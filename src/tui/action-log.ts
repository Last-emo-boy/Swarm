import type { RuntimeEvent } from "../runtime/events.js";
import { formatRuntimeEventBrief, formatWorkerBrief, formatWorkerDetail } from "../runtime/event-formatters.js";
import { formatRecoveryAdviceInline } from "../runtime/recovery.js";
import { buildWorkRecordFromRuntimeEvent, type WorkProtocolRecord } from "../runtime/work-protocol.js";
import { declaredToolTaskFileScope, declaredToolTaskWritePolicy } from "../runtime/tool-task-sandbox.js";

export type ActionLogMessage = {
  role: "user" | "assistant" | "system";
  brief: string;
  detail?: string;
  preview?: string;
};

export type TuiActionStatus = "info" | "running" | "pending" | "success" | "warning" | "error";

export type TuiActionRow = {
  id: string;
  kind: string;
  status: TuiActionStatus;
  title: string;
  summary?: string;
  meta?: string;
  details: string[];
};

export function buildActionLogRows(input: {
  messages: ActionLogMessage[];
  events: RuntimeEvent[];
}): TuiActionRow[] {
  return [
    ...input.messages.map(messageToActionRow),
    ...input.events.map(runtimeEventToActionRow)
  ];
}

export function messageToActionRow(message: ActionLogMessage, index: number): TuiActionRow {
  const title = message.role === "assistant"
    ? "Assistant response"
    : message.role === "user"
      ? "User request"
      : "System";
  return {
    id: `message:${index}:${message.role}:${message.brief}`,
    kind: `message:${message.role}`,
    status: message.role === "assistant" ? "success" : message.role === "user" ? "pending" : "info",
    title,
    summary: message.brief,
    details: compactLines(message.preview, message.detail)
  };
}

export function runtimeEventToActionRow(event: RuntimeEvent, index: number): TuiActionRow {
  const work = buildWorkRecordFromRuntimeEvent(event, new Date(0).toISOString());
  const workRow = workProtocolToActionRow(work, event, index);
  // Keep successful tool calls compact in the trace. Full stdout/stderr still lives
  // behind Enter/Ctrl+O via the explicit tool_result row below.
  if (workRow && !(event.type === "tool_result" && work.kind === "task")) {
    return workRow;
  }

  switch (event.type) {
    case "log":
      return row(event, index, "log", event.level === "error" ? "error" : event.level === "warn" ? "warning" : "info", `${event.level.toUpperCase()} log`, event.message);

    case "error":
      return row(event, index, "error", "error", "Runtime error", event.message);

    case "session":
      return row(
        event,
        index,
        "session",
        statusFromText(event.status),
        `Session ${shortId(event.session_id)} ${event.status}`,
        event.objective,
        compactLines(
          event.parent_session_id ? `parent=${event.parent_session_id}` : undefined,
          `session_id=${event.session_id}`
        )
      );

    case "controller":
      return row(
        event,
        index,
        "controller",
        "running",
        `Controller ${event.action}`,
        event.reason,
        compactLines(
          event.confidence !== undefined ? `confidence=${Math.round(event.confidence * 100)}%` : undefined,
          event.instruction ? `instruction=${event.instruction}` : undefined,
          event.details ? `details=${safeJson(event.details)}` : undefined
        )
      );

    case "queue":
      return row(
        event,
        index,
        "queue",
        event.queue === "worker_slots" && event.operation === "enqueue" ? "pending" : "info",
        `Queue ${event.queue} ${event.operation}`,
        `size=${event.size}${event.priority ? ` priority=${event.priority}` : ""}`,
        compactLines(
          event.session_id ? `session=${event.session_id}` : undefined,
          event.id ? `id=${event.id}` : undefined,
          event.message
        )
      );

    case "worker":
      return row(
        event,
        index,
        "worker",
        statusFromText(event.status),
        "Worker update",
        formatWorkerBrief(event.worker),
        compactLines(event.message, formatWorkerDetail(event.worker))
      );

    case "agent_spawn_decision":
      return row(
        event,
        index,
        "agent",
        "running",
        `Spawn ${event.worker_id}`,
        `${event.decision.agent_spec_id}/${event.decision.invocation_mode} confidence=${Math.round(event.decision.confidence * 100)}%`,
        compactLines(
          `parent=${event.parent_session_id}`,
          `reason=${event.decision.reason}`,
          event.decision.display_name ? `display=${event.decision.display_name}` : undefined,
          event.decision.role_title ? `role=${event.decision.role_title}` : undefined,
          `objective=${event.task_packet.objective}`,
          `policy=${event.task_packet.write_policy}`,
          event.task_packet.file_scope.length ? `scope=${event.task_packet.file_scope.join(", ")}` : undefined,
          event.task_packet.allowed_tools.length ? `tools=${event.task_packet.allowed_tools.join(", ")}` : undefined,
          event.task_packet.expected_output ? `output=${event.task_packet.expected_output}` : undefined
        )
      );

    case "agent_run_started":
      return row(
        event,
        index,
        "agent",
        "running",
        "Agent run started",
        formatWorkerBrief(event.worker),
        compactLines(
          `objective=${event.task_packet.objective}`,
          `policy=${event.task_packet.write_policy}`,
          event.task_packet.file_scope.length ? `scope=${event.task_packet.file_scope.join(", ")}` : undefined,
          event.task_packet.allowed_tools.length ? `tools=${event.task_packet.allowed_tools.join(", ")}` : undefined
        )
      );

    case "agent_run_completed":
      return row(
        event,
        index,
        "agent",
        statusFromText(event.worker.status),
        "Agent run completed",
        formatWorkerBrief(event.worker),
        compactLines(event.result)
      );

    case "handoff_started":
      return row(
        event,
        index,
        "handoff",
        "running",
        "Handoff started",
        `${event.handoff.handoff_id} -> ${event.handoff.target_agent_spec_id}`,
        compactLines(safeJson(event.handoff))
      );

    case "handoff_message":
      return row(event, index, "handoff", "running", `Handoff message ${shortId(event.handoff_id)}`, event.message);

    case "handoff_returned":
      return row(
        event,
        index,
        "handoff",
        statusFromText(event.handoff.status),
        "Handoff returned",
        `${event.handoff.handoff_id} [${event.handoff.status}]`,
        compactLines(event.result, safeJson(event.handoff))
      );

    case "handoff_taken_back":
      return row(event, index, "handoff", "warning", "Handoff taken back", `${event.handoff.handoff_id} [${event.handoff.status}]`, compactLines(safeJson(event.handoff)));

    case "workspace_change":
      return row(
        event,
        index,
        "workspace",
        event.change.operation === "delete" ? "warning" : "success",
        `Workspace ${event.change.operation}`,
        event.change.path,
        compactLines(
          `bytes ${event.change.beforeBytes} -> ${event.change.afterBytes}`,
          event.change.beforeHash ? `before=${event.change.beforeHash}` : undefined,
          `after=${event.change.afterHash}`,
          event.change.sessionId ? `session=${event.change.sessionId}` : undefined,
          event.change.taskId ? `task=${event.change.taskId}` : undefined,
          event.change.lockKey ? `lock=${event.change.lockKey}` : undefined
        )
      );

    case "file_lock":
      return row(
        event,
        index,
        "lock",
        event.event.status === "blocked" ? "warning" : "info",
        `File lock ${event.event.status}`,
        event.event.path,
        compactLines(
          `key=${event.event.key}`,
          event.event.holder ? `holder=${event.event.holder}` : undefined,
          event.event.reason ? `reason=${event.event.reason}` : undefined,
          event.event.sessionId ? `session=${event.event.sessionId}` : undefined,
          event.event.taskId ? `task=${event.event.taskId}` : undefined
        )
      );

    case "review_started":
      return row(event, index, "review", "running", "Review started", event.objective, compactLines(`session=${event.session_id}`));

    case "review_completed":
      return row(
        event,
        index,
        "review",
        event.result.verdict === "approve" ? "success" : event.result.verdict === "reject" ? "error" : "warning",
        `Review ${event.result.verdict}`,
        `score=${event.result.score} ${event.result.summary}`,
        compactLines(
          `target=${event.result.target_task_id}`,
          ...((event.result.issues ?? []).map((issue) =>
            `${issue.severity}${issue.task_id ? ` ${issue.task_id}` : ""}: ${issue.message}${issue.suggested_fix ? ` fix=${issue.suggested_fix}` : ""}`
          ))
        )
      );

    case "verification_started":
      return row(event, index, "verify", "running", "Verification started", event.objective, compactLines(`session=${event.session_id}`));

    case "verification_completed":
      return row(
        event,
        index,
        "verify",
        statusFromText(event.result.status),
        `Verification ${event.result.status}`,
        event.result.summary,
        compactLines(
          event.result.worker_id ? `worker=${event.result.worker_id}` : undefined,
          event.result.content
        )
      );

    case "self_review":
      return row(
        event,
        index,
        "review",
        event.findings.length ? "warning" : "success",
        "Self review",
        event.summary,
        compactLines(
          `inspected logs=${event.inspected.logs} sessions=${event.inspected.sessions} artifacts=${event.inspected.artifacts}`,
          ...event.findings.map((finding) => `finding=${finding}`),
          ...event.recommendations.map((recommendation) => `recommendation=${recommendation}`)
        )
      );

    case "eval_result":
      return row(event, index, "eval", event.status === "pass" ? "success" : "error", `Eval ${event.status}`, event.name, compactLines(event.message));

    case "agent":
      return row(
        event,
        index,
        "agent",
        statusFromText(event.card.status),
        `Agent ${event.card.name || event.card.agent_id}`,
        `[${event.card.status}] running=${event.card.load.running_tasks}/${event.card.load.max_tasks}`,
        compactLines(safeJson(event.card))
      );

    case "envelope":
      return row(event, index, "envelope", "info", `Envelope ${event.envelope.type}`, event.envelope.task_id, compactLines(safeJson(event.envelope)));

    case "plan":
      return row(
        event,
        index,
        "plan",
        "pending",
        `Plan ${shortId(event.session_id)}`,
        event.plan.summary,
        compactLines(
          `objective=${event.plan.objective}`,
          event.plan.intent ? `intent=${event.plan.intent}` : undefined,
          ...event.plan.tasks.map((task, taskIndex) => formatPlanTask(task, taskIndex)),
          event.plan.final_artifact ? `artifact=${event.plan.final_artifact.path} (${event.plan.final_artifact.format})` : undefined
        )
      );

    case "task":
      return row(event, index, "task", statusFromText(event.status), `Task ${event.status}`, event.title || event.task_id, compactLines(`task=${event.task_id}`));

    case "task_attempt":
      return row(
        event,
        index,
        "attempt",
        statusFromText(event.status),
        `Attempt ${event.attempt} ${event.status}`,
        event.title || event.task_id,
        compactLines(event.session_id ? `session=${event.session_id}` : undefined, `task=${event.task_id}`)
      );

    case "blackboard":
      return row(
        event,
        index,
        "blackboard",
        "info",
        `Blackboard ${event.entry.type}`,
        event.entry.key,
        compactLines(
          `session=${event.entry.session_id}`,
          event.entry.task_id ? `task=${event.entry.task_id}` : undefined,
          `visibility=${event.entry.visibility} version=${event.entry.version}`,
          event.entry.tags?.length ? `tags=${event.entry.tags.join(", ")}` : undefined,
          `value=${safeJson(event.entry.value)}`
        )
      );

    case "approval":
      return row(
        event,
        index,
        "approval",
        event.status === "pending" ? "pending" : event.status === "approved" ? "success" : "error",
        `Approval ${event.status}`,
        `${event.request.action} ${event.request.risk_class}/${event.request.risk}: ${event.request.summary}`,
        compactLines(
          `target=${event.request.target}`,
          `why=${event.request.why_now}`,
          event.request.attention_note ? `attention=${event.request.attention_note}` : undefined,
          `impact=${event.request.predicted_impact}`,
          `rollback=${event.request.rollback_plan}`,
          event.request.detail,
          event.request.summary_diff ? `diff=${event.request.summary_diff}` : undefined
        )
      );

    case "live_message":
      return row(event, index, "live", statusFromText(event.status), `Live message ${event.status}`, event.content, compactLines(event.session_id ? `session=${event.session_id}` : undefined, `message=${event.id}`));

    case "control":
      return row(
        event,
        index,
        "control",
        event.action === "ask_clarification" ? "pending" : "warning",
        `Control ${event.action}`,
        event.reason,
        compactLines(`message=${event.message_id}`, `instruction=${event.instruction}`)
      );

    case "loop_activity":
      return row(
        event,
        index,
        "activity",
        loopStatus(event.phase),
        `AI ${event.phase.replace(/_/g, " ")}`,
        event.message,
        compactLines(
          `session=${event.session_id}`,
          event.agent ? `agent=${agentIdentityLabel(event.agent)}` : undefined,
          event.agent?.worker_id ? `worker=${event.agent.worker_id}` : undefined,
          event.turn ? `turn=${event.turn}` : undefined,
          event.tool ? `tool=${event.tool}` : undefined,
          event.task_id ? `task=${event.task_id}` : undefined
        )
      );

    case "final":
      return row(
        event,
        index,
        "final",
        statusFromText(event.status ?? "completed"),
        `Final ${event.status ?? "completed"}`,
        event.content,
        compactLines(
          `session=${event.session_id}`,
          event.artifact_path ? `artifact=${event.artifact_path}` : undefined,
          event.outcome?.changed_files.length ? `changed=${event.outcome.changed_files.join(", ")}` : undefined,
          event.outcome?.tests_run.length ? `checks=${event.outcome.tests_run.join(", ")}` : undefined,
          event.outcome?.intermediate_artifacts.length ? `artifacts=${event.outcome.intermediate_artifacts.join(", ")}` : undefined
        )
      );

    case "tool_result":
      return row(
        event,
        index,
        "tool",
        statusFromText(event.status ?? "completed"),
        `Tool ${event.action}`,
        event.summary,
        compactLines(
          event.title ? `title=${event.title}` : undefined,
          event.session_id ? `session=${event.session_id}` : undefined,
          event.agent ? `agent=${agentIdentityLabel(event.agent)}` : undefined,
          event.agent?.worker_id ? `worker=${event.agent.worker_id}` : undefined,
          `task=${event.task_id}`,
          event.attempt ? `attempt=${event.attempt}` : undefined,
          event.outputRef ? `output=${event.outputRef}` : undefined,
          event.errorCode ? `error=${event.errorCode}` : undefined,
          event.recoverySuggestion ? `recovery=${event.recoverySuggestion}` : undefined,
          event.recovery ? `recovery_detail=${formatRecoveryAdviceInline(event.recovery)}` : undefined,
          event.write_policy ? `policy=${event.write_policy}` : undefined,
          event.file_scope?.length ? `scope=${event.file_scope.join(",")}` : undefined,
          event.sandbox ? `sandbox=${event.sandbox.policy}/${event.sandbox.decision} ${event.sandbox.reason}` : undefined,
          event.sandbox?.targets?.length ? `targets=${event.sandbox.targets.join(",")}` : undefined,
          event.sandbox?.file_scope?.length
            ? `${event.file_scope?.length ? "sandbox_scope" : "scope"}=${event.sandbox.file_scope.join(",")}`
            : undefined,
          event.capability ? `capability=${event.capability.providerId}/${event.capability.id} ${event.capability.riskClass}` : undefined,
          event.content
        )
      );

    case "provider_usage":
      return row(
        event,
        index,
        "usage",
        "info",
        `Usage ${event.usage.providerId}/${event.usage.model}`,
        `${event.usage.purpose} ${event.usage.totalTokens ?? "?"} tokens ${event.usage.durationMs}ms`,
        compactLines(safeJson(event.usage))
      );

    case "progress":
      return row(event, index, "progress", event.completed >= event.total && event.total > 0 ? "success" : "running", "Progress", `${event.completed}/${event.total}`);
  }
}

export function workProtocolToActionRow(
  work: WorkProtocolRecord,
  event: RuntimeEvent | undefined,
  index: number
): TuiActionRow | undefined {
  switch (work.kind) {
    case "session":
      return {
        id: `work:${index}:session:${work.session_id}:${work.status}`,
        kind: "work:session",
        status: statusFromText(work.status),
        title: `Session ${shortId(work.session_id)} ${work.status}`,
        summary: work.objective,
        meta: work.schema_version,
        details: compactLines(
          work.parent_session_id ? `parent=${work.parent_session_id}` : undefined,
          `session_id=${work.session_id}`,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "task":
      return {
        id: `work:${index}:task:${work.task_id}:${work.phase}:${work.status ?? ""}`,
        kind: "work:task",
        status: statusFromText(work.result_status ?? work.phase),
        title: work.action ? `Tool ${work.action}` : `Task ${work.phase}`,
        summary: work.summary ?? work.title,
        meta: work.schema_version,
        details: compactLines(
          work.session_id ? `session=${work.session_id}` : undefined,
          `task=${work.task_id}`,
          work.title !== work.summary ? `title=${work.title}` : undefined,
          work.attempt ? `attempt=${work.attempt}` : undefined,
          work.agent_label ? `agent=${work.agent_label}` : undefined,
          work.worker_id ? `worker=${work.worker_id}` : undefined,
          work.parent_session_id ? `parent=${work.parent_session_id}` : undefined,
          work.worker_session_id ? `worker_session=${work.worker_session_id}` : undefined,
          work.agent_spec_id ? `agent=${work.agent_spec_id}` : undefined,
          work.invocation_mode ? `mode=${work.invocation_mode}` : undefined,
          work.handoff_id ? `handoff=${work.handoff_id}` : undefined,
          work.capability ? `capability=${work.capability}` : undefined,
          work.action ? `action=${work.action}` : undefined,
          work.write_policy ? `policy=${work.write_policy}` : undefined,
          work.file_scope?.length ? `scope=${work.file_scope.join(", ")}` : undefined,
          work.tool_budget ? `budget=${work.tool_budget.max_turns}/${work.tool_budget.max_tool_calls}` : undefined,
          work.source_agent ? `source=${work.source_agent}` : undefined,
          work.target_agent_spec_id ? `target=${work.target_agent_spec_id}` : undefined,
          work.output_contract ? `output=${work.output_contract}` : undefined,
          work.output_ref ? `output_ref=${work.output_ref}` : undefined,
          work.error_code ? `error=${work.error_code}` : undefined,
          work.recovery_suggestion ? `recovery=${work.recovery_suggestion}` : undefined,
          work.recovery ? `recovery_detail=${formatRecoveryAdviceInline(work.recovery)}` : undefined,
          work.sandbox ? `sandbox=${work.sandbox.policy}/${work.sandbox.status} ${work.sandbox.reason}` : undefined,
          work.sandbox?.targets?.length ? `targets=${work.sandbox.targets.join(", ")}` : undefined,
          work.sandbox?.file_scope?.length
            ? `${work.file_scope?.length ? "sandbox_scope" : "scope"}=${work.sandbox.file_scope.join(", ")}`
            : undefined,
          work.spawn_reason ? `reason=${work.spawn_reason}` : undefined,
          work.requested_by ? `requested_by=${work.requested_by}` : undefined,
          work.blocked_reason ? `blocked=${work.blocked_reason}` : undefined,
          work.changed_files?.length ? `changed=${work.changed_files.join(", ")}` : undefined,
          work.tests_run?.length ? `checks=${work.tests_run.join(", ")}` : undefined,
          work.intermediate_artifacts?.length ? `artifacts=${work.intermediate_artifacts.join(", ")}` : undefined,
          work.status ? `status=${work.status}` : undefined,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "permission":
      return {
        id: `work:${index}:permission:${work.approval_id}:${work.status}`,
        kind: "work:permission",
        status: work.status === "pending" ? "pending" : work.status === "approved" ? "success" : "error",
        title: `Permission ${work.status}`,
        summary: `${work.action} ${work.risk_class}/${work.risk}: ${work.summary}`,
        meta: work.schema_version,
        details: compactLines(
          work.session_id ? `session=${work.session_id}` : undefined,
          work.task_id ? `task=${work.task_id}` : undefined,
          `approval=${work.approval_id}`,
          `target=${work.target}`,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "sandbox":
      return {
        id: `work:${index}:sandbox:${work.task_id ?? ""}:${work.policy}:${work.status}`,
        kind: "work:sandbox",
        status: work.status === "denied" ? "error" : "success",
        title: `Sandbox ${work.status}`,
        summary: `${work.policy}/${work.subject}: ${work.reason}`,
        meta: work.schema_version,
        details: compactLines(
          work.session_id ? `session=${work.session_id}` : undefined,
          work.task_id ? `task=${work.task_id}` : undefined,
          work.action ? `action=${work.action}` : undefined,
          work.capability_id ? `capability=${work.capability_id}` : undefined,
          work.targets?.length ? `targets=${work.targets.join(", ")}` : undefined,
          work.file_scope?.length ? `scope=${work.file_scope.join(", ")}` : undefined,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "control":
      return {
        id: `work:${index}:control:${work.message_id ?? ""}:${work.action}`,
        kind: "work:control",
        status: work.action === "ask_clarification" ? "pending" : "warning",
        title: `Control ${work.action}`,
        summary: work.reason,
        meta: work.schema_version,
        details: compactLines(
          work.session_id ? `session=${work.session_id}` : undefined,
          work.message_id ? `message=${work.message_id}` : undefined,
          work.instruction ? `instruction=${work.instruction}` : undefined,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "queue":
      return {
        id: `work:${index}:queue:${work.queue}:${work.operation}:${work.id ?? ""}`,
        kind: "work:queue",
        status: work.queue === "worker_slots" && work.operation === "enqueue" ? "pending" : "info",
        title: `Queue ${work.queue} ${work.operation}`,
        summary: `size=${work.size}${work.priority ? ` priority=${work.priority}` : ""}`,
        meta: work.schema_version,
        details: compactLines(
          work.session_id ? `session=${work.session_id}` : undefined,
          work.id ? `id=${work.id}` : undefined,
          work.worker_id ? `worker=${work.worker_id}` : undefined,
          work.message,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "activity":
      return {
        id: `work:${index}:activity:${work.session_id}:${work.phase}:${work.task_id ?? ""}:${work.tool ?? ""}`,
        kind: "work:activity",
        status: loopStatus(work.phase),
        title: `Activity ${work.phase.replace(/_/g, " ")}`,
        summary: work.agent_label ? `${work.agent_label}: ${work.message}` : work.message,
        meta: work.schema_version,
        details: compactLines(
          `session=${work.session_id}`,
          work.agent_label ? `agent=${work.agent_label}` : undefined,
          work.worker_id ? `worker=${work.worker_id}` : undefined,
          work.agent_spec_id ? `agent_spec=${work.agent_spec_id}` : undefined,
          work.invocation_mode ? `mode=${work.invocation_mode}` : undefined,
          work.task_id ? `task=${work.task_id}` : undefined,
          work.turn ? `turn=${work.turn}` : undefined,
          work.tool ? `tool=${work.tool}` : undefined,
          work.status ? `status=${work.status}` : undefined,
          work.summary ? `summary=${work.summary}` : undefined,
          work.error_code ? `error=${work.error_code}` : undefined,
          work.recovery_suggestion ? `recovery=${work.recovery_suggestion}` : undefined,
          work.recovery ? `recovery_detail=${formatRecoveryAdviceInline(work.recovery)}` : undefined,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "run":
      return {
        id: `work:${index}:run:${work.phase}:${work.session_id ?? ""}`,
        kind: "work:run",
        status: statusFromText(work.status ?? work.phase),
        title: `Run ${work.phase}`,
        summary: work.objective ?? work.message,
        meta: work.schema_version,
        details: compactLines(
          work.session_id ? `session=${work.session_id}` : undefined,
          work.mode ? `mode=${work.mode}` : undefined,
          work.permission_mode ? `permission=${work.permission_mode}` : undefined,
          work.sandbox_mode ? `sandbox=${work.sandbox_mode}` : undefined,
          work.operation ? `operation=${work.operation}` : undefined,
          work.resume_session_id ? `resume=${work.resume_session_id}` : undefined,
          event ? `runtime=${safeJson(event)}` : undefined
        )
      };
    case "runtime_event":
      return undefined;
  }
}

function row(
  event: RuntimeEvent,
  index: number,
  kind: string,
  status: TuiActionStatus,
  title: string,
  summary?: string,
  details: string[] = []
): TuiActionRow {
  return {
    id: `${index}:${event.type}:${formatRuntimeEventBrief(event)}`,
    kind,
    status,
    title,
    summary,
    meta: event.type,
    details
  };
}

function compactLines(...items: Array<string | undefined>): string[] {
  return items.flatMap((item) => {
    if (!item) {
      return [];
    }
    return item
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  });
}

function formatPlanTask(
  task: Extract<RuntimeEvent, { type: "plan" }>["plan"]["tasks"][number],
  taskIndex: number
): string {
  const inputs = task.inputs && typeof task.inputs === "object" ? task.inputs : {};
  const action = typeof inputs.action === "string" && inputs.action.trim().length ? inputs.action.trim() : undefined;
  const writePolicy = declaredToolTaskWritePolicy(inputs);
  const fileScope = declaredToolTaskFileScope(inputs);
  return [
    `${taskIndex + 1}. ${task.title} [${task.status}]`,
    `id=${task.task_id}`,
    task.required_capabilities.length ? `caps=${task.required_capabilities.join(",")}` : undefined,
    action ? `action=${action}` : undefined,
    writePolicy ? `policy=${writePolicy}` : undefined,
    fileScope?.length ? `scope=${fileScope.join(",")}` : undefined
  ].filter(Boolean).join(" ");
}

function statusFromText(status: string): TuiActionStatus {
  const normalized = status.toLowerCase();
  if (normalized === "failed" || normalized === "error" || normalized === "denied" || normalized === "reject" || normalized === "cancelled") {
    return "error";
  }
  if (normalized === "completed" || normalized === "success" || normalized === "approved" || normalized === "pass" || normalized === "done") {
    return "success";
  }
  if (normalized === "pending" || normalized === "queued" || normalized === "assigned" || normalized === "waiting" || normalized === "received") {
    return "pending";
  }
  if (normalized === "running" || normalized === "started" || normalized === "processing" || normalized === "applied") {
    return "running";
  }
  if (normalized === "partial" || normalized === "stopped" || normalized === "needs_revision" || normalized === "blocked") {
    return "warning";
  }
  return "info";
}

function loopStatus(phase: Extract<RuntimeEvent, { type: "loop_activity" }>["phase"]): TuiActionStatus {
  switch (phase) {
    case "completed":
    case "turn_complete":
      return "success";
    case "failed":
      return "error";
    case "waiting_approval":
      return "pending";
    case "stopped":
      return "warning";
    default:
      return "running";
  }
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function agentIdentityLabel(agent: NonNullable<Extract<RuntimeEvent, { type: "loop_activity" }>["agent"]>): string {
  const name = agent.display_name?.trim() || agent.agent_id || agent.worker_id || agent.agent_spec_id || agent.capability || agent.role || "agent";
  const role = agent.role_title?.trim();
  return role ? `${name} / ${role}` : name;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
