import type { RuntimeAgentIdentity, RuntimeEvent } from "./events.js";
import { workerDisplayLabel, type WorkerRecord } from "../storage/worker-state-store.js";

type RouteLike = {
  mode?: unknown;
  confidence?: unknown;
  reason?: unknown;
  requires_workspace?: unknown;
  expected_side_effects?: unknown;
  needs_parallelism?: unknown;
  parallelism_reason?: unknown;
  swarm_value?: unknown;
  risk?: unknown;
  fallback_mode?: unknown;
};

export function formatRuntimeEventBrief(event: RuntimeEvent): string {
  switch (event.type) {
    case "session":
      return `session: ${event.session_id} [${event.status}]`;
    case "task":
      return `${statusIcon(event.status)} ${event.status}: ${event.title || event.task_id}`;
    case "task_attempt":
      return `${statusIcon(event.status)} attempt ${event.attempt}: ${event.title || event.task_id}`;
    case "tool_result":
      return `${formatAgentPrefix(event.agent)}tool: ${event.action} [${event.status ?? "unknown"}] ${truncate(event.summary, 90)}${formatSandboxSuffix(event)}${event.recoverySuggestion ? ` recovery=${truncate(event.recoverySuggestion, 70)}` : ""}`;
    case "provider_usage":
      return `usage: ${event.usage.providerId}/${event.usage.model} ${event.usage.purpose}`;
    case "tui_focus":
      return `tui-focus: ${event.key_event} ${event.detail_reason} ${event.focus_before}->${event.focus_after} detail=${event.detail_before}->${event.detail_after} pane=${event.pane_before}->${event.pane_after} allowed=${event.allowed}`;
    case "progress":
      return `progress: ${event.completed}/${event.total}`;
    case "envelope":
      return `${event.envelope.type} ${event.envelope.task_id ?? ""}`.trim();
    case "blackboard":
      return `bb: ${event.entry.key}`;
    case "agent":
      return `agent: ${event.card.agent_id} [${event.card.status}]`;
    case "approval":
      return `approval: ${event.status}${formatApprovalRiskLabel(event.request)} ${event.request.action} ${event.request.risk_class}/${event.request.risk}${formatPermissionSuffix(event.request)}`;
    case "live_message":
      return `live: ${event.status} ${truncate(event.content, 70)}`;
    case "control":
      return `control: ${event.action} - ${truncate(event.reason, 90)}`;
    case "loop_activity":
      return `activity: ${formatAgentPrefix(event.agent)}${event.message}`;
    case "controller":
      return formatControllerBrief(event);
    case "queue":
      return [
        `queue:${event.queue}`,
        event.operation,
        event.id ? `id=${event.id}` : undefined,
        event.priority ? `priority=${event.priority}` : undefined,
        `size=${event.size}`,
        event.message ? truncate(event.message, 90) : undefined
      ].filter(Boolean).join(" ");
    case "budget":
      return `budget: ${event.decision.action} ${event.decision.actor_id} pressure=${event.decision.pressure} scope=${event.decision.scope} ${truncate(event.decision.reason, 80)}`;
    case "worker":
      return `worker: ${formatWorkerBrief(event.worker)}${event.message ? ` - ${truncate(event.message, 70)}` : ""}`;
    case "agent_spawn_decision":
      return `spawn: ${event.worker_id} parent=${event.parent_session_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode} policy=${event.task_packet.write_policy} (${percent(event.decision.confidence)})`;
    case "agent_run_started":
      return `agent-run: ${workerDisplayLabel(event.worker)} started ${event.worker.agent_spec_id ?? event.worker.capability}`;
    case "agent_run_completed":
      return `agent-run: ${workerDisplayLabel(event.worker)} completed ${truncate(event.result, 70)}`;
    case "handoff_started":
      return `handoff: ${event.handoff.handoff_id} started -> ${event.handoff.target_agent_spec_id}`;
    case "handoff_message":
      return `handoff: ${event.handoff_id} ${truncate(event.message, 70)}`;
    case "handoff_returned":
      return `handoff: ${event.handoff.handoff_id} ${event.handoff.status}`;
    case "handoff_taken_back":
      return `handoff: ${event.handoff.handoff_id} taken back`;
    case "workspace_change":
      return `change: ${event.change.operation} ${event.change.path}`;
    case "file_lock":
      return `lock: ${event.event.status} ${event.event.path}`;
    case "review_started":
      return `review: started ${event.session_id}`;
    case "review_completed":
      return `review: ${event.result.verdict} score=${event.result.score} - ${truncate(event.result.summary, 70)}`;
    case "verification_started":
      return `verify: started ${event.session_id}`;
    case "verification_completed":
      return `verify: ${event.result.status} - ${truncate(event.result.summary, 70)}`;
    case "self_review":
      return `self-review: ${truncate(event.summary, 90)}`;
    case "eval_result":
      return `eval: ${event.status} ${event.name}`;
    case "plan":
      return `plan: ${event.session_id} tasks=${event.plan.tasks.length}`;
    case "final":
      return `final: ${event.status ?? "completed"}, ${event.outcome?.changed_files.length ?? 0} changed, ${event.outcome?.tests_run.length ?? 0} checks`;
    case "log":
      return `${event.level}: ${event.message}`;
    case "error":
      return `ERROR: ${event.message}`;
  }
}

export function formatHeadlessProgress(event: RuntimeEvent): string | undefined {
  if (event.type === "controller") {
    return `swarm: ${formatControllerBrief(event)}`;
  }
  if (event.type === "tool_result") {
    return `${formatAgentPrefix(event.agent)}tool: ${event.action} [${event.status ?? "unknown"}] ${event.summary}${formatSandboxSuffix(event)}${event.recoverySuggestion ? ` recovery=${event.recoverySuggestion}` : ""}`;
  }
  if (event.type === "loop_activity") {
    return `activity: ${formatAgentPrefix(event.agent)}${event.message}`;
  }
  if (event.type === "agent_spawn_decision") {
    return `agent: spawn ${event.worker_id} parent=${event.parent_session_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode} policy=${event.task_packet.write_policy} (${percent(event.decision.confidence)}) ${event.decision.reason}`;
  }
  if (event.type === "agent_run_started") {
    return `agent: start ${workerDisplayLabel(event.worker)} ${event.worker.agent_spec_id ?? event.worker.capability}`;
  }
  if (event.type === "agent_run_completed") {
    return `agent: done ${workerDisplayLabel(event.worker)} ${firstLine(event.result)}`;
  }
  if (event.type === "worker") {
    return `worker: ${formatWorkerBrief(event.worker)}${event.message ? ` - ${event.message}` : ""}`;
  }
  if (event.type === "queue") {
    return [
      `queue:${event.queue}`,
      event.operation,
      event.id ? `id=${event.id}` : undefined,
      event.priority ? `priority=${event.priority}` : undefined,
      `size=${event.size}`,
      event.message
    ].filter(Boolean).join(" ");
  }
  if (event.type === "budget") {
    return `budget: ${event.decision.action} actor=${event.decision.actor_id} pressure=${event.decision.pressure} scope=${event.decision.scope} reason=${event.decision.reason}`;
  }
  if (event.type === "review_completed") {
    return `review: ${event.result.verdict} ${event.result.score} - ${event.result.summary}`;
  }
  if (event.type === "verification_completed") {
    return `verify: ${event.result.status} - ${event.result.summary}`;
  }
  if (event.type === "final") {
    return `final: ${event.status ?? "completed"}, ${event.outcome?.changed_files.length ?? 0} changed, ${event.outcome?.tests_run.length ?? 0} checks`;
  }
  if (event.type === "approval") {
    return `approval: ${event.status}${formatApprovalRiskLabel(event.request)} ${event.request.action} ${event.request.risk_class}/${event.request.risk} target=${event.request.target}${formatPermissionSuffix(event.request)}`;
  }
  return undefined;
}

export function formatWhyReport(events: RuntimeEvent[], limit = 80): string {
  const relevant = events.filter(isWhyEvent).slice(-limit);
  if (!relevant.length) {
    return "No recent control decisions.";
  }
  return [
    section("Route Decision", relevant.filter((event) => event.type === "controller").map(formatControllerDetail)),
    section("Delegation Decisions", relevant.filter((event) => event.type === "agent_spawn_decision").map(formatSpawnDecisionDetail)),
    section("Workers", relevant.filter((event) => event.type === "worker" || event.type === "agent_run_started" || event.type === "agent_run_completed").map(formatRuntimeEventBrief)),
    section("Reviews", relevant.filter((event) => event.type === "review_started" || event.type === "review_completed").map(formatRuntimeEventBrief)),
    section("Verification", relevant.filter((event) => event.type === "verification_started" || event.type === "verification_completed").map(formatRuntimeEventBrief)),
    section("Workspace Changes", relevant.filter((event) => event.type === "workspace_change" || event.type === "file_lock").map(formatRuntimeEventBrief)),
    section("Live Control", relevant.filter((event) => event.type === "control" || event.type === "queue").map(formatRuntimeEventBrief))
  ].filter(Boolean).join("\n\n");
}

export function formatWorkerBrief(worker: WorkerRecord): string {
  const agent = worker.agent_spec_id
    ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}`
    : worker.capability;
  const policy = worker.task_packet?.write_policy ? ` policy=${worker.task_packet.write_policy}` : "";
  const scope = worker.file_scope.length ? ` scope=${worker.file_scope.join(",")}` : "";
  const blocked = worker.blocked_reason ? ` blocked=${truncate(worker.blocked_reason, 80)}` : "";
  const result = worker.last_result ? ` - ${truncate(firstLine(worker.last_result), 80)}` : "";
  return `${workerDisplayLabel(worker)} [${worker.status}] ${agent} (${worker.worker_id})${policy}${scope}${blocked}${result}`;
}

export function formatWorkerDetail(worker: WorkerRecord): string {
  return [
    `${workerDisplayLabel(worker)} [${worker.status}]`,
    `worker_id=${worker.worker_id}`,
    worker.agent_spec_id ? `agent=${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : undefined,
    worker.handoff_id ? `handoff=${worker.handoff_id}` : undefined,
    `capability=${worker.capability}`,
    worker.task_packet?.write_policy ? `policy=${worker.task_packet.write_policy}` : undefined,
    `parent=${worker.parent_session_id}`,
    worker.requested_by ? `requested_by=${worker.requested_by}` : undefined,
    worker.worker_session_id ? `session=${worker.worker_session_id}` : undefined,
    `budget=${worker.tool_budget.max_turns} turns/${worker.tool_budget.max_tool_calls} tools`,
    worker.file_scope.length ? `scope=${worker.file_scope.join(", ")}` : undefined,
    worker.spawn_reason ? `reason=${worker.spawn_reason}` : undefined,
    worker.blocked_reason ? `blocked=${worker.blocked_reason}` : undefined,
    `objective=${worker.objective}`,
    worker.outcome ? `outcome=changed:${worker.outcome.changed_files.length} checks:${worker.outcome.tests_run.length}` : undefined,
    worker.last_result ? `last_result=${worker.last_result}` : undefined,
    worker.output_contract ? `output_contract=${worker.output_contract}` : undefined,
    worker.task_packet ? `task_packet=${JSON.stringify(worker.task_packet, null, 2)}` : undefined,
    `updated=${worker.updated_at}`
  ].filter(Boolean).join("\n");
}

function formatControllerBrief(event: Extract<RuntimeEvent, { type: "controller" }>): string {
  const route = extractRoute(event);
  if (!route) {
    return `controller: ${event.action} - ${truncate(event.reason, 90)}`;
  }
  const mode = typeof route.mode === "string" ? route.mode : event.action.replace(/^run_/, "");
  return `route: ${mode} (${percent(route.confidence)}) - ${truncate(String(route.reason ?? event.reason), 100)}`;
}

function formatAgentPrefix(agent: RuntimeAgentIdentity | undefined): string {
  const label = formatRuntimeAgentLabel(agent);
  return label ? `@${label} ` : "";
}

export function formatRuntimeAgentLabel(agent: RuntimeAgentIdentity | undefined): string | undefined {
  if (!agent) {
    return undefined;
  }
  const name = agent.display_name?.trim() || agent.agent_id || agent.worker_id || agent.agent_spec_id || agent.capability || agent.role;
  if (!name) {
    return undefined;
  }
  const role = agent.role_title?.trim();
  return role ? `${name}/${role}` : name;
}

function formatPermissionSuffix(request: Extract<RuntimeEvent, { type: "approval" }>["request"]): string {
  const parts = [
    request.permission_name ? `permission=${request.permission_name}` : undefined,
    request.permission_rule ? `rule=${request.permission_rule}` : undefined,
    request.permission_reason ? `reason=${truncate(request.permission_reason, 70)}` : undefined
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function formatApprovalRiskLabel(request: Extract<RuntimeEvent, { type: "approval" }>["request"]): string {
  return request.risk === "shell" && request.risk_class === "r4" ? " destructive-shell" : "";
}

function formatSandboxSuffix(event: Extract<RuntimeEvent, { type: "tool_result" }>): string {
  const hasTaskScope = Boolean(event.file_scope?.length);
  const parts = [
    event.write_policy ? `policy=${event.write_policy}` : undefined,
    hasTaskScope ? `scope=${truncate(event.file_scope!.join(","), 70)}` : undefined
  ];
  if (event.sandbox) {
    parts.push(
      `sandbox=${event.sandbox.policy}/${event.sandbox.decision}${formatSandboxLabel(event.sandbox)}`,
      event.sandbox.subject ? `subject=${event.sandbox.subject}` : undefined,
      event.sandbox.decision === "deny" ? `reason=${truncate(event.sandbox.reason, 70)}` : undefined,
      event.sandbox.targets?.length ? `targets=${truncate(event.sandbox.targets.join(","), 70)}` : undefined,
      event.sandbox.file_scope?.length
        ? `${hasTaskScope ? "sandbox_scope" : "scope"}=${truncate(event.sandbox.file_scope.join(","), 70)}`
        : undefined
    );
  }
  const filtered = parts.filter(Boolean);
  return filtered.length ? ` ${filtered.join(" ")}` : "";
}

function formatSandboxLabel(sandbox: NonNullable<Extract<RuntimeEvent, { type: "tool_result" }>["sandbox"]>): string {
  if (sandbox.decision !== "deny") {
    return "";
  }
  if (sandbox.policy === "read_only") {
    return "(read-only-block)";
  }
  if (sandbox.policy === "scoped_write" && sandbox.subject === "tool_action") {
    return "(file-scope-block)";
  }
  if (sandbox.policy === "scoped_write" && sandbox.subject === "capability") {
    return "(capability-block)";
  }
  return "";
}

function formatControllerDetail(event: Extract<RuntimeEvent, { type: "controller" }>): string {
  const route = extractRoute(event);
  if (!route) {
    return `${event.action}: ${event.reason}`;
  }
  return [
    `mode=${String(route.mode ?? event.action.replace(/^run_/, ""))} confidence=${percent(route.confidence)}`,
    `reason=${String(route.reason ?? event.reason)}`,
    `workspace=${String(route.requires_workspace ?? "unknown")} side_effects=${String(route.expected_side_effects ?? "unknown")} risk=${String(route.risk ?? "unknown")}`,
    `parallel=${String(route.needs_parallelism ?? false)} fallback=${String(route.fallback_mode ?? "none")}`,
    typeof route.parallelism_reason === "string" && route.parallelism_reason ? `parallelism_reason=${route.parallelism_reason}` : undefined,
    typeof route.swarm_value === "string" && route.swarm_value ? `swarm_value=${route.swarm_value}` : undefined
  ].filter(Boolean).join("\n");
}

function formatSpawnDecisionDetail(event: Extract<RuntimeEvent, { type: "agent_spawn_decision" }>): string {
  return [
    `${event.worker_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode} confidence=${percent(event.decision.confidence)}`,
    `parent=${event.parent_session_id}`,
    `reason=${event.decision.reason}`,
    event.decision.display_name || event.decision.role_title
      ? `identity=${[event.decision.display_name, event.decision.role_title].filter(Boolean).join(" / ")}`
      : undefined,
    `objective=${event.task_packet.objective}`,
    `policy=${event.task_packet.write_policy}`,
    event.task_packet.file_scope.length ? `scope=${event.task_packet.file_scope.join(", ")}` : undefined,
    `tools=${event.task_packet.allowed_tools.join(", ")}`
  ].filter(Boolean).join("\n");
}

function extractRoute(event: Extract<RuntimeEvent, { type: "controller" }>): RouteLike | undefined {
  const route = event.details?.route;
  return typeof route === "object" && route !== null ? route as RouteLike : undefined;
}

function isWhyEvent(event: RuntimeEvent): boolean {
  return event.type === "control" ||
    event.type === "controller" ||
    event.type === "queue" ||
    event.type === "agent_spawn_decision" ||
    event.type === "agent_run_started" ||
    event.type === "agent_run_completed" ||
    event.type === "worker" ||
    event.type === "handoff_started" ||
    event.type === "handoff_returned" ||
    event.type === "handoff_taken_back" ||
    event.type === "review_started" ||
    event.type === "review_completed" ||
    event.type === "verification_started" ||
    event.type === "verification_completed" ||
    event.type === "workspace_change" ||
    event.type === "file_lock";
}

function section(title: string, lines: string[]): string {
  return lines.length ? [`${title}:`, ...lines.map((line) => indent(line))].join("\n") : "";
}

function indent(value: string): string {
  return value.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function statusIcon(status: string): string {
  switch (status) {
    case "assigned": return "->";
    case "running": return "..";
    case "started": return "..";
    case "completed": return "OK";
    case "failed": return "!!";
    default: return "-";
  }
}

function percent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "n/a";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 140) ?? "";
}
