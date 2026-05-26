import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";

test("Gateway approval routes list, inspect, and decide a live actionable approval", async () => {
  const fixture = createFixture();
  const oldToken = process.env.SWARM_GATEWAY_TOKEN;
  delete process.env.SWARM_GATEWAY_TOKEN;

  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspace,
    databasePath: fixture.databasePath
  });

  try {
    configureApprovalFixture(server);
    const started = await server.start();
    const invokePromise = invokeWriteCapability(started.url, {
      path: "approved.txt",
      content: "approved through gateway\n"
    });

    const pendingQueue = await waitForApprovalQueue(started.url, "gateway-approval-session", (queue) =>
      queue.summary.actionable_pending === 1 && queue.actionable_approval_ids.length === 1
    );
    const approvalId = pendingQueue.actionable_approval_ids[0];
    assert(approvalId, "Expected one actionable approval id.");
    assert.equal(pendingQueue.pending_requests[0]?.id, approvalId);
    assert.equal(pendingQueue.pending_requests[0]?.action, "file.write");
    assert.equal(pendingQueue.pending_requests[0]?.permission_name, "Write");
    assert.equal(pendingQueue.pending_requests[0]?.permission_decision, "ask");
    assert.equal(pendingQueue.pending_requests[0]?.governance?.actor_binding.actor_id, "gateway.local");
    assert.equal(pendingQueue.pending_requests[0]?.governance?.actor_binding.session_id, "gateway-approval-session");
    assert.equal(pendingQueue.pending_requests[0]?.governance?.scope.actions.includes("file.write"), true);
    assert(pendingQueue.approvals.some((approval) =>
      approval.approval_id === approvalId && approval.status === "pending"
    ));

    const detail = await readJson<ApprovalDetailPayload>(`${started.url}/v1/approvals/${encodeURIComponent(approvalId)}`);
    assert.equal(detail.actionable, true);
    assert.equal(detail.approval.approval_id, approvalId);
    assert.equal(detail.approval.status, "pending");
    assert.equal(detail.pending_request?.id, approvalId);
    assert.equal(typeof detail.gateway_pending_created_at, "string");

    const unauthenticatedDecision = await postJson<GatewayErrorPayload>(
      `${started.url}/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      { approved: true },
      { "content-type": "application/json" },
      false
    );
    assert.equal(unauthenticatedDecision.status, 403);
    assert.match(unauthenticatedDecision.body.error?.message ?? "", /Gateway mutation requires/);

    const decision = await postJson<ApprovalDecisionPayload>(
      `${started.url}/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      { approved: true, correlation_id: "corr-approval-decision-1" }
    );
    assert.equal(decision.status, 200);
    assert.deepEqual(decision.body, {
      approval_id: approvalId,
      status: "approved",
      session_id: "gateway-approval-session"
    });
    const trace = server.runtime.traceStore.list("gateway-approval-session");
    const envelope = trace.find((item) => item.intent === "gateway.approval.decision");
    assert(envelope, "missing gateway approval decision envelope");
    assert.equal(envelope.from.agent_id, "gateway.local");
    assert.equal(envelope.type, "blackboard.write");
    assert.equal(envelope.correlation_id, "corr-approval-decision-1");
    assert.equal(envelope.auth?.actor, "gateway.local.control");
    assert(envelope.auth?.scopes?.includes("gateway.approval.decision"));
    assert.equal((envelope.payload as { approval_id?: string }).approval_id, approvalId);
    assert.equal((envelope.payload as { decision?: string }).decision, "approved");
    const grantEnvelope = trace.find((item) => item.type === "approval.grant" && (item.payload as { approval_id?: string }).approval_id === approvalId);
    assert(grantEnvelope, "missing approval grant envelope");
    assert.equal(grantEnvelope.from.agent_id, "gateway.local");
    assert.equal(grantEnvelope.correlation_id, "corr-approval-decision-1");
    assert.equal((grantEnvelope.payload as { governance?: { actor_binding?: { actor_id?: string }; scope?: { target?: string } } }).governance?.actor_binding?.actor_id, "gateway.local");
    assert.equal((grantEnvelope.payload as { governance?: { scope?: { target?: string } } }).governance?.scope?.target, "approved.txt");
    const deliveries = server.runtime.envelopeDeliveryStore.list({
      sessionId: "gateway-approval-session",
      envelopeId: envelope.id
    });
    assert(deliveries.some((delivery) =>
      delivery.status === "delivered" &&
      delivery.recipient_agent_id === "main_swarm"
    ));

    const invoke = await invokePromise;
    assert.equal(invoke.status, 200);
    assert.equal(invoke.body.result.status, "success");
    assert.match(invoke.body.result.summary, /created .* bytes at approved\.txt/);
    assert.equal(existsSync(join(fixture.workspace, "approved.txt")), true);
    assert.equal(readFileSync(join(fixture.workspace, "approved.txt"), "utf8"), "approved through gateway\n");

    const approvedDetail = await readJson<ApprovalDetailPayload>(`${started.url}/v1/approvals/${encodeURIComponent(approvalId)}`);
    assert.equal(approvedDetail.actionable, false);
    assert.equal(approvedDetail.approval.status, "approved");

    const approvedQueue = await readJson<ApprovalQueuePayload>(`${started.url}/v1/approvals?session_id=gateway-approval-session`);
    assert.equal(approvedQueue.summary.actionable_pending, 0);
    assert(approvedQueue.summary.approved >= 1);
    assert.equal(approvedQueue.actionable_approval_ids.includes(approvalId), false);

    const missingDetail = await readJson<GatewayErrorPayload>(`${started.url}/v1/approvals/approval_missing`, false);
    assert.equal(missingDetail.status, 404);
    assert.match(missingDetail.error?.message ?? "", /Unknown approval/);

    const missingDecision = await postJson<GatewayErrorPayload>(
      `${started.url}/v1/approvals/approval_missing/decision`,
      { approved: false }
    );
    assert.equal(missingDecision.status, 404);
    assert.match(missingDecision.body.error?.message ?? "", /Unknown approval/);
  } finally {
    await server.stop();
    fixture.close();
    if (oldToken === undefined) {
      delete process.env.SWARM_GATEWAY_TOKEN;
    } else {
      process.env.SWARM_GATEWAY_TOKEN = oldToken;
    }
  }
});

test("Gateway approval decision rejects persisted pending records that are not actionable", async () => {
  const fixture = createFixture();
  const oldToken = process.env.SWARM_GATEWAY_TOKEN;
  delete process.env.SWARM_GATEWAY_TOKEN;

  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspace,
    databasePath: fixture.databasePath
  });

  try {
    configureApprovalFixture(server);
    const started = await server.start();
    server.runtime.approvalStore.upsert(approvalRequest("approval_persisted_pending"), "pending");

    const response = await postJson<GatewayErrorPayload>(
      `${started.url}/v1/approvals/approval_persisted_pending/decision`,
      { approved: true }
    );
    assert.equal(response.status, 409);
    assert.match(response.body.error?.message ?? "", /not actionable in this gateway process/);
  } finally {
    await server.stop();
    fixture.close();
    if (oldToken === undefined) {
      delete process.env.SWARM_GATEWAY_TOKEN;
    } else {
      process.env.SWARM_GATEWAY_TOKEN = oldToken;
    }
  }
});

type Fixture = {
  root: string;
  workspace: string;
  databasePath: string;
  close(): void;
};

type ApprovalQueuePayload = {
  session_id?: string;
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

type ApprovalDetailPayload = {
  approval: ApprovalRecord;
  actionable: boolean;
  pending_request?: ToolApprovalRequest;
  gateway_pending_created_at?: string;
};

type ApprovalDecisionPayload = {
  approval_id: string;
  status: "approved" | "denied";
  session_id?: string;
};

type CapabilityInvokePayload = {
  result: ToolResult;
};

type GatewayErrorPayload = {
  error?: {
    message?: string;
    status?: number;
  };
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-gateway-approvals-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function configureApprovalFixture(server: SwarmGatewayServer): void {
  server.runtime.settings.tools.directWrite = true;
  server.runtime.settings.permissions.defaultMode = "ask";
  server.runtime.settings.permissions.allow = ["Read(**)", "LS(**)", "Grep(**)", "Glob(**)", "Stat(**)", "WebSearch(*)"];
  server.runtime.settings.permissions.ask = ["Write(**)"];
  server.runtime.settings.permissions.deny = [];
}

function invokeWriteCapability(gatewayUrl: string, args: { path: string; content: string }): Promise<HttpJsonResponse<CapabilityInvokePayload>> {
  return postJson<CapabilityInvokePayload>(`${gatewayUrl}/v1/capabilities/local_tool.Write/invoke`, {
    session_id: "gateway-approval-session",
    task_id: "gateway-approval-task",
    args
  });
}

async function waitForApprovalQueue(
  gatewayUrl: string,
  sessionId: string,
  predicate: (queue: ApprovalQueuePayload) => boolean,
  timeoutMs = 5_000
): Promise<ApprovalQueuePayload> {
  const start = Date.now();
  while (true) {
    const queue = await readJson<ApprovalQueuePayload>(`${gatewayUrl}/v1/approvals?session_id=${encodeURIComponent(sessionId)}`);
    if (predicate(queue)) {
      return queue;
    }
    if (Date.now() - start > timeoutMs) {
      assert.fail(`Timed out waiting for live approval queue. Last payload: ${JSON.stringify(queue)}`);
    }
    await delay(20);
  }
}

type HttpJsonResponse<T> = {
  status: number;
  body: T;
};

async function readJson<T>(url: string): Promise<T>;
async function readJson<T>(url: string, expectOk: false): Promise<T & { status: number }>;
async function readJson<T>(url: string, expectOk = true): Promise<T | (T & { status: number })> {
  const response = await fetch(url);
  const body = await response.json() as T;
  if (expectOk) {
    assert.equal(response.ok, true, JSON.stringify(body));
    return body;
  }
  return { ...body, status: response.status };
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "content-type": "application/json", ...gatewayClientAuthHeaders() },
  includeDefaultAuth = true
): Promise<HttpJsonResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: includeDefaultAuth
      ? { "content-type": "application/json", ...gatewayClientAuthHeaders(), ...headers }
      : headers,
    body: JSON.stringify(body)
  });
  const payload = await response.json() as T;
  return { status: response.status, body: payload };
}

function approvalRequest(id: string): ToolApprovalRequest {
  return {
    id,
    session_id: "persisted-session",
    task_id: "persisted-task",
    action: "file.write",
    summary: "Write file: persisted.txt",
    detail: "Path: persisted.txt",
    risk: "write",
    risk_class: "r1",
    target: "persisted.txt",
    why_now: "Fixture pending approval.",
    predicted_impact: "Would write a fixture file.",
    rollback_plan: "Delete the fixture file.",
    permission_decision: "ask",
    permission_reason: "Approval required by test fixture.",
    permission_mode: "ask",
    permission_name: "Write",
    permission_rule: "Write(**)"
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
