import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import type { Trigger } from "./core/index.js";
import { ChatterRoom, attendPrompt, chatterPrompt, namesAgent, quietAt } from "./chatter.js";
import { CHAT_CREDENTIALS, CHAT_SAFETY, OWN_WORDS, UNSEEN_MEDIA } from "./prompt-text.js";
import { cutToFit, wordCount } from "./text.js";
import { ask, closeAsks, openAsks } from "./asks.js";
import { posted } from "./people.js";
import { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { feishuTrigger } from "./sources/feishu.js";
import { feishuUserChannel } from "./sources/feishu-trigger.js";
import { Commands } from "./commands.js";
import { vi } from "./testing/expect.js";

const CHAT = "oc_team", BOT = "ou_bot";
let stateDir: string;
let client: SuperagentClient;
let room: ChatterRoom;
let now: number;
let answers: string[];
let calls: { system: string; user: string; model?: string }[];
/** What the room noted through its host's log, such as a model answer it could not use. */
let logs: string[];
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
  logs = [];
  room = new ChatterRoom({ client, now: () => now, log: (message) => { logs.push(message); },
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
  it("counts the media it cannot show on its card, and marks the agent's own words a ticket said", async () => {
    message("ou_alice", "[Image: img_v3_aaa] 看这个", 300);
    message("ou_bob", "[Image: img_v3_bbb] 还有这个", 250);
    // What the outbox records with a ticket id is a ticket's words; nothing else on the card writes that field.
    // `spoke` counts what it said on its own; without it two said entries an hour old would spend the hourly budget.
    client.store.set(KV.chatter.chat(CHAT), { spoke: [], said: [
      { at: new Date(now - 200_000).toISOString(), text: "ticket report", ticket: "f4df52f8" },
      { at: new Date(now - 150_000).toISOString(), text: "my own talk" }] });
    await room.consider(CHAT);
    const card = JSON.parse(calls[0]!.user) as { messages: ({ media?: number; from_ticket?: string; you?: true; text: string })[] };
    expect(card.messages.map((line) => [line.text, line.media ?? 0, line.from_ticket ?? null, line.you ?? false])).toEqual([
      ["[Image: img_v3_aaa] 看这个", 1, null, false], ["[Image: img_v3_bbb] 还有这个", 1, null, false],
      ["ticket report", 0, "f4df52f8", true], ["my own talk", 0, null, true]]);
  });
  it("lists this chat's tickets on the card, with the state each is in", async () => {
    const started = message("ou_alice", "把这个报错修一下", 500);
    client.store.tickets.save({ id: "f4df52f8", title: "Fix the crash", mandate: { strength: "explicit" }, origin: { triggerId: started.id },
      assignments: [], inputs: [], undelivered: [], activity: [], createdAt: new Date(now - 400_000).toISOString() } as never);
    message("ou_alice", "another thing", 300);
    await room.consider(CHAT);
    const card = JSON.parse(calls[0]!.user) as { tickets?: { ticket_id: string; title: string; state: string }[] };
    expect(card.tickets?.map((ticket) => [ticket.ticket_id, ticket.title, ticket.state])).toEqual([["f4df52f8", "Fix the crash", "working/queued"]]);
  });
  it("sees other bots' replies: one answering a person restarts the lull and is on the card, marked bot", async () => {
    message("ou_alice", "@yyu 在吗？", 120);
    n += 1;
    const reply = feishuTrigger({ message_id: `om_${n}`, chat_id: CHAT, chat_type: "group", sender_id: "ou_yyu", sender_type: "bot",
      content: "在的，什么事？", create_time: String(now - 30_000), mentions: [] }, BOT, "cli_app")!;
    client.engine.receive(reply);
    // The person wrote two minutes ago, but the bot answered 30 s ago: the chat is not quiet yet.
    room.pass();
    expect(queued()).toEqual([]);
    now += 61_000;
    room.pass();
    expect(queued()).toEqual([CHAT]);
    await room.consider(CHAT);
    const card = JSON.parse(calls[0]!.user) as { messages: { from_id?: string; text: string; bot?: true }[] };
    expect(card.messages.map((line) => [line.from_id, line.text, line.bot ?? false])).toEqual([["ou_alice", "@yyu 在吗？", false], ["ou_yyu", "在的，什么事？", true]]);
    expect(calls[0]!.system).toMatch(/A bot's reply counts as an answer/);
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
  it("asks once more for an answer it cannot use, then says nothing rather than ask forever, and considers the chat as usual the next time", async () => {
    const asked = message("ou_alice", "anyone tried the new tea place?", 300);
    answers.push("not json", '{"say": 5}');
    await room.consider(CHAT);
    expect(calls.length).toBe(2);
    expect(posts()).toEqual([]);
    expect(client.store.get(KV.chatter.chat(CHAT))?.spoke).toBeUndefined();
    answers.push(JSON.stringify({ say: "The oolong there is worth the queue.", reply_to: asked.meta.messageId, reason: "a tea question" }));
    await room.consider(CHAT);
    expect(calls.length).toBe(3);
    expect(posts().map((post) => [post.text, post.channel.address.messageId])).toEqual([["The oolong there is worth the queue.", asked.meta.messageId]]);
  });
  it("posts what the second answer says when only the first cannot be used", async () => {
    message("ou_alice", "anyone tried the new tea place?", 300);
    answers.push("I would rather not answer in JSON.", JSON.stringify({ say: "The oolong there is worth the queue.", reason: "a tea question" }));
    await room.consider(CHAT);
    expect(calls.length).toBe(2);
    expect(posts().map((post) => post.text)).toEqual(["The oolong there is worth the queue."]);
    expect(client.store.get(KV.chatter.chat(CHAT))?.spoke?.length).toBe(1);
  });
  it("takes an answer whose reason runs far past what it asked for: it never reads the reason", async () => {
    message("ou_alice", "anyone tried the new tea place?", 300);
    const reason = "because ".repeat(75);
    expect(reason.length).toBe(600);
    answers.push(JSON.stringify({ say: "The oolong there is worth the queue.", reason }));
    await room.consider(CHAT);
    expect(calls.length).toBe(1);
    expect(posts().map((post) => post.text)).toEqual(["The oolong there is worth the queue."]);
  });
  it("ends its effect when no answer can be used, and keeps it for another try when the call itself fails", async () => {
    let down = false;
    const live = new ChatterRoom({ client, now: () => now,
      complete: async (input) => { calls.push(input); if (down) throw new Error("network down"); return answers.shift()!; } });
    live.install();
    client.effects.start();
    const waiting = () => client.store.db.prepare("SELECT key, attempts, error FROM effect WHERE kind = 'chatter'").all().map((row) => [row.key, row.attempts, row.error]);
    message("ou_alice", "anyone tried the new tea place?", 200);
    answers.push("not json", '{"say": 5}');
    live.pass();
    expect(queued()).toEqual([CHAT]);
    await client.effects.idle("chatter");
    expect([calls.length, waiting(), posts()]).toEqual([2, [], []]);
    // A call that fails is another matter: it rejects, and its effect stays to be tried again.
    down = true;
    await expect(live.consider(CHAT)).rejects.toThrow(/network down/);
    client.store.atomic(() => { client.effects.enqueue("chatter", CHAT, { chatId: CHAT }); });
    await client.effects.idle("chatter");
    expect([calls.length, waiting()]).toEqual([4, [[CHAT, 1, "Error: network down"]]]);
    await client.effects.drain();
  });
});

it("shows on the card what the host read of a file a message carries, and keeps the read for the next card", async () => {
  const downloads: string[] = [];
  vi.spyOn(Commands.prototype, "lark").mockImplementation(async (args: string[], cwd?: string) => {
    downloads.push(args.join(" "));
    if (!cwd) throw new Error(`unexpected lark ${args.join(" ")}`);
    writeFileSync(join(cwd, "周报.csv"), "本周进展,完成 A & B\n");
    return { saved_path: "周报.csv" };
  });
  const doc = message("ou_alice", '<file key="file_v3_doc" name="周报.csv"/> 这周的进展', 300);
  answers.push(JSON.stringify({ say: null, reason: "nothing to add" }));
  await room.consider(CHAT);
  const card = JSON.parse(calls[0]!.user) as { messages: { id: string; media?: number; media_excerpt?: { text?: string }[] }[] };
  const line = card.messages.find((item) => item.id === String(doc.meta.messageId))!;
  expect(line.media).toBe(1);
  expect(line.media_excerpt?.[0]?.text).toBe("本周进展,完成 A & B\n");
  expect(downloads.length).toBe(1);
  // The read is kept under the message and file key: the next card costs no download.
  answers.push(JSON.stringify({ say: null, reason: "nothing to add" }));
  await room.consider(CHAT);
  expect(downloads.length).toBe(1);
  const again = JSON.parse(calls[1]!.user) as { messages: { id: string; media_excerpt?: { text?: string }[] }[] };
  expect(again.messages.find((item) => item.id === String(doc.meta.messageId))?.media_excerpt?.[0]?.text).toBe("本周进展,完成 A & B\n");
  vi.restoreAllMocks();
});

it("says in its instructions who it is, and that silence is the usual answer", () => {
  expect(chatterPrompt("", "")).toContain("You are the bot, a member of a group chat on Feishu");
  expect(chatterPrompt("w33d", "")).toContain("Most of the time the right answer is nothing");
});

it("tells every talk-only call that it has no tools, cannot promise, cannot see media and keeps secrets out of groups", () => {
  for (const [prompt, noun] of [[chatterPrompt("w33d", ""), "answer"], [attendPrompt("w33d", ""), "reply"]] as const) {
    expect(prompt).toContain(`Never promise anything you do not do in this ${noun}.`);
    expect(prompt).toContain("there is no later turn of yours");
    expect(prompt).toContain(OWN_WORDS);
    expect(prompt).toContain(UNSEEN_MEDIA);
    expect(prompt).toContain(CHAT_SAFETY);
  }
  // The credentials sentence alone is what the promise keeper adds (memories.test.ts); the rest stays out of it.
  expect(CHAT_SAFETY).toContain(CHAT_CREDENTIALS);
});

it("remembers what it says in a Feishu chat, whatever sends it, once, and nothing it sends to a person's direct messages", () => {
  const chat = (address: Record<string, string>) => ({ source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, ...address } });
  client.outbox.send({ id: "r1", kind: "acknowledgement", text: "On it.", channel: chat({ messageId: "om_1" }) });
  client.outbox.send({ id: "r1", kind: "acknowledgement", text: "On it.", channel: chat({ messageId: "om_1" }) });
  client.outbox.send({ id: "r2", kind: "notice", text: "Tea?", channel: chat({ mode: "chat" }) });
  client.outbox.send({ id: "r3", kind: "reply", text: "Morning!", channel: chat({ messageId: "om_2", mode: "chat" }) });
  client.outbox.send({ id: "r4", kind: "reply", text: "Enter ABCD-1234.", channel: feishuUserChannel("ou_alice") });
  // A message a ticket sent carries its id; one chatter or a memory sent is the agent's own talk, with none.
  client.outbox.send({ id: "r5", kind: "notice", text: "最小请求已发出，返回 403", channel: chat({ mode: "chat" }), ticketId: "f4df52f8" });
  client.outbox.send({ id: "r6", kind: "notice", text: "我先去问问予谦", channel: chat({ mode: "chat" }) });
  expect(client.store.get(KV.chatter.chat(CHAT))?.said.map(({ at: _at, ...entry }) => entry)).toEqual([
    { text: "On it.", to: "om_1", topic: true }, { text: "Tea?" }, { text: "Morning!", to: "om_2" },
    { text: "最小请求已发出，返回 403", ticket: "f4df52f8" }, { text: "我先去问问予谦" }
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
    expect(queuedAttend).toEqual({ chatId: CHAT, source: "feishu", ids: [reply.id] });
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
    // With nothing left to wait for, the bot's next @ is an ordinary one; what it answered is kept for the record.
    expect(client.store.get(KV.chatter.chat(CHAT))?.answered).toEqual([{ at: new Date(now).toISOString(), bot: true }]);
  });

  it("answers someone who names it or replies to its message and a bot that @-mentions it, leaves a person's @ to its router, and answers bots however often it is called", async () => {
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
    // However often it answered bots lately, it answers this one too.
    const hour = Array.from({ length: 30 }, (_, index) => ({ at: new Date(now - 60_000 + index).toISOString(), bot: true as const }));
    client.store.set(KV.chatter.chat(CHAT), { ...client.store.get(KV.chatter.chat(CHAT))!, answered: hour });
    answers.push(JSON.stringify({ reply: { text: "fixtures 我这边还没跑", reply_to: pinged.meta.messageId }, relay: [] }));
    await room.attend(CHAT, [pinged.id]);
    expect(calls.length).toBe(1);
    answers.push(JSON.stringify({ reply: { text: "行，我觉得可以先上", reply_to: named.meta.messageId, mention: "ou_bob" }, relay: [] }));
    await room.attend(CHAT, [named.id, quoted.id, pinged.id]);
    const card = JSON.parse(calls[1]!.user) as { messages: { id?: string; for_you?: string }[] };
    expect(card.messages.filter((line) => line.for_you).map((line) => line.for_you)).toEqual(["names_you", "replies_to_you", "mentions_you"]);
    expect(posts().map((post) => [post.text, post.channel.address.messageId])).toEqual([
      ["fixtures 我这边还没跑", pinged.meta.messageId], ["行，我觉得可以先上", named.meta.messageId]
    ]);
  });

  it("asks again when a relay is longer than Feishu takes, then cuts it after a whole sentence rather than drop it", async () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 进度如何？", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    const reply = botMessage("ou_feifei", "很长的一段进度说明", 0, { mention: true });
    const long = "规范基本定完了，热更新由上层每次进选关时调一次。".repeat(12);
    answers.push(JSON.stringify({ reply: null, relay: [{ question: "ask-1", text: long }] }), JSON.stringify({ reply: null, relay: [{ question: "ask-1", text: long }] }));
    await room.attend(CHAT, [reply.id]);
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[1]!.user).problem).toMatch(/^the relay for ask-1 is \d+ words: Feishu takes a relay of at most 100 words/);
    const [relay] = posts();
    expect(wordCount(relay!.text) <= 100 && relay!.text.endsWith("。…") && relay!.text.startsWith("规范基本定完了")).toBe(true);
    expect(openAsks(client.store, now)).toEqual([]);
  });

  it("counts only what is said to it as an answer: those it asked talk to others there too", () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 进度如何？", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    botMessage("ou_feifei", "@Tickey 版本号和 schemaVersion 怎么对应？", 0);
    now += 16_000;
    room.pass();
    expect(attending()).toEqual([]);
    const answer = botMessage("ou_feifei", "进度：规范基本定了", 0, { mention: true });
    now += 16_000;
    room.pass();
    expect(attending()[0]?.ids).toEqual([answer.id]);
  });

  it("asks the person it acts for what only they can give when a bot asks for it, and takes their answer back to the bot", async () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 Alice 想要 repo 的地址", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    closeAsks(client.store, ["ask-1"], now);
    const wants = botMessage("ou_feifei", "要加 collaborator 的话，请告诉我你们的 GitHub 账号名", 0, { mention: true });
    answers.push(JSON.stringify({ reply: { text: "我去问一下 Alice", reply_to: wants.meta.messageId }, relay: [],
      ask_back: [{ for: "ou_alice", text: "飞飞要你的 GitHub 账号名来加 collaborator，是哪个？" }] }));
    await room.attend(CHAT, [wants.id]);
    expect(JSON.parse(calls[0]!.user).acting_for).toEqual([{ id: "ou_alice", name: "Alice", you_asked_here: "@飞飞 Alice 想要 repo 的地址" }]);
    const sent = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as
      { text: string; channel: { address: Record<string, string> }; mentions?: { id: string }[] });
    expect(sent().map((post) => [post.channel.address.chatId, post.channel.address.messageId, post.text, post.mentions?.map((mention) => mention.id) ?? []])).toEqual([
      ["oc_home", "om_q", "飞飞要你的 GitHub 账号名来加 collaborator，是哪个？", ["ou_alice"]],
      [CHAT, wants.meta.messageId, "我去问一下 Alice", []]
    ]);
    const [waiting] = openAsks(client.store, now);
    expect([waiting?.chatId, waiting?.to, waiting?.for.id, waiting?.for.channel.address.messageId]).toEqual(["oc_home", ["ou_alice"], "ou_feifei", wants.meta.messageId]);
    // Alice answers where she was asked; the answer goes back to 飞飞, quoting its message and @-ing it.
    now += 5000;
    const reply = feishuTrigger({ message_id: "om_alice", chat_id: "oc_home", chat_type: "group", sender_id: "ou_alice", sender_type: "user",
      content: "@_user_1 我的是 alice-gh", create_time: String(now), mentions: [{ id: BOT, key: "@_user_1", name: "w33d" }] }, BOT, "cli_app")!;
    client.engine.receive(reply);
    room.pass();
    now += 16_000;
    room.pass();
    const queuedAttend = attending().find((item) => item.chatId === "oc_home");
    expect(queuedAttend?.ids).toEqual([reply.id]);
    answers.push(JSON.stringify({ reply: null, relay: [{ question: waiting!.id, text: "Alice 说她的 GitHub 账号是 alice-gh" }] }));
    await room.attend("oc_home", queuedAttend!.ids);
    expect(sent().slice(2).map((post) => [post.channel.address.chatId, post.channel.address.messageId, post.text, post.mentions?.map((mention) => mention.id)])).toEqual([
      [CHAT, wants.meta.messageId, "Alice 说她的 GitHub 账号是 alice-gh", ["ou_feifei"]]
    ]);
    expect(openAsks(client.store, now)).toEqual([]);
  });

  it("answers other bots in a chat where only bots have spoken lately, however often it already answered them", async () => {
    // 奶机乐园 on 11-11: bots wrote nearly everything, and the agent had answered bots many times since a person last wrote.
    room.pass();
    now += 1000;
    for (let index = 0; index < 35; index++) botMessage(index % 2 ? "ou_feifei" : "ou_tickey", `进度第 ${index} 条`, 0);
    const many = Array.from({ length: 22 }, (_, index) => ({ at: new Date(now - 600_000 + index).toISOString(), bot: true as const }));
    client.store.set(KV.chatter.chat(CHAT), { ...client.store.get(KV.chatter.chat(CHAT))!, answered: many });
    const asked = botMessage("ou_naidan", "报进度 一句就行 昨天认领的活做完没", 0, { mention: true });
    answers.push(JSON.stringify({ reply: { text: "我昨天没认领活，这边没进度可报", reply_to: asked.meta.messageId }, relay: [] }));
    await room.attend(CHAT, [asked.id]);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0]!.user).replies_to_bots_in_a_row).toBeUndefined();
    expect(posts().map((post) => post.text)).toEqual(["我昨天没认领活，这边没进度可报"]);
    // Its instructions say to answer what is put to it directly, even when it has nothing to report.
    expect(attendPrompt("w33d", "")).toMatch(/Always answer what is put to you directly, by a person or a bot: a question, a request for your progress/);
  });

  it("asks again when a reply is longer than Feishu takes, then cuts it after a whole sentence rather than drop it", async () => {
    room.pass();
    now += 1000;
    const asked = botMessage("ou_tickey", "改一下分工，你那边怎么看", 0, { mention: true });
    const long = "我这边还没认领活，所以没有进度可报，等正明分配后再说。".repeat(6);
    answers.push(JSON.stringify({ reply: { text: long, reply_to: asked.meta.messageId } }), JSON.stringify({ reply: { text: long, reply_to: asked.meta.messageId } }));
    await room.attend(CHAT, [asked.id]);
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[1]!.user).problem).toMatch(/^the reply is \d+ words: Feishu takes a relay of at most 100 words and a reply of at most 60/);
    const [post] = posts();
    expect(wordCount(post!.text) <= 60 && post!.text.endsWith("。…") && post!.text.startsWith("我这边还没认领活")).toBe(true);
  });

  it("shortens only the reply that broke the limit, and keeps the other's first answer", async () => {
    room.pass();
    now += 1000;
    const first = botMessage("ou_tickey", "今天能合吗", 0, { mention: true });
    const second = botMessage("ou_feifei", "你那边还卡着吗", 0, { mention: true });
    const long = "我这边还没认领活，所以没有进度可报，等正明分配后再说。".repeat(6);
    answers.push(JSON.stringify({ reply: [
      { text: "能合，下午我看一下", reply_to: first.meta.messageId },
      { text: long, reply_to: second.meta.messageId }] }),
    JSON.stringify({ reply: [{ text: "还卡在等审阅", reply_to: second.meta.messageId }] }));
    await room.attend(CHAT, [first.id, second.id]);
    // One retry for the whole card, naming the reply that was long; the short one is never asked for again.
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[1]!.user).problem).toMatch(/^the reply is \d+ words/);
    expect(JSON.parse(calls[1]!.user).problem).not.toContain("(to ");
    // The retry replaced only the long reply; the other keeps what it first said, and each message gets one answer.
    expect(posts().map((post) => [post.text, post.channel.address.messageId])).toEqual([
      ["能合，下午我看一下", first.meta.messageId], ["还卡在等审阅", second.meta.messageId]
    ]);
  });

  it("asks once more for an answer it cannot use, then neither replies nor relays, and keeps waiting for what it asked", async () => {
    const live = new ChatterRoom({ client, now: () => now, complete: async (input) => { calls.push(input); return answers.shift()!; } });
    live.install();
    client.effects.start();
    live.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 进度如何？", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    const reply = botMessage("ou_feifei", "规范基本定了，还差发版", 0, { mention: true });
    now += 16_000;
    answers.push("not json", '{"reply": 5}');
    live.pass();
    expect(attending()).toEqual([{ chatId: CHAT, source: "feishu", ids: [reply.id] }]);
    await client.effects.idle("attend");
    expect([calls.length, attending(), posts()]).toEqual([2, [], []]);
    expect(openAsks(client.store, now).map((item) => item.id)).toEqual(["ask-1"]);
    expect(client.store.get(KV.chatter.chat(CHAT))?.answered).toBeUndefined();
    // Its effect ended, and the call it could not answer stays behind the mark: with nothing newer it is not asked again.
    now += 30_000;
    live.pass();
    await client.effects.idle("attend");
    expect([calls.length, attending()]).toEqual([2, []]);
    // The queue stops here, before anything is posted: a running one would hand the relay below to the Source's CLI.
    await client.effects.drain();
    // The ask is still open, so the next message that answers it is passed on, read together with the call left unanswered.
    const more = botMessage("ou_feifei", "发版也定了", 0, { mention: true });
    now += 16_000;
    live.pass();
    expect(attending()).toEqual([{ chatId: CHAT, source: "feishu", ids: [reply.id, more.id] }]);
    answers.push(JSON.stringify({ reply: [{ text: null, reply_to: reply.meta.messageId }], relay: [{ question: "ask-1", text: "飞飞说规范和发版都定了" }] }));
    await live.attend(CHAT, [reply.id, more.id]);
    expect(calls.length).toBe(3);
    expect(posts().map((post) => post.text)).toEqual(["飞飞说规范和发版都定了"]);
    expect(openAsks(client.store, now)).toEqual([]);
  });

  it("keeps a first answer that is too long when asking for a shorter one gives none it can use, cut to fit", async () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 进度如何？", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    const reply = botMessage("ou_feifei", "很长的一段进度说明", 0, { mention: true });
    const long = "规范基本定完了，热更新由上层每次进选关时调一次。".repeat(12);
    answers.push(JSON.stringify({ reply: null, relay: [{ question: "ask-1", text: long }] }), "not json");
    await room.attend(CHAT, [reply.id]);
    // The shorter one is asked for once: a second call for it would be a third here.
    expect(calls.map((call) => "problem" in JSON.parse(call.user))).toEqual([false, true]);
    const [relay] = posts();
    expect(wordCount(relay!.text) <= 100 && relay!.text.endsWith("。…") && relay!.text.startsWith("规范基本定完了")).toBe(true);
    expect(openAsks(client.store, now)).toEqual([]);
    // The retry that gave no usable answer is noted as its own purpose, with one try.
    expect(logs).toEqual(["superagent: no usable answer for superagent_attend again after 1 try: not json"]);
  });

  it("asks the model three times at most: twice for an answer it can use, once for a shorter one", async () => {
    room.pass();
    now += 1000;
    const asked = botMessage("ou_tickey", "改一下分工，你那边怎么看", 0, { mention: true });
    const long = "我这边还没认领活，所以没有进度可报，等正明分配后再说。".repeat(6);
    answers.push("not json", JSON.stringify({ reply: { text: long, reply_to: asked.meta.messageId } }), '{"reply": 5}');
    await room.attend(CHAT, [asked.id]);
    expect(calls.map((call) => "problem" in JSON.parse(call.user))).toEqual([false, false, true]);
    const [post] = posts();
    expect(wordCount(post!.text) <= 60 && post!.text.endsWith("。…") && post!.text.startsWith("我这边还没认领活")).toBe(true);
  });

  it("takes an answer whose reason runs far past what it asked for: it never reads the reason", async () => {
    room.pass();
    now += 1000;
    const asked = botMessage("ou_tickey", "你那边有 fixtures 的结果吗", 0, { mention: true });
    answers.push(JSON.stringify({ reply: { text: "fixtures 我这边还没跑", reply_to: asked.meta.messageId }, relay: [], reason: "because ".repeat(75) }));
    await room.attend(CHAT, [asked.id]);
    expect(calls.length).toBe(1);
    expect(posts().map((post) => post.text)).toEqual(["fixtures 我这边还没跑"]);
  });

  it("asks only the first person an answer names to ask back, though it names more", async () => {
    room.pass();
    now += 2000;
    for (const [id, person, name] of [["ask-1", "ou_alice", "Alice"], ["ask-2", "ou_carol", "Carol"]] as const) {
      ask(client.store, { id, chatId: CHAT, to: ["ou_feifei"], text: `@飞飞 ${name} 想要 repo 的地址`, at: new Date(now - 1000).toISOString(),
        for: { id: person, name, channel: home } }, now);
    }
    closeAsks(client.store, ["ask-1", "ask-2"], now);
    const wants = botMessage("ou_feifei", "要加 collaborator 的话，请告诉我你们的 GitHub 账号名", 0, { mention: true });
    answers.push(JSON.stringify({ reply: { text: "我去问一下他们", reply_to: wants.meta.messageId }, relay: [],
      ask_back: [{ for: "ou_alice", text: "飞飞要 Alice 的 GitHub 账号名，是哪个？" }, { for: "ou_carol", text: "飞飞要 Carol 的 GitHub 账号名，是哪个？" }] }));
    await room.attend(CHAT, [wants.id]);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0]!.user).acting_for.map((item: { id: string }) => item.id)).toEqual(["ou_alice", "ou_carol"]);
    const sent = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as
      { text: string; mentions?: { id: string }[] });
    expect(sent.map((post) => [post.text, post.mentions?.map((mention) => mention.id) ?? []])).toEqual([
      ["飞飞要 Alice 的 GitHub 账号名，是哪个？", ["ou_alice"]], ["我去问一下他们", []]
    ]);
    // What it waits for is what it asked: the first person, with the question it sent them.
    expect(openAsks(client.store, now).map((item) => [item.to, item.text, item.for.id])).toEqual([[["ou_alice"], "飞飞要 Alice 的 GitHub 账号名，是哪个？", "ou_feifei"]]);
  });

  it("sends an answer that names a message it cannot place to the call that is waiting, rather than dropping it", async () => {
    room.pass();
    now += 1000;
    const asked = botMessage("ou_tickey", "你那边有 fixtures 的结果吗", 0, { mention: true });
    // An older card message the router owns, not a call this pass may answer.
    answers.push(JSON.stringify({ reply: { text: "fixtures 我这边还没跑", reply_to: "om_older_card" } }));
    await room.attend(CHAT, [asked.id]);
    expect(calls.length).toBe(1);
    expect(posts().map((post) => [post.text, post.channel.address.messageId])).toEqual([["fixtures 我这边还没跑", asked.meta.messageId]]);
    // Answered for the record, so the call does not sit behind the mark and come back.
    expect(client.store.get(KV.chatter.chat(CHAT))?.answered?.length).toBe(1);
  });

  it("still asks the person it acts for when the reply itself is declined", async () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 Alice 想要 repo 的地址", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    closeAsks(client.store, ["ask-1"], now);
    const wants = botMessage("ou_feifei", "要加 collaborator 的话，请告诉我你们的 GitHub 账号名", 0, { mention: true });
    answers.push(JSON.stringify({ reply: { text: null, reply_to: wants.meta.messageId }, relay: [],
      ask_back: [{ for: "ou_alice", text: "飞飞要你的 GitHub 账号名来加 collaborator，是哪个？" }] }));
    await room.attend(CHAT, [wants.id]);
    const sent = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as
      { text: string; channel: { address: Record<string, string> } });
    expect(sent.map((post) => [post.channel.address.chatId, post.text])).toEqual([["oc_home", "飞飞要你的 GitHub 账号名来加 collaborator，是哪个？"]]);
    expect(openAsks(client.store, now).map((item) => [item.to, item.for.id])).toEqual([[["ou_alice"], "ou_feifei"]]);
  });

  it("lets a call that fails reject, so its effect tries again", async () => {
    room.pass();
    now += 1000;
    const asked = botMessage("ou_tickey", "你那边有 fixtures 的结果吗", 0, { mention: true });
    const down = new ChatterRoom({ client, now: () => now, complete: async (input) => { calls.push(input); throw new Error("network down"); } });
    await expect(down.attend(CHAT, [asked.id])).rejects.toThrow(/network down/);
    expect(calls.length).toBe(1);
    expect(posts()).toEqual([]);
  });

  it("cuts a sentence too long alone where it fits", () => {
    const cut = cutToFit("word ".repeat(300), 100);
    expect(wordCount(cut) <= 100 && cut.endsWith("…")).toBe(true);
  });

  it("knows its name as a word, not inside a link", () => {
    expect(["w33d 你看看", "问问W33D", "@w33d 在吗", "ok w33d."].map((text) => namesAgent(text, "w33d"))).toEqual([true, true, true, true]);
    expect(["see w33d.xyz", "x@w33d.xyz", "aw33d", "w33d_bot"].map((text) => namesAgent(text, "w33d"))).toEqual([false, false, false, false]);
    expect(namesAgent("奶蛋你来", "奶蛋")).toBe(true);
  });

  it("takes an answer whose relay, ask_back or reason is null for the empty list it would rather write, in a single call", async () => {
    room.pass();
    now += 2000;
    ask(client.store, { id: "ask-1", chatId: CHAT, to: ["ou_feifei"], text: "@飞飞 进度如何？", at: new Date(now - 1000).toISOString(),
      for: { id: "ou_alice", name: "Alice", channel: home } }, now);
    const reply = botMessage("ou_feifei", "规范基本定了，还差发版", 0, { mention: true });
    answers.push(JSON.stringify({ reply: { text: "收到，我转告 Alice", reply_to: reply.meta.messageId }, relay: null, ask_back: null, reason: null }));
    await room.attend(CHAT, [reply.id]);
    expect(calls.length).toBe(1);
    expect(posts().map((post) => post.text)).toEqual(["收到，我转告 Alice"]);
    expect(logs).toEqual([]);
  });

  it("takes a considered answer whose reason is null, saying it in a single call", async () => {
    room.pass();
    message("ou_alice", "anyone tried the new tea place?", 30);
    now += 61_000;
    answers.push(JSON.stringify({ say: "The oolong there is worth the queue.", reply_to: null, mention: null, reason: null }));
    await room.consider(CHAT);
    expect(calls.length).toBe(1);
    expect(posts().map((post) => post.text)).toEqual(["The oolong there is worth the queue."]);
    expect(logs).toEqual([]);
  });

  it("gives up after two unusable answers, noting the purpose and the start of the last one", async () => {
    room.pass();
    message("ou_alice", "anyone tried the new tea place?", 30);
    now += 61_000;
    room.pass();
    answers.push("I would rather not answer in JSON.", `{"say": ${"x".repeat(300)}}`);
    await room.consider(CHAT);
    expect(calls.length).toBe(2);
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/^superagent: no usable answer for superagent_chatter after 2 tries: \{"say": xxx/);
    expect(logs[0]!.length < 300).toBe(true);
    // An answer it can use is no such trace.
    logs = [];
    answers.push(JSON.stringify({ say: "The oolong there is worth the queue." }));
    await room.consider(CHAT);
    expect(logs).toEqual([]);
  });

  it("notes a give-up when answering what called for it leaves no answer it can use", async () => {
    room.pass();
    now += 1000;
    const asked = botMessage("ou_tickey", "你那边有 fixtures 的结果吗", 0, { mention: true });
    answers.push("not json", "still not json");
    await room.attend(CHAT, [asked.id]);
    expect(calls.length).toBe(2);
    expect(logs.length).toBe(1);
    expect(logs[0]).toBe("superagent: no usable answer for superagent_attend after 2 tries: still not json");
  });
});
