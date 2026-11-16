/** The router's clock: replay fixes it, and production leaves it out and reads the wall clock. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ModelAssessor, type Complete } from "../assessor.js";
import { SuperagentClient } from "../client.js";
import { threadKey, type Trigger } from "../core/index.js";
import { chatSubject, localNow, SELF } from "../memories.js";
import { settingsPath, writeSettings } from "../settings.js";
import { feishuTrigger } from "../sources/feishu.js";

const CHAT = "oc_team", BOT = "ou_bot";
/** 2026-11-11 10:45:24Z: the afternoon's staging question, at the exact minute it was asked. */
const FIXED = Date.parse("2026-11-11T10:45:24.000Z");

let stateDir: string;
let client: SuperagentClient;
let calls: { system: string; user: string }[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-assessor-clock-"));
  writeSettings({ sources: { feishu: { enabled: true, config: {} } }, policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } },
    memory: { enabled: true } }, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
  calls = [];
});
afterEach(() => { client.close(); rmSync(stateDir, { recursive: true, force: true }); });

const complete: Complete = async (input) => {
  calls.push({ system: input.system, user: input.user });
  return JSON.stringify({ kind: "ignore", reason: "nothing to do" });
};

/** A Feishu message from an admitted person, @-ing the agent, waiting in its thread's queue for an explicit Eval. */
function queued(text: string, at: number): string {
  const trigger = feishuTrigger({ message_id: "om_now", chat_id: CHAT, chat_type: "group", sender_id: "ou_alice", sender_type: "user",
    content: `@_user_1 ${text}`, create_time: String(at), mentions: [{ id: BOT, key: "@_user_1", name: "w33d" }] }, BOT, "cli_app") as Trigger;
  client.store.set(`person:feishu:ou_alice` as never, { name: "Alice", at: new Date(at).toISOString() } as never);
  client.store.triggers.save(trigger);
  client.store.threads.save({ key: threadKey(trigger.threads[0]!), ref: trigger.threads[0]!, createdAt: trigger.at, lastAt: trigger.at,
    subscriptions: [], correlated: [], pending: [trigger.id], meta: {} });
  return trigger.id;
}

test("an assessor given a clock reads it: the card is dated by it, not by the wall clock", async () => {
  const triggerId = queued("staging 那版应该没上吧", FIXED - 60_000);
  const assessor = new ModelAssessor({ client, complete, now: () => FIXED, configured: () => false });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId);
  assert.ok(candidate, "an Eval holds the message");
  await assessor.judge(triggerId, candidate.evalId);
  const card = JSON.parse(calls[0]!.user).candidate as { now?: string; time_zone?: string };
  // The card's date is the fixed one, to the minute, in the chats' zone (18:45 there is 10:45Z).
  assert.equal(card.now, localNow(client.settings(), FIXED).now);
  assert.match(card.now ?? "", /^2026-11-11 18:45/);
  assert.equal(card.time_zone, "Asia/Shanghai");
});

test("with no clock the card is the wall clock's, to within the minute, so production behaves as before", async () => {
  const triggerId = queued("staging 那版应该没上吧", Date.now() - 60_000);
  const assessor = new ModelAssessor({ client, complete, configured: () => false });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId);
  assert.ok(candidate);
  await assessor.judge(triggerId, candidate.evalId);
  const card = JSON.parse(calls[0]!.user).candidate as { now?: string };
  assert.equal(card.now, localNow(client.settings(), Date.now()).now);
  assert.notEqual(card.now, localNow(client.settings(), FIXED).now);
});

test("the memory a card shows sits under the same clock", async () => {
  // A note the store holds, so the router's card carries `memory` and the time it prints beside it.
  client.store.memory.save({ id: "n1", about: chatSubject(CHAT), text: "有人让我发个最小验证", kind: "event", origin: { chatId: CHAT },
    created: "2026-11-11T09:05:41.000Z", updated: "2026-11-11T09:05:41.000Z" });
  const triggerId = queued("staging 那版应该没上吧", FIXED - 60_000);
  const assessor = new ModelAssessor({ client, complete, now: () => FIXED, configured: () => false });
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId);
  assert.ok(candidate);
  await assessor.judge(triggerId, candidate.evalId);
  const card = JSON.parse(calls[0]!.user).candidate as { now?: string; memory?: { id: string }[] };
  assert.ok(card.memory?.some((note) => note.id === "n1"), "the note about the chat is on the card");
  assert.match(card.now ?? "", /^2026-11-11 18:45/, "18:45 in Asia/Shanghai is 10:45Z");
  void SELF;
});
