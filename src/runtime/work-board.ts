import { isAbsolute, relative, resolve } from "node:path";
import type { SwarmSession, TaskContractRecord, WorkContractHandoff, WorkContractWorker, WorkHeartbeatState, WorkItem, WorkLeaseAge, WorkSnapshot } from "../protocol/types.js";
import type { SwarmRuntime } from "./runtime.js";
import { latestSymphonyActionFact, type SymphonyActionFact } from "../symphony/action-lifecycle.js";

export type WorkBoardFilter = "active" | "blocked" | "failed" | "resumable" | "changed-files" | "checks";

export const WORK_BOARD_FILTERS: WorkBoardFilter[] = ["active", "blocked", "failed", "resumable", "changed-files", "checks"];

export function isWorkBoardFilter(value: string | undefined): value is WorkBoardFilter {
  return Boolean(value && (WORK_BOARD_FILTERS as string[]).includes(value));
}

export type WorkBoardSession = {
  session_id: string;
  status: SwarmSession["status"];
  objective: string;
  source?: WorkItem;
  workspace_path?: string;
  updated_at: string;
  next_action?: string;
};

export type WorkBoardWorker = WorkContractWorker & {
  session_id?: string;
  worker_session_id?: string;
  recovery?: string;
  trajectory?: {
    report?: string;
    changed_files: string[];
    checks: string[];
    artifacts: string[];
  };
};

export type WorkBoardTask = TaskContractRecord & {
  session_id?: string;
  recovery?: string;
};

export type WorkBoardClaim = {
  claim_id: string;
  kind: "worker" | "handoff" | "symphony";
  session_id?: string;
  worker_id?: string;
  work_item_key?: string;
  claim_owner?: string;
  lease_age?: WorkLeaseAge;
  heartbeat_state?: WorkHeartbeatState;
  stale_reason?: string;
  conflict_reason?: string;
  resume_command?: string;
  last_artifact?: string;
  status: string;
  target?: string;
  updated_at?: string;
  recovery?: string;
};

export type WorkBoardArtifact = {
  artifact_id?: string;
  session_id: string;
  path: string;
  type: string;
  summary?: string;
  created_at?: string;
};

export type WorkBoardCheck = {
  session_id: string;
  value: string;
  status: "recorded" | "failed";
  recovery?: string;
};

export type WorkBoardNextAction = {
  source: "session" | "worker" | "task" | "claim" | "check" | "artifact" | "action";
  id: string;
  severity: "info" | "warning" | "error";
  action: string;
};

export type WorkBoardSummary = {
  sessions: number;
  active_sessions: number;
  workers: number;
  active_workers: number;
  resumable_workers: number;
  tasks: number;
  blocked: number;
  failed: number;
  resumable: number;
  claims: number;
  changed_files: number;
  checks: number;
  artifacts: number;
  actions: number;
};

export type WorkBoard = {
  schema_version: "swarm.work_board.v1";
  generated_at: string;
  scope: {
    kind: "session" | "workspace" | "symphony";
    workspace_path?: string;
    session_id?: string;
  };
  summary: WorkBoardSummary;
  sessions: WorkBoardSession[];
  work_items: WorkItem[];
  workers: WorkBoardWorker[];
  tasks: WorkBoardTask[];
  claims: WorkBoardClaim[];
  blocked: WorkBoardNextAction[];
  failed: WorkBoardNextAction[];
  resumable: WorkBoardNextAction[];
  changed_files: string[];
  checks: WorkBoardCheck[];
  artifacts: WorkBoardArtifact[];
  recent_actions: SymphonyActionFact[];
  next_actions: WorkBoardNextAction[];
  filters: WorkBoardFilter[];
};

export function buildSessionWorkBoard(
  runtime: SwarmRuntime,
  sessionId: string,
  options: {
    generatedAt?: string;
  } = {}
): WorkBoard {
  const snapshot = runtime.getWorkSnapshot(sessionId);
  return buildWorkBoardFromSnapshots({
    runtime,
    scope: {
      kind: "session",
      workspace_path: snapshot.workspace?.workspace_path ?? runtime.getWorkspacePath(),
      session_id: sessionId
    },
    snapshots: [snapshot],
    generatedAt: options.generatedAt
  });
}

export function buildWorkspaceWorkBoard(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
    generatedAt?: string;
  } = {}
): WorkBoard {
  const limit = normalizeLimit(options.limit, 20);
  const snapshots = listWorkBoardWorkspaceSessions(runtime, limit)
    .map((session) => safeSnapshot(runtime, session.session_id))
    .filter((snapshot): snapshot is WorkSnapshot => Boolean(snapshot));
  return buildWorkBoardFromSnapshots({
    runtime,
    scope: {
      kind: "workspace",
      workspace_path: runtime.getWorkspacePath()
    },
    snapshots,
    generatedAt: options.generatedAt
  });
}

function listWorkBoardWorkspaceSessions(
  runtime: SwarmRuntime,
  limit: number
): ReturnType<SwarmRuntime["listRecentSessionsForWorkspace"]> {
  const byId = new Map<string, ReturnType<SwarmRuntime["listRecentSessionsForWorkspace"]>[number]>();
  for (const session of runtime.listRecentSessionsForWorkspace(limit)) {
    byId.set(session.session_id, session);
  }

  const workspacePath = runtime.getWorkspacePath();
  for (const session of runtime.sessionStore.listRecent(Math.max(limit * 8, limit))) {
    if (byId.size >= limit) {
      break;
    }
    if (byId.has(session.session_id)) {
      continue;
    }
    const lease = session.workspace_lease_id
      ? runtime.workspaceLeaseStore.get(session.workspace_lease_id)
      : runtime.workspaceLeaseStore.getBySession(session.session_id);
    if (!lease) {
      continue;
    }
    if (isPathInWorkspaceScope(lease.workspace_path, workspacePath) || isPathInWorkspaceScope(lease.workspace_root, workspacePath)) {
      byId.set(session.session_id, session);
    }
  }

  return [...byId.values()].slice(0, limit);
}

function isPathInWorkspaceScope(candidatePath: string | undefined, workspacePath: string): boolean {
  if (!candidatePath) {
    return false;
  }
  const relativePath = relative(resolve(workspacePath), resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function buildWorkBoardFromSnapshots(input: {
  runtime?: Pick<SwarmRuntime, "artifactStore">;
  scope: WorkBoard["scope"];
  snapshots: WorkSnapshot[];
  generatedAt?: string;
  extraClaims?: WorkBoardClaim[];
  extraActions?: SymphonyActionFact[];
}): WorkBoard {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sessions = input.snapshots.map(sessionFromSnapshot);
  const workers = input.snapshots.flatMap((snapshot) => workersFromSnapshot(snapshot, generatedAt));
  const tasks = input.snapshots.flatMap(tasksFromSnapshot);
  const workerClaims = workers
    .filter((worker) => worker.status === "running" || worker.status === "pending")
    .map(workerClaim);
  const handoffClaims = input.snapshots.flatMap((snapshot) =>
    snapshot.work_contracts.active_handoffs.map((handoff) => handoffClaim(snapshot.session.session_id, handoff))
  );
  const claims = [...workerClaims, ...handoffClaims, ...(input.extraClaims ?? [])];
  const checks = input.snapshots.flatMap(checksFromSnapshot);
  const changedFiles = uniqueStrings(input.snapshots.flatMap((snapshot) => snapshot.changed_files));
  const artifacts = input.snapshots.flatMap((snapshot) => artifactsFromSnapshot(input.runtime, snapshot));
  const actions = latestActions(input.snapshots, input.extraActions);
  const blocked = [
    ...tasks.filter((task) => task.status === "blocked").map((task) => nextAction("task", task.task_id, "warning", task.recovery ?? defaultTaskRecovery(task) ?? "Resolve task blockers, then resume the task.")),
    ...workers.filter((worker) => worker.blocked_reason).map((worker) => nextAction("worker", worker.worker_id, "warning", worker.recovery ?? defaultWorkerRecovery(worker) ?? `Inspect blocked worker ${worker.worker_id}, then resume or retry.`)),
    ...claims.filter((claim) => claim.recovery && isBlockedClaim(claim)).map((claim) => nextAction("claim", claim.claim_id, "warning", claim.recovery ?? "Inspect the claim owner and resolve the blocker."))
  ];
  const failed = [
    ...sessions.filter((session) => session.status === "failed" || session.status === "cancelled").map((session) => nextAction("session", session.session_id, "error", session.next_action ?? defaultSessionRecovery(session.status))),
    ...tasks.filter((task) => task.status === "failed" || task.status === "cancelled").map((task) => nextAction("task", task.task_id, "error", task.recovery ?? defaultTaskRecovery(task) ?? "Inspect task attempts and rerun after fixing the failure.")),
    ...workers.filter((worker) => worker.status === "failed").map((worker) => nextAction("worker", worker.worker_id, "error", worker.recovery ?? defaultWorkerRecovery(worker) ?? `Inspect failed worker ${worker.worker_id}, then retry with a new worker.`)),
    ...checks.filter((check) => check.status === "failed").map((check) => nextAction("check", `${check.session_id}:${check.value}`, "error", check.recovery ?? "Inspect the failed check output, fix the failure, then rerun verification.")),
    ...actions.filter((action) => action.status === "rejected" || action.status === "not_supported" || action.status === "timed_out" || action.status === "rolled_back").map((action) =>
      nextAction("action", action.action_id, "error", action.recovery ?? `Inspect Symphony action ${action.action_id}, then retry with a supported operation.`)
    )
  ];
  const resumable = workers
    .filter((worker) => worker.status !== "pending" && worker.status !== "running")
    .map((worker) => nextAction("worker", worker.worker_id, worker.status === "failed" ? "error" : "info", worker.recovery ?? defaultWorkerRecovery(worker) ?? `Review worker ${worker.worker_id} and decide whether to resume, retry, or close it.`));
  const nextActions = dedupeNextActions([...blocked, ...failed, ...resumable]);
  const summary = summarize({
    sessions,
    workers,
    tasks,
    claims,
    changedFiles,
    checks,
    artifacts,
    actions,
    blocked,
    failed,
    resumable
  });
  return {
    schema_version: "swarm.work_board.v1",
    generated_at: generatedAt,
    scope: input.scope,
    summary,
    sessions,
    work_items: input.snapshots.map((snapshot) => snapshot.session.source).filter((item): item is WorkItem => Boolean(item)),
    workers,
    tasks,
    claims,
    blocked,
    failed,
    resumable,
    changed_files: changedFiles,
    checks,
    artifacts,
    recent_actions: actions,
    next_actions: nextActions,
    filters: WORK_BOARD_FILTERS
  };
}

export function formatWorkBoard(board: WorkBoard, options: { filter?: WorkBoardFilter } = {}): string {
  const filter = options.filter;
  if (filter) {
    return formatFilteredWorkBoard(board, filter);
  }
  return [
    "Work Board",
    `scope=${board.scope.kind}${board.scope.session_id ? ` session=${board.scope.session_id}` : ""}${board.scope.workspace_path ? ` workspace=${board.scope.workspace_path}` : ""}`,
    `summary sessions=${board.summary.sessions} active=${board.summary.active_sessions} workers=${board.summary.workers} active_workers=${board.summary.active_workers} resumable_workers=${board.summary.resumable_workers} tasks=${board.summary.tasks} blocked=${board.summary.blocked} failed=${board.summary.failed} claims=${board.summary.claims} changes=${board.summary.changed_files} checks=${board.summary.checks} artifacts=${board.summary.artifacts} actions=${board.summary.actions}`,
    "",
    "Sessions",
    ...(board.sessions.length
      ? board.sessions.slice(0, 20).map((session) => `${session.session_id} [${session.status}] ${session.source?.human_id ?? session.source?.source_id ?? session.source?.source ?? "user"} ${session.objective}${session.next_action ? ` next=${session.next_action}` : ""}`)
      : ["(none)"]),
    "",
    "Workers",
    ...(board.workers.length
      ? board.workers.slice(0, 20).map((worker) => [
          `${worker.worker_id} [${worker.status}]`,
          worker.session_id ? `session=${worker.session_id}` : undefined,
          worker.worker_session_id ? `worker_session=${worker.worker_session_id}` : undefined,
          worker.agent_spec_id ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : worker.capability,
          worker.write_policy ? `policy=${worker.write_policy}` : undefined,
          worker.file_scope.length ? `scope=${worker.file_scope.join(",")}` : undefined,
          worker.recovery ? `next=${worker.recovery}` : undefined
        ].filter(Boolean).join(" "))
      : ["(none)"]),
    "",
    "Tasks",
    ...(board.tasks.length
      ? board.tasks.slice(0, 30).map((task) => [
          `${task.task_id} [${task.status}]`,
          task.session_id ? `session=${task.session_id}` : undefined,
          task.capability ? `cap=${task.capability}` : undefined,
          task.write_policy ? `policy=${task.write_policy}` : undefined,
          task.file_scope.length ? `scope=${task.file_scope.join(",")}` : undefined,
          task.recovery ? `next=${task.recovery}` : undefined,
          task.title
        ].filter(Boolean).join(" "))
      : ["(none)"]),
    "",
    "Claims",
    ...(board.claims.length
      ? board.claims.slice(0, 30).map((claim) => [
          `${claim.claim_id} [${claim.status}]`,
          claim.kind,
          claim.session_id ? `session=${claim.session_id}` : undefined,
          claim.worker_id ? `worker=${claim.worker_id}` : undefined,
          claim.work_item_key ? `work_item=${claim.work_item_key}` : undefined,
          claim.target ? `target=${claim.target}` : undefined,
          claim.recovery ? `next=${claim.recovery}` : undefined
        ].filter(Boolean).join(" "))
      : ["(none)"]),
    "",
    "Next Actions",
    ...(board.next_actions.length
      ? board.next_actions.slice(0, 20).map((action) => `${action.severity} ${action.source}:${action.id} ${action.action}`)
      : ["(none)"]),
    "",
    "Changed Files",
    ...(board.changed_files.length ? board.changed_files.slice(0, 30) : ["(none)"]),
    "",
    "Checks",
    ...(board.checks.length
      ? board.checks.slice(0, 30).map((check) => `${check.session_id} [${check.status}] ${check.value}${check.recovery ? ` next=${check.recovery}` : ""}`)
      : ["(none)"]),
    "",
    "Artifacts",
    ...(board.artifacts.length
      ? board.artifacts.slice(0, 30).map((artifact) => `${artifact.session_id} ${artifact.artifact_id ?? "-"} ${artifact.type} ${artifact.path}${artifact.summary ? ` - ${artifact.summary}` : ""}`)
      : ["(none)"]),
    "",
    "Recent Actions",
    ...(board.recent_actions.length
      ? board.recent_actions.slice(0, 10).map((action) => `${action.action_id} ${action.action}/${action.status} correlation=${action.correlation_id}${action.target.session_id ? ` session=${action.target.session_id}` : ""}${action.recovery ? ` next=${action.recovery}` : ""}`)
      : ["(none)"])
  ].join("\n");
}

function formatFilteredWorkBoard(board: WorkBoard, filter: WorkBoardFilter): string {
  const header = [
    "Work Board",
    `scope=${board.scope.kind}${board.scope.session_id ? ` session=${board.scope.session_id}` : ""}${board.scope.workspace_path ? ` workspace=${board.scope.workspace_path}` : ""}`,
    `filter=${filter}`,
    `summary sessions=${board.summary.sessions} active=${board.summary.active_sessions} workers=${board.summary.workers} active_workers=${board.summary.active_workers} resumable_workers=${board.summary.resumable_workers} tasks=${board.summary.tasks} blocked=${board.summary.blocked} failed=${board.summary.failed} claims=${board.summary.claims} changes=${board.summary.changed_files} checks=${board.summary.checks} artifacts=${board.summary.artifacts} actions=${board.summary.actions}`,
    ""
  ];
  if (filter === "active") {
    return [
      ...header,
      "Active Sessions",
      ...formatSessionRows(board.sessions.filter((session) => isActiveSessionStatus(session.status))),
      "",
      "Active Workers",
      ...formatWorkerRows(board.workers.filter((worker) => worker.status === "running" || worker.status === "pending")),
      "",
      "Active Claims",
      ...formatClaimRows(board.claims.filter((claim) => claim.status === "running" || claim.status === "pending" || claim.status === "active"))
    ].join("\n");
  }
  if (filter === "blocked") {
    return [
      ...header,
      "Blocked",
      ...(board.blocked.length ? board.blocked.map(formatNextActionRow) : ["(none)"])
    ].join("\n");
  }
  if (filter === "failed") {
    return [
      ...header,
      "Failed",
      ...(board.failed.length ? board.failed.map(formatNextActionRow) : ["(none)"])
    ].join("\n");
  }
  if (filter === "resumable") {
    return [
      ...header,
      "Resumable",
      ...(board.resumable.length ? board.resumable.map(formatNextActionRow) : ["(none)"]),
      "",
      "Workers",
      ...formatWorkerRows(board.workers.filter((worker) => worker.status !== "running" && worker.status !== "pending"))
    ].join("\n");
  }
  if (filter === "changed-files") {
    return [
      ...header,
      "Changed Files",
      ...(board.changed_files.length ? board.changed_files : ["(none)"])
    ].join("\n");
  }
  return [
    ...header,
    "Checks",
    ...(board.checks.length
      ? board.checks.map((check) => `${check.session_id} [${check.status}] ${check.value}${check.recovery ? ` next=${check.recovery}` : ""}`)
      : ["(none)"])
  ].join("\n");
}

function formatSessionRows(sessions: WorkBoardSession[]): string[] {
  return sessions.length
    ? sessions.slice(0, 20).map((session) => `${session.session_id} [${session.status}] ${session.source?.human_id ?? session.source?.source_id ?? session.source?.source ?? "user"} ${session.objective}${session.next_action ? ` next=${session.next_action}` : ""}`)
    : ["(none)"];
}

function formatWorkerRows(workers: WorkBoardWorker[]): string[] {
  return workers.length
    ? workers.slice(0, 20).map((worker) => [
        `${worker.worker_id} [${worker.status}]`,
        worker.session_id ? `session=${worker.session_id}` : undefined,
        worker.worker_session_id ? `worker_session=${worker.worker_session_id}` : undefined,
        worker.claim_owner ? `owner=${worker.claim_owner}` : undefined,
        worker.lease_age ? `lease=${worker.lease_age.label}` : undefined,
        worker.heartbeat_state ? `heartbeat=${worker.heartbeat_state}` : undefined,
        worker.stale_reason ? `stale=${worker.stale_reason}` : undefined,
        worker.last_artifact ? `artifact=${worker.last_artifact}` : undefined,
        worker.agent_spec_id ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : worker.capability,
        worker.write_policy ? `policy=${worker.write_policy}` : undefined,
        worker.file_scope.length ? `scope=${worker.file_scope.join(",")}` : undefined,
        worker.resume_command ? `resume=${worker.resume_command}` : undefined,
        worker.recovery ? `next=${worker.recovery}` : undefined
      ].filter(Boolean).join(" "))
    : ["(none)"];
}

function formatClaimRows(claims: WorkBoardClaim[]): string[] {
  return claims.length
    ? claims.slice(0, 30).map((claim) => [
        `${claim.claim_id} [${claim.status}]`,
        claim.kind,
        claim.session_id ? `session=${claim.session_id}` : undefined,
        claim.worker_id ? `worker=${claim.worker_id}` : undefined,
        claim.work_item_key ? `work_item=${claim.work_item_key}` : undefined,
        claim.claim_owner ? `owner=${claim.claim_owner}` : undefined,
        claim.lease_age ? `lease=${claim.lease_age.label}` : undefined,
        claim.heartbeat_state ? `heartbeat=${claim.heartbeat_state}` : undefined,
        claim.stale_reason ? `stale=${claim.stale_reason}` : undefined,
        claim.last_artifact ? `artifact=${claim.last_artifact}` : undefined,
        claim.target ? `target=${claim.target}` : undefined,
        claim.resume_command ? `resume=${claim.resume_command}` : undefined,
        claim.recovery ? `next=${claim.recovery}` : undefined
      ].filter(Boolean).join(" "))
    : ["(none)"];
}

function formatNextActionRow(action: WorkBoardNextAction): string {
  return `${action.severity} ${action.source}:${action.id} ${action.action}`;
}

function sessionFromSnapshot(snapshot: WorkSnapshot): WorkBoardSession {
  const failedTasks = snapshot.task_contracts.summary.failed;
  const blockedTasks = snapshot.task_contracts.summary.blocked;
  return {
    session_id: snapshot.session.session_id,
    status: snapshot.session.status,
    objective: snapshot.session.objective,
    source: snapshot.session.source,
    workspace_path: snapshot.workspace?.workspace_path,
    updated_at: snapshot.session.updated_at,
    next_action: snapshot.session.status === "failed" || snapshot.session.status === "cancelled"
      ? defaultSessionRecovery(snapshot.session.status)
      : blockedTasks > 0
        ? "Inspect blocked tasks and resolve their dependencies before resuming."
        : failedTasks > 0
          ? "Inspect failed tasks and rerun verification after fixing them."
          : undefined
  };
}

function workersFromSnapshot(snapshot: WorkSnapshot, generatedAt: string): WorkBoardWorker[] {
  const persisted = new Map<string, unknown>();
  for (const worker of snapshot.workers) {
    if (isRecord(worker) && typeof worker.worker_id === "string") {
      persisted.set(worker.worker_id, worker);
    }
  }
  return [...snapshot.work_contracts.active_workers, ...snapshot.work_contracts.resumable_workers].map((worker) => {
    const row = persisted.get(worker.worker_id);
    const workerSessionId = isRecord(row) && typeof row.worker_session_id === "string" ? row.worker_session_id : undefined;
    const outcome = isRecord(row) && isRecord(row.outcome) ? row.outcome : undefined;
    const lastResult = isRecord(row) && typeof row.last_result === "string" ? firstLine(row.last_result) : undefined;
    const changedFiles = stringArray(outcome?.changed_files);
    const checks = stringArray(outcome?.tests_run);
    const artifacts = stringArray(outcome?.intermediate_artifacts);
    const leaseAge = buildLeaseAge(worker.updated_at, generatedAt);
    const heartbeatState = workerHeartbeatState(worker.status, leaseAge, worker.blocked_reason);
    const lastArtifact = artifacts.at(-1) ?? changedFiles.at(-1) ?? lastResult;
    const resumeCommand = workerResumeCommand(worker.worker_id, worker.status, workerSessionId);
    const staleReason = workerStaleReason(worker, leaseAge, heartbeatState);
    return {
      ...worker,
      session_id: snapshot.session.session_id,
      worker_session_id: workerSessionId,
      claim_owner: workerSessionId ?? worker.requested_by ?? snapshot.session.session_id,
      lease_age: leaseAge,
      heartbeat_state: heartbeatState,
      stale_reason: staleReason,
      resume_command: resumeCommand,
      last_artifact: lastArtifact,
      recovery: defaultWorkerRecovery({
        ...worker,
        stale_reason: staleReason,
        resume_command: resumeCommand,
        last_artifact: lastArtifact
      }),
      trajectory: {
        report: lastResult,
        changed_files: changedFiles,
        checks,
        artifacts
      }
    };
  });
}

function tasksFromSnapshot(snapshot: WorkSnapshot): WorkBoardTask[] {
  return snapshot.task_contracts.tasks.map((task) => ({
    ...task,
    session_id: snapshot.session.session_id,
    recovery: defaultTaskRecovery(task)
  }));
}

function workerClaim(worker: WorkBoardWorker): WorkBoardClaim {
  return {
    claim_id: `worker:${worker.worker_id}`,
    kind: "worker",
    session_id: worker.session_id,
    worker_id: worker.worker_id,
    claim_owner: worker.claim_owner ?? worker.worker_session_id ?? worker.session_id,
    lease_age: worker.lease_age,
    heartbeat_state: worker.heartbeat_state,
    stale_reason: worker.stale_reason ?? worker.blocked_reason,
    resume_command: worker.resume_command,
    last_artifact: worker.last_artifact,
    status: worker.blocked_reason ? "blocked" : worker.status,
    target: worker.file_scope.join(",") || worker.objective,
    updated_at: worker.updated_at,
    recovery: worker.blocked_reason ? defaultWorkerRecovery(worker) : undefined
  };
}

function handoffClaim(sessionId: string, handoff: WorkContractHandoff): WorkBoardClaim {
  return {
    claim_id: `handoff:${handoff.handoff_id}`,
    kind: "handoff",
    session_id: sessionId,
    worker_id: handoff.worker_id,
    claim_owner: handoff.claim_owner,
    lease_age: handoff.lease_age,
    heartbeat_state: handoff.heartbeat_state,
    stale_reason: handoff.stale_reason,
    conflict_reason: handoff.conflict_reason,
    last_artifact: handoffLastArtifact(handoff),
    status: handoff.protocol_status ?? handoff.status,
    target: handoff.scope.join(",") || handoff.file_scope.join(",") || handoff.target_agent_spec_id,
    updated_at: handoff.updated_at,
    recovery: defaultHandoffRecovery(handoff)
  };
}

function isBlockedClaim(claim: WorkBoardClaim): boolean {
  return claim.status === "blocked" ||
    claim.status === "active" ||
    claim.status === "conflict" ||
    claim.status === "timeout" ||
    claim.status === "stale" ||
    claim.heartbeat_state === "blocked" ||
    claim.heartbeat_state === "stale" ||
    claim.heartbeat_state === "missing";
}

function checksFromSnapshot(snapshot: WorkSnapshot): WorkBoardCheck[] {
  return snapshot.checks.map((check) => ({
    session_id: snapshot.session.session_id,
    value: check,
    status: /\b(fail|failed|error|reject|denied)\b/i.test(check) ? "failed" : "recorded",
    recovery: /\b(fail|failed|error|reject|denied)\b/i.test(check)
      ? "Inspect the failed check output, fix the issue, then rerun the check."
      : undefined
  }));
}

function artifactsFromSnapshot(runtime: Pick<SwarmRuntime, "artifactStore"> | undefined, snapshot: WorkSnapshot): WorkBoardArtifact[] {
  const persisted = runtime?.artifactStore.list(snapshot.session.session_id).map((artifact) => ({
    artifact_id: artifact.artifact_id,
    session_id: artifact.session_id,
    path: artifact.path,
    type: artifact.type,
    summary: artifact.summary,
    created_at: artifact.created_at
  })) ?? [];
  const persistedPaths = new Set(persisted.map((artifact) => artifact.path));
  const outcomeArtifacts = (snapshot.final_outcome?.intermediate_artifacts ?? [])
    .filter((path) => !persistedPaths.has(path))
    .map((path) => ({
      session_id: snapshot.session.session_id,
      path,
      type: "intermediate",
      summary: "Recorded in final outcome."
    }));
  return [...persisted, ...outcomeArtifacts];
}

function latestActions(snapshots: WorkSnapshot[], extra: SymphonyActionFact[] | undefined): SymphonyActionFact[] {
  const values = [
    ...(extra ?? []),
    ...snapshots.flatMap((snapshot) => snapshot.attempts.map((attempt) => attempt.metadata)),
    ...snapshots.flatMap((snapshot) => {
      const actionLike = [
        snapshot.review,
        snapshot.verification
      ];
      return actionLike;
    })
  ];
  const latest = latestSymphonyActionFact(values);
  return latest ? [latest] : [];
}

function summarize(input: {
  sessions: WorkBoardSession[];
  workers: WorkBoardWorker[];
  tasks: WorkBoardTask[];
  claims: WorkBoardClaim[];
  changedFiles: string[];
  checks: WorkBoardCheck[];
  artifacts: WorkBoardArtifact[];
  actions: SymphonyActionFact[];
  blocked: WorkBoardNextAction[];
  failed: WorkBoardNextAction[];
  resumable: WorkBoardNextAction[];
}): WorkBoardSummary {
  return {
    sessions: input.sessions.length,
    active_sessions: input.sessions.filter((session) => isActiveSessionStatus(session.status)).length,
    workers: input.workers.length,
    active_workers: input.workers.filter((worker) => worker.status === "running" || worker.status === "pending").length,
    resumable_workers: input.workers.filter((worker) => worker.status !== "running" && worker.status !== "pending").length,
    tasks: input.tasks.length,
    blocked: input.blocked.length,
    failed: input.failed.length,
    resumable: input.resumable.length,
    claims: input.claims.length,
    changed_files: input.changedFiles.length,
    checks: input.checks.length,
    artifacts: input.artifacts.length,
    actions: input.actions.length
  };
}

function nextAction(source: WorkBoardNextAction["source"], id: string, severity: WorkBoardNextAction["severity"], action: string): WorkBoardNextAction {
  return { source, id, severity, action };
}

function dedupeNextActions(actions: WorkBoardNextAction[]): WorkBoardNextAction[] {
  const seen = new Set<string>();
  const output: WorkBoardNextAction[] = [];
  for (const action of actions) {
    const key = `${action.source}:${action.id}:${action.action}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(action);
    }
  }
  return output;
}

function defaultSessionRecovery(status: SwarmSession["status"]): string {
  return status === "cancelled"
    ? "Resume the session with a new message or inspect cancellation intent before retrying."
    : "Open latest diagnosis, inspect failed attempts, fix the cause, then retry or resume.";
}

function defaultTaskRecovery(task: TaskContractRecord): string | undefined {
  if (task.status === "blocked") {
    return task.last_error ?? "Resolve dependencies or approvals, then resume the task.";
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return task.last_error ?? "Inspect task attempts and rerun after fixing the failure.";
  }
  return undefined;
}

function defaultWorkerRecovery(worker: Pick<WorkContractWorker, "status" | "blocked_reason" | "worker_id" | "stale_reason" | "resume_command" | "last_artifact">): string | undefined {
  if (worker.blocked_reason) {
    return worker.blocked_reason;
  }
  if (worker.status === "failed") {
    return worker.stale_reason ?? `Inspect worker ${worker.worker_id} report and continue with /continue-agent or retry with a new worker.`;
  }
  if (worker.status === "stopped") {
    return worker.resume_command ?? `Continue worker ${worker.worker_id} with /continue-agent or take back its handoff.`;
  }
  if (worker.status === "completed") {
    return worker.last_artifact
      ? `Review worker ${worker.worker_id} artifact ${worker.last_artifact} before closing dependent work.`
      : `Review worker ${worker.worker_id} result before closing dependent work.`;
  }
  return undefined;
}

function defaultHandoffRecovery(handoff: WorkContractHandoff): string | undefined {
  if (handoff.protocol_status === "conflict" || handoff.conflict_reason) {
    return handoff.conflict_reason ?? `Resolve ownership conflict for handoff ${handoff.handoff_id}, then take back or renew the lease.`;
  }
  if (handoff.protocol_status === "timeout") {
    return `Handoff ${handoff.handoff_id} timed out; take it back or reassign from the latest checkpoint.`;
  }
  if (handoff.heartbeat_state === "missing") {
    return `Handoff ${handoff.handoff_id} is waiting for ${handoff.target_agent_spec_id} to accept ownership.`;
  }
  if (handoff.heartbeat_state === "stale" || handoff.protocol_status === "stale") {
    return handoff.stale_reason ?? `Handoff ${handoff.handoff_id} has no fresh heartbeat; take it back or request renewal.`;
  }
  if (handoff.status === "active") {
    return `Review handoff ${handoff.handoff_id}; take it back or let ${handoff.target_agent_spec_id} return it.`;
  }
  return undefined;
}

function handoffLastArtifact(handoff: WorkContractHandoff): string | undefined {
  const returnContract = isRecord(handoff.return_contract) ? handoff.return_contract : undefined;
  const result = isRecord(returnContract?.result) ? returnContract.result : undefined;
  const checkpoint = isRecord(handoff.last_checkpoint) ? handoff.last_checkpoint : undefined;
  const fromReturn = stringValue(result?.output_ref ?? result?.outputRef ?? returnContract?.output_ref ?? returnContract?.outputRef);
  const fromCheckpoint = stringValue(checkpoint?.artifact ?? checkpoint?.output_ref ?? checkpoint?.outputRef ?? checkpoint?.worker_session_id);
  const fromSummary = stringValue(result?.summary ?? checkpoint?.summary);
  return fromReturn ?? fromCheckpoint ?? fromSummary;
}

function buildLeaseAge(updatedAt: string, generatedAt: string): WorkLeaseAge {
  const ageMs = Math.max(0, Date.parse(generatedAt) - Date.parse(updatedAt));
  return {
    since: updatedAt,
    age_ms: Number.isFinite(ageMs) ? ageMs : 0,
    label: formatAgeLabel(ageMs)
  };
}

function workerHeartbeatState(
  status: WorkContractWorker["status"],
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
  worker: WorkContractWorker,
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

function workerResumeCommand(workerId: string, status: WorkContractWorker["status"], workerSessionId: string | undefined): string | undefined {
  if (status === "running" || status === "pending") {
    return workerSessionId ? `/continue-agent ${workerId} ${workerSessionId}` : `/continue-agent ${workerId}`;
  }
  if (status === "failed" || status === "stopped") {
    return workerSessionId ? `/continue-agent ${workerId} resume ${workerSessionId}` : `/continue-agent ${workerId} resume`;
  }
  if (status === "completed") {
    return workerSessionId ? `/continue-agent ${workerId} inspect ${workerSessionId}` : `/continue-agent ${workerId} inspect`;
  }
  return undefined;
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

function safeSnapshot(runtime: SwarmRuntime, sessionId: string): WorkSnapshot | undefined {
  try {
    return runtime.getWorkSnapshot(sessionId);
  } catch {
    return undefined;
  }
}

function isActiveSessionStatus(status: SwarmSession["status"]): boolean {
  return status === "created" || status === "planning" || status === "running" || status === "reviewing" || status === "aggregating";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}
