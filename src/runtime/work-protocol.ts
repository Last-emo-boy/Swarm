import type { RuntimeAgentIdentity, RuntimeEvent } from "./events.js";
import type { RunMode, RunSandboxMode } from "./execution-router.js";
import type { HeadlessPermissionMode, HeadlessToolPolicy } from "./headless-artifacts.js";
import type { ToolApprovalRequest } from "../tools/types.js";

export const SWARM_WORK_PROTOCOL_VERSION = "swarm.work.v1";

export type WorkProtocolContext = {
  objective?: string;
  workspace?: string;
  mode?: RunMode;
  permissionMode?: HeadlessPermissionMode;
  sandboxMode?: RunSandboxMode;
  toolPolicy?: HeadlessToolPolicy;
  additionalReadDirectories?: string[];
  operation?: "run" | "resume" | "continue";
  resumeSessionId?: string;
};

export type WorkProtocolRecord =
  | WorkRunRecord
  | WorkRuntimeEventRecord
  | WorkActivityRecord
  | WorkQueueRecord
  | WorkControlRecord
  | WorkPermissionRecord
  | WorkSandboxRecord
  | WorkTaskRecord
  | WorkSessionRecord;

export type WorkRunRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "run";
  phase: "start" | "end" | "signal";
  at: string;
  session_id?: string;
  objective?: string;
  workspace?: string;
  mode?: RunMode;
  permission_mode?: HeadlessPermissionMode;
  sandbox_mode?: RunSandboxMode;
  tool_policy?: HeadlessToolPolicy;
  additional_read_directories?: string[];
  operation?: "run" | "resume" | "continue";
  resume_session_id?: string;
  status?: "completed" | "failed" | "stopped";
  message?: string;
};

export type WorkRuntimeEventRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "runtime_event";
  at: string;
  event_type: RuntimeEvent["type"];
  session_id?: string;
  task_id?: string;
  worker_id?: string;
  summary: string;
  event: RuntimeEvent;
};

export type WorkActivityRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "activity";
  at: string;
  session_id: string;
  phase: Extract<RuntimeEvent, { type: "loop_activity" }>["phase"];
  message: string;
  worker_id?: string;
  agent_label?: string;
  agent_spec_id?: string;
  invocation_mode?: string;
  turn?: number;
  tool?: string;
  task_id?: string;
  status?: string;
  summary?: string;
  error_code?: string;
  recovery_suggestion?: string;
};

export type WorkQueueRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "queue";
  at: string;
  session_id?: string;
  queue: Extract<RuntimeEvent, { type: "queue" }>["queue"];
  operation: Extract<RuntimeEvent, { type: "queue" }>["operation"];
  id?: string;
  worker_id?: string;
  priority?: Extract<RuntimeEvent, { type: "queue" }>["priority"];
  size: number;
  message?: string;
};

export type WorkControlRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "control";
  at: string;
  session_id?: string;
  message_id?: string;
  action: string;
  reason: string;
  instruction?: string;
};

export type WorkPermissionRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "permission";
  at: string;
  session_id?: string;
  task_id?: string;
  approval_id: string;
  status: "pending" | "approved" | "denied";
  action: string;
  risk: ToolApprovalRequest["risk"];
  risk_class: ToolApprovalRequest["risk_class"];
  target: string;
  summary: string;
  permission_decision?: ToolApprovalRequest["permission_decision"];
  permission_reason?: string;
  permission_mode?: string;
  permission_name?: string;
  permission_rule?: string;
};

export type WorkSandboxRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "sandbox";
  at: string;
  session_id?: string;
  task_id?: string;
  status: "allowed" | "denied";
  policy: NonNullable<Extract<RuntimeEvent, { type: "tool_result" }>["sandbox"]>["policy"];
  subject: NonNullable<Extract<RuntimeEvent, { type: "tool_result" }>["sandbox"]>["subject"];
  action?: string;
  capability_id?: string;
  reason: string;
  targets?: string[];
  file_scope?: string[];
};

export type WorkTaskSandbox = Omit<WorkSandboxRecord, "schema_version" | "kind" | "at" | "session_id" | "task_id">;

export type WorkTaskRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "task";
  at: string;
  session_id?: string;
  task_id: string;
  phase: "queued" | "started" | "completed" | "failed" | "running" | "unknown";
  title: string;
  attempt?: number;
  worker_id?: string;
  agent_label?: string;
  parent_session_id?: string;
  worker_session_id?: string;
  agent_spec_id?: string;
  invocation_mode?: string;
  handoff_id?: string;
  capability?: string;
  action?: string;
  write_policy?: "read_only" | "scoped_write" | "workspace_write";
  file_scope?: string[];
  tool_budget?: {
    max_turns: number;
    max_tool_calls: number;
  };
  source_agent?: string;
  target_agent_spec_id?: string;
  output_contract?: string;
  summary?: string;
  result_status?: "success" | "partial" | "failed";
  output_ref?: string;
  error_code?: string;
  recovery_suggestion?: string;
  sandbox?: WorkTaskSandbox;
  spawn_reason?: string;
  requested_by?: string;
  blocked_reason?: string;
  changed_files?: string[];
  tests_run?: string[];
  intermediate_artifacts?: string[];
  status?: string;
};

export type WorkSessionRecord = {
  schema_version: typeof SWARM_WORK_PROTOCOL_VERSION;
  kind: "session";
  at: string;
  session_id: string;
  parent_session_id?: string;
  status: string;
  objective?: string;
};

export function buildWorkRunRecord(input: WorkProtocolContext & {
  at: string;
  phase: WorkRunRecord["phase"];
  sessionId?: string;
  status?: WorkRunRecord["status"];
  message?: string;
}): WorkRunRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "run",
    phase: input.phase,
    at: input.at,
    session_id: input.sessionId,
    objective: input.objective,
    workspace: input.workspace,
    mode: input.mode,
    permission_mode: input.permissionMode,
    sandbox_mode: input.sandboxMode,
    tool_policy: input.toolPolicy,
    additional_read_directories: input.additionalReadDirectories,
    operation: input.operation,
    resume_session_id: input.resumeSessionId,
    status: input.status,
    message: input.message
  });
}

export function buildWorkRecordFromRuntimeEvent(event: RuntimeEvent, at: string): WorkProtocolRecord {
  if (event.type === "queue") {
    return queueWorkRecord(event, at);
  }
  if (event.type === "approval") {
    return approvalWorkRecord(event, at);
  }
  if (event.type === "tool_result") {
    return toolResultWorkRecord(event, at);
  }
  if (event.type === "loop_activity") {
    return activityWorkRecord(event, at);
  }
  if (event.type === "control") {
    return controlWorkRecord(event, at);
  }
  if (event.type === "session") {
    return stripUndefined({
      schema_version: SWARM_WORK_PROTOCOL_VERSION,
      kind: "session",
      at,
      session_id: event.session_id,
      parent_session_id: event.parent_session_id,
      status: event.status,
      objective: event.objective
    });
  }
  if (event.type === "task_attempt") {
    return stripUndefined({
      schema_version: SWARM_WORK_PROTOCOL_VERSION,
      kind: "task",
      at,
      session_id: event.session_id,
      task_id: event.task_id,
      phase: event.status,
      title: event.title,
      status: event.status
    });
  }
  if (event.type === "task") {
    return stripUndefined({
      schema_version: SWARM_WORK_PROTOCOL_VERSION,
      kind: "task",
      at,
      session_id: event.session_id,
      task_id: event.task_id,
      phase: taskPhase(event.status),
      title: event.title,
      capability: event.capability,
      write_policy: event.write_policy,
      file_scope: event.file_scope,
      status: event.status
    });
  }
  if (event.type === "worker") {
    return workerWorkRecord(event.worker, event.status, at);
  }
  if (event.type === "agent_spawn_decision") {
    return stripUndefined({
      schema_version: SWARM_WORK_PROTOCOL_VERSION,
      kind: "task",
      at,
      task_id: event.worker_id,
      worker_id: event.worker_id,
      agent_label: agentIdentityLabel({
        worker_id: event.worker_id,
        display_name: event.decision.display_name,
        role_title: event.decision.role_title,
        agent_spec_id: event.decision.agent_spec_id,
        invocation_mode: event.decision.invocation_mode
      }),
      phase: "queued",
      title: event.task_packet.objective,
      session_id: event.parent_session_id,
      parent_session_id: event.parent_session_id,
      agent_spec_id: event.decision.agent_spec_id,
      invocation_mode: event.decision.invocation_mode,
      write_policy: event.task_packet.write_policy,
      file_scope: event.task_packet.file_scope,
      tool_budget: event.task_packet.budget,
      output_contract: event.task_packet.expected_output,
      spawn_reason: event.decision.reason,
      status: `${event.decision.agent_spec_id}/${event.decision.invocation_mode}`
    });
  }
  if (event.type === "agent_run_started") {
    return workerWorkRecord(event.worker, "running", at);
  }
  if (event.type === "agent_run_completed") {
    return workerWorkRecord(event.worker, event.worker.status, at);
  }
  if (event.type === "handoff_started") {
    return handoffWorkRecord(event.handoff, "running", at);
  }
  if (event.type === "handoff_returned" || event.type === "handoff_taken_back") {
    return handoffWorkRecord(event.handoff, event.handoff.status === "returned" ? "completed" : "failed", at);
  }
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "runtime_event",
    at,
    event_type: event.type,
    session_id: runtimeEventSessionId(event),
    task_id: runtimeEventTaskId(event),
    worker_id: runtimeEventWorkerId(event),
    summary: runtimeEventSummary(event),
    event
  });
}

function workerWorkRecord(
  worker: Extract<RuntimeEvent, { type: "worker" }>["worker"],
  status: string,
  at: string
): WorkTaskRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "task",
    at,
    session_id: worker.parent_session_id,
    task_id: worker.worker_id,
    worker_id: worker.worker_id,
    agent_label: agentIdentityLabel({
      worker_id: worker.worker_id,
      display_name: worker.display_name,
      role_title: worker.role_title,
      agent_spec_id: worker.agent_spec_id,
      invocation_mode: worker.invocation_mode
    }),
    parent_session_id: worker.parent_session_id,
    worker_session_id: worker.worker_session_id,
    agent_spec_id: worker.agent_spec_id,
    invocation_mode: worker.invocation_mode,
    handoff_id: worker.handoff_id,
    capability: worker.capability,
    write_policy: worker.task_packet?.write_policy,
    file_scope: worker.file_scope,
    tool_budget: worker.tool_budget,
    output_contract: worker.output_contract,
    spawn_reason: worker.spawn_reason,
    requested_by: worker.requested_by,
    blocked_reason: worker.blocked_reason,
    changed_files: worker.outcome?.changed_files,
    tests_run: worker.outcome?.tests_run,
    intermediate_artifacts: worker.outcome?.intermediate_artifacts,
    phase: workerTaskPhase(status),
    title: worker.objective,
    status: [
      worker.agent_spec_id,
      worker.invocation_mode,
      status
    ].filter(Boolean).join("/") || status
  });
}

function handoffWorkRecord(
  handoff: Extract<RuntimeEvent, { type: "handoff_started" }>["handoff"],
  status: string,
  at: string
): WorkTaskRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "task",
    at,
    session_id: handoff.parent_session_id,
    task_id: handoff.handoff_id,
    worker_id: handoff.worker_id,
    agent_label: handoff.target_agent_spec_id,
    parent_session_id: handoff.parent_session_id,
    handoff_id: handoff.handoff_id,
    agent_spec_id: handoff.target_agent_spec_id,
    invocation_mode: "handoff",
    source_agent: handoff.source_agent,
    target_agent_spec_id: handoff.target_agent_spec_id,
    write_policy: handoff.task_packet.write_policy,
    file_scope: handoff.task_packet.file_scope,
    tool_budget: handoff.task_packet.budget,
    output_contract: handoff.task_packet.expected_output,
    phase: workerTaskPhase(status),
    title: handoff.task_packet.objective,
    status: `${handoff.target_agent_spec_id}/${handoff.status}`
  });
}

function approvalWorkRecord(event: Extract<RuntimeEvent, { type: "approval" }>, at: string): WorkPermissionRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "permission",
    at,
    session_id: event.request.session_id,
    task_id: event.request.task_id,
    approval_id: event.request.id,
    status: event.status,
    action: event.request.action,
    risk: event.request.risk,
    risk_class: event.request.risk_class,
    target: event.request.target,
    summary: event.request.summary,
    permission_decision: event.request.permission_decision,
    permission_reason: event.request.permission_reason,
    permission_mode: event.request.permission_mode,
    permission_name: event.request.permission_name,
    permission_rule: event.request.permission_rule
  });
}

function toolResultWorkRecord(event: Extract<RuntimeEvent, { type: "tool_result" }>, at: string): WorkTaskRecord {
  const resultStatus = event.status ?? "success";
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "task",
    at,
    session_id: event.session_id,
    task_id: event.task_id,
    worker_id: event.agent?.worker_id,
    agent_label: agentIdentityLabel(event.agent),
    phase: toolResultTaskPhase(resultStatus),
    title: event.title,
    attempt: event.attempt,
    agent_spec_id: event.agent?.agent_spec_id,
    invocation_mode: event.agent?.invocation_mode,
    capability: event.action,
    action: event.action,
    write_policy: event.write_policy,
    file_scope: event.file_scope,
    summary: event.summary,
    result_status: resultStatus,
    output_ref: event.outputRef,
    error_code: event.errorCode,
    recovery_suggestion: event.recoverySuggestion,
    sandbox: taskSandboxMetadata(event),
    status: resultStatus
  });
}

function controlWorkRecord(event: Extract<RuntimeEvent, { type: "control" }>, at: string): WorkControlRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "control",
    at,
    message_id: event.message_id,
    action: event.action,
    reason: event.reason,
    instruction: event.instruction
  });
}

function queueWorkRecord(event: Extract<RuntimeEvent, { type: "queue" }>, at: string): WorkQueueRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "queue",
    at,
    session_id: event.session_id,
    queue: event.queue,
    operation: event.operation,
    id: event.id,
    worker_id: event.queue === "worker_slots" ? event.id : undefined,
    priority: event.priority,
    size: event.size,
    message: event.message
  });
}

function activityWorkRecord(event: Extract<RuntimeEvent, { type: "loop_activity" }>, at: string): WorkActivityRecord {
  return stripUndefined({
    schema_version: SWARM_WORK_PROTOCOL_VERSION,
    kind: "activity",
    at,
    session_id: event.session_id,
    phase: event.phase,
    message: event.message,
    worker_id: event.agent?.worker_id,
    agent_label: agentIdentityLabel(event.agent),
    agent_spec_id: event.agent?.agent_spec_id,
    invocation_mode: event.agent?.invocation_mode,
    turn: event.turn,
    tool: event.tool,
    task_id: event.task_id,
    status: event.status,
    summary: event.summary,
    error_code: event.errorCode,
    recovery_suggestion: event.recoverySuggestion
  });
}

function runtimeEventSessionId(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "queue":
      return event.session_id;
    case "session":
    case "plan":
    case "review_started":
    case "review_completed":
    case "verification_started":
    case "verification_completed":
    case "workspace_change":
    case "final":
    case "loop_activity":
      return event.session_id;
    case "tool_result":
    case "task_attempt":
    case "live_message":
    case "handoff_message":
      return event.session_id;
    case "worker":
    case "agent_run_started":
    case "agent_run_completed":
      return event.worker.parent_session_id;
    case "agent_spawn_decision":
      return event.parent_session_id;
    default:
      return undefined;
  }
}

function runtimeEventTaskId(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "queue":
      return event.queue === "worker_slots" ? event.id : undefined;
    case "task":
    case "task_attempt":
    case "tool_result":
      return event.task_id;
    case "loop_activity":
      return event.task_id;
    case "handoff_message":
      return event.handoff_id;
    case "worker":
    case "agent_run_started":
    case "agent_run_completed":
      return event.worker.worker_id;
    case "agent_spawn_decision":
      return event.worker_id;
    default:
      return undefined;
  }
}

function runtimeEventWorkerId(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "loop_activity":
    case "tool_result":
      return event.agent?.worker_id;
    case "queue":
      return event.queue === "worker_slots" ? event.id : undefined;
    case "handoff_message":
      return event.worker_id;
    case "worker":
    case "agent_run_started":
    case "agent_run_completed":
      return event.worker.worker_id;
    case "agent_spawn_decision":
      return event.worker_id;
    default:
      return undefined;
  }
}

function agentIdentityLabel(agent: RuntimeAgentIdentity | undefined): string | undefined {
  if (!agent) {
    return undefined;
  }
  const name = agent.display_name?.trim() || agent.agent_id || agent.worker_id || agent.agent_spec_id || agent.capability || agent.role;
  if (!name) {
    return undefined;
  }
  const role = agent.role_title?.trim();
  return role ? `${name} / ${role}` : name;
}

function runtimeEventSummary(event: RuntimeEvent): string {
  switch (event.type) {
    case "queue":
      return [
        `${event.queue} ${event.operation}`,
        `size=${event.size}`,
        event.message
      ].filter(Boolean).join(" ");
    case "log":
      return event.message;
    case "error":
      return event.message;
    case "controller":
      return event.reason;
    case "loop_activity":
      return event.message;
    case "tool_result":
      return event.summary;
    case "final":
      return event.content.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "Final response";
    case "provider_usage":
      return `${event.usage.providerId}/${event.usage.model} ${event.usage.purpose}`;
    case "agent_spawn_decision":
      return `${event.worker_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode}`;
    case "agent_run_started":
      return `Worker started: ${event.worker.worker_id}`;
    case "agent_run_completed":
      return `Worker completed: ${event.worker.worker_id}`;
    case "handoff_message":
      return event.message;
    default:
      return event.type;
  }
}

function taskSandboxMetadata(event: Extract<RuntimeEvent, { type: "tool_result" }>): WorkTaskSandbox | undefined {
  const sandbox = event.sandbox;
  if (!sandbox) {
    return undefined;
  }
  return stripUndefined({
    status: sandbox.decision === "deny" ? "denied" : "allowed",
    policy: sandbox.policy,
    subject: sandbox.subject,
    action: sandbox.action ?? event.action,
    capability_id: sandbox.capability_id,
    reason: sandbox.reason,
    targets: sandbox.targets,
    file_scope: sandbox.file_scope
  });
}

function taskPhase(status: string): WorkTaskRecord["phase"] {
  if (status === "queued" || status === "assigned") {
    return "queued";
  }
  if (status === "running" || status === "started") {
    return "running";
  }
  if (status === "completed" || status === "failed") {
    return status;
  }
  return "unknown";
}

function toolResultTaskPhase(status: "success" | "partial" | "failed"): WorkTaskRecord["phase"] {
  return status === "failed" ? "failed" : "completed";
}

function workerTaskPhase(status: string): WorkTaskRecord["phase"] {
  if (status === "pending") {
    return "queued";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "completed" || status === "failed") {
    return status;
  }
  if (status === "stopped") {
    return "failed";
  }
  return "unknown";
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = stripUndefined(item);
    }
  }
  return output as T;
}
