import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import type { Trigger } from "./core/index.js";
import { ChatterRoom, chatterPrompt, quietAt } from "./chatter.js";
import { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { feishuTrigger } from "./sources/feishu.js";
import { feishuUserChannel } from "./sources/feishu-trigger.js";

const CHAT = "oc_team", BOT = "ou_bot";
let stateDir: string;
let client: SuperagentClient;
let room: ChatterRoom;
let now: number;
let answers: string[];
let calls: { system: string; user: string; model?: string }[];
const write = (chatter: Record<string, unknown> = {}) => writeSettings({
  sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "all" }], directMessages: true } } },
  policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } },
  chatter: { chats: [CHAT], persona: "Dry humour, loves tea.", ...chatter }
}, settingsPath(stateDir));
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-chatter-"));
  write();
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: BOT, name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  now = Date.parse("2026-11-10T06:00:00Z");
  answers = [];
  calls = [];
  room = new ChatterRoom({ client, now: () => now,
    complete: async (input) => { calls.push(input); return answers.shift() ?? JSON.stringify({ say: null, reason: "nothing to add" }); } });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

let n = 0;
/** A message in the chat from `sender`, `ago` seconds before now. */
function message(sender: string, text: string, ago: number, mention = false): Trigger {
  n += 1;
  const at = now - ago * 1000;
  const trigger = feishuTrigger({ message_id: `om_${n}`, chat_id: CHAT, chat_type: "group", sender_id: sender, sender_type: "user",
    content: mention ? `@_user_1 ${text}` : text, create_time: String(at), mentions: mention ? [{ id: BOT, key: "@_user_1", name: "w33d" }] : [] }, BOT, "cli_app")!;
  client.engine.receive(trigger);
  return trigger;
}
const queued = () => client.store.db.prepare("SELECT key FROM effect WHERE kind = 'chatter'").all().map((row) => String(row.key));
const posts = () => client.store.db.prepare("SELECT value FROM outbox").all().map((row) => JSON.parse(String(row.value)) as { text: string; channel: { address: Record<string, string> } });

describe("when the agent considers a chat", () => {
  it("waits for a lull, then considers it once per new message and no more often than the settings allow", () => {
    message("ou_alice", "anyone tried the new tea place?", 30);
    room.pass();
    expect(queued()).toEqual([]);
    now += 61_000;
    room.pass();
    expect(queued()).toEqual([CHAT]);
    client.store.db.prepare("DELETE FROM effect").run();
    room.pass();
    expect(queued()).toEqual([]);
    // A new message waits for its lull and for the next consideration window.
    message("ou_bob", "not yet", -1);
    now += 120_000;
    room.pass();
    expect(queued()).toEqual([]);
    now += 8 * 60_000;
    room.pass();
    expect(queued()).toEqual([CHAT]);
  });
  it("leaves a message that mentions it to its router, and stays silent past its hourly budget and in quiet hours", () => {
    message("ou_alice", "@w33d hi", 200, true);
    room.pass();
    expect(queued()).toEqual([]);
    expect(client.store.get(KV.chatter.chat(CHAT))?.consideredAt).toBeDefined();
    client.store.set(KV.chatter.chat(CHAT), { said: [{ at: new Date(now - 60_000).toISOString(), text: "a" }, { at: new Date(now - 120_000).toISOString(), text: "b" }] });
    message("ou_alice", "so quiet today", 200);
    room.pass();
    expect(queued()).toEqual([]);
    expect(quietAt({ quiet: { from: 23, to: 7, timeZone: "Asia/Shanghai" } }, Date.parse("2026-11-10T16:30:00Z"))).toBe(true);
    expect(quietAt({ quiet: { from: 23, to: 7, timeZone: "Asia/Shanghai" } }, Date.parse("2026-11-10T06:00:00Z"))).toBe(false);
    expect(quietAt({}, now)).toBe(false);
  });
});

describe("a consideration", () => {
  it("reads the chat and what the agent said there, and posts into the chat what it says, quoting the message it answers", async () => {
    const asked = message("ou_alice", "anyone tried the new tea place?", 300);
    message("ou_bob", "is it the one near the station?", 200);
    client.store.set(KV.chatter.chat(CHAT), { said: [{ at: new Date(now - 250_000).toISOString(), text: "Tea is always the answer." }] });
    answers.push(JSON.stringify({ say: "The oolong there is worth the queue.", reply_to: asked.meta.messageId, reason: "a tea question" }));
    await room.consider(CHAT);
    expect(calls[0]!.system).toContain("You are w33d, a member of a group chat");
    expect(calls[0]!.system).toContain("Dry humour, loves tea.");
    const card = JSON.parse(calls[0]!.user) as { messages: { from: string; text: string; you?: true }[] };
    expect(card.messages.map((item) => [item.from, item.text, item.you ?? false])).toEqual([
      ["ou_alice", "anyone tried the new tea place?", false], ["w33d", "Tea is always the answer.", true], ["ou_bob", "is it the one near the station?", false]]);
    expect(posts()).toEqual([expect.objectContaining({ text: "The oolong there is worth the queue.",
      channel: { source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, mode: "chat", messageId: asked.meta.messageId } } })]);
    expect(client.store.get(KV.chatter.chat(CHAT))?.said.map((item) => item.text)).toEqual(["Tea is always the answer.", "The oolong there is worth the queue."]);
  });
  it("posts nothing when it decides to say nothing, repeats itself, or would say too much", async () => {
    message("ou_alice", "lunch?", 300);
    await room.consider(CHAT);
    client.store.set(KV.chatter.chat(CHAT), { said: [{ at: new Date(now - 1000).toISOString(), text: "Same as yesterday." }] });
    answers.push(JSON.stringify({ say: "Same as yesterday.", reason: "again" }), JSON.stringify({ say: "word ".repeat(80), reason: "long" }));
    await room.consider(CHAT);
    await room.consider(CHAT);
    expect(posts()).toEqual([]);
  });
  it("is not asked for a chat the owner turned it off for, and uses its own model when the settings name one", async () => {
    message("ou_alice", "hello?", 300);
    write({ chats: [] });
    await room.consider(CHAT);
    expect(calls).toEqual([]);
    write({ model: "deepseek/deepseek-chat" });
    await room.consider(CHAT);
    expect(calls[0]!.model).toBe("deepseek/deepseek-chat");
  });
});

it("says in its instructions who it is, and that silence is the usual answer", () => {
  expect(chatterPrompt("", "")).toContain("You are the bot, a member of a group chat on Feishu");
  expect(chatterPrompt("w33d", "")).toContain("Most of the time the right answer is nothing");
});

it("remembers what it says in a Feishu chat, whatever sends it, once, and nothing it sends to a person's direct messages", () => {
  const chat = (address: Record<string, string>) => ({ source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, ...address } });
  client.outbox.send({ id: "r1", kind: "acknowledgement", text: "On it.", channel: chat({ messageId: "om_1" }) });
  client.outbox.send({ id: "r1", kind: "acknowledgement", text: "On it.", channel: chat({ messageId: "om_1" }) });
  client.outbox.send({ id: "r2", kind: "notice", text: "Tea?", channel: chat({ mode: "chat" }) });
  client.outbox.send({ id: "r3", kind: "reply", text: "Morning!", channel: chat({ messageId: "om_2", mode: "chat" }) });
  client.outbox.send({ id: "r4", kind: "reply", text: "Enter ABCD-1234.", channel: feishuUserChannel("ou_alice") });
  expect(client.store.get(KV.chatter.chat(CHAT))?.said.map(({ at: _at, ...entry }) => entry)).toEqual([
    { text: "On it.", to: "om_1", topic: true }, { text: "Tea?" }, { text: "Morning!", to: "om_2" }
  ]);
});
