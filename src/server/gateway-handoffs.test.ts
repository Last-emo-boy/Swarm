import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTaskPacket } from "../runtime/agent-specs.js";
import type { SwarmPolicy } from "../protocol/types.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";

test("Gateway handoff take-back creates durable protocol envelope and preserves response shape", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspace,
    databasePath: fixture.databasePath
  });

  try {
    seedParentSession(server, fixture);
    const taskPacket = handoffTaskPacket();
    const worker = server.runtime.workerStateStore.create({
      worker_id: "worker-gateway-handoff-1",
      display_name: "Grace",
      role_title: "Handoff Specialist",
      parent_session_id: "gateway-handoff-parent-session",
      capability: "handoff.deep_work",
      objective: "Own gateway handoff take-back fixture",
      status: "running",
      agent_spec_id: "handoff_specialist",
      invocation_mode: "handoff",
      handoff_id: "handoff-gateway-1",
      file_scope: ["src/server/gateway.ts"],
      tool_budget: taskPacket.budget,
      persona_snapshot: taskPacket.persona_snapshot,
      task_packet: taskPacket,
      requested_by: "main_swarm"
    });
    server.runtime.handoffStore.create({
      handoff_id: "handoff-gateway-1",
      worker_id: worker.worker_id,
      parent_session_id: "gateway-handoff-parent-session",
      source_agent: "main_swarm",
      target_agent_spec_id: "handoff_specialist",
      reason: "Gateway take-back test",
      task_packet: taskPacket,
      requester_agent_id: "main_swarm",
      owner_agent_id: "worker:worker-gateway-handoff-1",
      request_envelope_id: "env_handoff_request_gateway_1"
    });
    server.runtime.handoffStore.markAccepted({
      handoff_id: "handoff-gateway-1",
      owner_agent_id: "worker:worker-gateway-handoff-1",
      envelope_id: "env_handoff_accept_gateway_1"
    });

    const started = await server.start();
    const handoff = await postJson<HandoffSessionRecord>(`${started.url}/v1/handoffs/handoff-gateway-1/take-back`, {
      reason: "operator take back",
      correlation_id: "corr-handoff-take-back-1"
    });

    assert.equal(handoff.handoff_id, "handoff-gateway-1");
    assert.equal(handoff.worker_id, "worker-gateway-handoff-1");
    assert.equal(handoff.status, "taken_back");
    assert.equal(handoff.protocol_status, "taken_back");
    assert.equal(handoff.requester_agent_id, "gateway.local");
    assert.equal(handoff.owner_agent_id, "gateway.local");
    const gatewayEnvelopeId = stringValue(handoff.take_back_envelope_id, "handoff.take_back_envelope_id");

    const stored = server.runtime.handoffStore.get("handoff-gateway-1");
    assert.equal(stored?.status, "taken_back");
    assert.equal(stored?.take_back_envelope_id, gatewayEnvelopeId);
    assert.equal(server.runtime.workerStateStore.get(worker.worker_id)?.status, "stopped");

    const envelope = server.runtime.traceStore.list("gateway-handoff-parent-session").find((item) => item.id === gatewayEnvelopeId);
    assert(envelope, "missing Gateway handoff take-back envelope");
    assert.equal(envelope.from.agent_id, "gateway.local");
    assert.equal(envelope.type, "handoff.take_back");
    assert.equal(envelope.intent, "gateway.handoff.take_back");
    assert.equal(envelope.correlation_id, "corr-handoff-take-back-1");
    assert.equal(envelope.reply_to, "env_handoff_accept_gateway_1");
    assert.equal(envelope.auth?.actor, "gateway.local.control");
    assert(envelope.auth?.scopes?.includes("gateway.handoff.take_back"));
    assert.equal(!Array.isArray(envelope.to) && envelope.to.agent_id, "worker:worker-gateway-handoff-1");
    const payload = envelope.payload as Record<string, unknown>;
    assert.equal(payload.handoff_id, "handoff-gateway-1");
    assert.equal(payload.worker_id, "worker-gateway-handoff-1");
    assert.equal(payload.requester_agent_id, "gateway.local");
    assert.equal(payload.reason, "operator take back");
    assert.equal(payload.previous_owner, "worker:worker-gateway-handoff-1");
    assert.equal(payload.resulting_owner, "gateway.local");

    const deliveries = server.runtime.envelopeDeliveryStore.list({
      sessionId: "gateway-handoff-parent-session",
      envelopeId: gatewayEnvelopeId
    });
    assert(deliveries.some((delivery) =>
      delivery.status === "delivered" &&
      delivery.recipient_agent_id === "worker:worker-gateway-handoff-1"
    ));
  } finally {
    await server.stop();
    fixture.close();
  }
});

function seedParentSession(server: SwarmGatewayServer, fixture: ReturnType<typeof createFixture>): void {
  const now = new Date().toISOString();
  const lease = server.runtime.workspaceLeaseStore.create({
    lease_id: "lease-gateway-handoff-parent-session",
    session_id: "gateway-handoff-parent-session",
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/server/gateway.ts"],
    write_boundary: "workspace",
    metadata: { kind: "gateway-handoffs-test" },
    created_at: now
  });
  server.runtime.sessionStore.create({
    swarm_id: "swarm-gateway-handoff-parent-session",
    session_id: "gateway-handoff-parent-session",
    user_request_id: "gateway-handoffs-test",
    workspace_lease_id: lease.lease_id,
    objective: "Gateway handoff compatibility parent session",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
  });
}

function handoffTaskPacket(): AgentTaskPacket {
  return {
    objective: "Own gateway handoff take-back fixture",
    agent_spec_id: "handoff_specialist",
    invocation_mode: "handoff",
    persona_snapshot: "Gateway handoff specialist fixture.",
    role_title: "Handoff Specialist",
    persona_brief: "Owns a focused handoff segment.",
    relevant_context: "Gateway take-back test fixture.",
    file_scope: ["src/server/gateway.ts"],
    allowed_tools: ["file.read"],
    write_policy: "scoped_write",
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: {
      max_turns: 3,
      max_tool_calls: 9
    },
    expected_output: "Return handoff result.",
    return_conditions: ["done", "blocked"]
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 60_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: false,
    consensus: "coordinator_decision",
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

function createFixture(): {
  root: string;
  workspace: string;
  databasePath: string;
  close(): void;
} {
  const root = join(tmpdir(), `swarm-gateway-handoffs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...gatewayClientAuthHeaders()
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as T;
  assert.equal(response.status, 202, JSON.stringify(payload));
  return payload;
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${description}`);
  }
  return value;
}
