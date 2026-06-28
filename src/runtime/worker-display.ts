import { workerDisplayLabel, type WorkerRecord } from "../storage/worker-state-store.js";
import { firstLine } from "./common-utilities.js";

export function compactWorkerRecord(worker: WorkerRecord): Record<string, unknown> {
  return {
    worker_id: worker.worker_id,
    display_name: worker.display_name,
    role_title: worker.role_title,
    parent_session_id: worker.parent_session_id,
    worker_session_id: worker.worker_session_id,
    agent_spec_id: worker.agent_spec_id,
    invocation_mode: worker.invocation_mode,
    capability: worker.capability,
    objective: worker.objective,
    status: worker.status,
    file_scope: worker.file_scope,
    handoff_id: worker.handoff_id,
    blocked_reason: worker.blocked_reason,
    last_result: worker.last_result ? firstLine(worker.last_result) : undefined,
    outcome: worker.outcome
      ? {
          changed_files: worker.outcome.changed_files,
          tests_run: worker.outcome.tests_run,
          intermediate_artifacts: worker.outcome.intermediate_artifacts,
          final_summary: worker.outcome.final_summary
        }
      : undefined,
    created_at: worker.created_at,
    updated_at: worker.updated_at
  };
}

export function renderWorkerList(workers: WorkerRecord[]): string {
  if (workers.length === 0) {
    return "No workers found.";
  }
  return workers.map((worker) => {
    const label = workerDisplayLabel(worker);
    const result = worker.last_result ? ` - ${firstLine(worker.last_result)}` : "";
    const scope = worker.file_scope.length ? ` scope=${worker.file_scope.slice(0, 4).join(",")}` : "";
    return `${worker.worker_id} [${worker.status}] ${label}${scope}${result}`;
  }).join("\n");
}

export function renderWorkerDetailForTool(worker: WorkerRecord): string {
  return [
    `${worker.worker_id} [${worker.status}] ${workerDisplayLabel(worker)}`,
    worker.agent_spec_id ? `Agent spec: ${worker.agent_spec_id}` : undefined,
    worker.invocation_mode ? `Invocation mode: ${worker.invocation_mode}` : undefined,
    `Capability: ${worker.capability}`,
    `Parent session: ${worker.parent_session_id}`,
    worker.worker_session_id ? `Worker session: ${worker.worker_session_id}` : undefined,
    worker.handoff_id ? `Handoff: ${worker.handoff_id}` : undefined,
    worker.file_scope.length ? `File scope: ${worker.file_scope.join(", ")}` : undefined,
    worker.blocked_reason ? `Blocked: ${worker.blocked_reason}` : undefined,
    worker.last_result ? `Last result: ${firstLine(worker.last_result)}` : undefined,
    worker.outcome?.final_summary ? `Outcome: ${worker.outcome.final_summary}` : undefined,
    `Objective: ${worker.objective}`,
    `Updated: ${worker.updated_at}`
  ].filter(Boolean).join("\n");
}
