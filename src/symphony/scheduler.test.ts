import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmSession, WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { RuntimeEvents, type RuntimeEvent } from "../runtime/events.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionStore } from "../storage/session-store.js";
import { SymphonyClaimStore } from "../storage/symphony-claim-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { createSymphonyPolicy } from "./kernel.js";
import { SymphonyScheduler } from "./scheduler.js";
import { normalizeRecordToWorkItem, workSourceIdentity, type WorkSource } from "./work-source.js";
import { workItemKey } from "./work-item.js";

const AT = "2026-05-11T00:00:00.000Z";

test("scheduler recovers running, completed, and failed sessions from the Work Kernel", () => {
  const fixture = createFixture({ maxConcurrent: 2 });
  try {
    const running = workItem("WK-101", "Todo");
    const completed = workItem("WK-102", "Todo");
    const failed = workItem("WK-103", "Todo");

    seedSession(fixture, { sessionId: "sym_running", item: running, status: "running" });
    seedAttempt(fixture, "sym_running", "symphony.dispatch", "completed", { workspacePath: workspaceFor(fixture, running) });
    seedSession(fixture, { sessionId: "sym_completed", item: completed, status: "completed" });
    seedAttempt(fixture, "sym_completed", "symphony.dispatch", "completed", { workspacePath: workspaceFor(fixture, completed) });
    seedSession(fixture, { sessionId: "sym_failed", item: failed, status: "failed" });
    seedAttempt(fixture, "sym_failed", "symphony.dispatch", "completed", { workspacePath: workspaceFor(fixture, failed) });
    seedAttempt(fixture, "sym_failed", "symphony.runner", "failed", {
      terminalReason: "runner failed",
      workspacePath: workspaceFor(fixture, failed)
    });

    const scheduler = new SymphonyScheduler({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      source: sourceFor([running, completed, failed])
    });

    scheduler.recover();
    const snapshot = scheduler.snapshot();

    assert.deepEqual(snapshot.claimed, [workItemKey(running)]);
    assert.deepEqual(snapshot.completed, [workItemKey(completed)]);
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].session_id, "sym_running");
    assert.equal(snapshot.running[0].status, "running");
    assert.equal(snapshot.retrying.length, 1);
    assert.equal(snapshot.retrying[0].key, workItemKey(failed));
    assert.equal(snapshot.retrying[0].attempt, 1);
    assert.match(snapshot.retrying[0].error ?? "", /runner failed/);
    assert.deepEqual(snapshot.capacity, { max_concurrent: 4, running: 1, available: 3 });
  } finally {
    fixture.close();
  }
});

test("scheduler keeps not-due retries queued without dispatching them", async () => {
  const fixture = createFixture({ maxConcurrent: 2 });
  try {
    const item = workItem("WK-201", "Todo");
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    seedSession(fixture, { sessionId: "sym_retry_pending", item, status: "failed" });
    seedAttempt(fixture, "sym_retry_pending", "symphony.retry", "started", {
      attempt: 2,
      terminalReason: "waiting for backoff",
      metadata: { due_at: dueAt, error: "waiting for backoff" }
    });

    const scheduler = new SymphonyScheduler({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      source: sourceFor([item])
    });

    const result = await scheduler.tick();

    assert.equal(result.dispatched.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "retry_not_due");
    assert.equal(result.snapshot.retrying.length, 1);
    assert.equal(result.snapshot.retrying[0].key, workItemKey(item));
    assert.equal(result.snapshot.retrying[0].attempt, 2);
  } finally {
    fixture.close();
  }
});

test("scheduler redispatches due retries with the recovered attempt number", async () => {
  const fixture = createFixture({ maxConcurrent: 2 });
  try {
    const item = workItem("WK-202", "Todo");
    seedSession(fixture, { sessionId: "sym_retry_due", item, status: "failed" });
    seedAttempt(fixture, "sym_retry_due", "symphony.retry", "started", {
      attempt: 3,
      terminalReason: "retry due",
      metadata: { due_at: new Date(Date.now() - 1_000).toISOString(), error: "retry due" }
    });

    const scheduler = new SymphonyScheduler({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      source: sourceFor([item]),
      createWorkspace: false
    });

    const result = await scheduler.tick();

    assert.equal(result.dispatched.length, 1, JSON.stringify({
      skipped: result.skipped.map((record) => record.reason),
      failed: result.failed.map((record) => ({ reason: record.reason, error: record.error })),
      preflight: result.preflight
    }));
    assert.equal(result.dispatched[0].work_item.source_id, item.source_id);
    assert.equal(result.dispatched[0].attempt?.attempt, 3);
    assert.equal(result.snapshot.retrying.length, 0);
    assert.equal(result.snapshot.running.length, 1);
    assert.equal(result.snapshot.running[0].key, workItemKey(item));
  } finally {
    fixture.close();
  }
});

test("scheduler cancels recovered running sessions when the source item disappears", async () => {
  const fixture = createFixture({ maxConcurrent: 2 });
  try {
    const item = workItem("WK-301", "Todo");
    seedSession(fixture, { sessionId: "sym_missing_source", item, status: "running" });
    seedAttempt(fixture, "sym_missing_source", "symphony.dispatch", "completed", {
      workspacePath: workspaceFor(fixture, item)
    });

    const scheduler = new SymphonyScheduler({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      source: sourceFor([], new Map([[workSourceIdentity(item), undefined]]))
    });

    const result = await scheduler.tick();
    const row = fixture.runtime.sessionStore.get("sym_missing_source");
    const reconcile = fixture.runtime.runAttemptStore.list("sym_missing_source")
      .find((attempt) => attempt.task_id === "symphony.reconcile");

    assert.equal(row?.status, "cancelled");
    assert.equal(reconcile?.status, "cancelled");
    assert.equal(reconcile?.terminal_reason, "work_item_missing_from_source");
    assert.deepEqual(result.snapshot.running, []);
    assert.equal(fixture.interruptions[0]?.sessionId, "sym_missing_source");
  } finally {
    fixture.close();
  }
});

test("scheduler skips work items already claimed by another owner", async () => {
  const fixture = createFixture({ maxConcurrent: 2 });
  try {
    const item = workItem("WK-401", "Todo");
    const existing = fixture.runtime.symphonyClaimStore.tryClaim({
      work_item_key: workItemKey(item),
      source_identity: workSourceIdentity(item),
      workflow_path: fixture.workflowPath,
      owner_id: "other-scheduler",
      ttl_ms: 60_000
    });
    assert.equal(existing.claimed, true);

    const scheduler = new SymphonyScheduler({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      source: sourceFor([item])
    });

    const result = await scheduler.tick();

    assert.equal(result.dispatched.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, "already_claimed");
  } finally {
    fixture.close();
  }
});

type Fixture = {
  root: string;
  workspaceRoot: string;
  workflowPath: string;
  runtime: SwarmRuntime;
  events: RuntimeEvent[];
  interruptions: Array<{ sessionId: string; reason: string }>;
  close(): void;
};

function createFixture(input: { maxConcurrent: number }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-symphony-scheduler-"));
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  writeFileSync(workflowPath, workflowText(workspaceRoot, input.maxConcurrent), "utf8");
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const events = new RuntimeEvents();
  const capturedEvents: RuntimeEvent[] = [];
  events.onEvent((event) => {
    capturedEvents.push(event);
  });
  const interruptions: Fixture["interruptions"] = [];
  const runtime = {
    database,
    events,
    sessionStore: new SessionStore(database),
    runAttemptStore: new RunAttemptStore(database),
    workspaceLeaseStore: new WorkspaceLeaseStore(database),
    symphonyClaimStore: new SymphonyClaimStore(database),
    taskStateStore: new TaskStateStore(database),
    traceStore: new TraceStore(database),
    blackboardStore: new BlackboardStore(database),
    settings: {
      runtime: {
        maxAgents: 4,
        maxParallelTasks: 4,
        taskTimeoutMs: 10_000
      }
    },
    getWorkSnapshot: (sessionId: string) => ({
      session: {
        session_id: sessionId,
        swarm_id: `swarm_${sessionId}`,
        objective: "Test Symphony dispatch",
        status: "running",
        created_at: AT,
        updated_at: AT
      },
      attempts: [],
      workers: [],
      graph: { tasks: [], edges: [] },
      blackboard_counts: {},
      changed_files: [],
      checks: [],
      usage_summary: {},
      task_contracts: {
        summary: {
          total: 0,
          pending: 0,
          running: 0,
          blocked: 0,
          completed: 0,
          failed: 0,
          read_only: 0,
          scoped_write: 0,
          workspace_write: 0,
          scoped_targets: []
        },
        tasks: []
      },
      work_contracts: {
        summary: {
          active_workers: 0,
          running_workers: 0,
          pending_workers: 0,
          resumable_workers: 0,
          active_handoffs: 0,
          read_only: 0,
          scoped_write: 0,
          workspace_write: 0,
          scoped_targets: []
        },
        active_workers: [],
        resumable_workers: [],
        active_handoffs: []
      }
    }),
    interruptWorkSession: (sessionId: string, reason: string) => {
      interruptions.push({ sessionId, reason });
      return false;
    }
  } as unknown as SwarmRuntime;
  return {
    root,
    workspaceRoot,
    workflowPath,
    runtime,
    events: capturedEvents,
    interruptions,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function workflowText(workspaceRoot: string, maxConcurrent: number): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    `  max_concurrent_agents: ${maxConcurrent}`,
    "  max_retry_backoff_ms: 5000",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}

function workItem(identifier: string, state: string): WorkItem {
  return normalizeRecordToWorkItem({
    id: identifier.toLowerCase(),
    identifier,
    title: `Work item ${identifier}`,
    priority: 1,
    state,
    labels: ["test"],
    created_at: AT,
    updated_at: AT
  }, "fake");
}

function sourceFor(candidates: WorkItem[], refreshed?: Map<string, WorkItem | undefined>): WorkSource {
  return {
    kind: "test",
    async fetchCandidateItems() {
      return candidates;
    },
    async refreshItems(items: WorkItem[]) {
      if (refreshed) {
        return refreshed;
      }
      return new Map(items.map((item) => [workSourceIdentity(item), candidates.find((candidate) => workSourceIdentity(candidate) === workSourceIdentity(item)) ?? item]));
    },
    async listTerminalItems() {
      return [];
    }
  };
}

function seedSession(
  fixture: Fixture,
  input: {
    sessionId: string;
    item: WorkItem;
    status: SwarmSession["status"];
  }
): void {
  const lease = fixture.runtime.workspaceLeaseStore.create({
    lease_id: `lease_${input.sessionId}`,
    session_id: input.sessionId,
    workspace_root: fixture.workspaceRoot,
    workspace_path: workspaceFor(fixture, input.item),
    scope: [],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
  });
  fixture.runtime.sessionStore.create({
    swarm_id: `swarm_${input.sessionId}`,
    session_id: input.sessionId,
    user_request_id: input.item.source_id ?? input.sessionId,
    source: input.item,
    workspace_lease_id: lease.lease_id,
    objective: input.item.title,
    status: input.status,
    coordinator: { agent_id: "symphony", role: "scheduler" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: createSymphonyPolicy(4, 10_000)
  });
}

function seedAttempt(
  fixture: Fixture,
  sessionId: string,
  taskId: string,
  status: "started" | "completed" | "failed" | "cancelled" | "stopped",
  options: {
    attempt?: number;
    terminalReason?: string;
    workspacePath?: string;
    metadata?: Record<string, unknown>;
  } = {}
): void {
  fixture.runtime.runAttemptStore.upsert({
    attempt_id: `attempt_${sessionId}_${taskId}_${options.attempt ?? 0}`,
    session_id: sessionId,
    task_id: taskId,
    runner_id: "symphony.scheduler",
    kind: "swarm_task",
    status,
    attempt: options.attempt ?? 0,
    title: taskId,
    terminal_reason: options.terminalReason,
    workspace_path: options.workspacePath,
    metadata: {
      workflow_path: fixture.workflowPath,
      ...(options.metadata ?? {})
    }
  });
}

function workspaceFor(fixture: Fixture, item: WorkItem): string {
  return join(fixture.workspaceRoot, item.human_id ?? item.source_id ?? "work-item");
}
