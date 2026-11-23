/** Leases for what cannot be undone, and the rules offered work and lent calls follow on the node they reach. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { nodeCard } from "./card.js";
import { callLent } from "./borrow.js";
import { callPeer, joinMesh, type MeshError } from "./client.js";
import { LEASE_HEADER, LEASES_HEADER, LEASES_PER_PEER, mintLease, requireLease } from "./leases.js";
import { LEND_AUDIT, lendFolders, registerLending } from "./lend.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, readMesh, removePeer, setGrant, updateMesh, type Peer } from "./state.js";
import { OfferSchema, claimMismatch, fittest, offeredMode } from "./work.js";
import type { NodeCard } from "./card.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const started: { home: string; server: MeshServer }[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const node of started.splice(0)) {
    await node.server.stop();
    rmSync(node.home, { recursive: true, force: true });
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function startNode(name: string, lend = false) {
  const home = mkdtempSync(join(tmpdir(), `swarm-lease-${name}-`));
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  if (lend) registerLending(server);
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const node = { home, server, url };
  started.push(node);
  return node;
}

/** A peer record as a node keeps it, for the rules that need no link. */
const record = (home: string, name: string): Peer => findPeer(readMesh(home), name);
/** The headers a call of this version carries, naming `lease` when it has one. */
const named = (lease?: string): Record<string, string> => ({ [LEASES_HEADER]: "1", ...(lease ? { [LEASE_HEADER]: lease } : {}) });

test("a lease is minted only for a surface the grant reaches, holds one resource, and ends", async () => {
  const ovh = await startNode("ovh");
  const mac = await startNode("mac");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const asked = { surface: "tickets.stop", resource: "ticket-1" };
  // A new pairing is a member, which stops nothing, so it gets no lease to stop with.
  assert.throws(() => mintLease(record(ovh.home, "mac"), asked, ovh.home), /does not allow tickets\.stop, so no lease/);
  setGrant("mac", "operator", ovh.home);
  const lease = mintLease(record(ovh.home, "mac"), asked, ovh.home);
  assert.equal(mintLease(record(ovh.home, "mac"), asked, ovh.home).leaseId, lease.leaseId, "asking again answers the same lease");
  const covers = (resource: string) => resource === "ticket-1";
  assert.equal(requireLease(record(ovh.home, "mac"), "tickets.stop", named(lease.leaseId), covers, ovh.home)?.id, lease.leaseId);
  assert.throws(() => requireLease(record(ovh.home, "mac"), "tickets.stop", named(), covers, ovh.home), /needs a lease/);
  assert.throws(() => requireLease(record(ovh.home, "mac"), "tickets.stop", named(lease.leaseId), (resource) => resource === "ticket-2", ovh.home), /does not act on/);
  assert.throws(() => requireLease(record(ovh.home, "mac"), "work.offer", named(lease.leaseId), covers, ovh.home), /is for tickets\.stop/);
  // A lease past its time holds nothing.
  updateMesh((state) => ({ ...state, leases: state.leases.map((item) => ({ ...item, expiresAt: new Date(Date.now() - 1000).toISOString() })) }), ovh.home);
  assert.throws(() => requireLease(record(ovh.home, "mac"), "tickets.stop", named(lease.leaseId), covers, ovh.home), /expired/);
});

test("a call from a node before leases is taken without one only from an operator, which could mint any lease", async () => {
  const ovh = await startNode("ovh");
  const mac = await startNode("mac");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const covers = () => true;
  // No marker: the caller cannot ask for a lease. A member is still refused; an operator's call passes as it did before.
  assert.throws(() => requireLease(record(ovh.home, "mac"), "work.offer", {}, covers, ovh.home), /needs a lease/);
  setGrant("mac", "operator", ovh.home);
  assert.equal(requireLease(record(ovh.home, "mac"), "work.offer", {}, covers, ovh.home), undefined);
  // A caller that knows leases and names none is refused, operator or not.
  assert.throws(() => requireLease(record(ovh.home, "mac"), "work.offer", named(), covers, ovh.home), /needs a lease/);
});

test("a peer holds only so many leases, and an unpaired one holds none", async () => {
  const ovh = await startNode("ovh");
  const mac = await startNode("mac");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  setGrant("mac", "operator", ovh.home);
  for (let index = 0; index < LEASES_PER_PEER; index += 1) mintLease(record(ovh.home, "mac"), { surface: "tickets.stop", resource: `ticket-${index}` }, ovh.home);
  assert.throws(() => mintLease(record(ovh.home, "mac"), { surface: "tickets.stop", resource: "one-more" }, ovh.home), /holds 8 tickets\.stop leases/);
  // Another peer's lease is never this one's, whatever it names.
  const lease = readMesh(ovh.home).leases[0]!;
  assert.throws(() => requireLease({ ...record(ovh.home, "mac"), id: "someone-else" }, "tickets.stop", named(lease.id), () => true, ovh.home), /No lease/);
  removePeer(record(ovh.home, "mac").id, ovh.home);
  assert.deepEqual(readMesh(ovh.home).leases, [], "the leases went with the pairing");
});

test("a peer asks for a lease over its link, and a member is refused it", async () => {
  const ovh = await startNode("ovh");
  const mac = await startNode("mac");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  const asked = { surface: "lend.shell", resource: "/srv/lent" };
  const refused = await callPeer(record(mac.home, "ovh"), "POST", "/mesh/v1/leases", asked).then((): undefined => undefined, (error: MeshError) => error);
  assert.equal(refused?.status, 403);
  setGrant("mac", "operator", ovh.home);
  const answer = await callPeer<{ leaseId: string; expiresAt: string }>(record(mac.home, "ovh"), "POST", "/mesh/v1/leases", asked);
  assert.ok(Date.parse(answer.expiresAt) - Date.now() <= 30 * 60_000 + 1000, "thirty minutes unless asked for less");
  assert.equal(readMesh(ovh.home).leases.find((lease) => lease.id === answer.leaseId)?.by, record(ovh.home, "mac").id);
});

test("offered work carries only the ticket's own variables, and asks for no more autonomy than the node allows", () => {
  const offer = { ticketId: "t", assignmentId: "a", name: "fix-it", repository: "", variables: { SWARM_TICKET_ID: "t" },
    blockedCommands: [], permissionMode: "full-auto", leaseMs: 60_000 };
  assert.equal(OfferSchema.safeParse(offer).success, true);
  for (const name of ["NODE_OPTIONS", "BASH_ENV", "npm_config_script_shell", "PATH", "swarm_ticket_id"]) {
    assert.equal(OfferSchema.safeParse({ ...offer, variables: { ...offer.variables, [name]: "x" } }).success, false, `${name} is refused`);
  }
  assert.equal(offeredMode("yolo", "full-auto"), "full-auto", "an offer cannot ask for more than the node allows");
  assert.equal(offeredMode("full-auto", "yolo"), "full-auto", "it may ask for less");
  assert.equal(offeredMode("yolo", "yolo"), "yolo");
});

test("a lent shell takes a lease on its folder, and every lent call is kept on the lender's record", async () => {
  const lent = mkdtempSync(join(tmpdir(), "swarm-lent-"));
  homes.push(lent);
  const ovh = await startNode("ovh", true);
  lendFolders("shell", [lent], ovh.home);
  const mac = await startNode("mac");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  // A member reaches no lent shell at all.
  await assert.rejects(callLent("ovh", "shell", { command: "pwd" }, 10_000, mac.home), /does not allow lend\.shell/);
  setGrant("mac", "operator", ovh.home);
  // The borrower asks for the lease itself, names what it borrows for, and the command runs.
  const ran = await callLent("ovh", "shell", { command: "pwd" }, 10_000, mac.home, "ticket 1234abcd") as { exit_code: number; stdout: string };
  assert.equal(ran.exit_code, 0);
  assert.equal(readMesh(ovh.home).leases.filter((lease) => lease.surface === "lend.shell").length, 1);
  const audit = readFileSync(join(ovh.home, LEND_AUDIT), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const last = audit.at(-1)!;
  assert.equal(last.tool, "shell");
  assert.equal(last.asked, "pwd");
  assert.equal(last.for, "ticket 1234abcd");
  assert.equal((last.peer as { name: string }).name, "mac");
  assert.ok(typeof last.lease === "string" && last.ok === true);
  // A shell call that names no lease is refused at the lender before it reaches the tool, as an HTTP refusal the borrower
  // can answer with a fresh lease, whatever the borrower's grant; the refusal is kept on the record too.
  const peer = record(mac.home, "ovh");
  const direct = await callPeer(peer, "POST", "/mesh/v1/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "shell", arguments: { command: "touch should-not-exist" } } },
    undefined, { accept: "application/json, text/event-stream" }).then((): undefined => undefined, (error: MeshError) => error);
  assert.equal(direct?.status, 403, "an unleased shell call does not run");
  assert.match(String(direct?.message), /lend\.shell needs a lease/);
  assert.equal(existsSync(join(lent, "should-not-exist")), false);
  const kept = readFileSync(join(ovh.home, LEND_AUDIT), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).at(-1)!;
  assert.equal(kept.tool, "shell");
  assert.match(String(kept.error), /needs a lease/);
});

test("an offer answering a claim must be the work that was claimed, of a repository this node pulls", () => {
  const claim = { assignmentId: "a1", repository: "acme/app" };
  assert.equal(claimMismatch(claim, { assignmentId: "a1", repository: "acme/app" }, ["acme/app"]), undefined);
  assert.equal(claimMismatch(claim, { assignmentId: "a1", repository: "acme/app" }, []), undefined, "a node that pulls any repository");
  assert.match(String(claimMismatch(claim, { assignmentId: "a2", repository: "acme/app" }, [])), /claimed Assignment a1/);
  assert.match(String(claimMismatch(claim, { assignmentId: "a1", repository: "evil/other" }, [])), /shown work of acme\/app/);
  assert.match(String(claimMismatch({ ...claim, repository: "evil/other" }, { assignmentId: "a1", repository: "evil/other" }, ["acme/app"])), /pulls only/);
});

test("a node that takes no work put on it is never chosen for another node's work", () => {
  const card = (name: string, extra: Partial<NodeCard> = {}): NodeCard => ({ id: name, name, addresses: [], relayName: `node:${name}`, version: "0", os: "linux",
    arch: "x64", abilities: ["linux"], load: { running: 0, queued: 0, slots: 4 }, at: "", ...extra });
  assert.equal(fittest(["linux"], [card("vm", { takesWork: false })]), undefined);
  assert.equal(fittest(["linux"], [card("vm", { takesWork: false }), card("box")])?.name, "box");
});

test("a shell lent at the root of the filesystem takes a lease on it for a command in any folder below", async () => {
  const ovh = await startNode("ovh", true);
  lendFolders("shell", ["/"], ovh.home);
  const mac = await startNode("mac");
  await joinMesh(createInvite(ovh.url, 15, ovh.home), mac.home);
  setGrant("mac", "operator", ovh.home);
  const folder = mkdtempSync(join(tmpdir(), "swarm-root-lent-"));
  homes.push(folder);
  const ran = await callLent("ovh", "shell", { command: "pwd", cwd: folder }, 10_000, mac.home) as { exit_code: number; cwd: string };
  assert.equal(ran.exit_code, 0);
  assert.deepEqual(readMesh(ovh.home).leases.filter((lease) => lease.surface === "lend.shell").map((lease) => lease.resource), ["/"]);
});
