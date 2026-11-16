/**
 * The host's wiring of the terminal chat (host.ts + local.ts): a message the TUI queues is taken in by the local Source's
 * watch loop, a bot command among them is answered through the outbox, and the text reaches the router as chat.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentHost } from "./host.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator, TUI_CHAT } from "./sources/local.js";
import { localReplies } from "./views.js";
import { KV } from "./kv.js";

let stateDir: string;
let host: SuperagentHost;
/** A router that would call the model fails the test rather than call out; the command path needs none. */
const noModel = async (): Promise<string> => { throw new Error("no model in this test"); };
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-host-chat-"));
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } } }, settingsPath(stateDir));
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {}, complete: noModel });
});
afterEach(async () => { await host.stop(); rmSync(stateDir, { recursive: true, force: true }); });

async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

test("a message the TUI queues is taken in as chat, and a bot command among them is answered in the terminal", async () => {
  const client = host.client;
  const { messageId } = client.chat("/me");
  await host.start();
  // The answer goes to the terminal chat's channel, which is the flat local address of the TUI chat.
  const reply = await until(() => localReplies(client, 20).find((row) => row.text.length > 0 && row.kind === "reply"));
  assert.ok(reply.text.length > 0, `the command was answered: ${JSON.stringify(reply)}`);
  assert.equal(client.store.get(KV.local.inbox(messageId)), undefined, "the queued row was taken in once and cleared");
  // A trigger's id is content-derived; the queued message id is its `meta.requestId`.
  const stored = await until(() => client.store.db.prepare("SELECT value FROM trigger WHERE value ->> '$.meta.requestId' = ?").all(messageId)
    .map((row) => JSON.parse(String((row as { value: unknown }).value)) as { id: string })[0]);
  assert.ok(stored.id, "the message entered the engine as a trigger");
});

test("a message with no command among them reaches the router as a chat message in the terminal chat", async () => {
  const client = host.client;
  const { messageId } = client.chat("what do you think of the release?");
  await host.start();
  const trigger = await until(() => client.store.db.prepare("SELECT value FROM trigger WHERE value ->> '$.meta.requestId' = ?").all(messageId)
    .map((row) => JSON.parse(String((row as { value: unknown }).value)) as { id: string; source: string; meta: Record<string, unknown>; threads: { id: string }[] })[0]);
  assert.equal(trigger.source, "local");
  assert.equal(trigger.meta.chatId, TUI_CHAT);
  assert.deepEqual(trigger.threads.map((thread) => thread.id), [TUI_CHAT], "on the terminal chat's thread");
});
