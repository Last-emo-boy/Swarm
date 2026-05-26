import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmSession, WorkItem, WorkSessionOutcome } from "../protocol/types.js";
import type { ExecutionResult } from "../runtime/orchestrator.js";
import { RuntimeEvents, type RuntimeEvent } from "../runtime/events.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { createEnvelope } from "../protocol/envelope.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { EnvelopeDeliveryStore } from "../storage/envelope-delivery-store.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionStore } from "../storage/session-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { AgentRegistry } from "../runtime/registry.js";
import { EnvelopeRouter } from "../runtime/router.js";
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

test("local coding-loop runner returns protocol result and fail envelopes through router", async () => {
  const completed = createFixture({
    result: {
      session_id: "result-protocol-completed",
      content: "protocol completed",
      status: "completed",
      outcome: outcomeFixture("protocol completed")
    },
    withProtocol: true
  });
  try {
    const dispatch = createDispatch(completed, "RUN-501", { attempt: 1, withAssignmentEnvelope: true });
    const records = await runDispatchedSymphonyWork({
      runtime: completed.runtime,
      dispatches: [dispatch]
    });
    assert.equal(records[0]?.status, "completed");

    const resultEnvelope = completed.runtime.traceStore.list(dispatch.session!.session_id)
      .find((envelope) => envelope.type === "task.result" && envelope.reply_to === dispatch.assignment_envelope?.id);
    assert(resultEnvelope, "missing task.result envelope");
    assert.equal(resultEnvelope.from.agent_id, "symphony.scheduler");
    assert.equal(singleAgentId(resultEnvelope.to), "main_swarm");
    assert.equal(resultEnvelope.payload && typeof resultEnvelope.payload === "object" && "protocol" in resultEnvelope.payload
      ? resultEnvelope.payload.protocol
      : undefined, "symphony_source_adapter");
    assert.equal(completed.runtime.envelopeDeliveryStore.list({ envelopeId: dispatch.assignment_envelope!.id })[0]?.status, "acked");
    assert.equal(completed.runtime.envelopeDeliveryStore.list({ envelopeId: resultEnvelope.id })[0]?.status, "delivered");
    assert.equal(completed.runtime.agentActorStore.get("symphony.scheduler")?.current_task_id, undefined);
    assert.equal(latestRunnerEntry(completed, dispatch, "symphony.runner.completed")?.metadata?.source_envelope_id, resultEnvelope.id);
  } finally {
    completed.close();
  }

  const failed = createFixture({
    error: new Error("Missing API key for provider"),
    withProtocol: true
  });
  try {
    const dispatch = createDispatch(failed, "RUN-502", { attempt: 1, withAssignmentEnvelope: true });
    const runner = new LocalCodingLoopSymphonyRunner(failed.runtime);
    const record = await runner.run({ dispatch });
    assert.equal(record.status, "failed");

    const failEnvelope = failed.runtime.traceStore.list(dispatch.session!.session_id)
      .find((envelope) => envelope.type === "task.fail" && envelope.reply_to === dispatch.assignment_envelope?.id);
    assert(failEnvelope, "missing task.fail envelope");
    assert.equal(failed.runtime.envelopeDeliveryStore.list({ envelopeId: dispatch.assignment_envelope!.id })[0]?.status, "acked");
    assert.equal(failed.runtime.agentActorStore.get("symphony.scheduler")?.status, "degraded");
    assert.equal(latestRunnerEntry(failed, dispatch, "symphony.runner.failed")?.metadata?.source_envelope_id, failEnvelope.id);
  } finally {
    failed.close();
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

function createFixture(input: { result?: ExecutionResult; error?: unknown; withProtocol?: boolean }): Fixture {
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
  const traceStore = new TraceStore(database);
  const blackboardStore = new BlackboardStore(database);
  const taskStateStore = new TaskStateStore(database);
  const protocol = input.withProtocol
    ? createProtocolRuntimeParts(database, events, traceStore, blackboardStore, taskStateStore)
    : {};
  const runtime = {
    database,
    events,
    sessionStore: new SessionStore(database),
    runAttemptStore: new RunAttemptStore(database),
    blackboardStore,
    workspaceLeaseStore: new WorkspaceLeaseStore(database),
    traceStore,
    taskStateStore,
    ...protocol,
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

function createDispatch(fixture: Fixture, identifier: string, input: { attempt: number; withAssignmentEnvelope?: boolean }): SymphonyDispatchRecord {
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
  const assignment = input.withAssignmentEnvelope
    ? createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: "symphony.dispatch",
      attempt: input.attempt,
      from: { agent_id: "main_swarm", role: "controller" },
      to: { agent_id: "symphony.scheduler", role: "scheduler" },
      type: "task.assign",
      intent: "symphony.dispatch",
      payload: {
        source: "symphony",
        work_item_key: `fake:${identifier.toLowerCase()}`,
        claim_key: `symphony:fake:${identifier.toLowerCase()}`,
        owner_id: "symphony.scheduler",
        protocol: "symphony_source_adapter"
      },
      routing: { mode: "direct", require_ack: true },
      trace: {
        trace_id: session.session_id,
        span_id: `span_assignment_${identifier}`
      }
    })
    : undefined;
  if (assignment && fixture.runtime.router) {
    void fixture.runtime.router.dispatch(assignment);
  }
  return {
    status: "dispatched",
    work_item: item,
    session,
    workspace_path: workspacePath,
    prompt: `Implement ${identifier}`,
    assignment_envelope: assignment,
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

function createProtocolRuntimeParts(
  database: SwarmDatabase,
  events: RuntimeEvents,
  traceStore: TraceStore,
  blackboardStore: BlackboardStore,
  taskStateStore: TaskStateStore
): Pick<SwarmRuntime, "registry" | "router" | "agentActorStore" | "envelopeDeliveryStore"> {
  const agentActorStore = new AgentActorStore(database);
  const envelopeDeliveryStore = new EnvelopeDeliveryStore(database);
  const registry = new AgentRegistry(events, agentActorStore);
  registry.register({
    agent_id: "main_swarm",
    name: "Main Swarm",
    role: "coordinator",
    capabilities: ["swarm.coordinate"],
    status: "idle",
    load: { running_tasks: 0, max_tasks: 1 },
    reliability: { success_rate: 1, avg_latency_ms: 0 },
    metadata: { kind: "main" }
  });
  registry.register({
    agent_id: "symphony.scheduler",
    name: "Symphony Scheduler",
    role: "scheduler",
    capabilities: ["work_item.intake", "task.schedule", "claim.manage"],
    status: "idle",
    load: { running_tasks: 0, max_tasks: 1 },
    reliability: { success_rate: 1, avg_latency_ms: 0 },
    metadata: { kind: "symphony" }
  });
  const router = new EnvelopeRouter(
    registry,
    traceStore,
    events,
    blackboardStore,
    undefined,
    taskStateStore,
    envelopeDeliveryStore,
    agentActorStore
  );
  return {
    registry,
    router,
    agentActorStore,
    envelopeDeliveryStore
  } as Pick<SwarmRuntime, "registry" | "router" | "agentActorStore" | "envelopeDeliveryStore">;
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

function singleAgentId(to: { agent_id?: string } | Array<{ agent_id?: string }>): string | undefined {
  return Array.isArray(to) ? to[0]?.agent_id : to.agent_id;
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
