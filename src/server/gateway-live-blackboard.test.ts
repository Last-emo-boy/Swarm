import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BlackboardEntry, SwarmPolicy, SwarmSession, WorkItem, WorkSnapshot } from "../protocol/types.js";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";

test("Gateway live-control Blackboard projection reaches replay, resume, preflight, and session work_snapshot", async () => {
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
    const session = seedActiveFullSwarmSession(server, fixture);
    const started = await server.start();
    const content = "Stop the current worker and redirect to the operator's new instruction.";
    const requestId = "live-blackboard-interrupt-001";

    const interrupt = await postJson<InterruptPayload>(
      `${started.url}/v1/sessions/${encodeURIComponent(session.session_id)}/interrupt`,
      { content, request_id: requestId }
    );
    assert.equal(interrupt.status, 200);
    assert.equal(interrupt.body.status, "applied");
    assert.equal(interrupt.body.route, "full_swarm");
    assert.equal(interrupt.body.session_id, session.session_id);
    assert.equal(interrupt.body.request_id, requestId);
    assert.equal(interrupt.body.duplicate, false);
    assert.equal(interrupt.body.control?.message_id, requestId);
    assert.equal(interrupt.body.control?.action, "interrupt_and_redirect");
    assert.equal(interrupt.body.control?.reason, "Explicit user interrupt.");
    assert.equal(interrupt.body.control?.instruction, content);

    const duplicate = await postJson<InterruptPayload>(
      `${started.url}/v1/sessions/${encodeURIComponent(session.session_id)}/interrupt`,
      { content: "A duplicate request should be idempotent.", request_id: requestId }
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.control?.message_id, requestId);

    const trace = server.runtime.traceStore.list(session.session_id);
    const sourceEnvelope = trace.find((item) =>
      item.type === "user.message" &&
      item.intent === "source.user.message" &&
      item.correlation_id === requestId
    );
    assert(sourceEnvelope, "missing Gateway source adapter user.message envelope");
    assert.equal(sourceEnvelope.from.agent_id, "source.gateway");
    assert.equal((sourceEnvelope.payload as { schema_version?: string }).schema_version, "swarm.source_adapter.user_message.v1");
    assert.equal((sourceEnvelope.payload as { source?: string }).source, "gateway");
    assert.equal((sourceEnvelope.payload as { source_id?: string }).source_id, "http");
    assert.equal((sourceEnvelope.payload as { content?: string }).content, content);
    assert.equal((sourceEnvelope.payload as { trust_level?: string }).trust_level, "trusted");
    assert.equal((sourceEnvelope.payload as { route?: string }).route, "/v1/sessions/session-gateway-live-blackboard/interrupt");
    assert.equal(sourceEnvelope.idempotency_key, "source:gateway:user.message:live-blackboard-interrupt-001");
    const sourceAcks = trace.filter((item) =>
      item.type === "ack" &&
      item.intent === "user.message.ack" &&
      item.reply_to === sourceEnvelope.id
    );
    assert.equal(sourceAcks.length, 1);

    const gatewayEnvelope = trace.find((item) =>
      item.intent === "gateway.live.interrupt" &&
      item.correlation_id === requestId
    );
    assert(gatewayEnvelope, "missing Gateway live interrupt envelope");
    assert.equal(gatewayEnvelope.from.agent_id, "gateway.local");
    assert.equal(gatewayEnvelope.type, "task.cancel");
    assert.equal(gatewayEnvelope.auth?.actor, "gateway.local.control");
    assert(gatewayEnvelope.auth?.scopes?.includes("gateway.live.interrupt"));
    assert.equal((gatewayEnvelope.payload as { request_id?: string }).request_id, requestId);
    assert.equal((gatewayEnvelope.payload as { duplicate?: boolean }).duplicate, false);
    const deliveries = server.runtime.envelopeDeliveryStore.list({
      sessionId: session.session_id,
      envelopeId: gatewayEnvelope.id
    });
    assert(deliveries.some((delivery) =>
      delivery.status === "delivered" &&
      delivery.recipient_agent_id === "main_swarm"
    ));
    const gatewayActor = server.runtime.agentActorStore.get("gateway.local");
    assert.equal(gatewayActor?.kind, "gateway");
    assert.equal(gatewayActor?.heartbeat_state, "fresh");
    assert.equal(gatewayActor?.current_session_id, session.session_id);

    const blackboard = await readJson<BlackboardPayload>(
      `${started.url}/v1/sessions/${encodeURIComponent(session.session_id)}/blackboard`
    );
    const liveEntries = blackboard.entries.filter((entry) =>
      entry.type === "decision" && entry.key.startsWith("user.live_message.")
    );
    assert.equal(liveEntries.length, 1);
    const liveEntry = liveEntries[0];
    assert(liveEntry, "expected one Blackboard live-control decision entry");
    assert.equal(liveEntry.key, `user.live_message.${requestId}`);
    assert.equal(liveEntry.created_by.agent_id, "user");
    assert.equal(liveEntry.created_by.role, "user");
    assert.deepEqual(liveEntry.tags, ["user", "live-message"]);
    const liveValue = recordValue(liveEntry.value);
    const decision = recordValue(liveValue.decision);
    assert.equal(liveValue.content, content);
    assert.equal(decision.action, "interrupt_and_redirect");
    assert.equal(decision.reason, "Explicit user interrupt.");
    assert.equal(decision.instruction, content);

    const replay = await readJson<ReplayPayload>(
      `${started.url}/v1/sessions/${encodeURIComponent(session.session_id)}/replay`
    );
    assert.match(replay.replay, /Live Control Directives/);
    assert.match(replay.replay, new RegExp(`message_id=${escapeRegExp(requestId)}`));
    assert.match(replay.replay, /action=interrupt_and_redirect/);
    assert.match(replay.replay, /reason=Explicit user interrupt\./);
    assert(replay.replay.includes(`instruction=${content}`));
    assert(replay.replay.includes(`content=${content}`));

    const resumePrompt = server.runtime.buildResumePrompt(session.session_id, "Resume after operator interrupt.");
    assert.match(resumePrompt, /Live Control Directives/);
    assert.match(resumePrompt, new RegExp(`message_id=${escapeRegExp(requestId)}`));
    assert(resumePrompt.includes("action=interrupt_and_redirect"));
    assert(resumePrompt.includes(content));

    const preflight = server.runtime.renderResumePreflight({
      sessionId: session.session_id,
      instruction: "Resume after operator interrupt.",
      command: "resume",
      route: "stored_plan"
    });
    assert.match(preflight, /Live Control Directives/);
    assert.match(preflight, new RegExp(`message_id=${escapeRegExp(requestId)}`));
    assert(preflight.includes("action=interrupt_and_redirect"));
    assert(preflight.includes(content));

    const sessionView = await readJson<SessionViewPayload>(
      `${started.url}/v1/sessions/${encodeURIComponent(session.session_id)}`
    );
    assert.equal(sessionView.session_id, session.session_id);
    assert.equal(sessionView.work_snapshot.session.session_id, session.session_id);
    assert.equal(sessionView.work_snapshot.blackboard_counts.decision, 1);
    const protocolGateway = sessionView.swarm_protocol.actors.find((actor) => actor.actor_id === "gateway.local");
    assert(protocolGateway, "session swarm_protocol should include gateway.local actor");
    assert.equal(protocolGateway.kind, "gateway");
    assert.equal(protocolGateway.mailbox.outbox_total >= 1, true);
    assert.equal(sessionView.swarm_protocol.mailbox.recent_messages.some((message) =>
      message.envelope_id === gatewayEnvelope.id &&
      message.direction === "outbox" &&
      message.from_agent_id === "gateway.local"
    ), true);
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

type InterruptPayload = {
  status: "applied";
  session_id: string;
  route: "coding_loop" | "full_swarm";
  request_id?: string;
  duplicate: boolean;
  control?: {
    message_id: string;
    action: string;
    reason: string;
    instruction: string;
  };
};

type BlackboardPayload = {
  session_id: string;
  entries: BlackboardEntry[];
};

type ReplayPayload = {
  session_id: string;
  replay: string;
};

type SessionViewPayload = {
  session_id: string;
  work_snapshot: WorkSnapshot;
  swarm_protocol: {
    actors: Array<{
      actor_id: string;
      kind: string;
      mailbox: {
        outbox_total: number;
      };
    }>;
    mailbox: {
      recent_messages: Array<{
        envelope_id: string;
        direction: "inbox" | "outbox";
        from_agent_id?: string;
      }>;
    };
  };
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-gateway-live-blackboard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function seedActiveFullSwarmSession(server: SwarmGatewayServer, fixture: Fixture): SwarmSession {
  const session: SwarmSession = {
    swarm_id: "swarm-gateway-live-blackboard",
    session_id: "session-gateway-live-blackboard",
    user_request_id: "user-gateway-live-blackboard",
    source: source(),
    workspace_lease_id: "lease-gateway-live-blackboard",
    objective: "Prove Gateway full_swarm live-control Blackboard projection",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  };
  server.runtime.workspaceLeaseStore.create({
    lease_id: session.workspace_lease_id,
    session_id: session.session_id,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/server/gateway-live-blackboard.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "gateway-live-blackboard-test" },
    created_at: AT
  });
  server.runtime.sessionStore.create(session);
  runtimeAccess(server.runtime).activeSwarmSession = session;
  return session;
}

function source(): WorkItem {
  return {
    source: "gateway",
    source_id: "run-live-blackboard",
    human_id: "CAND-PROD-026",
    title: "Gateway live-control Blackboard projection",
    description: "Deterministic session-scoped interrupt projection evidence.",
    labels: ["blackboard", "live-control", "gateway"],
    state: "active",
    metadata: { candidate: "CAND-PROD-026", route: "full_swarm" }
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 2,
    max_parallel_tasks: 1,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: "on-request",
    network_access: "deny",
    allow_domains: [],
    human_approval_for: [],
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: [],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    }
  };
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as T;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...gatewayClientAuthHeaders() },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json() as T
  };
}

function runtimeAccess(runtime: SwarmGatewayServer["runtime"]): {
  activeSwarmSession?: SwarmSession;
} {
  return runtime as unknown as { activeSwarmSession?: SwarmSession };
}

function recordValue(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected record value");
  return value as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AT = "2026-05-13T00:00:00.000Z";
