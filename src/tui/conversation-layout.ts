import { renderMarkdownLines, type MarkdownLine } from "./markdown-rendering.js";
import { displayWidth, sliceByDisplayWidth } from "./display-width.js";
import { transcriptEventToken, type TuiTone } from "./theme.js";

export type ConversationMessage = {
  role: "user" | "assistant" | "system";
  brief: string;
  detail?: string;
  preview?: string;
  kind?: "message" | "logo" | "command" | "tool_use" | "tool_result" | "thinking" | "approval" | "progress";
  title?: string;
  status?: "running" | "pending" | "success" | "warning" | "error" | "info";
};

export type ConversationLine = {
  key: string;
  role: ConversationMessage["role"];
  messageIndex?: number;
  text: string;
  kind: "label" | MarkdownLine["kind"] | "divider";
  bold?: boolean;
  dim?: boolean;
  selected?: boolean;
  tone?: TuiTone;
};

export type ConversationFirstLayout = {
  transcript: ConversationLine[];
  activity: string[];
  transcriptLimit: number;
  activityLimit: number;
  scrollOffset: number;
  hiddenBelow: number;
  stickyPrompt?: string;
  bottomPill?: string;
};

export type ConversationViewportState = {
  scrollOffset: number;
  newMessageCount: number;
  unseenStartIndex?: number;
};

export type DetailOpenTarget = "latest" | "selected-action" | "none";
export type InlineInspectorTarget = {
  enabled: boolean;
  source: "ai" | "command" | "task" | "event";
  title: string;
};

export type TuiScreenMode = {
  compactStatus: boolean;
  showCurrentAction: boolean;
  showInspector: boolean;
  primarySurface: "conversation" | "trace" | "operator";
};

export function buildConversationFirstLayout(input: {
  messages: ConversationMessage[];
  activity: string[];
  rows: number;
  columns?: number;
  busy: boolean;
  hasResult: boolean;
  scrollOffset?: number;
  newMessageCount?: number;
  unseenStartIndex?: number;
}): ConversationFirstLayout {
  const baseTranscriptLimit = conversationTranscriptLimit(input.rows, input.busy, input.hasResult);
  const activityLimit = conversationActivityLimit(input.rows, input.busy, input.hasResult);
  const rendered = renderConversationLines(input.messages, input.columns, {
    unseenStartIndex: input.unseenStartIndex,
    newMessageCount: input.newMessageCount
  });
  const requestedScrollOffset = normalizeConversationScrollOffset(rendered.length, baseTranscriptLimit, input.scrollOffset ?? 0);
  let transcriptLimit = Math.max(1, baseTranscriptLimit);
  let scrollOffset = normalizeConversationScrollOffset(rendered.length, transcriptLimit, input.scrollOffset ?? 0);
  let windowed = windowConversationLines(rendered, transcriptLimit, scrollOffset);
  const stickyPrompt = scrollOffset > 0
    ? stickyPromptForWindow(input.messages, rendered, windowed.start, windowed.end)
    : undefined;
  if (stickyPrompt) {
    transcriptLimit = Math.max(1, transcriptLimit - 1);
    scrollOffset = normalizeConversationScrollOffset(rendered.length, transcriptLimit, input.scrollOffset ?? 0);
    windowed = windowConversationLines(rendered, transcriptLimit, scrollOffset);
  }
  const bottomPill = scrollOffset > 0
    ? unseenTranscriptPill(input.newMessageCount ?? 0)
    : undefined;
  return {
    transcript: windowed.lines,
    activity: activityLimit > 0 ? input.activity.slice(-activityLimit) : [],
    transcriptLimit,
    activityLimit,
    scrollOffset,
    hiddenBelow: windowed.hiddenBelow,
    stickyPrompt,
    bottomPill
  };
}

export function conversationTranscriptLimit(rows: number, busy: boolean, hasResult: boolean): number {
  return Math.max(4, Math.floor(rows));
}

export function conversationActivityLimit(rows: number, busy: boolean, hasResult: boolean): number {
  return busy ? 1 : 0;
}

export const CONVERSATION_PROMPT_CHROME_ROWS = 4;
export const CONVERSATION_MIN_TRANSCRIPT_ROWS = 4;
export const CONVERSATION_MAX_INPUT_ROWS = 4;

export function conversationInputCapacity(input: {
  bottomRows: number;
}): { maxInputRows: number; maxCompletionRows: number } {
  const availableRows = Math.max(1, Math.floor(input.bottomRows) - 2);
  return {
    maxCompletionRows: Math.max(0, availableRows - 1),
    maxInputRows: CONVERSATION_MAX_INPUT_ROWS
  };
}

export function conversationPromptRows(completionRows: number): number {
  return CONVERSATION_PROMPT_CHROME_ROWS + Math.max(0, completionRows);
}

export function conversationBottomStatusRows(input: {
  busy?: boolean;
  hasResult?: boolean;
}): number {
  if (input.busy) {
    return 1;
  }
  if (input.hasResult) {
    return 2;
  }
  return 0;
}

export function conversationBottomRows(input: {
  terminalRows: number;
  contentRows: number;
  approval?: boolean;
  pendingPlan?: boolean;
}): number {
  const terminalRows = Math.max(1, Math.floor(input.terminalRows));
  if (input.approval) {
    return clampConversationBottomRows(Math.max(8, Math.floor(terminalRows * 0.45)), terminalRows);
  }
  if (input.pendingPlan) {
    return clampConversationBottomRows(3, terminalRows);
  }
  return clampConversationBottomRows(
    Math.max(CONVERSATION_PROMPT_CHROME_ROWS, input.contentRows),
    terminalRows
  );
}

export function fullscreenConversationRows(terminalRows: number, bottomRows: number): number {
  return Math.max(CONVERSATION_MIN_TRANSCRIPT_ROWS, Math.floor(terminalRows) - Math.max(0, Math.floor(bottomRows)));
}

export function normalizeConversationScrollOffset(totalLines: number, viewportLines: number, scrollOffset: number): number {
  const maxOffset = Math.max(0, totalLines - Math.max(1, viewportLines));
  return Math.max(0, Math.min(maxOffset, Math.floor(scrollOffset)));
}

export function nextConversationScrollOffset(input: {
  totalLines: number;
  viewportLines: number;
  currentOffset: number;
  delta: number;
}): number {
  return normalizeConversationScrollOffset(
    input.totalLines,
    input.viewportLines,
    input.currentOffset + input.delta
  );
}

export function conversationHiddenBelowCount(input: {
  totalLines: number;
  viewportLines: number;
  scrollOffset: number;
}): number {
  return normalizeConversationScrollOffset(input.totalLines, input.viewportLines, input.scrollOffset);
}

export function conversationScrollOffsetAfterAppend(currentOffset: number, appendedLines: number): number {
  if (currentOffset <= 0) {
    return 0;
  }
  return currentOffset + Math.max(0, appendedLines);
}

export function conversationNewMessageCountAfterAppend(input: {
  currentOffset: number;
  currentCount: number;
  message: ConversationMessage;
}): number {
  if (input.message.role === "user" || input.currentOffset <= 0) {
    return 0;
  }
  return isUnseenCountableAssistantMessage(input.message)
    ? Math.max(0, input.currentCount) + 1
    : Math.max(0, input.currentCount);
}

export function stickyPromptForMessages(messages: ConversationMessage[]): string | undefined {
  return latestUserPrompt(messages);
}

export function unseenTranscriptPill(newMessageCount: number): string {
  return newMessageCount > 0
    ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
    : "Jump to bottom";
}

export function conversationRenderedLineCount(
  messages: ConversationMessage[],
  columns?: number,
  options?: ConversationRenderOptions
): number {
  return renderConversationLines(messages, columns, options).length;
}

export function conversationMessageRenderedLineCount(message: ConversationMessage, columns?: number): number {
  return renderConversationLines([message], columns).length;
}

export function renderConversationMessageLines(
  message: ConversationMessage,
  columns?: number,
  options: ConversationRenderOptions = {},
  messageIndex = 0
): ConversationLine[] {
  return renderConversationMessage(message, messageIndex, options)
    .flatMap((line) => wrapConversationLine(line, columns));
}

export function conversationAppendRenderedLineCount(input: {
  message: ConversationMessage;
  columns?: number;
  startsUnseenSection?: boolean;
}): number {
  return conversationMessageRenderedLineCount(input.message, input.columns) + (input.startsUnseenSection ? 1 : 0);
}

export function resetConversationViewport(): ConversationViewportState {
  return {
    scrollOffset: 0,
    newMessageCount: 0,
    unseenStartIndex: undefined
  };
}

export function conversationViewportAfterAppend(input: {
  state: ConversationViewportState;
  message: ConversationMessage;
  messageIndex: number;
  columns?: number;
}): ConversationViewportState {
  if (input.message.role === "user") {
    return resetConversationViewport();
  }
  const shouldTrackUnseen = input.state.scrollOffset > 0;
  const startsUnseenSection = shouldTrackUnseen && input.state.unseenStartIndex === undefined;
  return {
    scrollOffset: conversationScrollOffsetAfterAppend(
      input.state.scrollOffset,
      conversationAppendRenderedLineCount({
        message: input.message,
        columns: input.columns,
        startsUnseenSection
      })
    ),
    newMessageCount: conversationNewMessageCountAfterAppend({
      currentOffset: input.state.scrollOffset,
      currentCount: input.state.newMessageCount,
      message: input.message
    }),
    unseenStartIndex: shouldTrackUnseen
      ? input.state.unseenStartIndex ?? input.messageIndex
      : undefined
  };
}

export function conversationViewportAfterScroll(input: {
  state: ConversationViewportState;
  totalLines: number;
  viewportLines: number;
  delta: number;
}): ConversationViewportState {
  const scrollOffset = nextConversationScrollOffset({
    totalLines: input.totalLines,
    viewportLines: input.viewportLines,
    currentOffset: input.state.scrollOffset,
    delta: input.delta
  });
  return scrollOffset === 0
    ? resetConversationViewport()
    : { ...input.state, scrollOffset };
}

export function conversationRoleLabel(role: ConversationMessage["role"]): string {
  if (role === "user") {
    return "❯";
  }
  return "";
}

export function conversationMessageFoldKey(message: ConversationMessage, index: number): string {
  return [
    index,
    message.role,
    message.kind ?? "message",
    message.status ?? "",
    message.title ?? "",
    message.brief.slice(0, 120)
  ].join("|");
}

export function isFoldableConversationMessage(message: ConversationMessage): boolean {
  return message.kind === "thinking" ||
    message.kind === "tool_use" ||
    message.kind === "tool_result" ||
    message.kind === "approval" ||
    message.kind === "progress";
}

function renderConversationMessage(message: ConversationMessage, index: number, options: ConversationRenderOptions): ConversationLine[] {
  if (message.kind === "logo") {
    return markSelectedLines(renderConversationLogoMessage(message, index), index, options);
  }
  if (message.kind && message.kind !== "message") {
    return markSelectedLines(renderConversationEventMessage(message, index, options), index, options);
  }
  const content = conversationMessageContent(message);
  const markdownLines = renderMarkdownLines(content);
  const baseKey = `${message.role}:${index}`;
  if (markdownLines.length === 0) {
    return [];
  }

  if (markdownLines.length === 1 && markdownLines[0]?.kind === "paragraph") {
    const text = conversationInlineText(message.role, markdownLines[0].text);
    return [{
      key: `${baseKey}:0`,
      role: message.role,
      messageIndex: index,
      text,
      kind: "paragraph",
      bold: false,
      selected: isSelectedConversationMessage(index, options)
    }];
  }

  const label = conversationRoleLabel(message.role);
  return markSelectedLines([
    ...(label
      ? [{
      key: `${baseKey}:label`,
      role: message.role,
      messageIndex: index,
      text: label,
      kind: "label",
      bold: true
    } satisfies ConversationLine]
      : []),
    ...markdownLines.map((line, lineIndex) => ({
      key: `${baseKey}:${lineIndex}`,
      role: message.role,
      messageIndex: index,
      text: renderConversationMarkdownLine(message.role, line),
      kind: line.kind,
      bold: line.bold,
      dim: line.dim
    }))
  ], index, options);
}

function renderConversationLogoMessage(message: ConversationMessage, index: number): ConversationLine[] {
  const baseKey = `logo:${index}`;
  return renderMarkdownLines(message.brief).map((line, lineIndex) => ({
    key: `${baseKey}:${lineIndex}`,
    role: message.role,
    messageIndex: index,
    text: line.text,
    kind: line.kind,
    bold: line.bold,
    dim: line.dim
  }));
}

function renderConversationEventMessage(message: ConversationMessage, index: number, options: ConversationRenderOptions): ConversationLine[] {
  const content = conversationEventContent(message, isConversationMessageExpanded(message, index, options));
  const markdownLines = renderMarkdownLines(content);
  const baseKey = `${message.kind}:${index}`;
  if (markdownLines.length === 0) {
    return [];
  }
  return markdownLines.map((line, lineIndex) => ({
    key: `${baseKey}:${lineIndex}`,
    role: message.role,
    messageIndex: index,
    text: renderConversationEventLine(message, line, lineIndex),
    kind: line.kind,
    bold: line.bold,
    dim: line.dim ?? (message.status === "running" || message.kind === "thinking"),
    tone: transcriptEventToken(message.kind, message.status).tone
  }));
}

export type ConversationRenderOptions = {
  unseenStartIndex?: number;
  newMessageCount?: number;
  expandedMessageKeys?: ReadonlySet<string>;
  selectedMessageIndex?: number;
  searchMatchMessageIndex?: number;
};

function renderConversationLines(
  messages: ConversationMessage[],
  columns?: number,
  options: ConversationRenderOptions = {}
): ConversationLine[] {
  const rawLines = messages
    .flatMap((message, index) => renderConversationMessage(message, index, options))
  const withDivider = insertUnseenDivider(rawLines, messages.length, options);
  return withDivider.flatMap((line) => wrapConversationLine(line, columns));
}

function insertUnseenDivider(
  lines: ConversationLine[],
  messageCount: number,
  options: ConversationRenderOptions
): ConversationLine[] {
  const unseenStartIndex = options.unseenStartIndex;
  const newMessageCount = Math.max(0, options.newMessageCount ?? 0);
  if (
    unseenStartIndex === undefined ||
    newMessageCount <= 0 ||
    unseenStartIndex < 0 ||
    unseenStartIndex >= messageCount
  ) {
    return lines;
  }
  const insertAt = lines.findIndex((line) =>
    line.messageIndex !== undefined && line.messageIndex >= unseenStartIndex
  );
  if (insertAt < 0) {
    return lines;
  }
  return [
    ...lines.slice(0, insertAt),
    unseenDividerLine(unseenStartIndex, newMessageCount),
    ...lines.slice(insertAt)
  ];
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

function conversationMessageContent(message: ConversationMessage): string {
  if (message.role !== "assistant") {
    return message.brief;
  }
  return extractFullOutput(message.detail) ?? message.detail ?? message.preview ?? message.brief;
}

function conversationEventContent(message: ConversationMessage, expanded: boolean): string {
  if (expanded) {
    return message.detail ?? message.preview ?? message.brief;
  }
  if (!isFoldableConversationMessage(message)) {
    return message.preview ?? message.detail ?? message.brief;
  }
  return firstNonEmptyLine(message.preview ?? message.brief) || firstNonEmptyLine(message.detail) || message.brief;
}

function latestUserPrompt(messages: ConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.brief.trim()) {
      return compactStickyPrompt(message.brief);
    }
  }
  return undefined;
}

function compactStickyPrompt(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157).trimEnd()}...` : singleLine;
}

function stickyPromptForWindow(messages: ConversationMessage[], rendered: ConversationLine[], windowStart: number, windowEnd: number): string | undefined {
  if (windowStart <= 0) {
    return undefined;
  }
  const bounds = renderedLineBoundsByMessage(rendered);
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

function renderedLineBoundsByMessage(lines: ConversationLine[]): Map<number, { first: number; last: number }> {
  const result = new Map<number, { first: number; last: number }>();
  lines.forEach((line, index) => {
    if (line.messageIndex === undefined) {
      return;
    }
    const existing = result.get(line.messageIndex);
    if (existing) {
      existing.last = index;
    } else {
      result.set(line.messageIndex, { first: index, last: index });
    }
  });
  return result;
}

function extractFullOutput(detail: string | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const marker = "\n\nFull Output\n";
  const markerIndex = detail.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const output = detail.slice(markerIndex + marker.length).trim();
  return output || undefined;
}

function conversationInlineText(role: ConversationMessage["role"], text: string): string {
  const label = conversationRoleLabel(role);
  return label ? `${label} ${text}` : text;
}

function renderConversationMarkdownLine(role: ConversationMessage["role"], line: MarkdownLine): string {
  if (role === "user") {
    return indentConversationLine(line);
  }
  return line.text;
}

function renderConversationEventLine(message: ConversationMessage, line: MarkdownLine, lineIndex: number): string {
  const prefix = lineIndex === 0 ? conversationEventPrefix(message) : "  ";
  if (line.kind === "blank") {
    return "";
  }
  return `${prefix}${line.text}`;
}

function isConversationMessageExpanded(
  message: ConversationMessage,
  index: number,
  options: ConversationRenderOptions
): boolean {
  return isFoldableConversationMessage(message) &&
    Boolean(options.expandedMessageKeys?.has(conversationMessageFoldKey(message, index)));
}

function isSelectedConversationMessage(index: number, options: ConversationRenderOptions): boolean {
  return options.selectedMessageIndex === index || options.searchMatchMessageIndex === index;
}

function markSelectedLines(lines: ConversationLine[], index: number, options: ConversationRenderOptions): ConversationLine[] {
  if (!isSelectedConversationMessage(index, options)) {
    return lines;
  }
  return lines.map((line) => ({ ...line, selected: true }));
}

function firstNonEmptyLine(value: string | undefined): string {
  return value?.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function conversationEventPrefix(message: ConversationMessage): string {
  return transcriptEventToken(message.kind, message.status).prefix;
}

function isUnseenCountableAssistantMessage(message: ConversationMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return message.kind === undefined || message.kind === "message";
}

function indentConversationLine(line: MarkdownLine): string {
  if (line.kind === "blank") {
    return "";
  }
  return `  ${line.text}`;
}

function wrapConversationLine(line: ConversationLine, columns: number | undefined): ConversationLine[] {
  const width = Math.max(12, Math.floor(columns ?? 100));
  const chunks = hardWrapConversationText(line.text, width, continuationPrefixForLine(line));
  return chunks.map((text, index) => ({
    ...line,
    key: index === 0 ? line.key : `${line.key}:wrap:${index}`,
    text
  }));
}

function continuationPrefixForLine(line: ConversationLine): string {
  if (line.kind === "blank" || line.kind === "label") {
    return "";
  }
  const leading = line.text.match(/^\s*/u)?.[0] ?? "";
  if (line.kind === "list") {
    return `${leading}  `;
  }
  if (line.kind === "paragraph" && leading.length === 0) {
    return "  ";
  }
  return leading;
}

function hardWrapConversationText(text: string, columns: number, continuationPrefix: string): string[] {
  if (text.length === 0) {
    return [""];
  }
  if (displayWidth(text) <= columns) {
    return [text];
  }

  const rows: string[] = [];
  let remaining = text;
  let prefix = "";
  while (remaining.length > 0) {
    const available = Math.max(8, columns - displayWidth(prefix));
    if (displayWidth(remaining) <= available) {
      rows.push(`${prefix}${remaining}`);
      break;
    }
    const breakAt = wrappingBreakIndex(remaining, available);
    const chunk = remaining.slice(0, breakAt).trimEnd();
    if (chunk) {
      rows.push(`${prefix}${chunk}`);
      remaining = remaining.slice(breakAt).trimStart();
    } else {
      const sliced = sliceByDisplayWidth(remaining, available);
      rows.push(`${prefix}${sliced.head}`);
      remaining = sliced.tail.trimStart();
    }
    prefix = continuationPrefix.length < columns - 4 ? continuationPrefix : "";
  }
  return rows;
}

function wrappingBreakIndex(value: string, available: number): number {
  let width = 0;
  let index = 0;
  let fallback = 0;
  for (const char of value) {
    const nextWidth = width + displayWidth(char);
    if (nextWidth > available) {
      break;
    }
    width = nextWidth;
    index += char.length;
    if (/\s/u.test(char) && width > Math.max(6, Math.floor(available * 0.45))) {
      fallback = index;
    }
  }
  return fallback;
}

function windowConversationLines(lines: ConversationLine[], limit: number, scrollOffset: number): { lines: ConversationLine[]; hiddenBelow: number; start: number; end: number } {
  if (lines.length <= limit) {
    return { lines, hiddenBelow: 0, start: 0, end: lines.length };
  }
  const normalizedOffset = normalizeConversationScrollOffset(lines.length, limit, scrollOffset);
  const end = lines.length - normalizedOffset;
  const start = Math.max(0, end - limit);
  const hiddenBelow = lines.length - end;
  return {
    lines: lines.slice(start, end),
    hiddenBelow,
    start,
    end
  };
}

function clampConversationBottomRows(rows: number, terminalRows: number): number {
  const maxBottomRows = Math.max(
    CONVERSATION_PROMPT_CHROME_ROWS,
    Math.min(
      Math.floor(Math.max(1, terminalRows) * 0.5),
      Math.max(CONVERSATION_PROMPT_CHROME_ROWS, terminalRows - CONVERSATION_MIN_TRANSCRIPT_ROWS)
    )
  );
  return Math.max(1, Math.min(Math.max(1, Math.floor(rows)), maxBottomRows));
}

export function detailOpenTargetForPane(input: {
  pane: string;
  actionCount: number;
  hasLatestDetail: boolean;
}): DetailOpenTarget {
  if (input.pane === "log" && input.actionCount > 0) {
    return "selected-action";
  }
  return input.hasLatestDetail ? "latest" : "none";
}

export function inlineInspectorTargetForPane(input: {
  pane: string;
  selectedAction: boolean;
  latestDetailSource: "none" | "ai" | "command" | "task" | "event";
  latestDetail: boolean;
}): InlineInspectorTarget {
  if (input.latestDetail && (input.latestDetailSource === "ai" || input.latestDetailSource === "task")) {
    return {
      enabled: true,
      source: input.latestDetailSource,
      title: detailTitleForSource(input.latestDetailSource, true)
    };
  }
  if (input.pane === "log" && input.selectedAction) {
    return {
      enabled: true,
      source: "event",
      title: "Trace Detail"
    };
  }
  return {
    enabled: false,
    source: "event",
    title: "Inspector"
  };
}

export function tuiScreenMode(input: {
  pane: string;
  columns: number;
  busy: boolean;
  hasApproval: boolean;
  hasPendingPlan: boolean;
}): TuiScreenMode {
  return {
    compactStatus: input.pane === "chat",
    showCurrentAction: input.busy || input.hasApproval || input.hasPendingPlan,
    showInspector: input.columns >= 128 && input.pane !== "chat" && !input.hasApproval && !input.hasPendingPlan,
    primarySurface: input.pane === "chat" ? "conversation" : input.pane === "log" ? "trace" : "operator"
  };
}

export function detailTitleForSource(
  source: "none" | "ai" | "command" | "task" | "event" | undefined,
  inline = false
): string {
  if (source === "command") {
    return inline ? "Latest Output" : "Command Output";
  }
  if (source === "task") {
    return "Task Detail";
  }
  if (source === "event") {
    return inline ? "Trace Detail" : "Event Detail";
  }
  if (source === "ai") {
    return "Assistant Detail";
  }
  return "Inspector";
}
