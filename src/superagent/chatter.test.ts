import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import type { Trigger } from "./core/index.js";
import { ChatterRoom, chatterPrompt, namesAgent, quietAt } from "./chatter.js";
import { ask, openAsks } from "./asks.js";
import { posted } from "./people.js";
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

describe("in every group", () => {
  it("joins in on its own wherever it is unless an owner turned it off there, counting only what it said on its own, and @s whom it answers", async () => {
    const { readMembers } = await import("./people.js");
    client.store.set(KV.sources.labels("feishu"), { [CHAT]: "Team" });
    await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }] }), client.store, CHAT);
    write({ chats: [], everywhere: true, off: [CHAT] });
    const asked = message("ou_alice", "anyone tried the new tea place?", 200);
    room.pass();
    expect(queued()).toEqual([]);
    write({ chats: [], everywhere: true });
    // Two answers it gave when asked leave its hourly budget for speaking on its own.
    client.store.set(KV.chatter.chat(CHAT), { said: [{ at: new Date(now - 60_000).toISOString(), text: "a" }, { at: new Date(now - 90_000).toISOString(), text: "b" }], spoke: [] });
    room.pass();
    expect(queued()).toEqual([CHAT]);
    answers.push(JSON.stringify({ say: "@Alice the oolong is worth the queue.", reply_to: asked.meta.messageId, mention: "ou_alice", reason: "a tea question" }));
    await room.consider(CHAT);
    expect(posts().at(-1)).toEqual(expect.objectContaining({ text: "@Alice the oolong is worth the queue.", mentions: [{ id: "ou_alice", name: "Alice" }] }));
    expect(client.store.get(KV.chatter.chat(CHAT))?.spoke?.length).toBe(1);
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

describe("when messages call for the agent that its router does not answer", () => {
  /** A message in the chat from another bot, `ago` seconds before now, @-mentioning the agent or quoting `parent`. */
  function botMessage(sender: string, text: string, ago: number, options: { mention?: boolean; parent?: string } = {}): Trigger {
    n += 1;
    const trigger = feishuTrigger({ message_id: `om_${n}`, chat_id: CHAT, chat_type: "group", sender_id: sender, sender_type: "bot",
      content: options.mention ? `@_user_1 ${text}` : text, create_time: String(now - ago * 1000), ...(options.parent ? { parent_id: options.parent } : {}),
      mentions: options.mention ? [{ id: BOT, key: "@_user_1", name: "w33d" }] : [] }, BOT, "cli_app")!;
    client.engine.receive(trigger);
    return trigger;
  }
  const attending = () => client.store.db.prepare("SELECT value FROM effect WHERE kind = 'attend'").all()
    .map((row) => JSON.parse(String(row.value)) as { chatId: string; ids: string[] });
  const home = { source: "feishu", thread: "feishu:oc_home", address: { chatId: "oc_home", messageId: "om_q", mode: "chat" } };

  it("passes on another bot's answer to what it asked for someone, with an @, answers the bot once, and stops waiting", async () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 Alice 让我问问 loader 的进度", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    const reply = botMessage("ou_feifei", "规范基本定了，还差谁能合 main、怎么发版", 0, { mention: true });
    room.pass();
    expect(attending()).toEqual([]);
    now += 16_000;
    room.pass();
    const [queuedAttend] = attending();
    expect(queuedAttend).toEqual({ chatId: CHAT, ids: [reply.id] });
    answers.push(JSON.stringify({ reply: { text: "收到，我转告 Alice", reply_to: reply.meta.messageId }, relay: [{ question: "ask-1", text: "飞飞说规范基本定了，还差合 main 和发版" }] }));
    await room.attend(CHAT, queuedAttend!.ids);
    const card = JSON.parse(calls[0]!.user) as { your_questions: { id: string; asked_for: string }[]; messages: { for_you?: string; bot?: true }[] };
    expect(card.your_questions).toEqual([{ id: "ask-1", asked_for: "Alice", asked: "@飞飞 Alice 让我问问 loader 的进度", at: new Date(now - 17_000).toISOString() }]);
    expect(card.messages.find((line) => line.for_you)).toMatchObject({ for_you: "answers_your_question", bot: true });
    const sent = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as
      { text: string; channel: { address: Record<string, string> }; mentions?: { id: string }[] });
    expect(sent.map((post) => [post.channel.address.chatId, post.text, post.mentions?.map((mention) => mention.id) ?? []])).toEqual([
      ["oc_home", "飞飞说规范基本定了，还差合 main 和发版", ["ou_alice"]],
      [CHAT, "收到，我转告 Alice", []]
    ]);
    expect(sent[1]!.channel.address.messageId).toBe(reply.meta.messageId);
    expect(openAsks(client.store, now)).toEqual([]);
    // With nothing left to wait for, the bot's next @ is an ordinary one, which it answers within its budget for bots.
    expect(client.store.get(KV.chatter.chat(CHAT))?.answered).toEqual([{ at: new Date(now).toISOString(), bot: true }]);
  });

  it("answers someone who names it or replies to its message and a bot that @-mentions it, leaves a person's @ to its router, and holds bots to a few an hour", async () => {
    room.pass();
    now += 1000;
    posted(client.store, CHAT, "om_mine");
    const named = message("ou_bob", "w33d 你觉得这个方案行吗", 0);
    message("ou_bob", "文档在 w33d.xyz/docs", 0);
    message("ou_alice", "@w33d 帮我看看", 0, true);
    const quoted = feishuTrigger({ message_id: "om_quote", chat_id: CHAT, chat_type: "group", sender_id: "ou_carol", sender_type: "user", content: "真的吗？",
      create_time: String(now), parent_id: "om_mine", mentions: [] }, BOT, "cli_app")!;
    client.engine.receive(quoted);
    const pinged = botMessage("ou_tickey", "你那边有 fixtures 的结果吗", 0, { mention: true });
    botMessage("ou_tickey", "我先去忙了", 0);
    now += 16_000;
    room.pass();
    expect(attending()[0]?.ids).toEqual([named.id, quoted.id, pinged.id]);
    // Past its budget for bots, the bot's message is not answered; people's still are.
    const hour = Array.from({ length: 4 }, () => ({ at: new Date(now - 60_000).toISOString(), bot: true as const }));
    client.store.set(KV.chatter.chat(CHAT), { ...client.store.get(KV.chatter.chat(CHAT))!, answered: hour });
    answers.push(JSON.stringify({ reply: { text: "Tickey 的我也回一下", reply_to: pinged.meta.messageId }, relay: [] }));
    await room.attend(CHAT, [pinged.id]);
    expect(calls).toEqual([]);
    answers.length = 0;
    answers.push(JSON.stringify({ reply: { text: "行，我觉得可以先上", reply_to: named.meta.messageId, mention: "ou_bob" }, relay: [] }));
    await room.attend(CHAT, [named.id, quoted.id, pinged.id]);
    const card = JSON.parse(calls[0]!.user) as { messages: { id?: string; for_you?: string }[] };
    expect(card.messages.filter((line) => line.for_you).map((line) => line.for_you)).toEqual(["names_you", "replies_to_you", "mentions_you"]);
    expect(posts().map((post) => [post.text, post.channel.address.messageId])).toEqual([["行，我觉得可以先上", named.meta.messageId]]);
  });

  it("knows its name as a word, not inside a link", () => {
    expect(["w33d 你看看", "问问W33D", "@w33d 在吗", "ok w33d."].map((text) => namesAgent(text, "w33d"))).toEqual([true, true, true, true]);
    expect(["see w33d.xyz", "x@w33d.xyz", "aw33d", "w33d_bot"].map((text) => namesAgent(text, "w33d"))).toEqual([false, false, false, false]);
    expect(namesAgent("奶蛋你来", "奶蛋")).toBe(true);
  });
});
