import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { RuntimeEvents, type RuntimeEvent } from "../runtime/events.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { AuditStore } from "../storage/audit-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionStore } from "../storage/session-store.js";
import { SymphonyClaimStore } from "../storage/symphony-claim-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { SymphonyDaemonManager } from "./daemon.js";

test("daemon stops after max_ticks and records tick history", async () => {
  const fixture = createFixture();
  const manager = new SymphonyDaemonManager(fixture.runtime);
  try {
    const started = await manager.start({
      workflowPath: fixture.workflowPath,
      createWorkspace: false,
      maxTicks: 1
    });
    if (!started.ok) {
      assert.fail(started.error.message);
    }

    await waitFor(() => started.daemon.status === "stopped");

    assert.equal(started.created, true);
    assert.equal(started.daemon.tick_count, 1);
    assert.equal(started.daemon.stop_reason, "max_ticks_reached");
    assert.equal(started.daemon.history.length, 1);
    assert.equal(started.daemon.history[0].tick, 1);
    assert.equal(started.daemon.history[0].dispatched, 1);
    assert.equal(started.daemon.history[0].max_concurrent, 2);
  } finally {
    await manager.stopAll();
    fixture.close();
  }
});

test("daemon duplicate start reuses running record and stop wakes the loop", async () => {
  const fixture = createFixture();
  const manager = new SymphonyDaemonManager(fixture.runtime);
  try {
    const first = await manager.start({
      workflowPath: fixture.workflowPath,
      createWorkspace: false,
      maxTicks: 10
    });
    if (!first.ok) {
      assert.fail(first.error.message);
    }

    const second = await manager.start({
      workflowPath: fixture.workflowPath,
      createWorkspace: false,
      maxTicks: 10
    });
    if (!second.ok) {
      assert.fail(second.error.message);
    }

    assert.equal(second.created, false);
    assert.equal(second.daemon.daemon_id, first.daemon.daemon_id);

    await waitFor(() => first.daemon.tick_count >= 1);
    const stopped = manager.requestStop({
      daemonId: first.daemon.daemon_id,
      reason: "unit_test_stop",
      cancelRunning: true
    });

    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].stop_reason, "unit_test_stop");
    await waitFor(() => first.daemon.status === "stopped");
    assert.equal(first.daemon.stop_reason, "unit_test_stop");
    assert.equal(fixture.interruptions.length, 1);
  } finally {
    await manager.stopAll();
    fixture.close();
  }
});

test("daemon start reports workflow load errors without creating a loop", async () => {
  const fixture = createFixture();
  const manager = new SymphonyDaemonManager(fixture.runtime);
  try {
    const result = await manager.start({ workflowPath: join(fixture.root, "missing-WORKFLOW.md") });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "missing_workflow_file");
    }
    assert.deepEqual(manager.listRecords(), []);
  } finally {
    await manager.stopAll();
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

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-symphony-daemon-"));
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  writeFileSync(workflowPath, workflowText(workspaceRoot), "utf8");
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
    auditStore: new AuditStore(database),
    artifactStore: new ArtifactStore(database),
    settings: {
      runtime: {
        maxAgents: 4,
        maxParallelTasks: 4,
        taskTimeoutMs: 10_000,
        projectArtifactDir: ".swarm/artifacts"
      }
    },
    getWorkSnapshot: (sessionId: string) => ({
      session: {
        session_id: sessionId,
        swarm_id: `swarm_${sessionId}`,
        objective: "Test Symphony daemon",
        status: "running",
        created_at: "2026-05-12T00:00:00.000Z",
        updated_at: "2026-05-12T00:00:00.000Z"
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
      return true;
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

function workflowText(workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "polling:",
    "  interval_ms: 60000",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 2",
    "  max_retry_backoff_ms: 5000",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail("Timed out waiting for daemon state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
