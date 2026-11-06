import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, afterEach, test } from "node:test";
import { WebSocket } from "ws";
import { nodeCard, type NodeCard } from "./card.js";
import { callPeer } from "./client.js";
import { describePath, pathTo } from "./link.js";
import { inviteWithCode, joinWithCode } from "./pair.js";
import { RelayError, RelayListener, RelayServer, openMailbox, relayDial, type RelayLimits } from "./relay.js";
import { MeshServer } from "./server.js";
import { findPeer, readMesh, relayName, updateMesh, type MeshNode } from "./state.js";

// Every node here uses a relay this file starts, never a real one.
process.env.SWARM_MESH_RELAY = "off";

const root = mkdtempSync(join(tmpdir(), "swarm-mesh-relay-"));
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
after(() => rmSync(root, { recursive: true, force: true }));

/** A node key pair, as a node's mesh state holds it. */
function nodeKeys(): MeshNode["keys"] {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}

async function relayWith(limits: Partial<RelayLimits> = {}): Promise<{ relay: RelayServer; url: string }> {
  const relay = new RelayServer(() => {}, limits);
  const { url } = await relay.start("127.0.0.1:0");
  cleanup.push(() => relay.stop());
  return { relay, url };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 300) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A node listening at the relay under its key's name; every stream it takes echoes what it reads. */
async function listening(relay: RelayServer, url: string): Promise<{ name: string; streams: Duplex[] }> {
  const keys = nodeKeys();
  const streams: Duplex[] = [];
  const before = relay.stats().listeners;
  const listener = new RelayListener(url, keys, (stream) => { streams.push(stream); stream.pipe(stream); });
  listener.start();
  cleanup.push(() => listener.close());
  await until(() => relay.stats().listeners > before);
  return { name: relayName(keys.publicKey), streams };
}

/** Sends `bytes` down a stream and reads them back from the echoing node on the other end. */
async function echoes(stream: Duplex, bytes: string): Promise<string> {
  const back = new Promise<string>((resolve) => stream.once("data", (chunk: Buffer) => resolve(chunk.toString())));
  stream.write(bytes);
  return back;
}

/** Dials `name` with a raw WebSocket, answers the relay's challenge with `reply`, and reports how the relay closed it. */
function dialAnswering(url: string, name: string, reply: (challenge: string) => unknown): Promise<{ code: number; reason: string; ready: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/v1/dial?name=${encodeURIComponent(name)}`);
    let ready = false;
    ws.on("message", (data) => {
      if (String(data) === "ready") { ready = true; return; }
      const { challenge } = JSON.parse(String(data)) as { challenge: string };
      ws.send(JSON.stringify(reply(challenge)));
    });
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString(), ready }));
  });
}

/** Waits past the last few seconds of a minute, so counts per minute in one test all land in the same minute. */
async function freshMinute(): Promise<void> {
  const left = 60_000 - Date.now() % 60_000;
  if (left < 5000) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

test("a dial to a node must be signed: the relay refuses an unsigned dial and one signed by another key than it presents", async () => {
  const { relay, url } = await relayWith();
  const node = await listening(relay, url);
  const presented = nodeKeys();
  const other = nodeKeys();
  const signedBy = (keys: MeshNode["keys"], challenge: string): string =>
    sign(null, Buffer.from(`swarm-relay/dial/v1|${challenge}|${node.name}`), createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), format: "der", type: "pkcs8" })).toString("base64");

  const unsigned = await dialAnswering(url, node.name, () => ({}));
  assert.deepEqual([unsigned.code, unsigned.ready], [4403, false]);
  assert.match(unsigned.reason, /must be signed/);
  const forged = await dialAnswering(url, node.name, (challenge) => ({ publicKey: presented.publicKey, signature: signedBy(other, challenge) }));
  assert.deepEqual([forged.code, forged.ready], [4403, false]);
  const ownMessage = await dialAnswering(url, node.name, (challenge) => ({ publicKey: other.publicKey, signature: signedBy(other, `${challenge}x`) }));
  assert.equal(ownMessage.code, 4403, "a signature over another challenge does not count");
  assert.equal(node.streams.length, 0, "the node never heard of a refused dial");
  assert.deepEqual(relay.stats().refused, { signature: 3, limit: 0 });

  await assert.rejects(relayDial(url, node.name), /takes only dials signed by a node's key/, "a client without a key says why it gives up");
  const stream = await relayDial(url, node.name, other);
  assert.equal(await echoes(stream, "hello"), "hello");
  stream.destroy();
});

test("a dial to a pairing code's mailbox needs no signature, and has its own tight limit per address", async () => {
  const { relay, url } = await relayWith({ codeDialsPerAddress: 2 });
  await freshMinute();
  const taken: Duplex[] = [];
  const mailbox = await openMailbox(url, 5, (stream) => { taken.push(stream); stream.pipe(stream); });
  cleanup.push(() => mailbox.close());
  const stream = await relayDial(url, `code:${mailbox.mailbox}`);
  assert.equal(await echoes(stream, "pair"), "pair");
  stream.destroy();
  await assert.rejects(relayDial(url, "code:ZZ"), /No device is waiting/);
  await assert.rejects(relayDial(url, `code:${mailbox.mailbox}`), (error: RelayError) =>
    error.code === 4429 && /Too many pairing attempts from this address this minute; the relay allows 2/.test(error.message));
  assert.equal(relay.stats().refused.limit, 1);
});

test("the relay limits dials per signing key and streams per listener, and a client over a limit is told which", async () => {
  const { relay, url } = await relayWith({ dialsPerKey: 2, streamsPerListener: 2 });
  await freshMinute();
  const node = await listening(relay, url);
  const busy = nodeKeys();
  const first = await relayDial(url, node.name, busy);
  const second = await relayDial(url, node.name, busy);
  await assert.rejects(relayDial(url, node.name, busy), (error: RelayError) =>
    error.code === 4429 && /Too many dials signed by this node this minute; the relay allows 2/.test(error.message));
  await assert.rejects(relayDial(url, node.name, nodeKeys()), /Too many streams to this node at the relay; it allows 2 at a time/,
    "another node's dial is within its own limit, but the node already has as many streams as it may");
  first.destroy();
  await until(() => relay.stats().streams === 1);
  const third = await relayDial(url, node.name, nodeKeys());
  assert.equal(await echoes(third, "again"), "again");
  for (const stream of [second, third]) stream.destroy();
  assert.deepEqual(relay.stats().refused, { signature: 0, limit: 2 });
});

test("the relay answers health and counts at /v1/health, beside /healthz, and nothing else", async () => {
  const { relay, url } = await relayWith();
  const node = await listening(relay, url);
  const mailbox = await openMailbox(url, 5, () => {});
  cleanup.push(() => mailbox.close());
  const stream = await relayDial(url, node.name, nodeKeys());
  await until(() => relay.stats().streams === 1);
  await dialAnswering(url, node.name, () => ({}));
  const http = url.replace(/^ws:/, "http:");
  const health = await fetch(`${http}/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  const body = await health.json();
  assert.deepEqual(body, { ok: true, listeners: 1, mailboxes: 1, streams: 1, waiting: 0, refused: { signature: 1, limit: 0 } });
  assert.deepEqual(await (await fetch(`${http}/healthz`)).json(), body);
  assert.equal((await fetch(`${http}/v1/nothing`)).status, 404);
  stream.destroy();
});

/** A stand-in for what can sit in front of a relay: answers every WebSocket upgrade with this HTTP response. */
async function answering(response: string): Promise<string> {
  const server: Server = createServer((_request, reply) => reply.writeHead(404).end());
  server.on("upgrade", (_request, socket) => socket.end(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("an HTTP answer in front of the relay, such as Cloudflare's 403, is reported as such instead of a bare close", async () => {
  const cloudflare = await answering("HTTP/1.1 403 Forbidden\r\nserver: cloudflare\r\ncf-ray: 8f00000000000000-CDG\r\ncontent-type: text/html\r\ncontent-length: 21\r\nconnection: close\r\n\r\n<html>Blocked</html>\n");
  const said = `the relay at ${cloudflare} answered HTTP 403: a Cloudflare challenge or block rule in front of the relay refused this connection`;
  await assert.rejects(relayDial(cloudflare, "node:abcdefghijklmnopqrstuv", nodeKeys()), (error: RelayError) => error.message === said);
  await assert.rejects(openMailbox(cloudflare, 5, () => {}), (error: RelayError) => error.message === said);
  const listener = new RelayListener(cloudflare, nodeKeys(), () => {});
  listener.start();
  cleanup.push(() => listener.close());
  await until(() => listener.lastError !== undefined);
  assert.equal(listener.lastError, said);

  const proxy = await answering("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  await assert.rejects(relayDial(proxy, "code:AB"), /answered HTTP 502: the proxy in front of it cannot reach the relay, or the relay is down$/);
});

test("a node reaches a peer through the relay signed as itself, whichever home its peer record came from", async () => {
  // One dial per key: were two devices in this process to sign as the same node, the second would be refused.
  const { relay, url } = await relayWith({ dialsPerKey: 1 });
  await freshMinute();
  const device = (name: string): string => {
    const home = join(root, name);
    updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0", advertise: "127.0.0.1:9", relay: url } }), home);
    return home;
  };
  const ovh = device("ovh");
  const server = new MeshServer({ home: ovh, card: () => nodeCard(readMesh(ovh).node, { abilities: ["test"] }) });
  await server.start("127.0.0.1:0", { relay: url });
  cleanup.push(() => server.stop());
  await until(() => relay.stats().listeners === 1);
  for (const name of ["mac", "box"]) {
    const home = device(name);
    const invitation = await inviteWithCode({ home: ovh });
    await joinWithCode(invitation.code, home).finally(() => invitation.close());
    const peer = findPeer(readMesh(home), "ovh");
    assert.equal(peer.home, home);
    assert.equal((await callPeer<NodeCard>(peer, "GET", "/mesh/v1/node")).name, "ovh");
    assert.equal(describePath(pathTo(peer.id)), "via relay");
  }
  assert.deepEqual(relay.stats().refused, { signature: 0, limit: 0 });
});
