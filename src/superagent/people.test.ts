/** The Feishu directory (people.ts): member lists read in the background, names messages carry, and the conversations cards show. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { AGAIN_MS, MEMBERS_MS, chatsToRead, conversation, findPeople, noticed, peopleIn, readMembers, senderOf } from "./people.js";
import { feishuTrigger } from "./sources/feishu.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-people-"));
  client = new SuperagentClient({ stateDir });
  client.store.set(KV.sources.labels("feishu"), { oc_team: "Team" });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** What lark-cli prints for a chat's members: people, and bots with their app ids. */
const listed = {
  users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" }],
  bots: [{ member_id: "ou_tickey", app_id: "cli_tickey", name: "Tickey" }]
};
let n = 0;
const message = (chat: string, sender: string, text: string, extra: Record<string, unknown> = {}) => feishuTrigger({ message_id: `om_${++n}`, chat_id: chat,
  chat_type: chat.startsWith("oc_dm") ? "p2p" : "group", sender_id: sender, sender_type: sender.startsWith("ou_tickey") ? "bot" : "user",
  content: text, create_time: String(Date.now() - 60_000 + n), mentions: [], ...extra }, "ou_bot", "cli_bot")!;

test("reads a chat's people and bots into the directory, and keeps the names it had when Feishu cannot list them", async () => {
  const calls: string[][] = [];
  await readMembers(async (args) => { calls.push(args); return listed; }, client.store, "oc_team", Date.parse("2026-11-10T06:00:00Z"));
  assert.deepEqual(calls, [["im", "+chat-members-list", "--chat-id", "oc_team", "--page-all", "--page-limit", "0"]]);
  assert.deepEqual(peopleIn(client.store, "oc_team", 10), [{ id: "ou_alice", name: "Alice" }, { id: "ou_bob", name: "Bob" }, { id: "ou_tickey", name: "Tickey", bot: true }]);
  assert.equal(client.store.get(KV.people.person("feishu", "cli_tickey"))?.name, "Tickey", "a bot's messages may carry its app id");
  const later = Date.parse("2026-11-10T13:00:00Z");
  await readMembers(async () => { throw new Error("not in the chat"); }, client.store, "oc_team", later);
  assert.equal(peopleIn(client.store, "oc_team", 10).length, 3);
  // A failed read is tried again after a while, not after the usual six hours.
  assert.deepEqual(chatsToRead(client.store, later + AGAIN_MS - 1000), []);
  assert.deepEqual(chatsToRead(client.store, later + AGAIN_MS + 1000), ["oc_team"]);
});

test("reads the chats never read first, then ones with a stranger in them, then stale ones, a few at a time", async () => {
  const now = Date.parse("2026-11-10T06:00:00Z");
  client.store.set(KV.sources.labels("feishu"), Object.fromEntries(["oc_a", "oc_b", "oc_c", "oc_d", "oc_e", "oc_f", "oc_g"].map((id) => [id, id])));
  client.store.set(KV.feishu.chats, { oc_dm1: true });
  for (const [chat, age, again] of [["oc_a", 1000, false], ["oc_b", MEMBERS_MS + 1000, false], ["oc_c", AGAIN_MS + 1000, true], ["oc_d", 1000, true]] as const) {
    client.store.set(KV.people.members(chat), { at: new Date(now - age).toISOString(), names: {}, again });
  }
  assert.deepEqual(chatsToRead(client.store, now), ["oc_e", "oc_f", "oc_g", "oc_dm1", "oc_c"]);
});

test("a message carries its sender's name and teaches the names it mentions; one from a stranger has its chat read again", async () => {
  await readMembers(async () => listed, client.store, "oc_team");
  const fromAlice = noticed(client.store, message("oc_team", "ou_alice", "@Carol can you look?", { mentions: [{ id: "ou_carol", key: "@_user_1", name: "Carol" }] }));
  assert.equal(fromAlice.meta.senderName, "Alice");
  assert.equal(client.store.get(KV.people.person("feishu", "ou_carol"))?.name, "Carol");
  const stranger = noticed(client.store, message("oc_team", "ou_dave", "hi"));
  assert.equal(stranger.meta.senderName, undefined);
  assert.equal(senderOf(client.store, stranger), "ou_dave");
  assert.equal(client.store.get(KV.people.members("oc_team"))?.again, true);
  assert.deepEqual(findPeople(client.store, "car").map((person) => person.name), ["Carol"]);
  assert.deepEqual(findPeople(client.store, "ali"), [{ id: "ou_alice", name: "Alice", chats: ["Team"] }]);
});

test("a conversation shows the chat's latest messages with names, bots and the agent's own words, and a topic only its own", async () => {
  await readMembers(async () => listed, client.store, "oc_team");
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const first = message("oc_team", "ou_alice", "anyone tried the new build?");
  client.engine.receive(noticed(client.store, first));
  client.engine.receive(noticed(client.store, message("oc_team", "ou_tickey", "I did, it works")));
  // A reply in a topic belongs to that topic, not to the chat's conversation.
  const inTopic = message("oc_team", "ou_bob", "details here", { root_id: first.meta.messageId, thread_id: "omt_1" });
  client.engine.receive(noticed(client.store, inTopic));
  client.outbox.send({ id: "r1", kind: "reply", text: "Works for me too.", channel: { source: "feishu", thread: "feishu:oc_team", address: { chatId: "oc_team", mode: "chat" } } });
  const asked = message("oc_team", "ou_bob", "@w33d what did Tickey say?");
  client.engine.receive(noticed(client.store, asked));
  const chat = conversation(client.store, asked, { since, limit: 12, chars: 300, exclude: new Set([asked.id]), self: "w33d" });
  assert.deepEqual(chat.map((line) => [line.from, line.text, line.bot ?? line.you ?? false]), [
    ["Alice", "anyone tried the new build?", false], ["Tickey", "I did, it works", true], ["w33d", "Works for me too.", true]
  ]);
  const topic = conversation(client.store, { ...inTopic, id: "other" }, { since, limit: 12, chars: 300 });
  assert.deepEqual(topic.map((line) => line.text), ["anyone tried the new build?", "details here"]);
});
