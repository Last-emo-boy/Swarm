import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { disposeGlobalLspManager } from "../lsp/manager.js";
import { SwarmGatewayServer } from "./gateway.js";

test("Gateway exposes LSP semantic planning status through a real HTTP route", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.workspace,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const health = await readJson<GatewayHealthPayload>(`${started.url}/health`);
    assert.equal(health.ok, true);
    assert(health.routes.includes("/v1/lsp/status"));

    const status = await readJson<LspStatusPayload>(`${started.url}/v1/lsp/status?provider=typescript`);
    assert.equal(status.workspace, fixture.workspace);
    assert.equal(status.providers.length, 1);
    assert.equal(status.providers[0].providerId, "typescript");
    assert.equal(status.providers[0].detected, true);
    assert.equal(status.providers[0].available, true);
    assert.equal(status.semanticPlanning?.participant_id, "capability:lsp:planning");
    assert.equal(status.semanticPlanning?.state, "active");
    assert.equal(status.semanticPlanning?.task_hint_capable, true);
    assert.equal(status.semanticPlanning?.conflict_evidence_capable, true);
  } finally {
    await server.stop();
    await disposeGlobalLspManager(fixture.workspace);
    fixture.close();
  }
});

type GatewayHealthPayload = {
  ok: boolean;
  routes: string[];
};

type LspStatusPayload = {
  workspace: string;
  providers: Array<{
    providerId: string;
    detected: boolean;
    available: boolean;
  }>;
  semanticPlanning?: {
    participant_id: string;
    state: string;
    task_hint_capable: boolean;
    conflict_evidence_capable: boolean;
  };
};

function createFixture(): { root: string; workspace: string; databasePath: string; close(): void } {
  const root = join(tmpdir(), `swarm-gateway-lsp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf8");
  writeFileSync(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }, null, 2), "utf8");
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
