import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";

test("Gateway checkpoint routes create, list, and revert the server workspace", async () => {
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
    const started = await server.start();
    const health = await readJson<GatewayHealthPayload>(`${started.url}/health`);
    assert(health.routes.includes("/v1/checkpoints"));
    assert(health.routes.includes("/v1/checkpoints/:id/revert"));

    const emptyList = await readJson<CheckpointListPayload>(`${started.url}/v1/checkpoints?limit=5`);
    assert.equal(emptyList.workspace, fixture.workspace);
    assert.deepEqual(emptyList.checkpoints, []);

    const unauthenticated = await postJson<GatewayErrorPayload>(
      `${started.url}/v1/checkpoints`,
      { name: "before edit" },
      { "content-type": "application/json" },
      false
    );
    assert.equal(unauthenticated.status, 403);
    assert.match(unauthenticated.body.error?.message ?? "", /Gateway mutation requires/);

    const created = await postJson<CheckpointPayload>(`${started.url}/v1/checkpoints`, {
      name: "before edit",
      reason: "gateway smoke"
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.workspace, fixture.workspace);
    assert.equal(created.body.checkpoint.name, "before edit");
    assert.equal(created.body.checkpoint.status, "available");
    assert.equal(created.body.checkpoint.revertAvailable, true);

    const listed = await readJson<CheckpointListPayload>(`${started.url}/v1/checkpoints?limit=1`);
    assert.deepEqual(listed.checkpoints.map((item) => item.id), [created.body.checkpoint.id]);

    writeFileSync(fixture.subjectPath, "changed through gateway test\n", "utf8");
    writeFileSync(fixture.extraPath, "extra file that should be removed\n", "utf8");

    const reverted = await postJson<CheckpointPayload>(
      `${started.url}/v1/checkpoints/${encodeURIComponent(created.body.checkpoint.id)}/revert`,
      {}
    );
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body.workspace, fixture.workspace);
    assert.equal(reverted.body.checkpoint.id, created.body.checkpoint.id);
    assert.equal(reverted.body.checkpoint.status, "reverted");
    assert.equal(readFileSync(fixture.subjectPath, "utf8"), "original checkpoint text\n");
    assert.equal(existsSync(fixture.extraPath), false);

    const missing = await postJson<GatewayErrorPayload>(`${started.url}/v1/checkpoints/cp_missing/revert`, {});
    assert.equal(missing.status, 404);
    assert.match(missing.body.error?.message ?? "", /Unknown checkpoint/);
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
  subjectPath: string;
  extraPath: string;
  close(): void;
};

type GatewayHealthPayload = {
  ok: boolean;
  routes: string[];
};

type CheckpointSummary = {
  id: string;
  name: string;
  mode: "git" | "snapshot";
  status: "available" | "reverted" | "missing";
  revertAvailable: boolean;
};

type CheckpointListPayload = {
  workspace: string;
  checkpoints: CheckpointSummary[];
};

type CheckpointPayload = {
  workspace: string;
  checkpoint: CheckpointSummary;
};

type GatewayErrorPayload = {
  error?: {
    message?: string;
    status?: number;
  };
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-gateway-checkpoints-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  const subjectPath = join(workspace, "subject.txt");
  const extraPath = join(workspace, "extra.txt");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(subjectPath, "original checkpoint text\n", "utf8");
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    subjectPath,
    extraPath,
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

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "content-type": "application/json", ...gatewayClientAuthHeaders() },
  includeDefaultAuth = true
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: includeDefaultAuth
      ? { "content-type": "application/json", ...gatewayClientAuthHeaders(), ...headers }
      : headers,
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json() as T
  };
}
