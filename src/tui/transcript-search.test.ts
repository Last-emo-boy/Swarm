import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildTranscriptSearchIndex,
  closeTranscriptSearch,
  createTranscriptSearchState,
  currentTranscriptSearchMatch,
  refreshTranscriptSearch,
  stepTranscriptSearch,
  transcriptSearchSummary,
  updateTranscriptSearch
} from "./transcript-search.js";
import { splitSearchHighlightText } from "./renderer/search-highlight.js";
import type { ConversationMessage } from "./conversation-layout.js";

test("transcript search indexes brief, preview, and detail text", () => {
  const index = buildTranscriptSearchIndex(messages());
  const state = updateTranscriptSearch(createTranscriptSearchState(), index, "offscreen target");

  assert.equal(state.matches.length, 1);
  assert.deepEqual(currentTranscriptSearchMatch(state), {
    messageIndex: 3,
    start: state.matches[0]?.start,
    end: state.matches[0]?.end
  });
  assert.equal(transcriptSearchSummary(state), "search 1/1 offscreen target");
});

test("transcript search supports no matches, close, and wraparound navigation", () => {
  const index = buildTranscriptSearchIndex(messages());
  const empty = updateTranscriptSearch(createTranscriptSearchState(), index, "missing");
  assert.equal(empty.matches.length, 0);
  assert.equal(empty.currentIndex, -1);
  assert.equal(transcriptSearchSummary(empty), "search 0/missing");

  const found = updateTranscriptSearch(empty, index, "line");
  assert(found.matches.length >= 2);
  const previous = stepTranscriptSearch(found, -1);
  assert.equal(previous.currentIndex, found.matches.length - 1);

  const closed = closeTranscriptSearch(previous);
  assert.equal(closed.active, false);
  assert.equal(transcriptSearchSummary(closed), undefined);
});

test("transcript search refresh preserves active query and current match on stream append", () => {
  const initial = updateTranscriptSearch(createTranscriptSearchState(), buildTranscriptSearchIndex(messages()), "line");
  const selected = stepTranscriptSearch(initial, 1);
  const selectedMatch = currentTranscriptSearchMatch(selected);
  assert(selectedMatch);

  const refreshed = refreshTranscriptSearch(selected, buildTranscriptSearchIndex([
    ...messages(),
    { role: "assistant", brief: "Fresh appended line from a runtime event." }
  ]));

  assert.equal(refreshed.active, true);
  assert.equal(refreshed.query, "line");
  assert(refreshed.matches.length > selected.matches.length);
  assert.equal(currentTranscriptSearchMatch(refreshed)?.messageIndex, selectedMatch.messageIndex);
  assert.equal(transcriptSearchSummary(refreshed)?.startsWith("search "), true);
});

test("transcript search refresh leaves inactive search closed", () => {
  const inactive = createTranscriptSearchState();
  const refreshed = refreshTranscriptSearch(inactive, buildTranscriptSearchIndex(messages()));

  assert.equal(refreshed, inactive);
});

test("transcript search aliases locate cache miss, LSP fallback, Gateway actions, and action ids", () => {
  const index = buildTranscriptSearchIndex([
    {
      role: "system",
      kind: "progress",
      status: "warning",
      brief: "Provider usage prompt_cache_status=cache_miss missReason=prefix_drift"
    },
    {
      role: "system",
      kind: "progress",
      status: "warning",
      brief: "Semantic provider fallback_reason=provider_unavailable; use file.grep/file.read"
    },
    {
      role: "system",
      kind: "progress",
      status: "warning",
      brief: "Symphony live_control not_supported message_id=gateway-action-1"
    }
  ]);

  assert.equal(firstMatchIndex(index, "cache miss"), 0);
  assert.equal(firstMatchIndex(index, "lsp fallback"), 1);
  assert.equal(firstMatchIndex(index, "gateway action"), 2);
  assert.equal(firstMatchIndex(index, "action id gateway-action-1"), 2);
});

test("search highlight segments preserve unmatched text around every local match", () => {
  assert.deepEqual(splitSearchHighlightText("cache miss then CACHE MISS", "cache miss"), [
    { text: "cache miss", match: true },
    { text: " then ", match: false },
    { text: "CACHE MISS", match: true }
  ]);
  assert.deepEqual(splitSearchHighlightText("no query", " "), [
    { text: "no query", match: false }
  ]);
});

function firstMatchIndex(index: ReturnType<typeof buildTranscriptSearchIndex>, query: string): number | undefined {
  const state = updateTranscriptSearch(createTranscriptSearchState(), index, query);
  return currentTranscriptSearchMatch(state)?.messageIndex;
}

function messages(): ConversationMessage[] {
  return [
    { role: "system", brief: "Swarm chat ready." },
    { role: "user", brief: "Find a line." },
    { role: "assistant", brief: "First line." },
    {
      role: "assistant",
      brief: "Result",
      preview: "short preview",
      detail: "Full detail with offscreen target and another line."
    }
  ];
}
