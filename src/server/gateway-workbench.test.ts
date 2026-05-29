import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmPolicy, SwarmSession, WorkItem } from "../protocol/types.js";
import type { CaseWorkbenchDetail, CaseWorkbenchProjection } from "../runtime/case-workbench.js";
import { SwarmGatewayServer } from "./gateway.js";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";

test("Gateway exposes global workbench cases inbox and selected case detail as read-only routes", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspaceA,
    databasePath: fixture.databasePath
  });

  try {
    seedSession(server, {
      sessionId: "gateway-case-a",
      workspace: fixture.workspaceA,
      objective: "Global workbench case A",
      source: workItem("user", "Gateway Case A"),
      status: "running"
    });
    seedSession(server, {
      sessionId: "gateway-case-b",
      workspace: fixture.workspaceB,
      objective: "Global workbench case B",
      source: workItem("symphony", "Gateway Case B"),
      status: "completed"
    });
    seedSession(server, {
      sessionId: "gateway-case-no-workspace",
      objective: "No workspace case",
      source: workItem("gateway", "No Workspace Case"),
      status: "planning",
      createLease: false
    });

    const started = await server.start();
    const health = await readJson<GatewayHealthPayload>(`${started.url}/health`);
    assert(health.routes.includes("/v1/workbench"));
    assert(health.routes.includes("/v1/workbench/cases"));
    assert(health.routes.includes("/v1/workbench/cases/:id"));
    assert(health.routes.includes("/v1/workbench/inbox"));

    const projection = await readJson<CaseWorkbenchProjection>(`${started.url}/v1/workbench?limit=10`);
    assert.equal(projection.schema_version, "swarm.case_workbench.v1");
    assert.equal(projection.scope, "global");
    assert.equal(projection.summary.cases, 3);
    assert(projection.cases.some((item) => item.case_id === "gateway-case-b" && item.workspace_path === fixture.workspaceB));
    assert(projection.inbox.some((item) => item.case_id === "gateway-case-no-workspace" && item.kind === "no_workspace"));

    const cases = await readJson<{ cases: CaseWorkbenchProjection["cases"] }>(`${started.url}/v1/workbench/cases?limit=10`);
    assert.deepEqual(cases.cases.map((item) => item.case_id), projection.cases.map((item) => item.case_id));

    const inbox = await readJson<{ inbox: CaseWorkbenchProjection["inbox"] }>(`${started.url}/v1/workbench/inbox?limit=10`);
    assert(inbox.inbox.some((item) => item.kind === "no_workspace"));

    const detail = await readJson<CaseWorkbenchDetail>(`${started.url}/v1/workbench/cases/gateway-case-a`);
    assert.equal(detail.case_id, "gateway-case-a");
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.workspace_path, fixture.workspaceA);

    const postResponse = await fetch(`${started.url}/v1/workbench/cases`, {
      method: "POST",
      headers: gatewayClientAuthHeaders()
    });
    assert.equal(postResponse.status, 405);
  } finally {
    await server.stop();
    fixture.close();
  }
});

type GatewayHealthPayload = {
  ok: boolean;
  routes: string[];
};

function seedSession(
  server: SwarmGatewayServer,
  input: {
    sessionId: string;
    objective: string;
    status: SwarmSession["status"];
    workspace?: string;
    source?: WorkItem;
    createLease?: boolean;
  }
): void {
  const now = new Date().toISOString();
  const lease = input.createLease === false || !input.workspace
    ? undefined
    : server.runtime.workspaceLeaseStore.create({
        lease_id: `lease-${input.sessionId}`,
        session_id: input.sessionId,
        workspace_root: input.workspace,
        workspace_path: input.workspace,
        scope: [],
        write_boundary: "workspace",
        metadata: { kind: "gateway-workbench-test" },
        created_at: now
      });
  server.runtime.sessionStore.create({
    swarm_id: `swarm-${input.sessionId}`,
    session_id: input.sessionId,
    user_request_id: `request-${input.sessionId}`,
    source: input.source,
    workspace_lease_id: lease?.lease_id,
    objective: input.objective,
    status: input.status,
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
  });
}

function workItem(source: string, title: string): WorkItem {
  return {
    source,
    source_id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    human_id: title,
    title,
    labels: [],
    metadata: {}
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
  workspaceA: string;
  workspaceB: string;
  databasePath: string;
  close(): void;
} {
  const root = join(tmpdir(), `swarm-gateway-workbench-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  return {
    root,
    workspaceA,
    workspaceB,
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
