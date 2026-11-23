import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BotCommands } from "../superagent/bot-commands.js";
import { SuperagentClient } from "../superagent/client.js";
import { settingsPath, writeSettings } from "../superagent/settings.js";
import { TuiTickets } from "../tui/tickets/controller.js";
import { needsYouItems } from "../tui/tickets/view-model.js";
import { nodeCard } from "./card.js";
import { callPeer, joinMesh, type MeshError } from "./client.js";
import { findPeer } from "./state.js";
import { localOperator } from "../superagent/sources/local.js";
import { MeshServer } from "./server.js";
import { createInvite, readMesh, setGrant, updateMesh } from "./state.js";
import { peerAct, registerTicketRoutes, splitHandle } from "./tickets.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const root = mkdtempSync(join(tmpdir(), "swarm-mesh-tickets-"));
let ovh: { client: SuperagentClient; server: MeshServer; meshHome: string };
let mac: { client: SuperagentClient; tickets: TuiTickets; meshHome: string };

/** A ticket accepted on `client` from a local request, with its assignment started. */
function accepted(client: SuperagentClient, request: string, title: string, name: string): string {
  const { triggerId } = client.request(request);
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title, scope: title, reason: "asked", name, evalId: candidate.evalId });
  client.engine.assignmentStarted(ticketId!, client.store.tickets.get(ticketId!)!.assignments[0]!.id);
  return ticketId!;
}

before(async () => {
  const ovhMesh = join(root, "ovh-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "ovh", listen: "127.0.0.1:0" } }), ovhMesh);
  const ovhClient = new SuperagentClient({ stateDir: join(root, "ovh-superagent") });
  const server = new MeshServer({ home: ovhMesh, card: () => nodeCard(readMesh(ovhMesh).node, { abilities: ["linux"] }) });
  // The host's own command runner for the limits, with the command wording this file asserts in its place.
  const commands = new BotCommands(ovhClient);
  registerTicketRoutes(server, ovhClient, {
    commandText: async (trigger, name, args) => `ran ${name} ${args.join(" ")} as ${trigger.actor.id}`,
    requestHeld: (trigger) => commands.requestHeld(trigger)
  });
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), ovhMesh);
  ovh = { client: ovhClient, server, meshHome: ovhMesh };

  const macMesh = join(root, "mac-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "mac", advertise: "http://127.0.0.1:9" } }), macMesh);
  await joinMesh(createInvite(url, 15, ovhMesh), macMesh);
  // These tests work with what a pairing reached before grants: the operator preset. The presets of their own are below.
  setGrant("mac", "operator", ovhMesh);
  const macClient = new SuperagentClient({ stateDir: join(root, "mac-superagent") });
  mac = { client: macClient, meshHome: macMesh, tickets: new TuiTickets({ stateDir: join(root, "mac-superagent"), meshHome: macMesh, log: () => {} }) };
});
after(async () => {
  await mac.tickets.close();
  mac.client.close();
  await ovh.server.stop();
  ovh.client.close();
  rmSync(root, { recursive: true, force: true });
});

test("the TUI shows a paired device's tickets as <device>:<id> beside its own, with the counts merged", async () => {
  accepted(mac.client, "tidy the readme", "Tidy the README", "tidy-readme");
  const remote = accepted(ovh.client, "choose a separator", "Separator option", "separator-option");
  ovh.client.engine.report(remote, { state: "progress", summary: "Need the default", question: "Dash or underscore?" });

  await mac.tickets.refreshRemote();
  const snapshot = (await mac.tickets.snapshot())!;
  const byTitle = Object.fromEntries(snapshot.rows.map((row) => [row.title, row]));
  assert.equal(byTitle["Tidy the README"]?.device, undefined);
  assert.equal(byTitle["Separator option"]?.device, "ovh");
  assert.equal(byTitle["Separator option"]?.short, `ovh:${remote.slice(0, 8)}`);
  assert.equal(snapshot.rows[0]?.title, "Separator option", "what waits for a person comes first, wherever it is");
  assert.equal(snapshot.status.counts.person, 1);
  assert.equal(snapshot.status.counts.working + snapshot.status.counts.queued + snapshot.status.counts.idle, 1);

  const [needs] = needsYouItems(snapshot.rows);
  assert.equal(needs?.action, `/ticket say ovh:${remote.slice(0, 8)} <answer>`);
});

test("answering, stopping and filing go to the device that owns the ticket", async () => {
  await mac.tickets.refreshRemote();
  const row = (await mac.tickets.snapshot())!.rows.find((item) => item.title === "Separator option")!;

  await mac.tickets.say(row.short, "dash");
  const inputs = ovh.client.store.tickets.get(row.id)!.inputs;
  assert.ok(inputs.some((input) => input.kind === "trigger" && ovh.client.store.triggers.get(input.triggerId)?.text === "dash"), "the answer reached ovh's ticket");
  assert.equal(mac.client.store.tickets.get(row.id), undefined, "nothing was written on the mac");

  const stopped = await mac.tickets.stop(row.id);
  assert.equal(stopped.device, "ovh", "a bare id of a paired device's ticket is found there");
  assert.ok(ovh.client.store.tickets.get(row.id)!.ended, "ovh ended it");

  const { triggerId } = await mac.tickets.request("bump the version", "ovh");
  assert.ok(ovh.client.store.triggers.get(triggerId), "the request is ovh's");
  assert.equal(mac.client.store.triggers.get(triggerId), undefined);
  assert.deepEqual(splitHandle("ovh:abc12345"), { device: "ovh", id: "abc12345" });
});

test("replies posted on a paired device reach the TUI once, after its first read", async () => {
  await mac.tickets.refreshRemote();
  await mac.tickets.newReplies();
  const ticketId = accepted(ovh.client, "write the changelog", "Write the changelog", "write-changelog");
  ovh.client.engine.report(ticketId, { state: "ready", summary: "Wrote it." });
  ovh.client.engine.reply({ purpose: "result", ticketId, text: "The changelog is written." });

  await mac.tickets.refreshRemote();
  const fresh = await mac.tickets.newReplies();
  assert.deepEqual(fresh.map((reply) => [reply.device, reply.text]), [["ovh", "The changelog is written."]]);
  assert.deepEqual(await mac.tickets.newReplies(), [], "shown once");
  const messages = await mac.tickets.messages(`ovh:${ticketId.slice(0, 8)}`);
  assert.ok(messages.some((message) => message.text === "The changelog is written."));
});

test("a paired node runs a read command on the other through the same table, and nothing else", async () => {
  const peer = findPeer(readMesh(mac.meshHome), "ovh");
  const answered = await callPeer<{ text: string }>(peer, "POST", "/mesh/v1/command", { name: "status", args: ["1"] });
  assert.equal(answered.text, `ran status 1 as ${localOperator()}`);
  const refused = await callPeer<{ error?: string }>(peer, "POST", "/mesh/v1/command", { name: "link", args: [] }).then(() => undefined, (error: unknown) => error);
  assert.match(String(refused), /read only: status, tickets, usage, devices, mesh, me/);
});

test("a peer's grant decides what it reaches here: viewer reads, member files requests, operator keeps every surface", async () => {
  const peer = () => findPeer(readMesh(mac.meshHome), "ovh");
  const call = (method: string, path: string, body?: unknown) => callPeer(peer(), method, path, body)
    .then((): undefined => undefined, (error: MeshError) => error);
  const refused = async (method: string, path: string, surface: string, grant: string, body?: unknown): Promise<void> => {
    const error = await call(method, path, body);
    assert.ok(error, `${grant} must not reach ${surface}`);
    assert.equal(error.status, 403);
    assert.match(error.message, new RegExp(`grant \\(${grant}\\) does not allow ${surface.replace(".", "\\.")}`));
  };
  const ticket = accepted(ovh.client, "tidy the changelog", "Tidy the changelog", "tidy-changelog");
  const short = ticket.slice(0, 8);

  setGrant("mac", "viewer", ovh.meshHome);
  assert.equal(await call("GET", "/mesh/v1/tickets"), undefined, "a viewer reads the list");
  assert.equal(await call("GET", `/mesh/v1/tickets/${short}`), undefined, "and one ticket");
  await refused("POST", "/mesh/v1/requests", "tickets.submit", "viewer", { text: "more work" });
  await refused("POST", `/mesh/v1/tickets/${short}/stop`, "tickets.stop", "viewer", {});
  assert.ok(!ovh.client.store.tickets.get(ticket)!.ended, "the ticket is untouched");

  setGrant("mac", "member", ovh.meshHome);
  const macId = findPeer(readMesh(ovh.meshHome), "mac").id;
  const { triggerId } = await callPeer<{ triggerId: string }>(peer(), "POST", "/mesh/v1/requests", { text: "write the notes" });
  const trigger = ovh.client.store.triggers.get(triggerId)!;
  assert.deepEqual(trigger.actor, { source: "mesh", id: macId, name: "mac" }, "the request is filed under the peer");
  ovh.client.engine.evaluateDue();
  const candidate = ovh.client.engine.candidate(triggerId)!;
  const { ticketId } = ovh.client.engine.decide(triggerId, { kind: "accept", title: "Write the notes", scope: "notes", reason: "asked", name: "write-notes", evalId: candidate.evalId });
  const mandate = ovh.client.store.tickets.get(ticketId!)!.mandate;
  assert.equal(mandate.actor.source, "mesh", "its work is the peer's");
  assert.equal(mandate.basis.via, "peer", "and says it came over the mesh");
  await refused("POST", `/mesh/v1/tickets/${short}/stop`, "tickets.stop", "member", {});
  assert.ok(!ovh.client.store.tickets.get(ticket)!.ended, "a member cannot stop another's ticket");

  setGrant("mac", "operator", ovh.meshHome);
  // An operator reaches the stop, and a stop cannot be had back: without a lease on the ticket it is still refused.
  const unleased = await call("POST", `/mesh/v1/tickets/${short}/stop`, {});
  assert.equal(unleased?.status, 403);
  assert.match(unleased!.message, /tickets\.stop needs a lease/);
  assert.ok(!ovh.client.store.tickets.get(ticket)!.ended);
  // peerAct asks for the lease on that one ticket first, as the TUI and the CLI do.
  await peerAct(peer(), short, "stop");
  assert.ok(ovh.client.store.tickets.get(ticket)!.ended, "an operator stops a ticket with a lease on it");
  // A stop uses its lease up: none on that ticket is left for another call.
  assert.deepEqual(readMesh(ovh.meshHome).leases.filter((lease) => lease.resource === ticket), []);
  // An operator's request is this node's operator's, as a pairing's was before grants.
  const asOperator = await callPeer<{ triggerId: string }>(peer(), "POST", "/mesh/v1/requests", { text: "check the logs" });
  assert.equal(ovh.client.store.triggers.get(asOperator.triggerId)!.actor.source, "local");
  // The peer's own ticket is not left open: the next test starts from no open ticket of the peer's.
  ovh.client.stop(ticketId!);
});

test("a peer that may post to a ticket but is no operator speaks as itself, and an operator as this node's operator", async () => {
  const ticket = accepted(ovh.client, "sort the issues", "Sort the issues", "sort-issues");
  const macId = findPeer(readMesh(ovh.meshHome), "mac").id;
  const latest = (): { actor: { source: string; id: string; name?: string } } => {
    const rows = ovh.client.store.db.prepare("SELECT value FROM trigger ORDER BY at").all().map((row) => JSON.parse(String(row.value)) as { text: string; actor: { source: string; id: string; name?: string } });
    return rows.filter((trigger) => trigger.text === "any news?").at(-1)!;
  };
  setGrant("mac", { scopes: ["node.read", "tickets.read", "tickets.message"] }, ovh.meshHome);
  try {
    await callPeer(findPeer(readMesh(mac.meshHome), "ovh"), "POST", `/mesh/v1/tickets/${ticket.slice(0, 8)}/messages`, { text: "any news?" });
    assert.deepEqual(latest().actor, { source: "mesh", id: macId, name: "mac" }, "the message is the peer's, not this node's operator's");
    setGrant("mac", "operator", ovh.meshHome);
    await callPeer(findPeer(readMesh(mac.meshHome), "ovh"), "POST", `/mesh/v1/tickets/${ticket.slice(0, 8)}/messages`, { text: "any news?" });
    assert.equal(latest().actor.source, "local", "an operator speaks as this node's operator, as before grants");
  } finally {
    setGrant("mac", "operator", ovh.meshHome);
    ovh.client.stop(ticket);
  }
});

test("a member's requests count against the limits a person's message does", async () => {
  setGrant("mac", "member", ovh.meshHome);
  const peer = findPeer(readMesh(mac.meshHome), "ovh");
  const path = settingsPath(join(root, "ovh-superagent"));
  writeSettings({ access: { limits: { everyone: { openTickets: 1 } } } }, path);
  try {
    const mine = (id: string) => ovh.client.store.tickets.open().filter((ticket) => ticket.mandate.actor.source === "mesh" && ticket.mandate.actor.id === id);
    assert.equal(mine(findPeer(readMesh(ovh.meshHome), "mac").id).length, 0, "the peer holds no open ticket yet");
    const first = await callPeer<{ triggerId: string }>(peer, "POST", "/mesh/v1/requests", { text: "first one" });
    ovh.client.engine.evaluateDue();
    const candidate = ovh.client.engine.candidate(first.triggerId)!;
    ovh.client.engine.decide(first.triggerId, { kind: "accept", title: "First one", scope: "x", reason: "asked", name: "first-one", evalId: candidate.evalId });
    const error = await callPeer(peer, "POST", "/mesh/v1/requests", { text: "second one" }).then((): undefined => undefined, (failure: MeshError) => failure);
    assert.equal(error?.status, 429, "the second request is held");
    assert.match(error!.message, /open tickets/, "and says why");
  } finally {
    rmSync(path, { force: true });
    setGrant("mac", "operator", ovh.meshHome);
  }
});

test("a paired device that stops answering is named, and its tickets leave the view", async () => {
  await ovh.server.stop();
  await mac.tickets.refreshRemote();
  const snapshot = (await mac.tickets.snapshot())!;
  assert.deepEqual(snapshot.unreachable, ["ovh"]);
  assert.ok(snapshot.rows.every((row) => !row.device));
  await assert.rejects(mac.tickets.say("ovh:abcdef12", "hello"), /unreachable/);
});
