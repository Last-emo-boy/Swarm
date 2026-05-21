import type { ApprovalRecord, ApprovalStatus } from "../storage/approval-store.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { gatewayClientAuthHeaders } from "../server/gateway-auth.js";
import { formatApprovalDetail } from "./report.js";

export type ApprovalQueueView = {
  session_id?: string;
  session_ids?: string[];
  pending_requests: ToolApprovalRequest[];
  actionable_approval_ids: string[];
  approvals: ApprovalRecord[];
  summary: {
    actionable_pending: number;
    persisted_pending: number;
    approved: number;
    denied: number;
  };
};

export type ApprovalGatewayDetail = {
  approval: ApprovalRecord;
  actionable: boolean;
  pending_request?: ToolApprovalRequest;
  gateway_pending_created_at?: string;
};

export type ApprovalGatewayReport = {
  detail: string;
  data: Record<string, unknown>;
};

export class ApprovalGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly gatewayUrl: string,
    readonly approvalId?: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export async function listApprovalsViaGateway(input: {
  gatewayUrl?: string;
  sessionId?: string;
  limit?: number;
  status?: ApprovalStatus;
}): Promise<ApprovalGatewayReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await getGatewayJson(gatewayUrl, approvalListPath(input.sessionId, input.limit));
  const view = approvalQueueValue(payload);
  if (!view) {
    throw new ApprovalGatewayError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 200, gatewayUrl, undefined, payload);
  }
  const approvals = input.status
    ? view.approvals.filter((approval) => approval.status === input.status)
    : view.approvals;
  const lines = [
    "Swarm Approvals",
    `gateway=${gatewayUrl}`,
    [
      `summary approvals=${approvals.length}`,
      `actionable_pending=${view.summary.actionable_pending}`,
      `persisted_pending=${view.summary.persisted_pending}`,
      `approved=${view.summary.approved}`,
      `denied=${view.summary.denied}`,
      view.session_id ? `session=${view.session_id}` : undefined,
      input.status ? `status_filter=${input.status}` : undefined
    ].filter(Boolean).join(" "),
    ""
  ];
  if (view.pending_requests.length) {
    lines.push("Actionable");
    for (const request of view.pending_requests) {
      lines.push(`${request.id} [pending/${request.risk_class}] ${request.summary}`);
      lines.push([
        `  session=${request.session_id ?? "-"} task=${request.task_id ?? "-"} action=${request.action} target=${request.target}`,
        request.permission_name ? `permission=${request.permission_name}` : undefined,
        request.permission_rule ? `rule=${request.permission_rule}` : undefined
      ].filter(Boolean).join(" "));
    }
    lines.push("");
  }
  if (!approvals.length) {
    lines.push(view.session_id
      ? `No approvals recorded for session family ${view.session_id}.`
      : "No approvals recorded through this Gateway.");
  } else {
    lines.push("Persisted");
    for (const approval of approvals) {
      lines.push(`${approval.updated_at} [${approval.status}/${approval.risk_class}] ${approval.approval_id} ${truncateText(approval.summary, 108)}`);
      lines.push(`  session=${approval.session_id ?? "-"} task=${approval.task_id ?? "-"} action=${approval.action} target=${truncateText(approval.target, 96)}`);
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      gateway_url: gatewayUrl,
      status_filter: input.status,
      ...view,
      approvals
    }
  };
}

export async function showApprovalViaGateway(input: {
  gatewayUrl?: string;
  approvalId: string;
}): Promise<ApprovalGatewayReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await getGatewayJson(gatewayUrl, `/v1/approvals/${encodeURIComponent(input.approvalId)}`);
  const detail = approvalDetailValue(payload);
  if (!detail) {
    throw new ApprovalGatewayError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 200, gatewayUrl, input.approvalId, payload);
  }
  return {
    detail: [
      formatApprovalDetail(detail.approval),
      `actionable=${detail.actionable ? "yes" : "no"}`,
      detail.gateway_pending_created_at ? `gateway_pending_created_at=${detail.gateway_pending_created_at}` : undefined
    ].filter(Boolean).join("\n"),
    data: {
      gateway_url: gatewayUrl,
      ...detail
    }
  };
}

export async function decideApprovalViaGateway(input: {
  gatewayUrl?: string;
  approvalId: string;
  approved: boolean;
}): Promise<ApprovalGatewayReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await postGatewayJson(gatewayUrl, `/v1/approvals/${encodeURIComponent(input.approvalId)}/decision`, {
    approved: input.approved
  });
  const record = recordValue(payload);
  const approvalId = stringValue(record?.approval_id);
  const status = stringValue(record?.status);
  const sessionId = stringValue(record?.session_id);
  if (!approvalId || !status) {
    throw new ApprovalGatewayError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 200, gatewayUrl, input.approvalId, payload);
  }
  return {
    detail: [
      "Swarm Approval Decision",
      `gateway=${gatewayUrl}`,
      `approval=${approvalId}`,
      `status=${status}`,
      sessionId ? `session=${sessionId}` : undefined
    ].filter(Boolean).join("\n"),
    data: {
      action: input.approved ? "approve" : "deny",
      gateway_url: gatewayUrl,
      approval_id: approvalId,
      status,
      session_id: sessionId
    }
  };
}

export function isApprovalGatewayError(error: unknown): error is ApprovalGatewayError {
  return error instanceof ApprovalGatewayError;
}

function resolveGatewayUrl(value?: string): string {
  const fallback = process.env.SWARM_GATEWAY_URL?.trim() || "http://127.0.0.1:38171";
  const resolved = (value?.trim() || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`Invalid gateway URL: ${resolved}`);
  }
  return resolved;
}

function approvalListPath(sessionId?: string, limit?: number): string {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set("session_id", sessionId);
  }
  if (Number.isFinite(limit) && (limit ?? 0) > 0) {
    params.set("limit", String(Math.floor(limit as number)));
  }
  const query = params.toString();
  return query ? `/v1/approvals?${query}` : "/v1/approvals";
}

async function getGatewayJson(gatewayUrl: string, path: string): Promise<unknown> {
  const url = `${gatewayUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApprovalGatewayError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      undefined,
      gatewayUrl
    );
  }
  const payload = await readGatewayJson(response);
  if (!response.ok) {
    throw new ApprovalGatewayError(gatewayErrorMessage(payload, response.status), response.status, gatewayUrl, undefined, payload);
  }
  return payload;
}

async function postGatewayJson(gatewayUrl: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${gatewayUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...gatewayClientAuthHeaders() },
      body: JSON.stringify(body)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApprovalGatewayError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      undefined,
      gatewayUrl
    );
  }
  const payload = await readGatewayJson(response);
  if (!response.ok) {
    throw new ApprovalGatewayError(gatewayErrorMessage(payload, response.status), response.status, gatewayUrl, undefined, payload);
  }
  return payload;
}

async function readGatewayJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function gatewayErrorMessage(payload: unknown, status: number): string {
  const record = recordValue(payload);
  const nested = recordValue(record?.error);
  return stringValue(nested?.message)
    ?? stringValue(record?.message)
    ?? `Swarm Gateway request failed with HTTP ${status}.`;
}

function approvalQueueValue(value: unknown): ApprovalQueueView | undefined {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.approvals) || !Array.isArray(record.pending_requests) || !recordValue(record.summary)) {
    return undefined;
  }
  return record as unknown as ApprovalQueueView;
}

function approvalDetailValue(value: unknown): ApprovalGatewayDetail | undefined {
  const record = recordValue(value);
  if (!record || !recordValue(record.approval) || typeof record.actionable !== "boolean") {
    return undefined;
  }
  return record as unknown as ApprovalGatewayDetail;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
