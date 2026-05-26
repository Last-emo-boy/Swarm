import React, { useRef } from "react";
import { Box, Text } from "../ui.js";
import {
  normalizeConversationScrollOffset,
  applyConversationDynamicLineState,
  conversationMessageFoldKey,
  renderConversationMessageLines,
  unseenTranscriptPill,
  type ConversationRenderOptions,
  type ConversationLine,
  type ConversationMessage
} from "../conversation-layout.js";
import {
  priorityConversationMessageIndexes,
  type PriorityConversationMessageReason
} from "../message-folding.js";
import { visualTokenColor } from "../theme.js";
import { TranscriptRow } from "./TranscriptRow.js";

export type ConversationRenderCacheStats = {
  hits: number;
  misses: number;
};

export type ConversationRenderCache = {
  getMessageLines: (message: ConversationMessage, index: number, columns?: number, options?: ConversationRenderOptions) => ConversationLine[];
  stats: () => ConversationRenderCacheStats;
  resetStats: () => void;
};

export type VirtualConversationHandoffTarget = {
  id: string;
  debugName: string;
  messageIndex: number;
  reason: PriorityConversationMessageReason;
  lineStart: number;
  lineEnd: number;
  visible: boolean;
  mounted: boolean;
};

export type VirtualConversationLayout = {
  transcript: ConversationLine[];
  totalRows: number;
  transcriptLimit: number;
  scrollOffset: number;
  hiddenBelow: number;
  stickyPrompt?: string;
  bottomPill?: string;
  mountedMessageCount: number;
  visibleMessageCount: number;
  mountedRange: { start: number; end: number };
  visibleRange: { start: number; end: number };
  inspectorHandoffTargets: VirtualConversationHandoffTarget[];
};

type VirtualConversationItem = {
  key: string;
  messageIndex?: number;
  lines: ConversationLine[];
  start: number;
  end: number;
};

export function createConversationRenderCache(): ConversationRenderCache {
  const byMessage = new WeakMap<ConversationMessage, Map<string, ConversationLine[]>>();
  let hits = 0;
  let misses = 0;

  return {
    getMessageLines(message: ConversationMessage, index: number, columns?: number, options: ConversationRenderOptions = {}): ConversationLine[] {
      const expanded = options.expandedMessageKeys?.has(conversationMessageFoldKey(message, index)) ?? false;
      const widthKey = [
        columns === undefined ? "auto" : String(Math.floor(columns)),
        expanded ? "expanded" : "compact"
      ].join(":");
      const cachedByWidth = byMessage.get(message);
      const cached = cachedByWidth?.get(widthKey);
      if (cached) {
        hits += 1;
        return applyDynamicLineState(remapMessageLines(cached, index), index, options);
      }
      misses += 1;
      const rendered = renderConversationMessageLines(message, columns, {
        expandedMessageKeys: options.expandedMessageKeys
      }, index);
      const nextByWidth = cachedByWidth ?? new Map<string, ConversationLine[]>();
      nextByWidth.set(widthKey, rendered);
      byMessage.set(message, nextByWidth);
      return applyDynamicLineState(remapMessageLines(rendered, index), index, options);
    },
    stats() {
      return { hits, misses };
    },
    resetStats() {
      hits = 0;
      misses = 0;
    }
  };
}

export function buildVirtualConversationLayout(input: {
  messages: ConversationMessage[];
  rows: number;
  columns?: number;
  scrollOffset?: number;
  newMessageCount?: number;
  unseenStartIndex?: number;
  expandedMessageKeys?: ReadonlySet<string>;
  selectedMessageIndex?: number;
  searchMatchMessageIndex?: number;
  searchMatchQuery?: string;
  overscanRows?: number;
  cache?: ConversationRenderCache;
}): VirtualConversationLayout {
  const cache = input.cache ?? createConversationRenderCache();
  const baseTranscriptLimit = Math.max(1, Math.floor(input.rows));
  const items = buildVirtualConversationItems(input.messages, input.columns, {
    cache,
    unseenStartIndex: input.unseenStartIndex,
    newMessageCount: input.newMessageCount,
    expandedMessageKeys: input.expandedMessageKeys,
    selectedMessageIndex: input.selectedMessageIndex,
    searchMatchMessageIndex: input.searchMatchMessageIndex,
    searchMatchQuery: input.searchMatchQuery
  });
  const totalRows = items.at(-1)?.end ?? 0;
  const requestedOffset = normalizeConversationScrollOffset(totalRows, baseTranscriptLimit, input.scrollOffset ?? 0);
  let transcriptLimit = baseTranscriptLimit;
  let visibleRange = visibleLineRange(totalRows, transcriptLimit, requestedOffset, 0);
  let mountedRange = visibleLineRange(totalRows, transcriptLimit, requestedOffset, input.overscanRows ?? 2);
  let stickyPrompt = requestedOffset > 0
    ? stickyPromptForVirtualWindow(input.messages, items, visibleRange.start, visibleRange.end)
    : undefined;

  if (stickyPrompt) {
    transcriptLimit = Math.max(1, transcriptLimit - 1);
    const scrollOffset = normalizeConversationScrollOffset(totalRows, transcriptLimit, input.scrollOffset ?? 0);
    visibleRange = visibleLineRange(totalRows, transcriptLimit, scrollOffset, 0);
    mountedRange = visibleLineRange(totalRows, transcriptLimit, scrollOffset, input.overscanRows ?? 2);
    stickyPrompt = stickyPromptForVirtualWindow(input.messages, items, visibleRange.start, visibleRange.end);
  }

  const scrollOffset = normalizeConversationScrollOffset(totalRows, transcriptLimit, input.scrollOffset ?? 0);
  const transcript = linesForRange(items, visibleRange.start, visibleRange.end);
  const bottomPill = scrollOffset > 0
    ? unseenTranscriptPill(input.newMessageCount ?? 0)
    : undefined;
  const inspectorHandoffTargets = buildInspectorHandoffTargets({
    messages: input.messages,
    items,
    visibleRange,
    mountedRange
  });

  return {
    transcript,
    totalRows,
    transcriptLimit,
    scrollOffset,
    hiddenBelow: scrollOffset,
    stickyPrompt,
    bottomPill,
    mountedMessageCount: countMessagesInRange(items, mountedRange.start, mountedRange.end),
    visibleMessageCount: countMessagesInRange(items, visibleRange.start, visibleRange.end),
    mountedRange,
    visibleRange,
    inspectorHandoffTargets
  };
}

export function VirtualConversationList(input: {
  messages: ConversationMessage[];
  rows: number;
  columns?: number;
  scrollOffset?: number;
  newMessageCount?: number;
  unseenStartIndex?: number;
  expandedMessageKeys?: ReadonlySet<string>;
  selectedMessageIndex?: number;
  searchMatchMessageIndex?: number;
  searchMatchQuery?: string;
  tail?: React.ReactNode;
  tailRows?: number;
}): React.ReactElement {
  const cacheRef = useRef<ConversationRenderCache>(createConversationRenderCache());
  const tailRows = input.tail ? Math.max(1, Math.floor(input.tailRows ?? 1)) : 0;
  const layoutRows = Math.max(1, input.rows - tailRows);
  const layout = buildVirtualConversationLayout({
    messages: input.messages,
    rows: layoutRows,
    columns: input.columns,
    scrollOffset: input.scrollOffset,
    newMessageCount: input.newMessageCount,
    unseenStartIndex: input.unseenStartIndex,
    expandedMessageKeys: input.expandedMessageKeys,
    selectedMessageIndex: input.selectedMessageIndex,
    searchMatchMessageIndex: input.searchMatchMessageIndex,
    searchMatchQuery: input.searchMatchQuery,
    cache: cacheRef.current
  });

  return (
    <Box flexDirection="column" width="100%" height={input.rows} overflow="hidden">
      {layout.stickyPrompt && (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          ❯ {layout.stickyPrompt}
        </Text>
      )}
      <Box flexDirection="column" width="100%" flexGrow={1} flexShrink={1} overflow="hidden">
        {layout.transcript.map((line) => <TranscriptRow key={line.key} line={line} />)}
        <Box flexGrow={1} />
        {input.tail && (
          <Box width="100%" flexDirection="column" flexShrink={0}>
            {input.tail}
          </Box>
        )}
      </Box>
      {layout.bottomPill && (
        <Box width="100%" justifyContent="center" position="absolute" marginTop={Math.max(0, input.rows - 1)}>
          <Text inverse dimColor wrap="truncate">
            {" "}{layout.bottomPill}{" ↓ "}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function buildVirtualConversationItems(
  messages: ConversationMessage[],
  columns: number | undefined,
  options: {
    cache: ConversationRenderCache;
    unseenStartIndex?: number;
    newMessageCount?: number;
    expandedMessageKeys?: ReadonlySet<string>;
    selectedMessageIndex?: number;
    searchMatchMessageIndex?: number;
    searchMatchQuery?: string;
  }
): VirtualConversationItem[] {
  const items: Omit<VirtualConversationItem, "start" | "end">[] = [];
  const shouldRenderDivider = options.unseenStartIndex !== undefined &&
    Math.max(0, options.newMessageCount ?? 0) > 0 &&
    options.unseenStartIndex >= 0 &&
    options.unseenStartIndex < messages.length;

  messages.forEach((message, index) => {
    if (shouldRenderDivider && index === options.unseenStartIndex) {
      items.push({
        key: `divider:${index}`,
        lines: [unseenDividerLine(index, options.newMessageCount ?? 0)]
      });
    }
    const lines = options.cache.getMessageLines(message, index, columns, {
      expandedMessageKeys: options.expandedMessageKeys,
      selectedMessageIndex: options.selectedMessageIndex,
      searchMatchMessageIndex: options.searchMatchMessageIndex,
      searchMatchQuery: options.searchMatchQuery
    });
    if (lines.length > 0) {
      items.push({
        key: `message:${index}`,
        messageIndex: index,
        lines
      });
    }
  });

  let cursor = 0;
  return items.map((item) => {
    const start = cursor;
    cursor += item.lines.length;
    return { ...item, start, end: cursor };
  });
}

function visibleLineRange(totalRows: number, rows: number, scrollOffset: number, overscanRows: number): { start: number; end: number } {
  if (totalRows <= 0) {
    return { start: 0, end: 0 };
  }
  const normalizedOffset = normalizeConversationScrollOffset(totalRows, rows, scrollOffset);
  const end = totalRows - normalizedOffset;
  const start = Math.max(0, end - Math.max(1, Math.floor(rows)));
  const overscan = Math.max(0, Math.floor(overscanRows));
  return {
    start: Math.max(0, start - overscan),
    end: Math.min(totalRows, end + overscan)
  };
}

function linesForRange(items: VirtualConversationItem[], start: number, end: number): ConversationLine[] {
  const result: ConversationLine[] = [];
  for (const item of items) {
    if (item.end <= start || item.start >= end) {
      continue;
    }
    const localStart = Math.max(0, start - item.start);
    const localEnd = Math.min(item.lines.length, end - item.start);
    result.push(...item.lines.slice(localStart, localEnd));
  }
  return result;
}

function countMessagesInRange(items: VirtualConversationItem[], start: number, end: number): number {
  let count = 0;
  for (const item of items) {
    if (item.messageIndex === undefined || item.end <= start || item.start >= end) {
      continue;
    }
    count += 1;
  }
  return count;
}

function buildInspectorHandoffTargets(input: {
  messages: ConversationMessage[];
  items: VirtualConversationItem[];
  visibleRange: { start: number; end: number };
  mountedRange: { start: number; end: number };
}): VirtualConversationHandoffTarget[] {
  const itemByMessage = new Map<number, VirtualConversationItem>();
  for (const item of input.items) {
    if (item.messageIndex !== undefined) {
      itemByMessage.set(item.messageIndex, item);
    }
  }
  return priorityConversationMessageIndexes(input.messages)
    .map(({ index, reason }) => {
      const item = itemByMessage.get(index);
      if (!item) {
        return undefined;
      }
      return {
        id: `message:${index}:${reason}`,
        debugName: `message:${index}:${reason}`,
        messageIndex: index,
        reason,
        lineStart: item.start,
        lineEnd: item.end,
        visible: rangesOverlap(item, input.visibleRange),
        mounted: rangesOverlap(item, input.mountedRange)
      };
    })
    .filter((target): target is VirtualConversationHandoffTarget => target !== undefined);
}

function rangesOverlap(
  first: { start: number; end: number },
  second: { start: number; end: number }
): boolean {
  return first.end > second.start && first.start < second.end;
}

function stickyPromptForVirtualWindow(
  messages: ConversationMessage[],
  items: VirtualConversationItem[],
  windowStart: number,
  windowEnd: number
): string | undefined {
  if (windowStart <= 0) {
    return undefined;
  }
  const bounds = renderedLineBoundsByMessage(items);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const bound = bounds.get(index);
    if (message?.role !== "user" || !bound || !message.brief.trim()) {
      continue;
    }
    if (bound.first < windowEnd && bound.last >= windowStart) {
      return undefined;
    }
    if (bound.last < windowStart) {
      return compactStickyPrompt(message.brief);
    }
  }
  return undefined;
}

function renderedLineBoundsByMessage(items: VirtualConversationItem[]): Map<number, { first: number; last: number }> {
  const result = new Map<number, { first: number; last: number }>();
  for (const item of items) {
    if (item.messageIndex === undefined) {
      continue;
    }
    result.set(item.messageIndex, {
      first: item.start,
      last: item.end - 1
    });
  }
  return result;
}

function remapMessageLines(lines: ConversationLine[], messageIndex: number): ConversationLine[] {
  return lines.map((line) => ({
    ...line,
    key: `message:${messageIndex}:${line.key}`,
    messageIndex
  }));
}

function applyDynamicLineState(lines: ConversationLine[], messageIndex: number, options: ConversationRenderOptions): ConversationLine[] {
  return applyConversationDynamicLineState(lines, messageIndex, options);
}

function unseenDividerLine(unseenStartIndex: number, newMessageCount: number): ConversationLine {
  const count = Math.max(1, newMessageCount);
  return {
    key: `transcript:unseen-divider:${unseenStartIndex}`,
    role: "system",
    text: `--- ${count} new message${count === 1 ? "" : "s"} ---`,
    kind: "divider",
    dim: true
  };
}

function compactStickyPrompt(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157).trimEnd()}...` : singleLine;
}
