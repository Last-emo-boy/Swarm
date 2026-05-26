import React from "react";
import type { ConversationMessage } from "../conversation-layout.js";
import {
  buildVirtualConversationLayout,
  type VirtualConversationLayout
} from "../components/VirtualConversationList.js";
import { Text } from "./components/Text.js";
import { renderToScreen } from "./render-to-screen.js";
import { searchFrameText, type TuiSearchMatch } from "./search-highlight.js";
import type { TuiFrame } from "./frame.js";

export type RendererVirtualTranscriptSnapshot = {
  layout: VirtualConversationLayout;
  frame: TuiFrame;
  searchMatches: TuiSearchMatch[];
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

