import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { devicesCard, devicesOf, devicesText, type Devices } from "./devices.js";
import { KV } from "./kv.js";
import type { MeshView } from "./placement.js";
import { settingsPath, writeSettings } from "./settings.js";
import { sayIn } from "./text.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "swarm-devices-")); });
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});
function start(settings: unknown = {}) {
  writeSettings(settings, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
}
const devices = (view?: MeshView, running = 0): Devices =>
  devicesOf({ settings: client.settings(), store: client.store, ...(view ? { view } : {}), running });
/** A slot's lease: a VM boots or runs its ticket until `expiresAt`, or it let the ticket go. */
const lease = (expiresAt: number, held = true) => ({ ticketId: "t", assignmentId: "a", tokenHash: held ? "hash" : "", at: "", expiresAt: new Date(expiresAt).toISOString() });

/** A bot VM with OpenCode, paired with a Mac that has Codex and Claude Code and a PC that does not answer. */
const MESH: MeshView = { here: { name: "bot-vm", abilities: ["linux", "harness:opencode"] },
  peers: [{ name: "mac", abilities: ["macos", "harness:codex", "harness:claude"] }], offline: ["pc"] };

test("lists this node and its paired nodes, online or not, with their machines and harnesses apart", () => {
  start();
  const found = devices(MESH, 1);
  assert.deepEqual(found.here, { name: "bot-vm", machine: ["linux"], harnesses: ["opencode"] });
  assert.deepEqual(found.peers, [
    { name: "mac", online: true, machine: ["macos"], harnesses: ["codex", "claude"] },
    { name: "pc", online: false, machine: [], harnesses: [] }
  ]);
  assert.deepEqual(found.workers, { isolation: "process", slots: { total: 3, busy: 1, free: 2 } });
});

test("on a host that is no mesh node, counts the harness profiles it would run as its own, OpenCode's alone in ticket VMs", () => {
  start();
  assert.deepEqual(devices().here, { machine: [], harnesses: ["claude", "codex", "kimi", "opencode", "claude-glm", "claude-deepseek"] });
  assert.deepEqual(devices().peers, []);
  client.close();
  start({ executor: { isolation: "vm" } });
  assert.deepEqual(devices().here.harnesses, ["opencode"]);
});

test("counts the ticket VMs whose lease holds as busy, here and in the cluster, and the rest as free", () => {
  start({ executor: { isolation: "vm", vm: { slots: 4, kube: { slots: 10 } } } });
  const later = Date.now() + 60_000;
  client.store.set(KV.vm.slot("0"), lease(later));
  // A lease that lapsed, and a slot that let its ticket go, hold no VM.
  client.store.set(KV.vm.slot("1"), lease(Date.now() - 1000));
  client.store.set(KV.vm.slot("2"), lease(later, false));
  client.store.set(KV.vm.slot("c3"), lease(later));
  client.store.set(KV.vm.slot("c4"), lease(later));
  assert.deepEqual(devices(undefined, 2).workers, { isolation: "vm", local: { total: 4, busy: 1, free: 3 }, cluster: { total: 10, busy: 2, free: 8 } });
  client.close();
  start({ executor: { isolation: "vm", vm: { slots: 2 } } });
  assert.deepEqual(devices().workers, { isolation: "vm", local: { total: 2, busy: 1, free: 1 } });
});

test("the router's card names the nodes for those who may see them, and gives everyone else counts", () => {
  start({ executor: { isolation: "vm", vm: { slots: 0, kube: { slots: 10 } } } });
  const found = devices(MESH);
  assert.deepEqual(devicesCard(found, true), {
    this_node: { name: "bot-vm", machine: ["linux"], harnesses: ["opencode"] },
    paired_nodes: [{ name: "mac", online: true, machine: ["macos"], harnesses: ["codex", "claude"] }, { name: "pc", online: false }],
    ticket_workers: { runs_as: "a VM of its own for each ticket; the cluster takes tickets once this node's VMs are busy", in_the_cluster: { total: 10, busy: 0, free: 10 } }
  });
  const counts = devicesCard(found, false);
  assert.deepEqual(counts.paired_nodes, { total: 2, online: 1 });
  assert.equal(counts.this_node, undefined);
  assert.doesNotMatch(JSON.stringify(counts), /mac|pc"|bot-vm|codex/);
});

test("/devices words the same view in English and Chinese, with counts alone for people who may not see the nodes", () => {
  start({ executor: { isolation: "vm", vm: { slots: 4, kube: { slots: 10 } } } });
  client.store.set(KV.vm.slot("0"), lease(Date.now() + 60_000));
  const found = devices(MESH);
  assert.equal(devicesText(found, true, sayIn(false)), "This node: bot-vm (linux; harnesses: opencode). "
    + "Paired nodes: mac, online (macos; harnesses: codex, claude); pc, offline. Ticket VMs: 3 of 4 free here, 10 of 10 free in the cluster.");
  assert.equal(devicesText(found, true, sayIn(true)), "本机：bot-vm（linux；harness：opencode）。"
    + "配对节点：mac 在线（macos；harness：codex、claude）；pc 离线。工单 VM：本机 4 台，空闲 3 台；集群 10 台，空闲 10 台。");
  assert.equal(devicesText(found, false, sayIn(false)),
    "Paired nodes: 2, 1 online. Ticket VMs: 3 of 4 free here, 10 of 10 free in the cluster. Only maintainers and owners see which nodes these are.");
  client.close();
  start();
  assert.equal(devicesText(devices(undefined, 3), true, sayIn(false)),
    "This node: this host (harnesses: claude, codex, kimi, opencode, claude-glm, claude-deepseek). Paired nodes: none. Workers: 0 of 3 free, as processes on this node.");
});
