/** The self-organizing half of the mesh: a node opens pairing codes on its own, and membership repairs itself. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MeshAdmin, adminSocket, askAdmin } from "./admin.js";
import { nodeCard } from "./card.js";
import { callPeer, joinMesh, meet, peerHealth } from "./client.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, readMesh, removePeer, updateMesh } from "./state.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const started: { home: string; server: MeshServer; url: string }[] = [];
const admins: MeshAdmin[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const admin of admins.splice(0)) await admin.stop();
  for (const node of started.splice(0)) {
    await node.server.stop();
    rmSync(node.home, { recursive: true, force: true });
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function startNode(name: string) {
  const home = mkdtempSync(join(tmpdir(), `swarm-selforg-${name}-`));
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const node = { home, server, url };
  started.push(node);
  return node;
}

/** A device's own id, as its state records it. */
const idOf = (home: string): string => readMesh(home).node.id;
const peersOf = (home: string): string[] => readMesh(home).peers.map((peer) => peer.name).sort();

test("a running node opens a pairing code itself, and asking twice keeps the one it has", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-admin-"));
  homes.push(home);
  let closed = 0;
  const started_: string[] = [];
  const admin = new MeshAdmin({ home, open: async (minutes) => {
    started_.push(`opened for ${minutes}`);
    let end: (reason: string) => void = () => {};
    const ended = new Promise<string>((resolve) => { end = resolve; });
    return { code: "AB12-CD34", expiresAt: new Date(Date.now() + minutes * 60_000), ended, close: () => { closed += 1; end("closed"); } };
  } });
  admins.push(admin);
  await admin.start();
  assert.equal(existsSync(adminSocket(home)), true, "the control socket is there while the node runs");
  assert.deepEqual(await askAdmin(home, 15), { code: "AB12-CD34", expiresAt: (await askAdmin(home, 15))!.expiresAt });
  assert.deepEqual(started_, ["opened for 15"], "a second ask during the same code opens nothing");
  await admin.stop();
  assert.equal(existsSync(adminSocket(home)), false, "the socket goes with the node");
  assert.equal(closed, 1);
  assert.equal(await askAdmin(home, 15), undefined, "no node answers once it stopped");
});

test("a member two devices both lack is introduced by any peer they share, and both ends get the same key", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  // Both join ovh, which pairs them with every member it has: mac and gpu end up introduced to each other only through ovh.
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  await joinMesh(createInvite(ovh.url, 15, ovh.home), gpu.home);
  // Now take that introduction away on both sides, as an expired voucher or a device paired before the other would leave it.
  removePeer(idOf(gpu.home), mac.home);
  removePeer(idOf(mac.home), gpu.home);
  assert.deepEqual(peersOf(mac.home), ["ovh"]);
  assert.deepEqual(peersOf(gpu.home), ["ovh"]);

  await meet(mac.home, 5000);
  await meet(gpu.home, 5000);

  assert.deepEqual(peersOf(mac.home), ["gpu", "ovh"]);
  assert.deepEqual(peersOf(gpu.home), ["mac", "ovh"]);
  const fromMac = findPeer(readMesh(mac.home), "gpu")!;
  const fromGpu = findPeer(readMesh(gpu.home), "mac")!;
  assert.equal(fromMac.key, fromGpu.key, "both ends hold the key the shared peer minted");
  assert.equal(fromMac.introducedBy, idOf(ovh.home));
  assert.equal((await callPeer<{ name: string }>(fromMac, "GET", "/mesh/v1/node")).name, "gpu");
});

test("a broker introduces only its caller, and only to a peer it has", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  await joinMesh(createInvite(ovh.url, 15, ovh.home), gpu.home);
  removePeer(idOf(gpu.home), mac.home);
  const asMac = findPeer(readMesh(mac.home), "ovh")!;
  const me = { id: idOf(mac.home), name: "mac", addresses: [mac.url], relayName: "node:x" };
  // A device may not claim to be another when asking for an introduction.
  await assert.rejects(callPeer(asMac, "POST", "/mesh/v1/broker", { id: idOf(gpu.home), node: { ...me, id: "someone-else" } }),
    /only introduce the device that sends it/);
  // A peer this node does not have is not introduced, removed or never paired.
  await assert.rejects(callPeer(asMac, "POST", "/mesh/v1/broker", { id: "not-a-peer", node: me }), /no peer not-a-peer/);
});

test("a pass takes up the address a peer announces now, so a device that moved is dialled at its new one", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  // ovh announces a new address (it still answers at the old one here, as a node reachable through the relay would).
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: "127.0.0.1:9" } }), ovh.home);
  assert.deepEqual(findPeer(readMesh(mac.home), "ovh")!.addresses, [ovh.url]);
  await meet(mac.home, 5000);
  assert.deepEqual(findPeer(readMesh(mac.home), "ovh")!.addresses, ["127.0.0.1:9"], "the card names where it is reached now");
});
