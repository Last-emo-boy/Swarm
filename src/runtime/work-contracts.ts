import type {
  TaskContractRecord,
  TaskContractSummary,
  TaskStateSnapshot,
  WorkContractHandoff,
  WorkContractSnapshot,
  WorkContractSummary,
  WorkContractWorker
} from "../protocol/types.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

export function buildWorkContractSnapshot(input: {
  workers: WorkerRecord[];
  handoffs: HandoffSessionRecord[];
}): WorkContractSnapshot {
  const activeWorkers = input.workers
    .filter((worker) => worker.status === "pending" || worker.status === "running")
    .map(buildWorkContractWorker);
  const resumableWorkers = input.workers
    .filter((worker) => worker.status !== "pending" && worker.status !== "running")
    .map(buildWorkContractWorker);
  const handoffContracts = input.handoffs.map(buildWorkContractHandoff);
  const activeHandoffs = handoffContracts.filter((handoff) => handoff.status === "active");
  const workerContracts = [...activeWorkers, ...resumableWorkers];
  return {
    summary: summarizeWorkContracts({ workers: workerContracts, handoffs: handoffContracts }),
    active_workers: activeWorkers,
    resumable_workers: resumableWorkers,
    active_handoffs: activeHandoffs
  };
}

export function buildTaskContractSnapshot(tasks: TaskStateSnapshot[]): {
  summary: TaskContractSummary;
  tasks: TaskContractRecord[];
} {
  const contracts = tasks.map(buildTaskContractRecord);
  return {
    summary: summarizeTaskContracts(contracts),
    tasks: contracts
  };
}

export function buildTaskContractRecord(task: TaskStateSnapshot): TaskContractRecord {
  return {
    task_id: task.task_id,
    parent_task_id: task.parent_task_id,
    title: task.title,
    status: task.status,
    attempt: task.attempt,
    capability: task.capability ?? task.required_capabilities.find((item) => item.trim()),
    write_policy: task.write_policy,
    file_scope: task.file_scope ?? [],
    dependencies: task.dependencies,
    last_error: task.last_error,
    updated_at: task.updated_at
  };
}

export function summarizeTaskContracts(tasks: TaskContractRecord[]): TaskContractSummary {
  return {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === "created" || task.status === "pending" || task.status === "assigned").length,
    running: tasks.filter((task) => task.status === "running").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length,
    read_only: tasks.filter((task) => task.write_policy === "read_only").length,
    scoped_write: tasks.filter((task) => task.write_policy === "scoped_write").length,
    workspace_write: tasks.filter((task) => task.write_policy === "workspace_write").length,
    scoped_targets: uniqueStrings(tasks.flatMap((task) => task.file_scope))
  };
}

export function summarizeWorkContracts(input: {
  workers: WorkContractWorker[];
  handoffs: WorkContractHandoff[];
}): WorkContractSummary {
  const activeHandoffs = input.handoffs.filter((handoff) => handoff.status === "active");
  const runningWorkers = input.workers.filter((worker) => worker.status === "running").length;
  const pendingWorkers = input.workers.filter((worker) => worker.status === "pending").length;
  return {
    active_workers: runningWorkers + pendingWorkers,
    running_workers: runningWorkers,
    pending_workers: pendingWorkers,
    resumable_workers: input.workers.filter((worker) => worker.status !== "pending" && worker.status !== "running").length,
    active_handoffs: activeHandoffs.length,
    read_only: input.workers.filter((worker) => worker.write_policy === "read_only").length,
    scoped_write: input.workers.filter((worker) => worker.write_policy === "scoped_write").length,
    workspace_write: input.workers.filter((worker) => worker.write_policy === "workspace_write").length,
    scoped_targets: uniqueStrings([
      ...input.workers.flatMap((worker) => worker.file_scope),
      ...activeHandoffs.flatMap((handoff) => handoff.file_scope)
    ])
  };
}

export function buildWorkContractWorker(worker: WorkerRecord): WorkContractWorker {
  return {
    worker_id: worker.worker_id,
    display_name: worker.display_name,
    role_title: worker.role_title,
    status: worker.status,
    capability: worker.capability,
    objective: worker.objective,
    agent_spec_id: worker.agent_spec_id,
    invocation_mode: worker.invocation_mode,
    handoff_id: worker.handoff_id,
    write_policy: worker.task_packet?.write_policy ?? (worker.file_scope.length ? "scoped_write" : undefined),
    file_scope: worker.file_scope,
    requested_by: worker.requested_by,
    blocked_reason: worker.blocked_reason,
    updated_at: worker.updated_at
  };
}

export function buildWorkContractHandoff(handoff: HandoffSessionRecord): WorkContractHandoff {
  return {
    handoff_id: handoff.handoff_id,
    worker_id: handoff.worker_id,
    source_agent: handoff.source_agent,
    target_agent_spec_id: handoff.target_agent_spec_id,
    reason: handoff.reason,
    status: handoff.status,
    write_policy: handoff.task_packet.write_policy,
    file_scope: handoff.task_packet.file_scope,
    updated_at: handoff.updated_at
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}
