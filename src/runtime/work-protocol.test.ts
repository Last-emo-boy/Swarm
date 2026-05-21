import { strict as assert } from "node:assert";
import test from "node:test";
import type { RuntimeEvent } from "./events.js";
import type { AgentTaskPacket } from "./agent-specs.js";
import type { WorkProtocolRecord } from "./work-protocol.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import {
  buildWorkRecordFromRuntimeEvent,
  buildWorkRunRecord,
  SWARM_WORK_PROTOCOL_VERSION
} from "./work-protocol.js";

const AT = "2026-05-11T00:00:00.000Z";

test("buildWorkRunRecord maps camelCase input to snake_case protocol fields", () => {
  const record = buildWorkRunRecord({
    at: AT,
    phase: "start",
    sessionId: "session-1",
    objective: "Stabilize contracts",
    workspace: "E:/Playground/Swarm",
    mode: "coding_loop",
    permissionMode: "ask",
    sandboxMode: "read-only",
    toolPolicy: {
      allowed_tools: ["Read", "Grep"],
      disallowed_tools: ["Bash"]
    },
    additionalReadDirectories: ["E:/Shared/ReadOnly"],
    operation: "resume",
    resumeSessionId: "session-0",
    message: "starting"
  });

  assert.equal(record.schema_version, SWARM_WORK_PROTOCOL_VERSION);
  assert.equal(record.kind, "run");
  assert.equal(record.session_id, "session-1");
  assert.equal(record.permission_mode, "ask");
  assert.equal(record.sandbox_mode, "read-only");
  assert.deepEqual(record.tool_policy, {
    allowed_tools: ["Read", "Grep"],
    disallowed_tools: ["Bash"]
  });
  assert.deepEqual(record.additional_read_directories, ["E:/Shared/ReadOnly"]);
  assert.equal(record.resume_session_id, "session-0");
  assert(!("sessionId" in record));
  assert(!("toolPolicy" in record));
  assert(!("additionalReadDirectories" in record));
});

test("buildWorkRunRecord strips undefined fields without dropping falsy values", () => {
  const record = buildWorkRunRecord({
    at: AT,
    phase: "end",
    objective: "",
    message: "",
    status: "completed"
  });

  assert.equal(record.objective, "");
  assert.equal(record.message, "");
  assert(!("session_id" in record));
});

test("queue events become queue records and worker slot ids become worker_id", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "queue",
    queue: "worker_slots",
    operation: "enqueue",
    id: "worker-1",
    priority: "now",
    size: 0,
    session_id: "session-1",
    message: "queued"
  }, AT);

  assertProtocol(record, "queue");
  assert.equal(record.queue, "worker_slots");
  assert.equal(record.worker_id, "worker-1");
  assert.equal(record.size, 0);
});

test("approval events become permission records", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "approval",
    request: approvalRequest(),
    status: "pending"
  }, AT);

  assertProtocol(record, "permission");
  assert.equal(record.session_id, "session-1");
  assert.equal(record.task_id, "task-1");
  assert.equal(record.approval_id, "approval-1");
  assert.equal(record.risk_class, "r3");
  assert.equal(record.permission_decision, "ask");
});

test("tool_result events become task records with sandbox metadata", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "tool_result",
    session_id: "session-1",
    task_id: "task-1",
    title: "Read file",
    action: "file.read",
    summary: "read ok",
    status: "success",
    outputRef: "artifact://read",
    attempt: 2,
    write_policy: "read_only",
    file_scope: ["src/runtime/work-protocol.ts"],
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    },
    sandbox: {
      decision: "allow",
      policy: "read_only",
      subject: "tool_action",
      reason: "read-only action",
      action: "file.read"
    }
  }, AT);

  assertProtocol(record, "task");
  assert.equal(record.phase, "completed");
  assert.equal(record.result_status, "success");
  assert.equal(record.attempt, 2);
  assert.equal(record.worker_id, "worker-1");
  assert.equal(record.agent_label, "Ada / Diff Investigator");
  assert.equal(record.sandbox?.status, "allowed");
  assert.equal(record.sandbox?.policy, "read_only");
});

test("failed tool_result maps to failed task phase and denied sandbox", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "tool_result",
    session_id: "session-1",
    task_id: "task-1",
    title: "Write file",
    action: "file.write",
    summary: "blocked",
    status: "failed",
    errorCode: "SANDBOX_DENIED",
    recoverySuggestion: "Use scoped write",
    sandbox: {
      decision: "deny",
      policy: "read_only",
      subject: "tool_action",
      reason: "read-only denied write",
      action: "file.write",
      targets: ["src/runtime/work-protocol.ts"],
      file_scope: ["src/runtime/work-protocol.ts"]
    }
  }, AT);

  assertProtocol(record, "task");
  assert.equal(record.phase, "failed");
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "SANDBOX_DENIED");
  assert.equal(record.sandbox?.status, "denied");
});

test("loop_activity events become activity records with error and recovery fields", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "loop_activity",
    session_id: "session-1",
    phase: "running_tool",
    message: "running code build",
    turn: 3,
    tool: "code.build",
    task_id: "task-1",
    status: "running",
    summary: "npm run check",
    errorCode: "E_CHECK",
    recoverySuggestion: "Fix types",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  }, AT);

  assertProtocol(record, "activity");
  assert.equal(record.phase, "running_tool");
  assert.equal(record.error_code, "E_CHECK");
  assert.equal(record.recovery_suggestion, "Fix types");
  assert.equal(record.worker_id, "worker-1");
  assert.equal(record.agent_label, "Ada / Diff Investigator");
  assert.equal(record.agent_spec_id, "researcher");
  assert.equal(record.invocation_mode, "call_subagent");
});

test("control events become control records", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "control",
    message_id: "message-1",
    action: "inject_next_turn",
    reason: "user follow-up",
    instruction: "focus tests"
  }, AT);

  assertProtocol(record, "control");
  assert.equal(record.message_id, "message-1");
  assert.equal(record.action, "inject_next_turn");
});

test("session and task events become dedicated records", () => {
  const session = buildWorkRecordFromRuntimeEvent({
    type: "session",
    session_id: "session-1",
    parent_session_id: "parent-1",
    status: "running",
    objective: "Run work"
  }, AT);
  const task = buildWorkRecordFromRuntimeEvent({
    type: "task",
    session_id: "session-1",
    task_id: "task-1",
    title: "Task",
    status: "assigned",
    capability: "code.test",
    write_policy: "scoped_write",
    file_scope: ["src/runtime/work-protocol.ts"]
  }, AT);

  assertProtocol(session, "session");
  assert.equal(session.parent_session_id, "parent-1");
  assertProtocol(task, "task");
  assert.equal(task.phase, "queued");
  assert.equal(task.capability, "code.test");
});

test("worker and agent run events become task records with worker metadata", () => {
  const workerRecord = worker({ status: "running" });
  const started = buildWorkRecordFromRuntimeEvent({
    type: "agent_run_started",
    worker: workerRecord,
    task_packet: taskPacket()
  }, AT);
  const completed = buildWorkRecordFromRuntimeEvent({
    type: "agent_run_completed",
    worker: { ...workerRecord, status: "completed" },
    result: "done"
  }, AT);

  assertProtocol(started, "task");
  assert.equal(started.phase, "running");
  assert.equal(started.worker_id, "worker-1");
  assert.equal(started.tool_budget?.max_tool_calls, 10);
  assertProtocol(completed, "task");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.status, "coder/call_subagent/completed");
});

test("agent_spawn_decision events become queued task records with budget and output contract", () => {
  const record = buildWorkRecordFromRuntimeEvent({
    type: "agent_spawn_decision",
    worker_id: "worker-1",
    parent_session_id: "session-1",
    decision: {
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      reason: "needs code",
      confidence: 0.9
    },
    task_packet: taskPacket()
  }, AT);

  assertProtocol(record, "task");
  assert.equal(record.phase, "queued");
  assert.equal(record.task_id, "worker-1");
  assert.equal(record.status, "coder/call_subagent");
  assert.deepEqual(record.tool_budget, { max_turns: 4, max_tool_calls: 10 });
  assert.equal(record.output_contract, "Summary");
});

test("handoff events become handoff task records", () => {
  const started = buildWorkRecordFromRuntimeEvent({ type: "handoff_started", handoff: handoff("active") }, AT);
  const returned = buildWorkRecordFromRuntimeEvent({ type: "handoff_returned", handoff: handoff("returned"), result: "done" }, AT);
  const takenBack = buildWorkRecordFromRuntimeEvent({ type: "handoff_taken_back", handoff: handoff("taken_back") }, AT);

  assertProtocol(started, "task");
  assert.equal(started.phase, "running");
  assert.equal(started.invocation_mode, "handoff");
  assertProtocol(returned, "task");
  assert.equal(returned.phase, "completed");
  assertProtocol(takenBack, "task");
  assert.equal(takenBack.phase, "failed");
});

test("fallback runtime events retain session/task/worker ids and summaries", () => {
  const final = buildWorkRecordFromRuntimeEvent({
    type: "final",
    session_id: "session-1",
    content: "\n  Finished contract tests\nMore detail"
  }, AT);
  const handoffMessage = buildWorkRecordFromRuntimeEvent({
    type: "handoff_message",
    session_id: "session-1",
    handoff_id: "handoff-1",
    worker_id: "worker-1",
    message: "handoff update"
  }, AT);

  assertProtocol(final, "runtime_event");
  assert.equal(final.session_id, "session-1");
  assert.equal(final.summary, "Finished contract tests");
  assertProtocol(handoffMessage, "runtime_event");
  assert.equal(handoffMessage.task_id, "handoff-1");
  assert.equal(handoffMessage.worker_id, "worker-1");
  assert.equal(handoffMessage.summary, "handoff update");
});

test("final runtime events preserve checkpoint metadata in runtime_event projections", () => {
  const event: RuntimeEvent = {
    type: "final",
    session_id: "session-1",
    content: "Checkpoint projection complete.",
    status: "completed",
    outcome: {
      changed_files: ["src/runtime/result-card.test.ts"],
      intermediate_artifacts: ["checkpoint-summary.json"],
      tests_run: ["node --import tsx --test src/runtime/result-card.test.ts"],
      final_summary: "Checkpoint projection complete."
    },
    checkpoint: {
      id: "cp_runtime_event_projection",
      name: "Runtime event checkpoint",
      mode: "git",
      status: "available",
      revertAvailable: true
    }
  };
  const record = buildWorkRecordFromRuntimeEvent(event, AT);

  assertProtocol(record, "runtime_event");
  assert.equal(record.session_id, "session-1");
  assert.equal(record.summary, "Checkpoint projection complete.");
  assert.deepEqual(record.event, event);
  assert.equal(record.event.type, "final");
  assert.equal(record.event.checkpoint?.name, "Runtime event checkpoint");
  assert.equal(record.event.checkpoint?.revertAvailable, true);
  assert.equal(record.event.outcome?.final_summary, "Checkpoint projection complete.");
});

test("all projected records include schema_version, kind, and at", () => {
  const events: RuntimeEvent[] = [
    { type: "log", level: "info", message: "hello" },
    { type: "error", message: "boom" },
    { type: "progress", completed: 0, total: 0 },
    {
      type: "provider_usage",
      usage: {
        providerId: "openai",
        protocol: "openai-responses",
        model: "gpt",
        purpose: "chat",
        cacheMode: "off",
        promptCacheKey: "",
        promptCacheScope: "",
        cacheablePrefixTokensEstimate: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    }
  ];

  for (const event of events) {
    const record = buildWorkRecordFromRuntimeEvent(event, AT);
    assert.equal(record.schema_version, SWARM_WORK_PROTOCOL_VERSION);
    assert.equal(record.at, AT);
    assert(typeof record.kind === "string" && record.kind.length > 0);
  }
});

function assertProtocol<K extends WorkProtocolRecord["kind"]>(
  record: WorkProtocolRecord,
  kind: K
): asserts record is Extract<WorkProtocolRecord, { kind: K }> {
  assert.equal(record.schema_version, SWARM_WORK_PROTOCOL_VERSION);
  assert.equal(record.kind, kind);
  assert.equal(record.at, AT);
}

function approvalRequest(): ToolApprovalRequest {
  return {
    id: "approval-1",
    session_id: "session-1",
    task_id: "task-1",
    action: "file.write",
    summary: "Write file",
    detail: "Needs write access",
    risk: "write",
    risk_class: "r3",
    target: "src/runtime/work-protocol.ts",
    why_now: "Contract test",
    predicted_impact: "Updates source",
    rollback_plan: "Revert file",
    permission_decision: "ask",
    permission_reason: "write requested",
    permission_mode: "ask",
    permission_name: "file.write",
    permission_rule: "ask:file.write"
  };
}

function worker(input: { status: WorkerRecord["status"] }): WorkerRecord {
  return {
    worker_id: "worker-1",
    display_name: "Ada",
    parent_session_id: "session-1",
    worker_session_id: "worker-session-1",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    capability: "code.test",
    objective: "Write tests",
    status: input.status,
    file_scope: ["src/runtime/work-protocol.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 10 },
    task_packet: taskPacket(),
    output_contract: "Summary",
    spawn_reason: "need coverage",
    requested_by: "main",
    created_at: AT,
    updated_at: AT
  };
}

function handoff(status: HandoffSessionRecord["status"]): HandoffSessionRecord {
  return {
    handoff_id: "handoff-1",
    worker_id: "worker-1",
    parent_session_id: "session-1",
    source_agent: "main",
    target_agent_spec_id: "reviewer",
    reason: "Review",
    status,
    task_packet: taskPacket({ invocationMode: "handoff" }),
    created_at: AT,
    updated_at: AT
  };
}

function taskPacket(input: { invocationMode?: AgentTaskPacket["invocation_mode"] } = {}): AgentTaskPacket {
  return {
    objective: "Write tests",
    agent_spec_id: "coder",
    invocation_mode: input.invocationMode ?? "call_subagent",
    persona_snapshot: "Coder",
    file_scope: ["src/runtime/work-protocol.ts"],
    allowed_tools: ["file.read"],
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
