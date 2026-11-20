import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { advertisedAddresses, nodeCard, type NodeCard } from "./card.js";
import { callPeer, joinMesh, MeshError, peerHealth, unpair } from "./client.js";
import { parseListen } from "./listen.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, newPairKey, parseInvite, readMesh, updateMesh, type Peer } from "./state.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

interface TestNode { home: string; server: MeshServer; url: string }
const started: TestNode[] = [];

/** A node on a free localhost port, advertising that address, with its own mesh state. */
async function startNode(name: string): Promise<TestNode> {
  const home = mkdtempSync(join(tmpdir(), `swarm-mesh-${name}-`));
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const node = { home, server, url };
  started.push(node);
  return node;
}

afterEach(async () => {
  for (const node of started.splice(0)) {
    await node.server.stop();
    rmSync(node.home, { recursive: true, force: true });
  }
});

test("two nodes pair with an invite and call each other over links keyed with the secret they share", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const peer = await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  assert.equal(peer.name, "ovh");

  const fromMac = await callPeer<NodeCard>(findPeer(readMesh(mac.home), "ovh"), "GET", "/mesh/v1/node");
  assert.deepEqual([fromMac.name, fromMac.addresses, fromMac.abilities], ["ovh", [ovh.url], ["test"]]);
  const fromOvh = await callPeer<NodeCard>(findPeer(readMesh(ovh.home), "mac"), "GET", "/mesh/v1/node");
  assert.deepEqual([fromOvh.name, fromOvh.addresses], ["mac", [mac.url]]);

  const [macSide, ovhSide] = [readMesh(mac.home).peers[0]!, readMesh(ovh.home).peers[0]!];
  assert.equal(macSide.key, ovhSide.key, "both ends derived the same pair key");
  assert.notEqual(macSide.key, readMesh(mac.home).node.keys.privateKey);
  assert.equal(statSync(join(mac.home, "state.json")).mode & 0o777, 0o600);
});

test("a node refuses a device it shares no key with, and answers a paired one's unknown route with 404", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const stranger: Peer = { id: readMesh(ovh.home).node.id, name: "ovh", key: newPairKey(), addresses: [ovh.url], pairedAt: "" };
  await assert.rejects(callPeer(stranger, "GET", "/mesh/v1/node"), (error: MeshError) => error.status === 0 && /no longer knows this node/.test(error.message));
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  await assert.rejects(callPeer(findPeer(readMesh(mac.home), "ovh"), "GET", "/mesh/v1/nothing"), (error: MeshError) => error.status === 404);
});

test("an invite pairs once, not after it expired, and not with a wrong secret", async () => {
  const mac = await startNode("mac");
  const gpu = await startNode("gpu");
  const box = await startNode("box");
  const ovh = await startNode("ovh");
  const code = createInvite(ovh.url, 15, ovh.home);
  await joinMesh(code, mac.home);
  await assert.rejects(joinMesh(code, gpu.home), /unknown, used or expired/);

  const stale = createInvite(ovh.url, 15, ovh.home, new Date(Date.now() - 3600_000));
  await assert.rejects(joinMesh(stale, gpu.home), /expired/);
  const tampered = parseInvite(createInvite(ovh.url, 15, ovh.home));
  const wrong = `swarm-mesh:${Buffer.from(JSON.stringify({ ...tampered, secret: "a-secret-nobody-was-given" })).toString("base64url")}`;
  await assert.rejects(joinMesh(wrong, box.home), /code is wrong/);
  assert.deepEqual(readMesh(ovh.home).peers.map((peer) => peer.name), ["mac"]);
});

test("one invite brings the joiner into the swarm: the members it already had take it on first contact", async () => {
  const mac = await startNode("mac");
  const gpu = await startNode("gpu");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  await joinMesh(createInvite(ovh.url, 15, ovh.home), gpu.home);

  const macOnGpu = findPeer(readMesh(gpu.home), "mac");
  assert.equal(macOnGpu.introducedBy, readMesh(ovh.home).node.id);
  assert.ok(macOnGpu.voucher, "gpu carries ovh's word for it until mac has seen it");
  assert.equal(readMesh(mac.home).peers.some((peer) => peer.name === "gpu"), false, "mac hears of gpu only when gpu calls");

  const card = await callPeer<NodeCard>(macOnGpu, "GET", "/mesh/v1/node");
  assert.equal(card.name, "mac");
  assert.equal(findPeer(readMesh(mac.home), "gpu").key, macOnGpu.key);
  assert.equal((await callPeer<NodeCard>(findPeer(readMesh(mac.home), "gpu"), "GET", "/mesh/v1/node")).name, "gpu", "and mac calls gpu back");
  await peerHealth(gpu.home);
  assert.equal(findPeer(readMesh(gpu.home), "mac").voucher, undefined, "once accepted, the introduction is not shown again");
});

test("unpairing on one side forgets the pairing on both", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const macSeesOvh = findPeer(readMesh(mac.home), "ovh");
  const ovhSeesMac = findPeer(readMesh(ovh.home), "mac");

  assert.equal(await unpair(macSeesOvh, mac.home), true, "ovh heard");
  assert.deepEqual([readMesh(mac.home).peers, readMesh(ovh.home).peers], [[], []]);
  // A link opened before the unpairing is refused per request; a new one fails its handshake.
  const forgotten = (error: MeshError): boolean => error.status === 401 || (error.status === 0 && /no longer knows this node/.test(error.message));
  await assert.rejects(callPeer(macSeesOvh, "GET", "/mesh/v1/node"), forgotten);
  await assert.rejects(callPeer(ovhSeesMac, "GET", "/mesh/v1/node"), forgotten);
});

test("peer health reads each peer's card and marks a stopped peer unreachable", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const gpu = await startNode("gpu");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  await joinMesh(createInvite(gpu.url, 15, gpu.home), mac.home);
  await gpu.server.stop();

  const health = await peerHealth(mac.home, 2000);
  const byName = Object.fromEntries(health.map((item) => [item.peer.name, item]));
  assert.equal(byName.ovh?.reachable, true);
  assert.equal(byName.ovh?.card?.name, "ovh");
  assert.equal(byName.gpu?.reachable, false);
  assert.match(byName.gpu?.error ?? "", /unreachable/);
});

test("a call after a link sat idle until the peer's server closes it goes out on a new link", { timeout: 20_000 }, async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const peer = () => findPeer(readMesh(mac.home), "ovh");
  await callPeer(peer(), "GET", "/mesh/v1/node");
  // Node's server closes an idle link 5 s after its last answer, plus a second's grace: as a call that waits for a free
  // slot on a busy peer retries.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const card = await callPeer<NodeCard>(peer(), "GET", "/mesh/v1/node");
  assert.equal(card.name, "ovh");
});

test("parses listen addresses with hosts, IPv6 brackets and bare ports", () => {
  assert.deepEqual(parseListen("100.64.0.7:38172"), { host: "100.64.0.7", port: 38172 });
  assert.deepEqual(parseListen("[::]:38172"), { host: "::", port: 38172 });
  assert.deepEqual(parseListen("38172"), { host: "127.0.0.1", port: 38172 });
  assert.throws(() => parseListen("mac:http"), /host:port/);
});

test("a node offers its configured address and the concrete address it binds", async () => {
  const node = { listen: "100.64.0.7:38172" };
  assert.deepEqual(await advertisedAddresses(node), ["100.64.0.7:38172"]);
  assert.deepEqual(await advertisedAddresses({ ...node, advertise: "gpu.example:9000" }), ["gpu.example:9000", "100.64.0.7:38172"]);
  assert.deepEqual(await advertisedAddresses({ ...node, advertise: "http://gpu.example:9000/" }), ["gpu.example:9000", "100.64.0.7:38172"], "an older URL form still works");
  assert.deepEqual(await advertisedAddresses({ listen: "[fd7a::1]:38172" }), ["[fd7a::1]:38172"]);
});
