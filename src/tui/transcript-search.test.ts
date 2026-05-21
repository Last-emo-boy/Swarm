import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildTranscriptSearchIndex,
  closeTranscriptSearch,
  createTranscriptSearchState,
  currentTranscriptSearchMatch,
  stepTranscriptSearch,
  transcriptSearchSummary,
  updateTranscriptSearch
} from "./transcript-search.js";
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
