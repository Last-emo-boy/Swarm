import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTaskPacket } from "./agent-specs.js";
import { RuntimeEventPersister } from "./runtime-event-persister.js";
import type { RuntimeEvent } from "./events.js";
import type { SwarmPolicy, SwarmEnvelope, SwarmSession } from "../protocol/types.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import { AuditStore } from "../storage/audit-store.js";
import { ApprovalStore } from "../storage/approval-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionContextStore } from "../storage/session-context-store.js";
import { SessionStore } from "../storage/session-store.js";
import { TaskGraphStore } from "../storage/task-graph-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { UsageStore } from "../storage/usage-store.js";

const AT = "2026-06-07T00:00:00.000Z";

test("runtime event persister projects tool_result into context, graph, usage, audit, and attempts", () => {
  const fixture = createFixture();
  try {
    const seeded = seedSession(fixture);
    const persister = createPersister(fixture);

    persister.record({
      type: "tool_result",
      session_id: seeded.sessionId,
      task_id: "task-tool-1",
      title: "Write file",
      action: "file.write",
      summary: "Wrote focused file",
      content: "updated src/runtime/runtime-event-persister.test.ts",
      status: "success",
      outputRef: "task-output://task-tool-1",
      attempt: 2,
      write_policy: "scoped_write",
      file_scope: ["src/runtime/runtime-event-persister.test.ts"],
      capability: {
        id: "local_tool.file.write",
        providerId: "local_tool",
        permissionName: "file.write",
        riskClass: "r1"
      }
    });

    const context = fixture.sessionContextStore.list(seeded.sessionId);
    assert.equal(context.length, 1);
    assert.equal(context[0]?.kind, "tool_result");
    assert.equal(context[0]?.role, "tool");
    assert.match(context[0]?.content ?? "", /file\.write: Wrote focused file/);
    assert.match(context[0]?.content ?? "", /updated src\/runtime\/runtime-event-persister\.test\.ts/);
    assert.equal(context[0]?.metadata.task_id, "task-tool-1");
    assert.equal(context[0]?.metadata.outputRef, "task-output://task-tool-1");

    const graphTask = fixture.taskGraphStore.get(seeded.sessionId).tasks.find((task) => task.task_id === "task-tool-1");
    assert.equal(graphTask?.status, "completed");
    assert.equal(graphTask?.capability, "file.write");
    assert.equal(graphTask?.write_policy, "scoped_write");
    assert.deepEqual(graphTask?.file_scope, ["src/runtime/runtime-event-persister.test.ts"]);

    const usage = fixture.usageStore.list(seeded.sessionId);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.kind, "tool_call");
    assert.equal(usage[0]?.metadata.action, "file.write");
    assert.equal(usage[0]?.metadata.status, "success");

    const audit = fixture.auditStore.list(seeded.sessionId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor_type, "tool");
    assert.equal(audit[0]?.action, "file.write");
    assert.equal(audit[0]?.decision, "executed");
    assert.equal(audit[0]?.risk_class, "r1");

    const attempts = fixture.runAttemptStore.listByTask(seeded.sessionId, "task-tool-1");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.kind, "tool_call");
    assert.equal(attempts[0]?.runner_id, "file.write");
    assert.equal(attempts[0]?.status, "completed");
    assert.equal(attempts[0]?.attempt, 2);
    assert.equal(attempts[0]?.terminal_reason, "Wrote focused file");
    assert.equal(attempts[0]?.workspace_path, fixture.workspace);
    assert.equal(attempts[0]?.metadata.outputRef, "task-output://task-tool-1");
  } finally {
    fixture.close();
  }
});

test("runtime event persister projects worker start and completion into context, attempts, usage, and audit", () => {
  const fixture = createFixture();
  try {
    const seeded = seedSession(fixture);
    const persister = createPersister(fixture);
    const startedWorker = worker(seeded.sessionId, "running");
    const packet = taskPacket({ personaBrief: "Temporary persona text should not persist." });

    persister.record({
      type: "agent_run_started",
      worker: startedWorker,
      task_packet: packet
    });
    persister.record({
      type: "agent_run_completed",
      worker: { ...startedWorker, status: "completed", outcome: finalOutcome() },
      result: "Worker completed the extraction.\nDetailed result follows."
    });

    const context = fixture.sessionContextStore.list(seeded.sessionId);
    assert.equal(context.filter((entry) => entry.kind === "worker").length, 2);
    assert.match(context[0]?.content ?? "", /Started worker-1: Extract runtime event persister/);
    assert.match(context[1]?.content ?? "", /Completed worker-1: Worker completed the extraction/);

    const attempts = fixture.runAttemptStore.listByTask(seeded.sessionId, "worker-1");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.kind, "worker_run");
    assert.equal(attempts[0]?.runner_id, "coder");
    assert.equal(attempts[0]?.status, "completed");
    assert.equal(attempts[0]?.terminal_reason, "Worker completed the extraction.");
    assert.equal(attempts[0]?.metadata.result, "Worker completed the extraction.\nDetailed result follows.");
    assert.deepEqual(attempts[0]?.metadata.outcome, finalOutcome());
    const durablePacket = attempts[0]?.metadata.task_packet as Record<string, unknown> | undefined;
    assert.equal(durablePacket?.objective, "Extract runtime event persister");
    assert.equal(durablePacket?.persona_brief, undefined);

    const usage = fixture.usageStore.list(seeded.sessionId);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.kind, "worker_spawn");
    assert.equal(usage[0]?.task_id, "worker-1");

    const audit = fixture.auditStore.list(seeded.sessionId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor_type, "runtime");
    assert.equal(audit[0]?.action, "agent.spawn");
    assert.equal(audit[0]?.decision, "executed");
  } finally {
    fixture.close();
  }
});

test("runtime event persister projects final events into context, final outcome, and final attempt", () => {
  const fixture = createFixture();
  try {
    const seeded = seedSession(fixture);
    const persister = createPersister(fixture);
    const outcome = finalOutcome();

    persister.record({
      type: "final",
      session_id: seeded.sessionId,
      content: "Final answer body",
      artifact_path: ".swarm/output/final.md",
      outcome,
      status: "failed"
    });

    const context = fixture.sessionContextStore.list(seeded.sessionId);
    assert.equal(context.length, 1);
    assert.equal(context[0]?.kind, "final");
    assert.equal(context[0]?.role, "assistant");
    assert.equal(context[0]?.content, "Final answer body");
    assert.equal(context[0]?.metadata.status, "failed");
    assert.equal(context[0]?.metadata.artifact_path, ".swarm/output/final.md");
    assert.deepEqual(context[0]?.metadata.outcome, outcome);

    const row = fixture.sessionStore.get(seeded.sessionId);
    assert.deepEqual(row?.final_outcome_json ? JSON.parse(row.final_outcome_json) : undefined, outcome);
    assert.equal(row?.final_output, null);

    const attempts = fixture.runAttemptStore.listByTask(seeded.sessionId, "final");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.runner_id, "main_swarm");
    assert.equal(attempts[0]?.kind, "coding_turn");
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(attempts[0]?.terminal_reason, "runtime event persister extracted");
    assert.equal(attempts[0]?.workspace_path, fixture.workspace);
    assert.equal(attempts[0]?.metadata.artifact_path, ".swarm/output/final.md");
    assert.deepEqual(attempts[0]?.metadata.outcome, outcome);
  } finally {
    fixture.close();
  }
});

type Fixture = {
  root: string;
  workspace: string;
  database: SwarmDatabase;
  sessionStore: SessionStore;
  taskGraphStore: TaskGraphStore;
  sessionContextStore: SessionContextStore;
  usageStore: UsageStore;
  auditStore: AuditStore;
  runAttemptStore: RunAttemptStore;
  receivedEnvelopes: SwarmEnvelope[];
  close(): void;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-runtime-event-persister-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const sessionStore = new SessionStore(database);
  const taskStateStore = new TaskStateStore(database);
  return {
    root,
    workspace,
    database,
    sessionStore,
    taskGraphStore: new TaskGraphStore(database, taskStateStore),
    sessionContextStore: new SessionContextStore(database),
    usageStore: new UsageStore(database),
    auditStore: new AuditStore(database),
    runAttemptStore: new RunAttemptStore(database),
    receivedEnvelopes: [],
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createPersister(fixture: Fixture): RuntimeEventPersister {
  return new RuntimeEventPersister({
    taskGraphStore: fixture.taskGraphStore,
    approvalStore: new ApprovalStore(fixture.database),
    sessionStore: fixture.sessionStore,
    usageStore: fixture.usageStore,
    auditStore: fixture.auditStore,
    sessionContextStore: fixture.sessionContextStore,
    runAttemptStore: fixture.runAttemptStore,
    router: {
      receive: (envelope) => {
        fixture.receivedEnvelopes.push(envelope);
      }
    },
    workspaceForSession: () => fixture.workspace,
    activeSessionId: () => undefined,
    recordProviderUsage: () => undefined,
    isDisposed: () => false
  });
}

function seedSession(fixture: Fixture): { sessionId: string; swarmId: string } {
  const sessionId = "session-persister-1";
  const swarmId = "swarm-persister-1";
  const session: SwarmSession = {
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: "user-persister-1",
    objective: "Extract runtime event persister",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  };
  fixture.sessionStore.create(session);
  return { sessionId, swarmId };
}

function worker(parentSessionId: string, status: WorkerRecord["status"]): WorkerRecord {
  return {
    worker_id: "worker-1",
    display_name: "Ada",
    role_title: "Coder",
    parent_session_id: parentSessionId,
    worker_session_id: "worker-session-1",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    capability: "code.test",
    objective: "Extract runtime event persister",
    status,
    file_scope: ["src/runtime/runtime-event-persister.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 10 },
    task_packet: taskPacket(),
    output_contract: "Summary",
    spawn_reason: "decouple runtime event persistence",
    requested_by: "main_swarm",
    created_at: AT,
    updated_at: AT
  };
}

function taskPacket(input: { personaBrief?: string } = {}): AgentTaskPacket {
  return {
    objective: "Extract runtime event persister",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    persona_snapshot: "Coder",
    persona_brief: input.personaBrief,
    file_scope: ["src/runtime/runtime-event-persister.ts"],
    allowed_tools: ["file.read", "file.write"],
    write_policy: "scoped_write",
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: { max_turns: 4, max_tool_calls: 10 },
    expected_output: "Summary",
    return_conditions: ["done"]
  };
}

function finalOutcome(): NonNullable<Extract<RuntimeEvent, { type: "final" }>["outcome"]> {
  return {
    changed_files: ["src/runtime/runtime-event-persister.ts"],
    intermediate_artifacts: ["runtime-event-persister"],
    tests_run: ["node --import tsx --test src/runtime/runtime-event-persister.test.ts"],
    final_summary: "runtime event persister extracted"
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: "on-request",
    network_access: "deny",
    allow_domains: [],
    human_approval_for: [],
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: [],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    }
  };
}
