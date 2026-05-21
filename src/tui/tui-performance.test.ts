import { strict as assert } from "node:assert";
import test from "node:test";
import {
  conversationBottomRows,
  conversationInputCapacity,
  conversationMessageFoldKey,
  conversationPromptRows,
  fullscreenConversationRows,
  type ConversationMessage
} from "./conversation-layout.js";
import {
  buildVirtualConversationLayout,
  createConversationRenderCache
} from "./components/VirtualConversationList.js";
import {
  buildTranscriptSearchIndex,
  currentTranscriptSearchMatch,
  updateTranscriptSearch,
  createTranscriptSearchState
} from "./transcript-search.js";

test("TUI viewport gates keep transcript room across short, narrow, normal, and tall terminals", () => {
  for (const viewport of [
    { rows: 8, columns: 44 },
    { rows: 14, columns: 58 },
    { rows: 32, columns: 100 },
    { rows: 52, columns: 140 }
  ]) {
    const bottomRows = conversationBottomRows({
      terminalRows: viewport.rows,
      contentRows: conversationPromptRows(0),
      approval: false,
      pendingPlan: false
    });
    const transcriptRows = fullscreenConversationRows(viewport.rows, bottomRows);
    const capacity = conversationInputCapacity({ bottomRows });

    assert(transcriptRows >= 4, `expected transcript room for ${viewport.rows}x${viewport.columns}`);
    assert(bottomRows <= Math.max(4, Math.floor(viewport.rows * 0.5)));
    assert(capacity.maxInputRows >= 1);
    assert(capacity.maxCompletionRows >= 1);
  }
});

test("virtual transcript performance gate catches full remount regressions on append", () => {
  const messages = longConversationMessages(1500);
  const cache = createConversationRenderCache();
  const initial = buildVirtualConversationLayout({
    messages,
    rows: 18,
    columns: 96,
    scrollOffset: 0,
    cache
  });

  assert.equal(initial.transcript.length, 18);
  assert(initial.visibleMessageCount <= 18);
  assert(initial.mountedMessageCount < 28);
  assert.equal(cache.stats().misses, messages.length);

  cache.resetStats();
  const appended = buildVirtualConversationLayout({
    messages: [...messages, { role: "assistant", brief: "fresh appended tail" }],
    rows: 18,
    columns: 96,
    scrollOffset: 0,
    cache
  });

  assert.equal(appended.transcript.at(-1)?.text, "fresh appended tail");
  assert.equal(cache.stats().misses, 1);
  assert(cache.stats().hits >= messages.length, "append should reuse cached message layouts");
});

test("long-session search jumps to offscreen matches without mounting the whole transcript", () => {
  const messages = longConversationMessages(1200);
  messages[25] = {
    role: "assistant",
    brief: "This is the offscreen needle for transcript search."
  };
  const state = updateTranscriptSearch(
    createTranscriptSearchState(),
    buildTranscriptSearchIndex(messages),
    "offscreen needle"
  );
  const match = currentTranscriptSearchMatch(state);

  assert.equal(match?.messageIndex, 25);

  const cache = createConversationRenderCache();
  const belowTarget = messages.slice((match?.messageIndex ?? 0) + 1);
  const rowsBelowTarget = buildVirtualConversationLayout({
    messages: belowTarget,
    rows: 18,
    columns: 96,
    cache
  }).totalRows;
  cache.resetStats();

  const layout = buildVirtualConversationLayout({
    messages,
    rows: 18,
    columns: 96,
    scrollOffset: rowsBelowTarget,
    searchMatchMessageIndex: match?.messageIndex,
    cache
  });

  assert(layout.transcript.some((line) => line.messageIndex === 25 && line.selected));
  assert(layout.mountedMessageCount < 30);
});

test("expanded fold rows update virtual height without losing cache isolation", () => {
  const messages = longConversationMessages(100);
  messages[90] = {
    role: "system",
    kind: "tool_result",
    status: "success",
    brief: "shell.exec: command exited 0",
    preview: "shell.exec: command exited 0",
    detail: [
      "shell.exec: command exited 0",
      "short",
      "full output line",
      "another full output line"
    ].join("\n")
  };
  const cache = createConversationRenderCache();
  const compact = buildVirtualConversationLayout({ messages, rows: 12, columns: 88, cache });
  const compactText = compact.transcript.map((line) => line.text).join("\n");

  cache.resetStats();
  const expanded = buildVirtualConversationLayout({
    messages,
    rows: 12,
    columns: 88,
    expandedMessageKeys: new Set([conversationMessageFoldKey(messages[90]!, 90)]),
    selectedMessageIndex: 90,
    cache
  });
  const expandedText = expanded.transcript.map((line) => line.text).join("\n");

  assert.doesNotMatch(compactText, /full output line/);
  assert.match(expandedText, /full output line/);
  assert(expanded.totalRows > compact.totalRows);
  assert(cache.stats().misses >= 1);
  assert(expanded.transcript.some((line) => line.messageIndex === 90 && line.selected));
});

function longConversationMessages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => {
    if (index % 2 === 0) {
      return {
        role: "user",
        brief: `prompt ${index}`
      };
    }
    return {
      role: "assistant",
      brief: `assistant response ${index}`
    };
  });
}
