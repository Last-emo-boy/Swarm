import { renderMarkdownLines, type MarkdownLine } from "./markdown-rendering.js";
import { displayWidth, sliceByDisplayWidth } from "./display-width.js";
import { transcriptEventToken, type TuiColorRef, type TuiTone } from "./theme.js";
import { splitSearchHighlightText } from "./renderer/search-highlight.js";

export type ConversationMessage = {
  role: "user" | "assistant" | "system";
  brief: string;
  detail?: string;
  preview?: string;
  kind?: "message" | "logo" | "command" | "tool_use" | "tool_result" | "thinking" | "approval" | "progress";
  title?: string;
  status?: "running" | "pending" | "success" | "warning" | "error" | "info";
};

export type ConversationLineSpan = {
  text: string;
  color?: TuiColorRef;
  backgroundColor?: TuiColorRef;
  tone?: TuiTone;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
};

export type ConversationLine = {
  key: string;
  role: ConversationMessage["role"];
  messageIndex?: number;
  text: string;
  spans?: ConversationLineSpan[];
  kind: "label" | MarkdownLine["kind"] | "divider";
  firstPrefixText?: string;
  continuationPrefix?: string;
  bold?: boolean;
  dim?: boolean;
  selected?: boolean;
  tone?: TuiTone;
  backgroundColor?: TuiColorRef;
  underline?: boolean;
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
export type DetailOpenInputIntent = "explicit" | "focused" | "submit" | "none";
export type TuiDensity = "compact" | "default" | "comfortable";
export type TuiDensityPreference = TuiDensity | "auto";
export type TuiFocusOwner = "input" | "detail" | "action-log" | "footer" | "message" | "onboarding" | "approval";
export type TuiFocusTransitionReason =
  | "startup"
  | "empty-enter"
  | "submit"
  | "explicit-open-detail"
  | "focused-open-detail"
  | "close-detail"
  | "select-action"
  | "select-footer"
  | "select-message"
  | "debug-hydration"
  | "unknown";
export type TuiFocusTransitionDecision = {
  focusBefore: TuiFocusOwner;
  focusAfter: TuiFocusOwner;
  detailBefore: boolean;
  detailAfter: boolean;
  paneBefore: string;
  paneAfter: string;
  detailSource?: "none" | "ai" | "command" | "task" | "event";
  reason: TuiFocusTransitionReason;
  allowed: boolean;
  blockedReason?: string;
};
export type InlineInspectorTarget = {
  enabled: boolean;
  source: "ai" | "command" | "task" | "event";
  title: string;
};

export type TuiScreenMode = {
  density: TuiDensity;
  compactStatus: boolean;
  showCurrentAction: boolean;
  showInspector: boolean;
  primarySurface: "conversation" | "trace" | "operator";
};

export type ConversationRendererZoneName =
  | "viewport"
  | "scrollRegion"
  | "bottomChrome"
  | "completionOverlay"
  | "inspector";

export type ConversationDomNodeRole =
  | "root"
  | "conversation"
  | "scrollback"
  | "statusBar"
  | "composer"
  | "inspector"
  | "overlay"
  | "detailPane";

export type ConversationDomOverflow = "visible" | "hidden" | "scroll";

export type ConversationRendererZone = {
  name: ConversationRendererZoneName;
  debugName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rightExclusive: number;
  bottomExclusive: number;
};

export type ConversationDomNode = {
  id: string;
  role: ConversationDomNodeRole;
  debugName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rightExclusive: number;
  bottomExclusive: number;
  zIndex: number;
  focusable: boolean;
  overflow: ConversationDomOverflow;
  parentId?: string;
};

export type ConversationRendererContract = {
  rows: number;
  columns: number;
  activePaneDebugName: string;
  focusOwnerId: string;
  zones: {
    viewport: ConversationRendererZone;
    scrollRegion: ConversationRendererZone;
    bottomChrome: ConversationRendererZone;
    completionOverlay?: ConversationRendererZone;
    inspector?: ConversationRendererZone;
  };
  nodes: {
    root: ConversationDomNode;
    conversation: ConversationDomNode;
    scrollback: ConversationDomNode;
    statusBar?: ConversationDomNode;
    composer: ConversationDomNode;
    inspector?: ConversationDomNode;
    overlay?: ConversationDomNode;
    detailPane?: ConversationDomNode;
  };
};

export type ConversationDomLayoutIssue = {
  kind: "overlap" | "containment" | "focus";
  nodeId: string;
  otherNodeId?: string;
  message: string;
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

export function conversationRendererContract(input: {
  rows: number;
  columns?: number;
  bottomRows: number;
  completionOverlayRows?: number;
  pane?: string;
  showInspector?: boolean;
  approval?: boolean;
  pendingPlan?: boolean;
}): ConversationRendererContract {
  const rows = Math.max(1, Math.floor(input.rows));
  const columns = Math.max(1, Math.floor(input.columns ?? 80));
  const maxBottomRows = Math.max(0, rows - 1);
  const bottomRows = maxBottomRows <= 0
    ? 0
    : Math.max(1, Math.min(Math.floor(input.bottomRows), maxBottomRows));
  const scrollableRows = Math.max(1, rows - bottomRows);
  const viewport = rendererZone("viewport", 0, 0, columns, rows);
  const scrollRegion = rendererZone("scrollRegion", 0, 0, columns, scrollableRows);
  const bottomChrome = rendererZone("bottomChrome", 0, scrollRegion.bottomExclusive, columns, bottomRows);
  const completionRows = input.completionOverlayRows === undefined
    ? 0
    : Math.max(1, Math.min(Math.floor(input.completionOverlayRows), scrollRegion.height));
  const completionOverlay = completionRows > 0
    ? rendererZone("completionOverlay", 0, scrollRegion.bottomExclusive - completionRows, columns, completionRows)
    : undefined;
  const inspector = shouldOwnInlineInspector({
    pane: input.pane ?? "chat",
    columns,
    showInspector: input.showInspector,
    approval: input.approval,
    pendingPlan: input.pendingPlan
  })
    ? rendererZone("inspector", inspectorLeft(columns), scrollRegion.top, inspectorWidth(columns), scrollRegion.height)
    : undefined;
  const nodes = conversationDomNodes({
    columns,
    rows,
    scrollRegion,
    bottomChrome,
    completionOverlay,
    inspector
  });

  return {
    rows,
    columns,
    activePaneDebugName: conversationPaneDebugName(input.pane ?? "chat"),
    focusOwnerId: "composer",
    zones: {
      viewport,
      scrollRegion,
      bottomChrome,
      ...(completionOverlay ? { completionOverlay } : {}),
      ...(inspector ? { inspector } : {})
    },
    nodes
  };
}

export function conversationPaneDebugName(pane: string | undefined): string {
  const normalized = (pane ?? "chat")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `pane:${normalized || "chat"}`;
}

export function validateConversationDomLayout(
  contract: ConversationRendererContract
): ConversationDomLayoutIssue[] {
  const issues: ConversationDomLayoutIssue[] = [];
  const nodes = conversationDomNodeList(contract);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (!parent || !domNodeContains(parent, node)) {
        issues.push({
          kind: "containment",
          nodeId: node.id,
          otherNodeId: node.parentId,
          message: `${node.id} must fit inside ${node.parentId}`
        });
      }
    }
  }

  const focusOwner = byId.get(contract.focusOwnerId);
  if (!focusOwner || !focusOwner.focusable) {
    issues.push({
      kind: "focus",
      nodeId: contract.focusOwnerId,
      message: `${contract.focusOwnerId} must be a focusable renderer node`
    });
  }

  for (const node of nodes) {
    if (node.id === "scrollback" && rectsOverlap(node, contract.nodes.composer)) {
      issues.push({
        kind: "overlap",
        nodeId: node.id,
        otherNodeId: "composer",
        message: "scrollback must not overlap composer"
      });
    }
    if (node.role === "overlay" && rectsOverlap(node, contract.nodes.composer)) {
      issues.push({
        kind: "overlap",
        nodeId: node.id,
        otherNodeId: "composer",
        message: "overlay must not cover composer"
      });
    }
    if (node.role === "inspector" && node.focusable) {
      issues.push({
        kind: "focus",
        nodeId: node.id,
        message: "inline inspector must not own prompt focus"
      });
    }
  }

  return issues;
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
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
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
    const inline = conversationMessageRowLine(message.role, markdownLines[0], 0);
    return [{
      key: `${baseKey}:0`,
      role: message.role,
      messageIndex: index,
      text: inline.text,
      spans: inline.spans,
      firstPrefixText: inline.firstPrefixText,
      continuationPrefix: inline.continuationPrefix,
      kind: "paragraph",
      bold: false,
      backgroundColor: roleBackground(message.role, isSelectedConversationMessage(index, options)),
      selected: isSelectedConversationMessage(index, options)
    }];
  }

  return markSelectedLines([
    ...markdownLines.map((line, lineIndex) => {
      const rendered = conversationMessageRowLine(message.role, line, lineIndex);
      return {
        key: `${baseKey}:${lineIndex}`,
        role: message.role,
        messageIndex: index,
        text: rendered.text,
        spans: rendered.spans,
        firstPrefixText: rendered.firstPrefixText,
        continuationPrefix: rendered.continuationPrefix,
        kind: line.kind,
        bold: line.bold,
        dim: line.dim,
        backgroundColor: roleBackground(message.role, isSelectedConversationMessage(index, options))
      };
    })
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
    ...renderConversationEventLine(message, line, lineIndex),
    kind: line.kind,
    bold: line.bold,
    dim: line.dim ?? (message.status === "running" || message.kind === "thinking"),
    tone: transcriptEventToken(message.kind, message.status).tone,
    backgroundColor: isSelectedConversationMessage(index, options) ? "surface.selection" : undefined
  }));
}

export type ConversationRenderOptions = {
  unseenStartIndex?: number;
  newMessageCount?: number;
  expandedMessageKeys?: ReadonlySet<string>;
  selectedMessageIndex?: number;
  searchMatchMessageIndex?: number;
  searchMatchQuery?: string;
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

const TRANSCRIPT_LABEL_WIDTH = 10;

type TranscriptRowChrome = {
  marker: string;
  label: string;
  markerColor: TuiColorRef;
  labelColor: TuiColorRef;
  bodyColor: TuiColorRef;
};

function transcriptPrefix(marker: string, label: string): string {
  return `${marker} ${label.padEnd(TRANSCRIPT_LABEL_WIDTH)} `;
}

function transcriptContinuationPrefix(): string {
  return " ".repeat(2 + TRANSCRIPT_LABEL_WIDTH + 1);
}

function conversationMessageRowLine(role: ConversationMessage["role"], line: MarkdownLine, lineIndex: number): {
  text: string;
  spans?: ConversationLineSpan[];
  firstPrefixText?: string;
  continuationPrefix?: string;
} {
  if (line.kind === "blank") {
    return { text: "", continuationPrefix: "" };
  }
  const chrome = conversationRoleChrome(role);
  const body = line.text;
  const backgroundColor = roleBackground(role, false);
  const prefix = lineIndex === 0
    ? transcriptPrefix(chrome.marker, chrome.label)
    : transcriptContinuationPrefix();
  const rendered = `${prefix}${body}`;
  return {
    text: rendered,
    firstPrefixText: prefix,
    continuationPrefix: transcriptContinuationPrefix(),
    spans: [
      {
        text: lineIndex === 0 ? `${chrome.marker} ` : prefix,
        color: lineIndex === 0 ? chrome.markerColor : "text.muted",
        backgroundColor,
        bold: lineIndex === 0,
        dim: lineIndex !== 0
      },
      ...(lineIndex === 0 ? [{
        text: `${chrome.label.padEnd(TRANSCRIPT_LABEL_WIDTH)} `,
        color: chrome.labelColor,
        backgroundColor,
        bold: true
      } satisfies ConversationLineSpan] : []),
      {
        text: body,
        color: markdownBodyColor(role, line, chrome.bodyColor),
        backgroundColor,
        dim: line.dim
      }
    ]
  };
}

function conversationRoleChrome(role: ConversationMessage["role"]): TranscriptRowChrome {
  if (role === "user") {
    return {
      marker: "❯",
      label: "user",
      markerColor: "role.user",
      labelColor: "role.user",
      bodyColor: "text.primary"
    };
  }
  if (role === "assistant") {
    return {
      marker: "·",
      label: "assistant",
      markerColor: "text.muted",
      labelColor: "text.muted",
      bodyColor: "role.assistant"
    };
  }
  return {
    marker: "·",
    label: "system",
    markerColor: "text.muted",
    labelColor: "text.muted",
    bodyColor: "text.primary"
  };
}

function markdownBodyColor(role: ConversationMessage["role"], line: MarkdownLine, defaultColor: TuiColorRef): TuiColorRef {
  if (line.kind === "heading") {
    return "brand.focus";
  }
  if (line.kind === "code" || line.kind === "quote" || line.kind === "divider") {
    return "text.muted";
  }
  if (line.kind === "table" && line.dim) {
    return "text.muted";
  }
  if (role === "assistant") {
    return "role.assistant";
  }
  return defaultColor;
}

function renderConversationEventLine(message: ConversationMessage, line: MarkdownLine, lineIndex: number): { text: string; spans?: ConversationLineSpan[]; firstPrefixText?: string; continuationPrefix?: string } {
  if (line.kind === "blank") {
    return { text: "" };
  }
  const chrome = conversationEventChrome(message);
  const prefix = lineIndex === 0
    ? transcriptPrefix(chrome.marker, chrome.label)
    : transcriptContinuationPrefix();
  const rendered = `${prefix}${line.text}`;
  return {
    text: rendered,
    firstPrefixText: prefix,
    continuationPrefix: transcriptContinuationPrefix(),
    spans: [
      {
        text: lineIndex === 0 ? `${chrome.marker} ` : prefix,
        color: lineIndex === 0 ? chrome.markerColor : "text.muted",
        bold: lineIndex === 0,
        dim: lineIndex !== 0
      },
      ...(lineIndex === 0 ? [{
        text: `${chrome.label.padEnd(TRANSCRIPT_LABEL_WIDTH)} `,
        color: chrome.labelColor,
        bold: true
      } satisfies ConversationLineSpan] : []),
      {
        text: line.text,
        color: markdownBodyColor(message.role, line, chrome.bodyColor),
        dim: message.kind === "thinking" || line.dim
      }
    ]
  };
}

function conversationEventChrome(message: ConversationMessage): TranscriptRowChrome {
  const token = transcriptEventToken(message.kind, message.status);
  const runningMarker = message.status === "running" ? "●" : token.prefix.trim().slice(0, 1);
  switch (message.kind) {
    case "command":
      return {
        marker: "❯",
        label: "cmd",
        markerColor: "role.user",
        labelColor: "role.user",
        bodyColor: "text.primary"
      };
    case "tool_use":
      return {
        marker: message.status === "running" ? "●" : "⏵",
        label: "tool",
        markerColor: message.status === "running" ? "status.running" : token.tone,
        labelColor: token.tone,
        bodyColor: "text.primary"
      };
    case "tool_result":
      return {
        marker: runningMarker || "⎿",
        label: token.label,
        markerColor: token.tone,
        labelColor: token.tone,
        bodyColor: "text.primary"
      };
    case "thinking":
      return {
        marker: message.status === "running" ? "·" : "∴",
        label: "think",
        markerColor: message.status === "running" ? "status.running" : "text.muted",
        labelColor: "text.muted",
        bodyColor: "text.muted"
      };
    case "approval":
      return {
        marker: "?",
        label: "approval",
        markerColor: "status.pending",
        labelColor: "status.pending",
        bodyColor: "text.primary"
      };
    case "progress":
      return {
        marker: "·",
        label: "progress",
        markerColor: token.tone,
        labelColor: token.tone,
        bodyColor: "text.primary"
      };
    default:
      return conversationRoleChrome(message.role);
  }
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

export function applyConversationDynamicLineState(
  lines: ConversationLine[],
  index: number,
  options: ConversationRenderOptions
): ConversationLine[] {
  return markSelectedLines(lines, index, options);
}

function markSelectedLines(lines: ConversationLine[], index: number, options: ConversationRenderOptions): ConversationLine[] {
  const selected = isSelectedConversationMessage(index, options);
  const searchHighlighted = options.searchMatchMessageIndex === index && Boolean(options.searchMatchQuery?.trim());
  if (!selected && !searchHighlighted) {
    return lines;
  }
  return lines.map((line) => {
    const selectedLine = selected ? { ...line, selected: true, backgroundColor: "surface.selection" } : line;
    return searchHighlighted ? highlightConversationLine(selectedLine, options.searchMatchQuery) : selectedLine;
  });
}

function roleBackground(role: ConversationMessage["role"], selected: boolean): TuiColorRef | undefined {
  if (selected) {
    return "surface.selection";
  }
  return role === "user" ? "surface.user" : undefined;
}

function highlightConversationLine(line: ConversationLine, query: string | undefined): ConversationLine {
  if (!query?.trim() || !line.text.trim()) {
    return line;
  }
  const baseSpans = line.spans?.length
    ? line.spans
    : [{
      text: line.text,
      tone: line.tone,
      backgroundColor: line.backgroundColor,
      bold: line.bold,
      dim: line.dim
    } satisfies ConversationLineSpan];
  let matched = false;
  const spans = baseSpans.flatMap((span) => splitSearchHighlightText(span.text, query).map((segment) => {
    if (!segment.match) {
      return span.text === segment.text ? span : { ...span, text: segment.text };
    }
    matched = true;
    return {
      ...span,
      text: segment.text,
      backgroundColor: "surface.searchMatch" as const,
      underline: true,
      dim: false
    };
  }));
  return matched ? { ...line, spans } : line;
}

function firstNonEmptyLine(value: string | undefined): string {
  return value?.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function isUnseenCountableAssistantMessage(message: ConversationMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return message.kind === undefined || message.kind === "message";
}

function wrapConversationLine(line: ConversationLine, columns: number | undefined): ConversationLine[] {
  const width = Math.max(12, Math.floor(columns ?? 100));
  const continuationPrefix = continuationPrefixForLine(line);
  const chunks = line.firstPrefixText && line.text.startsWith(line.firstPrefixText)
    ? hardWrapPrefixedConversationText(line.text, line.firstPrefixText, continuationPrefix, width)
    : hardWrapConversationText(line.text, width, continuationPrefix);
  let offset = 0;
  return chunks.map((text, index) => {
    const chunkOffset = line.text.indexOf(text.trimStart(), offset);
    const start = chunkOffset >= 0 ? chunkOffset : offset;
    offset = start + text.length;
    return {
      ...line,
      key: index === 0 ? line.key : `${line.key}:wrap:${index}`,
      text,
      spans: line.spans ? sliceLineSpans(line.spans, line.text, start, text) : undefined
    };
  });
}

function sliceLineSpans(spans: ConversationLineSpan[], fullText: string, start: number, chunkText: string): ConversationLineSpan[] | undefined {
  const chunkLength = chunkText.length;
  if (chunkLength <= 0) {
    return undefined;
  }
  const prefix = chunkText.match(/^\s*/u)?.[0] ?? "";
  const targetStart = Math.max(0, Math.min(fullText.length, start));
  const targetEnd = Math.min(fullText.length, targetStart + chunkLength - prefix.length);
  const result: ConversationLineSpan[] = [];
  let cursor = 0;
  if (prefix) {
    result.push({ text: prefix, tone: "muted" });
  }
  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    cursor = spanEnd;
    if (spanEnd <= targetStart || spanStart >= targetEnd) {
      continue;
    }
    const sliceStart = Math.max(targetStart, spanStart) - spanStart;
    const sliceEnd = Math.min(targetEnd, spanEnd) - spanStart;
    const nextText = span.text.slice(sliceStart, sliceEnd);
    if (nextText) {
      result.push({ ...span, text: nextText });
    }
  }
  return result.length > 0 ? result : undefined;
}

function continuationPrefixForLine(line: ConversationLine): string {
  if (line.continuationPrefix !== undefined) {
    return line.continuationPrefix;
  }
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

function hardWrapPrefixedConversationText(text: string, firstPrefix: string, continuationPrefix: string, columns: number): string[] {
  if (displayWidth(text) <= columns) {
    return [text];
  }
  const body = text.slice(firstPrefix.length);
  if (!body) {
    return [text];
  }
  const rows: string[] = [];
  let remaining = body;
  let prefix = firstPrefix;
  while (remaining.length > 0) {
    const available = Math.max(1, columns - displayWidth(prefix));
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
    const nextPrefixWidth = displayWidth(continuationPrefix);
    prefix = nextPrefixWidth < columns - 1 ? continuationPrefix : "";
  }
  return rows;
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
    const nextPrefixWidth = displayWidth(continuationPrefix);
    prefix = nextPrefixWidth < columns - 1 ? continuationPrefix : "";
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

function rendererZone(
  name: ConversationRendererZoneName,
  left: number,
  top: number,
  width: number,
  height: number
): ConversationRendererZone {
  const normalizedLeft = Math.max(0, Math.floor(left));
  const normalizedTop = Math.max(0, Math.floor(top));
  const normalizedWidth = Math.max(0, Math.floor(width));
  const normalizedHeight = Math.max(0, Math.floor(height));
  return {
    name,
    debugName: `zone:${name}`,
    left: normalizedLeft,
    top: normalizedTop,
    width: normalizedWidth,
    height: normalizedHeight,
    rightExclusive: normalizedLeft + normalizedWidth,
    bottomExclusive: normalizedTop + normalizedHeight
  };
}

function conversationDomNodes(input: {
  columns: number;
  rows: number;
  scrollRegion: ConversationRendererZone;
  bottomChrome: ConversationRendererZone;
  completionOverlay?: ConversationRendererZone;
  inspector?: ConversationRendererZone;
}): ConversationRendererContract["nodes"] {
  const root = conversationDomNode({
    id: "root",
    role: "root",
    left: 0,
    top: 0,
    width: input.columns,
    height: input.rows,
    zIndex: 0,
    overflow: "hidden"
  });
  const conversationWidth = input.inspector
    ? Math.max(1, input.inspector.left - 1)
    : input.columns;
  const conversation = conversationDomNode({
    id: "conversation",
    role: "conversation",
    left: 0,
    top: input.scrollRegion.top,
    width: conversationWidth,
    height: input.scrollRegion.height,
    zIndex: 1,
    overflow: "hidden",
    parentId: "root"
  });
  const scrollback = conversationDomNode({
    id: "scrollback",
    role: "scrollback",
    left: conversation.left,
    top: conversation.top,
    width: conversation.width,
    height: conversation.height,
    zIndex: 1,
    overflow: "scroll",
    parentId: "conversation"
  });
  const statusBar = input.bottomChrome.height > 1
    ? conversationDomNode({
      id: "statusBar",
      role: "statusBar",
      left: 0,
      top: input.bottomChrome.top,
      width: input.columns,
      height: Math.max(0, input.bottomChrome.height - 1),
      zIndex: 2,
      overflow: "hidden",
      parentId: "root"
    })
    : undefined;
  const composer = conversationDomNode({
    id: "composer",
    role: "composer",
    left: 0,
    top: Math.max(input.bottomChrome.top, input.bottomChrome.bottomExclusive - 1),
    width: input.columns,
    height: input.bottomChrome.height > 0 ? 1 : 0,
    zIndex: 3,
    focusable: true,
    overflow: "hidden",
    parentId: "root"
  });
  const inspector = input.inspector
    ? conversationDomNode({
      id: "inspector",
      role: "inspector",
      left: input.inspector.left,
      top: input.inspector.top,
      width: input.inspector.width,
      height: input.inspector.height,
      zIndex: 2,
      overflow: "hidden",
      parentId: "root"
    })
    : undefined;
  const overlay = input.completionOverlay
    ? conversationDomNode({
      id: "overlay",
      role: "overlay",
      left: input.completionOverlay.left,
      top: input.completionOverlay.top,
      width: conversation.width,
      height: input.completionOverlay.height,
      zIndex: 4,
      overflow: "hidden",
      parentId: "root"
    })
    : undefined;

  return {
    root,
    conversation,
    scrollback,
    ...(statusBar ? { statusBar } : {}),
    composer,
    ...(inspector ? { inspector } : {}),
    ...(overlay ? { overlay } : {})
  };
}

function conversationDomNode(input: {
  id: string;
  role: ConversationDomNodeRole;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  focusable?: boolean;
  overflow: ConversationDomOverflow;
  parentId?: string;
}): ConversationDomNode {
  const left = Math.max(0, Math.floor(input.left));
  const top = Math.max(0, Math.floor(input.top));
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  return {
    id: input.id,
    role: input.role,
    debugName: `node:${input.id}`,
    left,
    top,
    width,
    height,
    rightExclusive: left + width,
    bottomExclusive: top + height,
    zIndex: input.zIndex,
    focusable: Boolean(input.focusable),
    overflow: input.overflow,
    ...(input.parentId ? { parentId: input.parentId } : {})
  };
}

function conversationDomNodeList(contract: ConversationRendererContract): ConversationDomNode[] {
  return [
    contract.nodes.root,
    contract.nodes.conversation,
    contract.nodes.scrollback,
    contract.nodes.statusBar,
    contract.nodes.composer,
    contract.nodes.inspector,
    contract.nodes.overlay,
    contract.nodes.detailPane
  ].filter((node): node is ConversationDomNode => node !== undefined);
}

function domNodeContains(parent: ConversationDomNode, child: ConversationDomNode): boolean {
  return child.left >= parent.left &&
    child.top >= parent.top &&
    child.rightExclusive <= parent.rightExclusive &&
    child.bottomExclusive <= parent.bottomExclusive;
}

function rectsOverlap(
  first: Pick<ConversationDomNode, "left" | "top" | "rightExclusive" | "bottomExclusive">,
  second: Pick<ConversationDomNode, "left" | "top" | "rightExclusive" | "bottomExclusive">
): boolean {
  return first.left < second.rightExclusive &&
    first.rightExclusive > second.left &&
    first.top < second.bottomExclusive &&
    first.bottomExclusive > second.top;
}

function inspectorWidth(columns: number): number {
  if (columns < 128) {
    return 0;
  }
  return Math.min(60, Math.max(40, Math.floor(columns * 0.34)));
}

function inspectorLeft(columns: number): number {
  const width = inspectorWidth(columns);
  return width > 0 ? Math.max(0, columns - width) : columns;
}

function shouldOwnInlineInspector(input: {
  pane: string;
  columns: number;
  showInspector?: boolean;
  approval?: boolean;
  pendingPlan?: boolean;
}): boolean {
  if (input.showInspector !== undefined) {
    return input.showInspector;
  }
  return tuiScreenMode({
    pane: input.pane,
    columns: input.columns,
    busy: false,
    hasApproval: Boolean(input.approval),
    hasPendingPlan: Boolean(input.pendingPlan)
  }).showInspector;
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

export function detailOpenInputIntent(input: {
  character?: string;
  key: { ctrl?: boolean; return?: boolean };
}): DetailOpenInputIntent {
  const normalized = normalizeDetailOpenCharacter(input.character);
  if (input.key.ctrl && normalized === "o") {
    return "explicit";
  }
  if (!input.key.ctrl && normalized === "o") {
    return "focused";
  }
  if (input.key.return) {
    return "submit";
  }
  return "none";
}

export function shouldOpenDetailFromInput(input: {
  intent: DetailOpenInputIntent;
  hasFocusedTarget: boolean;
}): boolean {
  return input.intent === "explicit" || (input.intent === "focused" && input.hasFocusedTarget);
}

export function tuiFocusTransitionForInput(input: {
  character?: string;
  key: { ctrl?: boolean; return?: boolean; escape?: boolean };
  focusBefore?: TuiFocusOwner;
  detailOpen: boolean;
  pane: string;
  latestDetailSource?: "none" | "ai" | "command" | "task" | "event";
  hasFocusedTarget?: boolean;
}): TuiFocusTransitionDecision {
  const focusBefore = input.focusBefore ?? (input.detailOpen ? "detail" : "input");
  const intent = detailOpenInputIntent({ character: input.character, key: input.key });
  const normalized = normalizeDetailOpenCharacter(input.character);
  const emptyEnter = intent === "submit" && !input.character;
  if (input.detailOpen && (input.key.escape || intent === "explicit" || (!input.key.ctrl && normalized === "q") || (input.key.ctrl && normalized === "c"))) {
    return {
      focusBefore,
      focusAfter: "input",
      detailBefore: true,
      detailAfter: false,
      paneBefore: input.pane,
      paneAfter: input.pane,
      detailSource: input.latestDetailSource,
      reason: "close-detail",
      allowed: true
    };
  }
  if (emptyEnter) {
    return {
      focusBefore,
      focusAfter: "input",
      detailBefore: input.detailOpen,
      detailAfter: false,
      paneBefore: input.pane,
      paneAfter: input.pane,
      detailSource: input.latestDetailSource,
      reason: "empty-enter",
      allowed: false,
      blockedReason: "empty Enter submits input only; it must not open Command Output or change panes"
    };
  }
  if (shouldOpenDetailFromInput({ intent, hasFocusedTarget: Boolean(input.hasFocusedTarget) })) {
    return {
      focusBefore,
      focusAfter: "detail",
      detailBefore: input.detailOpen,
      detailAfter: true,
      paneBefore: input.pane,
      paneAfter: input.pane,
      detailSource: input.latestDetailSource,
      reason: intent === "explicit" ? "explicit-open-detail" : "focused-open-detail",
      allowed: true
    };
  }
  return {
    focusBefore,
    focusAfter: focusBefore === "detail" ? "input" : focusBefore,
    detailBefore: input.detailOpen,
    detailAfter: input.detailOpen,
    paneBefore: input.pane,
    paneAfter: input.pane,
    detailSource: input.latestDetailSource,
    reason: intent === "submit" ? "submit" : "unknown",
    allowed: true
  };
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
  density?: TuiDensityPreference;
}): TuiScreenMode {
  const density = resolveTuiDensity({
    density: input.density,
    pane: input.pane,
    columns: input.columns
  });
  return {
    density,
    compactStatus: density === "compact",
    showCurrentAction: input.busy || input.hasApproval || input.hasPendingPlan,
    showInspector: density !== "compact" && input.pane !== "chat" && !input.hasApproval && !input.hasPendingPlan && (
      density === "comfortable" ? input.columns >= 120 : input.columns >= 128
    ),
    primarySurface: input.pane === "chat" ? "conversation" : input.pane === "log" ? "trace" : "operator"
  };
}

export function resolveTuiDensity(input: {
  density?: TuiDensityPreference;
  pane: string;
  columns: number;
}): TuiDensity {
  const preference = input.density ?? "auto";
  if (preference !== "auto") {
    return preference;
  }
  if (input.pane === "chat") {
    return "compact";
  }
  if (input.columns < 112) {
    return "compact";
  }
  if (input.columns < 150) {
    return "default";
  }
  return "comfortable";
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

function normalizeDetailOpenCharacter(character: string | undefined): string {
  if (!character) {
    return "";
  }
  if (character === "\x0f") {
    return "o";
  }
  return character.toLowerCase();
}
