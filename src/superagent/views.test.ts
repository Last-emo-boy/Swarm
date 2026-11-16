/** The views the terminal shows (views.ts): a ticket's messages whatever their Source, what status says failed, and `why`. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SwarmDatabase } from "../storage/database.js";
import { UsageStore } from "../storage/usage-store.js";
import { key } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { Journal } from "./journal.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import { feishuTrigger } from "./sources/feishu.js";
import { hostStatus, ticketMessages, whyReport, whyText } from "./views.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-views-"));
  client = new SuperagentClient({ stateDir });
  client.journal = new Journal(client.store);
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A ticket accepted from a request, as the router's accept decision makes one. */
function accept(text = "write the essay about tea"): { triggerId: string; ticketId: string; decisionId: string } {
  const { triggerId } = client.request(text);
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const decision = client.engine.decide(triggerId, { kind: "accept", title: "Write the essay", scope: "write it", reason: "asked", name: "essay", evalId: candidate.evalId });
  return { triggerId, ticketId: decision.ticketId!, decisionId: decision.id };
}

test("a ticket's messages are every receipt queued for it, whatever its Source, with status, platform id and attachment", () => {
  const { triggerId, ticketId } = accept();
  const channel = { source: "local", thread: "local:x", address: {} };
  // A message to a Feishu chat, sent with the platform's own id; one to a local thread still pending, with a file.
  client.store.atomic(() => {
    client.store.receipts.add({ id: "m1", channel: { source: "feishu", thread: "feishu:oc_team", address: { chatId: "oc_team" } }, text: "I need the essay's text",
      kind: "reply", ticketId, triggerId });
    client.store.receipts.add({ id: "m2", channel, text: "Working on it", kind: "reply", ticketId, attachment: "/state/patches/e9e622ae.patch" });
  });
  const first = client.store.receipts.get("m1")!;
  client.store.receipts.settle(first, "sent", { at: "2026-11-14T09:21:04.000Z", messageId: "om_y1" });
  client.store.receipts.add({ id: "other", channel, text: "not this ticket", kind: "reply", ticketId: "elsewhere" });
  const messages = ticketMessages(client, ticketId);
  assert.deepEqual(messages.map((message) => [message.id, message.source, message.status]), [["m1", "feishu", "sent"], ["m2", "local", "pending"]]);
  assert.equal(messages[0]!.sentAt, "2026-11-14T09:21:04.000Z");
  assert.equal(messages[0]!.platformMessageId, "om_y1");
  assert.equal(messages[0]!.triggerId, triggerId);
  assert.equal(messages[1]!.attachment, "/state/patches/e9e622ae.patch");
});

test("a ticket's messages keep the newest when over the limit, oldest first, so a long ticket shows today", () => {
  const { ticketId } = accept();
  const channel = { source: "local", thread: "local:x", address: {} };
  client.store.atomic(() => {
    for (let index = 0; index < 5; index++) client.store.receipts.add({ id: `m${index}`, channel, text: `message ${index}`, kind: "reply", ticketId });
  });
  assert.deepEqual(ticketMessages(client, ticketId, 3).map((message) => message.id), ["m2", "m3", "m4"]);
});

test("status says which replies keep failing, which were dropped, and which tickets wait on a Source that is off", () => {
  const { ticketId } = accept();
  const channel = { source: "feishu", thread: "feishu:oc_team", address: { chatId: "oc_team" } };
  client.store.receipts.add({ id: "failing", channel, text: "one", kind: "reply", ticketId });
  client.store.receipts.add({ id: "gone", channel, text: "two", kind: "reply", ticketId });
  client.store.db.prepare("INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES ('reply', ?, '{}', 1, 3, 'no route', 0, '')")
    .run("failing");
  client.store.receipts.settle(client.store.receipts.get("gone")!, "channelGone");
  // The waiting ones are queued before the Source goes off; the settled two are not waiting on anything.
  client.store.atomic(() => {
    for (const id of ["w1", "w2"]) client.store.receipts.add({ id, channel, text: id, kind: "reply", ticketId });
  });

  // While the Source is on, the waiting messages are not waiting on anything off.
  writeSettings({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [] } } } }, settingsPath(stateDir));
  const on = hostStatus(client);
  assert.deepEqual(on.replies.failing.map((reply) => [reply.id, reply.attempts, reply.error]), [["failing", 3, "no route"]]);
  assert.deepEqual(on.replies.dropped.map((reply) => [reply.id, reply.reason]), [["gone", "channelGone"]]);
  assert.deepEqual(on.waitingOnOff, []);
  writeSettings({ sources: { feishu: { enabled: false, config: { cli: "lark-cli", chats: [] } } } }, settingsPath(stateDir));
  const off = hostStatus(client);
  // The failing message still waits to go out with the rest; its ticket's messages count as one line.
  assert.deepEqual(off.waitingOnOff, [{ ticketId, source: "feishu", messages: 3 }], "a ticket's messages count as one line");
});

test("why reads the journal rows of a ticket, so the card and the reason of a silent run are not lost", async () => {
  const { ticketId, triggerId } = accept();
  // A routing run under the trigger it routed; a chat consideration of the chat the request came from, kept under the chat.
  client.journal!.start({ kind: "route", key: `trigger:${triggerId}`, purpose: "superagent_route", system: "router", user: '{"candidate":{}}' });
  client.journal!.outcome("route", `trigger:${triggerId}`, "accept", { reason: "the message asks for a document" });
  const report = await whyReport(client, ticketId);
  assert.equal(report.ticket?.short, ticketId.slice(0, 8));
  assert.equal(report.routing?.decision?.kind, "accept");
  assert.equal(report.routing?.decision?.reason, "asked");
  assert.deepEqual(report.talking.map((run) => [run.kind, run.outcome, run.reason]), [["route", "accept", "the message asks for a document"]]);

  // A message from a chat carries its chat: the chat's own runs come with it, whose reason no other row holds.
  client.store.atomic(() => client.store.receipts.add({ id: "asked", channel: { source: "local", thread: "local:x", address: {} }, text: "the essay", kind: "reply" }));
  client.journal!.skip("chatter", "chat:oc_team", "silent", "the talk is between others");
  const text = whyText(client, report);
  assert.match(text, /accept/);
  assert.match(text, /the message asks for a document/);
  assert.match(text, /talking/);

  // By a message's id: that message's routing, and the rows under its own trigger.
  const byMessage = await whyReport(client, triggerId.slice(0, 10));
  assert.equal(byMessage.handle, `message ${triggerId}`);
  assert.deepEqual(byMessage.talking.map((run) => run.kind), ["route"]);
  const chatReport = await whyReport(client, triggerId);
  assert.ok(chatReport.routing);
});

test("why says what was queued for a message, its platform id and where its file is, and how the mesh calls went", async () => {
  const { ticketId, triggerId } = accept();
  client.store.set(KV.mesh.calls(ticketId), [
    { at: "2026-11-14T09:20:00.000Z", node: "ovh", tool: "shell", args: '{"command":"ls ~/essays"}', ok: true, ms: 120 },
    { at: "2026-11-14T09:21:00.000Z", node: "kube", tool: "shell", args: '{"command":"cat"}', ok: false, error: "timed out", ms: 30_000 }
  ]);
  client.store.atomic(() => client.store.receipts.add({ id: key("attend", "oc_team", triggerId), triggerId,
    channel: { source: "local", thread: "local:x", address: {} }, text: "I need the essay's text", kind: "reply", attachment: "/state/x.patch" }));
  const report = await whyReport(client, triggerId);
  assert.deepEqual(report.messages.map((message) => [message.text, message.attachment]), [["I need the essay's text", "/state/x.patch"]]);
  assert.deepEqual(report.work?.calls.map((call) => [call.node, call.ok]), [["ovh", true], ["kube", false]]);
  const text = whyText(client, report);
  assert.match(text, /I need the essay's text/);
  assert.match(text, /attachment {2}\/state\/x\.patch/);
  assert.match(text, /→ failed: timed out/);
});

test("why names no ticket or message it does not have, and a ticket with no journal rows still reads", async () => {
  await assert.rejects(whyReport(client, "nope"), /No ticket or message nope/);
  const { ticketId } = accept();
  const report = await whyReport(client, ticketId.slice(0, 8));
  assert.deepEqual(report.talking, []);
  assert.match(whyText(client, report), /none kept for this yet/);
});

test("a message handle reports failed tries and the error, as the ticket view does for the same receipt", async () => {
  const { triggerId } = accept();
  client.store.receipts.add({ id: key("attend", "oc_team", triggerId), triggerId, channel: { source: "local", thread: "local:x", address: {} },
    text: "one moment", kind: "reply" });
  client.store.db.prepare("INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES ('reply', ?, '{}', 1, 3, 'no route', 0, '')")
    .run(key("attend", "oc_team", triggerId));
  const report = await whyReport(client, triggerId);
  assert.deepEqual(report.messages.map((message) => [message.attempts, message.error]), [[3, "no route"]]);
  assert.match(whyText(client, report), /\(3 failed tries\)/);
});

test("status does not count a message that failed once and was delivered as failing", () => {
  const { ticketId } = accept();
  const channel = { source: "feishu", thread: "feishu:oc_team", address: { chatId: "oc_team" } };
  writeSettings({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [] } } } }, settingsPath(stateDir));
  client.store.receipts.add({ id: "late", channel, text: "one", kind: "reply", ticketId });
  client.store.db.prepare("INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES ('reply', 'late', '{}', 1, 1, 'no route', 0, '')").run();
  client.store.receipts.settle(client.store.receipts.get("late")!, "sent", { at: "2026-11-14T09:21:04.000Z", messageId: "om_late" });
  // The effect row outlives the settle for a moment: a delivered message is not failing.
  assert.deepEqual(hostStatus(client).replies.failing, []);
});

test("status names a message on a Source this build does not have as not installed, not as waiting on an off Source", () => {
  const channel = { source: "peerchat", thread: "peerchat:c1", address: { chatId: "c1" } };
  client.store.receipts.add({ id: "orphan", channel, text: "hello", kind: "notice" });
  assert.deepEqual(hostStatus(client).waitingOnOff, []);
});

test("a message's usage counts only its own calls, and a ticket's its chat's from when it was asked", async () => {
  const { ticketId, triggerId } = accept();
  // The request came from a chat, as a Feishu one does: the ticket's chat arm has a chat to look at.
  client.store.triggers.save({ ...client.store.triggers.get(triggerId)!, meta: { ...client.store.triggers.get(triggerId)!.meta, chatId: "oc_team" } });
  // The ledger lives in Swarm's own database, under the test home the settings resolve.
  const database = new SwarmDatabase(join(process.env.SWARM_HOME!, "state", "swarm.db"));
  const usage = new UsageStore(database);
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const call = (trigger: string | undefined, chat: string | undefined, minutes: number) => usage.append({ session_id: "s", kind: "llm_call", amount: 1, unit: "count",
    metadata: { providerId: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", purpose: "superagent_chatter",
      ...(trigger ? { triggerId: trigger } : {}), ...(chat ? { chatId: chat } : {}), inputTokens: 100, outputTokens: 10 }, created_at: at(minutes) });
  client.store.atomic(() => client.store.receipts.add({ id: "r", channel: { source: "local", thread: "local:x", address: {} }, text: "x", kind: "reply", triggerId }));
  // Another message's routing, a chat consideration after the ask, and this message's own routing.
  call("another-message", undefined, 2);
  call(undefined, "oc_team", 5);
  call(triggerId, "oc_team", 10);
  database.close();
  assert.equal((await whyReport(client, triggerId)).usage.calls, 1, "a message handle counts its own calls only");
  assert.equal((await whyReport(client, ticketId)).usage.calls, 2, "a ticket handle adds the chat's calls from when it was asked");
});

test("why reaches a promise made on the ticket or message, whose run is journaled under its note", async () => {
  const { ticketId, triggerId } = accept();
  const at = new Date().toISOString();
  client.store.memory.save({ id: "p1", about: "self", kind: "promise", text: "send the essay", due: at, created: at, updated: at,
    origin: { triggerId, ticketId } });
  client.journal!.start({ kind: "promise", key: "note:p1", purpose: "superagent_promise", system: "s", user: '{"promise":{}}' });
  client.journal!.outcome("promise", "note:p1", "sent", { reason: "said it would send it", outbox: ["o1"] });
  for (const handle of [ticketId, triggerId]) {
    const report = await whyReport(client, handle);
    assert.deepEqual(report.talking.filter((run) => run.kind === "promise").map((run) => [run.outcome, run.reason]),
      [["sent", "said it would send it"]], `a promise made on ${handle === ticketId ? "the ticket" : "the message"} shows in its why`);
  }
});
