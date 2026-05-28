import {
  conversationBottomRows,
  conversationPromptRows,
  conversationRendererContract,
  detailOpenTargetForPane,
  fullscreenConversationRows,
  nextConversationScrollOffset,
  tuiFocusTransitionForInput,
  validateConversationDomLayout,
  type ConversationDomLayoutIssue,
  type ConversationMessage,
  type TuiFocusOwner,
  type TuiFocusTransitionDecision
} from "./conversation-layout.js";
import {
  buildVirtualConversationLayout,
  createConversationRenderCache,
  type ConversationRenderCache,
  type ConversationRenderCacheStats
} from "./components/VirtualConversationList.js";
import {
  createMessageCursorState,
  messageCursorReducer,
  selectedConversationMessage,
  type MessageCursorState
} from "./message-folding.js";
import { parseSlashCommandLine } from "./slash-commands.js";
import {
  collaborationShortcutActionForInput,
  type CollaborationOverlayTarget
} from "./collaboration-cockpit.js";
import {
  buildTranscriptSearchIndex,
  closeTranscriptSearch,
  createTranscriptSearchState,
  currentTranscriptSearchMatch,
  stepTranscriptSearch,
  transcriptSearchSummary,
  updateTranscriptSearch,
  type TranscriptSearchState
} from "./transcript-search.js";

export type TuiReplayDetailSource = "none" | "ai" | "command" | "task" | "event";

export type TuiReplayEvent =
  | { type: "key"; label?: string; character?: string; key: { ctrl?: boolean; return?: boolean; escape?: boolean }; hasFocusedTarget?: boolean }
  | { type: "collaboration-key"; label?: string; character?: string; key: { ctrl?: boolean; return?: boolean; escape?: boolean }; enabled?: boolean; inputIsEmpty?: boolean }
  | { type: "slash"; commandLine: string; pane?: string; detailSource?: TuiReplayDetailSource }
  | { type: "select-action"; index: number; actionCount?: number; pane?: string; detailSource?: TuiReplayDetailSource }
  | { type: "open-detail"; via?: "ctrl+o" | "focused"; hasFocusedTarget?: boolean }
  | { type: "close-detail"; via?: "escape" | "ctrl+o" | "q" }
  | { type: "search"; query: string; delta?: number; close?: boolean }
  | { type: "fold"; index?: number; action?: "toggle" | "open" }
  | { type: "scroll"; delta: number }
  | { type: "layout"; rows?: number; columns?: number; pane?: string }
  | { type: "append-message"; message: ConversationMessage };

export type TuiReplayScenario = {
  name: string;
  messages: ConversationMessage[];
  events: TuiReplayEvent[];
  rows?: number;
  columns?: number;
  pane?: string;
  latestDetailSource?: TuiReplayDetailSource;
  detailOpen?: boolean;
  actionCount?: number;
  route?: string;
  sessionId?: string;
  performanceBudget?: TuiReplayPerformanceBudget;
};

export type TuiReplayPerformanceBudget = {
  maxMountedMessages?: number;
  maxVisibleMessages?: number;
};

export type TuiReplayTraceEntry = {
  step: number;
  event: string;
  focus: TuiFocusOwner;
  detailOpen: boolean;
  detailSource: TuiReplayDetailSource;
  pane: string;
  selectedRow?: number;
  selectedActionRow?: number;
  collaborationOverlay?: CollaborationOverlayTarget;
  search?: string;
  currentSearchMessageIndex?: number;
  scrollOffset: number;
  totalRows: number;
  visibleMessageCount: number;
  mountedMessageCount: number;
  layoutIssues: string[];
  cacheStats: ConversationRenderCacheStats;
  transition?: TuiFocusTransitionDecision;
};

export type TuiReplayFailure = {
  kind: "focus" | "detail" | "layout" | "search" | "slash" | "performance" | "fold";
  message: string;
  lastTrace?: TuiReplayTraceEntry;
};

export type TuiReplayFinalState = {
  focus: TuiFocusOwner;
  detailOpen: boolean;
  detailSource: TuiReplayDetailSource;
  pane: string;
  selectedRow?: number;
  selectedActionRow?: number;
  collaborationOverlay?: CollaborationOverlayTarget;
  scrollOffset: number;
};

export type TuiReplayResult = {
  name: string;
  status: "pass" | "fail";
  trace: TuiReplayTraceEntry[];
  failures: TuiReplayFailure[];
  finalState: TuiReplayFinalState;
  maxMountedMessageCount: number;
  maxVisibleMessageCount: number;
  route?: string;
  sessionId?: string;
};

export type TuiReplaySuiteResult = {
  status: "pass" | "fail";
  scenarios: TuiReplayResult[];
  failureCount: number;
  traceCount: number;
};

type MutableTuiReplayState = {
  messages: ConversationMessage[];
  rows: number;
  columns: number;
  pane: string;
  latestDetailSource: TuiReplayDetailSource;
  detailOpen: boolean;
  focus: TuiFocusOwner;
  selectedRow?: number;
  selectedActionRow?: number;
  scrollOffset: number;
  search: TranscriptSearchState;
  collaborationOverlay?: CollaborationOverlayTarget;
  cursor: MessageCursorState;
  actionCount: number;
  cache: ConversationRenderCache;
  route?: string;
  sessionId?: string;
  lastTransition?: TuiFocusTransitionDecision;
};

export function runTuiInteractionReplay(scenario: TuiReplayScenario): TuiReplayResult {
  const state: MutableTuiReplayState = {
    messages: [...scenario.messages],
    rows: scenario.rows ?? 24,
    columns: scenario.columns ?? 96,
    pane: scenario.pane ?? "chat",
    latestDetailSource: scenario.latestDetailSource ?? "none",
    detailOpen: scenario.detailOpen ?? false,
    focus: scenario.detailOpen ? "detail" : "input",
    scrollOffset: 0,
    search: createTranscriptSearchState(),
    cursor: createMessageCursorState(),
    actionCount: scenario.actionCount ?? 0,
    cache: createConversationRenderCache(),
    route: scenario.route,
    sessionId: scenario.sessionId
  };
  const trace: TuiReplayTraceEntry[] = [];
  const failures: TuiReplayFailure[] = [];

  scenario.events.forEach((event, eventIndex) => {
    state.lastTransition = undefined;
    failures.push(...applyTuiReplayEvent(state, event));
    const entry = buildTuiReplayTraceEntry(state, eventIndex + 1, event);
    trace.push(entry);
    failures.push(...validateTuiReplayStep(state, event, entry, scenario.performanceBudget));
  });

  return {
    name: scenario.name,
    status: failures.length ? "fail" : "pass",
    trace,
    failures,
    finalState: {
      focus: state.focus,
      detailOpen: state.detailOpen,
      detailSource: state.latestDetailSource,
      pane: state.pane,
      selectedRow: state.selectedRow,
      selectedActionRow: state.selectedActionRow,
      collaborationOverlay: state.collaborationOverlay,
      scrollOffset: state.scrollOffset
    },
    maxMountedMessageCount: Math.max(0, ...trace.map((entry) => entry.mountedMessageCount)),
    maxVisibleMessageCount: Math.max(0, ...trace.map((entry) => entry.visibleMessageCount)),
    route: state.route,
    sessionId: state.sessionId
  };
}

export function runDefaultTuiReplaySuite(): TuiReplaySuiteResult {
  const scenarios = defaultTuiReplayScenarios();
  const results = scenarios.map((scenario) => runTuiInteractionReplay(scenario));
  const failureCount = results.reduce((count, result) => count + result.failures.length, 0);
  return {
    status: failureCount ? "fail" : "pass",
    scenarios: results,
    failureCount,
    traceCount: results.reduce((count, result) => count + result.trace.length, 0)
  };
}

export function formatTuiReplaySuiteReport(suite: TuiReplaySuiteResult): string[] {
  const lines = [
    "TUI Replay",
    `status=${suite.status}`,
    `scenarios=${suite.scenarios.length}`,
    `traces=${suite.traceCount}`,
    `failures=${suite.failureCount}`
  ];
  for (const scenario of suite.scenarios) {
    lines.push(
      `- ${scenario.name}: ${scenario.status} steps=${scenario.trace.length} final_focus=${scenario.finalState.focus} detail=${scenario.finalState.detailOpen} source=${scenario.finalState.detailSource} pane=${scenario.finalState.pane} selected=${scenario.finalState.selectedRow ?? "-"} selected_action=${scenario.finalState.selectedActionRow ?? "-"} mounted_max=${scenario.maxMountedMessageCount}`
    );
    for (const failure of scenario.failures) {
      const last = failure.lastTrace;
      lines.push(
        `  failure kind=${failure.kind} message=${failure.message} last_focus=${last?.focus ?? "-"} last_detail=${last?.detailOpen ?? "-"} last_source=${last?.detailSource ?? "-"} last_pane=${last?.pane ?? "-"} last_selected=${last?.selectedRow ?? last?.selectedActionRow ?? "-"}`
      );
    }
  }
  return lines;
}

export function defaultTuiReplayScenarios(): TuiReplayScenario[] {
  return [
    {
      name: "startup-enter-command-output-guard",
      rows: 24,
      columns: 96,
      pane: "chat",
      latestDetailSource: "command",
      route: "coding_loop",
      sessionId: "-",
      messages: [
        { role: "system", brief: "Swarm chat ready." },
        {
          role: "system",
          kind: "tool_result",
          status: "success",
          brief: "3 recent tool outputs. Ctrl+O for details.",
          detail: longCommandOutputDetail()
        }
      ],
      events: [
        { type: "key", label: "empty-enter", key: { return: true }, hasFocusedTarget: true },
        { type: "open-detail", via: "ctrl+o" },
        { type: "close-detail", via: "escape" }
      ]
    },
    {
      name: "debug-mode-trace-action-detail",
      rows: 28,
      columns: 132,
      pane: "chat",
      latestDetailSource: "command",
      route: "coding_loop",
      sessionId: "-",
      actionCount: 4,
      messages: [
        { role: "system", brief: "Debug hydration: session=- route=coding_loop latest command output available." },
        { role: "user", brief: "Continue the current task." },
        {
          role: "system",
          kind: "progress",
          status: "warning",
          brief: "Command Output detail is present but must stay behind explicit trace action."
        }
      ],
      events: [
        { type: "key", label: "debug-empty-enter", key: { return: true }, hasFocusedTarget: true },
        { type: "slash", commandLine: "/view trace", pane: "log" },
        { type: "select-action", index: 2, actionCount: 4 },
        { type: "open-detail", via: "ctrl+o" },
        { type: "close-detail", via: "q" }
      ]
    },
    {
      name: "cache-miss-detail-search-replay",
      rows: 24,
      columns: 120,
      pane: "chat",
      latestDetailSource: "event",
      messages: [
        { role: "user", brief: "Why did provider reuse fail?" },
        {
          role: "system",
          kind: "progress",
          status: "warning",
          brief: "Prompt cache cache_miss missReason=prefix_drift. Ctrl+O for details.",
          detail: "Cache miss detail\nmiss_reason=prefix_drift\nstable_prefix_ratio=0.42"
        }
      ],
      events: [
        { type: "search", query: "cache miss" },
        { type: "open-detail", via: "ctrl+o" },
        { type: "close-detail", via: "escape" }
      ]
    },
    {
      name: "lsp-fallback-detail-search-replay",
      rows: 24,
      columns: 120,
      pane: "chat",
      latestDetailSource: "event",
      messages: [
        { role: "user", brief: "Use semantic evidence for this edit." },
        {
          role: "system",
          kind: "progress",
          status: "warning",
          brief: "LSP fallback_reason=provider_unavailable; use file.grep/file.read. Ctrl+O for details.",
          detail: "Semantic fallback detail\nfallback_reason=provider_unavailable\nfallback_tools=file.grep,file.read"
        }
      ],
      events: [
        { type: "search", query: "lsp fallback" },
        { type: "open-detail", via: "ctrl+o" },
        { type: "close-detail", via: "escape" }
      ]
    },
    {
      name: "long-session-search-scroll-fold-budget",
      rows: 30,
      columns: 140,
      pane: "chat",
      latestDetailSource: "event",
      performanceBudget: { maxMountedMessages: 42, maxVisibleMessages: 32 },
      messages: longReplayMessages(1200),
      events: [
        { type: "search", query: "offscreen needle" },
        { type: "scroll", delta: 12 },
        { type: "search", query: "cache miss" },
        { type: "fold", index: 1175, action: "toggle" },
        { type: "scroll", delta: -6 },
        { type: "open-detail", via: "ctrl+o" },
        { type: "close-detail", via: "escape" }
      ]
    }
  ];
}

function applyTuiReplayEvent(state: MutableTuiReplayState, event: TuiReplayEvent): TuiReplayFailure[] {
  switch (event.type) {
    case "key":
      return applyFocusTransition(state, event.character, event.key, event.hasFocusedTarget);
    case "collaboration-key":
      return applyCollaborationReplayEvent(state, event);
    case "slash":
      return applySlashReplayEvent(state, event);
    case "select-action":
      state.pane = event.pane ?? "log";
      state.focus = "action-log";
      state.selectedActionRow = Math.max(0, Math.floor(event.index));
      state.actionCount = Math.max(state.selectedActionRow + 1, event.actionCount ?? state.actionCount);
      state.latestDetailSource = event.detailSource ?? "event";
      return [];
    case "open-detail": {
      const target = detailOpenTargetForPane({
        pane: state.pane,
        actionCount: state.actionCount,
        hasLatestDetail: state.latestDetailSource !== "none"
      });
      if (target === "none") {
        return [{
          kind: "detail",
          message: "open-detail has no latest or selected action target"
        }];
      }
      return applyFocusTransition(
        state,
        event.via === "focused" ? "o" : "o",
        { ctrl: event.via !== "focused" },
        event.hasFocusedTarget ?? true
      );
    }
    case "close-detail":
      state.collaborationOverlay = undefined;
      return applyCloseDetail(state, event.via ?? "escape");
    case "search":
      return applySearchReplayEvent(state, event);
    case "fold":
      return applyFoldReplayEvent(state, event);
    case "scroll":
      state.scrollOffset = nextConversationScrollOffset({
        totalLines: replayVirtualLayout(state).totalRows,
        viewportLines: replayTranscriptRows(state),
        currentOffset: state.scrollOffset,
        delta: event.delta
      });
      return [];
    case "layout":
      state.rows = event.rows ?? state.rows;
      state.columns = event.columns ?? state.columns;
      state.pane = event.pane ?? state.pane;
      return [];
    case "append-message":
      state.messages.push(event.message);
      return [];
  }
}

function applyCollaborationReplayEvent(
  state: MutableTuiReplayState,
  event: Extract<TuiReplayEvent, { type: "collaboration-key" }>
): TuiReplayFailure[] {
  const action = collaborationShortcutActionForInput({
    character: event.character,
    key: event.key,
    enabled: event.enabled ?? true,
    inputIsEmpty: event.inputIsEmpty ?? true
  });
  if (!action) {
    return [];
  }
  state.collaborationOverlay = action === "open"
    ? "ownership"
    : action === "reassign"
      ? "ownership"
      : action;
  state.focus = "input";
  state.detailOpen = false;
  state.latestDetailSource = "none";
  return [];
}

function applyFocusTransition(
  state: MutableTuiReplayState,
  character: string | undefined,
  key: { ctrl?: boolean; return?: boolean; escape?: boolean },
  hasFocusedTarget = true
): TuiReplayFailure[] {
  const transition = tuiFocusTransitionForInput({
    character,
    key,
    focusBefore: state.focus,
    detailOpen: state.detailOpen,
    pane: state.pane,
    latestDetailSource: state.latestDetailSource,
    hasFocusedTarget
  });
  state.lastTransition = transition;
  state.focus = transition.focusAfter;
  state.detailOpen = transition.detailAfter;
  return [];
}

function applyCloseDetail(state: MutableTuiReplayState, via: "escape" | "ctrl+o" | "q"): TuiReplayFailure[] {
  if (via === "ctrl+o") {
    return applyFocusTransition(state, "o", { ctrl: true }, true);
  }
  if (via === "q") {
    return applyFocusTransition(state, "q", {}, true);
  }
  return applyFocusTransition(state, undefined, { escape: true }, true);
}

function applySlashReplayEvent(state: MutableTuiReplayState, event: Extract<TuiReplayEvent, { type: "slash" }>): TuiReplayFailure[] {
  const parsed = parseSlashCommandLine(event.commandLine);
  if (!parsed) {
    return [{ kind: "slash", message: `invalid slash command: ${event.commandLine}` }];
  }
  if (parsed.command === "view" && parsed.args[0]) {
    state.pane = parsed.args[0] === "trace" ? "log" : parsed.args[0];
  }
  state.pane = event.pane ?? state.pane;
  state.latestDetailSource = event.detailSource ?? state.latestDetailSource;
  state.focus = "input";
  state.detailOpen = false;
  return [];
}

function applySearchReplayEvent(state: MutableTuiReplayState, event: Extract<TuiReplayEvent, { type: "search" }>): TuiReplayFailure[] {
  if (event.close) {
    state.search = closeTranscriptSearch(state.search);
    return [];
  }
  const index = buildTranscriptSearchIndex(state.messages);
  state.search = updateTranscriptSearch(state.search, index, event.query);
  if (event.delta) {
    state.search = stepTranscriptSearch(state.search, event.delta);
  }
  const match = currentTranscriptSearchMatch(state.search);
  if (!match) {
    return [{ kind: "search", message: `query did not match transcript: ${event.query}` }];
  }
  state.selectedRow = match.messageIndex;
  state.scrollOffset = scrollOffsetToRevealMessage(state, match.messageIndex);
  return [];
}

function applyFoldReplayEvent(state: MutableTuiReplayState, event: Extract<TuiReplayEvent, { type: "fold" }>): TuiReplayFailure[] {
  if (event.index !== undefined) {
    state.cursor = messageCursorReducer(state.cursor, { type: "select", index: event.index }, state.messages);
  }
  state.cursor = messageCursorReducer(state.cursor, { type: event.action ?? "toggle" }, state.messages);
  const selected = selectedConversationMessage(state.cursor, state.messages);
  state.selectedRow = selected?.index;
  return state.cursor.expandedKeys.size
    ? []
    : [{ kind: "fold", message: "fold event did not expand a foldable message" }];
}

function buildTuiReplayTraceEntry(
  state: MutableTuiReplayState,
  step: number,
  event: TuiReplayEvent
): TuiReplayTraceEntry {
  const layout = replayVirtualLayout(state);
  const issues = replayLayoutIssues(state);
  const match = currentTranscriptSearchMatch(state.search);
  return {
    step,
    event: describeTuiReplayEvent(event),
    focus: state.focus,
    detailOpen: state.detailOpen,
    detailSource: state.latestDetailSource,
    pane: state.pane,
    selectedRow: state.selectedRow,
    selectedActionRow: state.selectedActionRow,
    collaborationOverlay: state.collaborationOverlay,
    search: transcriptSearchSummary(state.search),
    currentSearchMessageIndex: match?.messageIndex,
    scrollOffset: layout.scrollOffset,
    totalRows: layout.totalRows,
    visibleMessageCount: layout.visibleMessageCount,
    mountedMessageCount: layout.mountedMessageCount,
    layoutIssues: issues.map(formatLayoutIssue),
    cacheStats: state.cache.stats(),
    transition: state.lastTransition
  };
}

function validateTuiReplayStep(
  state: MutableTuiReplayState,
  event: TuiReplayEvent,
  trace: TuiReplayTraceEntry,
  budget: TuiReplayPerformanceBudget | undefined
): TuiReplayFailure[] {
  const failures: TuiReplayFailure[] = [];
  if (trace.layoutIssues.length > 0) {
    failures.push({
      kind: "layout",
      message: trace.layoutIssues.join("; "),
      lastTrace: trace
    });
  }
  if (isEmptyEnter(event) && (state.detailOpen || state.focus === "detail" || state.pane !== trace.transition?.paneBefore)) {
    failures.push({
      kind: "focus",
      message: "generic Enter must not open detail, steal focus, or switch panes",
      lastTrace: trace
    });
  }
  if (state.detailOpen && state.latestDetailSource === "none") {
    failures.push({
      kind: "detail",
      message: "detail pane opened without a traceable detail source",
      lastTrace: trace
    });
  }
  if (event.type === "collaboration-key" && state.collaborationOverlay && state.detailOpen) {
    failures.push({
      kind: "focus",
      message: "collaboration overlay must not open fullscreen detail or hide prompt",
      lastTrace: trace
    });
  }
  const maxMounted = budget?.maxMountedMessages ?? Math.max(42, replayTranscriptRows(state) + 12);
  const maxVisible = budget?.maxVisibleMessages ?? replayTranscriptRows(state);
  if (trace.mountedMessageCount > maxMounted) {
    failures.push({
      kind: "performance",
      message: `mounted messages ${trace.mountedMessageCount} exceeded budget ${maxMounted}`,
      lastTrace: trace
    });
  }
  if (trace.visibleMessageCount > maxVisible) {
    failures.push({
      kind: "performance",
      message: `visible messages ${trace.visibleMessageCount} exceeded budget ${maxVisible}`,
      lastTrace: trace
    });
  }
  return failures;
}

function replayVirtualLayout(state: MutableTuiReplayState) {
  return buildVirtualConversationLayout({
    messages: state.messages,
    rows: replayTranscriptRows(state),
    columns: state.columns,
    scrollOffset: state.scrollOffset,
    expandedMessageKeys: state.cursor.expandedKeys,
    selectedMessageIndex: state.selectedRow,
    searchMatchMessageIndex: currentTranscriptSearchMatch(state.search)?.messageIndex,
    cache: state.cache
  });
}

function replayTranscriptRows(state: Pick<MutableTuiReplayState, "rows">): number {
  const bottomRows = conversationBottomRows({
    terminalRows: state.rows,
    contentRows: conversationPromptRows(0)
  });
  return fullscreenConversationRows(state.rows, bottomRows);
}

function replayLayoutIssues(state: MutableTuiReplayState): ConversationDomLayoutIssue[] {
  const bottomRows = conversationBottomRows({
    terminalRows: state.rows,
    contentRows: conversationPromptRows(0)
  });
  const contract = conversationRendererContract({
    rows: state.rows,
    columns: state.columns,
    bottomRows,
    pane: state.pane
  });
  return validateConversationDomLayout(contract);
}

function scrollOffsetToRevealMessage(state: MutableTuiReplayState, messageIndex: number): number {
  const belowTarget = state.messages.slice(messageIndex + 1);
  return buildVirtualConversationLayout({
    messages: belowTarget,
    rows: replayTranscriptRows(state),
    columns: state.columns,
    cache: createConversationRenderCache()
  }).totalRows;
}

function describeTuiReplayEvent(event: TuiReplayEvent): string {
  switch (event.type) {
    case "key":
      return `key:${event.label ?? keyEventLabel(event)}`;
    case "collaboration-key":
      return `collaboration:${event.label ?? keyEventLabel(event)}`;
    case "slash":
      return `slash:${event.commandLine}`;
    case "select-action":
      return `select-action:${event.index}`;
    case "open-detail":
      return `open-detail:${event.via ?? "ctrl+o"}`;
    case "close-detail":
      return `close-detail:${event.via ?? "escape"}`;
    case "search":
      return `search:${event.query}`;
    case "fold":
      return `fold:${event.index ?? "selected"}`;
    case "scroll":
      return `scroll:${event.delta}`;
    case "layout":
      return `layout:${event.columns ?? "-"}x${event.rows ?? "-"}`;
    case "append-message":
      return "append-message";
  }
}

function keyEventLabel(event: Extract<TuiReplayEvent, { type: "key" | "collaboration-key" }>): string {
  if (event.key.return) {
    return "return";
  }
  if (event.key.escape) {
    return "escape";
  }
  if (event.key.ctrl && event.character) {
    return `ctrl+${event.character.toLowerCase()}`;
  }
  return event.character ?? "other";
}

function isEmptyEnter(event: TuiReplayEvent): boolean {
  return event.type === "key" && event.key.return === true && !event.character;
}

function formatLayoutIssue(issue: ConversationDomLayoutIssue): string {
  return `${issue.kind}:${issue.nodeId}${issue.otherNodeId ? `>${issue.otherNodeId}` : ""}:${issue.message}`;
}

function longCommandOutputDetail(): string {
  return [
    "Command Output",
    "session=- route=coding_loop",
    ...Array.from({ length: 80 }, (_, index) => `line ${index + 1}: command output remains behind Ctrl+O`)
  ].join("\n");
}

function longReplayMessages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => {
    if (index === 25) {
      return { role: "assistant", brief: "This is the offscreen needle for transcript search." };
    }
    if (index === 900) {
      return {
        role: "system",
        kind: "progress",
        status: "warning",
        brief: "Prompt cache cache_miss missReason=prefix_drift in a long replay."
      };
    }
    if (index === 1175) {
      return {
        role: "system",
        kind: "tool_result",
        status: "success",
        brief: "shell.exec: command exited 0",
        preview: "shell.exec: command exited 0",
        detail: "shell.exec: command exited 0\nshort\nfull output line\nanother full output line"
      };
    }
    return index % 2 === 0
      ? { role: "user", brief: `prompt ${index}` }
      : { role: "assistant", brief: `assistant response ${index}` };
  });
}
