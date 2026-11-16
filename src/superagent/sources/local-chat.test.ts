import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Trigger } from "../core/index.js";
import { KV } from "../kv.js";
import { SuperagentClient } from "../client.js";
import { localChatKind, localOperator, takeLocalInbox, TUI_CHAT } from "./local.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "swarm-local-chat-")); client = new SuperagentClient({ stateDir }); });
afterEach(() => { client.close(); rmSync(stateDir, { recursive: true, force: true }); });

test("the terminal is a chat kind: one direct chat, the operator in it, the same flat address", () => {
  assert.equal(client.sources.chatKind("local"), localChatKind);
  const state = client.store;
  assert.deepEqual(localChatKind.directory.chats(state), [{ source: "local", chatId: TUI_CHAT, name: localOperator(), direct: true, people: 1 }]);
  assert.equal(localChatKind.directory.chat(state, TUI_CHAT)?.direct, true);
  assert.equal(localChatKind.directory.chatKey(TUI_CHAT), true);
  assert.equal(localChatKind.directory.chatKey("some-ticket"), false);
  assert.equal(localChatKind.directory.personKey(localOperator()), true);
  assert.equal(localChatKind.directory.personKey("ou_someone"), false);
  // A post into the terminal chat keeps the flat local address, and only that chat reads back as a chat.
  const channel = localChatKind.chat(TUI_CHAT);
  assert.deepEqual(channel, { source: "local", thread: `local:${TUI_CHAT}`, address: { thread: TUI_CHAT } });
  assert.deepEqual(localChatKind.describe(channel), { chatId: TUI_CHAT, direct: true, mode: "chat" });
  assert.deepEqual(localChatKind.describe({ source: "local", thread: "local:request-1", address: { thread: "request-1" } }), { direct: true, mode: "chat" });
});

test("a message the TUI queues is taken in as chat once, through the same receive Feishu's stream uses", async () => {
  const received: Trigger[] = [];
  type Ctx = Parameters<typeof takeLocalInbox>[0];
  // The context's state deletes on undefined, as sourceContextOf's does.
  const ctx: Ctx = {
    state: {
      get: (key) => client.store.get(key) as never,
      set: (key, value) => { if (value === undefined) client.store.delete(String(key)); else client.store.set(key as never, value as never); },
      keys: () => client.store.keys(KV.local.inbox) as never,
    },
    atomic: (work) => client.store.atomic(work),
    receive: (trigger) => { received.push(trigger); return undefined; },
  };
  client.chat("/me");
  // A moment apart, as two typed messages are; inside one millisecond the order is by id, which is random by design.
  await new Promise((resolve) => setTimeout(resolve, 5));
  client.chat("hello there");
  assert.equal(takeLocalInbox(ctx), 2);
  assert.deepEqual(received.map((trigger) => trigger.text), ["/me", "hello there"]);
  assert.deepEqual(received.map((trigger) => trigger.meta.chatId), [TUI_CHAT, TUI_CHAT]);
  assert.deepEqual(received.map((trigger) => trigger.threads[0]!.id), [TUI_CHAT, TUI_CHAT], "the chat's thread, not a request's");
  assert.equal(client.store.keys(KV.local.inbox).length, 0, "taken in once");
  assert.equal(takeLocalInbox(ctx), 0, "nothing is taken in again");
});

test("a message queued while the host ran elsewhere is still there for the host to take in", () => {
  const message = client.chat("are you there?");
  // A second client over the same directory — the host — sees the row the TUI queued.
  const host = new SuperagentClient({ stateDir });
  try {
    assert.equal(host.store.get(KV.local.inbox(message.messageId))?.text, "are you there?");
  } finally { host.close(); }
});
