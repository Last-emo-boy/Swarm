import { gatewayClientAuthHeaders } from "../server/gateway-auth.js";

export type SessionGatewayControlReport = {
  detail: string;
  data: Record<string, unknown>;
};

type SessionGatewayRoute = "messages" | "interrupt" | "execute" | "fork";

type GatewayControlDecision = {
  message_id?: string;
  action?: string;
  reason?: string;
  instruction?: string;
};

export class SessionGatewayControlError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly gatewayUrl: string,
    readonly sessionId?: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export async function sendSessionReplyViaGateway(input: {
  gatewayUrl?: string;
  sessionId: string;
  message: string;
  requestId?: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const body = await postGatewaySessionControl(gatewayUrl, input.sessionId, "messages", {
    content: input.message,
    request_id: input.requestId
  });
  return {
    detail: [
      "Swarm Session Reply",
      `gateway=${gatewayUrl}`,
      `session=${body.session_id}`,
      `route=${body.route}`,
      `status=${body.status}`,
      body.request_id ? `request_id=${body.request_id}${body.duplicate ? " duplicate=true" : ""}` : undefined,
      formatControlDetail(body.control),
      `message=${input.message}`
    ].filter(Boolean).join("\n"),
    data: {
      action: "reply",
      gateway_url: gatewayUrl,
      session_id: body.session_id,
      route: body.route,
      status: body.status,
      request_id: body.request_id,
      duplicate: body.duplicate,
      control: body.control,
      message: input.message
    }
  };
}

export async function sendSessionInterruptViaGateway(input: {
  gatewayUrl?: string;
  sessionId: string;
  message?: string;
  requestId?: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = {
    ...(input.message ? { content: input.message } : {}),
    ...(input.requestId ? { request_id: input.requestId } : {})
  };
  const body = await postGatewaySessionControl(gatewayUrl, input.sessionId, "interrupt", payload);
  return {
    detail: [
      "Swarm Session Interrupt",
      `gateway=${gatewayUrl}`,
      `session=${body.session_id}`,
      `route=${body.route}`,
      `status=${body.status}`,
      body.request_id ? `request_id=${body.request_id}${body.duplicate ? " duplicate=true" : ""}` : undefined,
      formatControlDetail(body.control),
      input.message ? `message=${input.message}` : undefined
    ].filter(Boolean).join("\n"),
    data: {
      action: "interrupt",
      gateway_url: gatewayUrl,
      session_id: body.session_id,
      route: body.route,
      status: body.status,
      request_id: body.request_id,
      duplicate: body.duplicate,
      control: body.control,
      message: input.message
    }
  };
}

export async function sendActiveReplyViaGateway(input: {
  gatewayUrl?: string;
  message: string;
  requestId?: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const body = await postGatewayLiveControl(gatewayUrl, "messages", {
    content: input.message,
    request_id: input.requestId
  });
  return {
    detail: [
      "Swarm Live Reply",
      `gateway=${gatewayUrl}`,
      `session=${body.session_id}`,
      `route=${body.route}`,
      `status=${body.status}`,
      body.request_id ? `request_id=${body.request_id}${body.duplicate ? " duplicate=true" : ""}` : undefined,
      formatControlDetail(body.control),
      `message=${input.message}`
    ].filter(Boolean).join("\n"),
    data: {
      action: "reply",
      gateway_url: gatewayUrl,
      session_id: body.session_id,
      route: body.route,
      status: body.status,
      request_id: body.request_id,
      duplicate: body.duplicate,
      control: body.control,
      message: input.message
    }
  };
}

export async function sendActiveInterruptViaGateway(input: {
  gatewayUrl?: string;
  message?: string;
  requestId?: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = {
    ...(input.message ? { content: input.message } : {}),
    ...(input.requestId ? { request_id: input.requestId } : {})
  };
  const body = await postGatewayLiveControl(gatewayUrl, "interrupt", payload);
  return {
    detail: [
      "Swarm Live Interrupt",
      `gateway=${gatewayUrl}`,
      `session=${body.session_id}`,
      `route=${body.route}`,
      `status=${body.status}`,
      body.request_id ? `request_id=${body.request_id}${body.duplicate ? " duplicate=true" : ""}` : undefined,
      formatControlDetail(body.control),
      input.message ? `message=${input.message}` : undefined
    ].filter(Boolean).join("\n"),
    data: {
      action: "interrupt",
      gateway_url: gatewayUrl,
      session_id: body.session_id,
      route: body.route,
      status: body.status,
      request_id: body.request_id,
      duplicate: body.duplicate,
      control: body.control,
      message: input.message
    }
  };
}

export async function readActiveLiveStatusViaGateway(input: {
  gatewayUrl?: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await getGatewayJson(gatewayUrl, "/v1/live");
  const record = recordValue(payload);
  const activeTarget = recordValue(record?.active_target);
  const controls = recordValue(record?.controls);
  const sessionId = stringValue(activeTarget?.session_id);
  const route = stringValue(activeTarget?.route);
  if (!sessionId || !route) {
    return {
      detail: [
        "Swarm Live",
        `gateway=${gatewayUrl}`,
        "status=idle",
        "",
        "No active Gateway-controlled run.",
        "Use `swarm run ...`, `swarm sessions execute ...`, or `swarm sessions resume ...` to create one."
      ].join("\n"),
      data: {
        action: "live",
        gateway_url: gatewayUrl,
        status: "idle",
        active_target: null,
        controls: {
          reply: booleanValue(controls?.reply),
          interrupt: booleanValue(controls?.interrupt)
        }
      }
    };
  }

  const session = liveSessionSummaryFromGatewayRecord(recordValue(record?.session))
    ?? await readGatewayLiveSessionSummary(gatewayUrl, sessionId);
  const sessionSummary = session
    ? [
        `session_status=${session.status}`,
        session.objective ? `objective=${session.objective}` : undefined,
        `workers=${session.activeWorkers}${session.resumableWorkers > 0 ? `+${session.resumableWorkers} resumable` : ""}`,
        `handoffs=${session.activeHandoffs}`,
        `pending_approvals=${session.pendingApprovals}`,
        `changed_files=${session.changedFiles}`,
        `checks=${session.checks}`
      ].filter(Boolean).join(" ")
    : "session_status=unavailable";

  return {
    detail: [
      "Swarm Live",
      `gateway=${gatewayUrl}`,
      "status=active",
      `session=${sessionId}`,
      `route=${route}`,
      sessionSummary
    ].join("\n"),
    data: {
      action: "live",
      gateway_url: gatewayUrl,
      status: "active",
      active_target: {
        session_id: sessionId,
        route
      },
      controls: {
        reply: booleanValue(controls?.reply, true),
        interrupt: booleanValue(controls?.interrupt, true)
      },
      session: session
        ? {
            session_id: sessionId,
            status: session.status,
            objective: session.objective,
            active_workers: session.activeWorkers,
            resumable_workers: session.resumableWorkers,
            active_handoffs: session.activeHandoffs,
            pending_approvals: session.pendingApprovals,
            changed_files: session.changedFiles,
            checks: session.checks
          }
        : undefined
    }
  };
}

export async function sendSessionExecuteViaGateway(input: {
  gatewayUrl?: string;
  sessionId: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await postGatewaySessionJson(gatewayUrl, input.sessionId, "execute", {});
  const record = recordValue(payload);
  const run = recordValue(record?.run);
  const session = recordValue(record?.session);
  const sessionId = stringValue(session?.session_id);
  const runId = stringValue(run?.run_id);
  const runStatus = stringValue(run?.status);
  if (!sessionId || !runId || !runStatus) {
    throw new SessionGatewayControlError(
      `Unexpected Swarm Gateway response from ${gatewayUrl}.`,
      202,
      gatewayUrl,
      input.sessionId,
      payload
    );
  }
  return {
    detail: [
      "Swarm Session Execute",
      `gateway=${gatewayUrl}`,
      `session=${sessionId}`,
      `run=${runId}`,
      `status=${runStatus}`
    ].join("\n"),
    data: {
      action: "execute",
      gateway_url: gatewayUrl,
      session_id: sessionId,
      run_id: runId,
      status: runStatus
    }
  };
}

export async function sendSessionForkViaGateway(input: {
  gatewayUrl?: string;
  sessionId: string;
  message?: string;
}): Promise<SessionGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await postGatewaySessionJson(gatewayUrl, input.sessionId, "fork", input.message ? { message: input.message } : {});
  const record = recordValue(payload);
  const session = recordValue(record?.session);
  const plan = recordValue(record?.plan);
  const forkedSessionId = stringValue(session?.session_id);
  const objective = stringValue(session?.objective);
  if (!forkedSessionId || !objective || !plan) {
    throw new SessionGatewayControlError(
      `Unexpected Swarm Gateway response from ${gatewayUrl}.`,
      201,
      gatewayUrl,
      input.sessionId,
      payload
    );
  }
  return {
    detail: [
      "Swarm Session Fork",
      `gateway=${gatewayUrl}`,
      `source_session=${input.sessionId}`,
      `session=${forkedSessionId}`,
      "stored_plan=yes",
      input.message ? `message=${input.message}` : undefined
    ].filter(Boolean).join("\n"),
    data: {
      action: "fork",
      gateway_url: gatewayUrl,
      source_session_id: input.sessionId,
      session_id: forkedSessionId,
      objective,
      has_stored_plan: true,
      message: input.message
    }
  };
}

export function isSessionGatewayControlError(error: unknown): error is SessionGatewayControlError {
  return error instanceof SessionGatewayControlError;
}

function resolveGatewayUrl(value?: string): string {
  const fallback = process.env.SWARM_GATEWAY_URL?.trim() || "http://127.0.0.1:38171";
  const resolved = (value?.trim() || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`Invalid gateway URL: ${resolved}`);
  }
  return resolved;
}

async function postGatewaySessionControl(
  gatewayUrl: string,
  sessionId: string,
  action: "messages" | "interrupt",
  body: Record<string, unknown>
): Promise<{ status: string; session_id: string; route: string; request_id?: string; duplicate?: boolean; control?: GatewayControlDecision }> {
  const payload = await postGatewaySessionJson(gatewayUrl, sessionId, action, body);
  return gatewayControlPayload(payload, gatewayUrl, sessionId);
}

async function postGatewayLiveControl(
  gatewayUrl: string,
  action: "messages" | "interrupt",
  body: Record<string, unknown>
): Promise<{ status: string; session_id: string; route: string; request_id?: string; duplicate?: boolean; control?: GatewayControlDecision }> {
  const payload = await postGatewayJson(gatewayUrl, `/v1/live/${action}`, body);
  return gatewayControlPayload(payload, gatewayUrl);
}

function gatewayControlPayload(
  payload: unknown,
  gatewayUrl: string,
  sessionId?: string
): { status: string; session_id: string; route: string; request_id?: string; duplicate?: boolean; control?: GatewayControlDecision } {
  const record = recordValue(payload);
  const status = stringValue(record?.status);
  const appliedSessionId = stringValue(record?.session_id);
  const route = stringValue(record?.route);
  if (!status || !appliedSessionId || !route) {
    throw new SessionGatewayControlError(
      `Unexpected Swarm Gateway response from ${gatewayUrl}.`,
      200,
      gatewayUrl,
      sessionId,
      payload
    );
  }
  return {
    status,
    session_id: appliedSessionId,
    route,
    request_id: stringValue(record?.request_id ?? record?.requestId),
    duplicate: booleanValue(record?.duplicate),
    control: controlDecisionFromRecord(recordValue(record?.control))
  };
}

function controlDecisionFromRecord(record: Record<string, unknown> | undefined): GatewayControlDecision | undefined {
  if (!record) {
    return undefined;
  }
  const action = stringValue(record.action);
  const reason = stringValue(record.reason);
  const instruction = stringValue(record.instruction);
  const messageId = stringValue(record.message_id);
  if (!action && !reason && !instruction && !messageId) {
    return undefined;
  }
  return {
    message_id: messageId,
    action,
    reason,
    instruction
  };
}

function formatControlDetail(control: GatewayControlDecision | undefined): string | undefined {
  if (!control?.action) {
    return undefined;
  }
  return `control=${control.action}${control.reason ? ` reason=${control.reason}` : ""}`;
}

async function postGatewaySessionJson(
  gatewayUrl: string,
  sessionId: string,
  action: SessionGatewayRoute,
  body: Record<string, unknown>
): Promise<unknown> {
  return postGatewayJson(gatewayUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/${action}`, body, sessionId);
}

async function postGatewayJson(
  gatewayUrl: string,
  path: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<unknown> {
  return requestGatewayJson(gatewayUrl, path, {
    method: "POST",
    body
  }, sessionId);
}

async function getGatewayJson(
  gatewayUrl: string,
  path: string,
  sessionId?: string
): Promise<unknown> {
  return requestGatewayJson(gatewayUrl, path, {
    method: "GET"
  }, sessionId);
}

async function requestGatewayJson(
  gatewayUrl: string,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
  },
  sessionId?: string
): Promise<unknown> {
  const url = `${gatewayUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.method === "POST" ? { "content-type": "application/json", ...gatewayClientAuthHeaders() } : undefined,
      body: init.method === "POST" ? JSON.stringify(init.body ?? {}) : undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SessionGatewayControlError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      undefined,
      gatewayUrl,
      sessionId
    );
  }
  const payload = await readGatewayJson(response);
  if (!response.ok) {
    throw new SessionGatewayControlError(
      gatewayErrorMessage(payload, response.status),
      response.status,
      gatewayUrl,
      sessionId,
      payload
    );
  }
  return payload;
}

async function readGatewayLiveSessionSummary(
  gatewayUrl: string,
  sessionId: string
): Promise<{
  status: string;
  objective?: string;
  activeWorkers: number;
  resumableWorkers: number;
  activeHandoffs: number;
  pendingApprovals: number;
  changedFiles: number;
  checks: number;
} | undefined> {
  try {
    const payload = await getGatewayJson(gatewayUrl, `/v1/sessions/${encodeURIComponent(sessionId)}`, sessionId);
    return liveSessionSummaryFromGatewayRecord(recordValue(payload));
  } catch (error) {
    if (error instanceof SessionGatewayControlError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function liveSessionSummaryFromGatewayRecord(record: Record<string, unknown> | undefined): {
  status: string;
  objective?: string;
  activeWorkers: number;
  resumableWorkers: number;
  activeHandoffs: number;
  pendingApprovals: number;
  changedFiles: number;
  checks: number;
} | undefined {
  const status = stringValue(record?.status);
  if (!record || !status) {
    return undefined;
  }
  const workContracts = recordValue(record.work_contracts);
  const workSummary = recordValue(workContracts?.summary);
  const approvals = recordValue(record.approvals);
  const approvalSummary = recordValue(approvals?.summary);
  const workSnapshot = recordValue(record.work_snapshot);
  return {
    status,
    objective: stringValue(record.objective),
    activeWorkers: numberValue(workSummary?.active_workers),
    resumableWorkers: numberValue(workSummary?.resumable_workers),
    activeHandoffs: numberValue(workSummary?.active_handoffs),
    pendingApprovals: numberValue(approvalSummary?.actionable_pending) + numberValue(approvalSummary?.persisted_pending),
    changedFiles: arrayLength(workSnapshot?.changed_files),
    checks: arrayLength(workSnapshot?.checks)
  };
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
