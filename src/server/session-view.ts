import type { SwarmRuntime } from "../runtime/runtime.js";

export function buildSessionSnapshot(runtime: SwarmRuntime, sessionId: string): Record<string, unknown> {
  const row = runtime.sessionStore.get(sessionId);
  if (!row) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const workSnapshot = runtime.getWorkSnapshot(sessionId);
  return {
    ...row,
    policy: parseJson(row.policy_json),
    participants: parseJson(row.participants_json),
    plan: row.plan_json ? parseJson(row.plan_json) : undefined,
    graph: runtime.getTaskGraph(sessionId),
    usage_summary: runtime.usageStore.summarize(sessionId),
    work_snapshot: workSnapshot,
    task_contracts: workSnapshot.task_contracts,
    work_contracts: workSnapshot.work_contracts
  };
}

export function buildWorkspaceSnapshot(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
    approvals?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  const limit = normalizeLimit(options.limit, 20);
  const sessions = runtime.listRecentSessionsForWorkspace(limit);
  const workContracts = runtime.getWorkspaceContractSnapshot(limit);
  const approvals = options.approvals ?? buildPersistedApprovalOverview(runtime, limit);
  const approvalSummary = approvalSummaryFromView(approvals);
  const activeLiveTarget = runtime.getActiveLiveTarget() ?? null;
  return {
    workspace_path: runtime.getWorkspacePath(),
    active_live_target: activeLiveTarget,
    sessions,
    approvals,
    work_contracts: workContracts,
    mcp_servers: runtime.listMcpServers(),
    summary: {
      sessions: sessions.length,
      active_sessions: sessions.filter((session) => session.status === "created" || session.status === "running").length,
      active_live_session_id: activeLiveTarget?.session_id,
      actionable_pending_approvals: approvalSummary.actionable_pending,
      persisted_pending_approvals: approvalSummary.persisted_pending,
      total_workers: workContracts.active_workers.length + workContracts.resumable_workers.length,
      active_handoffs: workContracts.active_handoffs.length,
      mcp_servers: runtime.listMcpServers().length
    }
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildPersistedApprovalOverview(runtime: SwarmRuntime, limit: number): Record<string, unknown> {
  const approvals = runtime.listRecentApprovalsForWorkspace(limit);
  return {
    session_id: undefined,
    pending_requests: [],
    actionable_approval_ids: [],
    approvals,
    summary: {
      actionable_pending: 0,
      persisted_pending: approvals.filter((approval) => approval.status === "pending").length,
      approved: approvals.filter((approval) => approval.status === "approved").length,
      denied: approvals.filter((approval) => approval.status === "denied").length
    }
  };
}

function approvalSummaryFromView(view: Record<string, unknown>): {
  actionable_pending: number;
  persisted_pending: number;
  approved: number;
  denied: number;
} {
  const summary = recordValue(view.summary);
  return {
    actionable_pending: numberValue(summary?.actionable_pending),
    persisted_pending: numberValue(summary?.persisted_pending),
    approved: numberValue(summary?.approved),
    denied: numberValue(summary?.denied)
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}
