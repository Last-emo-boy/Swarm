/** Exporting cases: the scene from a store copy, the card's hashes from the usage copy, and settings with no key in them. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { loadCase } from "./case.js";
import { DatabaseSync } from "node:sqlite";
import { key } from "../core/index.js";
import { FINDING_CASES, exportCases, outcomeFromStore, sanitizeSettings } from "./export.js";
import { KV } from "../kv.js";
import { state, usageDb, writeSettings, AT, CHAT, message } from "./_testing.js";

let dir: string, out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-replay-export-"));
  out = mkdtempSync(join(tmpdir(), "swarm-replay-out-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

/** A store copy with the messages a finding anchors on, and a settings file holding a key that must not travel. */
function storeCopy(): { store: string; settings: string; usage: string } {
  const fixture = state(dir);
  try {
    message(fixture.client, { id: "om_1", sender: "ou_alice", text: "staging 那版应该没上吧", at: "2026-11-11T10:40:02.000Z" });
    message(fixture.client, { id: "om_2", sender: "ou_bob", text: "我这边看不到", at: "2026-11-11T10:44:00.000Z" });
    // The Source's member list keeps the names the card shows; the copy holds them as KV rows.
    fixture.client.store.set(KV.people.person("feishu", "ou_alice"), { name: "Alice", at: "2026-11-10T00:00:00.000Z" });
    fixture.client.store.set(KV.people.person("feishu", "ou_bob"), { name: "Bob", at: "2026-11-10T00:00:00.000Z" });
  } finally { fixture.close(); }
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", appId: "cli_secret", appSecret: "s3cr3t" } } },
    chatter: { chats: [CHAT], persona: "Dry humour." }, eval: { mode: "observe" }, policy: { rules: [], sources: {} } }));
  const usage = join(dir, "usage.db");
  usageDb(usage, [
    { at: "2026-11-11T10:45:24.000Z", purpose: "superagent_chatter", systemHash: "a".repeat(64), userHash: "b".repeat(64), ms: 1200 },
    { at: "2026-11-11T10:46:24.000Z", purpose: "superagent_attend", systemHash: "c".repeat(64), userHash: "d".repeat(64), ms: 900 }
  ]);
  return { store: join(dir, "superagent.db"), settings, usage };
}

/** A finding's private anchors, as `--anchors` holds them; invented text here, the real lines only in the owner's file. */
const ANCHORS = { F04: { anchor: "staging 那版应该没上吧", rubric: "Say plainly it has not tested it." },
  F05: { anchor: "认领：这批用例", rubric: "Do not claim the task." },
  F15: { said: "这里没有任何一行" } };

test("exports the call behind a finding with its card hashes and a scene holding the chat", () => {
  const { store, settings, usage } = storeCopy();
  const result = exportCases({ storePath: store, usagePath: usage, settingsPath: settings, out, anchors: ANCHORS, findings: ["F04"] });
  assert.deepEqual(result.cases, ["f04-chatter-carbon"]);
  const kase = loadCase(out, "f04-chatter-carbon");
  assert.equal(kase.version, 1);
  assert.equal(kase.purpose, "chatter");
  assert.equal(kase.finding, "F04");
  // The chatter call at 10:45:24 started 1.2 s earlier: the scene's clock is the call's start.
  assert.equal(kase.scene.at, "2026-11-11T10:45:22.800Z");
  assert.deepEqual(kase.recorded.card, { systemHash: "a".repeat(64), userHash: "b".repeat(64), sectionHashes: { system: "a".repeat(64), task: "b".repeat(64) } });
  assert.equal(kase.recorded.callAt, "2026-11-11T10:45:24.000Z");
  const texts = kase.scene.messages.map((item) => item.text);
  assert.deepEqual(texts, ["staging 那版应该没上吧", "我这边看不到"]);
  assert.equal(kase.expect.rubric, "Say plainly it has not tested it.", "the finding's rubric comes from the private anchors");
  assert.equal(kase.scene.messages[0]!.senderName, "Alice", "a card names senders as it did then");
});

test("a case's settings carry no Source config, so no key or token travels with it", () => {
  const { store, settings, usage } = storeCopy();
  exportCases({ storePath: store, usagePath: usage, settingsPath: settings, out, anchors: ANCHORS, findings: ["F04"] });
  const text = readFileSync(join(out, "cases", "f04-chatter-carbon.json"), "utf8");
  assert.doesNotMatch(text, /s3cr3t|cli_secret|lark-cli/, "the exported case holds no credential");
  const kase = loadCase(out, "f04-chatter-carbon");
  assert.deepEqual((kase.scene.settings as { sources: Record<string, { config: unknown }> }).sources.feishu!.config, {});
  assert.equal((kase.scene.settings as { chatter: { persona: string } }).chatter.persona, "Dry humour.", "what the prompts read stays");
});

test("sanitizeSettings empties every Source's config and keeps the blocks the prompts read", () => {
  const clean = sanitizeSettings({ sources: { feishu: { enabled: true, config: { cli: "x", appSecret: "y" } }, github: { enabled: false, config: { token: "z" } } },
    chatter: { persona: "p" }, memory: { enabled: true }, eval: { mode: "auto" }, policy: { rules: [], sources: {} }, access: { on: true } });
  assert.deepEqual(clean.sources, { feishu: { enabled: true, config: {} }, github: { enabled: false, config: {} } });
  assert.equal((clean as { chatter: { persona: string } }).chatter.persona, "p");
  assert.deepEqual(clean.policy, { rules: [], sources: {} });
  assert.equal("paused" in clean, false, "nothing a run does not read is kept");
});

test("refuses to export into a git work tree", () => {
  const { store, settings, usage } = storeCopy();
  const inside = join(dir, "repo");
  state(inside);
  writeFileSync(join(inside, ".git"), "gitdir: elsewhere\n");
  assert.throws(() => exportCases({ storePath: store, usagePath: usage, settingsPath: settings, out: join(inside, "replay"), anchors: ANCHORS }), /git work tree/);
});

test("a finding with no surface to anchor on is skipped with the reason", () => {
  const { store, settings, usage } = storeCopy();
  // F15 anchors on the agent's own line, which this store never sent: the export skips it with the reason, not a bare failure.
  // F15's said line is not one the agent ever wrote here: the export skips it with the reason, not a bare failure.
  const result = exportCases({ storePath: store, usagePath: usage, settingsPath: settings, out, anchors: ANCHORS, findings: ["F15"] });
  assert.deepEqual(result.cases, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.why, /no message of the agent says/);
  // A finding with no private anchors is skipped too: the source holds no chat lines to guess from.
  const bare = exportCases({ storePath: store, usagePath: usage, settingsPath: settings, out, findings: ["F01"] });
  assert.deepEqual(bare.cases, []);
  assert.match(bare.skipped[0]!.why, /no private anchor/);
});

test("an attend case carries the message ids its effect was handed", () => {
  const { store, settings, usage } = storeCopy();
  // A store of its own, so neither copy outranks the other's anchor.
  const extra = mkdtempSync(join(tmpdir(), "swarm-replay-extra-"));
  const fixture = state(extra);
  try {
    message(fixture.client, { id: "om_3", sender: "ou_carol", text: "认领：这批用例", at: "2026-11-11T10:41:00.000Z", human: false, mention: true });
  } finally { fixture.close(); }
  const result = exportCases({ storePath: join(extra, "superagent.db"), usagePath: usage, settingsPath: settings, out, anchors: ANCHORS, findings: ["F05"] });
  rmSync(extra, { recursive: true, force: true });
  assert.deepEqual(result.cases, ["f05-attend-claim"]);
  const kase = loadCase(out, "f05-attend-claim");
  assert.equal(kase.purpose, "attend");
  // The ids production's attention() would hand it: the bot's @, named by callOf — not the scene's newest few.
  assert.deepEqual(kase.targetIds, kase.scene.messages.filter((item) => item.mentioned).map((item) => item.id));
  assert.equal(kase.targetIds?.length, 1);
  assert.deepEqual(kase.scene.notes, []);
});

/** A store copy whose outbox holds two replies in one chat, one for the call's message and one posted later. */
function chatWithTwoReplies(): { db: DatabaseSync; messages: { id: string; at: string }[] } {
  const fixture = state(dir);
  const later = "2026-11-11T18:00:00.000Z";
  try {
    message(fixture.client, { id: "om_1", sender: "ou_alice", text: "staging 那版应该没上吧", at: "2026-11-11T10:40:02.000Z" });
    message(fixture.client, { id: "om_9", sender: "ou_bob", text: "晚上好", at: later });
    // Two outbox rows: the call's own (its id names the message its card ended on) and a much later unrelated post.
    fixture.client.store.db.prepare("INSERT INTO outbox (id, value) VALUES (?, ?)").run(key("chatter", CHAT, "feishu:om_1"),
      JSON.stringify({ id: key("chatter", CHAT, "feishu:om_1"), channel: { source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, mode: "chat" } }, text: "我这边没测过" }));
    fixture.client.store.db.prepare("INSERT INTO outbox (id, value) VALUES (?, ?)").run(key("chatter", CHAT, "feishu:om_9"),
      JSON.stringify({ id: key("chatter", CHAT, "feishu:om_9"), channel: { source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, mode: "chat" } }, text: "晚上好" }));
  } finally { fixture.close(); }
  return { db: new DatabaseSync(join(dir, "superagent.db"), { readOnly: true }),
    messages: [{ id: "feishu:om_1", at: "2026-11-11T10:40:02.000Z" }] };
}

test("a call's recorded outcome is the message it sent, never the chat's latest post from another day", () => {
  // The F01/F04 chats were used for days after the recorded call: taking the newest outbox row handed every case the same
  // later line as its baseline, so the checks and the grader compared against the wrong text.
  const { db, messages } = chatWithTwoReplies();
  try {
    const outcome = outcomeFromStore(db, CHAT, "2026-11-11T10:45:24.000Z", "chatter", messages);
    assert.equal(outcome.kind, "said");
    assert.equal(outcome.text, "我这边没测过");
    // A call whose own row is not in the copy is silent, not some other post.
    const other = outcomeFromStore(db, CHAT, "2026-11-11T10:46:24.000Z", "chatter", []);
    assert.equal(other.kind, "silent");
  } finally { db.close(); }
});

test("a finding about the agent's own line pins the call after that line, not the first call ever", () => {
  const fixture = state(dir);
  try {
    message(fixture.client, { id: "om_1", sender: "ou_alice", text: "staging 那版应该没上吧", at: "2026-11-11T10:40:02.000Z" });
    // The said line the finding is about, as KV holds it, and the agent's own outbox post it came from.
    fixture.client.store.set(KV.chatter.chat(CHAT), { said: [{ at: "2026-11-11T10:44:30.000Z", text: "这截图我这边看不到内容" }] });
    fixture.client.store.db.prepare("INSERT INTO outbox (id, value) VALUES (?, ?)").run(key("chatter", CHAT, "feishu:om_1"),
      JSON.stringify({ id: key("chatter", CHAT, "feishu:om_1"), channel: { source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, messageId: "om_1", mode: "chat" } }, text: "这截图我这边看不到内容" }));
  } finally { fixture.close(); }
  // Two chatter calls: one before the line, one after it; the case must pin the later one.
  usageDb(join(dir, "usage.db"), [
    { at: "2026-11-09T09:00:00.000Z", purpose: "superagent_chatter", systemHash: "a".repeat(64), userHash: "b".repeat(64) },
    { at: "2026-11-11T10:45:24.000Z", purpose: "superagent_chatter", systemHash: "c".repeat(64), userHash: "d".repeat(64) }
  ]);
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ sources: { feishu: { enabled: true, config: {} } }, chatter: { chats: [CHAT] }, memory: { enabled: true }, policy: { rules: [], sources: {} } }));
  const result = exportCases({ storePath: join(dir, "superagent.db"), usagePath: join(dir, "usage.db"), settingsPath: settings, out,
    anchors: { F19: { said: "这截图我这边看不到内容" } }, findings: ["F19"] });
  assert.deepEqual(result.cases, ["f19-chatter-screenshot"]);
  const kase = loadCase(out, "f19-chatter-screenshot");
  assert.equal(kase.recorded.callAt, "2026-11-11T10:45:24.000Z", "the call after the line, not the first chatter call in the copy");
  // The agent's own line is in the scene, so the run is judged against what it had said.
  assert.equal(kase.scene.own.some((line) => line.text.includes("看不到内容")), true);
});

test("own lines are rebuilt from the outbox when the chat's said list has rolled past the call", () => {
  const fixture = state(dir);
  try {
    // The store keeps only the 20 newest said lines, so an old call sees none of them; its own post is still in the outbox.
    message(fixture.client, { id: "om_1", sender: "ou_alice", text: "staging 那版应该没上吧", at: "2026-11-11T10:40:02.000Z" });
    fixture.client.store.db.prepare("INSERT INTO outbox (id, value) VALUES (?, ?)").run(key("chatter", CHAT, "feishu:om_1"),
      JSON.stringify({ id: key("chatter", CHAT, "feishu:om_1"), channel: { source: "feishu", thread: `feishu:${CHAT}`, address: { chatId: CHAT, messageId: "om_1", mode: "chat" } }, text: "我这边没测过，别当成验过了" }));
  } finally { fixture.close(); }
  usageDb(join(dir, "usage.db"), [{ at: "2026-11-11T10:45:24.000Z", purpose: "superagent_chatter", systemHash: "a".repeat(64), userHash: "b".repeat(64) }]);
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ sources: { feishu: { enabled: true, config: {} } }, chatter: { chats: [CHAT] }, memory: { enabled: true }, policy: { rules: [], sources: {} } }));
  exportCases({ storePath: join(dir, "superagent.db"), usagePath: join(dir, "usage.db"), settingsPath: settings, out,
    anchors: { F04: { anchor: "staging 那版应该没上吧" } }, findings: ["F04"] });
  const kase = loadCase(out, "f04-chatter-carbon");
  assert.deepEqual(kase.scene.own.map((line) => line.text), ["我这边没测过，别当成验过了"]);
});

test("an anchor that matches messages in more than one chat is skipped, not guessed", () => {
  // The F05 and F12 anchors once matched a different chat's message two days earlier: a scene built there replays the
  // wrong conversation, so an anchor with no day has to name exactly one chat.
  const fixture = state(dir);
  try {
    message(fixture.client, { id: "om_1", sender: "ou_alice", text: "我接这个排期", at: "2026-11-09T15:10:06.000Z" });
    const other = mkdtempSync(join(tmpdir(), "swarm-replay-other-"));
    const second = state(other);
    try {
      second.client.engine.receive({ id: "feishu:om_2", source: "feishu", threads: [{ source: "feishu", id: "oc_other" }],
        actor: { source: "feishu", id: "ou_cam" }, human: true, at: "2026-11-11T10:41:00.000Z", text: "我接这个排期",
        meta: { chatId: "oc_other", messageId: "om_2", direct: false } } as never);
      const from = new DatabaseSync(join(other, "superagent.db"), { readOnly: true });
      const row = from.prepare("SELECT id, value, at FROM trigger WHERE id = 'feishu:om_2'").get() as { id: string; value: string; at: string };
      from.close();
      fixture.client.store.db.prepare("INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)").run(row.id, row.value, row.at);
    } finally { second.close(); rmSync(other, { recursive: true, force: true }); }
  } finally { fixture.close(); }
  usageDb(join(dir, "usage.db"), [{ at: "2026-11-11T10:45:24.000Z", purpose: "superagent_attend", systemHash: "a".repeat(64), userHash: "b".repeat(64) }]);
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ sources: { feishu: { enabled: true, config: {} } }, chatter: { chats: [CHAT] }, memory: { enabled: true }, policy: { rules: [], sources: {} } }));
  const result = exportCases({ storePath: join(dir, "superagent.db"), usagePath: join(dir, "usage.db"), settingsPath: settings, out,
    anchors: { F05: { anchor: "我接这个排期" } }, findings: ["F05"] });
  assert.deepEqual(result.cases, []);
  assert.match(result.skipped[0]!.why, /more than one chat/);
});

test("the shipped findings hold no chat text: anchors and rubrics live in the private anchors file", () => {
  // A clone of the repository must not be able to read the private store's lines from source; the cases' own lines come
  // from --anchors, which sits under the replay root.
  const source = JSON.stringify(FINDING_CASES);
  assert.doesNotMatch(source, /[\u4e00-\u9fff]/, "no Chinese chat text in the shipped findings");
  assert.equal(FINDING_CASES.every((item) => !item.anchor && !item.said), true);
});
