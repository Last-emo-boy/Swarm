import type { WorkSnapshot } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { buildSessionSnapshot, buildWorkspaceSnapshot } from "../server/session-view.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { SessionRow } from "../storage/session-store.js";

export type SessionSelectorResolution = {
  sessionId?: string;
  error?: string;
};

export type SessionCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export function buildSessionListReport(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
  } = {}
): SessionCliReport {
  const limit = normalizeLimit(options.limit, 20);
  const workspaceSnapshot = buildWorkspaceSnapshot(runtime, { limit });
  const sessions = runtime.listRecentSessionsForWorkspace(limit);
  const contracts = runtime.getWorkspaceContractSnapshot(limit);
  const approvals = runtime.listRecentApprovalsForWorkspace(limit);
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending").length;
  const activeLiveTarget = runtime.getActiveLiveTarget()?.session_id ?? "none";
  const lines: string[] = [
    "Swarm Sessions",
    `workspace=${runtime.getWorkspacePath()}`,
    `summary sessions=${sessions.length} active=${sessions.filter((session) => isActiveSessionStatus(session.status)).length} active_live=${activeLiveTarget} pending_approvals=${pendingApprovals} workers=${contracts.summary.active_workers + contracts.summary.resumable_workers} handoffs=${contracts.summary.active_handoffs} mcp_servers=${runtime.listMcpServers().length}`,
    ""
  ];
  if (sessions.length === 0) {
    lines.push("No persisted sessions found for this workspace.");
    lines.push("");
    lines.push("Use `swarm run ...` or `swarm chat` to create one, then inspect it with `swarm sessions show latest`.");
    return { detail: lines.join("\n"), data: workspaceSnapshot };
  }
  for (const session of sessions) {
    const snapshot = runtime.getWorkSnapshot(session.session_id);
    const approvalSummary = summarizeApprovals(runtime.listApprovalsForSessionFamily(session.session_id, 80));
    lines.push(`${session.updated_at} [${session.status}] ${session.session_id} ${truncateText(session.objective, 96)}`);
    lines.push([
      `  source=${sessionSourceLabel(snapshot)}`,
      `changed=${snapshot.changed_files.length}`,
      `checks=${snapshot.checks.length}`,
      `tasks=${snapshot.task_contracts.summary.total}`,
      `workers=${snapshot.work_contracts.summary.active_workers + snapshot.work_contracts.summary.resumable_workers}`,
      `approvals=${approvalSummary.total}`,
      approvalSummary.pending > 0 ? `pending=${approvalSummary.pending}` : undefined,
      session.plan_json ? "stored_plan=yes" : undefined,
      activeLiveTarget === session.session_id ? "live=active" : undefined
    ].filter(Boolean).join(" "));
    lines.push(`  final=${truncateText(sessionFinalSummary(session, snapshot), 116)}`);
  }
  lines.push("");
  lines.push("Use `swarm sessions show <session_id>` to inspect one session or `swarm sessions resume <session_id> <message>` to continue it.");
  return { detail: lines.join("\n"), data: workspaceSnapshot };
}

export function buildSessionDetailReport(runtime: SwarmRuntime, selector?: string): SessionCliReport {
  const resolution = resolveSessionSelector(runtime, selector);
  if (!resolution.sessionId) {
    throw new Error(resolution.error ?? `Unknown session: ${selector ?? "(missing)"}`);
  }
  const sessionId = resolution.sessionId;
  const row = runtime.sessionStore.get(sessionId);
  if (!row) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const approvals = runtime.listApprovalsForSessionFamily(sessionId, 100);
  const snapshot = runtime.getWorkSnapshot(sessionId);
  const data = {
    ...buildSessionSnapshot(runtime, sessionId),
    approvals
  };
  const activeLive = runtime.getActiveLiveTarget()?.session_id === sessionId ? "yes" : "no";
  const detail = [
    "Swarm Session",
    `created=${row.created_at} updated=${row.updated_at} stored_plan=${row.plan_json ? "yes" : "no"} parent_session=${row.parent_session_id ?? "(none)"} active_live=${activeLive}`,
    `approval_summary total=${approvals.length} pending=${approvals.filter((approval) => approval.status === "pending").length} approved=${approvals.filter((approval) => approval.status === "approved").length} denied=${approvals.filter((approval) => approval.status === "denied").length}`,
    "",
    runtime.replaySession(sessionId)
  ].join("\n");
  return { detail, data };
}

export function resolveSessionSelector(runtime: SwarmRuntime, query?: string): SessionSelectorResolution {
  const trimmed = query?.trim();
  const recent = runtime.listRecentSessionsForWorkspace(100);
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return recent[0]
      ? { sessionId: recent[0].session_id }
      : { error: "No recent session found for this workspace." };
  }
  if (runtime.sessionStore.get(trimmed)) {
    return { sessionId: trimmed };
  }
  const normalized = trimmed.toLowerCase();
  const prefixMatches = recent.filter((session) => session.session_id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { sessionId: prefixMatches[0].session_id };
  }
  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous session selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((session) => session.session_id).join(", ")}`
    };
  }
  const fuzzyMatches = recent.filter((session) => session.session_id.toLowerCase().includes(normalized)
    || session.objective.toLowerCase().includes(normalized));
  if (fuzzyMatches.length === 1) {
    return { sessionId: fuzzyMatches[0].session_id };
  }
  if (fuzzyMatches.length > 1) {
    return {
      error: `Ambiguous session selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((session) => session.session_id).join(", ")}`
    };
  }
  return { error: `Unknown session: ${trimmed}` };
}

function sessionSourceLabel(snapshot: WorkSnapshot): string {
  const source = snapshot.session.source?.source ?? "user";
  return snapshot.session.source?.human_id ? `${source}:${snapshot.session.source.human_id}` : source;
}

function sessionFinalSummary(row: SessionRow, snapshot: WorkSnapshot): string {
  return firstLine(snapshot.final_outcome?.final_summary ?? row.final_output ?? "") || "(none)";
}

function summarizeApprovals(approvals: ApprovalRecord[]): {
  total: number;
  pending: number;
} {
  return {
    total: approvals.length,
    pending: approvals.filter((approval) => approval.status === "pending").length
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

function isActiveSessionStatus(status: SessionRow["status"]): boolean {
  return status === "created" || status === "planning" || status === "running" || status === "reviewing" || status === "aggregating";
}
