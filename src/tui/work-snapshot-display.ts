import type { RunAttempt, WorkSnapshot } from "../protocol/types.js";
import { formatWorkerBrief } from "../runtime/event-formatters.js";
import { buildResultCardFromSnapshot, formatResultCardText } from "../runtime/result-card.js";

export function compactWorkSnapshotLines(snapshot: WorkSnapshot): string[] {
  const taskContracts = snapshot.task_contracts.summary;
  const contracts = snapshot.work_contracts.summary;
  const scopePreview = contracts.scoped_targets.slice(0, 3).join(", ");
  const scopeSuffix = contracts.scoped_targets.length > 3 ? ` +${contracts.scoped_targets.length - 3} more` : "";
  return [
    `${snapshot.session.session_id} [${snapshot.session.status}] source=${snapshot.session.source?.source ?? "unknown"}`,
    `objective=${snapshot.session.objective}`,
    `workspace=${snapshot.workspace?.workspace_path ?? "-"} boundary=${snapshot.workspace?.write_boundary ?? "-"}`,
    `attempts=${snapshot.attempts.length} tasks=${snapshot.graph.tasks.length} workers=${snapshot.workers.length} changes=${snapshot.changed_files.length} checks=${snapshot.checks.length}`,
    `tasks=running ${taskContracts.running} pending ${taskContracts.pending} blocked ${taskContracts.blocked} completed ${taskContracts.completed} failed ${taskContracts.failed} ro ${taskContracts.read_only} scoped ${taskContracts.scoped_write} workspace ${taskContracts.workspace_write}`,
    `contracts=running ${contracts.running_workers} pending ${contracts.pending_workers} active ${contracts.active_workers} resumable ${contracts.resumable_workers} handoffs ${contracts.active_handoffs} policies ro ${contracts.read_only} scoped ${contracts.scoped_write} workspace ${contracts.workspace_write}${scopePreview ? ` scope=${scopePreview}${scopeSuffix}` : ""}`,
    snapshot.review ? `review=${snapshot.review.verdict} score=${snapshot.review.score} ${snapshot.review.summary}` : "review=(none)",
    snapshot.context_summary
      ? `memory=${snapshot.context_summary.entries} entries compactions=${snapshot.context_summary.compactions}${snapshot.context_summary.latest_compaction ? ` latest=${snapshot.context_summary.latest_compaction.compaction_id}` : ""}`
      : "memory=(none)",
    snapshot.final_outcome?.final_summary ? `result=${snapshot.final_outcome.final_summary}` : undefined,
    `usage=${JSON.stringify(snapshot.usage_summary)}`
  ].filter(Boolean) as string[];
}

export function formatWorkSnapshot(snapshot: WorkSnapshot): string {
  const taskContracts = snapshot.task_contracts.summary;
  const contracts = snapshot.work_contracts.summary;
  return [
    formatResultCardText(buildResultCardFromSnapshot(snapshot)),
    "",
    `${snapshot.session.session_id} [${snapshot.session.status}]`,
    `source=${snapshot.session.source?.source ?? "unknown"}${snapshot.session.parent_session_id ? ` parent=${snapshot.session.parent_session_id}` : ""}`,
    snapshot.session.objective,
    "",
    "Workspace",
    snapshot.workspace ? `${snapshot.workspace.workspace_path} boundary=${snapshot.workspace.write_boundary}` : "(none)",
    "",
    `Run Attempts: ${snapshot.attempts.length}`,
    ...(snapshot.attempts.length
      ? snapshot.attempts.map(formatRunAttemptSummary)
      : ["(none)"]),
    "",
    `Tasks: ${snapshot.graph.tasks.length}`,
    ...(snapshot.graph.tasks.length
      ? snapshot.graph.tasks.map((task) => [
          `${task.task_id} [${task.status}] #${task.attempt}`,
          task.capability ? `cap=${task.capability}` : undefined,
          task.write_policy ? `policy=${task.write_policy}` : undefined,
          task.file_scope?.length ? `scope=${task.file_scope.join(",")}` : undefined,
          `deps=${task.dependencies.join(",") || "-"}`,
          task.title,
          task.last_error ? `- ${task.last_error}` : undefined
        ].filter(Boolean).join(" "))
      : ["(none)"]),
    "",
    `Task Contracts: total=${taskContracts.total} pending=${taskContracts.pending} running=${taskContracts.running} blocked=${taskContracts.blocked} completed=${taskContracts.completed} failed=${taskContracts.failed} ro=${taskContracts.read_only} scoped=${taskContracts.scoped_write} workspace=${taskContracts.workspace_write}`,
    ...(snapshot.task_contracts.tasks.length
      ? snapshot.task_contracts.tasks.map((task) => [
          `${task.task_id} [${task.status}] #${task.attempt}`,
          task.capability ? `cap=${task.capability}` : undefined,
          task.write_policy ? `policy=${task.write_policy}` : undefined,
          task.file_scope.length ? `scope=${task.file_scope.join(",")}` : undefined,
          task.dependencies.length ? `deps=${task.dependencies.join(",")}` : undefined,
          task.last_error ? `error=${task.last_error}` : undefined
        ].filter(Boolean).join(" "))
      : ["(none)"]),
    "",
    `Workers: ${snapshot.workers.length}`,
    ...(snapshot.workers.length
      ? snapshot.workers.map((worker) => formatWorkerBrief(worker as Parameters<typeof formatWorkerBrief>[0]))
      : ["(none)"]),
    "",
    `Work Contracts: running=${contracts.running_workers} pending=${contracts.pending_workers} active=${contracts.active_workers} resumable=${contracts.resumable_workers} handoffs=${contracts.active_handoffs} ro=${contracts.read_only} scoped=${contracts.scoped_write} workspace=${contracts.workspace_write}`,
    ...(snapshot.work_contracts.active_workers.length
      ? snapshot.work_contracts.active_workers.map((worker) => [
          `${worker.worker_id} [${worker.status}]`,
          worker.agent_spec_id ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : worker.capability,
          worker.write_policy ? `policy=${worker.write_policy}` : undefined,
          worker.file_scope.length ? `scope=${worker.file_scope.join(",")}` : undefined
        ].filter(Boolean).join(" "))
      : ["(no active worker contracts)"]),
    ...(snapshot.work_contracts.resumable_workers.length
      ? snapshot.work_contracts.resumable_workers.map((worker) => [
          `${worker.worker_id} [${worker.status}]`,
          worker.agent_spec_id ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : worker.capability,
          worker.write_policy ? `policy=${worker.write_policy}` : undefined,
          worker.file_scope.length ? `scope=${worker.file_scope.join(",")}` : undefined
        ].filter(Boolean).join(" "))
      : ["(no resumable worker contracts)"]),
    ...(snapshot.work_contracts.active_handoffs.length
      ? snapshot.work_contracts.active_handoffs.map((handoff) => [
          `${handoff.handoff_id} [${handoff.status}]`,
          `worker=${handoff.worker_id}`,
          `-> ${handoff.target_agent_spec_id}`,
          `policy=${handoff.write_policy}`,
          handoff.file_scope.length ? `scope=${handoff.file_scope.join(",")}` : undefined
        ].filter(Boolean).join(" "))
      : ["(no active handoffs)"]),
    "",
    `Changes: ${snapshot.changed_files.length}`,
    ...(snapshot.changed_files.length ? snapshot.changed_files : ["(none)"]),
    "",
    `Verification: ${snapshot.checks.length}`,
    ...(snapshot.checks.length ? snapshot.checks : ["(none)"]),
    "",
    `Review: ${snapshot.review ? `${snapshot.review.verdict} ${snapshot.review.score} - ${snapshot.review.summary}` : "(none)"}`,
    "",
    "Board",
    JSON.stringify(snapshot.blackboard_counts, null, 2),
    "",
    "Usage",
    JSON.stringify(snapshot.usage_summary, null, 2),
    "",
    "Context Memory",
    snapshot.context_summary ? JSON.stringify(snapshot.context_summary, null, 2) : "(none)",
    "",
    `Final: ${snapshot.final_outcome?.final_summary ?? "(none)"}`
  ].join("\n");
}

export function formatSessionMemory(input: {
  snapshot: WorkSnapshot;
  memory: string;
  freshness: string;
}): string {
  const sessionId = input.snapshot.session.session_id;
  return [
    "Session Memory",
    `${sessionId} [${input.snapshot.session.status}]`,
    `Objective: ${input.snapshot.session.objective}`,
    input.snapshot.context_summary
      ? `Summary: entries=${input.snapshot.context_summary.entries} compactions=${input.snapshot.context_summary.compactions}${input.snapshot.context_summary.latest_compaction ? ` latest=${input.snapshot.context_summary.latest_compaction.compaction_id}` : ""}`
      : "Summary: (none)",
    "",
    "Freshness",
    input.freshness,
    "",
    "Remembered Context",
    input.memory || "(none)"
  ].join("\n");
}

function formatRunAttemptSummary(attempt: RunAttempt): string {
  return [
    `${attempt.last_event_at} ${attempt.session_id}`,
    `${attempt.kind} ${attempt.task_id ?? attempt.runner_id ?? "-"}`,
    `[${attempt.status}] #${attempt.attempt}`,
    attempt.title,
    attempt.terminal_reason ? `- ${attempt.terminal_reason}` : undefined,
    attempt.recovery_suggestion ? `recovery=${attempt.recovery_suggestion}` : undefined
  ].filter(Boolean).join(" ");
}
