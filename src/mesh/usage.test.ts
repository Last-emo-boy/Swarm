import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultSwarmSettings } from "../config/settings.js";
import { SwarmDatabase } from "../storage/database.js";
import { UsageStore } from "../storage/usage-store.js";
import { collectUsage, usageReport, usageText } from "../usage/cli.js";
import { nodeCard } from "./card.js";
import { joinMesh } from "./client.js";
import { MeshServer } from "./server.js";
import { createInvite, readMesh, updateMesh } from "./state.js";
import { registerUsage } from "./usage.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const root = mkdtempSync(join(tmpdir(), "swarm-mesh-usage-"));
const macMesh = join(root, "mac-mesh");
const macDb = join(root, "mac.db");
const servers: MeshServer[] = [];

/** A device's database with one DeepSeek call per entry of `outputs`, a minute apart from `at`. */
function recordCalls(path: string, at: string, outputs: number[]): void {
  const database = new SwarmDatabase(path);
  const store = new UsageStore(database);
  outputs.forEach((outputTokens, index) => store.append({ session_id: "s", kind: "llm_call", amount: 1, unit: "count",
    created_at: new Date(Date.parse(at) + index * 60_000).toISOString(),
    metadata: { providerId: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", purpose: "main_coding_loop", sessionId: "s",
      inputTokens: 1000, cachedInputTokens: 0, outputTokens, totalInputWithCacheTokens: 1000 } }));
  database.close();
}

/** A paired node named `name` that serves its own usage database, or no usage at all as Swarm before the route did. */
async function node(name: string, database?: string): Promise<MeshServer> {
  const home = join(root, `${name}-mesh`);
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: [] }) });
  if (database) registerUsage(server, { databasePath: () => database });
  const { address } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: address } }), home);
  await joinMesh(createInvite(address, 15, home), macMesh);
  servers.push(server);
  return server;
}

let pi: MeshServer;
before(async () => {
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "mac", advertise: "http://127.0.0.1:9" } }), macMesh);
  recordCalls(macDb, "2026-11-07T08:00:00.000Z", [10]);
  recordCalls(join(root, "ovh.db"), "2026-11-07T09:00:00.000Z", [20, 30]);
  recordCalls(join(root, "pi.db"), "2026-11-07T09:30:00.000Z", [40]);
  await node("ovh", join(root, "ovh.db"));
  pi = await node("pi", join(root, "pi.db"));
  await node("old");
});
after(async () => {
  for (const server of servers) await server.stop();
  rmSync(root, { recursive: true, force: true });
});

test("--all-devices adds each paired device's calls under its name", async () => {
  const since = new Date("2026-11-07T00:00:00.000Z");
  const { entries, devices } = await collectUsage({ since, allDevices: true, databasePath: macDb, meshHome: macMesh });
  assert.deepEqual(devices.map((device) => [device.device, device.calls ?? device.skipped]).sort(),
    [["mac", 1], ["old", "its Swarm does not share usage yet; update it with swarm update"], ["ovh", 2], ["pi", 1]]);
  const report = usageReport(entries, devices, { since, by: "device" }, defaultSwarmSettings());
  assert.deepEqual(report.rows.map((row) => [row.key, row.calls, row.output]).sort(), [["mac", 1, 10], ["ovh", 2, 50], ["pi", 1, 40]]);

  const later = await collectUsage({ since: new Date("2026-11-07T09:01:00.000Z"), allDevices: true, databasePath: macDb, meshHome: macMesh });
  assert.deepEqual(later.entries.map((entry) => [entry.device, entry.output]), [["ovh", 30], ["pi", 40]], "each device reads only calls since then");

  const local = await collectUsage({ since, allDevices: false, databasePath: macDb, meshHome: macMesh });
  assert.deepEqual(local.devices, [{ device: "mac", calls: 1 }]);
});

test("a paired device that does not answer is skipped with a note", async () => {
  await pi.stop();
  const since = new Date("2026-11-07T00:00:00.000Z");
  const { entries, devices } = await collectUsage({ since, allDevices: true, databasePath: macDb, meshHome: macMesh, timeoutMs: 2000 });
  assert.deepEqual(entries.map((entry) => entry.device).sort(), ["mac", "ovh", "ovh"]);
  const skipped = devices.find((device) => device.device === "pi");
  assert.match(skipped?.skipped ?? "", /^it did not answer \(pi is unreachable/);
  const text = usageText(usageReport(entries, devices, { since, by: "device" }, defaultSwarmSettings()), "today");
  assert.match(text, /on mac, ovh:/);
  assert.match(text, /Skipped pi: it did not answer \(/);
});
