import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { WebSocket } from "ws";
import { nodeCard, type NodeCard } from "./card.js";
import { callPeer, peerHealth, removeFromSwarm } from "./client.js";
import { describePath, pathTo } from "./link.js";
import { formatCode, inviteWithCode, joinWithCode, parseCode } from "./pair.js";
import { RelayServer, relayDial } from "./relay.js";
import { MeshServer } from "./server.js";
import { findPeer, readMesh, relayName, updateMesh } from "./state.js";

// Every node here uses the relay this file starts, never a real one.
process.env.SWARM_MESH_RELAY = "off";

const root = mkdtempSync(join(tmpdir(), "swarm-mesh-pair-"));
let relay: RelayServer;
let relayUrl: string;
const servers: MeshServer[] = [];

before(async () => {
  relay = new RelayServer();
  relayUrl = (await relay.start("127.0.0.1:0")).url;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
after(async () => {
  await relay.stop();
  rmSync(root, { recursive: true, force: true });
});

let homes = 0;
/** A device's mesh state that uses the test relay; `reachable: false` gives it a direct address nothing answers on. */
function device(name: string): string {
  const home = join(root, `${name}-${homes += 1}`);
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0", advertise: "127.0.0.1:9", relay: relayUrl } }), home);
  return home;
}

/** A device that runs its node: it listens at the relay, and directly on a free port when `direct`. */
async function node(name: string, direct = false): Promise<string> {
  const home = device(name);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  const { address } = await server.start("127.0.0.1:0", { relay: relayUrl });
  servers.push(server);
  if (direct) updateMesh((state) => ({ ...state, node: { ...state.node, advertise: address } }), home);
  await until(() => relay.stats().listeners >= servers.length);
  return home;
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Opens a code on `home` and joins it from `joiner`. */
async function joinByCode(home: string, joiner: string): Promise<ReturnType<typeof joinWithCode>> {
  const invitation = await inviteWithCode({ home });
  try {
    return await joinWithCode(invitation.code, joiner);
  } finally {
    invitation.close();
  }
}

test("reads a code as a person types it", () => {
  assert.deepEqual(parseCode("k7qm-4zx2"), { mailbox: "K7", password: "QM4ZX2" });
  assert.deepEqual(parseCode(" K7QM 4ZX2 "), { mailbox: "K7", password: "QM4ZX2" });
  assert.deepEqual(parseCode("K7QM-4ZXO"), { mailbox: "K7", password: "QM4ZX0" }, "O is read as 0");
  assert.deepEqual(parseCode("K7QM-4ZXl"), { mailbox: "K7", password: "QM4ZX1" }, "l is read as 1");
  assert.deepEqual(parseCode("K7QM-4ZX2@relay.example"), { mailbox: "K7", password: "QM4ZX2", relay: "wss://relay.example" });
  assert.equal(parseCode("K7QM-4ZX"), undefined);
  assert.equal(parseCode("K7QM-4ZXU"), undefined, "U is not in the alphabet");
  assert.equal(formatCode("K7", "QM4ZX2"), "K7QM-4ZX2");
  assert.equal(formatCode("K7", "QM4ZX2", "wss://relay.example"), "K7QM-4ZX2@relay.example");
});

test("connections to the relay say they come from Swarm, which Cloudflare in front of a relay requires", async () => {
  const seen: string[] = [];
  const probe = new RelayServer();
  const { url } = await probe.start("127.0.0.1:0");
  const server = (probe as unknown as { server: import("node:http").Server }).server;
  server.prependListener("upgrade", (request: import("node:http").IncomingMessage) => seen.push(request.headers["user-agent"] ?? ""));
  await assert.rejects(relayDial(url, "node:nobody-listens-here-at-all", readMesh(device("probe")).node.keys), /not listening/);
  await probe.stop();
  assert.match(seen[0] ?? "", /^Swarm\/\S+ \(mesh relay client\)$/);
});

test("the relay lets only a key's holder listen under its name, and says when nobody listens", async () => {
  const home = device("lone");
  const name = relayName(readMesh(home).node.keys.publicKey);
  await assert.rejects(relayDial(relayUrl, name, readMesh(device("caller")).node.keys), /not listening at the relay/);
  await assert.rejects(relayDial(relayUrl, "code:ZZ"), /No device is waiting/);
  const impostor = new WebSocket(`${relayUrl}/v1/listen?name=${encodeURIComponent(name)}`);
  const other = readMesh(device("other")).node.keys;
  const closed = await new Promise<number>((resolve) => {
    impostor.once("message", () => impostor.send(JSON.stringify({ publicKey: other.publicKey, signature: Buffer.alloc(64).toString("base64") })));
    impostor.once("close", (code) => resolve(code));
  });
  assert.equal(closed, 4403);
});

test("a short code joins through the relay, and a node nothing reaches directly is reached through it", async () => {
  const ovh = await node("ovh");
  const mac = device("mac");
  const { inviter, members } = await joinByCode(ovh, mac);
  assert.deepEqual([inviter.name, members], ["ovh", []]);
  assert.equal(findPeer(readMesh(ovh), "mac").key, inviter.key);

  const card = await callPeer<NodeCard>(findPeer(readMesh(mac), "ovh"), "GET", "/mesh/v1/node");
  assert.equal(card.name, "ovh");
  assert.equal(describePath(pathTo(inviter.id)), "via relay", "its only address answers nothing");
});

test("a link goes direct when the peer's address answers", async () => {
  const gpu = await node("gpu", true);
  const mac = device("mac");
  const { inviter } = await joinByCode(gpu, mac);
  await callPeer(findPeer(readMesh(mac), "gpu"), "GET", "/mesh/v1/node");
  assert.match(describePath(pathTo(inviter.id)), /^direct \(127\.0\.0\.1:\d+\)$/);
});

test("one code joins the whole swarm: a device that joins through any member reaches the others", async () => {
  const ovh = await node("ovh");
  const gpu = await node("gpu");
  const mac = device("mac");
  await joinByCode(ovh, gpu);
  // mac joins through gpu, which runs no invite server of its own here: the code works from any member.
  const { inviter, members } = await joinByCode(gpu, mac);
  assert.deepEqual([inviter.name, members.map((member) => member.name)], ["gpu", ["ovh"]]);

  const health = await peerHealth(mac);
  assert.deepEqual(health.map((item) => [item.peer.name, item.reachable]).sort(), [["gpu", true], ["ovh", true]]);
  const macOnOvh = findPeer(readMesh(ovh), "mac");
  assert.equal(macOnOvh.introducedBy, readMesh(gpu).node.id, "ovh took gpu's word for mac");
  assert.equal(findPeer(readMesh(mac), "ovh").voucher, undefined, "once ovh took it, mac stops showing the introduction");
});

test("wrong codes are refused, and three of them cancel the code", async () => {
  const ovh = await node("ovh");
  const refused: number[] = [];
  const invitation = await inviteWithCode({ home: ovh, onRefused: (left) => refused.push(left) });
  const { mailbox, password } = parseCode(invitation.code)!;
  const wrong = formatCode(mailbox, password === "000000" ? "111111" : "000000", relayUrl);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(joinWithCode(wrong, device("guess")), /code is wrong/);
  assert.deepEqual(refused, [2, 1, 0]);
  assert.match(await invitation.ended, /cancelled/);
  await assert.rejects(joinWithCode(invitation.code, device("late")), /No device is waiting for this code/);
  assert.deepEqual(readMesh(ovh).peers, []);
});

test("a device already in the swarm cannot join it again, so no device can take over a member's id", async () => {
  const ovh = await node("ovh");
  const mac = device("mac");
  await joinByCode(ovh, mac);
  await assert.rejects(joinByCode(ovh, mac), /already in the swarm as mac/);
  assert.deepEqual(readMesh(ovh).peers.map((peer) => peer.name), ["mac"]);
});

test("a device removed from the swarm is forgotten by every member, which then refuses its introductions", async () => {
  const ovh = await node("ovh");
  const gpu = await node("gpu");
  await joinByCode(ovh, gpu);
  const box = await node("box");
  await joinByCode(ovh, box);
  const boxSeesGpu = findPeer(readMesh(box), "gpu");
  assert.ok(boxSeesGpu.voucher, "box has not met gpu yet");

  const { told, missed } = await removeFromSwarm(findPeer(readMesh(ovh), "box"), ovh);
  assert.deepEqual([told, missed], [true, []]);
  assert.deepEqual(readMesh(ovh).removed.map((item) => item.name), ["box"]);
  assert.deepEqual(readMesh(gpu).removed.map((item) => item.name), ["box"], "gpu heard of box's removal before it ever met box");
  await assert.rejects(callPeer(boxSeesGpu, "GET", "/mesh/v1/node"), /no longer knows this node/);
  assert.equal(readMesh(gpu).peers.some((peer) => peer.name === "box"), false);
  assert.equal(readMesh(box).peers.some((peer) => peer.name === "ovh"), false, "box was told to forget ovh");

  // Asked back in with a new code, box gets new introductions, and gpu takes them.
  await joinByCode(ovh, box);
  assert.equal((await callPeer<NodeCard>(findPeer(readMesh(box), "gpu"), "GET", "/mesh/v1/node")).name, "gpu");
});
