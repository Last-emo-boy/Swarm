import type { ApprovalRecord } from "../storage/approval-store.js";
import type { ArtifactRecord } from "../storage/artifact-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { RunAttempt, SwarmSession, WorkItem, WorkspaceLease } from "../protocol/types.js";
import type { SessionRow } from "../storage/session-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

export type CaseWorkbenchStatus = "active" | "blocked" | "review" | "resumable" | "done" | "failed" | "planned";
export type CaseWorkbenchSeverity = "info" | "warning" | "error";

export type CaseWorkbenchSessionRef = {
  session_id: string;
  parent_session_id?: string;
  status: SwarmSession["status"];
  objective: string;
  source?: WorkItem;
  workspace_path?: string;
  updated_at: string;
};

export type CaseWorkbenchItem = {
  case_id: string;
  root_session_id: string;
  title: string;
  status: CaseWorkbenchStatus;
  severity: CaseWorkbenchSeverity;
  source: string;
  owner: string;
  workspace_path?: string;
  workspace_label: string;
  write_boundary?: WorkspaceLease["write_boundary"];
  updated_at: string;
  session_count: number;
  worker_count: number;
  active_workers: number;
  pending_approvals: number;
  failed_checks: number;
  artifact_count: number;
  next_action: string;
  badges: string[];
};

export type CaseWorkbenchDetail = CaseWorkbenchItem & {
  sessions: CaseWorkbenchSessionRef[];
  leases: WorkspaceLease[];
  workers: Array<Pick<WorkerRecord, "worker_id" | "display_name" | "role_title" | "status" | "objective" | "blocked_reason" | "updated_at">>;
  handoffs: Array<Pick<HandoffSessionRecord, "handoff_id" | "worker_id" | "status" | "protocol_status" | "target_agent_spec_id" | "conflict_reason" | "updated_at">>;
  approvals: Array<Pick<ApprovalRecord, "approval_id" | "status" | "summary" | "risk_class" | "updated_at">>;
  attempts: Array<Pick<RunAttempt, "attempt_id" | "kind" | "status" | "title" | "workspace_path" | "last_event_at" | "recovery_suggestion">>;
  artifacts: ArtifactRecord[];
  timeline: string[];
};

export type CaseWorkbenchInboxItem = {
  id: string;
  case_id: string;
  kind: "approval" | "blocked_worker" | "failed_worker" | "failed_attempt" | "handoff" | "no_workspace";
  severity: CaseWorkbenchSeverity;
  reason: string;
  recommended_action: string;
  updated_at?: string;
};

export type CaseWorkbenchProjection = {
  schema_version: "swarm.case_workbench.v1";
  generated_at: string;
  scope: "global";
  summary: {
    cases: number;
    active: number;
    blocked: number;
    review: number;
    resumable: number;
    done: number;
    failed: number;
    no_workspace: number;
    inbox: number;
  };
  cases: CaseWorkbenchItem[];
  inbox: CaseWorkbenchInboxItem[];
};

export type BuildCaseWorkbenchInput = {
  sessions: SessionRow[];
  leases?: WorkspaceLease[];
  workers?: WorkerRecord[];
  handoffs?: HandoffSessionRecord[];
  approvals?: ApprovalRecord[];
  attempts?: RunAttempt[];
  artifactsBySession?: Map<string, ArtifactRecord[]>;
  generatedAt?: string;
  limit?: number;
};

export type BuildCaseWorkbenchDetailInput = BuildCaseWorkbenchInput & {
  caseId: string;
};

type CaseGroup = {
  root: SessionRow;
  sessions: SessionRow[];
};

export function buildCaseWorkbenchProjection(input: BuildCaseWorkbenchInput): CaseWorkbenchProjection {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const groups = caseGroups(input.sessions);
  const cases = groups
    .map((group) => caseItem(group, input))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, normalizeLimit(input.limit, 50));
  const caseIds = new Set(cases.map((item) => item.case_id));
  const inbox = groups
    .flatMap((group) => inboxItems(group, input))
    .filter((item) => caseIds.has(item.case_id))
    .sort((left, right) => inboxRank(left) - inboxRank(right) || (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));

  return {
    schema_version: "swarm.case_workbench.v1",
    generated_at: generatedAt,
    scope: "global",
    summary: {
      cases: cases.length,
      active: cases.filter((item) => item.status === "active").length,
      blocked: cases.filter((item) => item.status === "blocked").length,
      review: cases.filter((item) => item.status === "review").length,
      resumable: cases.filter((item) => item.status === "resumable").length,
      done: cases.filter((item) => item.status === "done").length,
      failed: cases.filter((item) => item.status === "failed").length,
      no_workspace: cases.filter((item) => !item.workspace_path).length,
      inbox: inbox.length
    },
    cases,
    inbox
  };
}

export function buildCaseWorkbenchDetail(input: BuildCaseWorkbenchDetailInput): CaseWorkbenchDetail | undefined {
  const group = caseGroups(input.sessions).find((candidate) => candidate.root.session_id === input.caseId);
  if (!group) {
    return undefined;
  }
  const item = caseItem(group, input);
  const sessionIds = new Set(group.sessions.map((session) => session.session_id));
  const leases = (input.leases ?? []).filter((lease) => sessionIds.has(lease.session_id));
  const workers = (input.workers ?? []).filter((worker) => sessionIds.has(worker.parent_session_id));
  const handoffs = (input.handoffs ?? []).filter((handoff) => sessionIds.has(handoff.parent_session_id));
  const approvals = (input.approvals ?? []).filter((approval) => approval.session_id ? sessionIds.has(approval.session_id) : false);
  const attempts = (input.attempts ?? []).filter((attempt) => sessionIds.has(attempt.session_id));
  const artifacts = group.sessions.flatMap((session) => input.artifactsBySession?.get(session.session_id) ?? []);
  return {
    ...item,
    sessions: group.sessions.map((session) => sessionRef(session, leaseForSession(input.leases ?? [], session))),
    leases,
    workers: workers.map((worker) => ({
      worker_id: worker.worker_id,
      display_name: worker.display_name,
      role_title: worker.role_title,
      status: worker.status,
      objective: worker.objective,
      blocked_reason: worker.blocked_reason,
      updated_at: worker.updated_at
    })),
    handoffs: handoffs.map((handoff) => ({
      handoff_id: handoff.handoff_id,
      worker_id: handoff.worker_id,
      status: handoff.status,
      protocol_status: handoff.protocol_status,
      target_agent_spec_id: handoff.target_agent_spec_id,
      conflict_reason: handoff.conflict_reason,
      updated_at: handoff.updated_at
    })),
    approvals: approvals.map((approval) => ({
      approval_id: approval.approval_id,
      status: approval.status,
      summary: approval.summary,
      risk_class: approval.risk_class,
      updated_at: approval.updated_at
    })),
    attempts: attempts.map((attempt) => ({
      attempt_id: attempt.attempt_id,
      kind: attempt.kind,
      status: attempt.status,
      title: attempt.title,
      workspace_path: attempt.workspace_path,
      last_event_at: attempt.last_event_at,
      recovery_suggestion: attempt.recovery_suggestion
    })),
    artifacts,
    timeline: timelineRows({ group, workers, handoffs, approvals, attempts, artifacts })
  };
}

function caseGroups(sessions: SessionRow[]): CaseGroup[] {
  const byId = new Map(sessions.map((session) => [session.session_id, session]));
  const groups = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const rootId = rootSessionId(session, byId);
    groups.set(rootId, [...(groups.get(rootId) ?? []), session]);
  }
  return [...groups.entries()]
    .map(([rootId, groupedSessions]) => ({
      root: byId.get(rootId) ?? groupedSessions[0]!,
      sessions: groupedSessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    }))
    .sort((left, right) => right.sessions[0]!.updated_at.localeCompare(left.sessions[0]!.updated_at));
}

function rootSessionId(session: SessionRow, byId: Map<string, SessionRow>): string {
  let current = session;
  const seen = new Set<string>();
  while (current.parent_session_id && !seen.has(current.session_id)) {
    seen.add(current.session_id);
    const parent = byId.get(current.parent_session_id);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current.session_id;
}

function caseItem(group: CaseGroup, input: BuildCaseWorkbenchInput): CaseWorkbenchItem {
  const sessionIds = new Set(group.sessions.map((session) => session.session_id));
  const leases = (input.leases ?? []).filter((lease) => sessionIds.has(lease.session_id));
  const workers = (input.workers ?? []).filter((worker) => sessionIds.has(worker.parent_session_id));
  const approvals = (input.approvals ?? []).filter((approval) => approval.session_id ? sessionIds.has(approval.session_id) : false);
  const attempts = (input.attempts ?? []).filter((attempt) => sessionIds.has(attempt.session_id));
  const artifacts = group.sessions.flatMap((session) => input.artifactsBySession?.get(session.session_id) ?? []);
  const latestSession = group.sessions[0] ?? group.root;
  const lease = leaseForSession(input.leases ?? [], latestSession) ?? leases[0];
  const failedChecks = attempts.filter((attempt) => attempt.kind === "verification" && attempt.status === "failed").length;
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending").length;
  const source = sourceFromSession(group.root);
  const status = caseStatus({ sessions: group.sessions, workers, attempts, pendingApprovals, failedChecks });
  const severity = status === "failed" ? "error" : status === "blocked" || status === "review" ? "warning" : "info";
  return {
    case_id: group.root.session_id,
    root_session_id: group.root.session_id,
    title: caseTitle(group.root),
    status,
    severity,
    source,
    owner: ownerFromWorkers(workers),
    workspace_path: lease?.workspace_path,
    workspace_label: lease ? shortPath(lease.workspace_path) : "no workspace",
    write_boundary: lease?.write_boundary,
    updated_at: latestSession.updated_at,
    session_count: group.sessions.length,
    worker_count: workers.length,
    active_workers: workers.filter((worker) => worker.status === "running" || worker.status === "pending").length,
    pending_approvals: pendingApprovals,
    failed_checks: failedChecks,
    artifact_count: artifacts.length,
    next_action: nextAction({ status, lease, workers, pendingApprovals, failedChecks }),
    badges: badges({ group, lease, workers, pendingApprovals, failedChecks, artifacts })
  };
}

function sessionRef(session: SessionRow, lease: WorkspaceLease | undefined): CaseWorkbenchSessionRef {
  return {
    session_id: session.session_id,
    parent_session_id: session.parent_session_id ?? undefined,
    status: session.status,
    objective: session.objective,
    source: parseSource(session.source_json),
    workspace_path: lease?.workspace_path,
    updated_at: session.updated_at
  };
}

function inboxItems(group: CaseGroup, input: BuildCaseWorkbenchInput): CaseWorkbenchInboxItem[] {
  const item = caseItem(group, input);
  const sessionIds = new Set(group.sessions.map((session) => session.session_id));
  const approvals = (input.approvals ?? []).filter((approval) => approval.session_id ? sessionIds.has(approval.session_id) : false);
  const workers = (input.workers ?? []).filter((worker) => sessionIds.has(worker.parent_session_id));
  const handoffs = (input.handoffs ?? []).filter((handoff) => sessionIds.has(handoff.parent_session_id));
  const attempts = (input.attempts ?? []).filter((attempt) => sessionIds.has(attempt.session_id));
  const output: CaseWorkbenchInboxItem[] = [];
  if (!item.workspace_path) {
    output.push({
      id: `no-workspace:${item.case_id}`,
      case_id: item.case_id,
      kind: "no_workspace",
      severity: "warning",
      reason: "Case has no workspace lease.",
      recommended_action: "Attach or choose a workspace before running workspace-write actions.",
      updated_at: item.updated_at
    });
  }
  for (const approval of approvals.filter((approval) => approval.status === "pending")) {
    output.push({
      id: `approval:${approval.approval_id}`,
      case_id: item.case_id,
      kind: "approval",
      severity: approval.risk_class === "r3" || approval.risk_class === "r4" ? "error" : "warning",
      reason: approval.summary,
      recommended_action: approval.challenge.attention_note ?? approval.challenge.why_now ?? "Review and decide the approval.",
      updated_at: approval.updated_at
    });
  }
  for (const worker of workers) {
    if (worker.blocked_reason) {
      output.push({
        id: `blocked-worker:${worker.worker_id}`,
        case_id: item.case_id,
        kind: "blocked_worker",
        severity: "warning",
        reason: worker.blocked_reason,
        recommended_action: "Inspect the teammate blocker, then continue or take back the work.",
        updated_at: worker.updated_at
      });
    }
    if (worker.status === "failed") {
      output.push({
        id: `failed-worker:${worker.worker_id}`,
        case_id: item.case_id,
        kind: "failed_worker",
        severity: "error",
        reason: worker.last_result ?? `Worker ${worker.worker_id} failed.`,
        recommended_action: "Inspect the failed teammate report and retry or continue.",
        updated_at: worker.updated_at
      });
    }
  }
  for (const attempt of attempts.filter((attempt) => attempt.status === "failed")) {
    output.push({
      id: `failed-attempt:${attempt.attempt_id}`,
      case_id: item.case_id,
      kind: "failed_attempt",
      severity: "error",
      reason: attempt.title ?? attempt.error_code ?? `${attempt.kind} failed.`,
      recommended_action: attempt.recovery_suggestion ?? "Inspect the failed attempt and rerun after fixing the issue.",
      updated_at: attempt.last_event_at
    });
  }
  for (const handoff of handoffs.filter((handoff) => handoff.status === "active" || handoff.protocol_status === "conflict" || handoff.protocol_status === "timeout")) {
    output.push({
      id: `handoff:${handoff.handoff_id}`,
      case_id: item.case_id,
      kind: "handoff",
      severity: handoff.protocol_status === "conflict" || handoff.protocol_status === "timeout" ? "warning" : "info",
      reason: handoff.conflict_reason ?? `Handoff ${handoff.handoff_id} is ${handoff.protocol_status ?? handoff.status}.`,
      recommended_action: "Inspect the handoff and decide whether to wait, renew, or take it back.",
      updated_at: handoff.updated_at
    });
  }
  return output;
}

function caseStatus(input: {
  sessions: SessionRow[];
  workers: WorkerRecord[];
  attempts: RunAttempt[];
  pendingApprovals: number;
  failedChecks: number;
}): CaseWorkbenchStatus {
  if (input.sessions.some((session) => session.status === "failed" || session.status === "cancelled") || input.workers.some((worker) => worker.status === "failed")) {
    return "failed";
  }
  if (input.pendingApprovals > 0 || input.workers.some((worker) => Boolean(worker.blocked_reason)) || input.failedChecks > 0) {
    return "blocked";
  }
  if (input.attempts.some((attempt) => attempt.kind === "review" && attempt.status === "started")) {
    return "review";
  }
  if (input.workers.some((worker) => worker.status === "stopped")) {
    return "resumable";
  }
  if (input.sessions.some((session) => isActiveSessionStatus(session.status)) || input.workers.some((worker) => worker.status === "running" || worker.status === "pending")) {
    return "active";
  }
  if (input.sessions.every((session) => session.status === "completed")) {
    return "done";
  }
  return "planned";
}

function nextAction(input: {
  status: CaseWorkbenchStatus;
  lease?: WorkspaceLease;
  workers: WorkerRecord[];
  pendingApprovals: number;
  failedChecks: number;
}): string {
  if (!input.lease) {
    return "Attach a workspace lease before running workspace-write actions.";
  }
  if (input.pendingApprovals > 0) {
    return "Review pending approvals.";
  }
  const blockedWorker = input.workers.find((worker) => worker.blocked_reason);
  if (blockedWorker) {
    return blockedWorker.blocked_reason ?? "Inspect blocked teammate.";
  }
  if (input.failedChecks > 0) {
    return "Fix failed verification checks, then rerun.";
  }
  if (input.status === "failed") {
    return "Inspect failure evidence and retry or fork.";
  }
  if (input.status === "resumable") {
    return "Resume or fork this case.";
  }
  if (input.status === "done") {
    return "Review final evidence or archive the case.";
  }
  return "Continue this case.";
}

function badges(input: {
  group: CaseGroup;
  lease?: WorkspaceLease;
  workers: WorkerRecord[];
  pendingApprovals: number;
  failedChecks: number;
  artifacts: ArtifactRecord[];
}): string[] {
  return [
    sourceFromSession(input.group.root),
    input.lease ? input.lease.write_boundary.replace("_", "-") : "no-workspace",
    input.workers.length ? `${input.workers.length} teammate${input.workers.length === 1 ? "" : "s"}` : undefined,
    input.pendingApprovals ? `${input.pendingApprovals} approval${input.pendingApprovals === 1 ? "" : "s"}` : undefined,
    input.failedChecks ? `${input.failedChecks} failed check${input.failedChecks === 1 ? "" : "s"}` : undefined,
    input.artifacts.length ? `${input.artifacts.length} artifact${input.artifacts.length === 1 ? "" : "s"}` : undefined
  ].filter((value): value is string => Boolean(value));
}

function timelineRows(input: {
  group: CaseGroup;
  workers: WorkerRecord[];
  handoffs: HandoffSessionRecord[];
  approvals: ApprovalRecord[];
  attempts: RunAttempt[];
  artifacts: ArtifactRecord[];
}): string[] {
  return [
    ...input.group.sessions.map((session) => `${session.updated_at} session ${session.session_id} ${session.status}: ${session.objective}`),
    ...input.workers.map((worker) => `${worker.updated_at} teammate ${worker.worker_id} ${worker.status}: ${worker.objective}`),
    ...input.handoffs.map((handoff) => `${handoff.updated_at} handoff ${handoff.handoff_id} ${handoff.protocol_status ?? handoff.status}`),
    ...input.approvals.map((approval) => `${approval.updated_at} approval ${approval.approval_id} ${approval.status}: ${approval.summary}`),
    ...input.attempts.map((attempt) => `${attempt.last_event_at} attempt ${attempt.kind}/${attempt.status}: ${attempt.title ?? attempt.attempt_id}`),
    ...input.artifacts.map((artifact) => `${artifact.created_at} artifact ${artifact.type}: ${artifact.summary ?? artifact.path}`)
  ].sort().slice(-40);
}

function sourceFromSession(session: SessionRow): string {
  return parseSource(session.source_json)?.source ?? "user";
}

function caseTitle(session: SessionRow): string {
  const source = parseSource(session.source_json);
  return source?.title || firstLine(session.objective, 96) || session.session_id;
}

function parseSource(sourceJson: string | null | undefined): WorkItem | undefined {
  if (!sourceJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(sourceJson) as WorkItem;
    return typeof parsed?.source === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function leaseForSession(leases: WorkspaceLease[], session: SessionRow): WorkspaceLease | undefined {
  if (session.workspace_lease_id) {
    const direct = leases.find((lease) => lease.lease_id === session.workspace_lease_id);
    if (direct) {
      return direct;
    }
  }
  return leases.find((lease) => lease.session_id === session.session_id);
}

function ownerFromWorkers(workers: WorkerRecord[]): string {
  const running = workers.find((worker) => worker.status === "running" || worker.status === "pending") ?? workers[0];
  return running?.display_name ?? "main_swarm";
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function firstLine(value: string, max: number): string {
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line;
}

function isActiveSessionStatus(status: SwarmSession["status"]): boolean {
  return status === "created" || status === "planning" || status === "running" || status === "reviewing" || status === "aggregating";
}

function inboxRank(item: CaseWorkbenchInboxItem): number {
  switch (item.kind) {
    case "approval":
      return 10;
    case "blocked_worker":
      return 20;
    case "failed_worker":
      return 25;
    case "failed_attempt":
      return 30;
    case "handoff":
      return 40;
    case "no_workspace":
      return 50;
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(Math.floor(value ?? fallback), 500));
}
