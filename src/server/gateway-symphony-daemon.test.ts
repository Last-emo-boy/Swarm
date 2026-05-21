import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";
import type { SymphonyDaemonRecord } from "../symphony/daemon.js";

test("Gateway Symphony daemon routes support bounded list, start, lookup, and stop", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();

    const emptyList = await readJson<DaemonListPayload>(`${started.url}/v1/symphony/daemon`);
    assert.deepEqual(emptyList.daemons, []);

    const firstDaemon = await startDaemon(started.url, fixture.workflowPath, 1);
    assert.equal(firstDaemon.status, "running");
    assert.equal(firstDaemon.workflow_path, fixture.workflowPath);

    const stoppedFirst = await waitForDaemon(started.url, firstDaemon.daemon_id, (daemon) => daemon.status === "stopped");
    assert.equal(stoppedFirst.tick_count, 1);
    assert.equal(stoppedFirst.stop_reason, "max_ticks_reached");

    const listAfterFirst = await readJson<DaemonListPayload>(`${started.url}/v1/symphony/daemon`);
    assert.equal(listAfterFirst.daemons.length, 1);
    assert.equal(listAfterFirst.daemons[0].daemon_id, firstDaemon.daemon_id);

    const lookupFirst = await readJson<DaemonLookupPayload>(`${started.url}/v1/symphony/daemon?daemon_id=${encodeURIComponent(firstDaemon.daemon_id)}`);
    assert.equal(lookupFirst.daemon.daemon_id, firstDaemon.daemon_id);
    assert.equal(lookupFirst.daemon.status, "stopped");

    const secondDaemon = await startDaemon(started.url, fixture.workflowPath, 10);
    await waitForDaemon(started.url, secondDaemon.daemon_id, (daemon) => daemon.tick_count >= 1 && daemon.status === "running");

    const stopResponse = await fetch(`${started.url}/v1/symphony/daemon/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        daemon_id: secondDaemon.daemon_id,
        reason: "route_stop",
        cancel_running: true
      })
    });
    const stopBody = await stopResponse.json() as { daemons?: SymphonyDaemonRecord[] };
    assert.equal(stopResponse.status, 202);
    assert(stopBody.daemons?.some((daemon) => daemon.daemon_id === secondDaemon.daemon_id));

    const stoppedSecond = await waitForDaemon(started.url, secondDaemon.daemon_id, (daemon) => daemon.status === "stopped");
    assert.equal(stoppedSecond.stop_reason, "route_stop");
    assert.equal(stoppedSecond.status, "stopped");

    const listAfterStop = await readJson<DaemonListPayload>(`${started.url}/v1/symphony/daemon`);
    assert.equal(listAfterStop.daemons.length, 2);
    assert(listAfterStop.daemons.some((daemon) => daemon.daemon_id === secondDaemon.daemon_id));
  } finally {
    await server.stop();
    fixture.close();
  }
});

type DaemonListPayload = {
  daemons: SymphonyDaemonRecord[];
};

type DaemonLookupPayload = {
  daemon: SymphonyDaemonRecord;
};

function createFixture(): { root: string; workflowPath: string; databasePath: string; close(): void } {
  const root = join(tmpdir(), `swarm-gateway-symphony-daemon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(workflowPath, workflowText(workspaceRoot), "utf8");
  return {
    root,
    workflowPath,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function startDaemon(gatewayUrl: string, workflowPath: string, maxTicks: number): Promise<SymphonyDaemonRecord> {
  const response = await fetch(`${gatewayUrl}/v1/symphony/daemon/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...gatewayClientAuthHeaders()
    },
    body: JSON.stringify({
      workflow_path: workflowPath,
      create_workspace: false,
      execute: false,
      max_ticks: maxTicks
    })
  });
  const body = await response.json() as { daemon?: SymphonyDaemonRecord };
  assert.equal(response.status, 202);
  assert(body.daemon, "Expected daemon response body.");
  return body.daemon;
}

async function waitForDaemon(
  gatewayUrl: string,
  daemonId: string,
  predicate: (daemon: SymphonyDaemonRecord) => boolean,
  timeoutMs = 5_000
): Promise<SymphonyDaemonRecord> {
  const start = Date.now();
  while (true) {
    const payload = await readJson<DaemonLookupPayload>(`${gatewayUrl}/v1/symphony/daemon?daemon_id=${encodeURIComponent(daemonId)}`);
    if (predicate(payload.daemon)) {
      return payload.daemon;
    }
    if (Date.now() - start > timeoutMs) {
      assert.fail(`Timed out waiting for daemon ${daemonId}.`);
    }
    await delay(20);
  }
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as T;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

function workflowText(workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "polling:",
    "  interval_ms: 60000",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 2",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
