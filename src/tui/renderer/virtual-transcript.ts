import React from "react";
import type { ConversationMessage } from "../conversation-layout.js";
import {
  buildVirtualConversationLayout,
  createConversationRenderCache,
  type VirtualConversationLayout
} from "../components/VirtualConversationList.js";
import {
  buildTranscriptSearchIndex,
  createTranscriptSearchState,
  currentTranscriptSearchMatch,
  updateTranscriptSearch,
  type TranscriptSearchMatch
} from "../transcript-search.js";
import { Text } from "./components/Text.js";
import { renderToScreen } from "./render-to-screen.js";
import { searchFrameText, type TuiSearchMatch } from "./search-highlight.js";
import type { TuiFrame } from "./frame.js";

export type RendererVirtualTranscriptSnapshot = {
  layout: VirtualConversationLayout;
  frame: TuiFrame;
  searchMatches: TuiSearchMatch[];
};

export type RendererVirtualTranscriptSearchSnapshot = RendererVirtualTranscriptSnapshot & {
  anchorScrollOffset: number;
  match?: TranscriptSearchMatch;
  searchIndexMatchCount: number;
};

export function renderVirtualTranscriptSnapshot(input: {
  messages: ConversationMessage[];
  rows: number;
  columns: number;
  scrollOffset?: number;
  query?: string;
  newMessageCount?: number;
  unseenStartIndex?: number;
}): RendererVirtualTranscriptSnapshot {
  const layout = buildVirtualConversationLayout({
    messages: input.messages,
    rows: input.rows,
    columns: input.columns,
    scrollOffset: input.scrollOffset,
    newMessageCount: input.newMessageCount,
    unseenStartIndex: input.unseenStartIndex
  });
  const frame = renderToScreen(
    React.createElement(Text, null, layout.transcript.map((line) => line.text).join("\n")),
    { width: input.columns, height: input.rows }
  ).frame;
  return {
    layout,
    frame,
    searchMatches: input.query ? searchFrameText(frame, input.query) : []
  };
}

export function renderVirtualTranscriptSearchSnapshot(input: {
  messages: ConversationMessage[];
  rows: number;
  columns: number;
  query: string;
  currentIndex?: number;
  newMessageCount?: number;
  unseenStartIndex?: number;
}): RendererVirtualTranscriptSearchSnapshot {
  const searchState = updateTranscriptSearch(
    createTranscriptSearchState(),
    buildTranscriptSearchIndex(input.messages),
    input.query
  );
  const currentIndex = searchState.matches.length
    ? clampSearchIndex(input.currentIndex ?? searchState.currentIndex, searchState.matches.length)
    : -1;
  const selectedSearchState = { ...searchState, currentIndex };
  const match = currentTranscriptSearchMatch(selectedSearchState);
  const cache = createConversationRenderCache();
  const anchorScrollOffset = match
    ? scrollOffsetToRevealMessage({
      messages: input.messages,
      messageIndex: match.messageIndex,
      rows: input.rows,
      columns: input.columns,
      cache
    })
    : 0;
  const layout = buildVirtualConversationLayout({
    messages: input.messages,
    rows: input.rows,
    columns: input.columns,
    scrollOffset: anchorScrollOffset,
    newMessageCount: input.newMessageCount,
    unseenStartIndex: input.unseenStartIndex,
    searchMatchMessageIndex: match?.messageIndex,
    searchMatchQuery: input.query,
    cache
  });
  const frame = renderToScreen(
    React.createElement(Text, null, layout.transcript.map((line) => line.text).join("\n")),
    { width: input.columns, height: input.rows }
  ).frame;
  return {
    layout,
    frame,
    searchMatches: input.query ? searchFrameText(frame, input.query) : [],
    anchorScrollOffset,
    match,
    searchIndexMatchCount: searchState.matches.length
  };
}

function scrollOffsetToRevealMessage(input: {
  messages: ConversationMessage[];
  messageIndex: number;
  rows: number;
  columns: number;
  cache: ReturnType<typeof createConversationRenderCache>;
}): number {
  const belowTarget = input.messages.slice(input.messageIndex + 1);
  return buildVirtualConversationLayout({
    messages: belowTarget,
    rows: input.rows,
    columns: input.columns,
    cache: input.cache
  }).totalRows;
}

function clampSearchIndex(index: number, matchCount: number): number {
  return Math.min(Math.max(0, index), matchCount - 1);
}
