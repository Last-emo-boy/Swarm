import type {
  TaskContractRecord,
  TaskContractSummary,
  TaskStateSnapshot,
  WorkContractHandoff,
  WorkContractSnapshot,
  WorkContractSummary,
  WorkContractWorker,
  WorkHeartbeatState,
  WorkLeaseAge
} from "../protocol/types.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

export function buildWorkContractSnapshot(input: {
  workers: WorkerRecord[];
  handoffs: HandoffSessionRecord[];
  generatedAt?: string;
}): WorkContractSnapshot {
  const activeWorkers = input.workers
    .filter((worker) => worker.status === "pending" || worker.status === "running")
    .map((worker) => buildWorkContractWorker(worker, { generatedAt: input.generatedAt }));
  const resumableWorkers = input.workers
    .filter((worker) => worker.status !== "pending" && worker.status !== "running")
    .map((worker) => buildWorkContractWorker(worker, { generatedAt: input.generatedAt }));
  const handoffContracts = input.handoffs.map((handoff) => buildWorkContractHandoff(handoff, { generatedAt: input.generatedAt }));
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

export function buildWorkContractWorker(worker: WorkerRecord, options: { generatedAt?: string } = {}): WorkContractWorker {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const leaseAge = buildLeaseAge(worker.updated_at, generatedAt);
  const heartbeatState = workerHeartbeatState(worker.status, leaseAge, worker.blocked_reason);
  const claimOwner = worker.worker_session_id ?? worker.requested_by ?? worker.parent_session_id;
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
    claim_owner: claimOwner,
    lease_age: leaseAge,
    heartbeat_state: heartbeatState,
    stale_reason: workerStaleReason(worker, leaseAge, heartbeatState),
    resume_command: workerResumeCommand(worker),
    last_artifact: lastWorkerArtifact(worker),
    write_policy: worker.task_packet?.write_policy ?? (worker.file_scope.length ? "scoped_write" : undefined),
    file_scope: worker.file_scope,
    requested_by: worker.requested_by,
    blocked_reason: worker.blocked_reason,
    updated_at: worker.updated_at
  };
}

export function buildWorkContractHandoff(handoff: HandoffSessionRecord, options: { generatedAt?: string } = {}): WorkContractHandoff {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = handoff.scope ?? handoff.task_packet.file_scope;
  const leaseAge = buildLeaseAge(handoff.updated_at, generatedAt);
  const heartbeatState = handoffHeartbeatState(handoff, generatedAt);
  return {
    handoff_id: handoff.handoff_id,
    worker_id: handoff.worker_id,
    source_agent: handoff.source_agent,
    target_agent_spec_id: handoff.target_agent_spec_id,
    reason: handoff.reason,
    status: handoff.status,
    protocol_status: handoff.protocol_status,
    requester_agent_id: handoff.requester_agent_id,
    owner_agent_id: handoff.owner_agent_id,
    claim_owner: handoff.owner_agent_id ?? handoff.requester_agent_id ?? handoff.source_agent,
    scope,
    lease_age: leaseAge,
    heartbeat_state: heartbeatState,
    stale_reason: handoffStaleReason(handoff, heartbeatState, generatedAt),
    conflict_reason: handoff.conflict_reason,
    deadline_at: handoff.deadline_at,
    lease_expires_at: handoff.lease_expires_at,
    accepted_at: handoff.accepted_at,
    last_checkpoint: handoff.last_checkpoint,
    return_contract: handoff.return_contract,
    write_policy: handoff.task_packet.write_policy,
    file_scope: handoff.task_packet.file_scope,
    updated_at: handoff.updated_at
  };
}

function buildLeaseAge(updatedAt: string, generatedAt: string): WorkLeaseAge {
  const since = updatedAt;
  const ageMs = Math.max(0, Date.parse(generatedAt) - Date.parse(updatedAt));
  return {
    since,
    age_ms: Number.isFinite(ageMs) ? ageMs : 0,
    label: formatAgeLabel(ageMs)
  };
}

function workerHeartbeatState(
  status: WorkerRecord["status"],
  leaseAge: WorkLeaseAge,
  blockedReason: string | undefined
): WorkHeartbeatState {
  if (blockedReason) {
    return "blocked";
  }
  if (status === "failed") {
    return "stale";
  }
  if (status === "stopped") {
    return "stopped";
  }
  if (status === "completed") {
    return "complete";
  }
  return leaseAge.age_ms > 5 * 60 * 1000 ? "stale" : "fresh";
}

function workerStaleReason(
  worker: WorkerRecord,
  leaseAge: WorkLeaseAge,
  heartbeatState: WorkHeartbeatState
): string | undefined {
  if (worker.blocked_reason) {
    return worker.blocked_reason;
  }
  if (heartbeatState === "stale") {
    return worker.status === "failed"
      ? "Worker failed and needs recovery."
      : `No recent update since ${leaseAge.since}.`;
  }
  if (heartbeatState === "blocked") {
    return "Worker is blocked and needs operator attention.";
  }
  if (heartbeatState === "stopped") {
    return "Worker is stopped and can be continued.";
  }
  if (heartbeatState === "complete") {
    return "Worker is complete; review the result before closing dependent work.";
  }
  return undefined;
}

function handoffHeartbeatState(handoff: HandoffSessionRecord, generatedAt: string): WorkHeartbeatState {
  if (handoff.status === "returned") {
    return "complete";
  }
  if (handoff.status === "taken_back") {
    return "stopped";
  }
  if (handoff.status === "failed" || handoff.protocol_status === "failed" || handoff.protocol_status === "rejected") {
    return "stale";
  }
  if (handoff.protocol_status === "conflict") {
    return "blocked";
  }
  if (handoff.protocol_status === "stale" || handoff.protocol_status === "timeout") {
    return "stale";
  }
  if (!handoff.owner_agent_id && handoff.protocol_status === "requested") {
    return "missing";
  }
  if (handoff.lease_expires_at) {
    const generatedMs = Date.parse(generatedAt);
    const leaseMs = Date.parse(handoff.lease_expires_at);
    if (Number.isFinite(generatedMs) && Number.isFinite(leaseMs) && leaseMs <= generatedMs) {
      return "stale";
    }
  }
  return "fresh";
}

function handoffStaleReason(
  handoff: HandoffSessionRecord,
  heartbeatState: WorkHeartbeatState,
  generatedAt: string
): string | undefined {
  if (handoff.conflict_reason) {
    return handoff.conflict_reason;
  }
  if (heartbeatState === "missing") {
    return "Handoff request has not been accepted by the target agent.";
  }
  if (heartbeatState === "blocked") {
    return "Handoff ownership is in conflict and needs operator resolution.";
  }
  if (heartbeatState === "stale") {
    if (handoff.protocol_status === "timeout") {
      return "Handoff lease timed out before renewal or return.";
    }
    if (handoff.protocol_status === "rejected") {
      return "Target agent rejected the handoff request.";
    }
    if (handoff.lease_expires_at && Date.parse(handoff.lease_expires_at) <= Date.parse(generatedAt)) {
      return `Handoff lease expired at ${handoff.lease_expires_at}.`;
    }
    return "Handoff has no fresh heartbeat.";
  }
  if (heartbeatState === "stopped") {
    return "Handoff was taken back by the main Swarm.";
  }
  if (heartbeatState === "complete") {
    return "Handoff returned its result contract.";
  }
  return undefined;
}

function workerResumeCommand(worker: WorkerRecord): string | undefined {
  if (worker.status === "running" || worker.status === "pending") {
    return `/continue-agent ${worker.worker_id} continue from the last known state`;
  }
  if (worker.status === "failed" || worker.status === "stopped") {
    return `/continue-agent ${worker.worker_id} resume from the latest result`;
  }
  if (worker.status === "completed") {
    return `/continue-agent ${worker.worker_id} inspect the completed result`;
  }
  return undefined;
}

function lastWorkerArtifact(worker: WorkerRecord): string | undefined {
  return worker.outcome?.intermediate_artifacts.at(-1)
    ?? worker.change_refs?.at(-1)
    ?? worker.output_contract
    ?? undefined;
}

function formatAgeLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 1000) {
    return "now";
  }
  const totalSeconds = Math.floor(ageMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}
