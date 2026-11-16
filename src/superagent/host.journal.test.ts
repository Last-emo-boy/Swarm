/** The host's journal (host.ts, journal.ts): the one wrapper around `complete` records a consideration's card and its outcome. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentHost } from "./host.js";
import { settingsPath, writeSettings } from "./settings.js";
import { feishuTrigger } from "./sources/feishu.js";

const CHAT = "oc_team";
let stateDir: string;
let host: SuperagentHost;
let calls: { purpose: string; user: string }[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-host-journal-"));
  writeSettings({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "all" }], directMessages: true } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } }, chatter: { chats: [CHAT], persona: "Dry humour." } }, settingsPath(stateDir));
  calls = [];
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {},
    complete: async (input) => { calls.push(input); return JSON.stringify({ say: "A lull is a good time for tea.", reason: "a light moment" }) } });
});
afterEach(async () => { await host.stop(); rmSync(stateDir, { recursive: true, force: true }); });

test("a consideration the host runs records its card and that it spoke, under the chat it considered", async () => {
  // A row from before the 14 days the journal keeps: the host's first pass deletes it.
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  host.client.store.db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?)").run("old", old, "chatter", "chat:x", 0, '{"purpose":"p","system":"","user":""}');
  await host.start();
  const message = feishuTrigger({ message_id: "om_1", chat_id: CHAT, chat_type: "group", sender_id: "ou_alice", sender_type: "user",
    content: "quiet in here", create_time: String(Date.now() - 3_600_000), mentions: [] }, "ou_bot", "cli_app")!;
  host.client.engine.receive(message);
  // The host's own effect handlers run it, as they would from its pass.
  host.client.effects.enqueue("chatter", CHAT, { chatId: CHAT });
  await host.client.effects.idle("chatter");
  assert.equal(calls.length, 1, "the wrapper passed the call through once");
  const runs = host.client.journal!.byKey(`chat:${CHAT}`);
  const run = runs.at(-1)!;
  assert.equal(run.purpose, "superagent_chatter");
  assert.equal(JSON.parse(run.user).messages[0].text, "quiet in here");
  assert.equal(run.outcome, "sent");
  assert.equal(run.reason, "a light moment");
  assert.equal(host.client.store.receipts.get(run.outbox![0]!)?.text, "A lull is a good time for tea.");
  assert.equal(host.client.store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE id = 'old'").get()?.n, 0, "the host pruned the old row");
});
