/** What the memory journal records (journal.ts, memories.ts): what a reflection kept, and why a promise or a note to someone was not sent. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { Journal, journaled } from "./journal.js";
import { KV } from "./kv.js";
import { Memories, chatSubject, personSubject, type Note } from "./memories.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { feishuTrigger } from "./sources/feishu.js";

const CHAT = "oc_team";
let stateDir: string;
let client: SuperagentClient;
let memories: Memories;
let now: number;
let answers: (string | Error)[];
let calls: { purpose: string; user: string }[];
const write = (memory: Record<string, unknown> = {}) => writeSettings({
  sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: true } } },
  policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }, { id: "ou_bob" }] } } },
  chatter: { persona: "Dry humour." }, memory: { enabled: true, ...memory }
}, settingsPath(stateDir));
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-memories-journal-"));
  write();
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: "ou_bot", name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  client.journal = new Journal(client.store, () => new Date(now));
  now = Date.parse("2026-11-10T06:00:00Z");
  answers = [];
  calls = [];
  memories = new Memories({ client, now: () => now,
    complete: journaled(client.journal, async (input) => {
      calls.push(input);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? JSON.stringify({ notes: [] });
    }) });
});
afterEach(() => { client.close(); rmSync(stateDir, { recursive: true, force: true }); });

let n = 0;
const note = (fields: Partial<Note> & Pick<Note, "about" | "text">): Note => ({ id: `n${++n}`, kind: "fact", origin: { chatId: CHAT },
  created: new Date(now).toISOString(), updated: new Date(now).toISOString(), ...fields });
function say(sender: string, text: string, ago: number) {
  const trigger = feishuTrigger({ message_id: `om_${++n}`, chat_id: CHAT, chat_type: "group", sender_id: sender, sender_type: "user",
    content: text, create_time: String(now - ago * 1000), mentions: [] }, "ou_bot", "cli_app")!;
  client.engine.receive(trigger);
  return trigger;
}
const runs = (key: string) => client.journal!.byKey(key);

test("a reflection that keeps notes is silent, and says how many it kept", async () => {
  const trigger = say("ou_alice", "the release is on Friday", 400);
  // A mark makes the reflection due: the chat went quiet with one message.
  client.store.set(KV.memory.reflected(CHAT), { at: new Date(now - 3_600_000).toISOString(), from: new Date(now - 86_400_000).toISOString(), upTo: new Date(now - 400_000).toISOString() });
  answers.push(JSON.stringify({ notes: [{ op: "add", about: trigger.actor.id, kind: "event", text: "the release is on Friday" }] }));
  await memories.reflect(CHAT);
  const [run] = runs(`chat:${CHAT}`);
  assert.equal(run!.purpose, "superagent_memory");
  assert.equal(run!.outcome, "silent");
  assert.equal(run!.reason, "1 notes kept");
  assert.equal(client.store.memory.about(personSubject(trigger.actor.id)).length, 1);
});

test("a reflection whose call fails records that it failed, and one with no usable answer says so", async () => {
  say("ou_alice", "the release is on Friday", 400);
  client.store.set(KV.memory.reflected(CHAT), { at: new Date(now - 3_600_000).toISOString(), from: new Date(now - 86_400_000).toISOString(), upTo: new Date(now - 400_000).toISOString() });
  answers.push("not json", "still not json");
  await memories.reflect(CHAT);
  // Each try is its own run: the first closes as retried when the second starts, and the second ends silent.
  assert.deepEqual(runs(`chat:${CHAT}`).map((run) => [run.outcome, run.reason]), [["dropped", "retried"], ["silent", "no usable answer after 2 tries"]]);
});

test("a promise with nowhere to send is skipped as such and still kept, and one that goes out records its message", async () => {
  // About itself, with no conversation it was made in: nowhere to send it.
  const nowNote = note({ about: "self", kind: "promise", text: "stretch", due: new Date(now - 60_000).toISOString(), origin: {} });
  client.store.memory.save(nowNote);
  await memories.keep(nowNote.id);
  assert.equal(runs(`note:${nowNote.id}`)[0]!.outcome, "skipped");
  assert.equal(runs(`note:${nowNote.id}`)[0]!.reason, "nowhere to send");
  assert.ok(client.store.memory.get(nowNote.id)!.done, "it is still kept, without a message");

  const owed = note({ about: personSubject("ou_alice"), kind: "promise", text: "remind about the report", due: new Date(now - 60_000).toISOString() });
  client.store.memory.save(owed);
  answers.push(JSON.stringify({ say: "The report is due today." }));
  await memories.keep(owed.id);
  const run = runs(`note:${owed.id}`)[0]!;
  assert.equal(run.outcome, "sent");
  assert.equal(run.outbox?.length, 1);
  assert.equal(client.store.receipts.get(run.outbox![0]!)?.text, "The report is due today.");
});

test("a promise whose message is null is silent, and one the chat cannot receive is skipped", async () => {
  const owed = note({ about: personSubject("ou_alice"), kind: "promise", text: "remind", due: new Date(now - 60_000).toISOString() });
  client.store.memory.save(owed);
  answers.push(JSON.stringify({ say: null }));
  await memories.keep(owed.id);
  assert.deepEqual(runs(`note:${owed.id}`).map((run) => [run.outcome, run.reason]), [["silent", "the model said null"]]);

  const muted = note({ about: chatSubject(CHAT), kind: "promise", text: "say hi", due: new Date(now - 60_000).toISOString() });
  client.store.memory.save(muted);
  write();
  // The chat listens for mentions only: a message there cannot go out.
  client.store.memory.save({ ...muted, origin: { chatId: CHAT } });
  client.store.set(KV.chatter.chat(CHAT), { said: [] });
  const { channelAllowed } = client.sources;
  client.sources.channelAllowed = () => false;
  try { await memories.keep(muted.id); } finally { client.sources.channelAllowed = channelAllowed }
  assert.deepEqual(runs(`note:${muted.id}`).map((run) => [run.outcome, run.reason]), [["skipped", "the chat cannot receive it"]]);
});

test("a reflection that writes to someone records what it queued, and one blocked by the day's cap records why", async () => {
  const first = say("ou_alice", "can you look at the deck later?", 400);
  client.store.set(KV.memory.reflected(CHAT), { at: new Date(now - 3_600_000).toISOString(), from: new Date(now - 86_400_000).toISOString(), upTo: new Date(now - 400_000).toISOString() });
  answers.push(JSON.stringify({ notes: [], reach_out: { to: first.actor.id, text: "About the deck: I will look at it tonight." } }));
  await memories.reflect(CHAT);
  const sent = runs(`chat:${CHAT}`).at(-1)!;
  assert.equal(sent.outcome, "sent");
  assert.equal(client.store.receipts.get(sent.outbox![0]!)?.channel.address.userId, first.actor.id);

  const second = say("ou_alice", "and the slides too", 300);
  client.store.set(KV.memory.reflected(CHAT), { at: new Date(now - 3_600_000).toISOString(), from: new Date(now - 86_400_000).toISOString(), upTo: new Date(now - 300_000).toISOString() });
  answers.push(JSON.stringify({ notes: [], reach_out: { to: second.actor.id, text: "I will look at the slides too." } }));
  await memories.reflect(CHAT);
  const blocked = runs(`person:${second.actor.id}:${new Date(now).toISOString()}`).at(-1)!;
  assert.deepEqual([blocked.outcome, blocked.reason], ["skipped", "it wrote to them already today"]);
  assert.equal(calls.length, 2);
});

test("a tidy records its run and its outcome under one key, the short subject the journal places it by", async () => {
  // Enough notes about a person to crowd the subject and start a tidy.
  write({ perSubject: 8 });
  const about = personSubject("ou_alice");
  for (let index = 0; index < 12; index++) client.store.memory.save(note({ about, text: `fact ${index}` }));
  answers.push(JSON.stringify({ notes: [] }));
  await memories.tidy(about);
  assert.equal(client.journal!.byKey("subject:ou_alice").length, 1, "one row, not a start and an orphaned outcome");
  assert.equal(client.journal!.byKey("subject:ou_alice")[0]!.outcome, "silent");
  assert.equal(client.journal!.byKey(`subject:${about}`).length, 0, "no row left under the long subject");
});
