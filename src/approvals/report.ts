import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ApprovalRecord, ApprovalStatus } from "../storage/approval-store.js";
import { resolveSessionSelector } from "../sessions/report.js";

export type ApprovalSelectorResolution = {
  approvalId?: string;
  error?: string;
};

export type ApprovalCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export function buildApprovalListReport(
  runtime: SwarmRuntime,
  options: {
    limit?: number;
    sessionSelector?: string;
    status?: ApprovalStatus;
  } = {}
): ApprovalCliReport {
  const limit = normalizeLimit(options.limit, 40);
  const sessionResolution = options.sessionSelector
    ? resolveSessionSelector(runtime, options.sessionSelector)
    : {};
  if (options.sessionSelector && !sessionResolution.sessionId) {
    throw new Error(sessionResolution.error ?? `Unknown session: ${options.sessionSelector}`);
  }
  const sessionId = sessionResolution.sessionId;
  const sessionIds = sessionId ? runtime.listSessionFamilySessionIds(sessionId, 1_000) : undefined;
  const approvals = approvalStatusFilter(
    sessionId
      ? runtime.listApprovalsForSessionFamily(sessionId, limit)
      : runtime.listRecentApprovalsForWorkspace(limit),
    options.status
  );
  const summary = summarizeApprovals(approvals);
  const lines = [
    "Swarm Approvals",
    `workspace=${runtime.getWorkspacePath()}`,
    [
      `summary approvals=${summary.total}`,
      `pending=${summary.pending}`,
      `approved=${summary.approved}`,
      `denied=${summary.denied}`,
      sessionId ? `session=${sessionId}` : undefined,
      options.status ? `status_filter=${options.status}` : undefined
    ].filter(Boolean).join(" "),
    ""
  ];
  if (!approvals.length) {
    lines.push(sessionId
      ? `No approvals recorded for session family ${sessionId}.`
      : "No approvals recorded for this workspace.");
  } else {
    for (const approval of approvals) {
      lines.push(formatApprovalSummaryLine(approval));
      lines.push(`  session=${approval.session_id ?? "-"} task=${approval.task_id ?? "-"} action=${approval.action} target=${truncateText(approval.target, 96)}`);
      if (approval.challenge.permission_name || approval.challenge.permission_rule) {
        lines.push([
          approval.challenge.permission_name ? `  permission=${approval.challenge.permission_name}` : undefined,
          approval.challenge.permission_rule ? `rule=${approval.challenge.permission_rule}` : undefined
        ].filter(Boolean).join(" "));
      }
    }
    lines.push("");
    lines.push("Use `swarm approvals show <approval_id>` to inspect one record or `swarm approvals approve|deny <approval_id>` to answer a live approval through the Gateway.");
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      session_id: sessionId,
      session_ids: sessionIds,
      status_filter: options.status,
      summary,
      approvals
    }
  };
}

export function buildApprovalDetailReport(
  runtime: SwarmRuntime,
  selector?: string,
  options: {
    pendingOnly?: boolean;
    sessionSelector?: string;
  } = {}
): ApprovalCliReport {
  const resolution = resolveApprovalSelector(runtime, selector, options);
  if (!resolution.approvalId) {
    throw new Error(resolution.error ?? `Unknown approval: ${selector ?? "(missing)"}`);
  }
  const approval = runtime.approvalStore.get(resolution.approvalId);
  if (!approval) {
    throw new Error(`Unknown approval: ${resolution.approvalId}`);
  }
  return {
    detail: formatApprovalDetail(approval),
    data: {
      workspace: runtime.getWorkspacePath(),
      approval
    }
  };
}

export function decideApprovalLocally(
  runtime: SwarmRuntime,
  selector: string,
  options: {
    approved: boolean;
    sessionSelector?: string;
  }
): ApprovalCliReport {
  const resolution = resolveApprovalSelector(runtime, selector, {
    sessionSelector: options.sessionSelector,
    pendingOnly: true
  });
  if (!resolution.approvalId) {
    throw new Error(resolution.error ?? `Unknown pending approval: ${selector}`);
  }
  const previous = runtime.approvalStore.get(resolution.approvalId);
  if (!previous) {
    throw new Error(`Unknown approval: ${resolution.approvalId}`);
  }
  if (previous.status !== "pending") {
    throw new Error(`Approval is not pending: ${resolution.approvalId} current_status=${previous.status}`);
  }
  const status: ApprovalStatus = options.approved ? "approved" : "denied";
  const approval = runtime.approvalStore.updateStatus(resolution.approvalId, status);
  if (!approval) {
    throw new Error(`Failed to update approval: ${resolution.approvalId}`);
  }
  return {
    detail: [
      "Swarm Approval Decision",
      `approval=${approval.approval_id}`,
      `status=${approval.status}`,
      approval.session_id ? `session=${approval.session_id}` : undefined,
      "source=local-store"
    ].filter(Boolean).join("\n"),
    data: {
      action: options.approved ? "approve" : "deny",
      source: "local-store",
      workspace: runtime.getWorkspacePath(),
      approval_id: approval.approval_id,
      status: approval.status,
      session_id: approval.session_id
    }
  };
}

export function resolveApprovalSelector(
  runtime: SwarmRuntime,
  query?: string,
  options: {
    pendingOnly?: boolean;
    sessionSelector?: string;
  } = {}
): ApprovalSelectorResolution {
  const trimmed = query?.trim();
  const sessionResolution = options.sessionSelector
    ? resolveSessionSelector(runtime, options.sessionSelector)
    : {};
  if (options.sessionSelector && !sessionResolution.sessionId) {
    return { error: sessionResolution.error ?? `Unknown session: ${options.sessionSelector}` };
  }
  const sessionId = sessionResolution.sessionId;
  const baseRows = sessionId
    ? runtime.listApprovalsForSessionFamily(sessionId, 200)
    : runtime.listRecentApprovalsForWorkspace(200);
  const rows = options.pendingOnly ? baseRows.filter((approval) => approval.status === "pending") : baseRows;
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return rows[0]
      ? { approvalId: rows[0].approval_id }
      : { error: options.pendingOnly ? "No pending approval found for this workspace." : "No approval found for this workspace." };
  }
  const exact = runtime.approvalStore.get(trimmed);
  if (exact && baseRows.some((approval) => approval.approval_id === exact.approval_id)) {
    return { approvalId: exact.approval_id };
  }
  const normalized = trimmed.toLowerCase();
  const prefixMatches = rows.filter((approval) => approval.approval_id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { approvalId: prefixMatches[0].approval_id };
  }
  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous approval selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((approval) => approval.approval_id).join(", ")}`
    };
  }
  const fuzzyMatches = rows.filter((approval) =>
    approval.approval_id.toLowerCase().includes(normalized)
    || approval.summary.toLowerCase().includes(normalized)
    || approval.target.toLowerCase().includes(normalized)
    || (approval.session_id?.toLowerCase().includes(normalized) ?? false)
  );
  if (fuzzyMatches.length === 1) {
    return { approvalId: fuzzyMatches[0].approval_id };
  }
  if (fuzzyMatches.length > 1) {
    return {
      error: `Ambiguous approval selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((approval) => approval.approval_id).join(", ")}`
    };
  }
  return { error: `Unknown approval: ${trimmed}` };
}

export function parseApprovalStatus(value?: string): ApprovalStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "pending" || normalized === "approved" || normalized === "denied") {
    return normalized;
  }
  throw new Error("Approval status must be pending, approved, or denied.");
}

export function formatApprovalDetail(approval: ApprovalRecord): string {
  return [
    "Swarm Approval",
    `${approval.approval_id} [${approval.status}] ${approval.risk_class}/${approval.risk}`,
    `session=${approval.session_id ?? "-"} task=${approval.task_id ?? "-"}`,
    `action=${approval.action} target=${approval.target}`,
    approval.summary,
    `why=${approval.challenge.why_now}`,
    approval.challenge.permission_name ? `permission=${approval.challenge.permission_name}` : undefined,
    approval.challenge.permission_rule ? `rule=${approval.challenge.permission_rule}` : undefined,
    approval.challenge.attention_note ? `attention=${approval.challenge.attention_note}` : undefined,
    `impact=${approval.challenge.predicted_impact}`,
    `rollback=${approval.challenge.rollback_plan}`,
    approval.challenge.summary_diff ? `diff=\n${approval.challenge.summary_diff}` : undefined
  ].filter(Boolean).join("\n");
}

function formatApprovalSummaryLine(approval: ApprovalRecord): string {
  return `${approval.updated_at} [${approval.status}/${approval.risk_class}] ${approval.approval_id} ${truncateText(approval.summary, 108)}`;
}

function summarizeApprovals(approvals: ApprovalRecord[]): {
  total: number;
  pending: number;
  approved: number;
  denied: number;
} {
  return {
    total: approvals.length,
    pending: approvals.filter((approval) => approval.status === "pending").length,
    approved: approvals.filter((approval) => approval.status === "approved").length,
    denied: approvals.filter((approval) => approval.status === "denied").length
  };
}

function approvalStatusFilter(approvals: ApprovalRecord[], status?: ApprovalStatus): ApprovalRecord[] {
  return status ? approvals.filter((approval) => approval.status === status) : approvals;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
