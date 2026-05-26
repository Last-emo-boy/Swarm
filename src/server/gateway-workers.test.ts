import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import type { SwarmPolicy, WorkContractWorker } from "../protocol/types.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import { SwarmGatewayServer } from "./gateway.js";

test("Gateway workers endpoint preserves worker records and contracts with actor projection enabled", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspace,
    databasePath: fixture.databasePath
  });

  try {
    seedParentSession(server, fixture);
    const worker = server.runtime.workerStateStore.create({
      worker_id: "worker-gateway-1",
      display_name: "Ada",
      role_title: "Coder",
      parent_session_id: "gateway-parent-session",
      capability: "code.implement",
      objective: "Verify gateway worker compatibility",
      status: "running",
      agent_spec_id: "coder",
      invocation_mode: "parallel",
      file_scope: ["src/server/gateway.ts"],
      tool_budget: { max_turns: 3, max_tool_calls: 9 },
      requested_by: "main_swarm"
    });
    assert.equal(server.runtime.agentActorStore.get(`worker:${worker.worker_id}`)?.kind, "worker");

    const started = await server.start();
    const payload = await readJson<WorkersPayload>(`${started.url}/v1/workers?parent_session_id=gateway-parent-session`);

    assert.equal(payload.workers.length, 1);
    assert.equal(payload.workers[0]?.worker_id, "worker-gateway-1");
    assert.equal(payload.workers[0]?.display_name, "Ada");
    assert.equal(payload.workers[0]?.role_title, "Coder");
    assert.equal(payload.workers[0]?.status, "running");
    assert.equal(payload.workers[0]?.capability, "code.implement");
    assert.equal(payload.worker_contracts.length, 1);
    assert.equal(payload.worker_contracts[0]?.worker_id, "worker-gateway-1");
    assert.equal(payload.worker_contracts[0]?.heartbeat_state, "fresh");
    assert.equal(payload.worker_contracts[0]?.claim_owner, "main_swarm");
    assert.equal(payload.work_contract_summary?.active_workers, 1);

    const stop = await postJson<{ worker_id: string; status: string }>(`${started.url}/v1/workers/worker-gateway-1/stop`, {
      reason: "operator stop",
      correlation_id: "corr-worker-stop-1"
    });
    assert.equal(stop.worker_id, "worker-gateway-1");
    assert.equal(stop.status, "stop_requested");

    const trace = server.runtime.traceStore.list("gateway-parent-session");
    const envelope = trace.find((item) => item.intent === "gateway.worker.stop");
    assert(envelope, "missing gateway worker stop envelope");
    assert.equal(envelope.from.agent_id, "gateway.local");
    assert.equal(envelope.type, "task.cancel");
    assert.equal(envelope.correlation_id, "corr-worker-stop-1");
    assert.equal(envelope.auth?.actor, "gateway.local.control");
    assert(envelope.auth?.scopes?.includes("gateway.worker.stop"));
    assert.equal((envelope.payload as { worker_id?: string }).worker_id, "worker-gateway-1");

    const deliveries = server.runtime.envelopeDeliveryStore.list({
      sessionId: "gateway-parent-session",
      envelopeId: envelope.id
    });
    assert(deliveries.some((delivery) =>
      delivery.status === "delivered" &&
      delivery.recipient_agent_id === "main_swarm"
    ));
    assert.match(server.runtime.replaySession("gateway-parent-session"), /gateway\.worker\.stop/);
  } finally {
    await server.stop();
    fixture.close();
  }
});

type WorkersPayload = {
  workers: WorkerRecord[];
  worker_contracts: WorkContractWorker[];
  work_contract_summary?: {
    active_workers: number;
  };
};

function seedParentSession(server: SwarmGatewayServer, fixture: ReturnType<typeof createFixture>): void {
  const now = new Date().toISOString();
  const lease = server.runtime.workspaceLeaseStore.create({
    lease_id: "lease-gateway-parent-session",
    session_id: "gateway-parent-session",
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/server/gateway.ts"],
    write_boundary: "workspace",
    metadata: { kind: "gateway-workers-test" },
    created_at: now
  });
  server.runtime.sessionStore.create({
    swarm_id: "swarm-gateway-parent-session",
    session_id: "gateway-parent-session",
    user_request_id: "gateway-workers-test",
    workspace_lease_id: lease.lease_id,
    objective: "Gateway worker compatibility parent session",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
  });
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
  const root = join(tmpdir(), `swarm-gateway-workers-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as T;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
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
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}
