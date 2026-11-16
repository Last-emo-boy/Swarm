/** The agent's memory (memories.ts): when it reflects, what it keeps, the promises it keeps, the people it writes to, and tidying. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { Memories, SELF, applyOps, chatSubject, localNow, noteLine, notesCard, personSubject, planOps, reflectionPrompt, ticketReflectionPrompt, type Note } from "./memories.js";
import { noticed, readMembers } from "./people.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { feishuTrigger } from "./sources/feishu.js";
import { IM_WORDS, wordCount } from "./text.js";

const CHAT = "oc_team";
let stateDir: string;
let client: SuperagentClient;
let memories: Memories;
let now: number;
/** What the model answers next, in order; an Error is a call that fails. */
let answers: (string | Error)[];
let calls: { purpose: string; system: string; user: string }[];
let written = Date.now();
/** What the memory noted through its host's log, such as a model answer it could not use. */
let logs: string[];
/** Writes the settings: the memory's and the chatter's, and the chat Source's when it is to be off or to listen elsewhere. */
const write = (memory: Record<string, unknown> = {}, chatter: Record<string, unknown> = {}, source: Record<string, unknown> = {}) => {
  writeSettings({
    sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: true }, ...source } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } },
    chatter: { persona: "Dry humour.", ...chatter }, memory: { enabled: true, ...memory }
  }, settingsPath(stateDir));
  // A later mtime each time, so the client notices a change written within the same instant as the last.
  written += 2000;
  utimesSync(settingsPath(stateDir), new Date(written), new Date(written));
};
beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-memories-"));
  write();
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: "ou_bot", name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  now = Date.now();
  answers = [];
  calls = [];
  logs = [];
  memories = new Memories({ client, now: () => now, log: (message) => { logs.push(message); },
    complete: async (input) => {
      calls.push(input);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? JSON.stringify({ notes: [] });
    } });
  memories.install();
  client.store.set(KV.sources.labels("feishu"), { [CHAT]: "Team" });
  await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" }] }), client.store, CHAT);
});
afterEach(async () => {
  // Stops the effects of a test that started them, before their store closes.
  await client.effects.drain();
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

let n = 0;
/** A message in the team chat (or a direct message) `ago` seconds before now. */
function say(sender: string, text: string, ago: number, extra: Record<string, unknown> = {}) {
  const trigger = noticed(client.store, feishuTrigger({ message_id: `om_${++n}`, chat_id: CHAT, chat_type: "group", sender_id: sender, sender_type: "user",
    content: text, create_time: String(now - ago * 1000), mentions: [], ...extra }, "ou_bot", "cli_app")!);
  client.engine.receive(trigger);
  return trigger;
}
const queued = (kind: string) => client.store.db.prepare("SELECT key FROM effect WHERE kind = ?").all(kind).map((row) => String(row.key));
const posts = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
  .map((row) => JSON.parse(String(row.value)) as { text: string; channel: { address: Record<string, string> }; mentions?: unknown });
const note = (fields: Partial<Note> & Pick<Note, "about" | "text">): Note => ({ id: `n${++n}`, kind: "fact", origin: { chatId: CHAT },
  created: new Date(now).toISOString(), updated: new Date(now).toISOString(), ...fields });

test("reflects on a chat once it went quiet with enough new messages, or one to the agent, and no more often than the settings allow", () => {
  say("ou_alice", "the release is on Friday", 400);
  memories.pass();
  assert.deepEqual(queued("reflect"), [], "one message is not enough");
  say("ou_bob", "ok", 390); say("ou_alice", "I'll write the notes", 380); say("ou_bob", "thanks", 100);
  now += 60_000;
  memories.pass();
  assert.deepEqual(queued("reflect"), [], "the chat is not quiet yet");
  now += 300_000;
  memories.pass();
  assert.deepEqual(queued("reflect"), [`chat:${CHAT}`]);
  const mark = client.store.get(KV.memory.reflected(CHAT))!;
  assert.ok(mark.upTo > mark.from);
  client.store.db.prepare("DELETE FROM effect").run();
  say("ou_alice", "@w33d one more thing", 10, { mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] });
  now += 600_000;
  memories.pass();
  assert.deepEqual(queued("reflect"), [], "it reflected on this chat less than half an hour ago");
  now += 30 * 60_000;
  memories.pass();
  assert.deepEqual(queued("reflect"), [`chat:${CHAT}`], "one message to the agent is enough");
});

test("a reflection keeps the notes it may write, about the people who spoke, the chat and itself, and writes to someone within its caps", async () => {
  for (const [sender, text, ago] of [["ou_alice", "I lead the 2048 project", 900], ["ou_bob", "anyone know how to train it faster?", 800],
    ["ou_alice", "not me", 700], ["ou_alice", "call me Ali", 600]] as const) say(sender, text, ago);
  const old = note({ about: personSubject("ou_alice"), text: "Alice likes tea" });
  client.store.memory.save(old);
  now += 600_000;
  memories.pass();
  answers.push(JSON.stringify({ notes: [
    { op: "add", about: "ou_alice", kind: "fact", text: "Alice leads the 2048 project" },
    { op: "add", about: "ou_alice", kind: "preference", text: "Alice likes to be called Ali" },
    { op: "add", about: "chat", kind: "event", text: "The team chat talks about the 2048 project" },
    { op: "add", about: "ou_carol", kind: "fact", text: "Carol was not here" },
    { op: "delete", id: old.id }
  ], reach_out: { to: "ou_bob", text: "Bob, try a larger batch size with mixed precision." } }));
  await memories.reflect(CHAT);
  assert.equal(calls[0]!.purpose, "superagent_memory");
  const card = JSON.parse(calls[0]!.user) as { messages: { from: string; from_id?: string }[]; memory: { id: string }[]; time_zone: string };
  assert.deepEqual(card.messages.map((line) => line.from), ["Alice", "Bob", "Alice", "Alice"]);
  assert.ok(card.memory.some((item) => item.id === old.id));
  assert.equal(card.time_zone, "Asia/Shanghai");
  assert.deepEqual(client.store.memory.about(personSubject("ou_alice")).map((item) => item.text).sort(), ["Alice leads the 2048 project", "Alice likes to be called Ali"]);
  assert.deepEqual(client.store.memory.about(chatSubject(CHAT)).map((item) => [item.text, item.origin.chatId]), [["The team chat talks about the 2048 project", CHAT]]);
  assert.deepEqual(client.store.memory.about(personSubject("ou_carol")), [], "Carol did not speak here");
  assert.deepEqual(posts().map((post) => [post.text, post.channel.address]), [["Bob, try a larger batch size with mixed precision.", { userId: "ou_bob", mode: "user", direct: "true" }]]);
  // Once a day per person, at most dmPerDay a day, never in quiet hours.
  const reach = (to: string) => (memories as unknown as { reachOut(person: string, text: string): void }).reachOut(to, `hi ${to}`);
  reach("ou_bob");
  write({ dmPerDay: 2 }, { quiet: { from: 0, to: 0 } });
  reach("ou_alice");
  reach("ou_carol");
  assert.deepEqual(posts().map((post) => post.channel.address.userId), ["ou_bob", "ou_alice"]);
});

test("keeps a promise when it falls due, in the chat where it was made with an @, or in a direct message, and once", async () => {
  const due = new Date(now + 120_000).toISOString();
  client.store.memory.save(note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes", due }));
  client.store.memory.save(note({ about: personSubject("ou_bob"), kind: "promise", text: "Remind Bob to stretch", due, origin: { chatId: "oc_dm_bob", direct: true } }));
  memories.pass();
  assert.deepEqual(queued("promise"), []);
  now += 180_000;
  (memories as unknown as { passedAt: number }).passedAt = 0;
  memories.pass();
  assert.equal(queued("promise").length, 2);
  answers.push(JSON.stringify({ say: "@Alice time to send the release notes." }), JSON.stringify({ say: "Bob, time to stretch." }));
  for (const id of queued("promise")) await memories.keep(id);
  assert.equal(calls[0]!.purpose, "superagent_promise");
  assert.deepEqual(posts().map((post) => [post.text, post.channel.address, post.mentions ?? null]), [
    ["@Alice time to send the release notes.", { chatId: CHAT, mode: "chat" }, [{ id: "ou_alice", name: "Alice" }]],
    ["Bob, time to stretch.", { userId: "ou_bob", mode: "user", direct: "true" }, null]
  ]);
  assert.deepEqual(client.store.memory.due(new Date(now).toISOString()), [], "kept promises are done");
  for (const id of queued("promise")) await memories.keep(id);
  assert.equal(posts().length, 2);
});

test("checks what a model asks of the notes, tidies a subject that grew too long, and shows a few of each subject's notes", async () => {
  const scope = { subjects: (name: string) => name === "ou_alice" ? personSubject("ou_alice") : name === SELF ? SELF : undefined, shown: new Set<string>() };
  assert.match(String(planOps(client.store, [{ op: "add", about: "ou_alice", kind: "promise", text: "Remind her" }], scope, {})), /A promise needs due/);
  assert.match(String(planOps(client.store, [{ op: "add", about: "ou_alice", kind: "fact", text: "x".repeat(201) }], scope, {})), /at most 200/);
  assert.match(String(planOps(client.store, [{ op: "delete", id: "nope" }], scope, {})), /not a note on the card/);
  assert.equal(typeof planOps(client.store, [{ op: "add", about: SELF, kind: "fact", text: "My name is w33d" }], scope, {}), "function");
  write({ perSubject: 5 });
  const notes = Array.from({ length: 7 }, (_, index) => note({ about: personSubject("ou_alice"), text: `Alice note ${index}` }));
  for (const item of notes) client.store.memory.save(item);
  client.store.memory.save(note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice", due: new Date(now + 3_600_000).toISOString() }));
  assert.deepEqual(notesCard(client.store, [personSubject("ou_alice")], 3).map((item) => item.text)[0], "Remind Alice", "promises first");
  (memories as unknown as { crowded(subjects: string[]): void }).crowded([personSubject("ou_alice")]);
  assert.deepEqual(queued("consolidate"), [personSubject("ou_alice")]);
  answers.push(JSON.stringify({ notes: notes.slice(0, 5).map((item) => ({ op: "delete", id: item.id })) }));
  await memories.tidy(personSubject("ou_alice"));
  assert.equal(client.store.memory.count(personSubject("ou_alice")), 3);
  assert.match(localNow({ chatter: { quiet: { from: 23, to: 7, timeZone: "Asia/Shanghai" } } as never }, Date.parse("2026-11-10T06:00:00Z")).now, /^2026-11-10 14:00 \(Tue, UTC\+08:00\)$/);
});

test("reflects on a ticket that ended, about its requester", async () => {
  const asked = say("ou_alice", "@w33d fix the README typo", 60, { mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(asked.id)!;
  const { ticketId } = client.engine.decide(asked.id, { kind: "accept", title: "Fix the README typo", scope: "x", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  client.engine.stopTicket(ticketId!, "done");
  assert.deepEqual(queued("reflect"), [`ticket:${ticketId}`]);
  answers.push(JSON.stringify({ notes: [{ op: "add", about: "ou_alice", kind: "event", text: "I fixed a README typo for Alice" }] }));
  await memories.reflectTicket(ticketId!);
  assert.deepEqual(client.store.memory.about(personSubject("ou_alice")).map((item) => [item.text, item.origin.ticketId]), [["I fixed a README typo for Alice", ticketId]]);
});

test("a kept promise given a new time falls due and is kept again, and one given only a new text stays kept", async () => {
  const due = new Date(now + 60_000).toISOString();
  const again = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes", due });
  const reworded = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to stretch", due });
  for (const item of [again, reworded]) client.store.memory.save(item);
  now += 120_000;
  answers.push(JSON.stringify({ say: "Alice, the release notes." }), JSON.stringify({ say: "Alice, time to stretch." }));
  for (const item of [again, reworded]) await memories.keep(item.id);
  assert.equal(posts().length, 2);
  assert.deepEqual(client.store.memory.due(new Date(now + 3 * 3_600_000).toISOString()), [], "both are kept");
  const later = new Date(now + 2 * 3_600_000).toISOString();
  const change = planOps(client.store, [{ op: "update", id: again.id, due: later }, { op: "update", id: reworded.id, text: "Remind Alice to stretch every hour" }],
    { subjects: () => undefined, shown: new Set([again.id, reworded.id]) }, {}, new Date(now));
  assert.equal(typeof change, "function");
  (change as () => void)();
  assert.deepEqual(client.store.memory.due(new Date(now + 3 * 3_600_000).toISOString()).map((item) => [item.id, item.due, item.done]), [[again.id, later, undefined]],
    "a new time makes it due again; a new text alone does not");
  const kept = client.store.memory.get(reworded.id)!;
  assert.deepEqual([kept.text, kept.due, typeof kept.done], ["Remind Alice to stretch every hour", due, "string"]);
  // Due again, it is kept again, with a message of its own.
  now += 3 * 3_600_000;
  memories.pass();
  assert.deepEqual(queued("promise"), [again.id]);
  answers.push(JSON.stringify({ say: "Alice, the release notes, once more." }));
  await memories.keep(again.id);
  assert.deepEqual(posts().map((post) => post.text), ["Alice, the release notes.", "Alice, time to stretch.", "Alice, the release notes, once more."]);
  assert.deepEqual(client.store.memory.due(new Date(now).toISOString()), []);
});

test("a card shows when a promise falls due, and when a kept one was kept", async () => {
  const due = new Date(now + 60_000).toISOString();
  const open = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to stretch", due });
  const kept = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes", due });
  for (const item of [open, kept]) client.store.memory.save(item);
  now += 120_000;
  answers.push(JSON.stringify({ say: "Alice, the release notes." }));
  await memories.keep(kept.id);
  assert.equal(JSON.parse(calls[0]!.user).promise.due, due, "the promise it keeps shows its time");
  const at = new Date(now).toISOString();
  const card = notesCard(client.store, [personSubject("ou_alice")]);
  assert.deepEqual(card.map((line) => [line.id, line.due, line.kept]), [[open.id, due, undefined], [kept.id, due, `${at.slice(0, 16)}Z`]]);
  assert.ok(!("kept" in card[0]!), "a promise yet to keep shows no kept");
  assert.deepEqual(noteLine(client.store, client.store.memory.get(kept.id)!),
    { id: kept.id, about: "ou_alice", kind: "promise", text: "Remind Alice to send the release notes", due, kept: `${at.slice(0, 16)}Z`, learned_in: "Team", updated: at.slice(0, 10) });
  for (const prompt of [reflectionPrompt("w33d", ""), ticketReflectionPrompt("w33d", "")]) assert.match(prompt, /A promise shown with kept was kept then/);
  // Reworded days later it still shows when it was kept, also on the card tidying reads.
  now += 3 * 86_400_000;
  assert.equal(applyOps(client.store, [{ op: "update", id: kept.id, text: "Remind Alice to send the notes" }], { subjects: () => undefined, shown: new Set([kept.id]) }, {}, new Date(now)), undefined);
  assert.equal(noteLine(client.store, client.store.memory.get(kept.id)!).kept, `${at.slice(0, 16)}Z`);
  write({ perSubject: 5 });
  for (let index = 0; index < 6; index++) client.store.memory.save(note({ about: personSubject("ou_alice"), text: `Alice note ${index}` }));
  await memories.tidy(personSubject("ou_alice"));
  const tidied = calls.at(-1)!;
  assert.match(tidied.system, /A promise shown with kept was kept then/);
  assert.deepEqual((JSON.parse(tidied.user) as { notes: { id: string; kept?: string }[] }).notes.filter((line) => line.kept).map((line) => line.id), [kept.id]);
});

test("a promise whose message cannot go out stays due, with no model call, until its Source listens there again", async () => {
  const due = new Date(now + 60_000).toISOString();
  const inChat = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes", due });
  const direct = note({ about: personSubject("ou_bob"), kind: "promise", text: "Remind Bob to stretch", due, origin: { chatId: "oc_dm_bob", direct: true } });
  for (const item of [inChat, direct]) client.store.memory.save(item);
  now += 120_000;
  write({}, {}, { enabled: false });
  memories.pass();
  assert.deepEqual(queued("promise"), [], "the Source is off");
  for (const item of [inChat, direct]) await memories.keep(item.id);
  assert.equal(calls.length, 0, "no model is asked for a message nobody can receive");
  assert.deepEqual(posts(), []);
  assert.deepEqual(client.store.memory.due(new Date(now).toISOString()).map((item) => item.id).sort(), [inChat.id, direct.id].sort(), "neither is used up");
  // On again but receiving no direct messages: only the one made in the chat can go out.
  write({}, {}, { config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: false } });
  now += 60_000;
  memories.pass();
  assert.deepEqual(queued("promise"), [inChat.id]);
  await memories.keep(direct.id);
  assert.equal(calls.length, 0);
  assert.equal(client.store.memory.get(direct.id)!.done, undefined);
  write();
  now += 60_000;
  memories.pass();
  assert.deepEqual(queued("promise").sort(), [inChat.id, direct.id].sort());
  answers.push(JSON.stringify({ say: "@Alice time to send the release notes." }), JSON.stringify({ say: "Bob, time to stretch." }));
  for (const item of [inChat, direct]) await memories.keep(item.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(posts().map((post) => [post.text, post.channel.address]), [
    ["@Alice time to send the release notes.", { chatId: CHAT, mode: "chat" }], ["Bob, time to stretch.", { userId: "ou_bob", mode: "user", direct: "true" }]]);
  assert.deepEqual(client.store.memory.due(new Date(now).toISOString()), []);
});

test("writes to nobody on its own, and spends none of the day's messages, while a direct message cannot go out", async () => {
  for (const [sender, text, ago] of [["ou_alice", "I lead the 2048 project", 900], ["ou_bob", "anyone know how to train it faster?", 800],
    ["ou_alice", "not me", 700], ["ou_alice", "call me Ali", 600]] as const) say(sender, text, ago);
  now += 600_000;
  memories.pass();
  const answer = JSON.stringify({ notes: [], reach_out: { to: "ou_bob", text: "Bob, try a larger batch size with mixed precision." } });
  // The Source off, then on but receiving no direct messages.
  for (const off of [{ enabled: false }, { config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: false } }]) {
    write({}, {}, off);
    answers.push(answer);
    await memories.reflect(CHAT);
    assert.deepEqual(posts(), []);
    assert.deepEqual(client.store.get(KV.memory.reached) ?? [], [], "a message not sent is not counted");
  }
  assert.equal(calls.length, 2);
  write();
  answers.push(answer);
  await memories.reflect(CHAT);
  assert.deepEqual(posts().map((post) => post.channel.address.userId), ["ou_bob"]);
  assert.deepEqual(client.store.get(KV.memory.reached)!.map((item) => item.person), ["ou_bob"]);
});

test("a promise with nowhere to go, such as one about itself made on a ticket, is kept without a message or a model call", async () => {
  const due = new Date(now + 60_000).toISOString();
  const onTicket = note({ about: SELF, kind: "promise", text: "Check that the release went out", due, origin: { ticketId: "t1" } });
  const inDirect = note({ about: SELF, kind: "promise", text: "Look at the build again", due, origin: { chatId: "oc_dm_bob", direct: true } });
  for (const item of [onTicket, inDirect]) client.store.memory.save(item);
  now += 120_000;
  // Whatever Sources are on: there is no chat or person to wait for.
  write({}, {}, { enabled: false });
  memories.pass();
  assert.deepEqual(queued("promise").sort(), [onTicket.id, inDirect.id].sort());
  for (const item of [onTicket, inDirect]) await memories.keep(item.id);
  assert.equal(calls.length, 0);
  assert.deepEqual(posts(), []);
  assert.deepEqual(client.store.memory.due(new Date(now).toISOString()), [], "neither stays due for good");
  assert.deepEqual(notesCard(client.store, [SELF]).map((line) => line.kept), Array(2).fill(`${new Date(now).toISOString().slice(0, 16)}Z`));
});

test("a kept promise stays kept when an update repeats the time it has, or gives one that is no time or long past", async () => {
  const promise = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to drink water", due: new Date(now + 10_000).toISOString() });
  client.store.memory.save(promise);
  now += 20_000;
  answers.push(JSON.stringify({ say: "Alice, water." }));
  await memories.keep(promise.id);
  now += 20_000;
  for (const due of [promise.due!, "tomorrow morning", new Date(now - 3_600_000).toISOString()]) {
    assert.equal(applyOps(client.store, [{ op: "update", id: promise.id, text: `Remind Alice to drink water, ${due}`, due }], { subjects: () => undefined, shown: new Set([promise.id]) }, {}, new Date(now)), undefined);
    const kept = client.store.memory.get(promise.id)!;
    assert.deepEqual([kept.text, kept.due, typeof kept.done], [`Remind Alice to drink water, ${due}`, promise.due, "string"]);
  }
  assert.deepEqual(client.store.memory.due(new Date(now + 86_400_000).toISOString()), []);
});

test("a promise changed or forgotten while its message is written is not overwritten, and one queued and then given a later time waits for it", async () => {
  const due = new Date(now + 60_000).toISOString();
  const moved = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes", due });
  const gone = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to stretch", due });
  const reworded = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to drink water", due });
  for (const item of [moved, gone, reworded]) client.store.memory.save(item);
  now += 120_000;
  const later = new Date(now + 3_600_000).toISOString();
  /** A memory whose model answers after `change` was made, as another effect makes one while it writes. */
  const during = (change: () => void) => new Memories({ client, now: () => now, complete: async () => { change(); return JSON.stringify({ say: "Alice, it is time." }); } });
  await during(() => { applyOps(client.store, [{ op: "update", id: moved.id, due: later }], { subjects: () => undefined, shown: new Set([moved.id]) }, {}, new Date(now)); }).keep(moved.id);
  await during(() => { client.store.memory.delete(gone.id); }).keep(gone.id);
  assert.deepEqual(posts(), [], "neither message is sent");
  assert.deepEqual([client.store.memory.get(moved.id)!.due, client.store.memory.get(moved.id)!.done], [later, undefined], "the new time stands");
  assert.equal(client.store.memory.get(gone.id), undefined, "a note forgotten is not written back");
  // One only reworded meanwhile is kept, and keeps its new words.
  await during(() => { applyOps(client.store, [{ op: "update", id: reworded.id, text: "Remind Alice to drink more water" }], { subjects: () => undefined, shown: new Set([reworded.id]) }, {}, new Date(now)); }).keep(reworded.id);
  assert.deepEqual(posts().map((post) => post.text), ["Alice, it is time."]);
  assert.deepEqual([client.store.memory.get(reworded.id)!.text, typeof client.store.memory.get(reworded.id)!.done], ["Remind Alice to drink more water", "string"]);
  // Its effect, queued when it first fell due, runs after the new time was given: nothing is asked or sent until then.
  await memories.keep(moved.id);
  assert.equal(calls.length, 0);
  assert.equal(client.store.memory.get(moved.id)!.done, undefined);
  now += 2 * 3_600_000;
  answers.push(JSON.stringify({ say: "Alice, the release notes." }));
  await memories.keep(moved.id);
  assert.deepEqual(posts().map((post) => post.text), ["Alice, it is time.", "Alice, the release notes."]);
  assert.equal(typeof client.store.memory.get(moved.id)!.done, "string");
});

test("a promise's message too long for a chat is cut to fit and sent", async () => {
  const promise = note({ about: personSubject("ou_alice"), kind: "promise", text: "Tell Alice how the release went", due: new Date(now + 60_000).toISOString() });
  client.store.memory.save(promise);
  now += 120_000;
  const long = Array.from({ length: 30 }, (_, index) => `Step ${index + 1} of the release went well for everyone here.`).join(" ");
  assert.equal(wordCount(long), 300);
  answers.push(JSON.stringify({ say: long }));
  await memories.keep(promise.id);
  const sent = posts().map((post) => post.text);
  assert.equal(sent.length, 1);
  assert.ok(wordCount(sent[0]!) > 0 && wordCount(sent[0]!) <= IM_WORDS, `${wordCount(sent[0]!)} words`);
  assert.ok(sent[0]!.endsWith("…") && long.startsWith(sent[0]!.slice(0, -1)), "what is sent is the start of the message");
  assert.equal(typeof client.store.memory.get(promise.id)!.done, "string");
});

test("gives up on an answer it cannot use after asking twice, and still fails when the call itself does", async () => {
  // A chat to reflect on, a ticket that ended, a subject whose notes grew too long, and a promise that fell due.
  for (const [sender, text, ago] of [["ou_alice", "I lead the 2048 project", 900], ["ou_bob", "anyone know how to train it faster?", 800],
    ["ou_alice", "not me", 700]] as const) say(sender, text, ago);
  const asked = say("ou_alice", "@w33d fix the README typo", 60, { mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(asked.id)!;
  const { ticketId } = client.engine.decide(asked.id, { kind: "accept", title: "Fix the README typo", scope: "x", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  client.engine.stopTicket(ticketId!, "done");
  write({ perSubject: 5 });
  for (let index = 0; index < 7; index++) client.store.memory.save(note({ about: personSubject("ou_alice"), text: `Alice note ${index}` }));
  const promise = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice", due: new Date(now + 60_000).toISOString() });
  client.store.memory.save(promise);
  now += 600_000;
  memories.pass();
  assert.ok(client.store.get(KV.memory.reflected(CHAT)));
  const sent = posts().length;
  /** How many times a model is asked when its first answer holds no JSON object and its second one the schema refuses. */
  const asks = async (run: () => Promise<void>, refused: unknown) => {
    const from = calls.length;
    answers.push("I would rather not say.", JSON.stringify(refused));
    await run();
    return calls.length - from;
  };
  assert.equal(await asks(() => memories.reflect(CHAT), { notes: "none" }), 2);
  assert.equal(await asks(() => memories.reflectTicket(ticketId!), { notes: "none" }), 2);
  assert.equal(await asks(() => memories.tidy(personSubject("ou_alice")), { notes: "none" }), 2);
  assert.equal(client.store.memory.get(promise.id)!.done, undefined);
  assert.equal(await asks(() => memories.keep(promise.id), { say: 5 }), 2);
  assert.deepEqual(answers, []);
  assert.deepEqual([client.store.memory.count(personSubject("ou_alice")), client.store.memory.count(chatSubject(CHAT)), client.store.memory.count(SELF)], [8, 0, 0], "nothing is kept or tidied");
  assert.equal(typeof client.store.memory.get(promise.id)!.done, "string", "the promise is not asked about again");
  assert.deepEqual(client.store.memory.due(new Date(now).toISOString()), []);
  assert.equal(posts().length, sent, "and nothing is posted for it");
  // A call that fails is an error still, which its effect tries again.
  const failing = new Memories({ client, now: () => now, complete: async () => { throw new Error("the model is unreachable"); } });
  const second = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice again", due: new Date(now - 60_000).toISOString() });
  client.store.memory.save(second);
  for (const run of [() => failing.reflect(CHAT), () => failing.reflectTicket(ticketId!), () => failing.tidy(personSubject("ou_alice")), () => failing.keep(second.id)]) {
    await assert.rejects(run, /the model is unreachable/);
  }
  assert.equal(client.store.memory.get(second.id)!.done, undefined);
});

test("the effects that reflect, keep a promise and tidy are over after two answers they cannot use, and one whose call fails waits to be tried again", async () => {
  for (const [sender, text, ago] of [["ou_alice", "I lead the 2048 project", 900], ["ou_bob", "anyone know how to train it faster?", 800],
    ["ou_alice", "not me", 700], ["ou_alice", "call me Ali", 600]] as const) say(sender, text, ago);
  write({ perSubject: 5 });
  for (let index = 0; index < 7; index++) client.store.memory.save(note({ about: personSubject("ou_alice"), text: `Alice note ${index}` }));
  const promise = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice", due: new Date(now + 60_000).toISOString() });
  client.store.memory.save(promise);
  now += 600_000;
  answers.push(...Array<string>(6).fill("I would rather not say."));
  memories.pass();
  (memories as unknown as { crowded(subjects: string[]): void }).crowded([personSubject("ou_alice")]);
  const waiting = () => [queued("reflect"), queued("promise"), queued("consolidate")];
  assert.deepEqual(waiting(), [[`chat:${CHAT}`], [promise.id], [personSubject("ou_alice")]]);
  // Nothing waits to be sent, so running the effects reaches no chat.
  assert.deepEqual(posts(), []);
  client.effects.start();
  await client.effects.idle();
  assert.equal(calls.length, 6, "each asked twice");
  assert.deepEqual(waiting(), [[], [], []], "none is left to try again");
  assert.equal(typeof client.store.memory.get(promise.id)!.done, "string");
  now += 120_000;
  memories.pass();
  await client.effects.idle();
  assert.deepEqual([calls.length, waiting(), posts()], [6, [[], [], []], []], "and the next pass queues none of them again");
  // A call that fails is another matter: its effect stays, with the failure counted, and the promise stays due.
  const second = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice again", due: new Date(now).toISOString() });
  client.store.memory.save(second);
  answers.push(new Error("the model is unreachable"));
  now += 120_000;
  memories.pass();
  await client.effects.idle();
  assert.deepEqual(client.store.db.prepare("SELECT key, attempts, error FROM effect WHERE kind = 'promise'").all().map((row) => ({ ...row })),
    [{ key: second.id, attempts: 1, error: "Error: the model is unreachable" }]);
  assert.equal(client.store.memory.get(second.id)!.done, undefined);
});

test("takes an answer whose notes is null for the empty list it would rather write, in a single call", async () => {
  for (const [sender, text, ago] of [["ou_alice", "I lead the 2048 project", 900], ["ou_bob", "anyone know how to train it faster?", 800],
    ["ou_alice", "not me", 700], ["ou_bob", "me neither", 600]] as const) say(sender, text, ago);
  now += 600_000;
  memories.pass();
  answers.push(JSON.stringify({ notes: null, reach_out: null }));
  await memories.reflect(CHAT);
  assert.equal(calls.length, 1);
  assert.deepEqual(client.store.memory.about(personSubject("ou_alice")), []);
  assert.deepEqual(logs, []);

  // A ticket that ended reads the same empty list the same way.
  const asked = say("ou_alice", "@w33d fix the README typo", 60, { mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(asked.id)!;
  const { ticketId } = client.engine.decide(asked.id, { kind: "accept", title: "Fix the README typo", scope: "x", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  client.engine.stopTicket(ticketId!, "done");
  answers.push(JSON.stringify({ notes: null }));
  calls = [];
  await memories.reflectTicket(ticketId!);
  assert.equal(calls.length, 1);
});

test("takes a promise's null message as none, marking it kept in a single call", async () => {
  const promise = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes",
    due: new Date(now).toISOString() });
  client.store.memory.save(promise);
  answers.push(JSON.stringify({ say: null }));
  await memories.keep(promise.id);
  assert.equal(calls.length, 1);
  assert.deepEqual(posts(), []);
  assert.equal(typeof client.store.memory.get(promise.id)!.done, "string");
});

test("takes a tidy's null notes as no change, in a single call", async () => {
  write({ perSubject: 5 });
  for (let index = 0; index < 6; index++) client.store.memory.save(note({ about: personSubject("ou_alice"), text: `Alice note ${index}` }));
  answers.push(JSON.stringify({ notes: null }));
  await memories.tidy(personSubject("ou_alice"));
  assert.equal(calls.length, 1);
  assert.equal(client.store.memory.count(personSubject("ou_alice")), 6);
});

test("notes each answer it could not use with its purpose, and a usable one with nothing", async () => {
  for (const [sender, text, ago] of [["ou_alice", "I lead the 2048 project", 900], ["ou_bob", "anyone know how to train it faster?", 800],
    ["ou_alice", "not me", 700], ["ou_bob", "me neither", 600]] as const) say(sender, text, ago);
  now += 600_000;
  memories.pass();
  answers.push("not json", "still not json");
  await memories.reflect(CHAT);
  assert.equal(calls.length, 2);
  assert.deepEqual(logs, ["superagent: no usable answer for superagent_memory after 2 tries: still not json"]);
  logs = [];
  answers.push(JSON.stringify({ notes: [] }));
  await memories.reflect(CHAT);
  assert.deepEqual(logs, []);

  // A promise's message that cannot be used is noted too, and the promise is still kept.
  const promise = note({ about: personSubject("ou_alice"), kind: "promise", text: "Remind Alice to send the release notes",
    due: new Date(now).toISOString() });
  client.store.memory.save(promise);
  answers.push("not json", "still not json");
  await memories.keep(promise.id);
  assert.deepEqual(logs, ["superagent: no usable answer for superagent_promise after 2 tries: still not json"]);
  assert.equal(typeof client.store.memory.get(promise.id)!.done, "string");

  // Reading a ticket that ended, and tidying a crowded subject, are noted under the same purpose.
  const asked = say("ou_alice", "@w33d fix the README typo", 60, { mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(asked.id)!;
  const { ticketId } = client.engine.decide(asked.id, { kind: "accept", title: "Fix the README typo", scope: "x", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  client.engine.stopTicket(ticketId!, "done");
  logs = [];
  answers.push("not json", "still not json");
  await memories.reflectTicket(ticketId!);
  assert.deepEqual(logs, ["superagent: no usable answer for superagent_memory after 2 tries: still not json"]);
  write({ perSubject: 5 });
  for (let index = 0; index < 6; index++) client.store.memory.save(note({ about: personSubject("ou_alice"), text: `Alice note ${index}` }));
  logs = [];
  answers.push("not json", "still not json");
  await memories.tidy(personSubject("ou_alice"));
  assert.deepEqual(logs, ["superagent: no usable answer for superagent_memory after 2 tries: still not json"]);
});
