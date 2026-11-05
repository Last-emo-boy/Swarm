import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SuperagentClient } from "../superagent/client.js";
import { TuiTickets } from "../tui/tickets/controller.js";
import { needsYouItems } from "../tui/tickets/view-model.js";
import { nodeCard } from "./card.js";
import { joinMesh } from "./client.js";
import { MeshServer } from "./server.js";
import { createInvite, readMesh, updateMesh } from "./state.js";
import { registerTicketRoutes, splitHandle } from "./tickets.js";

const root = mkdtempSync(join(tmpdir(), "swarm-mesh-tickets-"));
let ovh: { client: SuperagentClient; server: MeshServer };
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
  registerTicketRoutes(server, ovhClient);
  const { url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), ovhMesh);
  ovh = { client: ovhClient, server };

  const macMesh = join(root, "mac-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "mac", advertise: "http://127.0.0.1:9" } }), macMesh);
  await joinMesh(createInvite(url, 15, ovhMesh), macMesh);
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

test("a paired device that stops answering is named, and its tickets leave the view", async () => {
  await ovh.server.stop();
  await mac.tickets.refreshRemote();
  const snapshot = (await mac.tickets.snapshot())!;
  assert.deepEqual(snapshot.unreachable, ["ovh"]);
  assert.ok(snapshot.rows.every((row) => !row.device));
  await assert.rejects(mac.tickets.say("ovh:abcdef12", "hello"), /unreachable/);
});
