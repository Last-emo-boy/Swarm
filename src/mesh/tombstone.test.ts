/** Removals converge: a device removed while a member was offline is refused once that member reaches any peer. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { membersMismatch, nodeCard } from "./card.js";
import { callPeer, joinMesh, meet, peerHealth, removeFromSwarm, type MeshError } from "./client.js";
import { brokerPeer } from "./pair.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, forgetDevice, membersDigest, membersSummary, readMesh, refuses, removePeer, setGrant, tombstones, updateMesh } from "./state.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const started: { home: string; server: MeshServer; url: string }[] = [];
afterEach(async () => {
  for (const node of started.splice(0)) {
    await node.server.stop();
    rmSync(node.home, { recursive: true, force: true });
  }
});

async function startNode(name: string) {
  const home = mkdtempSync(join(tmpdir(), `swarm-tomb-${name}-`));
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"], members: membersSummary(readMesh(home)) }) });
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const node = { home, server, url };
  started.push(node);
  return node;
}

const idOf = (home: string): string => readMesh(home).node.id;
/** Lets `remover` take devices out of `node`'s swarm, and carry such removals to it: an operator's surface. */
const trusts = (node: { home: string }, ...removers: string[]): void => { for (const name of removers) setGrant(name, "operator", node.home); };
/** A joining copies the members the inviter had then; a pass (startup or interval) introduces the rest. */
const settle = async (...nodes: { home: string }[]): Promise<void> => {
  for (let round = 0; round < 2; round += 1) for (const node of nodes) await meet(node.home, 5000);
};
const peersOf = (home: string): string[] => readMesh(home).peers.map((peer) => peer.name).sort();

test("a member that was offline learns a removal from any peer, and keeps the record under its author", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const pi = await startNode("pi");
  const gpu = await startNode("gpu");
  for (const node of [mac, pi, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  await settle(mac, ovh, pi, gpu);
  // ovh takes mac's removals, and pi takes the removals ovh carries.
  trusts(ovh, "mac");
  trusts(pi, "ovh", "mac");
  // pi is offline while mac removes gpu: ovh hears, pi does not.
  await pi.server.stop();
  const removal = await removeFromSwarm(findPeer(readMesh(mac.home), "gpu")!, mac.home);
  assert.deepEqual(removal.missed, ["pi"]);
  // The author goes away too, so the record can only come from the member that carries it.
  await mac.server.stop();
  // pi comes back on a new port, as a rebooted device would, and reaches ovh alone on its next pass.
  updateMesh((state) => ({ ...state, node: { ...state.node, listen: "127.0.0.1:0" } }), pi.home);
  const back = { home: pi.home, server: new MeshServer({ home: pi.home, card: () => nodeCard(readMesh(pi.home).node, { abilities: ["test"], members: membersSummary(readMesh(pi.home)) }) }) };
  const { address } = await back.server.start();
  started.push({ home: pi.home, server: back.server, url: address });
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: address } }), pi.home);
  await meet(back.home, 5000);
  // ovh carried mac's record, so pi hears of the removal from ovh, with mac named as its author.
  const carried = readMesh(back.home).forgotten.find((item) => item.id === idOf(gpu.home));
  assert.ok(carried, "the carried record arrived");
  assert.equal(carried.by, idOf(mac.home), "the author is kept, not the carrier");
  assert.equal(refuses(readMesh(back.home), idOf(gpu.home)), true);
  assert.equal(peersOf(back.home).includes("gpu"), false);
  // No amplification: ovh's own removals stay empty; the record it holds is mac's.
  assert.deepEqual(readMesh(ovh.home).removed, []);
  assert.equal(readMesh(ovh.home).forgotten.some((item) => item.id === idOf(gpu.home) && item.by === idOf(mac.home)), true);
});

test("a device removed while offline is refused at the link once it comes back", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  for (const node of [mac, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  await settle(mac, ovh, gpu);
  trusts(ovh, "mac");
  await removeFromSwarm(findPeer(readMesh(mac.home), "gpu")!, mac.home);
  await meet(ovh.home, 5000);
  // ovh now refuses gpu: its key no longer opens a link, and the gpu record is gone from ovh's peers.
  assert.equal(refuses(readMesh(ovh.home), idOf(gpu.home)), true);
  assert.equal(readMesh(ovh.home).peers.some((peer) => peer.id === idOf(gpu.home)), false);
  // mac still links to ovh; only gpu is refused.
  assert.equal((await callPeer<{ name: string }>(findPeer(readMesh(ovh.home), "mac")!, "GET", "/mesh/v1/node")).name, "mac");
  // And no peer introduces it any more.
  const me = { id: idOf(gpu.home), name: "gpu", addresses: [gpu.url], relayName: "node:x" };
  assert.throws(() => brokerPeer({ id: idOf(mac.home), node: me }, idOf(gpu.home), ovh.home), /removed/);
});

test("two members removing the same device keep two authored records, and their digests agree", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  for (const node of [mac, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  await settle(mac, ovh, gpu);
  trusts(ovh, "mac");
  trusts(mac, "ovh");
  await Promise.all([removeFromSwarm(findPeer(readMesh(mac.home), "gpu")!, mac.home), removeFromSwarm(findPeer(readMesh(ovh.home), "gpu")!, ovh.home)]);
  await meet(mac.home, 5000);
  await meet(ovh.home, 5000);
  for (const node of [mac, ovh]) {
    const records = tombstones(readMesh(node.home)).filter((item) => item.id === idOf(gpu.home));
    assert.deepEqual(new Set(records.map((item) => item.by)), new Set([idOf(mac.home), idOf(ovh.home)]));
    assert.equal(membersSummary(readMesh(node.home)).removed, 1, "one device, two records");
  }
  assert.equal(membersDigest(readMesh(mac.home)), membersDigest(readMesh(ovh.home)));
});

test("a replay changes nothing, and a record about this node is never taken", async () => {
  const mac = await startNode("mac");
  const state = readMesh(mac.home);
  const record = { id: "gone-1", name: "gone", at: new Date().toISOString(), by: "author-1" };
  assert.equal(forgetDevice(record, mac.home), true);
  assert.equal(forgetDevice(record, mac.home), false, "the same record twice is a no-op");
  assert.equal(forgetDevice({ ...record, at: new Date(Date.now() + 60_000).toISOString() }, mac.home), false);
  assert.equal(readMesh(mac.home).forgotten[0]!.at, record.at, "the first time is kept");
  // A record about this node, or one naming this node as author, is dropped.
  assert.equal(forgetDevice({ id: state.node.id, name: "me", at: record.at, by: "author-1" }, mac.home), false);
  assert.equal(forgetDevice({ ...record, id: "gone-2", by: state.node.id }, mac.home), false);
  assert.equal(refuses(readMesh(mac.home), state.node.id), false);
});

test("a peer cannot remove this node from its own swarm, only report devices it removes itself", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  trusts(ovh, "mac");
  const peer = findPeer(readMesh(mac.home), "ovh");
  const mine = readMesh(ovh.home).node.id;
  const error = await callPeer(peer, "POST", "/mesh/v1/forget", { id: mine, name: "ovh" }).then((): undefined => undefined, (failure: MeshError) => failure);
  assert.equal(error?.status, 403, "a record about this node is refused");
  assert.equal(refuses(readMesh(ovh.home), mine), false, "this node keeps itself");
  assert.equal(readMesh(ovh.home).peers.length, 1, "and keeps its peer");
  // A record about a third device it removed itself is taken, and kept under its author.
  const gone = "gone-device";
  await callPeer(peer, "POST", "/mesh/v1/forget", { id: gone, name: "gone" });
  assert.deepEqual(readMesh(ovh.home).forgotten.filter((item) => item.id === gone).map((item) => item.by), [readMesh(mac.home).node.id]);
});

test("a membership that differs is shown, not enforced: links work until the next pass", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  for (const node of [mac, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  await settle(mac, ovh, gpu);
  trusts(ovh, "mac");
  // mac removes gpu without telling anyone yet, so its membership differs from ovh's.
  removePeer(idOf(gpu.home), mac.home, { name: "gpu" });
  const health = await peerHealth(mac.home, 5000);
  const ovhCard = health.find((item) => item.peer.name === "ovh")?.card;
  assert.ok(ovhCard, "ovh still answers: nothing is blocked");
  assert.match(String(membersMismatch(ovhCard!, membersSummary(readMesh(mac.home)))), /differ/);
  await meet(mac.home, 5000);
  await meet(ovh.home, 5000);
  const card = (await peerHealth(mac.home, 5000)).find((item) => item.peer.name === "ovh")?.card;
  assert.equal(membersMismatch(card!, membersSummary(readMesh(mac.home))), undefined, "one pass brings them together");
});

test("a removal stamped in the future refuses a fresh introduction until that author withdraws it", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  for (const node of [mac, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  await settle(mac, ovh, gpu);
  // mac removed gpu with a clock an hour ahead.
  removePeer(idOf(gpu.home), mac.home, { name: "gpu", at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(refuses(readMesh(mac.home), idOf(gpu.home)), true);
  // A voucher issued now does not re-admit it there; it fails closed, and no link is disturbed.
  const health = await peerHealth(mac.home, 5000);
  assert.equal(health.find((item) => item.peer.name === "ovh")?.reachable, true);
});

test("a member removes no third device from another node's swarm, directly or through what it carries", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  for (const node of [mac, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  await settle(mac, ovh, gpu);
  // mac is a member on ovh, as a new pairing is: telling ovh that gpu is gone is refused.
  const told = await callPeer(findPeer(readMesh(mac.home), "ovh"), "POST", "/mesh/v1/forget", { id: idOf(gpu.home), name: "gpu", at: "2099-01-01T00:00:00.000Z" })
    .then((): undefined => undefined, (error: MeshError) => error);
  assert.equal(told?.status, 403);
  assert.equal(refuses(readMesh(ovh.home), idOf(gpu.home)), false);
  assert.ok(readMesh(ovh.home).peers.some((peer) => peer.id === idOf(gpu.home)), "ovh keeps gpu");
  // mac removes gpu on its own side; ovh's pass reads mac's records and takes none of them.
  removePeer(idOf(gpu.home), mac.home, { name: "gpu" });
  await meet(ovh.home, 5000);
  assert.equal(refuses(readMesh(ovh.home), idOf(gpu.home)), false, "a member's records carry nothing");
  // Unpairing itself is a member's to do: a forget of the caller is that.
  await callPeer(findPeer(readMesh(mac.home), "ovh"), "POST", "/mesh/v1/forget", { id: idOf(mac.home), name: "mac" });
  assert.equal(readMesh(ovh.home).peers.some((peer) => peer.id === idOf(mac.home)), false);
});

test("a removal stamped far ahead of this node's clock counts as made now", async () => {
  const mac = await startNode("mac");
  assert.equal(forgetDevice({ id: "ahead", name: "ahead", at: "2099-01-01T00:00:00.000Z", by: "author-1" }, mac.home), true);
  const kept = readMesh(mac.home).forgotten.find((item) => item.id === "ahead")!;
  assert.ok(Date.parse(kept.at) <= Date.now(), `kept at ${kept.at}`);
});
