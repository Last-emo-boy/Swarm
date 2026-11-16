/** The outbox's receipts (outbox.ts, store.ts): when a Source took a message, the id the platform gave it, and why one was dropped. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { afterEach, beforeEach, test } from "node:test";
import type { OutboundMessage } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { settingsPath, writeSettings } from "./settings.js";
import type { SourceChannel } from "./sources/kind.js";

let stateDir: string;
let client: SuperagentClient;
/** What the demo Source's channel answers. */
let outcome: "sent" | "gone";
const channel: SourceChannel<Record<string, never>> = {
  async send(host, message) {
    if (outcome === "sent") host.posted?.({ messageId: "pm_1", chatId: message.channel.address.chatId });
    return outcome;
  },
  link: () => ({ url: "", label: "demo" })
};
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-outbox-"));
  writeSettings({ sources: { demo: { enabled: true, config: {} } } }, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
  client.sources.register({ kind: "demo", title: "Demo", schema: z.object({}), health: [], channel });
  outcome = "sent";
  client.effects.start();
});
afterEach(async () => { await client.effects.drain(); client.close(); rmSync(stateDir, { recursive: true, force: true }); });

const message = (patch: Partial<OutboundMessage> = {}): OutboundMessage => ({ id: "m1",
  channel: { source: "demo", thread: "demo:c1", address: { chatId: "c1" } }, text: "hello", kind: "notice", ...patch });

test("a message the Source takes settles with when it went and the platform's id, which the receipt keeps", async () => {
  client.outbox.send(message());
  await client.outbox.sent();
  const receipt = client.store.receipts.get("m1")!;
  assert.equal(receipt.status, "sent");
  assert.ok(receipt.sentAt && Math.abs(Date.parse(receipt.sentAt) - Date.now()) < 60_000, "the time it was sent is kept");
  assert.equal(receipt.platformMessageId, "pm_1");
  assert.equal(client.store.db.prepare("SELECT sentAt FROM outbox WHERE id = 'm1'").get()?.sentAt, receipt.sentAt, "the generated column fills from the stored row");
});

test("a message whose conversation is gone settles dropped with its reason, and one the Source keeps waiting stays pending", async () => {
  outcome = "gone";
  client.outbox.send(message({ id: "m2" }));
  await client.outbox.sent();
  const dropped = client.store.receipts.get("m2")!;
  assert.equal(dropped.status, "dropped");
  assert.equal(dropped.dropped?.reason, "channelGone");
  assert.equal(dropped.sentAt, undefined);

  // A Source that is off holds the message: it stays pending, with nothing of a send on it yet.
  writeSettings({ sources: { demo: { enabled: false, config: {} } } }, settingsPath(stateDir));
  client.outbox.send(message({ id: "m3" }));
  await client.effects.idle("reply");
  assert.equal(client.store.receipts.get("m3")!.status, "pending");
});

test("an old receipt without the new fields still reads, and a receipt recreated while being sent keeps the message it carried", () => {
  // As an earlier version stored it.
  client.store.db.prepare("INSERT INTO outbox VALUES (?,?)").run("old", JSON.stringify({ id: "old", text: "earlier", kind: "reply", status: "sent",
    channel: { source: "demo", thread: "demo:c1", address: { chatId: "c1" } } }));
  const old = client.store.receipts.get("old")!;
  assert.equal(old.status, "sent");
  assert.equal(old.sentAt, undefined);
  assert.equal(old.platformMessageId, undefined);
  // A receipt whose row was withdrawn while it was being sent is recreated with what it carried and the outcome.
  client.store.receipts.settle(message({ id: "withdrawn", ticketId: "t1", triggerId: "tr1", attachment: "/state/x.patch",
    mentions: [{ id: "ou_alice", name: "Alice" }] }), "sent", { at: "2026-11-16T09:00:00.000Z", messageId: "pm_2" });
  const recreated = client.store.receipts.get("withdrawn")!;
  assert.deepEqual([recreated.ticketId, recreated.status, recreated.sentAt, recreated.platformMessageId], ["t1", "sent", "2026-11-16T09:00:00.000Z", "pm_2"]);
  // The whole message is kept: the trigger it answers, the file it sends and whom it names.
  assert.deepEqual([recreated.triggerId, recreated.attachment, recreated.mentions], ["tr1", "/state/x.patch", [{ id: "ou_alice", name: "Alice" }]]);
});
