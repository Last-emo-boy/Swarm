import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentHost } from "./host.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator } from "./sources/local.js";
import { databasePath } from "./client.js";
import { KV } from "./kv.js";

let stateDir: string;
let host: SuperagentHost;
const noModel = async (): Promise<string> => { throw new Error("no model in this test"); };
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-repro-"));
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } } }, settingsPath(stateDir));
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {}, complete: noModel });
});
afterEach(async () => { await host.stop(); rmSync(stateDir, { recursive: true, force: true }); });

const triggerFor = (messageId: string) => host.client.store.db
  .prepare("SELECT value FROM trigger WHERE value ->> '$.meta.requestId' = ?").all(messageId);
async function waitFor(read: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (read()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}

test("watch loop: an error in takeLocalInbox kills the local watcher permanently", async () => {
  const client = host.client;
  const m1 = client.chat("/help").messageId;
  await host.start();
  assert.ok(await waitFor(() => client.store.get(KV.local.inbox(m1)) === undefined, 10_000), "first message taken in: watcher was alive");
  const watchers = (host as unknown as { watchers: Map<string, unknown> }).watchers;
  assert.ok(watchers.has("local"), "watcher registered");

  // A second connection holds the write lock past the 10s busy timeout, so the next takeLocalInbox throws SQLITE_BUSY.
  const locker = new DatabaseSync(databasePath(stateDir));
  const m2 = client.chat("hello while locked").messageId;   // written by client before the lock
  locker.exec("BEGIN IMMEDIATE");
  // wait long enough for a poll (500ms) plus the busy timeout (10s) to expire under the host
  await new Promise((r) => setTimeout(r, 12_500));
  locker.exec("ROLLBACK");
  locker.close();

  const m3 = client.chat("after the error").messageId;
  const took3 = await waitFor(() => client.store.get(KV.local.inbox(m3)) === undefined, 6_000);
  console.log("m3 taken in after error:", took3, "| trigger rows for m3:", triggerFor(m3).length,
    "| trigger rows for m2:", triggerFor(m2).length, "| m2 row still in inbox:", client.store.get(KV.local.inbox(m2)) !== undefined,
    "| watcher entry still registered:", watchers.has("local"));
  assert.equal(took3, false, "DEFECT: the watcher did not resume; the inbox is never drained again");
  assert.equal(triggerFor(m3).length, 0);
  assert.ok(client.store.get(KV.local.inbox(m3)) !== undefined, "m3 still queued");
  assert.ok(client.store.get(KV.local.inbox(m2)) !== undefined, "m2 still queued");
  assert.ok(watchers.has("local"), "stale watcher entry keeps syncSources from restarting it");
});
