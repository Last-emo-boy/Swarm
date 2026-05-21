import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmSession, WorkItem, WorkSessionOutcome } from "../protocol/types.js";
import type { ExecutionResult } from "../runtime/orchestrator.js";
import { RuntimeEvents, type RuntimeEvent } from "../runtime/events.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionStore } from "../storage/session-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { createSymphonyPolicy, createSymphonyWorkSession } from "./kernel.js";
import { LocalCodingLoopSymphonyRunner, runDispatchedSymphonyWork } from "./runner.js";
import type { SymphonyDispatchRecord } from "./scheduler.js";
import { getSymphonyStatus } from "./status.js";
import { normalizeRecordToWorkItem } from "./work-source.js";

const AT = "2026-05-12T00:00:00.000Z";

test("local coding-loop runner records completed outcome and blackboard result", async () => {
  const outcome = outcomeFixture("completed summary");
  const fixture = createFixture({
    result: {
      session_id: "result-completed",
      content: "completed summary\nwith detail",
      status: "completed",
      outcome
    }
  });
  try {
    const dispatch = createDispatch(fixture, "RUN-101", { attempt: 2 });
    const records = await runDispatchedSymphonyWork({
      runtime: fixture.runtime,
      dispatches: [dispatch],
      maxTurns: 3,
      maxToolCalls: 7
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].status, "completed");
    assert.deepEqual(fixture.executeCalls, [{
      session_id: dispatch.session?.session_id,
      prompt: dispatch.prompt,
      workspace_path: dispatch.workspace_path,
      maxTurns: 3,
      maxToolCalls: 7
    }]);

    const attempt = runnerAttempt(fixture, dispatch);
    assert.equal(attempt?.status, "completed");
    assert.equal(attempt?.runner_id, "symphony.local_coding_loop");
    assert.equal(attempt?.kind, "coding_turn");
    assert.equal(attempt?.attempt, 2);
    assert.equal(attempt?.terminal_reason, "completed summary");
    assert.equal(attempt?.workspace_path, dispatch.workspace_path);
    assert.equal(attempt?.metadata.result_session_id, "result-completed");
    assert.deepEqual(attempt?.metadata.outcome, outcome);

    const entry = latestRunnerEntry(fixture, dispatch, "symphony.runner.completed");
    assert.equal(entry?.type, "result");
    assert.deepEqual(entry?.tags, ["symphony", "runner", "completed", "work-kernel"]);
    assert.equal(fixture.events.some((event) => event.type === "blackboard" && event.entry.key === "symphony.runner.completed"), true);
    assert.equal(fixture.events.some((event) => event.type === "log" && /runner completed/.test(event.message)), true);

    fixture.runtime.sessionStore.setStatus(dispatch.session!.session_id, "completed");
    const status = getSymphonyStatus({ runtime: fixture.runtime, workflowPath: fixture.workflowPath });
    const session = status.sessions.find((item) => item.session_id === dispatch.session?.session_id);
    assert.equal(session?.runner_attempt?.status, "completed");
    assert.equal(status.scheduler.completed.includes(session?.work_item_key ?? ""), true);
  } finally {
    fixture.close();
  }
});

test("local coding-loop runner records stopped runs as cancelled decisions", async () => {
  const fixture = createFixture({
    result: {
      session_id: "result-stopped",
      content: "stopped fallback detail",
      status: "stopped",
      outcome: outcomeFixture("user stopped run")
    }
  });
  try {
    const dispatch = createDispatch(fixture, "RUN-201", { attempt: 1 });
    const runner = new LocalCodingLoopSymphonyRunner(fixture.runtime);
    const record = await runner.run({ dispatch, maxTurns: 1, maxToolCalls: 2 });

    assert.equal(record.status, "cancelled");
    const attempt = runnerAttempt(fixture, dispatch);
    assert.equal(attempt?.status, "cancelled");
    assert.equal(attempt?.terminal_reason, "user stopped run");
    assert.equal(attempt?.metadata.result_session_id, "result-stopped");

    const entry = latestRunnerEntry(fixture, dispatch, "symphony.runner.cancelled");
    assert.equal(entry?.type, "decision");
    assert.deepEqual(entry?.tags, ["symphony", "runner", "cancelled", "work-kernel"]);
    assert.equal(fixture.events.some((event) => event.type === "log" && /runner cancelled/.test(event.message)), true);
  } finally {
    fixture.close();
  }
});

test("local coding-loop runner classifies failures and writes retryable evidence", async () => {
  const fixture = createFixture({
    error: new Error("Missing API key for provider")
  });
  try {
    const dispatch = createDispatch(fixture, "RUN-301", { attempt: 4 });
    const runner = new LocalCodingLoopSymphonyRunner(fixture.runtime);
    const record = await runner.run({ dispatch });

    assert.equal(record.status, "failed");
    assert.match(record.error ?? "", /Missing API key/);
    const attempt = runnerAttempt(fixture, dispatch);
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.attempt, 4);
    assert.equal(attempt?.terminal_reason, "Missing API key for provider");
    assert.equal(attempt?.error_code, "MODEL_NOT_CONFIGURED");
    assert.equal(attempt?.recovery_suggestion, "retry_same_agent");
    assert.equal(attempt?.metadata.error, "Missing API key for provider");

    const entry = latestRunnerEntry(fixture, dispatch, "symphony.runner.failed");
    assert.equal(entry?.type, "evidence");
    assert.deepEqual(entry?.value, { error: "Missing API key for provider" });
    assert.deepEqual(entry?.tags, ["symphony", "runner", "failed", "work-kernel"]);
    assert.equal(fixture.events.some((event) => event.type === "log" && /runner failed/.test(event.message)), true);
  } finally {
    fixture.close();
  }
});

test("local coding-loop runner skips incomplete dispatches without model execution", async () => {
  const fixture = createFixture({
    result: {
      session_id: "unused",
      content: "unused",
      status: "completed"
    }
  });
  try {
    const item = workItem("RUN-401");
    const runner = new LocalCodingLoopSymphonyRunner(fixture.runtime);
    const record = await runner.run({
      dispatch: {
        status: "dispatched",
        work_item: item,
        workspace_path: fixture.workspacePath
      }
    });

    assert.equal(record.status, "skipped");
    assert.equal(record.error, "dispatch_missing_session_or_prompt");
    assert.equal(fixture.executeCalls.length, 0);
    assert.deepEqual(fixture.runtime.runAttemptStore.listRecent(), []);
    assert.deepEqual(fixture.runtime.blackboardStore.listRecent(), []);
  } finally {
    fixture.close();
  }
});

type Fixture = {
  root: string;
  workflowPath: string;
  workspacePath: string;
  runtime: SwarmRuntime;
  events: RuntimeEvent[];
  executeCalls: Array<{
    session_id: string;
    prompt: string;
    workspace_path?: string;
    maxTurns?: number;
    maxToolCalls?: number;
  }>;
  close(): void;
};

function createFixture(input: { result?: ExecutionResult; error?: unknown }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-symphony-runner-"));
  const workspaceRoot = join(root, "workspaces");
  const workspacePath = join(workspaceRoot, "RUN-101");
  const workflowPath = join(root, "WORKFLOW.md");
  writeFileSync(workflowPath, workflowText(workspaceRoot), "utf8");
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const events = new RuntimeEvents();
  const capturedEvents: RuntimeEvent[] = [];
  events.onEvent((event) => {
    capturedEvents.push(event);
  });
  const executeCalls: Fixture["executeCalls"] = [];
  const runtime = {
    database,
    events,
    sessionStore: new SessionStore(database),
    runAttemptStore: new RunAttemptStore(database),
    blackboardStore: new BlackboardStore(database),
    workspaceLeaseStore: new WorkspaceLeaseStore(database),
    settings: {
      runtime: {
        maxAgents: 4,
        taskTimeoutMs: 10_000
      }
    },
    executeWorkSession: async (request: Fixture["executeCalls"][number]) => {
      executeCalls.push(request);
      if (input.error) {
        throw input.error;
      }
      return input.result ?? {
        session_id: request.session_id,
        content: "completed",
        status: "completed"
      };
    }
  } as unknown as SwarmRuntime;
  return {
    root,
    workflowPath,
    workspacePath,
    runtime,
    events: capturedEvents,
    executeCalls,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createDispatch(fixture: Fixture, identifier: string, input: { attempt: number }): SymphonyDispatchRecord {
  const item = workItem(identifier);
  const session = createSymphonyWorkSession({
    item,
    maxAgents: 4,
    timeoutMs: 10_000,
    status: "running"
  });
  const workspacePath = join(fixture.root, "workspaces", identifier);
  fixture.runtime.sessionStore.create(session);
  fixture.runtime.workspaceLeaseStore.create({
    lease_id: `lease_${session.session_id}`,
    session_id: session.session_id,
    workspace_root: join(fixture.root, "workspaces"),
    workspace_path: workspacePath,
    scope: [],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
  });
  fixture.runtime.sessionStore.updateMetadata(session.session_id, {
    source: item,
    workspace_lease_id: `lease_${session.session_id}`
  });
  return {
    status: "dispatched",
    work_item: item,
    session,
    workspace_path: workspacePath,
    prompt: `Implement ${identifier}`,
    attempt: fixture.runtime.runAttemptStore.upsert({
      session_id: session.session_id,
      task_id: "symphony.dispatch",
      runner_id: "symphony.scheduler",
      kind: "swarm_task",
      status: "completed",
      attempt: input.attempt,
      title: `Dispatch ${identifier}`,
      workspace_path: workspacePath,
      metadata: {
        workflow_path: fixture.workflowPath
      }
    })
  };
}

function runnerAttempt(fixture: Fixture, dispatch: SymphonyDispatchRecord) {
  return fixture.runtime.runAttemptStore.list(dispatch.session!.session_id)
    .find((attempt) => attempt.task_id === "symphony.runner");
}

function latestRunnerEntry(fixture: Fixture, dispatch: SymphonyDispatchRecord, key: string) {
  return fixture.runtime.blackboardStore.query(dispatch.session!.session_id, {
    keyPrefix: key,
    taskId: "symphony.runner"
  }).at(-1);
}

function workItem(identifier: string): WorkItem {
  return normalizeRecordToWorkItem({
    id: identifier.toLowerCase(),
    identifier,
    title: `Runner item ${identifier}`,
    priority: 1,
    state: "Todo",
    labels: ["runner"],
    created_at: AT,
    updated_at: AT
  }, "fake");
}

function outcomeFixture(finalSummary: string): WorkSessionOutcome {
  return {
    changed_files: ["src/example.ts"],
    intermediate_artifacts: [],
    tests_run: ["npm test"],
    final_summary: finalSummary
  };
}

function workflowText(workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 4",
    "  max_retry_backoff_ms: 5000",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}
