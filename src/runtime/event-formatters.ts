import type { RuntimeEvent } from "./events.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

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
      return `tool: ${event.action} [${event.status ?? "unknown"}] ${truncate(event.summary, 90)}${event.recoverySuggestion ? ` recovery=${truncate(event.recoverySuggestion, 70)}` : ""}`;
    case "progress":
      return `progress: ${event.completed}/${event.total}`;
    case "envelope":
      return `${event.envelope.type} ${event.envelope.task_id ?? ""}`.trim();
    case "blackboard":
      return `bb: ${event.entry.key}`;
    case "agent":
      return `agent: ${event.card.agent_id} [${event.card.status}]`;
    case "approval":
      return `approval: ${event.status} ${event.request.action} ${event.request.risk_class}/${event.request.risk}`;
    case "live_message":
      return `live: ${event.status} ${truncate(event.content, 70)}`;
    case "control":
      return `control: ${event.action} - ${truncate(event.reason, 90)}`;
    case "loop_activity":
      return `activity: ${event.message}`;
    case "controller":
      return formatControllerBrief(event);
    case "queue":
      return `queue: ${event.operation} ${event.priority ?? ""} size=${event.size}`.trim();
    case "worker":
      return `worker: ${formatWorkerBrief(event.worker)}${event.message ? ` - ${truncate(event.message, 70)}` : ""}`;
    case "agent_spawn_decision":
      return `spawn: ${event.worker_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode} (${percent(event.decision.confidence)})`;
    case "agent_run_started":
      return `agent-run: ${event.worker.worker_id} started ${event.worker.agent_spec_id ?? event.worker.capability}`;
    case "agent_run_completed":
      return `agent-run: ${event.worker.worker_id} completed ${truncate(event.result, 70)}`;
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
    return `tool: ${event.action} [${event.status ?? "unknown"}] ${event.summary}${event.recoverySuggestion ? ` recovery=${event.recoverySuggestion}` : ""}`;
  }
  if (event.type === "loop_activity") {
    return `activity: ${event.message}`;
  }
  if (event.type === "agent_spawn_decision") {
    return `agent: spawn ${event.worker_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode} (${percent(event.decision.confidence)}) ${event.decision.reason}`;
  }
  if (event.type === "agent_run_started") {
    return `agent: start ${event.worker.worker_id} ${event.worker.agent_spec_id ?? event.worker.capability}`;
  }
  if (event.type === "agent_run_completed") {
    return `agent: done ${event.worker.worker_id} ${firstLine(event.result)}`;
  }
  if (event.type === "worker") {
    return `worker: ${formatWorkerBrief(event.worker)}${event.message ? ` - ${event.message}` : ""}`;
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
    return `approval: ${event.status} ${event.request.action} ${event.request.risk_class}/${event.request.risk} target=${event.request.target}`;
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
  const scope = worker.file_scope.length ? ` scope=${worker.file_scope.join(",")}` : "";
  return `${worker.worker_id} [${worker.status}] ${agent}${scope}`;
}

export function formatWorkerDetail(worker: WorkerRecord): string {
  return [
    `${worker.worker_id} [${worker.status}]`,
    worker.agent_spec_id ? `agent=${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : undefined,
    worker.handoff_id ? `handoff=${worker.handoff_id}` : undefined,
    `capability=${worker.capability}`,
    `parent=${worker.parent_session_id}`,
    worker.requested_by ? `requested_by=${worker.requested_by}` : undefined,
    worker.worker_session_id ? `session=${worker.worker_session_id}` : undefined,
    `budget=${worker.tool_budget.max_turns} turns/${worker.tool_budget.max_tool_calls} tools`,
    worker.file_scope.length ? `scope=${worker.file_scope.join(", ")}` : undefined,
    worker.spawn_reason ? `reason=${worker.spawn_reason}` : undefined,
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
    `reason=${event.decision.reason}`,
    `objective=${event.task_packet.objective}`,
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
