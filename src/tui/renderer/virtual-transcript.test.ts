import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { ConversationFirstPane } from "../components/ConversationFirstPane.js";
import {
  renderVirtualTranscriptSearchSnapshot,
  renderVirtualTranscriptSnapshot
} from "./virtual-transcript.js";
import { createTuiRoot } from "./root.js";
import type { ConversationMessage } from "../conversation-layout.js";
import type { TuiElement } from "./dom.js";

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

test("renderer virtual transcript search anchors offscreen matches without mounting full history", () => {
  const messages = longMessages(900);
  messages[24] = { role: "assistant", brief: "offscreen needle appears near the old history" };

  const snapshot = renderVirtualTranscriptSearchSnapshot({
    messages,
    rows: 12,
    columns: 80,
    query: "offscreen needle"
  });

  assert.equal(snapshot.match?.messageIndex, 24);
  assert.equal(snapshot.searchIndexMatchCount, 1);
  assert(snapshot.anchorScrollOffset > 0);
  assert(snapshot.layout.transcript.some((line) => line.messageIndex === 24));
  assert(snapshot.layout.transcript.some((line) => line.selected));
  assert(snapshot.layout.mountedMessageCount < 24);
  assert(snapshot.layout.visibleMessageCount <= 12);
  assert(snapshot.searchMatches.length >= 1);
});

test("renderer virtual transcript search keeps the selected message stable across resize", () => {
  const messages = longMessages(200);
  messages[48] = {
    role: "assistant",
    brief: "resize target wraps differently but keeps the same search anchor across widths"
  };

  const narrow = renderVirtualTranscriptSearchSnapshot({
    messages,
    rows: 10,
    columns: 34,
    query: "search anchor"
  });
  const wide = renderVirtualTranscriptSearchSnapshot({
    messages,
    rows: 10,
    columns: 96,
    query: "search anchor"
  });

  assert.equal(narrow.match?.messageIndex, 48);
  assert.equal(wide.match?.messageIndex, 48);
  assert(narrow.layout.transcript.some((line) => line.messageIndex === 48 && line.selected));
  assert(wide.layout.transcript.some((line) => line.messageIndex === 48 && line.selected));
  assert(narrow.layout.mountedMessageCount < 24);
  assert(wide.layout.mountedMessageCount < 24);
});

test("renderer virtual transcript mounts a live scroll DOM node with scroll bounds", () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: "assistant" as const,
    brief: `assistant line ${index}`
  }));
  const root = createTuiRoot({
    columns: 80,
    rows: 10,
    terminalCapabilities: { mouse: true }
  });

  root.render(React.createElement(ConversationFirstPane, {
    messages,
    rows: 8,
    columns: 80,
    scrollOffset: 6
  }));

  const scroll = findScrollElement(root.getDom());
  assert(scroll);
  assert.equal(scroll.scroll?.scrollTop, 6);
  assert.equal(scroll.scroll?.scrollHeight, 80);
  assert.equal(scroll.scroll?.viewportHeight, 8);
  assert.equal(scroll.scroll?.sticky, false);

  root.dispatchMouse({ x: 1, y: 0, button: "wheel-down", action: "press" });

  assert.equal(scroll.scroll?.scrollTop, 9);
  assert.equal(scroll.scroll?.pendingDelta, 3);
  root.unmount();
});

function longMessages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    brief: `message ${index}`
  }));
}

function findScrollElement(root: TuiElement): TuiElement | undefined {
  if (root.nodeName === "swarm-scroll") {
    return root;
  }
  for (const child of root.childNodes) {
    if (child.nodeName === "#text") {
      continue;
    }
    const found = findScrollElement(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}
