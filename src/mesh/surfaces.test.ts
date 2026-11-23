/**
 * The positive surface table: every route a paired node reaches is named there before it can be registered, and its grant
 * decides whether a call is served. A route added without a line in surfaces.ts fails these tests here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SuperagentClient } from "../superagent/client.js";
import { nodeCard } from "./card.js";
import { callPeer, joinMesh, type MeshError } from "./client.js";
import { registerLending } from "./lend.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, grantOf, newPairKey, readMesh, removePeer, savePeer, setGrant, updateMesh } from "./state.js";
import { MESH_ROUTES, MESH_SURFACES, surfaceOf, type MeshSurface } from "./surfaces.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const started: { home: string; server: MeshServer; url: string }[] = [];
const clients: SuperagentClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const node of started.splice(0)) {
    await node.server.stop();
    rmSync(node.home, { recursive: true, force: true });
  }
});

async function startNode(name: string): Promise<{ home: string; server: MeshServer; url: string }> {
  const home = mkdtempSync(join(tmpdir(), `swarm-surfaces-${name}-`));
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const node = { home, server, url };
  started.push(node);
  return node;
}

test("every route of the table names a surface of the table, and surfaceOf finds it", () => {
  const seen = new Set<string>();
  for (const route of MESH_ROUTES) {
    assert.ok((MESH_SURFACES as readonly string[]).includes(route.surface), `${route.method} ${route.path} names ${route.surface}`);
    assert.equal(surfaceOf(route.method, route.path), route.surface, `${route.method} ${route.path}`);
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), `${key} is named once`);
    seen.add(key);
  }
  assert.equal(surfaceOf("GET", "/mesh/v1/nothing"), undefined);
  assert.equal(surfaceOf("POST", "/mesh/v1/node"), undefined, "a method on another route's path is not that route");
});

test("a route the table does not name is refused at registration", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-surfaces-bare-"));
  started.push({ home, server: new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) }), url: "" });
  const server = started.at(-1)!.server;
  assert.throws(() => server.route("GET", "/mesh/v1/everything", () => ({})), /No mesh surface for GET \/mesh\/v1\/everything/);
  assert.throws(() => server.route("DELETE", "/mesh/v1/node", () => ({})), /No mesh surface for DELETE \/mesh\/v1\/node/);
  assert.deepEqual(server.routes.filter((route) => route.path === "/mesh/v1/everything"), []);
});

test("every route the server serves carries a surface, core and ticket routes alike", async () => {
  const node = await startNode("mac");
  const client = new SuperagentClient({ stateDir: join(node.home, "superagent") });
  clients.push(client);
  registerLending(node.server);
  const { registerTicketRoutes } = await import("./tickets.js");
  const { registerUsage } = await import("./usage.js");
  registerTicketRoutes(node.server, client, { commandText: async () => "", requestHeld: () => undefined });
  registerUsage(node.server, { databasePath: () => join(node.home, "ledger.db") });
  const served = new Set(node.server.routes.map((route) => route.surface));
  for (const surface of ["node.read", "node.peers", "tickets.read", "tickets.submit", "tickets.stop", "commands.read"] as const) {
    assert.ok(served.has(surface), `${surface} is served here`);
  }
  for (const route of node.server.routes) {
    assert.ok((MESH_SURFACES as readonly string[]).includes(route.surface), `${route.method} ${route.path} carries ${route.surface}`);
    assert.equal(surfaceOf(route.method, route.path), route.surface);
  }
});

test("a grant decides which surfaces a peer's calls reach", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh");
  // Stand-ins for the routes other modules serve, so the matrix needs no ticket host or worker.
  ovh.server.route("GET", "/mesh/v1/tickets", () => ({ rows: [] }));
  ovh.server.route("POST", "/mesh/v1/requests", () => ({ triggerId: "t" }));
  ovh.server.route("POST", "/mesh/v1/work/claims", () => ({ claimed: true }));
  ovh.server.route("POST", "/mesh/v1/work/offers", () => ({ accepted: true }));
  ovh.server.route("POST", "/mesh/v1/tickets/:handle/stop", () => ({ row: null }));
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const peer = () => findPeer(readMesh(mac.home), "ovh");
  const call = (method: string, path: string, body?: unknown) => callPeer(peer(), method, path, body)
    .then((): undefined => undefined, (error: MeshError) => error);

  const rows: { method: string; path: string; surface: MeshSurface; viewer: boolean; member: boolean; operator: boolean }[] = [
    { method: "GET", path: "/mesh/v1/node", surface: "node.read", viewer: true, member: true, operator: true },
    { method: "GET", path: "/mesh/v1/removed", surface: "mesh.removed", viewer: true, member: true, operator: true },
    { method: "GET", path: "/mesh/v1/tickets", surface: "tickets.read", viewer: true, member: true, operator: true },
    { method: "POST", path: "/mesh/v1/requests", surface: "tickets.submit", viewer: false, member: true, operator: true },
    { method: "POST", path: "/mesh/v1/work/claims", surface: "work.claim", viewer: false, member: true, operator: true },
    { method: "POST", path: "/mesh/v1/work/offers", surface: "work.offer", viewer: false, member: false, operator: true },
    { method: "POST", path: "/mesh/v1/tickets/abc12345/stop", surface: "tickets.stop", viewer: false, member: false, operator: true }
  ];
  for (const grant of ["viewer", "member", "operator"] as const) {
    setGrant("mac", grant, ovh.home);
    for (const row of rows) {
      const error = await call(row.method, row.path, row.method === "POST" ? {} : undefined);
      if (row[grant]) { assert.equal(error, undefined, `${grant} reaches ${row.surface}`); continue; }
      assert.ok(error, `${grant} must not reach ${row.surface}`);
      assert.equal(error.status, 403, `${grant} on ${row.surface} reads 403`);
      assert.match(error.message, new RegExp(`grant \\(${grant}\\) does not allow ${row.surface.replace(".", "\\.")}`));
    }
  }
});

test("a new pairing starts as a member, and a record paired before grants keeps every surface", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-surfaces-state-"));
  started.push({ home, server: new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) }), url: "" });
  const record = { id: "old-peer", name: "old", key: newPairKey(), addresses: [], pairedAt: "2026-01-01T00:00:00.000Z" };
  // A node from before grants: state.json has its pairing, and there is no grants file yet.
  updateMesh((state) => ({ ...state, peers: [record] }), home);
  assert.equal(existsSync(join(home, "grants.json")), false);
  assert.equal(grantOf(readMesh(home).peers[0]!), "operator", "a pairing from before grants keeps what pairing meant then");
  assert.equal(existsSync(join(home, "grants.json")), true, "the first read writes it down");
  // A pairing made after that starts as a member.
  savePeer({ id: "new-peer", name: "new", key: newPairKey(), addresses: [], pairedAt: new Date().toISOString() }, home);
  assert.equal(grantOf(findPeer(readMesh(home), "new")), "member");

  setGrant("old", "viewer", home);
  savePeer({ ...record, key: newPairKey(), addresses: [] }, home);
  assert.equal(grantOf(readMesh(home).peers.find((peer) => peer.id === "old-peer")!), "viewer", "pairing again keeps the grant this node set");
});

test("a grant survives a rewrite of state.json by an older Swarm, a damaged grants file narrows, and removal resets it", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-surfaces-grants-"));
  started.push({ home, server: new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) }), url: "" });
  savePeer({ id: "peer-1", name: "box", key: newPairKey(), addresses: [], pairedAt: new Date().toISOString() }, home);
  setGrant("box", "viewer", home);
  // An older Swarm rewrites state.json with only the fields it knows; the grant is not among them, and stays.
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(home, "state.json"), JSON.stringify({ node: state.node, peers: state.peers, removed: [] }));
  assert.equal(grantOf(findPeer(readMesh(home), "box")), "viewer");
  // A grant that does not read narrows that peer, and keeps the pairing.
  writeFileSync(join(home, "grants.json"), JSON.stringify({ version: 1, grants: { "peer-1": { scopes: ["not.a.surface"] } } }));
  assert.equal(grantOf(findPeer(readMesh(home), "box")), "viewer");
  assert.equal(readMesh(home).peers.length, 1);
  // A file that does not read at all narrows every peer.
  writeFileSync(join(home, "grants.json"), "{ not json");
  assert.equal(grantOf(findPeer(readMesh(home), "box")), "viewer");
  // A removed device that comes back is a new pairing again.
  setGrant("box", "operator", home);
  removePeer("peer-1", home);
  savePeer({ id: "peer-1", name: "box", key: newPairKey(), addresses: [], pairedAt: new Date().toISOString() }, home);
  assert.equal(grantOf(findPeer(readMesh(home), "box")), "member");
});
