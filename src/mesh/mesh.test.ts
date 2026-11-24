import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { advertisedAddresses, nodeCard, type NodeCard } from "./card.js";
import { callPeer, joinMesh, meet, MeshError, peerHealth, removeFromSwarm, unpair } from "./client.js";
import { parseListen } from "./listen.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, grantOf, membersSummary, newPairKey, parseInvite, readMesh, setGrant, updateMesh, type Peer } from "./state.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

interface TestNode { home: string; server: MeshServer; url: string }
const started: TestNode[] = [];

/** A node on a free localhost port, advertising that address, with its own mesh state; `home` brings one back. */
async function startNode(name: string, home = mkdtempSync(join(tmpdir(), `swarm-mesh-${name}-`))): Promise<TestNode> {
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"], members: membersSummary(readMesh(home)) }) });
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

test("a node's card tells each caller the grant it gives that caller", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const read = () => callPeer<NodeCard>(findPeer(readMesh(mac.home), "ovh"), "GET", "/mesh/v1/node");
  assert.equal((await read()).yourGrant, grantOf(findPeer(readMesh(ovh.home), "mac"), ovh.home));
  setGrant("mac", "viewer", ovh.home);
  assert.equal((await read()).yourGrant, "viewer");
  setGrant("mac", { scopes: ["node.read", "work.offer"] }, ovh.home);
  assert.deepEqual((await read()).yourGrant, { scopes: ["node.read", "work.offer"] });
});

test("a node's card names why its harnesses cannot run there, and says nothing when every one can", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-mesh-card-"));
  try {
    const node = readMesh(home).node;
    assert.equal((await nodeCard(node, { abilities: ["linux"], harnessProblems: {} })).harnessProblems, undefined);
    assert.deepEqual((await nodeCard(node, { abilities: ["linux"], harnessProblems: { codex: "Codex is not installed" } })).harnessProblems,
      { codex: "Codex is not installed" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test("a meeting hands on the pass read after it learned a removal, without the peer it dropped", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const pi = await startNode("pi");
  const gpu = await startNode("gpu");
  for (const node of [mac, pi, gpu]) await joinMesh(createInvite(ovh.url, 15, ovh.home), node.home);
  for (let round = 0; round < 2; round += 1) for (const node of [mac, ovh, pi, gpu]) await meet(node.home, 5000);
  // ovh takes mac's removals, and pi takes the removals both make or carry.
  setGrant("mac", "operator", ovh.home);
  for (const name of ["mac", "ovh"]) setGrant(name, "operator", pi.home);
  // pi is offline while mac removes gpu, so it learns of the removal on its next meeting; gpu still answers it.
  await pi.server.stop();
  await removeFromSwarm(findPeer(readMesh(mac.home), "gpu"), mac.home);
  await startNode("pi", pi.home);
  const pass = await meet(pi.home, 5000);
  assert.equal(readMesh(pi.home).peers.some((peer) => peer.name === "gpu"), false, "pi dropped gpu");
  assert.deepEqual(pass.map((item) => [item.peer.name, item.reachable]).sort(), [["mac", true], ["ovh", true]]);
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
