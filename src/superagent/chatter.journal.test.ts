/** What the chatter journal records (journal.ts, chatter.ts): the card it sent, and why it spoke or stayed silent at each exit. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import type { Trigger } from "./core/index.js";
import type { JournalRun } from "./journal.js";
import { Journal, journaled } from "./journal.js";
import { ChatterRoom } from "./chatter.js";
import { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { feishuTrigger } from "./sources/feishu.js";

const CHAT = "oc_team", BOT = "ou_bot";
let stateDir: string;
let client: SuperagentClient;
let room: ChatterRoom;
let now: number;
let answers: string[];
let calls: { system: string; user: string }[];
const write = (chatter: Record<string, unknown> = {}) => writeSettings({
  sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "all" }], directMessages: true } } },
  policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } },
  chatter: { chats: [CHAT], persona: "Dry humour, loves tea.", ...chatter }
}, settingsPath(stateDir));
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-chatter-journal-"));
  write();
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: BOT, name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  client.journal = new Journal(client.store, () => new Date(now));
  now = Date.parse("2026-11-10T06:00:00Z");
  answers = [];
  calls = [];
  room = new ChatterRoom({ client, now: () => now,
    complete: journaled(client.journal, async (input) => { calls.push(input); return answers.shift() ?? JSON.stringify({ say: null, reason: "nothing to add" }) }) });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

let n = 0;
/** A message in the chat from `sender`, `ago` seconds before now. */
function message(sender: string, text: string, ago: number, mention = false, type = "user"): Trigger {
  n += 1;
  const at = now - ago * 1000;
  const trigger = feishuTrigger({ message_id: `om_${n}`, chat_id: CHAT, chat_type: "group", sender_id: sender, sender_type: type,
    content: mention ? `@_user_1 ${text}` : text, create_time: String(at), mentions: mention ? [{ id: BOT, key: "@_user_1", name: "w33d" }] : [] }, BOT, "cli_app")!;
  client.engine.receive(trigger);
  return trigger;
}
const runs = (key = `chat:${CHAT}`) => client.journal!.byKey(key);

describe("a consideration", () => {
  it("records the card it sent and that it spoke, with the message it queued", async () => {
    const asked = message("ou_alice", "anyone tried the new tea place?", 300);
    answers.push(JSON.stringify({ say: "The oolong there is worth the queue.", reply_to: asked.meta.messageId, reason: "a tea question" }));
    await room.consider(CHAT);
    const [run] = runs();
    expect(run!.purpose).toBe("superagent_chatter");
    expect(run!.system).toContain("You are w33d, a member of a group chat");
    expect(JSON.parse(run!.user!).messages).toHaveLength(1);
    expect(run!.outcome).toBe("sent");
    expect(run!.reason).toBe("a tea question");
    expect(run!.outbox).toHaveLength(1);
    expect(client.store.receipts.get(run!.outbox![0]!)?.text).toBe("The oolong there is worth the queue.");
  });
  it("records quiet hours as skipped, with no model call and no card", async () => {
    write({ quiet: { from: 23, to: 7, timeZone: "Asia/Shanghai" }, perHour: 2 });
    // An hour's budget of two spent in the last hour leaves it silent however many messages arrived.
    client.store.set(KV.chatter.chat(CHAT), { said: [], spoke: [new Date(now - 60_000).toISOString(), new Date(now - 120_000).toISOString()] });
    await room.consider(CHAT);
    const [run] = runs();
    expect(calls).toEqual([]);
    expect(run!.outcome).toBe("skipped");
    expect(run!.reason).toBe("budget spent or quiet hours");
    expect(run!.user).toBe("");
  });
  it("records a chat it may not speak in as skipped, and says nothing when no answer can be used", async () => {
    write({ chats: [] });
    await room.consider(CHAT);
    expect(runs().map((run) => [run.outcome, run.reason])).toEqual([["skipped", "the chat is off for chatter"]]);
    write();
    message("ou_alice", "anyone tried the new tea place?", 300);
    answers.push("not json", '{"say": 5}');
    await room.consider(CHAT);
    const last = runs().at(-1)!;
    expect(calls).toHaveLength(2);
    expect(last.outcome).toBe("silent");
    expect(last.reason).toBe("no usable answer after 2 tries");
  });
  it("records an answer it would drop, with the model's own reason", async () => {
    message("ou_alice", "lunch?", 300);
    answers.push(JSON.stringify({ say: null, reason: "the talk is between others" }));
    await room.consider(CHAT);
    expect(runs().at(-1)).toEqual(expect.objectContaining({ outcome: "silent", reason: "the talk is between others" }));
  });
});

describe("an attend", () => {
  it("records what it answered and the message it queued", async () => {
    const asked = message("ou_yyu", "status?", 30, true, "bot");
    answers.push(JSON.stringify({ reply: { text: "Running the tests now.", reply_to: asked.meta.messageId }, reason: "a bot asked for progress" }));
    await room.attend(CHAT, [asked.id]);
    const run = runs().at(-1)! as JournalRun;
    expect(run.purpose).toBe("superagent_attend");
    expect(run.outcome).toBe("sent");
    expect(run.reason).toBe("a bot asked for progress");
    expect(run.outbox![0]).toBeDefined();
  });
  it("records that nothing called for it, with no model call", async () => {
    const plain = message("ou_alice", "lunch?", 30);
    await room.attend(CHAT, [plain.id]);
    expect(calls).toEqual([]);
    expect(runs().at(-1)).toEqual(expect.objectContaining({ outcome: "skipped", reason: "nothing for it here" }));
  });
});
