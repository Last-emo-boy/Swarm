import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { nodeCard, type NodeCard } from "./card.js";
import { callPeer, joinMesh, MeshError, meshFetch, peerHealth, unpair } from "./client.js";
import { MeshServer, parseListen } from "./server.js";
import { createInvite, findPeer, parseInvite, readMesh, updateMesh } from "./state.js";

interface TestNode { home: string; server: MeshServer; url: string }
const started: TestNode[] = [];

/** A node on a free localhost port, advertising that address, with its own mesh state. */
async function startNode(name: string): Promise<TestNode> {
  const home = mkdtempSync(join(tmpdir(), `swarm-mesh-${name}-`));
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  const { url } = await server.start();
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

test("two nodes pair with an invite and call each other with the tokens they issued", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  const peer = await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  assert.equal(peer.name, "ovh");

  const fromMac = await callPeer<NodeCard>(findPeer(readMesh(mac.home), "ovh"), "GET", "/mesh/v1/node");
  assert.deepEqual([fromMac.name, fromMac.url, fromMac.abilities], ["ovh", ovh.url, ["test"]]);
  const fromOvh = await callPeer<NodeCard>(findPeer(readMesh(ovh.home), "mac"), "GET", "/mesh/v1/node");
  assert.deepEqual([fromOvh.name, fromOvh.url], ["mac", mac.url]);

  const stored = readMesh(mac.home).peers[0]!;
  assert.notEqual(stored.token, readMesh(ovh.home).peers[0]!.token, "each side issued its own token");
  assert.equal(statSync(join(mac.home, "state.json")).mode & 0o777, 0o600);
});

test("a node refuses calls without a token it issued, and keeps health open", async () => {
  const ovh = await startNode("ovh");
  assert.deepEqual(await meshFetch(ovh.url, "/mesh/v1/health"), { ok: true, id: readMesh(ovh.home).node.id });
  await assert.rejects(meshFetch(ovh.url, "/mesh/v1/node"), (error: MeshError) => error.status === 401);
  await assert.rejects(meshFetch(ovh.url, "/mesh/v1/node", { token: "not-a-token-anyone-was-given" }), (error: MeshError) => error.status === 401);
  await assert.rejects(meshFetch(ovh.url, "/mesh/v1/nothing"), (error: MeshError) => error.status === 404);
});

test("an invite pairs once, and not after it expired", async () => {
  const mac = await startNode("mac");
  const gpu = await startNode("gpu");
  const ovh = await startNode("ovh");
  const code = createInvite(ovh.url, 15, ovh.home);
  await joinMesh(code, mac.home);
  await assert.rejects(joinMesh(code, gpu.home), (error: MeshError) => error.status === 403);

  const stale = createInvite(ovh.url, 15, ovh.home, new Date(Date.now() - 3600_000));
  await assert.rejects(joinMesh(stale, gpu.home), /expired/);
  const pair = { secret: parseInvite(stale).secret, node: { id: "gpu-id", name: "gpu", url: gpu.url }, token: "a-token-the-joiner-issues" };
  await assert.rejects(meshFetch(ovh.url, "/mesh/v1/pair", { method: "POST", body: pair }), (error: MeshError) => error.status === 403);
  assert.deepEqual(readMesh(ovh.home).peers.map((peer) => peer.name), ["mac"]);
});

test("unpairing on one side forgets the pairing on both", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const macSeesOvh = findPeer(readMesh(mac.home), "ovh");
  const ovhSeesMac = findPeer(readMesh(ovh.home), "mac");

  assert.equal(await unpair(macSeesOvh, mac.home), true, "ovh heard");
  assert.deepEqual([readMesh(mac.home).peers, readMesh(ovh.home).peers], [[], []]);
  await assert.rejects(callPeer(macSeesOvh, "GET", "/mesh/v1/node"), (error: MeshError) => error.status === 401);
  await assert.rejects(callPeer(ovhSeesMac, "GET", "/mesh/v1/node"), (error: MeshError) => error.status === 401);
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

test("parses listen addresses with hosts, IPv6 brackets and bare ports", () => {
  assert.deepEqual(parseListen("100.64.0.7:38172"), { host: "100.64.0.7", port: 38172 });
  assert.deepEqual(parseListen("[::]:38172"), { host: "::", port: 38172 });
  assert.deepEqual(parseListen("38172"), { host: "127.0.0.1", port: 38172 });
  assert.throws(() => parseListen("mac:http"), /host:port/);
});
