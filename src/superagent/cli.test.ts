/** The terminal's views of what the agent did (cli.ts, views.ts): `why`, a ticket's messages, and what status says did not arrive. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runSuperagentCommand } from "./cli.js";
import { localOperator } from "./sources/local.js";
import { SuperagentClient } from "./client.js";
import { Journal } from "./journal.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";

const home = process.env.SWARM_SUPERAGENT_HOME;
let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-cli-why-"));
  process.env.SWARM_SUPERAGENT_HOME = stateDir;
  client = new SuperagentClient({ stateDir });
  client.journal = new Journal(client.store);
});
afterEach(() => {
  client.close();
  if (home === undefined) delete process.env.SWARM_SUPERAGENT_HOME;
  else process.env.SWARM_SUPERAGENT_HOME = home;
  rmSync(stateDir, { recursive: true, force: true });
});

/** Runs a `swarm superagent` command on the test's state directory and returns what it printed. */
async function run(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...items: unknown[]) => { lines.push(items.join(" ")); };
  try { await runSuperagentCommand(args); } finally { console.log = log; }
  return lines.join("\n");
}

test("help names the terminal's GitHub commands beside the rest", async () => {
  const shown = await run("help");
  assert.match(shown, /link \[--repo owner\/name\] \[--wait\]/);
  assert.match(shown, /repo \[owner\/name\]/);
  assert.match(shown, /takeover <ticket>/);
});

/** A ticket accepted from a request, as the router's accept decision makes one. */
function accept(text = "write the essay about tea"): { triggerId: string; ticketId: string } {
  const { triggerId } = client.request(text);
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const decision = client.engine.decide(triggerId, { kind: "accept", title: "Write the essay", scope: "write it", reason: "asked", name: "essay", evalId: candidate.evalId });
  return { triggerId, ticketId: decision.ticketId! };
}

test("why shows a ticket's routing, and the journal's reason for a run that left no other trace", async () => {
  const { ticketId, triggerId } = accept();
  // An attend that answered the request: its reason exists only in the journal.
  client.journal!.skip("attend", "chat:oc_team", "silent", "the question was for someone else");
  client.journal!.start({ kind: "route", key: `trigger:${triggerId}`, purpose: "superagent_route", system: "router", user: '{"candidate":{}}' });
  client.journal!.outcome("route", `trigger:${triggerId}`, "accept", { reason: "it asks for a document" });
  const shown = await run("why", ticketId);
  assert.match(shown, new RegExp(`ticket ${ticketId.slice(0, 8)}`));
  assert.match(shown, /routing/);
  assert.match(shown, /accept/);
  assert.match(shown, /it asks for a document/, "the router's own reason, which only the journal keeps");
  assert.match(shown, /talking/);
  // The JSON carries the same report: the route's row, under the trigger it routed.
  const shownMessage = await run("why", triggerId.slice(0, 10), "--json");
  const report = JSON.parse(shownMessage) as { talking: { kind: string; reason?: string }[] };
  assert.ok(report.talking.some((run) => run.kind === "route" && run.reason === "it asks for a document"));

  // Without its journal rows the report would have no reason to give for the route: dropping them changes the answer.
  client.store.db.prepare("DELETE FROM journal").run();
  const bare = await run("why", ticketId);
  assert.doesNotMatch(bare, /it asks for a document/);
});

test("ticket prints every message queued for it with its status, platform id and attachment, whatever the Source", async () => {
  const { ticketId } = accept();
  client.store.atomic(() => {
    client.store.receipts.add({ id: "m1", channel: { source: "feishu", thread: "feishu:oc_team", address: { chatId: "oc_team" } },
      text: "I need the essay's text", kind: "reply", ticketId });
    client.store.receipts.add({ id: "m2", channel: { source: "local", thread: "local:x", address: {} },
      text: "Drafting it now", kind: "reply", ticketId, attachment: "/state/patches/e9e622ae.patch" });
  });
  client.store.receipts.settle(client.store.receipts.get("m1")!, "sent", { at: "2026-11-14T09:21:04.000Z", messageId: "om_y1" });
  const shown = await run("ticket", ticketId);
  assert.match(shown, /\[reply {2}sent .*\] I need the essay's text/);
  assert.match(shown, /om_y1/, "the id the platform gave the message");
  assert.match(shown, /\[reply {2}pending\] Drafting it now/);
  assert.match(shown, /attachment: \/state\/patches\/e9e622ae\.patch/);
  const json = JSON.parse(await run("ticket", ticketId, "--json")) as { messages: { id: string; sentAt?: string; platformMessageId?: string }[] };
  assert.deepEqual(json.messages.map((message) => [message.id, message.sentAt, message.platformMessageId]),
    [["m1", "2026-11-14T09:21:04.000Z", "om_y1"], ["m2", undefined, undefined]]);
});

test("status says which replies keep failing, which went nowhere, and which wait on a Source that is off", async () => {
  const { ticketId } = accept();
  const channel = { source: "feishu", thread: "feishu:oc_team", address: { chatId: "oc_team" } };
  client.store.atomic(() => {
    for (const id of ["trying", "lost", "held"]) client.store.receipts.add({ id, channel, text: id, kind: "reply", ticketId });
  });
  client.store.db.prepare("INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES ('reply', 'trying', '{}', 1, 2, 'no route to the chat', 0, '')").run();
  client.store.receipts.settle(client.store.receipts.get("lost")!, "channelGone");
  // The Source is off in settings nobody wrote: the reply waits rather than failing.
  const shown = await run("status");
  assert.match(shown, /1 reply failing to deliver:/);
  assert.match(shown, /2 failed tries {2}no route to the chat/);
  assert.match(shown, /1 reply dropped:/);
  assert.match(shown, /channelGone/);
  assert.match(shown, /Replies waiting on a Source that is off:/);
  assert.match(shown, new RegExp(`ticket ${ticketId.slice(0, 8)} {2}feishu {2}2 messages`), "the failing and the held messages both wait");
  // With the Source enabled, nothing waits on it.
  writeSettings({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [] } } } }, settingsPath(stateDir));
  assert.doesNotMatch(await run("status"), /waiting on a Source that is off/);
});

test("tickets says why one stays local, and ticket says what would let its work act on GitHub", async () => {
  const { ticketId } = accept();
  const ticket = client.store.tickets.get(ticketId)!;
  ticket.mandate.capability = { role: "everyone", write: "local", local: "unlinked" };
  client.store.tickets.save(ticket);
  const short = ticketId.slice(0, 8);
  assert.match(await run("tickets"), new RegExp(`${short}  .*  \\(local: link needed\\)`));
  assert.match(await run("ticket", ticketId), new RegExp(`run swarm superagent link, then swarm superagent takeover ${short} once it is ready`));
  // JSON carries the reason unchanged, for the TUI and scripts.
  const report = JSON.parse(await run("ticket", ticketId, "--json")) as { write: string; local?: string };
  assert.deepEqual([report.write, report.local], ["local", "unlinked"]);
  // Linked since it was accepted: the notice says so instead of asking for the link again.
  client.store.set(KV.links.github("local", localOperator()), { login: "operator-gh", id: 7, repos: ["owner/watched"], reposAt: "", linkedAt: "", access: { iv: "", data: "", tag: "" } });
  const later = await run("ticket", ticketId);
  assert.match(later, /accepted before your GitHub account was linked/);
  assert.doesNotMatch(later, /run swarm superagent link/);
  assert.match(await run("why", ticketId), /accepted before your GitHub account was linked/);
  client.store.delete(KV.links.github("local", localOperator()));
  // A ticket whose reason nobody can act on prints no way out.
  ticket.mandate.capability = { role: "everyone", write: "local", local: "inferred" };
  client.store.tickets.save(ticket);
  assert.match(await run("tickets"), /\(local: inferred, no one asked\)/);
  assert.doesNotMatch(await run("ticket", ticketId), /superagent link/);
});
