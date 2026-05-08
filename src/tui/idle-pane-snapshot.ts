import type { BlackboardEntry, RunAttempt, WorkspaceLease } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import type { SymphonyDaemonRecord } from "../symphony/daemon.js";

type RecentSessionRow = ReturnType<SwarmRuntime["sessionStore"]["listRecent"]>[number];

export type IdlePaneSnapshot = {
  sessions: RecentSessionRow[];
  attempts: RunAttempt[];
  leases: WorkspaceLease[];
  approvals: ApprovalRecord[];
  workers: WorkerRecord[];
  blackboard: BlackboardEntry[];
};

export function emptyIdlePaneSnapshot(): IdlePaneSnapshot {
  return {
    sessions: [],
    attempts: [],
    leases: [],
    approvals: [],
    workers: [],
    blackboard: []
  };
}

export function readIdlePaneSnapshot(runtime: SwarmRuntime | undefined): IdlePaneSnapshot {
  if (!runtime) {
    return emptyIdlePaneSnapshot();
  }
  return {
    sessions: runtime.listRecentSessionsForWorkspace(5),
    attempts: runtime.listRecentAttemptsForWorkspace(6),
    leases: runtime.listRecentLeasesForWorkspace(4),
    approvals: runtime.listRecentApprovalsForWorkspace(8).filter((record) => record.status === "pending").slice(0, 4),
    workers: runtime.listRecentWorkersForWorkspace(6),
    blackboard: runtime.listRecentBlackboardForWorkspace(5)
  };
}

export function idlePaneSnapshotSignature(snapshot: IdlePaneSnapshot): string {
  return JSON.stringify({
    sessions: snapshot.sessions.map((session) => [
      session.session_id,
      session.status,
      session.updated_at,
      session.workspace_lease_id ?? ""
    ]),
    attempts: snapshot.attempts.map((attempt) => [
      attempt.attempt_id,
      attempt.status,
      attempt.last_event_at,
      attempt.ended_at ?? "",
      attempt.error_code ?? ""
    ]),
    leases: snapshot.leases.map((lease) => [
      lease.lease_id,
      lease.session_id,
      lease.workspace_path,
      lease.write_boundary,
      lease.created_at
    ]),
    approvals: snapshot.approvals.map((approval) => [
      approval.approval_id,
      approval.status,
      approval.updated_at,
      approval.risk_class,
      approval.target
    ]),
    workers: snapshot.workers.map((worker) => [
      worker.worker_id,
      worker.display_name,
      worker.role_title ?? "",
      worker.status,
      worker.agent_spec_id ?? "",
      worker.updated_at,
      worker.last_result ?? ""
    ]),
    blackboard: snapshot.blackboard.map((entry) => [
      entry.entry_id,
      entry.updated_at ?? entry.created_at,
      entry.version,
      entry.key,
      entry.type
    ])
  });
}

export function symphonyDaemonRecordsSignature(records: SymphonyDaemonRecord[]): string {
  return JSON.stringify(records.map((record) => [
    record.daemon_id,
    record.status,
    record.updated_at,
    record.tick_count,
    record.next_tick_at ?? "",
    record.last_error ?? "",
    record.stop_reason ?? ""
  ]));
}
