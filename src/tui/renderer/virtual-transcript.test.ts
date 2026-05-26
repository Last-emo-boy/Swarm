import { strict as assert } from "node:assert";
import test from "node:test";
import { renderVirtualTranscriptSnapshot } from "./virtual-transcript.js";
import type { ConversationMessage } from "../conversation-layout.js";

test("renderer virtual transcript snapshots visible rows without mounting full history", () => {
  const messages = longMessages(500);
  messages[498] = { role: "assistant", brief: "needle appears at the tail" };
  const snapshot = renderVirtualTranscriptSnapshot({
    messages,
    rows: 12,
    columns: 80,
    query: "needle"
  });

  assert(snapshot.layout.mountedMessageCount < 24);
  assert(snapshot.layout.visibleMessageCount <= 12);
  assert.equal(snapshot.searchMatches.length, 1);
  assert.equal(snapshot.searchMatches[0]?.row, 10);
});

function longMessages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    brief: `message ${index}`
  }));
}

