import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  addPermissionAdditionalDirectory,
  addCustomProvider,
  ensureSwarmHome,
  getProviderModels,
  installPluginRoot,
  loadSwarmSettings,
  removePluginRoot,
  removePermissionAdditionalDirectory,
  setCapabilityEnabled,
  setCapabilityModelVisible,
  setModelSelection,
  setPermissionMode,
  setPluginEnabled,
  setProviderApiKey
} from "../config/settings.js";
import { refreshProviderModels } from "../providers/model-discovery.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import { resetDebugLogger } from "../runtime/debug-logger.js";
import type { RuntimeEvent } from "../runtime/events.js";
import { formatRuntimeEventBrief, formatWhyReport, formatWorkerBrief, formatWorkerDetail } from "../runtime/event-formatters.js";
import { buildPermissionReport } from "../runtime/permission-report.js";
import { buildWorkRecordFromRuntimeEvent } from "../runtime/work-protocol.js";
import type { RunMode, RunSandboxMode } from "../runtime/execution-router.js";
import type { ExecutionResult, PlannedSession } from "../runtime/orchestrator.js";
import { buildResultCardFromSnapshot, type ResultCard as RuntimeResultCard } from "../runtime/result-card.js";
import { formatPromptCacheBrief, formatPromptCacheDetail } from "../runtime/prompt-cache-status.js";
import type { PromptCacheRuntimeStatus } from "../runtime/prompt-cache-status.js";
import { formatToolFailureContent } from "../runtime/coding-agent-loop.js";
import {
  assertToolActionAllowedBySandbox,
  sandboxDecisionFromError,
  sandboxDecisionFromUnknown,
  sandboxFailureSummary,
  sandboxRecoverySuggestion
} from "../runtime/sandbox-policy.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, decideToolPermission } from "../tools/permissions.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";
import type { PermissionMode } from "../config/settings.js";
import { readTaskOutput, writeTaskOutput } from "../storage/task-output-store.js";
import type { BlackboardEntry, GeneratedPlan, RunAttempt, SwarmSession, WorkItem, WorkspaceLease } from "../protocol/types.js";
import { workerDisplayLabel, type WorkerRecord } from "../storage/worker-state-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import { runLocalEvals } from "../evals/local-evals.js";
import { buildDoctorReport } from "../doctor/report.js";
import { restoreSessionFromRow } from "../sessions/session-row.js";
import { getSymphonyStatus, type SymphonyStatus } from "../symphony/status.js";
import { cleanupSymphonyWorkspaces, type SymphonyCleanupResult } from "../symphony/cleanup.js";
import { SymphonyDaemonManager, type SymphonyDaemonRecord } from "../symphony/daemon.js";
import { runSymphonyTick, type SymphonyTickResult } from "../symphony/scheduler.js";
import { workItemLabel } from "../symphony/work-item.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowLoadResult } from "../symphony/workflow.js";
import { createWorkSourceFromConfig } from "../symphony/work-source.js";
import { mainPaneLabels, mainPaneOrder, mainPaneShortLabels, type MainPaneId } from "./main-panes.js";
import { applySandboxModeCommand, buildSandboxReport } from "./sandbox-control.js";
import {
  commandOutputPreview,
  formatToolOutputPreview,
  indentPreview,
  parseSlashCommandLine,
  rawSlashArgsAfter,
  renderSlashHelp,
  type SlashCommandSpec
} from "./slash-commands.js";
import { decideResumeExecution } from "./resume-control.js";
import { ChatCommandCandidates, ChatInputArea, emptyChatCompletionState, type ChatCompletionState } from "./ChatInputArea.js";
import { createChatInputControllerState, type ChatInputControllerState } from "./chat-input-controller.js";
import {
  emptyIdlePaneSnapshot,
  idlePaneSnapshotSignature,
  readIdlePaneSnapshot,
  symphonyDaemonRecordsSignature,
  type IdlePaneSnapshot
} from "./idle-pane-snapshot.js";
import { approvalInputDecision } from "./approval-input.js";
import { editOnboardFieldInput } from "./onboard-input.js";
import { messageToActionRow, runtimeEventToActionRow, type TuiActionRow } from "./action-log.js";
import { applyTaskAttemptToTuiState, applyWorkRecordToTuiState, summarizeTaskWritePolicies, type TuiTaskState, type TuiWorkState } from "./work-state.js";
import { ActionLog } from "./components/ActionLog.js";
import { appendTuiLoopActivity, appendTuiRuntimeEvent, runtimeEventDisplaySignature, sameRuntimeEventDisplay } from "./tui-event-buffer.js";
import { ActivityTimeline } from "./components/ActivityTimeline.js";
import { ApprovalOverlay } from "./components/ApprovalOverlay.js";
import { CurrentActionRow } from "./components/CurrentActionRow.js";
import { InspectorPane } from "./components/InspectorPane.js";
import { ResultCard as ResultCardPanel } from "./components/ResultCard.js";
import { StatusRail } from "./components/StatusRail.js";
import { ConversationFirstPane } from "./components/ConversationFirstPane.js";
import { ConversationBottomChrome, ConversationFullscreenLayout, ConversationResultLine, ConversationStatusLine } from "./components/ConversationFullscreenLayout.js";
import { progressBar, routeBadge, sandboxBadge, sectionLabel, statusBadge } from "./theme.js";
import { formatExecutionResultDisplay } from "./result-display.js";
import {
  appendTranscriptMessage,
  createStartupLogoMessage,
  runtimeEventTranscriptMessage,
  slashCommandTranscriptMessage,
  slashToolUseTranscriptMessage
} from "./conversation-transcript.js";
import {
  conversationPromptRows,
  conversationBottomRows as conversationBottomRowsForTerminal,
  conversationInputCapacity,
  conversationRenderedLineCount,
  conversationViewportAfterAppend,
  conversationViewportAfterScroll,
  detailOpenTargetForPane,
  fullscreenConversationRows,
  resetConversationViewport,
  tuiScreenMode,
  type ConversationViewportState,
  type ConversationMessage
} from "./conversation-layout.js";
import { compactWorkSnapshotLines, formatSessionMemory, formatWorkSnapshot } from "./work-snapshot-display.js";
import type { McpServerRecord } from "../extensions/mcp.js";
import { renderPluginSlashCommandObjective, type PluginContributionRecord, type PluginRecord } from "../extensions/plugins.js";
import type { SkillRecord, ActivatedSkill } from "../extensions/skills.js";
import { renderCustomCommandObjective, type CustomCommandRecord } from "../extensions/custom-commands.js";
import type { CapabilityDescriptor, CapabilityProviderSnapshot } from "../extensions/types.js";
import { summarizeCapabilityCatalog, summarizeMcpCatalog, summarizePluginCatalog, summarizeSkillCatalog } from "../extensions/catalog-summary.js";
import { getGlobalLspManager, type LspStatusReport } from "../lsp/manager.js";
import {
  buildFooterPills,
  createFooterNavigationState,
  footerNavigationReducer,
  selectedFooterPill,
  type FooterNavigationState,
  type FooterPill,
  type FooterPillId
} from "./footer-navigation.js";
import { formatServiceStatusSection } from "./status-surface.js";
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
import {
  createMessageCursorState,
  messageCursorReducer,
  selectedConversationMessage,
  type MessageCursorState
} from "./message-folding.js";

type ChatMessage = ConversationMessage;

type SlashCommandResult = {
  brief: string;
  detail?: string;
  detailSource?: "ai" | "command";
  autoOpenDetail?: boolean;
};

type OnboardField = "provider" | "apiKey" | "planner" | "worker" | "aggregator" | "customName" | "customBaseURL" | "customModel";

type OnboardState = {
  enabled: boolean;
  custom: boolean;
  field: OnboardField;
  values: Record<OnboardField, string>;
  error?: string;
};

type Props = {
  forceOnboarding?: boolean;
};

type TaskState = TuiTaskState;

type ToolResultState = {
  task_id: string;
  title: string;
  action: string;
  summary: string;
  content?: string;
  status?: "success" | "partial" | "failed";
  outputRef?: string;
  attempt?: number;
  errorCode?: string;
  recoverySuggestion?: string;
  agentLabel?: string;
  workerId?: string;
};

type LoopActivityState = Extract<RuntimeEvent, { type: "loop_activity" }>;
type ControllerEvent = Extract<RuntimeEvent, { type: "controller" }>;

type RouteState = {
  mode: string;
  confidence?: number;
  reason: string;
  requiresWorkspace?: boolean;
  needsParallelism?: boolean;
  fallbackMode?: string;
};

type CapabilityProviderSummaryRow = CapabilityProviderSnapshot;

type RecentSessionRow = ReturnType<SwarmRuntime["sessionStore"]["listRecent"]>[number];
type ApprovalStoreRecord = ReturnType<SwarmRuntime["approvalStore"]["list"]>[number];
type PluginSlashCommandRecord = {
  plugin: PluginRecord;
  contribution: PluginContributionRecord;
};

const fieldOrder: OnboardField[] = ["provider", "apiKey", "planner", "worker", "aggregator"];
const customFieldOrder: OnboardField[] = [
  "provider",
  "customName",
  "customBaseURL",
  "customModel",
  "apiKey",
  "planner",
  "worker",
  "aggregator"
];
const SLASH_OUTPUT_INLINE_BYTES = 18_000;
const SLASH_OUTPUT_PREVIEW_BYTES = 6_000;
const LOOP_ACTIVITY_TIMELINE_LIMIT = 6;
const MESSAGE_OUTPUT_PREVIEW_LINES = 4;
const MESSAGE_OUTPUT_PREVIEW_CHARS = 800;
const ADVANCED_SURFACE_FLAGS = new Set(["all", "advanced", "full", "--all", "--advanced"]);

function createChatSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `chat-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function SwarmChatApp({ forceOnboarding = false }: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [settingsSnapshot, setSettingsSnapshot] = useState(() => {
    ensureSwarmHome();
    return loadSwarmSettings();
  });
  const startupReadiness = useMemo(() => new OpenAIProvider().readiness(), []);
  const needsOnboarding = forceOnboarding || startupReadiness.some((item) => !item.configured);
  const initialProblem = startupReadiness.find((item) => !item.configured);
  const initialSystemBrief = needsOnboarding
    ? `Provider setup required.${initialProblem?.role ? ` ${initialProblem.role}: ${initialProblem.reason}` : ""}`
    : "Swarm chat ready. Enter an objective.";
  const initialSystemMessage: ChatMessage = needsOnboarding
    ? { role: "system", brief: initialSystemBrief }
    : createStartupLogoMessage({
      version: "0.1.0",
      cwd: process.cwd(),
      model: settingsSnapshot.models.worker || settingsSnapshot.models.planner || settingsSnapshot.models.defaultProvider || "model not configured"
    });
  const approvalResolver = useRef<((approved: boolean) => void) | undefined>();
  const sessionApprovalAllow = useRef<Set<string>>(new Set());
  const chatSessionId = useRef(createChatSessionId());
  const symphonyDaemonManager = useRef<SymphonyDaemonManager | undefined>();
  const [approval, setApproval] = useState<ToolApprovalRequest | undefined>();
  const [runtime, setRuntime] = useState<SwarmRuntime | undefined>(() => (needsOnboarding ? undefined : createRuntime()));
  const runtimeRef = useRef<SwarmRuntime | undefined>(runtime);
  const [messages, setMessages] = useState<ChatMessage[]>([initialSystemMessage]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [actionLogRows, setActionLogRows] = useState<TuiActionRow[]>(() => [messageToActionRow(initialSystemMessage, 0)]);
  const [pendingPlan, setPendingPlan] = useState<PlannedSession | undefined>();
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailScroll, setDetailScroll] = useState(0);
  const [latestDetail, setLatestDetail] = useState("");
  const [latestDetailSource, setLatestDetailSource] = useState<"none" | "ai" | "task" | "command" | "event">("none");
  const [onboard, setOnboard] = useState<OnboardState>(() => createOnboardState(needsOnboarding));
  const [taskWorkState, setTaskWorkState] = useState<TuiWorkState>(() => ({
    taskStates: new Map(),
    taskTotal: 0,
    taskCompleted: 0
  }));
  const taskStates = taskWorkState.taskStates;
  const taskTotal = taskWorkState.taskTotal;
  const taskCompleted = taskWorkState.taskCompleted;
  const [toolResults, setToolResults] = useState<ToolResultState[]>([]);
  const [loopActivity, setLoopActivity] = useState<LoopActivityState | undefined>();
  const [loopActivityTimeline, setLoopActivityTimeline] = useState<LoopActivityState[]>([]);
  const [workers, setWorkers] = useState<Map<string, WorkerRecord>>(new Map());
  const [handoffs, setHandoffs] = useState<Map<string, HandoffSessionRecord>>(new Map());
  const [symphonyDaemons, setSymphonyDaemons] = useState<SymphonyDaemonRecord[]>([]);
  const [lastSessionId, setLastSessionId] = useState<string | undefined>();
  const [lastRoute, setLastRoute] = useState<RouteState | undefined>();
  const [latestResultCard, setLatestResultCard] = useState<RuntimeResultCard | undefined>();
  const [runMode, setRunMode] = useState<RunMode>("auto");
  const [runSandboxMode, setRunSandboxMode] = useState<RunSandboxMode>("workspace-write");
  const [mainPane, setMainPane] = useState<MainPaneId>("chat");
  const [conversationViewport, setConversationViewport] = useState<ConversationViewportState>(() => resetConversationViewport());
  const [actionLogScrollOffset, setActionLogScrollOffset] = useState(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [idlePaneSnapshot, setIdlePaneSnapshot] = useState<IdlePaneSnapshot>(() => emptyIdlePaneSnapshot());
  const idlePaneSnapshotSignatureRef = useRef(idlePaneSnapshotSignature(idlePaneSnapshot));
  const [completionRows, setCompletionRows] = useState(0);
  const [chatCompletion, setChatCompletion] = useState<ChatCompletionState>(() => emptyChatCompletionState());
  const [footerNavigation, setFooterNavigation] = useState<FooterNavigationState>(() => createFooterNavigationState());
  const [transcriptSearch, setTranscriptSearch] = useState<TranscriptSearchState>(() => createTranscriptSearchState());
  const [messageCursor, setMessageCursor] = useState<MessageCursorState>(() => createMessageCursorState());
  const symphonyDaemonRecordsSignatureRef = useRef(symphonyDaemonRecordsSignature(symphonyDaemons));
  const chatInputState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const lastActionLogEventSignatureRef = useRef<string | undefined>(undefined);
  const previousActionLogLengthRef = useRef(actionLogRows.length);
  const [motionTick, setMotionTick] = useState(0);

  const terminalRows = stdout.rows || 32;
  const terminalColumns = stdout.columns || 100;
  const detailHeight = Math.max(12, terminalRows - 6);
  const actionLogPageRows = Math.max(4, terminalRows - 12 - completionRows);
  const shouldAnimate = !detailOpen && !onboard.enabled && (busy || Boolean(approval) || Boolean(pendingPlan));
  const extensionCommandCandidates = runtime
    ? [
      ...customSlashCommandCandidates(runtime.listCustomCommands()),
      ...pluginSlashCommandCandidates(runtime.listPlugins())
    ]
    : [];
  runtimeRef.current = runtime;

  function refreshSettingsSurface(targetRuntime = runtime): ReturnType<typeof loadSwarmSettings> {
    targetRuntime?.reloadSettings();
    const nextSettings = loadSwarmSettings();
    setSettingsSnapshot(nextSettings);
    return nextSettings;
  }

  function buildPermissionsCommandResult(settings = loadSwarmSettings()): SlashCommandResult {
    const report = buildPermissionReport({
      permissions: settings.permissions,
      sandboxMode: runSandboxMode,
      workspace: runtime?.workspaceRoot() ?? process.cwd(),
      recentApprovals: runtime?.listRecentApprovalsForWorkspace(8) ?? []
    });
    return {
      brief: `${report.brief} Ctrl+O for details.`,
      detail: report.detail
    };
  }

  useEffect(() => {
    if (!runtime) {
      return;
    }
    symphonyDaemonManager.current = new SymphonyDaemonManager(runtime);
    const unsubscribe = runtime.events.onEvent((event) => {
      setEvents((previous) => appendTuiRuntimeEvent(previous, event));
      appendRuntimeLogEvent(event);
      appendRuntimeTranscriptEvent(event);
      const work = buildWorkRecordFromRuntimeEvent(event, new Date().toISOString());
      if (work.kind === "task") {
        setTaskWorkState((previous) => applyWorkRecordToTuiState(previous, work));
      }

      if (event.type === "task_attempt") {
        setTaskWorkState((previous) => applyTaskAttemptToTuiState(previous, event));
      }
      if (event.type === "progress") {
        setTaskWorkState((previous) => previous.taskCompleted === event.completed && previous.taskTotal === event.total
          ? previous
          : { ...previous, taskCompleted: event.completed, taskTotal: event.total });
      }
      if (event.type === "loop_activity") {
        setLoopActivity((previous) => sameRuntimeEventDisplay(previous, event) ? previous : event);
        setLoopActivityTimeline((previous) => appendTuiLoopActivity(previous, event, LOOP_ACTIVITY_TIMELINE_LIMIT));
      }
      if (event.type === "controller") {
        const route = routeStateFromControllerEvent(event);
        if (route) {
          setLastRoute(route);
        }
      }
      if (event.type === "tool_result") {
        setToolResults((prev) => [
          ...prev.slice(-20),
          {
            task_id: event.task_id,
            title: event.title,
            action: event.action,
            summary: event.summary,
            content: event.content,
            status: event.status,
            outputRef: event.outputRef,
            attempt: event.attempt,
            errorCode: event.errorCode,
            recoverySuggestion: event.recoverySuggestion,
            agentLabel: event.agent ? runtimeAgentLabel(event.agent) : undefined,
            workerId: event.agent?.worker_id
          }
        ]);
        setDetailOpen(false);
        setLatestDetailSource("none");
      }
      if (event.type === "plan") {
        setLastSessionId(event.session_id);
        setTaskWorkState({ taskStates: new Map(), taskTotal: event.plan.tasks.length, taskCompleted: 0 });
        setToolResults([]);
      }
      if (event.type === "final") {
        setLastSessionId(event.session_id);
      }
      if (event.type === "workspace_change") {
        setLastSessionId(event.session_id);
      }
      if (event.type === "worker") {
        setWorkers((prev) => {
          const next = new Map(prev);
          next.set(event.worker.worker_id, event.worker);
          return next;
        });
      }
      if (event.type === "agent_run_started" || event.type === "agent_run_completed") {
        setWorkers((prev) => {
          const next = new Map(prev);
          next.set(event.worker.worker_id, event.worker);
          return next;
        });
      }
      if (event.type === "handoff_started" || event.type === "handoff_returned" || event.type === "handoff_taken_back") {
        setHandoffs((prev) => {
          const next = new Map(prev);
          next.set(event.handoff.handoff_id, event.handoff);
          return next;
        });
      }
    });
    return () => {
      unsubscribe();
      const manager = symphonyDaemonManager.current;
      symphonyDaemonManager.current = undefined;
      void manager?.stopAll("tui_runtime_disposed", true);
      runtime.dispose();
    };
  }, [runtime]);

  useEffect(() => {
    if (!runtime) {
      refreshIdlePaneSnapshot(emptyIdlePaneSnapshot());
      refreshSymphonyDaemons([]);
      return;
    }
    const timer = setInterval(() => {
      refreshIdlePaneSnapshot(readIdlePaneSnapshot(runtime));
      refreshSymphonyDaemons(symphonyDaemonManager.current?.listRecords() ?? []);
    }, 1_000);
    refreshIdlePaneSnapshot(readIdlePaneSnapshot(runtime));
    timer.unref?.();
    return () => clearInterval(timer);
  }, [runtime]);

  useEffect(() => {
    if (!shouldAnimate) {
      return;
    }
    const timer = setInterval(() => {
      setMotionTick((value) => (value + 1) % 4);
    }, 120);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [shouldAnimate]);

  useEffect(() => {
    refreshIdlePaneSnapshot(readIdlePaneSnapshot(runtime));
  }, [runtime, mainPane, messages.length, toolResults.length, lastSessionId]);

  useEffect(() => {
    const previousLength = previousActionLogLengthRef.current;
    previousActionLogLengthRef.current = actionLogRows.length;
    if (actionLogRows.length === 0) {
      setSelectedActionIndex(0);
      return;
    }
    if (actionLogRows.length > previousLength) {
      setSelectedActionIndex(actionLogRows.length - 1);
      return;
    }
    setSelectedActionIndex((value) => Math.min(value, actionLogRows.length - 1));
  }, [actionLogRows.length]);

  function refreshIdlePaneSnapshot(next: IdlePaneSnapshot): void {
    const signature = idlePaneSnapshotSignature(next);
    if (signature !== idlePaneSnapshotSignatureRef.current) {
      idlePaneSnapshotSignatureRef.current = signature;
      setIdlePaneSnapshot(next);
    }
  }

  function refreshSymphonyDaemons(next: SymphonyDaemonRecord[]): void {
    const signature = symphonyDaemonRecordsSignature(next);
    if (signature !== symphonyDaemonRecordsSignatureRef.current) {
      symphonyDaemonRecordsSignatureRef.current = signature;
      setSymphonyDaemons(next);
    }
  }

  function appendChatMessage(message: ChatMessage): void {
    setConversationViewport((state) => conversationViewportAfterAppend({
      state,
      message,
      messageIndex: messages.length,
      columns: conversationTextColumns()
    }));
    setMessages((previous) => [...previous, message]);
    setTranscriptSearch((state) => closeTranscriptSearch(state));
    setActionLogRows((previous) => [...previous, messageToActionRow(message, previous.length)]);
  }

  function appendChatTranscriptMessage(message: ChatMessage): void {
    setMessages((previous) => {
      const next = appendTranscriptMessage(previous, message);
      if (next === previous) {
        return previous;
      }
      setConversationViewport((state) => conversationViewportAfterAppend({
        state,
        message,
        messageIndex: previous.length,
        columns: conversationTextColumns()
      }));
      setTranscriptSearch((state) => closeTranscriptSearch(state));
      return next;
    });
  }

  function replaceChatTranscript(message: ChatMessage): void {
    setMessages([message]);
    setConversationViewport(resetConversationViewport());
    setTranscriptSearch(createTranscriptSearchState());
    setMessageCursor(createMessageCursorState());
    setActionLogRows([messageToActionRow(message, 0)]);
    setActionLogScrollOffset(0);
    lastActionLogEventSignatureRef.current = undefined;
  }

  function appendRuntimeLogEvent(event: RuntimeEvent): void {
    const signature = runtimeEventDisplaySignature(event);
    if (lastActionLogEventSignatureRef.current === signature) {
      return;
    }
    lastActionLogEventSignatureRef.current = signature;
    setActionLogRows((previous) => [...previous, runtimeEventToActionRow(event, previous.length)]);
  }

  function appendRuntimeTranscriptEvent(event: RuntimeEvent): void {
    const message = runtimeEventTranscriptMessage(event);
    if (!message) {
      return;
    }
    appendChatTranscriptMessage(message);
  }

  useInput((character, key) => {
    if (approval) {
      handleApprovalInput(character, key);
      return;
    }

    if (detailOpen) {
      if (key.escape || (key.ctrl && (character === "o" || character === "c")) || character === "q") {
        setDetailOpen(false);
        return;
      }
      handleDetailInput(key);
      return;
    }

    if (onboard.enabled) {
      if (key.ctrl && character === "c") {
        exit();
        return;
      }
      handleOnboardInput(character, key);
      return;
    }

    if (key.ctrl && character === "c") {
      if (busy && runtime) {
        try {
          const target = runtime.requestInterrupt("User pressed Ctrl+C. Stop unstarted work and reassess the current objective before continuing.");
          setLastSessionId(target.session_id);
          appendChatMessage({ role: "system", brief: `Interrupt requested for ${target.session_id}. Swarm will reassess at the next safe boundary.` });
        } catch (error) {
          pushError(error);
        }
        return;
      }
      exit();
      return;
    }

    if (key.ctrl && character === "o") {
      const target = detailOpenTargetForPane({
        pane: mainPane,
        actionCount: actionLogRows.length,
        hasLatestDetail: latestDetailSource !== "none"
      });
      if (target === "selected-action") {
        openSelectedActionDetail(true);
        return;
      }
      if (target === "latest") {
        setDetailOpen((value) => !value);
      }
      return;
    }

    if (key.ctrl && character === "t") {
      openTaskDetail();
      return;
    }

    if (handleTranscriptSearchInput(character, key)) {
      return;
    }

    if (!busy && pendingPlan) {
      if (character.toLowerCase() === "y") {
        void executePendingPlan();
        return;
      }
      if (character.toLowerCase() === "n") {
        appendChatMessage({ role: "system", brief: "Plan cancelled." });
        setPendingPlan(undefined);
        return;
      }
    }

    if (handleActionLogInput(character, key)) {
      return;
    }

    if (handleFooterNavigationInput(character, key)) {
      return;
    }

    if (handleMessageCursorInput(character, key)) {
      return;
    }

    if (handleConversationScrollInput(character, key)) {
      return;
    }

    // Normal text editing is owned by ChatInputArea so typing does not re-render the transcript.
  });

  async function submitObjective(objective: string): Promise<void> {
    objective = objective.trim();
    if (!objective) {
      return;
    }
    setActionLogScrollOffset(0);
    setConversationViewport(resetConversationViewport());

    if (objective.startsWith("/")) {
      await handleSlashCommand(objective);
      return;
    }

    if (!runtime) {
      setOnboard(createOnboardState(true));
      return;
    }

    if (busy) {
      appendChatMessage({ role: "user", brief: objective });
      await runtime.sendUserMessage(objective).then((target) => {
        setLastSessionId(target.session_id);
      }).catch(pushError);
      return;
    }

    setBusy(true);
    setLoopActivity(undefined);
    setLoopActivityTimeline([]);
    setLatestResultCard(undefined);
    appendChatMessage({ role: "user", brief: objective });
    try {
      const result = await runtime.run(objective, { mode: runMode, sandboxMode: runSandboxMode });
      const display = formatExecutionResultDisplay(result, runtime);
      setLatestResultCard(result.result_card);
      recordAiDetail(display.detail);
      appendChatMessage({
        role: "assistant",
        brief: display.brief,
        detail: display.detail,
        preview: display.preview
      });
    } catch (error) {
      pushError(error);
    } finally {
      setBusy(false);
    }
  }

  async function executePendingPlan(): Promise<void> {
    if (!runtime || !pendingPlan) {
      return;
    }
    const planned = pendingPlan;
    setPendingPlan(undefined);
    setBusy(true);
    setLoopActivity(undefined);
    setLoopActivityTimeline([]);
    setLatestResultCard(undefined);
    appendChatMessage({ role: "system", brief: "Executing approved swarm plan." });
    try {
      const result = await runtime.execute(planned);
      const display = formatExecutionResultDisplay(result, runtime);
      setLatestResultCard(result.result_card);
      recordAiDetail(display.detail);
      appendChatMessage({
        role: "assistant",
        brief: display.brief,
        detail: display.detail,
        preview: display.preview
      });
    } catch (error) {
      pushError(error);
    } finally {
      setBusy(false);
      setTaskWorkState({ taskStates: new Map(), taskTotal: 0, taskCompleted: 0 });
      setToolResults([]);
      setLoopActivity(undefined);
      setLoopActivityTimeline([]);
    }
  }

  function pushError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    clearDetailState();
    appendChatMessage({ role: "system", brief: message, detail: message, preview: detailPreview(message) });
  }

  function recordAiDetail(detail: string): void {
    if (!shouldOfferAiDetail(detail)) {
      clearDetailState();
      return;
    }
    setLatestDetail(detail);
    setLatestDetailSource("ai");
    setDetailScroll(0);
    setDetailOpen(false);
  }

  function recordCommandDetail(detail: string, open = false): void {
    setLatestDetail(detail);
    setLatestDetailSource("command");
    setDetailScroll(0);
    setDetailOpen(open);
  }

  function openTaskDetail(): void {
    setLatestDetail(renderTaskDetail());
    setLatestDetailSource("task");
    setDetailScroll(0);
    setDetailOpen(true);
  }

  function clearDetailState(): void {
    setDetailOpen(false);
    setLatestDetail("");
    setLatestDetailSource("none");
    setDetailScroll(0);
  }

  function handleDetailInput(key: { upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean }): void {
    const lines = latestDetail.split(/\r?\n/);
    if (key.upArrow) {
      setDetailScroll((value) => Math.max(0, value - 1));
    } else if (key.downArrow) {
      setDetailScroll((value) => Math.min(Math.max(0, lines.length - detailHeight), value + 1));
    } else if (key.pageUp) {
      setDetailScroll((value) => Math.max(0, value - detailHeight));
    } else if (key.pageDown) {
      setDetailScroll((value) => Math.min(Math.max(0, lines.length - detailHeight), value + detailHeight));
    }
  }

  function openSelectedActionDetail(fullscreen: boolean): void {
    const row = actionLogRows[selectedActionIndex] ?? actionLogRows.at(-1);
    if (!row) {
      return;
    }
    setLatestDetail(renderActionRowDetail(row));
    setLatestDetailSource("event");
    setDetailScroll(0);
    if (fullscreen) {
      setDetailOpen(true);
    }
  }

  function handleActionLogInput(character: string | undefined, key: { ctrl?: boolean; pageUp?: boolean; pageDown?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean }): boolean {
    if (mainPane !== "log") {
      return false;
    }
    const normalized = normalizeActionLogControlCharacter(character);
    const inputIsEmpty = chatInputState.current.input.value.length === 0;
    if (inputIsEmpty && key.upArrow) {
      setSelectedActionIndex((value) => Math.max(0, value - 1));
      setLatestDetailSource("none");
      setDetailScroll(0);
      return true;
    }
    if (inputIsEmpty && key.downArrow) {
      setSelectedActionIndex((value) => Math.min(Math.max(0, actionLogRows.length - 1), value + 1));
      setLatestDetailSource("none");
      setDetailScroll(0);
      return true;
    }
    if (inputIsEmpty && key.return && actionLogRows.length > 0) {
      openSelectedActionDetail(true);
      return true;
    }
    if (key.pageUp || (key.ctrl && normalized === "b")) {
      setActionLogScrollOffset((value) => value + actionLogPageRows);
      return true;
    }
    if (key.pageDown || (key.ctrl && normalized === "f")) {
      setActionLogScrollOffset((value) => Math.max(0, value - actionLogPageRows));
      return true;
    }
    return false;
  }

  function handleConversationScrollInput(
    character: string | undefined,
    key: { ctrl?: boolean; pageUp?: boolean; pageDown?: boolean }
  ): boolean {
    if (mainPane !== "chat") {
      return false;
    }
    if (chatInputState.current.input.value.length > 0) {
      return false;
    }
    const normalized = normalizeActionLogControlCharacter(character);
    const viewportLines = fullscreenConversationRows(terminalRows, conversationBottomRows());
    const pageRows = Math.max(4, viewportLines - 2);
    if (key.ctrl && normalized === "e") {
      setConversationViewport(resetConversationViewport());
      return true;
    }
    const delta = key.pageUp || (key.ctrl && normalized === "b")
      ? pageRows
      : key.pageDown || (key.ctrl && normalized === "f")
        ? -pageRows
        : undefined;
    if (delta === undefined) {
      return false;
    }
    setConversationViewport((state) => {
      return conversationViewportAfterScroll({
        state,
        totalLines: conversationRenderedLineCount(messages, conversationTextColumns(), {
          unseenStartIndex: state.unseenStartIndex,
          newMessageCount: state.newMessageCount
        }),
        viewportLines,
        delta
      });
    });
    return true;
  }

  function handleFooterNavigationInput(
    character: string | undefined,
    key: { ctrl?: boolean; leftArrow?: boolean; rightArrow?: boolean; return?: boolean; escape?: boolean; tab?: boolean }
  ): boolean {
    if (mainPane !== "chat" || footerItems.length === 0) {
      return false;
    }
    if (chatInputState.current.input.value.length > 0) {
      return false;
    }
    const normalized = normalizeActionLogControlCharacter(character);
    if (key.escape) {
      setFooterNavigation((state) => footerNavigationReducer(state, { type: "clear" }, footerItems));
      return true;
    }
    if (key.leftArrow || (key.ctrl && normalized === "p")) {
      setFooterNavigation((state) => footerNavigationReducer(state, { type: "previous" }, footerItems));
      return true;
    }
    if (key.rightArrow || key.tab || (key.ctrl && normalized === "n")) {
      setFooterNavigation((state) => footerNavigationReducer(state, { type: "next" }, footerItems));
      return true;
    }
    if (key.return || (key.ctrl && normalized === "o")) {
      const id = selectedFooterPill(footerNavigation, footerItems)?.id;
      if (id) {
        void openFooterDetail(id);
        return true;
      }
    }
    return false;
  }

  function handleTranscriptSearchInput(
    character: string | undefined,
    key: { ctrl?: boolean; meta?: boolean; return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean; upArrow?: boolean; downArrow?: boolean }
  ): boolean {
    const normalized = normalizeActionLogControlCharacter(character);
    if (!transcriptSearch.active) {
      if (character === "/" && chatInputState.current.input.value.length === 0) {
        const index = buildTranscriptSearchIndex(messages);
        setTranscriptSearch(updateTranscriptSearch(createTranscriptSearchState(), index, ""));
        return true;
      }
      return false;
    }
    const index = buildTranscriptSearchIndex(messages);
    if (key.escape || (key.ctrl && normalized === "c")) {
      setTranscriptSearch((state) => closeTranscriptSearch(state));
      return true;
    }
    if (key.return) {
      const match = currentTranscriptSearchMatch(transcriptSearch);
      if (match) {
        jumpToConversationMessage(match.messageIndex);
        setMessageCursor((state) => messageCursorReducer(state, { type: "select", index: match.messageIndex }, messages));
      }
      setTranscriptSearch((state) => closeTranscriptSearch(state));
      return true;
    }
    if (key.downArrow || (key.ctrl && normalized === "n")) {
      setTranscriptSearch((state) => stepTranscriptSearch(state, 1));
      return true;
    }
    if (key.upArrow || (key.ctrl && normalized === "p")) {
      setTranscriptSearch((state) => stepTranscriptSearch(state, -1));
      return true;
    }
    if (key.backspace || (key.delete && !character)) {
      setTranscriptSearch((state) => updateTranscriptSearch(state, index, state.query.slice(0, -1)));
      return true;
    }
    if (character && !key.ctrl && !key.meta) {
      setTranscriptSearch((state) => updateTranscriptSearch(state, index, `${state.query}${character}`));
      return true;
    }
    return true;
  }

  function handleMessageCursorInput(
    character: string | undefined,
    key: { return?: boolean }
  ): boolean {
    if (mainPane !== "chat" || chatInputState.current.input.value.length > 0) {
      return false;
    }
    const normalized = normalizeActionLogControlCharacter(character);
    if (normalized === "[") {
      setMessageCursor((state) => messageCursorReducer(state, { type: "previous" }, messages));
      return true;
    }
    if (normalized === "]") {
      setMessageCursor((state) => messageCursorReducer(state, { type: "next" }, messages));
      return true;
    }
    if (normalized === "x") {
      setMessageCursor((state) => messageCursorReducer(state, { type: "toggle" }, messages));
      return true;
    }
    if (normalized === "o" || (key.return && messageCursor.selectedIndex !== undefined)) {
      openSelectedMessageDetail();
      return true;
    }
    return false;
  }

  function jumpToConversationMessage(messageIndex: number): void {
    const targetLines = conversationRenderedLineCount(messages.slice(messageIndex + 1), conversationTextColumns(), {
      expandedMessageKeys: messageCursor.expandedKeys
    });
    setConversationViewport((state) => ({
      ...state,
      scrollOffset: Math.max(0, targetLines)
    }));
  }

  function openSelectedMessageDetail(): void {
    const selected = selectedConversationMessage(messageCursor, messages);
    if (!selected) {
      return;
    }
    setLatestDetail(renderConversationMessageDetail(selected.index, selected.message));
    setLatestDetailSource("event");
    setDetailScroll(0);
    setDetailOpen(true);
  }

  function conversationTextColumns(): number {
    return Math.max(20, terminalColumns - 2);
  }

  function conversationBottomRows(): number {
    return conversationBottomRowsForTerminal({
      terminalRows,
      contentRows: conversationPromptRows(0) + completionRows + conversationBottomStatusRows({
        busy: false,
        hasResult: false
      }),
      approval: Boolean(approval),
      pendingPlan: Boolean(pendingPlan)
    });
  }

  function chatInputCapacity(): { maxInputRows: number; maxCompletionRows: number } {
    return conversationInputCapacity({ bottomRows: conversationBottomRows() });
  }

  function chatCompletionOverlayRows(rows: number, bottomRows: number): number {
    const transcriptRows = fullscreenConversationRows(rows, bottomRows);
    const remainingAbovePrompt = Math.max(0, rows - bottomRows - 1);
    return Math.max(1, Math.min(5, transcriptRows, remainingAbovePrompt));
  }

  function renderTaskDetail(): string {
    const taskRows = [...taskStates.entries()].map(([id, state]) =>
      `${statusIcon(state.status)} ${id}${state.attempt ? ` #${state.attempt}` : ""}: ${state.title || "(untitled)"} [${state.status}]`
    );
    const toolRows = toolResults.map((result) =>
      [
        `${result.task_id}${result.attempt ? ` #${result.attempt}` : ""}`,
        `${result.action} [${result.status ?? "unknown"}${result.errorCode ? `/${result.errorCode}` : ""}]`,
        result.summary,
        result.outputRef ? `Full output: ${result.outputRef}` : undefined,
        result.recoverySuggestion ? `Recovery: ${result.recoverySuggestion}` : undefined
      ].filter(Boolean).join(" - ")
    );
    return [
      `Tasks ${taskCompleted}/${taskTotal}`,
      "",
      taskRows.length ? taskRows.join("\n") : "No task state yet.",
      "",
      "Tool Results",
      "",
      toolRows.length ? toolRows.join("\n") : "No tool output yet."
    ].join("\n");
  }

  async function openFooterDetail(id: FooterPillId): Promise<void> {
    setFooterNavigation((state) => footerNavigationReducer(state, { type: "select", id }, footerItems));
    try {
      const detail = await renderFooterDetail(id);
      setLatestDetail(detail);
      setLatestDetailSource("command");
      setDetailScroll(0);
      setDetailOpen(true);
    } catch (error) {
      pushError(error);
    }
  }

  async function renderFooterDetail(id: FooterPillId): Promise<string> {
    if (id === "tasks") {
      return renderTaskDetail();
    }
    if (id === "approvals") {
      const rows = runtime?.listRecentApprovalsForWorkspace(80) ?? [];
      return rows.length ? rows.map(formatApprovalRecord).join("\n\n") : "No approvals recorded.";
    }
    if (id === "cache") {
      return formatPromptCacheDetail(promptCacheStatus);
    }
    if (id === "gateway") {
      return renderGatewayStatusDetail();
    }
    if (id === "symphony") {
      if (!runtime) {
        return "Runtime is not ready.";
      }
      return formatSymphonyStatus(getSymphonyStatus({ runtime, limit: 20 }));
    }
    return renderLspStatusDetail();
  }

  function renderGatewayStatusDetail(): string {
    const sessions = runtime?.listRecentSessionsForWorkspace(20) ?? [];
    const gatewaySessions = sessions.filter((session) => sessionSourceKind(session.source_json) === "gateway");
    return [
      "Gateway",
      "status=local",
      "mode=TUI local process; HTTP Gateway status is available when `swarm serve` is running.",
      "",
      "Recent gateway sessions",
      ...(gatewaySessions.length
        ? gatewaySessions.slice(0, 10).map((session) => `${session.session_id} [${session.status}] ${session.objective}`)
        : ["(none)"]),
      "",
      "Routes",
      "/v1/sessions",
      "/v1/capabilities",
      "/v1/approvals",
      "/v1/symphony",
      "/mcp"
    ].join("\n");
  }

  async function renderLspStatusDetail(): Promise<string> {
    const workspace = runtime?.workspaceRoot() ?? process.cwd();
    const report = await getGlobalLspManager(workspace).status();
    return formatLspStatusReport(report);
  }

  function handleOnboardInput(
    character: string,
    key: { return?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean }
  ): void {
    if (key.return || key.tab) {
      advanceOnboard();
      return;
    }

    setOnboard((state) => {
      const edited = editOnboardFieldInput(state.values[state.field], character, key);
      if (!edited.handled) {
        return state;
      }
      return {
        ...state,
        custom: state.field === "provider" ? isCustomProviderInput(edited.value) : state.custom,
        values: { ...state.values, [state.field]: edited.value },
        error: undefined
      };
    });
  }

  function advanceOnboard(): void {
    const order = onboard.custom || isCustomProviderInput(onboard.values.provider) ? customFieldOrder : fieldOrder;
    const index = order.indexOf(onboard.field);
    if (index < order.length - 1) {
      setOnboard((state) => ({ ...state, field: order[index + 1], custom: isCustomProviderInput(state.values.provider) }));
      return;
    }

    try {
      void saveOnboarding().then((message) => {
        const nextRuntime = createRuntime();
        setRuntime(nextRuntime);
        refreshSettingsSurface(nextRuntime);
        replaceChatTranscript({ role: "system", brief: message });
        setOnboard((state) => ({ ...state, enabled: false }));
      }).catch((error: unknown) => {
        setOnboard((state) => ({
          ...state,
          error: error instanceof Error ? error.message : String(error)
        }));
      });
    } catch (error) {
      setOnboard((state) => ({
        ...state,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async function saveOnboarding(): Promise<string> {
    const values = onboard.values;
    const provider = values.provider.trim();
    if (!provider) {
      throw new Error("Provider is required.");
    }

    if (isCustomProviderInput(provider)) {
      const { id, protocol } = parseCustomProviderInput(provider);
      const model = values.customModel.trim();
      if (!id || !values.customBaseURL.trim() || !model) {
        throw new Error("Custom provider requires id, base URL, and model.");
      }
      addCustomProvider({
        id,
        name: values.customName.trim() || id,
        baseURL: values.customBaseURL.trim(),
        model,
        apiKey: values.apiKey.trim(),
        protocol,
        auth: protocol === "anthropic-messages" ? "x-api-key" : values.apiKey.trim() ? "bearer" : "none",
        apiKeyRequired: protocol === "anthropic-messages" ? true : undefined
      });
      const modelRef = `${id}/${model}`;
      const discovery = await refreshProviderModels(id);
      const discoveredModel = discovery.models[0] ? `${id}/${discovery.models[0]}` : modelRef;
      setModelSelection({
        defaultProvider: id,
        planner: values.planner.trim() || discoveredModel,
        worker: values.worker.trim() || discoveredModel,
        aggregator: values.aggregator.trim() || discoveredModel
      });
      return discovery.error
        ? `Provider configured. Model discovery failed: ${discovery.error}. Swarm chat ready with manual model.`
        : `Provider configured. Discovered ${discovery.models.length} models. Swarm chat ready.`;
    } else if (values.apiKey.trim()) {
      setProviderApiKey(provider, values.apiKey.trim());
    }

    if (!values.planner.trim() || !values.worker.trim() || !values.aggregator.trim()) {
      throw new Error("Planner, worker, and aggregator models are required.");
    }

    setModelSelection({
      defaultProvider: provider,
      planner: values.planner.trim(),
      worker: values.worker.trim(),
      aggregator: values.aggregator.trim()
    });
    return "Provider configured. Swarm chat ready. Enter an objective.";
  }

  async function handleSlashCommand(commandLine: string): Promise<void> {
    try {
      const parsed = parseSlashCommandLine(commandLine);
      if (!parsed) {
        return;
      }
      appendChatTranscriptMessage(slashCommandTranscriptMessage(commandLine));
      const result = await runSlashCommand(parsed.command, parsed.args, parsed);
      if (result.detailSource === "ai") {
        recordAiDetail(result.detail ?? result.brief);
      } else if (result.detail) {
        recordCommandDetail(result.detail, result.autoOpenDetail ?? parsed.command === "help");
      } else {
        clearDetailState();
      }
      const brief = result.detailSource === "ai" ? result.brief : stripCommandDetailHint(result.brief);
      appendChatMessage({
        role: "system",
        brief,
        detail: result.detail,
        preview: detailPreview(result.detail)
      });
    } catch (error) {
      pushError(error);
    }
  }

  async function runSlashCommand(command: string, args: string[], parsed?: ReturnType<typeof parseSlashCommandLine>): Promise<SlashCommandResult> {
    if (command === "help") {
      const includeAdvanced = hasAdvancedSurfaceFlag(args);
      const namespace = stripAdvancedSurfaceFlags(args)[0]?.toLowerCase();
      const detail = renderSlashHelp({ includeAdvanced, namespace });
      return {
        brief: namespace
          ? `${namespace} slash commands.`
          : includeAdvanced
          ? "All slash commands."
          : "Main slash commands. Use /help all for the full catalog.",
        detail,
        autoOpenDetail: includeAdvanced || Boolean(namespace)
      };
    }

    if (command === "work") {
      const subcommand = args[0]?.toLowerCase();
      if (!subcommand) {
        return { brief: "Work commands. Ctrl+O for details.", detail: renderSlashHelp({ namespace: "work" }) };
      }
      if (subcommand === "sessions") return runSlashCommand("session", args.slice(1), parsed);
      if (subcommand === "attempts") return runSlashCommand("attempts", args.slice(1), parsed);
      if (subcommand === "output") return runSlashCommand("output", args.slice(1), parsed);
      if (subcommand === "workers") return runSlashCommand("workers", args.slice(1), parsed);
      if (subcommand === "files" || subcommand === "checks") {
        if (!runtime) throw new Error("Runtime is not ready.");
        const sessionId = args[1] ?? lastSessionId;
        if (!sessionId) throw new Error(`Usage: /work ${subcommand} [session_id]`);
        const snapshot = runtime.getWorkSnapshot(sessionId);
        const rows = subcommand === "files" ? snapshot.changed_files : snapshot.checks;
        const label = subcommand === "files" ? "changed files" : "checks";
        return {
          brief: `${rows.length} ${label} for ${sessionId}. Ctrl+O for details.`,
          detail: rows.length ? rows.join("\n") : `(no ${label})`
        };
      }
      throw new Error("Usage: /work sessions|attempts|output|files|checks|workers");
    }

    if (command === "debug") {
      const subcommand = args[0]?.toLowerCase();
      if (!subcommand) {
        return { brief: "Debug commands. Ctrl+O for details.", detail: renderSlashHelp({ namespace: "debug" }) };
      }
      if (subcommand === "trace") return runSlashCommand("trace", args.slice(1), parsed);
      if (subcommand === "blackboard") return runSlashCommand("blackboard", args.slice(1), parsed);
      if (subcommand === "audit") return runSlashCommand("audit", args.slice(1), parsed);
      if (subcommand === "usage") return runSlashCommand("usage", args.slice(1), parsed);
      if (subcommand === "cache") {
        if (!runtime) throw new Error("Runtime is not ready.");
        const cache = runtime.getPromptCacheStatus();
        return { brief: formatPromptCacheBrief(cache), detail: formatPromptCacheDetail(cache) };
      }
      if (subcommand === "events") {
        const detail = events.slice(-80).map((event) => JSON.stringify(event)).join("\n");
        return { brief: `${Math.min(events.length, 80)} recent runtime events. Ctrl+O for details.`, detail: detail || "No runtime events yet." };
      }
      throw new Error("Usage: /debug trace|blackboard|audit|usage|cache|events");
    }

    if (command === "ext") {
      const subcommand = args[0]?.toLowerCase();
      if (!subcommand) {
        return { brief: "Extension commands. Ctrl+O for details.", detail: renderSlashHelp({ namespace: "ext" }) };
      }
      if (subcommand === "capabilities") return runSlashCommand("capabilities", args.slice(1), parsed);
      if (subcommand === "commands") return runSlashCommand("commands", args.slice(1), parsed);
      if (subcommand === "skills") return runSlashCommand("skills", args.slice(1), parsed);
      if (subcommand === "plugins") return runSlashCommand("plugins", args.slice(1), parsed);
      if (subcommand === "mcp") return runSlashCommand("mcp", args.slice(1), parsed);
      throw new Error("Usage: /ext capabilities|commands|skills|plugins|mcp");
    }

    if (command === "onboard") {
      setOnboard(createOnboardState(true));
      return { brief: "Opening onboarding." };
    }

    if (command === "view") {
      const target = args[0]?.toLowerCase();
      if (!target) {
        return {
          brief: `Current view: ${mainPaneLabels[mainPane]}. Ctrl+O for views.`,
          detail: mainPaneOrder.map((pane) => `${pane}${pane === mainPane ? " (current)" : ""} - ${mainPaneLabels[pane]}`).join("\n")
        };
      }
      const aliases: Record<string, MainPaneId> = {
        trace: "log",
        activity: "agents"
      };
      const pane = (aliases[target] ?? target) as MainPaneId;
      if (!mainPaneOrder.includes(pane)) {
        throw new Error("Usage: /view chat|trace|overview|output|sessions|attempts|agents|blackboard");
      }
      setMainPane(pane);
      if (pane === "chat") {
        setConversationViewport(resetConversationViewport());
      }
      return { brief: `Switched to ${mainPaneLabels[pane]}.` };
    }

    if (command === "provider") {
      const settings = loadSwarmSettings();
      if (!args[0]) {
        const detail = Object.values(settings.providers)
          .map((provider) => `${provider.id} (${provider.protocol}) ${provider.name}`)
          .join("\n");
        const current = settings.models.defaultProvider || "none selected";
        return { brief: `Current provider: ${current}. Ctrl+O for providers.`, detail };
      }
      if (!settings.providers[args[0]]) {
        throw new Error(`Unknown provider: ${args[0]}`);
      }
      setModelSelection({ defaultProvider: args[0] });
      refreshSettingsSurface();
      return { brief: `Default provider set to ${args[0]}.` };
    }

    if (command === "model") {
      const settings = loadSwarmSettings();
      if (!args[0]) {
        return { brief: currentModelBrief(settings), detail: JSON.stringify(settings.models, null, 2) };
      }
      if (["planner", "worker", "aggregator"].includes(args[0])) {
        const role = args[0] as "planner" | "worker" | "aggregator";
        const model = args[1];
        if (!model) {
          throw new Error(`Usage: /model ${role} <provider/model>`);
        }
        setModelSelection({ [role]: model });
        refreshSettingsSurface();
        return { brief: `${role} model set to ${model}.` };
      }
      if (!args[0].includes("/") && !settings.models.defaultProvider) {
        throw new Error("No default provider selected. Use /provider <id> first or pass <provider/model>.");
      }
      const modelRef = args[0].includes("/") ? args[0] : `${settings.models.defaultProvider}/${args[0]}`;
      setModelSelection({ planner: modelRef, worker: modelRef, aggregator: modelRef });
      refreshSettingsSurface();
      return { brief: `Planner, worker, and aggregator set to ${modelRef}.` };
    }

    if (command === "models") {
      const settings = loadSwarmSettings();
      const providerId = args[0] ?? settings.models.defaultProvider;
      if (!providerId) {
        throw new Error("No provider selected. Use /models <provider>.");
      }
      const provider = settings.providers[providerId];
      if (!provider) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      const models = getProviderModels(provider);
      const detail = models.length ? models.join("\n") : "No models configured. Try /refresh-models.";
      return { brief: `${providerId}: ${models.length} models. Ctrl+O for list.`, detail };
    }

    if (command === "refresh-models") {
      const settings = loadSwarmSettings();
      const providerId = args[0] ?? settings.models.defaultProvider;
      if (!providerId) {
        throw new Error("No provider selected. Use /refresh-models <provider>.");
      }
      const result = await refreshProviderModels(providerId);
      refreshSettingsSurface();
      if (result.error) {
        return { brief: `${providerId}: model discovery failed. Ctrl+O for details.`, detail: result.error };
      }
      return { brief: `${providerId}: discovered ${result.models.length} models.`, detail: result.models.join("\n") };
    }

    if (command === "symphony") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const subcommand = args[0]?.toLowerCase();
      if (subcommand === "help") {
        return { brief: "Symphony commands. Ctrl+O for details.", detail: renderSlashHelp({ namespace: "symphony" }) };
      }
      if (subcommand === "status") {
        args = args.slice(1);
      } else if (subcommand === "tick") {
        return runSlashCommand("symphony-tick", args.slice(1), parsed);
      } else if (subcommand === "run-once") {
        return runSlashCommand("symphony-run-once", args.slice(1), parsed);
      } else if (subcommand === "start") {
        return runSlashCommand("symphony-start", args.slice(1), parsed);
      } else if (subcommand === "stop") {
        return runSlashCommand("symphony-stop", args.slice(1), parsed);
      } else if (subcommand === "cleanup") {
        return runSlashCommand("symphony-cleanup", args.slice(1), parsed);
      }
      const status = getSymphonyStatus({
        runtime,
        workflowPath: args[0],
        limit: 100
      });
      if (!status.workflow.ok) {
        throw new Error(`${status.workflow.error.code}: ${status.workflow.error.message}`);
      }
      const detail = formatSymphonyStatus(status);
      return {
        brief: `Symphony: sessions=${status.totals.sessions}, running=${status.totals.running}, retrying=${status.totals.retrying}, capacity=${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "work-items") {
      const workflowPath = args[0];
      const workflow = loadWorkflow(workflowPath);
      if (!workflow.ok) {
        throw new Error(`${workflow.error.code}: ${workflow.error.message}`);
      }
      const source = createWorkSourceFromConfig(normalizeWorkflowConfig(workflow.workflow));
      const [active, terminal] = await Promise.all([
        source.fetchCandidateItems(),
        source.listTerminalItems()
      ]);
      const detail = formatWorkItems(workflow, source.kind, active, terminal);
      return {
        brief: `Work items: active=${active.length}, terminal=${terminal.length}, source=${source.kind}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "symphony-tick" || command === "symphony-run-once") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const parsed = parseSymphonyTickArgs(args);
      const result = await runSymphonyTick({
        runtime,
        workflowPath: parsed.workflowPath,
        createWorkspace: parsed.createWorkspace,
        execute: command === "symphony-run-once",
        maxRunnerTurns: parsed.maxRunnerTurns,
        maxRunnerToolCalls: parsed.maxRunnerToolCalls
      });
      if (!result.workflow.ok) {
        throw new Error(`${result.workflow.error.code}: ${result.workflow.error.message}`);
      }
      const runs = result.runs ?? [];
      return {
        brief: `Symphony ${command === "symphony-run-once" ? "run-once" : "tick"}: candidates=${result.candidates.length}, dispatched=${result.dispatched.length}, skipped=${result.skipped.length}, failed=${result.failed.length}, runs=${runs.length}. Ctrl+O for details.`,
        detail: formatSymphonyTick(result)
      };
    }

    if (command === "symphony-daemon") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const manager = requireSymphonyDaemonManager();
      refreshSymphonyDaemonState(manager);
      const daemonId = args[0];
      const records = daemonId
        ? manager.getRecord(daemonId) ? [manager.getRecord(daemonId) as SymphonyDaemonRecord] : []
        : manager.listRecords();
      if (daemonId && records.length === 0) {
        throw new Error(`Unknown Symphony daemon: ${daemonId}`);
      }
      const detail = formatSymphonyDaemons(records);
      const active = records.filter((record) => record.status === "running" || record.status === "stopping").length;
      return {
        brief: `Symphony daemons: total=${records.length}, active=${active}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "symphony-start") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const parsed = parseSymphonyDaemonStartArgs(args);
      const manager = requireSymphonyDaemonManager();
      const result = await manager.start(parsed);
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      refreshSymphonyDaemonState(manager);
      const detail = formatSymphonyDaemons([result.daemon]);
      return {
        brief: `Symphony daemon ${result.created ? "started" : "already running"}: ${result.daemon.daemon_id} ticks=${result.daemon.tick_count}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "symphony-stop") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const parsed = parseSymphonyDaemonStopArgs(args);
      const manager = requireSymphonyDaemonManager();
      const records = manager.requestStop(parsed);
      refreshSymphonyDaemonState(manager);
      return {
        brief: `Symphony stop requested: ${records.length} daemon(s). Ctrl+O for details.`,
        detail: formatSymphonyDaemons(records)
      };
    }

    if (command === "symphony-cleanup") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const execute = args.includes("--execute") || args.includes("--run");
      const workflowPath = args.find((arg) => !arg.startsWith("--"));
      const result = await cleanupSymphonyWorkspaces({
        runtime,
        workflowPath,
        execute,
        limit: 100
      });
      if (!result.workflow.ok) {
        throw new Error(`${result.workflow.error.code}: ${result.workflow.error.message}`);
      }
      const detail = formatSymphonyCleanup(result);
      return {
        brief: `Symphony cleanup ${result.execute ? "execute" : "dry-run"}: inspected=${result.inspected}, removed=${result.removed}, skipped=${result.skipped}, failed=${result.failed}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "session") {
      if (args[0] === "new") {
        chatSessionId.current = createChatSessionId();
        resetDebugLogger();
        setPendingPlan(undefined);
        setEvents([]);
        replaceChatTranscript(initialSystemMessage);
        lastActionLogEventSignatureRef.current = undefined;
        clearDetailState();
        setTaskWorkState({ taskStates: new Map(), taskTotal: 0, taskCompleted: 0 });
        setToolResults([]);
        setLoopActivity(undefined);
        setWorkers(new Map());
        setHandoffs(new Map());
        setLastSessionId(undefined);
        if (runtime) {
          void symphonyDaemonManager.current?.stopAll("session_new", true);
          symphonyDaemonManager.current = undefined;
          runtime.dispose();
          setRuntime(createRuntime());
        }
        setSymphonyDaemons([]);
        return { brief: "Started a new chat state." };
      }
      if (args[0]) {
        if (!runtime) throw new Error("Runtime is not ready.");
        const snapshot = runtime.getWorkSnapshot(args[0]);
        const detail = formatWorkSnapshot(snapshot);
        return { brief: `${snapshot.session.session_id}: ${snapshot.session.status}, attempts=${snapshot.attempts.length}, changed=${snapshot.changed_files.length}. Ctrl+O for details.`, detail };
      }
      const rows = runtime?.listRecentSessionsForWorkspace(10) ?? [];
      const detail = rows.length
        ? rows.map((row) => `${row.session_id} [${row.status}] ${row.updated_at} ${row.objective}`).join("\n")
        : "No sessions yet.";
      return { brief: `${rows.length} recent sessions. Ctrl+O for details.`, detail };
    }

    if (command === "memory") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId ?? runtime.listRecentSessionsForWorkspace(1)[0]?.session_id;
      if (!sessionId) throw new Error("Usage: /memory [session_id]");
      const snapshot = runtime.getWorkSnapshot(sessionId);
      const detail = formatSessionMemory({
        snapshot,
        memory: runtime.sessionContextStore.renderForSession(sessionId),
        freshness: runtime.renderWorkspaceFreshnessContract({
          sessionId,
          fileScope: snapshot.changed_files,
          reason: "showing remembered context for resume"
        })
      });
      const summary = snapshot.context_summary
        ? `entries=${snapshot.context_summary.entries}, compactions=${snapshot.context_summary.compactions}`
        : "no saved memory";
      return { brief: `Memory for ${sessionId}: ${summary}. Ctrl+O for details.`, detail };
    }

    if (command === "resume" || command === "continue") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const target = parseResumeTarget(runtime, lastSessionId, parsed, args, command);
      const sessionId = target.sessionId;
      if (!sessionId) throw new Error(command === "continue" ? "Usage: /continue [message]" : "Usage: /resume [session_id] [message]");
      const row = runtime.sessionStore.get(sessionId);
      if (!row) throw new Error(`Unknown session: ${sessionId}`);
      const execution = decideResumeExecution({
        command,
        sessionId,
        hasStoredPlan: Boolean(row.plan_json),
        instruction: target.instruction
      });
      const detail = runtime.renderResumePreflight({
        sessionId,
        instruction: execution.instruction,
        sandboxMode: runSandboxMode,
        command,
        route: execution.route
      });
      setBusy(true);
      setLoopActivity(undefined);
      setLoopActivityTimeline([]);
      setLatestResultCard(undefined);
      appendChatMessage({ role: "system", brief: `Resuming ${sessionId}.` });
      const storedPlan = row.plan_json;
      const runPromise = execution.route === "stored_plan"
        ? runtime.execute({ session: restoreSessionFromRow(row), plan: JSON.parse(storedPlan!) as GeneratedPlan })
        : runtime.executeWorkSession({
            session_id: sessionId,
            prompt: buildResumePrompt(runtime, sessionId, execution.instruction),
            sandboxMode: runSandboxMode
          });
      void runPromise.then((result) => {
        const display = formatExecutionResultDisplay(result, runtime);
        setLatestResultCard(result.result_card);
        recordAiDetail(display.detail);
        setLastSessionId(result.session_id);
        appendChatMessage({
          role: "assistant",
          brief: display.brief,
          detail: display.detail,
          preview: display.preview
        });
      }).catch((error: unknown) => {
        pushError(error);
      }).finally(() => setBusy(false));
      return {
        brief: `${command === "continue" ? "Continue" : "Resume"} started for ${sessionId}${execution.route === "stored_plan" ? " from stored plan" : " through local coding loop"}. Ctrl+O for preflight.`,
        detail,
        autoOpenDetail: true
      };
    }

    if (command === "replay") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      if (!sessionId) throw new Error("Usage: /replay <session_id>");
      const detail = runtime.replaySession(sessionId);
      return { brief: `Replay loaded for ${sessionId}. Ctrl+O for details.`, detail };
    }

    if (command === "fork") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0];
      if (!sessionId) throw new Error("Usage: /fork <session_id> [message]");
      const planned = await runtime.forkSession(sessionId, args.slice(1).join(" ").trim() || undefined);
      setPendingPlan(planned);
      setLastSessionId(planned.session.session_id);
      return {
        brief: `Fork planned as ${planned.session.session_id}. Use the normal execution controls to run it.`,
        detail: JSON.stringify(planned.plan, null, 2)
      };
    }

    if (command === "tasks") {
      if (args[0] && runtime) {
        const rows = runtime.taskStateStore.list(args[0]);
        const detail = rows.length
          ? rows.map((task) => `${task.task_id} [${task.status}] #${task.attempt} ${task.title}${task.last_error ? ` - ${task.last_error}` : ""}`).join("\n")
          : "No persisted task state for this session.";
        return { brief: `${rows.length} persisted task states. Ctrl+O for details.`, detail };
      }
      const rows = [...taskStates.entries()];
      const detail = rows.length
        ? rows.map(([id, state]) => `${id} [${state.status}${state.attempt ? ` attempt ${state.attempt}` : ""}] ${state.title}`).join("\n")
        : "No active task state in this chat.";
      return { brief: `${rows.length} task states. Ctrl+O for details.`, detail };
    }

    if (command === "graph") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      if (!sessionId) throw new Error("Usage: /graph [session_id]");
      const graph = runtime.getTaskGraph(sessionId);
      const edgeLines = graph.edges.length
        ? graph.edges.map((edge) => `${edge.task_id} <- ${edge.depends_on_task_id}`)
        : ["(no dependency edges)"];
      const detail = [
        `${sessionId}: ${graph.tasks.length} tasks`,
        "",
        "Tasks",
        ...graph.tasks.map((task) => `${task.task_id} [${task.status}] #${task.attempt} deps=${task.dependencies.join(",") || "-"} ${task.title}`),
        "",
        "Edges",
        ...edgeLines
      ].join("\n");
      return { brief: `${graph.tasks.length} task graph nodes for ${sessionId}. Ctrl+O for details.`, detail };
    }

    if (command === "task") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const taskId = args[0];
      const sessionId = args[1] ?? lastSessionId;
      if (!taskId || !sessionId) throw new Error("Usage: /task <task_id> [session_id]");
      const detail = JSON.stringify(runtime.getTaskDetail(sessionId, taskId), null, 2);
      return { brief: `Task ${taskId}. Ctrl+O for details.`, detail };
    }

    if (command === "trace") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0];
      if (!sessionId) throw new Error("Usage: /trace <session_id>");
      const trace = runtime.traceStore.list(sessionId);
      const detail = trace.length
        ? trace.map((env) => `${env.created_at} ${env.type} ${env.from.agent_id ?? env.from.role ?? "?"} -> ${Array.isArray(env.to) ? env.to.length : env.to.agent_id ?? env.to.capability ?? env.to.role ?? "?"} ${env.task_id ?? ""} ${env.trace?.trace_id ?? ""}/${env.trace?.span_id ?? ""}`).join("\n")
        : "No trace envelopes for this session.";
      return { brief: `${trace.length} trace envelopes. Ctrl+O for details.`, detail };
    }

    if (command === "attempts") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      const rows = sessionId
        ? runtime.runAttemptStore.list(sessionId, 120)
        : runtime.listRecentAttemptsForWorkspace(50);
      const detail = rows.length
        ? rows.map(formatRunAttempt).join("\n\n")
        : sessionId
          ? `No run attempts recorded for ${sessionId}.`
          : "No run attempts recorded.";
      return {
        brief: `${rows.length} attempts${sessionId ? ` for ${sessionId}` : " in this workspace"}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "leases") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const target = args[0] ?? lastSessionId;
      const rows = target
        ? leaseRowsForTarget(runtime, target)
        : runtime.listRecentLeasesForWorkspace(50);
      const detail = rows.length
        ? rows.map(formatWorkspaceLease).join("\n\n")
        : target
          ? `No workspace leases recorded for ${target}.`
          : "No workspace leases recorded.";
      return {
        brief: `${rows.length} workspace leases${target ? ` for ${target}` : " in this workspace"}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "span") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const id = args[0];
      if (!id) throw new Error("Usage: /span <trace_id|span_id>");
      const sessions = runtime.listRecentSessionsForWorkspace(50);
      const trace = sessions.flatMap((session) => runtime.traceStore.list(session.session_id))
        .filter((env) => env.trace?.trace_id === id || env.trace?.span_id === id || env.id === id);
      const audit = runtime.auditStore.listByTrace(id);
      const detail = [
        `Trace/span ${id}`,
        "",
        "Envelopes",
        ...(trace.length ? trace.map((env) => `${env.created_at} ${env.type} ${env.session_id} ${env.task_id ?? ""} ${env.intent}`) : ["(none)"]),
        "",
        "Audit",
        ...(audit.length ? audit.map(formatAuditRecord) : ["(none)"])
      ].join("\n");
      return { brief: `${trace.length} envelopes, ${audit.length} audit records. Ctrl+O for details.`, detail };
    }

    if (command === "approvals") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      const rows = sessionId ? runtime.listApprovalsForSessionFamily(sessionId, 80) : runtime.listRecentApprovalsForWorkspace(80);
      const detail = rows.length ? rows.map(formatApprovalRecord).join("\n\n") : "No approvals recorded.";
      return { brief: `${rows.length} approvals${sessionId ? ` for ${sessionId}` : " in this workspace"}. Ctrl+O for details.`, detail };
    }

    if (command === "approval") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const approvalId = args[0];
      if (!approvalId) return runSlashCommand("approvals", [], parsed);
      const approval = runtime.approvalStore.get(approvalId);
      if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
      return { brief: `${approval.approval_id}: ${approval.status}. Ctrl+O for details.`, detail: formatApprovalRecord(approval) };
    }

    if (command === "audit") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      const rows = runtime.auditStore.list(sessionId, 100);
      const detail = rows.length ? rows.map(formatAuditRecord).join("\n") : "No audit records.";
      return { brief: `${rows.length} audit records${sessionId ? ` for ${sessionId}` : ""}. Ctrl+O for details.`, detail };
    }

    if (command === "budget" || command === "usage") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      if (!sessionId) throw new Error(`Usage: /${command} [session_id]`);
      const session = runtime.sessionStore.get(sessionId);
      const summary = runtime.usageStore.summarize(sessionId);
      const detail = [
        `${sessionId}`,
        "",
        "Policy budget",
        session?.policy_json ? JSON.stringify(JSON.parse(session.policy_json).budget ?? {}, null, 2) : "(no persisted session policy)",
        "",
        "Usage",
        JSON.stringify(summary, null, 2)
      ].join("\n");
      return { brief: `${sessionId} usage: ${Object.keys(summary).length} counters. Ctrl+O for details.`, detail };
    }

    if (command === "output") {
      const taskId = args[0];
      if (!taskId) {
        const detail = toolResults.length
          ? toolResults
              .map((result) => formatToolOutputPreview(result))
              .join("\n\n")
          : "No tool outputs in this chat.";
        const latest = toolResults[toolResults.length - 1];
        return {
          brief: latest
            ? `${toolResults.length} tool outputs. Latest: ${latest.action} ${latest.summary}.`
            : "No tool outputs in this chat.",
          detail
        };
      }
      const result = [...toolResults].reverse().find((item) => item.task_id === taskId);
      if (!result) {
        throw new Error(`No output found for task: ${taskId}`);
      }
      const detail = result.outputRef ? await readTaskOutput(result.outputRef) : result.content ?? result.summary;
      return {
        brief: `${result.action}: ${result.summary}.`,
        detail: [detail, result.recoverySuggestion ? `Recovery: ${result.recoverySuggestion}` : undefined].filter(Boolean).join("\n\n")
      };
    }

    if (command === "diff") {
      return executeSlashTool({ action: "git.diff", cwd: "." });
    }

    if (command === "changes") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      const rows = runtime.listWorkspaceChanges(sessionId);
      const detail = rows.length
        ? rows.map(formatBlackboardEntry).join("\n\n")
        : "No workspace changes recorded.";
      return { brief: `${rows.length} workspace changes${sessionId ? ` for ${sessionId}` : ""}. Ctrl+O for details.`, detail };
    }

    if (command === "blackboard") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const first = args[0];
      const hasSessionArg = first?.startsWith("sess_") || first?.startsWith("loop_") || first?.startsWith("worker_loop_");
      const sessionId = hasSessionArg ? first : lastSessionId;
      const queryTokens = hasSessionArg ? args.slice(1) : args;
      const query = parseBlackboardQuery(queryTokens);
      const rows = runtime.listBlackboardEntries(sessionId, query).slice(0, 80);
      const detail = rows.length
        ? rows.map(formatBlackboardEntry).join("\n\n")
        : "No blackboard entries matched.";
      return { brief: `${rows.length} blackboard entries${sessionId ? ` for ${sessionId}` : ""}. Ctrl+O for details.`, detail };
    }

    if (command === "capabilities") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const includeAdvanced = hasAdvancedSurfaceFlag(args);
      const surfaceArgs = stripAdvancedSurfaceFlags(args);
      const filter = parseCapabilityCommandFilter(surfaceArgs);
      const [capabilities, providers] = await Promise.all([
        runtime.listCapabilities(filter),
        runtime.listCapabilityProviders()
      ]);
      const detail = includeAdvanced || hasCapabilityCommandFilter(filter)
        ? formatCapabilities(capabilities, providers)
        : formatCapabilitySummary(capabilities, providers);
      return {
        brief: includeAdvanced || hasCapabilityCommandFilter(filter)
          ? `${capabilities.length} capabilities across ${providers.length} providers. Ctrl+O for details.`
          : `${capabilities.length} capabilities across ${providers.length} providers. Use /capabilities all for the full catalog.`,
        detail
      };
    }

    if (command === "capability-enable" || command === "capability-disable" || command === "capability-show" || command === "capability-hide") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const capabilityId = args[0];
      if (!capabilityId) {
        throw new Error(`Usage: /${command} <capability_id>`);
      }
      if (command === "capability-enable" || command === "capability-disable") {
        setCapabilityEnabled(capabilityId, command === "capability-enable");
      } else {
        setCapabilityModelVisible(capabilityId, command === "capability-show");
      }
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const capability = await runtime.getCapability(capabilityId);
      return {
        brief: `Capability ${capabilityId} updated. Ctrl+O for details.`,
        detail: capability ? formatCapabilities([capability], await runtime.listCapabilityProviders()) : `Capability setting saved for ${capabilityId}.`
      };
    }

    if (command === "plugins") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const includeAdvanced = hasAdvancedSurfaceFlag(args);
      const surfaceArgs = stripAdvancedSurfaceFlags(args);
      const pluginId = surfaceArgs[0];
      const plugins = runtime.listPlugins();
      const selected = pluginId ? plugins.filter((plugin) => plugin.id === pluginId) : plugins;
      if (pluginId && selected.length === 0) {
        throw new Error(`Unknown plugin: ${pluginId}`);
      }
      return {
        brief: includeAdvanced || pluginId
          ? `${selected.length} plugin${selected.length === 1 ? "" : "s"}. Ctrl+O for details.`
          : `${plugins.length} plugins discovered. Use /plugins all for the full catalog.`,
        detail: includeAdvanced || pluginId ? formatPlugins(selected) : formatPluginsSummary(plugins)
      };
    }

    if (command === "plugin-install" || command === "plugin-remove-root") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const root = args[0];
      if (!root) {
        throw new Error(`Usage: /${command} <root_path>`);
      }
      if (command === "plugin-install") {
        installPluginRoot(root);
      } else {
        removePluginRoot(root);
      }
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const plugins = runtime.listPlugins();
      return {
        brief: `Plugin root ${command === "plugin-install" ? "installed" : "removed"}. Ctrl+O for plugin list.`,
        detail: formatPlugins(plugins)
      };
    }

    if (command === "plugin-update") {
      if (!runtime) throw new Error("Runtime is not ready.");
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const plugins = runtime.listPlugins();
      return {
        brief: `Plugin catalog refreshed: ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}. Ctrl+O for details.`,
        detail: formatPlugins(plugins)
      };
    }

    if (command === "plugin-enable" || command === "plugin-disable") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const pluginId = args[0];
      if (!pluginId) {
        throw new Error(`Usage: /${command} <plugin_id>`);
      }
      const enabled = command === "plugin-enable";
      setPluginEnabled(pluginId, enabled);
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const plugins = runtime.listPlugins();
      const selected = plugins.find((plugin) => plugin.id === pluginId);
      return {
        brief: `Plugin ${pluginId} ${enabled ? "enabled" : "disabled"}. Ctrl+O for plugin list.`,
        detail: selected ? formatPlugins([selected]) : formatPlugins(plugins)
      };
    }

    if (command === "commands") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const commands = runtime.listCustomCommands();
      const plugins = runtime.listPlugins();
      const pluginSlashCommands = listTrustedPluginSlashCommands(plugins);
      const active = commands.filter((item) => !item.shadowedBy).length;
      return {
        brief: hasAdvancedSurfaceFlag(args)
          ? `${active} custom commands, ${pluginSlashCommands.length} plugin slash commands, ${commands.length - active} shadowed. Ctrl+O for details.`
          : `${active} custom commands, ${pluginSlashCommands.length} plugin slash commands, ${commands.length - active} shadowed. Use /commands all for the full catalog.`,
        detail: hasAdvancedSurfaceFlag(args)
          ? [
            formatCustomCommands(commands),
            formatPluginSlashCommands(pluginSlashCommands)
          ].filter(Boolean).join("\n\n")
          : [
            formatCustomCommandsSummary(commands),
            formatPluginSlashCommandsSummary(pluginSlashCommands)
          ].filter(Boolean).join("\n\n")
      };
    }

    if (command === "skills") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const skills = runtime.listSkills();
      const active = skills.filter((skill) => !skill.shadowedBy).length;
      return {
        brief: hasAdvancedSurfaceFlag(args)
          ? `${active} active skills, ${skills.length - active} shadowed. Ctrl+O for details.`
          : `${active} active skills, ${skills.length - active} shadowed. Use /skills all for the full catalog.`,
        detail: hasAdvancedSurfaceFlag(args) ? formatSkills(skills) : formatSkillsSummary(skills)
      };
    }

    if (command === "skill") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const name = args[0];
      if (!name) throw new Error("Usage: /skill <name>");
      const skill = runtime.activateSkill(name, lastSessionId, "tui slash command");
      return {
        brief: `Skill activated: ${skill.name}. Ctrl+O for instructions.`,
        detail: formatActivatedSkill(skill)
      };
    }

    if (command === "mcp") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const includeAdvanced = hasAdvancedSurfaceFlag(args);
      const surfaceArgs = stripAdvancedSurfaceFlags(args);
      const serverId = surfaceArgs[0];
      const servers = runtime.listMcpServers();
      const selected = serverId ? servers.filter((server) => server.id === serverId) : servers;
      if (serverId && selected.length === 0) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }
      return {
        brief: includeAdvanced || serverId
          ? `${selected.length} MCP server${selected.length === 1 ? "" : "s"}. Ctrl+O for details.`
          : `${servers.length} MCP servers configured. Use /mcp all for the full catalog.`,
        detail: includeAdvanced || serverId ? formatMcpServers(selected) : formatMcpServersSummary(servers)
      };
    }

    if (command === "mcp-refresh") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const serverId = args[0];
      if (!serverId) throw new Error("Usage: /mcp-refresh <server_id>");
      const server = await runtime.refreshMcpServer(serverId);
      const capabilities = await runtime.listCapabilities({ providerId: `mcp:${serverId}`, includeDisabled: true });
      return {
        brief: `MCP ${server.id}: ${server.status}, tools=${server.toolCount}. Ctrl+O for details.`,
        detail: [
          formatMcpServers([server]),
          "",
          "Capabilities",
          capabilities.length ? capabilities.map((capability) => `${capability.id} ${capability.title ?? capability.name}`).join("\n") : "(none)"
        ].join("\n")
      };
    }

    if (command === "mcp-resources") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const serverId = args[0];
      if (!serverId) throw new Error("Usage: /mcp-resources <server_id>");
      const resources = runtime.listMcpResources(serverId);
      return {
        brief: `${resources.length} MCP resources from ${serverId}. Ctrl+O for details.`,
        detail: resources.length ? resources.map(formatMcpResource).join("\n\n") : "No MCP resources exposed."
      };
    }

    if (command === "mcp-read") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const serverId = args[0];
      const uri = args[1];
      if (!serverId || !uri) throw new Error("Usage: /mcp-read <server_id> <uri>");
      const result = await runtime.readMcpResource(serverId, uri);
      return {
        brief: `MCP resource ${uri}. Ctrl+O for contents.`,
        detail: formatMcpResourceReadResult(result)
      };
    }

    if (command === "mcp-prompts") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const serverId = args[0];
      if (!serverId) throw new Error("Usage: /mcp-prompts <server_id>");
      const prompts = runtime.listMcpPrompts(serverId);
      return {
        brief: `${prompts.length} MCP prompts from ${serverId}. Ctrl+O for details.`,
        detail: prompts.length ? prompts.map(formatMcpPrompt).join("\n\n") : "No MCP prompts exposed."
      };
    }

    if (command === "mcp-prompt") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const serverId = args[0];
      const name = args[1];
      if (!serverId || !name) throw new Error("Usage: /mcp-prompt <server_id> <name> [key=value...]");
      const result = await runtime.getMcpPrompt(serverId, name, parseKeyValueArgs(args.slice(2)));
      return {
        brief: `MCP prompt ${name}. Ctrl+O for rendered messages.`,
        detail: formatMcpPromptResult(result)
      };
    }

    if (command === "agents") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const specs = runtime.listAgentSpecs();
      const detail = specs.map((spec) => [
        `${spec.id} [${spec.role}/${spec.write_policy}]`,
        spec.description,
        `when: ${spec.when_to_use}`,
        `tools: ${spec.tools.join(", ")}`
      ].join("\n")).join("\n\n");
      return { brief: `${specs.length} agent specs. Ctrl+O for details.`, detail };
    }

    if (command === "agent") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const agentId = args[0];
      if (!agentId) throw new Error("Usage: /agent <agent_spec_id>");
      const detail = runtime.renderAgentSpec(agentId);
      if (!detail) throw new Error(`Unknown agent spec: ${agentId}`);
      return { brief: `Agent spec ${agentId}. Ctrl+O for details.`, detail };
    }

    if (command === "workers") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const rows = runtime.listRecentWorkersForWorkspace(30);
      const detail = rows.length
        ? rows.map(formatWorkerBrief).join("\n")
        : "No persisted workers yet.";
      return { brief: `${rows.length} workers in this workspace. Ctrl+O for details.`, detail };
    }

    if (command === "worker") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const workerId = args[0];
      if (!workerId) throw new Error("Usage: /worker <worker_id>");
      const worker = runtime.workerStateStore.get(workerId);
      if (!worker) throw new Error(`Unknown worker: ${workerId}`);
      return { brief: `${worker.worker_id}: ${worker.status}. Ctrl+O for details.`, detail: formatWorkerDetail(worker) };
    }

    if (command === "stop-worker") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const workerId = args[0];
      if (!workerId) throw new Error("Usage: /stop-worker <worker_id>");
      runtime.stopWorker(workerId);
      return { brief: `Stop requested for ${workerId}.` };
    }

    if (command === "continue-agent") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const workerId = args[0];
      const message = parsed ? rawSlashArgsAfter(parsed, 1) : args.slice(1).join(" ").trim();
      if (!workerId || !message) throw new Error("Usage: /continue-agent <worker_id> <message>");
      const result = await runtime.continueAgent(workerId, message);
      return { brief: result.summary, detail: result.content ?? JSON.stringify(result.data, null, 2) };
    }

    if (command === "handoffs") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const rows = runtime.listHandoffsForWorkspace(30);
      const detail = rows.length
        ? rows.map(formatHandoff).join("\n\n")
        : "No handoff sessions yet.";
      return { brief: `${rows.length} handoffs in this workspace. Ctrl+O for details.`, detail };
    }

    if (command === "handoff") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const handoffId = args[0];
      if (!handoffId) throw new Error("Usage: /handoff <handoff_id>");
      const handoff = runtime.getHandoff(handoffId);
      if (!handoff) throw new Error(`Unknown handoff: ${handoffId}`);
      return { brief: `${handoff.handoff_id}: ${handoff.status}. Ctrl+O for details.`, detail: formatHandoff(handoff) };
    }

    if (command === "takeback") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const handoffId = args[0];
      if (!handoffId) throw new Error("Usage: /takeback <handoff_id>");
      const handoff = runtime.takeBackHandoff(handoffId);
      return { brief: `Handoff ${handoff.handoff_id} is ${handoff.status}.` };
    }

    if (command === "why") {
      const detail = formatWhyReport(events);
      return { brief: "Recent route, delegation, worker, review, and verification decisions.", detail };
    }

    if (command === "self-review") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const review = await runtime.selfReview();
      const detail = [
        review.summary,
        "",
        "Findings",
        ...review.findings.map((item) => `- ${item}`),
        "",
        "Recommendations",
        ...review.recommendations.map((item) => `- ${item}`)
      ].join("\n");
      return { brief: review.summary, detail, detailSource: "ai" };
    }

    if (command === "improve-self") {
      if (!runtime) throw new Error("Runtime is not ready.");
      setBusy(true);
      try {
        const result = await runtime.improveSelf();
        const display = formatExecutionResultDisplay(result, runtime);
        recordAiDetail(display.detail);
        setLastSessionId(result.session_id);
        return { brief: display.brief, detail: display.detail, detailSource: "ai" };
      } finally {
        setBusy(false);
      }
    }

    if (command === "evals") {
      const results = runLocalEvals();
      if (runtime) {
        for (const result of results) {
          runtime.events.emitEvent({ type: "eval_result", ...result });
        }
      }
      const failed = results.filter((result) => result.status === "fail");
      const detail = results.map((result) => `${result.status === "pass" ? "OK" : "!!"} ${result.name}: ${result.message}`).join("\n");
      return { brief: `${results.length - failed.length}/${results.length} evals passed.`, detail };
    }

    if (command === "prd") {
      const path = resolve(process.cwd(), "docs/PRD.md");
      const detail = readFileSync(path, "utf8");
      return { brief: "Swarm PRD loaded.", detail };
    }

    if (command === "doctor") {
      const detail = await formatDoctorReport(runtime, args[0]);
      const failed = detail.split(/\r?\n/).filter((line) => line.startsWith("FAIL ")).length;
      const warnings = detail.split(/\r?\n/).filter((line) => line.startsWith("WARN ")).length;
      return {
        brief: `Doctor: ${failed} failed, ${warnings} warnings.`,
        detail
      };
    }

    if (command === "kernel" || command === "status") {
      const workflowPath = args.find((arg, index) => !arg.startsWith("--") && !isOptionValue(args, index));
      const status = runtime
        ? getSymphonyStatus({ runtime, workflowPath, limit: 20 })
        : undefined;
      const activeDaemons = symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping").length;
      const detail = formatKernelStatusView({
        runtime,
        busy,
        runMode,
        lastRoute,
        lastSessionId,
        taskCompleted,
        taskTotal,
        taskStates,
        toolResults,
        workers,
        handoffs,
        symphonyStatus: status,
        symphonyDaemons,
        cacheStatus: runtime?.getPromptCacheStatus(),
        events
      });
      const sessionCount = runtime?.listRecentSessionsForWorkspace(100).length ?? 0;
      return {
        brief: `Kernel: ${busy ? "running" : "idle"}, sessions=${sessionCount}, workers=${workers.size}, symphony=${activeDaemons}.`,
        detail
      };
    }

    if (command === "interrupt") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const message = parsed?.rawArgs || args.join(" ").trim() || "User requested an interrupt. Reassess before continuing.";
      const target = runtime.requestInterrupt(message);
      setLastSessionId(target.session_id);
      const detail = [
        "Interrupt Request",
        `Session: ${target.session_id}`,
        `Route: ${target.route}`,
        `Message: ${message}`
      ].join("\n");
      return {
        brief: `Interrupt requested for ${target.session_id} (${target.route}). Ctrl+O for details.`,
        detail
      };
    }

    if (command === "reply") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const message = parsed?.rawArgs || args.join(" ").trim();
      if (!message) throw new Error("Usage: /reply <message>");
      const target = await runtime.sendUserMessage(message);
      setLastSessionId(target.session_id);
      const detail = [
        "Live Reply",
        `Session: ${target.session_id}`,
        `Route: ${target.route}`,
        `Message: ${message}`
      ].join("\n");
      return {
        brief: `Live reply sent to ${target.session_id} (${target.route}). Ctrl+O for details.`,
        detail
      };
    }

    if (command === "permissions") {
      return buildPermissionsCommandResult();
    }

    if (command === "add-dir") {
      if (!args[0]) {
        throw new Error("Usage: /add-dir <directory>");
      }
      const directory = addPermissionAdditionalDirectory(args[0]);
      const settings = refreshSettingsSurface();
      const report = buildPermissionsCommandResult(settings);
      return {
        brief: `Additional read directory added: ${directory}. Ctrl+O for details.`,
        detail: report.detail
      };
    }

    if (command === "remove-dir") {
      if (!args[0]) {
        throw new Error("Usage: /remove-dir <directory>");
      }
      const removed = removePermissionAdditionalDirectory(args[0]);
      const settings = refreshSettingsSurface();
      const report = buildPermissionsCommandResult(settings);
      return {
        brief: removed
          ? `Additional read directory removed: ${args[0]}. Ctrl+O for details.`
          : `Additional read directory not found: ${args[0]}. Ctrl+O for details.`,
        detail: report.detail
      };
    }

    if (command === "permission-mode") {
      const mode = args[0];
      if (!mode) {
        return buildPermissionsCommandResult();
      }
      if (!isPermissionMode(mode)) {
        throw new Error("Usage: /permission-mode ask|auto-edit|full-auto|yolo");
      }
      setPermissionMode(mode);
      const settings = refreshSettingsSurface();
      const report = buildPermissionsCommandResult(settings);
      return {
        brief: `Permission mode set to ${mode}. Ctrl+O for details.`,
        detail: report.detail
      };
    }

    if (command === "sandbox") {
      const next = applySandboxModeCommand(runSandboxMode, args[0]);
      if (next.changed) {
        setRunSandboxMode(next.mode);
      }
      const report = buildSandboxReport({
        mode: next.mode,
        permissionMode: settingsSnapshot.permissions.defaultMode,
        workspace: runtime?.workspaceRoot() ?? process.cwd(),
        additionalDirectories: settingsSnapshot.permissions.additionalDirectories
      });
      return {
        brief: next.changed ? `${next.brief} Ctrl+O for details.` : `${report.brief} Ctrl+O for details.`,
        detail: report.detail
      };
    }

    if (command === "mode") {
      const mode = args[0];
      if (!mode) {
        return { brief: `Execution mode: ${runMode}. Auto prefers the local coding loop; swarm is experimental.` };
      }
      const normalized = normalizeRunMode(mode);
      setRunMode(normalized);
      return {
        brief: normalized === "full_swarm"
          ? "Execution mode set to full_swarm. This path is experimental; use it for explicit multi-agent tasks."
          : `Execution mode set to ${normalized}.`
      };
    }

    if (command === "checkpoint") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const subcommand = args[0]?.toLowerCase() ?? "list";
      if (subcommand === "list") {
        const checkpoints = await runtime.listCheckpoints(20);
        const detail = checkpoints.length
          ? checkpoints.map((checkpoint) => `${checkpoint.id} [${checkpoint.status}/${checkpoint.mode}] ${checkpoint.name}${checkpoint.revertAvailable ? " revert:yes" : " revert:no"}`).join("\n")
          : "No checkpoints recorded.";
        return { brief: `${checkpoints.length} checkpoint(s).`, detail };
      }
      if (subcommand === "create") {
        const name = args.slice(1).join(" ").trim() || `manual-${new Date().toISOString()}`;
        const checkpoint = await runtime.createCheckpoint(name, "manual TUI checkpoint");
        return { brief: `Checkpoint created: ${checkpoint.name} (${checkpoint.id}).` };
      }
      if (subcommand === "revert") {
        const id = args[1] && args[1] !== "last" ? args[1] : undefined;
        const checkpoint = await runtime.revertCheckpoint(id);
        if (!checkpoint) throw new Error("No checkpoint found to revert.");
        return { brief: `Reverted checkpoint: ${checkpoint.name} (${checkpoint.id}).` };
      }
      throw new Error("Usage: /checkpoint list|create <name>|revert [checkpoint_id|last]");
    }

    if (command === "revert") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const id = args[0] && args[0] !== "last" ? args[0] : undefined;
      const checkpoint = await runtime.revertCheckpoint(id);
      if (!checkpoint) throw new Error("No checkpoint found to revert.");
      return { brief: `Reverted checkpoint: ${checkpoint.name} (${checkpoint.id}).` };
    }

    if (command === "read") {
      const path = args[0];
      if (!path) {
        throw new Error("Usage: /read <path> [start:end]");
      }
      const range = parseLineRange(args[1]);
      return executeSlashTool({
        action: "file.read",
        path,
        startLine: range.startLine,
        endLine: range.endLine
      });
    }

    if (command === "grep") {
      const pattern = args[0];
      if (!pattern) {
        throw new Error("Usage: /grep <pattern> [root]");
      }
      return executeSlashTool({
        action: "file.grep",
        pattern,
        root: args[1] ?? ".",
        maxMatches: 100,
        contextLines: 0
      });
    }

    if (command === "glob") {
      const pattern = args[0];
      if (!pattern) {
        throw new Error("Usage: /glob <pattern> [root]");
      }
      return executeSlashTool({
        action: "file.glob",
        pattern,
        root: args[1] ?? ".",
        maxResults: 200
      });
    }

    if (command === "shell") {
      const shellCommand = slashRawRemainderOrSingleQuotedArg(parsed, args, 0);
      if (!shellCommand) {
        throw new Error("Usage: /shell <command>");
      }
      return executeSlashTool({
        action: "shell.exec",
        command: shellCommand,
        timeoutMs: 120_000,
        maxOutputBytes: 200_000
      });
    }

    if (command === "web") {
      const parsed = parseWebCommandArgs(args);
      if (!parsed.query) {
        throw new Error("Usage: /web <query> [allow:domain] [block:domain]");
      }
      return executeSlashTool({
        action: "web.search",
        query: parsed.query,
        allowed_domains: parsed.allowed_domains,
        blocked_domains: parsed.blocked_domains
      });
    }

    const customSlash = runtime?.getCustomCommand(command);
    if (customSlash) {
      return runCustomSlashCommand(customSlash, parsed?.rawArgs ?? args.join(" "));
    }

    const pluginSlash = runtime ? findPluginSlashCommand(runtime.listPlugins(), command) : undefined;
    if (pluginSlash) {
      return runPluginSlashCommand(pluginSlash, parsed?.rawArgs ?? args.join(" "));
    }

    throw new Error(`Unknown command: /${command}. Try /help.`);
  }

  async function runPluginSlashCommand(
    command: {
      plugin: PluginRecord;
      contribution: PluginRecord["contributions"][number];
    },
    rawArgs: string
  ): Promise<SlashCommandResult> {
    if (!runtime) throw new Error("Runtime is not ready.");
    const objective = renderPluginSlashCommandObjective(command.plugin, command.contribution, rawArgs);
    setBusy(true);
    setLoopActivity(undefined);
    setLoopActivityTimeline([]);
    try {
      const result = await runtime.run(objective, { mode: runMode, sandboxMode: runSandboxMode });
      const display = formatExecutionResultDisplay(result, runtime);
      return {
        brief: `${display.brief} via /${command.contribution.id}.`,
        detail: display.detail,
        detailSource: "ai"
      };
    } finally {
      setBusy(false);
    }
  }

  async function runCustomSlashCommand(command: CustomCommandRecord, rawArgs: string): Promise<SlashCommandResult> {
    if (!runtime) throw new Error("Runtime is not ready.");
    if (command.trust === "disabled" || command.trust === "untrusted") {
      throw new Error(`Custom command is not trusted in this workspace: /${command.name}`);
    }
    const objective = renderCustomCommandObjective(command, rawArgs);
    setBusy(true);
    setLoopActivity(undefined);
    setLoopActivityTimeline([]);
    try {
      const result = await runtime.run(objective, { mode: runMode, sandboxMode: runSandboxMode });
      const display = formatExecutionResultDisplay(result, runtime);
      return {
        brief: `${display.brief} via /${command.name}.`,
        detail: display.detail,
        detailSource: "ai"
      };
    } finally {
      setBusy(false);
    }
  }

  async function executeSlashTool(inputs: Record<string, unknown>): Promise<SlashCommandResult> {
    runtime?.ensureTuiChatSession(chatSessionId.current);
    const settings = loadSwarmSettings();
    const action = normalizeToolAction(inputs);
    appendChatTranscriptMessage(slashToolUseTranscriptMessage(action));
    const provider = new OpenAIProvider();
    const workspace = process.cwd();
    const result = await (async (): Promise<ToolResult> => {
      assertToolActionAllowedBySandbox(action, {
        writePolicy: runSandboxMode === "read-only" ? "read_only" : undefined,
        workspace
      });
      const permissionDecision = decideToolPermission(action, settings, { workspace });
      if (permissionDecision.decision === "deny") {
        throw new Error(`Tool action denied by ~/.swarm/settings.json permissions: ${action.type}`);
      }
      if (permissionDecision.decision === "ask") {
        const request = createToolApprovalRequest(action, permissionDecision);
        request.session_id = chatSessionId.current;
        request.task_id = `slash.${action.type}`;
        runtime?.events.emitEvent({ type: "approval", request, status: "pending" });
        const approved = await requestToolApproval(request);
        runtime?.events.emitEvent({ type: "approval", request, status: approved ? "approved" : "denied" });
        if (!approved) {
          throw new Error(`Tool action denied: ${action.type}`);
        }
      }
      return runLocalTool(action, {
        workspace,
        settings,
        sessionId: chatSessionId.current,
        taskId: `slash.${action.type}`,
        serverWebSearch: (searchAction) => provider.webSearch(searchAction)
      });
    })().catch((error: unknown) => slashToolFailureResult(action.type, error));
    const sandbox = sandboxDecisionFromUnknown(result.metadata?.sandbox ?? result.data);
    const prepared = await prepareSlashToolOutput(chatSessionId.current, `slash.${action.type}`, result);
    runtime?.events.emitEvent({
      type: "tool_result",
      session_id: chatSessionId.current,
      task_id: `slash.${action.type}`,
      title: "TUI slash tool",
      action: action.type,
      summary: result.summary,
      content: prepared.content,
      status: result.status,
      outputRef: prepared.outputRef,
      errorCode: result.errorCode,
      recoverySuggestion: result.recoverySuggestion,
      sandbox
    });
    return {
      brief: `${result.summary}${result.recoverySuggestion ? ` Recovery: ${result.recoverySuggestion}` : ""}${prepared.outputRef ? " (full output saved)" : ""}.`,
      detail: prepared.detail
    };
  }

  function createRuntime(): SwarmRuntime {
    const nextRuntime = new SwarmRuntime({ approvalHandler: requestToolApproval, debugSessionId: chatSessionId.current });
    nextRuntime.ensureTuiChatSession(chatSessionId.current);
    return nextRuntime;
  }

  function requireSymphonyDaemonManager(): SymphonyDaemonManager {
    if (!runtime) {
      throw new Error("Runtime is not ready.");
    }
    if (!symphonyDaemonManager.current) {
      symphonyDaemonManager.current = new SymphonyDaemonManager(runtime);
    }
    return symphonyDaemonManager.current;
  }

  function refreshSymphonyDaemonState(manager = symphonyDaemonManager.current): void {
    setSymphonyDaemons(manager?.listRecords() ?? []);
  }

  function requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
    if (sessionApprovalAllow.current.has(approvalSessionRuleKey(request, runtimeRef.current))) {
      return Promise.resolve(true);
    }
    approvalResolver.current?.(false);
    return new Promise((resolve) => {
      approvalResolver.current = resolve;
      setApproval(request);
    });
  }

  function handleApprovalInput(character: string, key: { ctrl?: boolean; escape?: boolean }): void {
    const decision = approvalInputDecision(character, key);
    if (!decision.handled) {
      return;
    }
    if (decision.rememberForSession && approval) {
      sessionApprovalAllow.current.add(approvalSessionRuleKey(approval, runtimeRef.current));
    }
    approvalResolver.current?.(decision.approved);
    approvalResolver.current = undefined;
    setApproval(undefined);
  }

  if (detailOpen) {
    return (
      <Box width={terminalColumns} height={terminalRows} flexDirection="column" overflow="hidden">
        <DetailView
          content={latestDetail || "No detail output yet."}
          scroll={detailScroll}
          height={detailHeight}
          sessionId={lastSessionId}
          route={lastRoute?.mode}
          source={latestDetailSource === "none" ? undefined : latestDetailSource}
        />
      </Box>
    );
  }

  if (onboard.enabled) {
    return (
      <Box width={terminalColumns} height={terminalRows} flexDirection="column" overflow="hidden" paddingX={1}>
        <OnboardView state={onboard} />
      </Box>
    );
  }

  const latestSnapshot = runtime && lastSessionId ? safeWorkSnapshot(runtime, lastSessionId) : undefined;
  const displayedResultCard = latestResultCard
    ?? (latestSnapshot?.final_outcome ? buildResultCardFromSnapshot(latestSnapshot) : undefined);
  const promptCacheStatus = runtime?.getPromptCacheStatus();
  const cacheStatus = promptCacheStatus?.status ?? displayedResultCard?.cache?.status;
  const cacheHitRate = promptCacheStatus?.hitRate ?? displayedResultCard?.cache?.hitRate;
  const checkpointLabel = runtime?.getLastCheckpoint()?.name ?? displayedResultCard?.checkpoint?.name;
  const routeLabel = displayedResultCard?.route
    ?? lastRoute?.mode
    ?? (runMode === "chat" ? "ask" : runMode === "full_swarm" ? "team" : "work");
  const currentAction = loopActivity
    ? formatLoopActivityLine(loopActivity)
    : busy
      ? "Starting local coding loop..."
      : pendingPlan
        ? "Awaiting approval for the plan."
        : displayedResultCard
          ? displayedResultCard.summary
          : "Idle";
  const currentPhase = loopActivity
    ? loopActivity.phase.replace(/_/g, " ")
    : pendingPlan
      ? "awaiting approval"
      : busy
        ? "running"
        : displayedResultCard
          ? displayedResultCard.status
          : "idle";
  const screenMode = tuiScreenMode({
    pane: mainPane,
    columns: terminalColumns,
    busy,
    hasApproval: Boolean(approval),
    hasPendingPlan: Boolean(pendingPlan)
  });
  const showCurrentAction = screenMode.showCurrentAction;
  const needYou = approval
    ? `Approve ${approval.summary}`
    : pendingPlan
      ? "approve with y or cancel with n"
      : "no";
  const progress = busy
    ? `${progressBar(taskCompleted, taskTotal || 0, 10)} tasks ${taskCompleted}/${taskTotal || 0} | tools ${toolResults.length}`
    : displayedResultCard
      ? `${displayedResultCard.changedFiles.length} changed files | ${displayedResultCard.checks.length} checks`
      : "no active tasks";
  const timelineItems = busy
    ? loopActivityTimeline.slice(-5).map(formatLoopActivityLine)
    : displayedResultCard
      ? compactResultCardLines(displayedResultCard)
      : messages.slice(-3).map((message) => `${message.role}: ${message.brief}`);
  const bodyRows = Math.max(12, terminalRows - (showCurrentAction ? 8 : 6) - completionRows);
  const timelineLimit = bodyRows >= 30 ? 5 : 3;
  const overviewSurface = busy
    ? (
      <ActiveWorkSummary
        taskStates={taskStates}
        taskCompleted={taskCompleted}
        taskTotal={taskTotal}
        toolResults={toolResults}
      />
    )
    : displayedResultCard
      ? <ResultCardPanel
          card={displayedResultCard}
          detailHint={latestDetailSource !== "none" ? "Ctrl+O opens the latest detail." : undefined}
        />
      : <ResultCardPanel emptyLabel="Not finished. Enter an objective or use /continue." />;
  const wideWorkbench = screenMode.showInspector;
  const primaryColumns = wideWorkbench ? Math.max(72, Math.floor((terminalColumns - 4) * 0.64)) : terminalColumns;
  const inspectorColumns = Math.max(40, terminalColumns - primaryColumns - 3);
  const selectedActionRow = actionLogRows[selectedActionIndex] ?? actionLogRows.at(-1);
  const activeSearchMatch = currentTranscriptSearchMatch(transcriptSearch);
  const bottomFooterHint = transcriptSearch.active
    ? `${transcriptSearchSummary(transcriptSearch) ?? "search"} | Enter jump | Esc close`
    : "Left/Right footer | [/] message | / search";
  const inlineInspectorContent = latestDetailSource !== "none" && latestDetail
    ? latestDetail
    : renderActionRowDetail(selectedActionRow);
  const inlineInspectorSource = latestDetailSource === "none" ? "event" : latestDetailSource;
  const footerItems = buildFooterPills({
    taskCompleted,
    taskTotal,
    pendingApprovals: footerPendingApprovalCount(approval, idlePaneSnapshot.approvals),
    cacheStatus,
    cacheHitRate,
    gatewayStatus: "local",
    symphonyRunning: symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping").length,
    symphonyRetrying: 0,
    lspStatus: "ready"
  });
  const selectedFooterItem = selectedFooterPill(footerNavigation, footerItems)?.id;
  if (screenMode.primarySurface === "conversation") {
    const bottomRows = conversationBottomRows();
    const conversationRows = fullscreenConversationRows(terminalRows, bottomRows);
    const inputCapacity = chatInputCapacity();
    const bottom = approval ? (
      <ApprovalOverlay request={approval} />
    ) : pendingPlan ? (
      <Box borderStyle="single" paddingX={1} width="100%">
        <Text color="yellow">Approve plan with y, cancel with n</Text>
      </Box>
    ) : (
      <ConversationBottomChrome
        busy={busy}
        activity={loopActivityTimeline.at(-1) ? formatConversationActivityLine(loopActivityTimeline.at(-1)!) : undefined}
        motionFrame={shouldAnimate ? motionTick : undefined}
        resultCard={displayedResultCard}
        detailAvailable={latestDetailSource !== "none"}
        input={
          <ChatInputArea
            onSubmit={submitObjective}
            onCompletionRowsChange={setCompletionRows}
            onCompletionStateChange={setChatCompletion}
            controllerStateRef={chatInputState}
            extraCommands={extensionCommandCandidates}
            promptLabel={routeLabel === "auto" ? undefined : routeBadge(routeLabel).toLowerCase()}
            sandboxLabel={runSandboxMode === "workspace-write" ? undefined : sandboxBadge(runSandboxMode).toLowerCase()}
            footerHint={bottomFooterHint}
            footerItems={footerItems}
            selectedFooterItem={selectedFooterItem}
            completionPlacement="overlay"
            maxRows={bottomRows}
            maxInputRows={inputCapacity.maxInputRows}
          />
        }
      />
    );
    const completionOverlay = !approval && !pendingPlan && chatCompletion.candidates.length > 0
      ? (
        <ChatCommandCandidates
          candidates={chatCompletion.candidates}
          selectedIndex={chatCompletion.selectedIndex}
          maxRows={chatCompletionOverlayRows(terminalRows, bottomRows)}
          columns={terminalColumns}
          overlay
        />
      )
      : undefined;
    return (
      <ConversationFullscreenLayout
        columns={terminalColumns}
        rows={terminalRows}
        bottomRows={bottomRows}
        completionOverlay={completionOverlay}
        completionOverlayRows={chatCompletionOverlayRows(terminalRows, bottomRows)}
        scrollable={
          <ConversationFirstPane
            messages={messages}
            rows={conversationRows}
            columns={conversationTextColumns()}
            scrollOffset={conversationViewport.scrollOffset}
            newMessageCount={conversationViewport.newMessageCount}
            unseenStartIndex={conversationViewport.unseenStartIndex}
            expandedMessageKeys={messageCursor.expandedKeys}
            selectedMessageIndex={messageCursor.selectedIndex}
            searchMatchMessageIndex={activeSearchMatch?.messageIndex}
            tailRows={conversationTailRows({ busy, hasResult: Boolean(displayedResultCard) })}
            tail={conversationTail({
              busy,
              activity: loopActivityTimeline.at(-1) ? formatConversationActivityLine(loopActivityTimeline.at(-1)!) : undefined,
              motionFrame: shouldAnimate ? motionTick : undefined,
              resultCard: displayedResultCard,
              detailAvailable: latestDetailSource !== "none"
            })}
          />
        }
        bottom={bottom}
      />
    );
  }
  return (
    <Box width={terminalColumns} height={terminalRows} flexDirection="column" overflow="hidden" paddingX={1}>
      <StatusRail
        appName="Swarm"
        state={approval ? "awaiting approval" : busy ? "running" : displayedResultCard ? "done" : "idle"}
        route={routeLabel}
        permissionMode={settingsSnapshot.permissions.defaultMode}
        sandboxMode={runSandboxMode}
        model={settingsSnapshot.models.worker || settingsSnapshot.models.planner || settingsSnapshot.models.defaultProvider || "unset"}
        sessionId={lastSessionId}
        cacheStatus={cacheStatus}
        checkpoint={checkpointLabel}
        view={mainPaneLabels[mainPane]}
        compact={screenMode.compactStatus}
      />

      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" width="100%" marginTop={1}>
        {showCurrentAction && (
          <CurrentActionRow
            message={currentAction}
            phase={currentPhase}
            color={loopActivity ? loopActivityColor(loopActivity.phase) : busy ? "cyan" : displayedResultCard ? "green" : "gray"}
            progress={progress}
            needYou={needYou === "no" ? undefined : needYou}
            motionFrame={shouldAnimate ? motionTick : undefined}
          />
        )}

        <Box flexDirection={wideWorkbench ? "row" : "column"} flexGrow={1} flexShrink={1} overflow="hidden" width="100%" marginTop={showCurrentAction ? 1 : 0}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" width={wideWorkbench ? primaryColumns : "100%"}>
            {screenMode.primarySurface === "trace" ? (
              <ActionLog
                rows={actionLogRows}
                height={bodyRows}
                columns={wideWorkbench ? primaryColumns : terminalColumns}
                scrollOffset={actionLogScrollOffset}
                onScrollOffsetChange={setActionLogScrollOffset}
                motionFrame={shouldAnimate ? motionTick : undefined}
                selectedIndex={selectedActionIndex}
              />
            ) : (
              <>
                <ActivityTimeline
                  title={busy ? "Progress" : displayedResultCard ? "Result" : "Recent"}
                  items={timelineItems}
                  emptyLabel="(none)"
                  limit={timelineLimit}
                />

                <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" width="100%" marginTop={1}>
                  {mainPane === "overview" ? (
                    overviewSurface
                  ) : (
                    <IdleKernelView
                      pane={mainPane}
                      rows={bodyRows}
                      columns={wideWorkbench ? primaryColumns : terminalColumns}
                      messages={messages.slice(-4)}
                      toolOutputs={toolResults.slice(-4)}
                      sessions={idlePaneSnapshot.sessions}
                      attempts={idlePaneSnapshot.attempts}
                      leases={idlePaneSnapshot.leases}
                      approvals={idlePaneSnapshot.approvals}
                      workers={mergeWorkerRecords(workers, idlePaneSnapshot.workers, 6)}
                      blackboard={idlePaneSnapshot.blackboard}
                      symphonyDaemons={symphonyDaemons.slice(0, 4)}
                      lastSessionId={lastSessionId}
                      lastRoute={lastRoute}
                      lastSnapshot={latestSnapshot}
                    />
                  )}
                </Box>
              </>
            )}
          </Box>
          {wideWorkbench && (
            <Box flexDirection="column" width={inspectorColumns} marginLeft={1} overflow="hidden">
              <DetailView
                content={inlineInspectorContent}
                scroll={detailScroll}
                height={bodyRows}
                sessionId={lastSessionId}
                route={lastRoute?.mode}
                source={inlineInspectorSource}
              />
            </Box>
          )}
        </Box>
      </Box>

      <Box flexShrink={0} width="100%" marginTop={1}>
        {approval ? (
          <ApprovalOverlay request={approval} />
        ) : pendingPlan ? (
          <Box borderStyle="single" paddingX={1} width="100%">
            <Text color="yellow">Approve plan with y, cancel with n</Text>
          </Box>
        ) : (
          <ChatInputArea
            onSubmit={submitObjective}
            onCompletionRowsChange={setCompletionRows}
            controllerStateRef={chatInputState}
            extraCommands={extensionCommandCandidates}
            promptLabel={routeBadge(routeLabel).toLowerCase()}
            sandboxLabel={sandboxBadge(runSandboxMode).toLowerCase()}
            footerHint={bottomFooterHint}
            footerItems={footerItems}
            selectedFooterItem={selectedFooterItem}
          />
        )}
      </Box>
    </Box>
  );
}

async function prepareSlashToolOutput(
  sessionId: string,
  taskId: string,
  result: ReturnType<typeof runLocalTool> extends Promise<infer T> ? T : never
): Promise<{ detail: string; content?: string; outputRef?: string }> {
  const detail = renderToolResultDetail(result);
  const existingRef = result.outputRef;
  const bytes = Buffer.byteLength(detail, "utf8");
  if (existingRef || bytes <= SLASH_OUTPUT_INLINE_BYTES) {
    return {
      detail,
      content: "content" in result && typeof result.content === "string" ? result.content : detail,
      outputRef: existingRef
    };
  }
  const ref = await writeTaskOutput({
    sessionId,
    taskId,
    attempt: Date.now(),
    content: detail
  });
  return {
    detail,
    content: truncateSlashOutput(detail, SLASH_OUTPUT_PREVIEW_BYTES, ref.path, ref.bytes, ref.lines),
    outputRef: ref.path
  };
}

function truncateSlashOutput(value: string, maxBytes: number, path: string, totalBytes: number, totalLines: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }
  const headBytes = Math.max(1000, Math.floor(maxBytes * 0.7));
  const tailBytes = Math.max(1000, maxBytes - headBytes);
  const head = buffer.subarray(0, headBytes).toString("utf8").replace(/\uFFFD$/u, "");
  const tail = buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8").replace(/^\uFFFD/u, "");
  return [
    head.trimEnd(),
    "",
    `[... ${totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8")} bytes omitted from ${totalLines} lines. Full output: ${path}]`,
    "",
    tail.trimStart()
  ].join("\n");
}

function detailPreview(detail: string | undefined): string | undefined {
  return commandOutputPreview(detail, MESSAGE_OUTPUT_PREVIEW_LINES, MESSAGE_OUTPUT_PREVIEW_CHARS);
}

function createOnboardState(enabled: boolean): OnboardState {
  const settings = loadSwarmSettings();
  const provider = settings.models.defaultProvider;
  return {
    enabled,
    custom: false,
    field: "provider",
    values: {
      provider,
      apiKey: "",
      planner: settings.models.planner,
      worker: settings.models.worker,
      aggregator: settings.models.aggregator,
      customName: "",
      customBaseURL: "",
      customModel: ""
    }
  };
}

function isCustomProviderInput(provider: string): boolean {
  return provider.startsWith("custom:") || provider.startsWith("custom-openai:") || provider.startsWith("custom-claude:");
}

function parseCustomProviderInput(provider: string): {
  id: string;
  protocol: "openai-chat-completions" | "anthropic-messages";
} {
  if (provider.startsWith("custom-claude:")) {
    return { id: provider.slice("custom-claude:".length).trim(), protocol: "anthropic-messages" };
  }
  if (provider.startsWith("custom-openai:")) {
    return { id: provider.slice("custom-openai:".length).trim(), protocol: "openai-chat-completions" };
  }
  return { id: provider.slice("custom:".length).trim(), protocol: "openai-chat-completions" };
}

function OnboardView({ state }: { state: OnboardState }): React.ReactElement {
  const readiness = new OpenAIProvider().readiness();
  const visibleFields = state.custom || isCustomProviderInput(state.values.provider) ? customFieldOrder : fieldOrder;
  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="single" paddingX={1} width="100%">
        <Text color="cyan">Swarm Onboarding</Text>
        <Text color="gray">  Enter/Tab next. Use a provider id, custom-openai:id, or custom-claude:id.</Text>
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1} width="100%">
        {readiness.map((item, index) => (
          <Text key={`${item.modelRef}:${index}`} color={item.configured ? "green" : "yellow"}>
            {item.modelRef}: {item.configured ? "configured" : item.reason}
          </Text>
        ))}
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1} width="100%">
        {visibleFields.map((field) => (
          <Text key={field} color={field === state.field ? "cyan" : undefined}>
            {fieldLabel(field)}: {maskField(field, state.values[field])}
          </Text>
        ))}
      </Box>
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">{state.error}</Text>
        </Box>
      )}
    </Box>
  );
}

function IdleKernelView(input: {
  pane: MainPaneId;
  rows: number;
  columns: number;
  messages: ChatMessage[];
  toolOutputs: ToolResultState[];
  sessions: RecentSessionRow[];
  attempts: RunAttempt[];
  leases: WorkspaceLease[];
  approvals: ApprovalStoreRecord[];
  workers: WorkerRecord[];
  blackboard: BlackboardEntry[];
  symphonyDaemons: SymphonyDaemonRecord[];
  lastSessionId?: string;
  lastRoute?: RouteState;
  lastSnapshot?: ReturnType<SwarmRuntime["getWorkSnapshot"]>;
}): React.ReactElement {
  if (input.pane === "chat") {
    return (
      <ConversationFirstPane
        messages={input.messages}
        rows={input.rows}
      />
    );
  }
  const activeDaemons = input.symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping");
  return (
    <Box flexDirection="column" width="100%">
      <PaneHeader pane={input.pane} columns={input.columns} />
      {input.pane === "overview" && <IdleOverviewPane input={input} rows={input.rows} activeDaemons={activeDaemons} lastSnapshot={input.lastSnapshot} />}
      {input.pane === "output" && <IdleOutputPane rows={input.rows} outputs={input.toolOutputs} />}
      {input.pane === "sessions" && <IdleSessionsPane rows={input.rows} sessions={input.sessions} leases={input.leases} lastSessionId={input.lastSessionId} />}
      {input.pane === "attempts" && <IdleAttemptsPane rows={input.rows} attempts={input.attempts} />}
      {input.pane === "agents" && <IdleActivityPane rows={input.rows} workers={input.workers} approvals={input.approvals} daemons={activeDaemons} />}
      {input.pane === "blackboard" && <IdleBlackboardPane rows={input.rows} blackboard={input.blackboard} messages={input.messages} />}
    </Box>
  );
}

function PaneHeader({ pane, columns }: { pane: MainPaneId; columns: number }): React.ReactElement {
  const compact = columns < 96;
  const current = compact ? mainPaneShortLabels[pane] : mainPaneLabels[pane];
  const shortcut = columns < 72 ? "/view" : "use /view";
  return (
    <Text wrap="truncate">
      <Text color="cyan" bold>{sectionLabel("View")}</Text>
      <Text color="gray"> {current} | {shortcut} </Text>
      {mainPaneOrder.map((item, index) => (
        <Text key={item} inverse={item === pane} color={item === pane ? "black" : "gray"}>
          {item === pane ? `[${compact ? mainPaneShortLabels[item] : mainPaneLabels[item]}]` : compact ? mainPaneShortLabels[item] : mainPaneLabels[item]}
          {index < mainPaneOrder.length - 1 ? " " : ""}
        </Text>
      ))}
    </Text>
  );
}

function IdleOverviewPane({ input, rows, activeDaemons, lastSnapshot }: {
  input: Parameters<typeof IdleKernelView>[0];
  rows: number;
  activeDaemons: SymphonyDaemonRecord[];
  lastSnapshot?: ReturnType<SwarmRuntime["getWorkSnapshot"]>;
}): React.ReactElement {
  const recentMessages = rows >= 48 ? 3 : rows >= 36 ? 2 : 1;
  return (
    <>
      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Status")}</Text>
      </Box>
      <Text color="gray">
        {`sessions=${input.sessions.length} attempts=${input.attempts.length} outputs=${input.toolOutputs.length} approvals=${input.approvals.length} symphony=${activeDaemons.length} last=${shortId(input.lastSessionId ?? "-")}`}
      </Text>
      {input.lastRoute && (
        <Text color="cyan" wrap="truncate">
          route={input.lastRoute.mode}{typeof input.lastRoute.confidence === "number" ? ` ${Math.round(input.lastRoute.confidence * 100)}%` : ""} {firstLine(input.lastRoute.reason, 90)}
        </Text>
      )}

      {(input.approvals.length > 0 || activeDaemons.length > 0) && (
        <>
          <Box marginTop={1}>
            <Text color="yellow" bold>{sectionLabel("Attention")}</Text>
          </Box>
          {input.approvals.slice(0, 2).map((approval) => (
            <Text key={approval.approval_id} wrap="truncate" color="yellow">
              approval {approval.risk_class}/{approval.risk} {approval.action} {firstLine(approval.target, 60)}
            </Text>
          ))}
          {activeDaemons.slice(0, 2).map((daemon) => (
            <Text key={daemon.daemon_id} wrap="truncate" color="cyan">
              daemon {shortId(daemon.daemon_id)} [{daemon.status}] ticks={daemon.tick_count}
            </Text>
          ))}
        </>
      )}

      {input.lastSessionId && (
        <>
          <Box marginTop={1}>
            <Text color="cyan" bold>{sectionLabel("Latest Session")}</Text>
          </Box>
          {lastSnapshot
            ? compactWorkSnapshotLines(lastSnapshot).slice(0, 2).map((line) => (
                <Text key={line} wrap="truncate" color="gray">
                  {line}
                </Text>
              ))
            : <Text color="gray">No snapshot available.</Text>}
        </>
      )}

      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Recent Messages")}</Text>
      </Box>
      {input.messages.length ? input.messages.slice(-recentMessages).map((message, index) => (
        <Box key={`${message.role}-${index}`} flexDirection="column">
          <Text wrap="truncate" color={roleColor(message.role)}>
            {message.role}: {message.brief}
          </Text>
        </Box>
      )) : <Text color="gray">(none)</Text>}

      {input.toolOutputs.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text color="cyan" bold>{sectionLabel("Latest Output")}</Text>
          </Box>
          {input.toolOutputs.slice(-1).map((result, index) => {
            return (
              <Box key={`${result.task_id}-${index}`} flexDirection="column">
                <Text wrap="truncate">
                  {statusIcon(result.status ?? "completed")} {result.action} {firstLine(result.summary, 88)}{result.outputRef ? " (saved)" : ""}
                </Text>
                {result.recoverySuggestion && <Text color="yellow" wrap="truncate">{indentPreview(firstLine(result.recoverySuggestion, 88), "  ")}</Text>}
                {compactPreview(result.content)}
              </Box>
            );
          })}
        </>
      )}
    </>
  );
}

function IdleOutputPane({ rows, outputs }: { rows: number; outputs: ToolResultState[] }): React.ReactElement {
  const outputLimit = rows >= 48 ? 5 : rows >= 36 ? 3 : 2;
  return (
    <>
      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Command Output")}</Text>
      </Box>
      {outputs.length ? outputs.slice(-outputLimit).map((result, index) => {
        return (
          <Box key={`${result.task_id}-${result.attempt ?? 0}-${index}`} flexDirection="column">
            <Text wrap="truncate">
              {statusIcon(result.status ?? "completed")} {result.action} {firstLine(result.summary, 92)}{result.outputRef ? " (saved)" : ""}
            </Text>
            {result.recoverySuggestion && <Text color="yellow" wrap="truncate">{indentPreview(firstLine(result.recoverySuggestion, 92), "  ")}</Text>}
            {result.outputRef && <Text color="gray" wrap="truncate">{indentPreview(`full: ${result.outputRef}`, "  ")}</Text>}
            {compactPreview(result.content)}
          </Box>
        );
      }) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleSessionsPane({ rows, sessions, leases, lastSessionId }: {
  rows: number;
  sessions: RecentSessionRow[];
  leases: WorkspaceLease[];
  lastSessionId?: string;
}): React.ReactElement {
  const sessionLimit = rows >= 48 ? 8 : rows >= 36 ? 5 : 3;
  const leaseLimit = rows >= 48 ? 3 : 1;
  return (
    <>
      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Recent Sessions")}</Text>
      </Box>
      {lastSessionId && <Text color="gray">last={lastSessionId}</Text>}
      {sessions.length ? sessions.slice(0, sessionLimit).map((session) => (
        <Text key={session.session_id} wrap="truncate">
          {statusIcon(session.status)} {shortId(session.session_id)} [{session.status}] {firstLine(session.objective, 72)}
        </Text>
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Workspace Leases")}</Text>
      </Box>
      {leases.length ? leases.slice(0, leaseLimit).map((lease) => (
        <Text key={lease.lease_id} wrap="truncate" color={lease.write_boundary === "read_only" ? "yellow" : undefined}>
          {shortId(lease.session_id)} [{lease.write_boundary}] {shortPath(lease.workspace_path)}
        </Text>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleAttemptsPane({ rows, attempts }: { rows: number; attempts: RunAttempt[] }): React.ReactElement {
  const attemptLimit = rows >= 48 ? 8 : rows >= 36 ? 5 : 3;
  return (
    <>
      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Recent Attempts")}</Text>
      </Box>
      {attempts.length ? attempts.slice(0, attemptLimit).map((attempt) => (
        <Box key={attempt.attempt_id} flexDirection="column">
          <Text wrap="truncate">
            {statusIcon(attempt.status)} {attempt.kind} {shortId(attempt.task_id ?? attempt.runner_id ?? "-")} [{attempt.status}] {firstLine(attempt.title ?? attempt.session_id, 72)}
          </Text>
          {attempt.recovery_suggestion && <Text color="yellow" wrap="truncate">  Recovery: {attempt.recovery_suggestion}</Text>}
        </Box>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleActivityPane({ rows, workers, approvals, daemons }: {
  rows: number;
  workers: WorkerRecord[];
  approvals: ApprovalStoreRecord[];
  daemons: SymphonyDaemonRecord[];
}): React.ReactElement {
  const workerLimit = rows >= 48 ? 6 : 3;
  const approvalLimit = rows >= 48 ? 4 : rows >= 36 ? 3 : 2;
  const daemonLimit = rows >= 48 ? 4 : rows >= 36 ? 3 : 2;
  return (
    <>
      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Active Work")}</Text>
      </Box>
      {workers.length ? workers.slice(0, workerLimit).map((worker) => (
        <WorkerLine key={worker.worker_id} worker={worker} />
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Approvals")}</Text>
      </Box>
      {approvals.length ? approvals.slice(0, approvalLimit).map((approval) => (
        <Text key={approval.approval_id} wrap="truncate" color={approval.status === "pending" ? "yellow" : undefined}>
          {shortId(approval.approval_id)} [{approval.status}] {approval.risk_class}/{approval.risk} {approval.action} {firstLine(approval.target, 52)}
        </Text>
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Background Work")}</Text>
      </Box>
      {daemons.length ? daemons.slice(0, daemonLimit).map((daemon) => (
        <Text key={daemon.daemon_id} wrap="truncate" color="cyan">
          {shortId(daemon.daemon_id)} [{daemon.status}] ticks={daemon.tick_count}
        </Text>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function ActiveWorkSummary(input: {
  taskStates: Map<string, TaskState>;
  taskCompleted: number;
  taskTotal: number;
  toolResults: ToolResultState[];
}): React.ReactElement {
  const latestTask = [...input.taskStates.entries()].slice(-1)[0];
  const latestOutput = input.toolResults.slice(-1)[0];
  const policySummary = summarizeTaskWritePolicies(input.taskStates);
  const scopePreview = policySummary.scopedTargets.slice(0, 3).join(", ");
  const scopeSuffix = policySummary.scopedTargets.length > 3 ? ` +${policySummary.scopedTargets.length - 3} more` : "";
  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" bold>{sectionLabel("Work")}</Text>
      <Text color="gray" wrap="truncate">
        in progress · tasks {input.taskCompleted}/{input.taskTotal || 0} · tool outputs {input.toolResults.length}
      </Text>
      <Text color="gray" wrap="truncate">
        policies: ro {policySummary.readOnly} · scoped {policySummary.scopedWrite} · workspace {policySummary.workspaceWrite}
      </Text>
      {policySummary.scopedTargets.length > 0 && (
        <Text color="gray" wrap="truncate">
          scope: {scopePreview}{scopeSuffix}
        </Text>
      )}
      <Text color="gray" wrap="truncate">
        task: {latestTask ? `${statusIcon(latestTask[1].status)} ${latestTask[1].title || latestTask[0]}${formatTaskStatePolicyHint(latestTask[1])}` : "(waiting)"}
      </Text>
      <Text color="gray" wrap="truncate">
        output: {latestOutput ? `[${latestOutput.status ?? "unknown"}${latestOutput.errorCode ? `/${latestOutput.errorCode}` : ""}] ${latestOutput.agentLabel ? `${latestOutput.agentLabel}: ` : ""}${latestOutput.summary}` : "(none)"}
      </Text>
    </Box>
  );
}

function formatTaskStatePolicyHint(task: TaskState): string {
  const parts = [
    task.writePolicy ? `policy=${task.writePolicy}` : undefined,
    task.capability ? `cap=${task.capability}` : undefined,
    task.fileScope?.length ? `scope=${task.fileScope.slice(0, 2).join(",")}${task.fileScope.length > 2 ? ",..." : ""}` : undefined
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(" ")})` : "";
}

function ActivityPanel({ workers, agents }: {
  workers: WorkerRecord[];
  agents: Array<Extract<RuntimeEvent, { type: "agent" }>>;
}): React.ReactElement {
  if (workers.length) {
    return (
      <>
        {workers.slice(0, 8).map((worker) => (
          <WorkerLine key={worker.worker_id} worker={worker} compact />
        ))}
      </>
    );
  }
  if (agents.length) {
    return (
      <>
        {agents.map((event) => (
          <Text key={`${event.card.agent_id}-${event.card.status}`} wrap="truncate">
            {event.card.name || event.card.agent_id} [{event.card.status}] running={event.card.load.running_tasks}/{event.card.load.max_tasks}
          </Text>
        ))}
      </>
    );
  }
  return <Text color="gray">No active background work.</Text>;
}

function WorkerLine({ worker, compact = false }: { worker: WorkerRecord; compact?: boolean }): React.ReactElement {
  const agent = worker.agent_spec_id
    ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}`
    : worker.capability;
  const displayLabel = workerDisplayLabel(worker);
  const result = worker.last_result ? ` - ${firstLine(worker.last_result, compact ? 44 : 90)}` : "";
  if (compact) {
    return (
      <Text wrap="truncate" color={workerStatusColor(worker.status)}>
        {statusIcon(worker.status)} {displayLabel} [{worker.status}]{result}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate" color={workerStatusColor(worker.status)}>
        {statusIcon(worker.status)} {displayLabel} [{worker.status}]
      </Text>
      <Text wrap="truncate" color="gray">
        {worker.worker_id} {agent}{worker.file_scope.length ? ` scope=${worker.file_scope.slice(0, 3).join(",")}` : ""}
      </Text>
      {!compact && <Text wrap="truncate">{worker.objective}</Text>}
      {result && <Text wrap="truncate" color="gray">{result}</Text>}
    </Box>
  );
}

function IdleBlackboardPane({ rows, blackboard, messages }: {
  rows: number;
  blackboard: BlackboardEntry[];
  messages: ChatMessage[];
}): React.ReactElement {
  const blackboardLimit = rows >= 48 ? 6 : rows >= 36 ? 4 : 3;
  const recentMessages = rows >= 48 ? 3 : rows >= 36 ? 2 : 1;
  return (
    <>
      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Blackboard")}</Text>
      </Box>
      {blackboard.length ? blackboard.slice(0, blackboardLimit).map((entry) => (
        <Text key={entry.entry_id} wrap="truncate" color="gray">
          {firstLine(entry.key, 56)} [{entry.type}] {shortId(entry.session_id)}
        </Text>
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="cyan" bold>{sectionLabel("Recent Messages")}</Text>
      </Box>
      {messages.length ? messages.slice(-recentMessages).map((message, index) => (
        <Text key={`${message.role}-${index}`} wrap="truncate" color={roleColor(message.role)}>
          {message.role}: {message.brief}
        </Text>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function ApprovalView({ request }: { request: ToolApprovalRequest }): React.ReactElement {
  return <ApprovalOverlay request={request} />;
}

function approvalSessionRuleKey(request: ToolApprovalRequest, runtime?: SwarmRuntime): string {
  const scope = request.session_id
    ? runtime?.sessionFamilyRootSessionId(request.session_id) ?? request.session_id
    : "sessionless";
  return `${scope}\0${request.action}\0${request.target}`;
}

function compactResultCardLines(card: RuntimeResultCard): string[] {
  const changed = card.changedFiles.length ? card.changedFiles.slice(0, 3).join(", ") : "none";
  const checks = card.checks.length ? card.checks.slice(0, 3).map((check) => `${check.command}[${check.status}]`).join(", ") : "none";
  const next = card.next.length ? card.next.slice(0, 2).join(" · ") : "none";
  return [
    `summary: ${card.summary}`,
    `changed: ${changed}`,
    `checks: ${checks}`,
    `review: ${card.review.status} - ${firstLine(card.review.summary, 120)}`,
    `next: ${next}`
  ];
}

function DetailView({ content, scroll, height, sessionId, route, source }: {
  content: string;
  scroll: number;
  height: number;
  sessionId?: string;
  route?: string;
  source?: "ai" | "command" | "task" | "event";
}): React.ReactElement {
  const lines = content.split(/\r?\n/);
  const visible = lines.slice(scroll, scroll + height);
  const title = source === "command" ? "Command Output" : source === "task" ? "Task Detail" : source === "event" ? "Event Detail" : "Inspector";
  return (
    <Box flexDirection="column" width="100%">
      <InspectorPane
        title={title}
        sessionId={sessionId}
        route={route}
        selected={`lines ${Math.min(scroll + 1, lines.length)}-${Math.min(scroll + height, lines.length)} / ${lines.length}`}
        tabs={source === "command" ? undefined : ["output", "files", "checks", "workers", "attempts", "debug"]}
        content={visible.join("\n") || " "}
      />
    </Box>
  );
}

function renderActionRowDetail(row: TuiActionRow | undefined): string {
  if (!row) {
    return "No action selected.";
  }
  return [
    `${statusBadge(row.status)} ${row.title}`,
    row.summary ? `summary: ${row.summary}` : undefined,
    row.meta ? `meta: ${row.meta}` : undefined,
    `kind: ${row.kind}`,
    "",
    ...(row.details.length ? row.details : ["No additional details."])
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function renderConversationMessageDetail(index: number, message: ConversationMessage): string {
  return [
    `Message ${index}`,
    `role=${message.role}`,
    message.kind ? `kind=${message.kind}` : undefined,
    message.status ? `status=${message.status}` : undefined,
    message.title ? `title=${message.title}` : undefined,
    "",
    "Brief",
    message.brief || "(empty)",
    message.preview ? ["", "Preview", message.preview].join("\n") : undefined,
    message.detail ? ["", "Detail", message.detail].join("\n") : undefined
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function renderPlanSummary(planned: PlannedSession): string {
  return [
    `Plan for ${planned.session.session_id}`,
    planned.plan.summary,
    "",
    ...planned.plan.tasks.map(
      (task, index) =>
        `${index + 1}. ${task.title} (${task.required_capabilities.join(", ")})${
          task.dependencies?.length ? ` after ${task.dependencies.join(", ")}` : ""
        }`
    )
  ].join("\n");
}

function formatLoopActivityLine(activity: LoopActivityState): string {
  const turn = activity.turn ? `#${activity.turn} ` : "";
  const tool = activity.tool ? `${activity.tool} ` : "";
  const agent = activityAgentLabel(activity);
  return `${agent ? `${agent} ` : ""}${turn}${activity.phase}: ${tool}${activity.message}`;
}

function formatConversationActivityLine(activity: LoopActivityState): string {
  const message = firstLine(activity.message, 120);
  const agent = activityAgentLabel(activity);
  const withAgent = (value: string): string => agent ? `${agent}: ${value}` : value;
  if (activity.phase === "thinking") {
    return withAgent(message || "Thinking");
  }
  if (activity.phase === "running_tool" || activity.phase === "running_tools") {
    return withAgent(activity.tool ? `${activity.tool}: ${message}` : message || "Running tools");
  }
  if (activity.phase === "waiting_approval") {
    return withAgent(message || "Waiting for approval");
  }
  if (activity.phase === "turn_complete") {
    return withAgent(message || "Working");
  }
  if (activity.phase === "completed") {
    return withAgent(message || "Completed");
  }
  if (activity.phase === "failed") {
    return withAgent(message || "Failed");
  }
  if (activity.phase === "stopped") {
    return withAgent(message || "Stopped");
  }
  return withAgent(message || "Working");
}

function activityAgentLabel(activity: LoopActivityState): string | undefined {
  const agent = activity.agent;
  return agent ? runtimeAgentLabel(agent) : undefined;
}

function runtimeAgentLabel(agent: NonNullable<LoopActivityState["agent"]>): string {
  const name = agent.display_name?.trim() || agent.agent_id || agent.worker_id || agent.agent_spec_id || agent.capability || agent.role || "agent";
  const role = agent.role_title?.trim();
  return role ? `${name} / ${role}` : name;
}

function conversationBottomStatusRows(_input: {
  busy?: boolean;
  hasResult?: boolean;
}): number {
  return 0;
}

function conversationTailRows(input: {
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

function conversationTail(input: {
  busy?: boolean;
  activity?: string;
  motionFrame?: number;
  resultCard?: RuntimeResultCard;
  detailAvailable?: boolean;
}): React.ReactNode {
  if (input.busy) {
    return (
      <ConversationStatusLine
        message={input.activity ?? "Working"}
        motionFrame={input.motionFrame}
      />
    );
  }
  if (input.resultCard) {
    return (
      <ConversationResultLine
        card={input.resultCard}
        detailAvailable={Boolean(input.detailAvailable)}
      />
    );
  }
  return undefined;
}

function normalizeActionLogControlCharacter(character: string | undefined): string {
  if (!character) {
    return "";
  }
  if (character === "\x02") {
    return "b";
  }
  if (character === "\x06") {
    return "f";
  }
  return character.toLowerCase();
}

function loopActivityColor(phase: LoopActivityState["phase"]): "cyan" | "green" | "yellow" | "red" | "gray" {
  switch (phase) {
    case "failed": return "red";
    case "completed": return "green";
    case "stopped": return "yellow";
    case "waiting_approval": return "yellow";
    case "turn_complete": return "gray";
    default: return "cyan";
  }
}

async function formatDoctorReport(runtime: SwarmRuntime | undefined, workflowPath?: string): Promise<string> {
  return (await buildDoctorReport({ runtime, workflowPath })).detail;
}

export function formatKernelStatusView(input: {
  runtime?: SwarmRuntime;
  busy: boolean;
  runMode: RunMode;
  lastRoute?: RouteState;
  lastSessionId?: string;
  taskCompleted: number;
  taskTotal: number;
  taskStates: Map<string, TaskState>;
  toolResults: ToolResultState[];
  workers: Map<string, WorkerRecord>;
  handoffs: Map<string, HandoffSessionRecord>;
  symphonyStatus?: SymphonyStatus;
  symphonyDaemons: SymphonyDaemonRecord[];
  cacheStatus?: PromptCacheRuntimeStatus;
  events: RuntimeEvent[];
}): string {
  const sessions = input.runtime?.listRecentSessionsForWorkspace(8) ?? [];
  const attempts = input.runtime?.listRecentAttemptsForWorkspace(12) ?? [];
  const leases = input.runtime?.listRecentLeasesForWorkspace(8) ?? [];
  const persistedWorkers = input.runtime?.listRecentWorkersForWorkspace(8) ?? [];
  const approvals = input.runtime?.listRecentApprovalsForWorkspace(8) ?? [];
  const persistedHandoffs = input.runtime?.listHandoffsForWorkspace(8) ?? [];
  const recentBlackboard = input.runtime?.listRecentBlackboardForWorkspace(8) ?? [];
  const lastSnapshot = input.runtime && input.lastSessionId
    ? safeWorkSnapshot(input.runtime, input.lastSessionId)
    : undefined;
  const symphony = input.symphonyStatus;
  const activeDaemons = input.symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping");
  return [
    "Swarm Kernel",
    `state=${input.busy ? "running" : "idle"} mode=${input.runMode} last_session=${input.lastSessionId ?? "-"}`,
    `latest_route=${input.lastRoute ? formatRouteState(input.lastRoute) : "-"}`,
    `active_tasks=${input.taskCompleted}/${input.taskTotal} memory_tasks=${input.taskStates.size} tool_outputs=${input.toolResults.length}`,
    `memory_workers=${input.workers.size} memory_handoffs=${input.handoffs.size} events=${input.events.length}`,
    "",
    "Current Work",
    ...(input.taskStates.size
      ? [...input.taskStates.entries()].slice(-10).map(([id, state]) => `${statusIcon(state.status)} ${id} [${state.status}]${state.attempt ? ` #${state.attempt}` : ""} ${state.title}${formatTaskStatePolicyHint(state)}`)
      : ["(none)"]),
    "",
    "Recent Sessions",
    ...(sessions.length
      ? sessions.map((row) => `${row.session_id} [${row.status}] ${row.updated_at} ${row.objective}`)
      : ["(none)"]),
    "",
    "Last Session Snapshot",
    ...(lastSnapshot ? compactWorkSnapshotLines(lastSnapshot) : ["(none)"]),
    "",
    "Recent Attempts",
    ...(attempts.length
      ? attempts.map(formatRunAttemptSummary)
      : ["(none)"]),
    "",
    "Workspace Leases",
    ...(leases.length
      ? leases.map(formatWorkspaceLeaseSummary)
      : ["(none)"]),
    "",
    "Workers",
    ...(persistedWorkers.length ? persistedWorkers.map(formatWorkerBrief) : ["(none)"]),
    "",
    "Approvals",
    ...(approvals.length ? approvals.map((approval) => `${approval.approval_id} [${approval.status}] ${approval.risk_class}/${approval.risk} ${approval.action} ${approval.target}`) : ["(none)"]),
    "",
    "Handoffs",
    ...(persistedHandoffs.length ? persistedHandoffs.map((handoff) => `${handoff.handoff_id} [${handoff.status}] ${handoff.source_agent} -> ${handoff.target_agent_spec_id} ${handoff.reason}`) : ["(none)"]),
    "",
    "Symphony",
    symphony?.workflow.ok
      ? `workflow=${symphony.workflow.workflow.path}`
      : `workflow=${symphony?.workflow.ok === false ? symphony.workflow.error.message : "-"}`,
    symphony
      ? `sessions=${symphony.totals.sessions} running=${symphony.totals.running} retrying=${symphony.totals.retrying} capacity=${symphony.scheduler.capacity.running}/${symphony.scheduler.capacity.max_concurrent}`
      : "status=(not loaded)",
    activeDaemons.length
      ? `daemons=${activeDaemons.map((daemon) => `${daemon.daemon_id}:${daemon.status}:ticks=${daemon.tick_count}`).join(" ")}`
      : "daemons=(none)",
    ...(symphony?.scheduler.running.length
      ? symphony.scheduler.running.slice(0, 5).map((item) => `${item.session_id} [${item.status}] ${workItemLabel(item.work_item)}`)
      : []),
    "",
    formatServiceStatusSection({
      cache: input.cacheStatus,
      gatewayStatus: "local",
      symphonyStatus: symphonyStatusForServiceSection(symphony),
      lspStatus: "ready"
    }),
    "",
    "Blackboard",
    ...(recentBlackboard.length
      ? recentBlackboard.map((entry) => `${entry.created_at} ${entry.session_id} ${entry.key} [${entry.type}] tags=${(entry.tags ?? []).join(",")}`)
      : ["(none)"]),
    "",
    "Recent Events",
    ...(input.events.length ? input.events.slice(-20).map(formatRuntimeEventBrief) : ["(none)"])
  ].join("\n");
}

function symphonyStatusForServiceSection(status: SymphonyStatus | undefined): string {
  if (!status) {
    return "unknown";
  }
  if (!status.workflow.ok) {
    return "failed";
  }
  if (status.totals.failed > 0) {
    return "failed";
  }
  if (status.totals.retrying > 0) {
    return "retrying";
  }
  if (status.totals.running > 0) {
    return "running";
  }
  return "ready";
}

function footerPendingApprovalCount(
  activeApproval: ToolApprovalRequest | undefined,
  recentApprovals: readonly { status?: string }[]
): number {
  const persisted = recentApprovals.filter((approval) => approval.status === "pending").length;
  return Math.max(persisted, activeApproval ? 1 : 0);
}

function sessionSourceKind(sourceJson: string | null | undefined): string | undefined {
  if (!sourceJson) {
    return undefined;
  }
  try {
    const source = JSON.parse(sourceJson) as { source?: unknown };
    return typeof source.source === "string" ? source.source : undefined;
  } catch {
    return undefined;
  }
}

function formatLspStatusReport(report: LspStatusReport): string {
  return [
    "LSP",
    `workspace=${report.workspace}`,
    `generated=${report.generatedAt}`,
    "",
    ...report.providers.map((provider) => [
      `${provider.providerId} [${provider.status}] detected=${provider.detected ? "yes" : "no"} available=${provider.available ? "yes" : "no"}`,
      provider.command ? `command=${[provider.command, ...(provider.args ?? [])].join(" ")}` : undefined,
      provider.pid ? `pid=${provider.pid}` : undefined,
      provider.reason ? `reason=${provider.reason}` : undefined,
      provider.lastError ? `error=${provider.lastError}` : undefined,
      `log=${provider.logPath}`
    ].filter(Boolean).join("\n")).join("\n\n")
  ].join("\n");
}

function routeStateFromControllerEvent(event: ControllerEvent): RouteState | undefined {
  const route = event.details?.route;
  if (typeof route !== "object" || route === null) {
    return {
      mode: event.action.replace(/^run_/, ""),
      reason: event.reason
    };
  }
  const value = route as Record<string, unknown>;
  const mode = typeof value.mode === "string" ? value.mode : event.action.replace(/^run_/, "");
  return {
    mode,
    confidence: typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : undefined,
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : event.reason,
    requiresWorkspace: typeof value.requires_workspace === "boolean" ? value.requires_workspace : undefined,
    needsParallelism: typeof value.needs_parallelism === "boolean" ? value.needs_parallelism : undefined,
    fallbackMode: typeof value.fallback_mode === "string" ? value.fallback_mode : undefined
  };
}

function formatRouteState(route: RouteState): string {
  return [
    `${route.mode}${typeof route.confidence === "number" ? `/${Math.round(route.confidence * 100)}%` : ""}`,
    route.requiresWorkspace === undefined ? undefined : `workspace=${route.requiresWorkspace}`,
    route.needsParallelism === undefined ? undefined : `parallel=${route.needsParallelism}`,
    route.fallbackMode ? `fallback=${route.fallbackMode}` : undefined,
    `reason=${route.reason}`
  ].filter(Boolean).join(" ");
}

function safeWorkSnapshot(runtime: SwarmRuntime, sessionId: string): ReturnType<SwarmRuntime["getWorkSnapshot"]> | undefined {
  try {
    return runtime.getWorkSnapshot(sessionId);
  } catch {
    return undefined;
  }
}

function leaseRowsForTarget(runtime: SwarmRuntime, target: string): WorkspaceLease[] {
  const byId = runtime.workspaceLeaseStore.get(target);
  if (byId) {
    return [byId];
  }
  return runtime.workspaceLeaseStore.listBySession(target, 20);
}

function buildResumePrompt(runtime: SwarmRuntime, sessionId: string, instruction: string): string {
  return runtime.buildResumePrompt(sessionId, instruction);
}

function parseResumeTarget(
  runtime: SwarmRuntime,
  lastSessionId: string | undefined,
  parsed: ReturnType<typeof parseSlashCommandLine>,
  args: string[],
  command: "resume" | "continue"
): { sessionId?: string; instruction: string } {
  const latestSessionId = lastSessionId ?? runtime.listRecentSessionsForWorkspace(1)[0]?.session_id;
  if (command === "continue") {
    return {
      sessionId: latestSessionId,
      instruction: parsed ? parsed.rawArgs : args.join(" ").trim()
    };
  }
  const first = args[0];
  const firstIsExistingSession = first ? Boolean(runtime.sessionStore.get(first)) : false;
  if (firstIsExistingSession) {
    return {
      sessionId: first,
      instruction: parsed ? rawSlashArgsAfter(parsed, 1) : args.slice(1).join(" ").trim()
    };
  }
  return {
    sessionId: latestSessionId,
    instruction: parsed ? parsed.rawArgs : args.join(" ").trim()
  };
}

function formatSymphonyStatus(status: SymphonyStatus): string {
  return [
    status.workflow.ok ? `Workflow: ${status.workflow.workflow.path}` : `Workflow error: ${status.workflow.error.message}`,
    `Generated: ${status.generated_at}`,
    "",
    "Totals",
    `sessions=${status.totals.sessions} running=${status.totals.running} completed=${status.totals.completed} failed=${status.totals.failed} cancelled=${status.totals.cancelled} retrying=${status.totals.retrying}`,
    `capacity=${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent} available=${status.scheduler.capacity.available}`,
    "",
    "Running",
    ...(status.scheduler.running.length
      ? status.scheduler.running.map((item) => `${item.session_id} [${item.status}] ${workItemLabel(item.work_item)} workspace=${item.workspace_path || "-"}`)
      : ["(none)"]),
    "",
    "Retrying",
    ...(status.scheduler.retrying.length
      ? status.scheduler.retrying.map((item) => `${workItemLabel(item.work_item)} attempt=${item.attempt} due=${item.due_at}${item.error ? ` error=${item.error}` : ""}`)
      : ["(none)"]),
    "",
    "Recent Sessions",
    ...(status.sessions.length
      ? status.sessions.map((session) => `${session.session_id} [${session.status}] ${workItemLabel(session.work_item)}${session.runner_attempt ? ` runner=${session.runner_attempt.status}` : ""}${session.next_retry_at ? ` retry=${session.next_retry_at}` : ""}`)
      : ["(none)"])
  ].join("\n");
}

function formatSymphonyTick(result: SymphonyTickResult): string {
  return [
    result.workflow.ok ? `Workflow: ${result.workflow.workflow.path}` : `Workflow error: ${result.workflow.error.message}`,
    `candidates=${result.candidates.length} dispatched=${result.dispatched.length} skipped=${result.skipped.length} failed=${result.failed.length} runs=${result.runs?.length ?? 0}`,
    result.preflight ? `preflight=${result.preflight.ok ? "ok" : "failed"} issues=${result.preflight.issues.length}` : "preflight=(not run)",
    ...(result.preflight?.issues.length
      ? result.preflight.issues.map((issue) => `preflight ${issue.severity} ${issue.code}: ${issue.message}`)
      : []),
    "",
    "Dispatched",
    ...(result.dispatched.length
      ? result.dispatched.map((record) => `${record.session?.session_id ?? "-"} ${workItemLabel(record.work_item)} workspace=${record.workspace_path ?? "-"}${record.reason ? ` reason=${record.reason}` : ""}`)
      : ["(none)"]),
    "",
    "Skipped",
    ...(result.skipped.length
      ? result.skipped.map((record) => `${workItemLabel(record.work_item)} ${record.reason ?? "skipped"}`)
      : ["(none)"]),
    "",
    "Failed",
    ...(result.failed.length
      ? result.failed.map((record) => `${workItemLabel(record.work_item)} ${record.error ?? record.reason ?? "failed"}`)
      : ["(none)"]),
    "",
    "Runs",
    ...(result.runs?.length
      ? result.runs.map((run) => `${run.session_id ?? "-"} [${run.status}]${run.error ? ` ${run.error}` : ""}`)
      : ["(none)"]),
    "",
    "Scheduler",
    `claimed=${result.snapshot.claimed.length} completed=${result.snapshot.completed.length} running=${result.snapshot.capacity.running}/${result.snapshot.capacity.max_concurrent} retrying=${result.snapshot.retrying.length}`,
    ...(result.snapshot.running.length
      ? result.snapshot.running.map((item) => `${item.session_id} [${item.status}] ${workItemLabel(item.work_item)} workspace=${item.workspace_path}`)
      : []),
    ...(result.snapshot.retrying.length
      ? result.snapshot.retrying.map((item) => `${workItemLabel(item.work_item)} retry=${item.attempt} due=${item.due_at}${item.error ? ` error=${item.error}` : ""}`)
      : [])
  ].join("\n");
}

function formatSymphonyCleanup(result: SymphonyCleanupResult): string {
  return [
    result.workflow.ok ? `Workflow: ${result.workflow.workflow.path}` : `Workflow error: ${result.workflow.error.message}`,
    `Mode: ${result.execute ? "execute" : "dry-run"}`,
    `Retention: min_age_ms=${result.retention.min_age_ms} keep_latest=${result.retention.keep_latest} preserve_artifacts=${result.retention.preserve_artifacts}`,
    `inspected=${result.inspected} removed=${result.removed} skipped=${result.skipped} failed=${result.failed}`,
    "",
    "Records",
    ...(result.records.length
      ? result.records.map((record) => `${record.session_id} [${record.status}] ${workItemLabel(record.work_item)} ${record.workspace?.workspace_path ?? ""}${record.reason ? ` - ${record.reason}` : ""}${record.age_ms !== undefined ? ` age_ms=${record.age_ms}` : ""}${record.artifact_path ? ` artifact=${record.artifact_path}` : ""}${record.error ? ` error=${record.error}` : ""}`)
      : ["(none)"])
  ].join("\n");
}

function formatSymphonyDaemons(records: SymphonyDaemonRecord[]): string {
  return [
    `Daemons: ${records.length}`,
    "",
    ...(records.length
      ? records.map((record) => [
        `${record.daemon_id} [${record.status}] ticks=${record.tick_count}${record.execute ? " execute" : ""}${record.stop_reason ? ` reason=${record.stop_reason}` : ""}`,
        `workflow=${record.workflow_path ?? "-"}`,
        `created=${record.created_at} updated=${record.updated_at}${record.next_tick_at ? ` next=${record.next_tick_at}` : ""}`,
        record.last_result
          ? `last tick=${record.last_result.tick} candidates=${record.last_result.candidates} dispatched=${record.last_result.dispatched} skipped=${record.last_result.skipped} failed=${record.last_result.failed} running=${record.last_result.running}/${record.last_result.max_concurrent}`
          : "last=(none)",
        record.history.length
          ? `history=${record.history.slice(-5).map((item) => `#${item.tick}:${item.status}:${item.dispatched}/${item.skipped}/${item.failed}`).join(" ")}`
          : undefined,
        record.last_error ? `error=${record.last_error}` : undefined
      ].filter(Boolean).join("\n"))
      : ["(none)"])
  ].join("\n\n");
}

function formatWorkItems(workflow: Extract<WorkflowLoadResult, { ok: true }>, sourceKind: string, active: WorkItem[], terminal: WorkItem[]): string {
  const config = normalizeWorkflowConfig(workflow.workflow);
  return [
    `Workflow: ${workflow.workflow.path}`,
    `Source: ${sourceKind} ${config.work_source.path ?? "WORK_ITEMS.md"}`,
    `Active states: ${config.work_source.active_states.join(", ")}`,
    `Terminal states: ${config.work_source.terminal_states.join(", ")}`,
    "",
    `Active Work Items: ${active.length}`,
    ...(active.length ? active.map(formatWorkItemLine) : ["(none)"]),
    "",
    `Terminal Work Items: ${terminal.length}`,
    ...(terminal.length ? terminal.slice(0, 50).map(formatWorkItemLine) : ["(none)"])
  ].join("\n");
}

function formatWorkItemLine(item: WorkItem): string {
  const priority = typeof item.priority === "number" ? ` p=${item.priority}` : "";
  const labels = item.labels.length ? ` labels=${item.labels.join(",")}` : "";
  return `${workItemLabel(item)} [${item.state ?? "-"}]${priority}${labels} ${item.title}`;
}

function parseSymphonyTickArgs(args: string[]): {
  workflowPath?: string;
  createWorkspace?: boolean;
  maxRunnerTurns?: number;
  maxRunnerToolCalls?: number;
} {
  const workflowPath = args.find((arg, index) => !arg.startsWith("--") && !isOptionValue(args, index));
  return {
    workflowPath,
    createWorkspace: !args.includes("--no-create"),
    maxRunnerTurns: parsePositiveSlashInteger(args, "--max-turns"),
    maxRunnerToolCalls: parsePositiveSlashInteger(args, "--max-tool-calls")
  };
}

function parseSymphonyDaemonStartArgs(args: string[]): {
  workflowPath?: string;
  createWorkspace?: boolean;
  execute?: boolean;
  maxRunnerTurns?: number;
  maxRunnerToolCalls?: number;
  maxTicks?: number;
} {
  const workflowPath = args.find((arg, index) => !arg.startsWith("--") && !isOptionValue(args, index));
  return {
    workflowPath,
    createWorkspace: !args.includes("--no-create"),
    execute: args.includes("--execute") || args.includes("--run"),
    maxRunnerTurns: parsePositiveSlashInteger(args, "--max-turns"),
    maxRunnerToolCalls: parsePositiveSlashInteger(args, "--max-tool-calls"),
    maxTicks: parsePositiveSlashInteger(args, "--max-ticks")
  };
}

function parseSymphonyDaemonStopArgs(args: string[]): {
  daemonId?: string;
  reason?: string;
  cancelRunning?: boolean;
} {
  const target = args.find((arg, index) => !arg.startsWith("--") && !isOptionValue(args, index));
  return {
    daemonId: target && target !== "all" ? target : undefined,
    reason: slashOptionValue(args, "--reason") ?? "tui_stop",
    cancelRunning: args.includes("--cancel-running")
  };
}

function parsePositiveSlashInteger(args: string[], flag: string): number | undefined {
  const value = slashOptionValue(args, flag);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return Math.floor(parsed);
}

function slashOptionValue(args: string[], flag: string): string | undefined {
  const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
  if (prefixed) {
    return prefixed.slice(flag.length + 1);
  }
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function isOptionValue(args: string[], index: number): boolean {
  const previous = args[index - 1];
  return previous === "--max-turns"
    || previous === "--max-tool-calls"
    || previous === "--max-ticks"
    || previous === "--reason";
}

function currentModelBrief(settings: ReturnType<typeof loadSwarmSettings>): string {
  const planner = settings.models.planner || "not set";
  const worker = settings.models.worker || "not set";
  const aggregator = settings.models.aggregator || "not set";
  return `planner=${planner} worker=${worker} aggregator=${aggregator}`;
}

function formatHandoff(handoff: HandoffSessionRecord): string {
  return [
    `${handoff.handoff_id} [${handoff.status}]`,
    `worker=${handoff.worker_id}`,
    `parent=${handoff.parent_session_id}`,
    `source=${handoff.source_agent}`,
    `target=${handoff.target_agent_spec_id}`,
    `reason=${handoff.reason}`,
    handoff.result ? `result=${handoff.result}` : undefined,
    `task_packet=${JSON.stringify(handoff.task_packet, null, 2)}`,
    `updated=${handoff.updated_at}`
  ].filter(Boolean).join("\n");
}

function formatCapabilities(capabilities: CapabilityDescriptor[], providers: CapabilityProviderSummaryRow[]): string {
  const providerLines = [...providers]
    .sort((left, right) => right.capabilities - left.capabilities || left.providerId.localeCompare(right.providerId))
    .map((provider) => {
      const diagnostics = provider.diagnostics.length
        ? ` diagnostics=${provider.diagnostics.map((item) => item.code ?? item.severity).join(",")}`
        : "";
      return `${provider.providerId}: ${provider.capabilities} capabilities${diagnostics}`;
    });
  const grouped = new Map<string, CapabilityDescriptor[]>();
  for (const capability of capabilities) {
    grouped.set(capability.kind, [...(grouped.get(capability.kind) ?? []), capability]);
  }
  const capabilityLines = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([kind, rows]) => [
      "",
      kind,
      ...rows.map((capability) => [
        `  ${capability.id} [${capability.providerId}/${capability.trust}/${capability.riskClass}]`,
        `    ${capability.title ?? capability.name}`,
        `    ${capability.description}`,
        `    permission=${capability.permissionName} model=${capability.modelVisible ? "yes" : "no"} user=${capability.userVisible ? "yes" : "no"}`
      ].join("\n"))
    ]);
  return [
    "Providers",
    ...(providerLines.length ? providerLines : ["No providers registered."]),
    ...capabilityLines
  ].join("\n");
}

function formatCapabilitySummary(capabilities: CapabilityDescriptor[], providers: CapabilityProviderSummaryRow[]): string {
  const summary = summarizeCapabilityCatalog(capabilities, providers);
  if (summary.totals.capabilities === 0) {
    return [
      "Capability summary",
      "No capabilities discovered.",
      "Use /capabilities all after loading skills, plugins, or MCP servers."
    ].join("\n");
  }

  return [
    "Capability summary",
    `${summary.totals.capabilities} capabilities across ${summary.totals.providers} providers.`,
    `Ready=${summary.totals.ready} model-visible=${summary.totals.modelVisible} hidden=${summary.totals.hidden}.`,
    "",
    "By kind",
    ...summary.byKind.map((item) => `  ${item.kind}: ${item.count}`),
    "",
    "Top surfaces",
    ...(summary.topCapabilities.length
      ? summary.topCapabilities.map((item) => `  ${item.id} - ${item.title} [${item.kind}/${item.providerId}]`)
      : ["  (none)"]),
    "",
    "Provider health",
    ...(summary.providers.length
      ? summary.providers.map((provider) => {
          const diagnostics = provider.diagnostics.length
            ? ` diagnostics=${provider.diagnostics.map((item) => item.code ?? item.severity).join(",")}`
            : "";
          return `  ${provider.providerId}: ${provider.capabilities} capabilities${diagnostics}`;
        })
      : ["  (none)"]),
    ...(summary.diagnostics.length
      ? ["", "Diagnostics", ...summary.diagnostics.map((item) => `  ${item.providerId}: ${item.code ?? "diagnostic"} ${item.message}`)]
      : []),
    "",
    "Use /capabilities all for the full catalog."
  ].join("\n");
}

function formatSkillsSummary(skills: SkillRecord[]): string {
  const summary = summarizeSkillCatalog(skills);
  if (summary.totals.skills === 0) {
    return [
      "Skill summary",
      "No skills discovered.",
      "Use /skills all after adding project or user skills."
    ].join("\n");
  }

  return [
    "Skill summary",
    `${summary.totals.active} active skills, ${summary.totals.shadowed} shadowed.`,
    "",
    "Active skills",
    ...(summary.topSkills.length
      ? summary.topSkills.map((skill) => `  ${skill.name} [${skill.scope}/${skill.trust}] - ${firstLine(skill.description, 96)}`)
      : ["  (none)"]),
    ...(summary.diagnostics.length
      ? ["", "Diagnostics", ...summary.diagnostics.map((item) => `  ${item.name}: ${item.code ?? "diagnostic"} ${item.message}`)]
      : []),
    "",
    "Use /skills all for the full catalog."
  ].join("\n");
}

function formatSkills(skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return "No skills discovered.";
  }
  return skills.map((skill) => [
    `${skill.name} [${skill.scope}/${skill.trust}]${skill.shadowedBy ? " shadowed" : ""}`,
    skill.description,
    `path=${skill.path}`,
    skill.allowedTools.length ? `allowed-tools=${skill.allowedTools.join(", ")}` : undefined,
    skill.resourcePaths.length ? `resources=${skill.resourcePaths.length}` : undefined,
    skill.shadowedBy ? `shadowed_by=${skill.shadowedBy}` : undefined,
    ...(skill.diagnostics ?? []).map((item) => `${item.severity}: ${item.code ?? "diagnostic"} ${item.message}`)
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatCustomCommandsSummary(commands: CustomCommandRecord[]): string {
  const active = commands.filter((command) => !command.shadowedBy);
  if (commands.length === 0) {
    return [
      "Custom command summary",
      "No custom commands discovered.",
      "Add Markdown files under ~/.swarm/commands or .swarm/commands."
    ].join("\n");
  }
  return [
    "Custom command summary",
    `${active.length} active commands, ${commands.length - active.length} shadowed.`,
    "",
    "Active commands",
    ...(active.length
      ? active.slice(0, 8).map((command) => `  /${command.name} [${command.scope}/${command.trust}] - ${firstLine(command.description, 96)}`)
      : ["  (none)"]),
    "",
    "Use /commands all for paths, diagnostics, and prompt previews."
  ].join("\n");
}

function customSlashCommandCandidates(commands: CustomCommandRecord[]): SlashCommandSpec[] {
  return commands
    .filter((command) => !command.shadowedBy && command.trust !== "disabled" && command.trust !== "untrusted")
    .map((command): SlashCommandSpec => ({
      name: command.name,
      group: "Config",
      usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      description: command.description,
      completionPriority: 120
    }));
}

function pluginSlashCommandCandidates(plugins: PluginRecord[]): SlashCommandSpec[] {
  return listTrustedPluginSlashCommands(plugins)
    .map(({ contribution }): SlashCommandSpec => ({
      name: contribution.id,
      group: "Config",
      usage: stringMetadata(contribution.metadata.usage) || `/${contribution.id}`,
      description: contribution.description,
      completionPriority: 130
    }));
}

function listTrustedPluginSlashCommands(plugins: PluginRecord[]): PluginSlashCommandRecord[] {
  return plugins
    .filter((plugin) => plugin.trust === "trusted")
    .flatMap((plugin) =>
      plugin.contributions
        .filter((contribution): contribution is PluginContributionRecord => contribution.kind === "slash_command")
        .map((contribution) => ({ plugin, contribution }))
    )
    .sort((left, right) => left.plugin.id.localeCompare(right.plugin.id) || left.contribution.id.localeCompare(right.contribution.id));
}

function formatCustomCommands(commands: CustomCommandRecord[]): string {
  if (commands.length === 0) {
    return "No custom commands discovered.";
  }
  return commands.map((command) => [
    `/${command.name} [${command.scope}/${command.trust}]${command.shadowedBy ? " shadowed" : ""}`,
    command.description,
    command.argumentHint ? `arguments=${command.argumentHint}` : undefined,
    `path=${command.path}`,
    command.shadowedBy ? `shadowed_by=${command.shadowedBy}` : undefined,
    command.content ? `prompt_preview=${firstLine(command.content, 180)}` : undefined,
    ...(command.diagnostics ?? []).map((item) => `${item.severity}: ${item.code ?? "diagnostic"} ${item.message}`)
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatPluginSlashCommandsSummary(commands: PluginSlashCommandRecord[]): string {
  return [
    "Plugin slash command summary",
    commands.length
      ? `${commands.length} trusted plugin slash commands.`
      : "No trusted plugin slash commands discovered.",
    "",
    "Active plugin commands",
    ...(commands.length
      ? commands.slice(0, 8).map(({ plugin, contribution }) => `  /${contribution.id} [plugin:${plugin.id}] - ${firstLine(contribution.description, 96)}`)
      : ["  (none)"]),
    "",
    "Use /plugins all for plugin manifests and diagnostics."
  ].join("\n");
}

function formatPluginSlashCommands(commands: PluginSlashCommandRecord[]): string {
  if (commands.length === 0) {
    return "No trusted plugin slash commands discovered.";
  }
  return commands.map(({ plugin, contribution }) => [
    `/${contribution.id} [plugin:${plugin.id}/${plugin.trust}]`,
    contribution.description,
    `usage=${stringMetadata(contribution.metadata.usage) || `/${contribution.id}`}`,
    `plugin_path=${plugin.path}`,
    stringMetadata(contribution.metadata.prompt) ? `prompt_preview=${firstLine(stringMetadata(contribution.metadata.prompt) as string, 180)}` : undefined
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatPluginsSummary(plugins: PluginRecord[]): string {
  const summary = summarizePluginCatalog(plugins);
  if (summary.totals.plugins === 0) {
    return [
      "Plugin summary",
      "No plugins discovered.",
      "Use /plugins all after installing a project or user plugin."
    ].join("\n");
  }

  return [
    "Plugin summary",
    `${summary.totals.plugins} plugins discovered, ${summary.totals.trusted} trusted, ${summary.totals.contributions} contributions.`,
    "",
    "Top plugins",
    ...(summary.topPlugins.length
      ? summary.topPlugins.map((plugin) => `  ${plugin.id} [${plugin.scope}/${plugin.trust}] - ${firstLine(plugin.description, 96)} (${plugin.contributions} contributions)`)
      : ["  (none)"]),
    ...(summary.slashContributions.length
      ? ["", "Slash contributions", ...summary.slashContributions.map((item) => `  ${item.pluginId}:${item.id} ${firstLine(item.description, 96)}`)]
      : []),
    ...(summary.diagnostics.length
      ? ["", "Diagnostics", ...summary.diagnostics.map((item) => `  ${item.pluginId}: ${item.code ?? "diagnostic"} ${item.message}`)]
      : []),
    "",
    "Use /plugins all for the full catalog."
  ].join("\n");
}

function formatPlugins(plugins: PluginRecord[]): string {
  if (plugins.length === 0) {
    return "No plugins discovered.";
  }
  return plugins.map((plugin) => [
    `${plugin.id} [${plugin.scope}/${plugin.trust}]${plugin.version ? ` v${plugin.version}` : ""}`,
    plugin.description,
    `path=${plugin.path}`,
    `checksum=${plugin.checksum.slice(0, 16)}`,
    plugin.contributions.length
      ? [
        "contributions",
        ...plugin.contributions.map((item) => [
          `  ${item.kind}:${item.id} [${item.riskClass}] ${item.title}`,
          item.kind === "slash_command" ? `    usage=${String(item.metadata.usage ?? `/${item.id}`)}` : undefined
        ].filter(Boolean).join("\n"))
      ].join("\n")
      : "contributions=(none)",
    ...(plugin.diagnostics ?? []).map((item) => `${item.severity}: ${item.code ?? "diagnostic"} ${item.message}`)
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatMcpServersSummary(servers: McpServerRecord[]): string {
  const summary = summarizeMcpCatalog(servers);
  if (summary.totals.servers === 0) {
    return [
      "MCP summary",
      "No MCP servers configured.",
      "Use /mcp all after enabling MCP or adding a server."
    ].join("\n");
  }

  return [
    "MCP summary",
    `${summary.totals.servers} servers configured.`,
    `  connected: ${summary.totals.connected}`,
    `  pending: ${summary.totals.pending}`,
    `  failed: ${summary.totals.failed}`,
    `  disabled: ${summary.totals.disabled}`,
    "",
    "Top servers",
    ...(summary.topServers.length
      ? summary.topServers.map((server) => `  ${server.id} [${server.status}/${server.transport}/${server.trust}] tools=${server.tools} resources=${server.resources} prompts=${server.prompts}`)
      : ["  (none)"]),
    ...(summary.errors.length ? ["", "Recent errors", ...summary.errors.map((item) => `  ${item.serverId}: ${item.message}`)] : []),
    ...(summary.diagnostics.length
      ? ["", "Diagnostics", ...summary.diagnostics.map((item) => `  ${item.serverId}: ${item.code ?? "diagnostic"} ${item.message}`)]
      : []),
    "",
    "Use /mcp all for the full catalog."
  ].join("\n");
}

function formatActivatedSkill(skill: ActivatedSkill): string {
  return [
    `${skill.name} [${skill.scope}/${skill.trust}]`,
    skill.description,
    `path=${skill.path}`,
    skill.allowedTools.length ? `allowed-tools=${skill.allowedTools.join(", ")}` : undefined,
    skill.resourcePaths.length ? `resources=\n${skill.resourcePaths.map((path) => `  ${path}`).join("\n")}` : undefined,
    "",
    skill.content
  ].filter(Boolean).join("\n");
}

function hasAdvancedSurfaceFlag(args: string[]): boolean {
  return args.some((arg) => ADVANCED_SURFACE_FLAGS.has(arg.toLowerCase()));
}

function stripAdvancedSurfaceFlags(args: string[]): string[] {
  return args.filter((arg) => !ADVANCED_SURFACE_FLAGS.has(arg.toLowerCase()));
}

function hasCapabilityCommandFilter(filter: { kind?: string; providerId?: string; query?: string }): boolean {
  return Boolean(filter.kind || filter.providerId || filter.query);
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findPluginSlashCommand(plugins: PluginRecord[], command: string): { plugin: PluginRecord; contribution: PluginRecord["contributions"][number] } | undefined {
  const normalized = command.trim().toLowerCase();
  for (const plugin of plugins) {
    if (plugin.trust !== "trusted") {
      continue;
    }
    const contribution = plugin.contributions.find((item) => item.kind === "slash_command" && item.id === normalized);
    if (contribution) {
      return { plugin, contribution };
    }
  }
  return undefined;
}

function formatMcpServers(servers: McpServerRecord[]): string {
  if (servers.length === 0) {
    return "No MCP servers configured.";
  }
  return servers.map((server) => [
    `${server.id} [${server.status}/${server.transport}/${server.trust}] tools=${server.toolCount}`,
    server.serverName ? `server=${server.serverName}${server.serverVersion ? ` ${server.serverVersion}` : ""}` : undefined,
    server.command ? `command=${[server.command, ...(server.args ?? [])].join(" ")}` : undefined,
    server.cwd ? `cwd=${server.cwd}` : undefined,
    server.url ? `url=${server.url}` : undefined,
    `expose tools=${server.exposeTools ? "yes" : "no"} resources=${server.exposeResources ? "yes" : "no"} prompts=${server.exposePrompts ? "yes" : "no"}`,
    server.lastConnectedAt ? `connected=${server.lastConnectedAt}` : undefined,
    server.lastError ? `error=${server.lastError}` : undefined,
    ...(server.diagnostics ?? []).slice(-8).map((item) => `${item.severity}: ${item.code ?? "diagnostic"} ${item.message}`)
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatMcpResource(resource: { uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number }): string {
  return [
    `${resource.name} ${resource.title ? `(${resource.title})` : ""}`,
    `uri=${resource.uri}`,
    resource.mimeType ? `mime=${resource.mimeType}` : undefined,
    typeof resource.size === "number" ? `size=${resource.size}` : undefined,
    resource.description
  ].filter(Boolean).join("\n");
}

function formatMcpPrompt(prompt: { name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }): string {
  return [
    `${prompt.name} ${prompt.title ? `(${prompt.title})` : ""}`,
    prompt.description,
    prompt.arguments?.length
      ? `args=${prompt.arguments.map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ")}`
      : "args=(none)"
  ].filter(Boolean).join("\n");
}

function formatMcpResourceReadResult(result: { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }): string {
  return result.contents.map((item) => [
    `--- ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ""} ---`,
    item.text ?? (item.blob ? `[blob base64 ${item.blob.length} chars]` : "")
  ].join("\n")).join("\n\n");
}

function formatMcpPromptResult(result: { description?: string; messages: Array<{ role: string; content: unknown }> }): string {
  return [
    result.description,
    ...result.messages.map((message, index) => [
      `--- ${index + 1}. ${message.role} ---`,
      formatMcpPromptContent(message.content)
    ].join("\n"))
  ].filter(Boolean).join("\n\n");
}

function formatMcpPromptContent(content: unknown): string {
  if (typeof content === "object" && content !== null && "type" in content) {
    const typed = content as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown; resource?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      return typed.text;
    }
    if (typed.type === "image" || typed.type === "audio") {
      return `[${String(typed.type)} ${String(typed.mimeType ?? "")} ${typeof typed.data === "string" ? `${typed.data.length} chars` : ""}]`;
    }
    if (typed.type === "resource") {
      return JSON.stringify(typed.resource, null, 2);
    }
  }
  return JSON.stringify(content, null, 2);
}

function formatApprovalRecord(approval: ReturnType<SwarmRuntime["approvalStore"]["list"]>[number]): string {
  return [
    `${approval.approval_id} [${approval.status}] ${approval.risk_class}/${approval.risk}`,
    `session=${approval.session_id ?? "-"} task=${approval.task_id ?? "-"}`,
    `action=${approval.action} target=${approval.target}`,
    approval.summary,
    `why=${approval.challenge.why_now}`,
    approval.challenge.attention_note ? `attention=${approval.challenge.attention_note}` : undefined,
    `impact=${approval.challenge.predicted_impact}`,
    `rollback=${approval.challenge.rollback_plan}`,
    approval.challenge.summary_diff ? `diff=\n${approval.challenge.summary_diff}` : undefined
  ].filter(Boolean).join("\n");
}

function formatRunAttemptSummary(attempt: RunAttempt): string {
  return [
    `${attempt.last_event_at} ${attempt.session_id}`,
        `${attempt.kind} ${attempt.task_id ?? attempt.runner_id ?? "-"}`,
        `[${attempt.status}] #${attempt.attempt}`,
        attempt.title,
        attempt.terminal_reason ? `- ${attempt.terminal_reason}` : undefined,
        attempt.recovery_suggestion ? `recovery=${attempt.recovery_suggestion}` : undefined
      ].filter(Boolean).join(" ");
}

function formatRunAttempt(attempt: RunAttempt): string {
  return [
    `${attempt.attempt_id} [${attempt.status}]`,
    `session=${attempt.session_id} kind=${attempt.kind} attempt=${attempt.attempt}`,
    `task=${attempt.task_id ?? "-"} runner=${attempt.runner_id ?? "-"}`,
    attempt.title ? `title=${attempt.title}` : undefined,
    `started=${attempt.started_at} last_event=${attempt.last_event_at}${attempt.ended_at ? ` ended=${attempt.ended_at}` : ""}`,
    `workspace=${attempt.workspace_path ?? "-"}`,
    attempt.terminal_reason ? `reason=${attempt.terminal_reason}` : undefined,
    attempt.error_code ? `error=${attempt.error_code}` : undefined,
    attempt.recovery_suggestion ? `recovery=${attempt.recovery_suggestion}` : undefined,
    Object.keys(attempt.metadata).length ? `metadata=${JSON.stringify(attempt.metadata, null, 2)}` : undefined
  ].filter(Boolean).join("\n");
}

function formatWorkspaceLeaseSummary(lease: WorkspaceLease): string {
  return `${lease.created_at} ${lease.session_id} ${lease.lease_id} boundary=${lease.write_boundary} path=${lease.workspace_path}`;
}

function formatWorkspaceLease(lease: WorkspaceLease): string {
  return [
    `${lease.lease_id} [${lease.write_boundary}]`,
    `session=${lease.session_id}`,
    `root=${lease.workspace_root}`,
    `path=${lease.workspace_path}`,
    `scope=${lease.scope.length ? lease.scope.join(", ") : "-"}`,
    `created=${lease.created_at}`,
    Object.keys(lease.metadata).length ? `metadata=${JSON.stringify(lease.metadata, null, 2)}` : undefined
  ].filter(Boolean).join("\n");
}

function formatAuditRecord(record: ReturnType<SwarmRuntime["auditStore"]["list"]>[number]): string {
  return [
    `${record.created_at} ${record.decision} ${record.risk_class} ${record.action}`,
    `session=${record.session_id ?? "-"} task=${record.task_id ?? "-"} actor=${record.actor_type}:${record.actor_id}`,
    record.reason ? `reason=${record.reason}` : undefined,
    `checksum=${record.checksum.slice(0, 16)}`
  ].filter(Boolean).join(" | ");
}

function formatBlackboardEntry(entry: BlackboardEntry): string {
  return [
    `${entry.entry_id} ${entry.key} [${entry.type}]`,
    `session=${entry.session_id}${entry.task_id ? ` task=${entry.task_id}` : ""}`,
    `by=${entry.created_by.agent_id ?? entry.created_by.role ?? "unknown"} tags=${(entry.tags ?? []).join(",")}`,
    `value=${JSON.stringify(entry.value, null, 2)}`,
    `created=${entry.created_at}${entry.updated_at ? ` updated=${entry.updated_at}` : ""}`
  ].join("\n");
}

function parseBlackboardQuery(tokens: string[]): { type?: BlackboardEntry["type"]; tag?: string; keyPrefix?: string; taskId?: string; agentId?: string } {
  const query: { type?: BlackboardEntry["type"]; tag?: string; keyPrefix?: string; taskId?: string; agentId?: string } = {};
  for (const token of tokens) {
    if (token.startsWith("tag:")) {
      query.tag = token.slice("tag:".length);
    } else if (token.startsWith("key:")) {
      query.keyPrefix = token.slice("key:".length);
    } else if (token.startsWith("task:")) {
      query.taskId = token.slice("task:".length);
    } else if (token.startsWith("agent:")) {
      query.agentId = token.slice("agent:".length);
    } else if (token.startsWith("type:")) {
      const type = token.slice("type:".length);
      if (isBlackboardType(type)) {
        query.type = type;
      }
    } else if (token.trim()) {
      query.keyPrefix = token.trim();
    }
  }
  return query;
}

function parseCapabilityCommandFilter(tokens: string[]): { kind?: string; providerId?: string; query?: string } {
  const filter: { kind?: string; providerId?: string; query?: string } = {};
  const query: string[] = [];
  const knownKinds = new Set(["local_tool", "mcp_tool", "mcp_resource", "mcp_prompt", "skill", "slash_command", "agent_spec", "plugin"]);
  for (const token of tokens) {
    if (token.startsWith("kind:")) {
      filter.kind = token.slice("kind:".length);
    } else if (token.startsWith("provider:")) {
      filter.providerId = token.slice("provider:".length);
    } else if (knownKinds.has(token)) {
      filter.kind = token;
    } else if (token.trim()) {
      query.push(token);
    }
  }
  if (query.length > 0) {
    filter.query = query.join(" ");
  }
  return filter;
}

function parseKeyValueArgs(tokens: string[]): Record<string, string> {
  return Object.fromEntries(tokens
    .map((token) => {
      const index = token.indexOf("=");
      return index > 0 ? [token.slice(0, index), token.slice(index + 1)] as const : undefined;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined));
}

function isBlackboardType(value: string): value is BlackboardEntry["type"] {
  return ["plan", "observation", "evidence", "result", "critique", "decision", "artifact"].includes(value);
}

function parseWebCommandArgs(tokens: string[]): { query: string; allowed_domains?: string[]; blocked_domains?: string[] } {
  const query: string[] = [];
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("allow:")) {
      allowed.push(token.slice("allow:".length));
    } else if (token.startsWith("allowed:")) {
      allowed.push(token.slice("allowed:".length));
    } else if (token.startsWith("site:")) {
      allowed.push(token.slice("site:".length));
    } else if (token.startsWith("block:")) {
      blocked.push(token.slice("block:".length));
    } else if (token.startsWith("blocked:")) {
      blocked.push(token.slice("blocked:".length));
    } else {
      query.push(token);
    }
  }
  return {
    query: query.join(" ").trim(),
    allowed_domains: allowed.filter(Boolean),
    blocked_domains: blocked.filter(Boolean)
  };
}

function slashRawRemainderOrSingleQuotedArg(
  parsed: ReturnType<typeof parseSlashCommandLine>,
  args: string[],
  consumedArgs: number
): string {
  if (!parsed) {
    return args.slice(consumedArgs).join(" ").trim();
  }
  const raw = rawSlashArgsAfter(parsed, consumedArgs);
  const remainingArgs = args.slice(consumedArgs);
  if (remainingArgs.length === 1 && isSingleQuotedToken(raw)) {
    return remainingArgs[0];
  }
  return raw;
}

function isSingleQuotedToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const quote = trimmed[0];
  if (quote !== "\"" && quote !== "'") {
    return false;
  }
  if (trimmed[trimmed.length - 1] !== quote) {
    return false;
  }
  let escaped = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      return false;
    }
  }
  return true;
}

function slashToolFailureResult(action: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = slashToolErrorCode(error, message);
  const sandbox = sandboxDecisionFromError(error);
  const summary = sandbox ? sandboxFailureSummary(sandbox) : message;
  const recoverySuggestion = sandbox ? sandboxRecoverySuggestion(sandbox) : slashToolRecoverySuggestion(action, errorCode, message);
  return {
    action: action as ToolResult["action"],
    status: "failed",
    summary,
    content: formatToolFailureContent(action, summary, errorCode, recoverySuggestion, sandbox),
    errors: [message],
    errorCode,
    retryable: errorCode !== "INVALID_INPUT" && errorCode !== "PERMISSION_DENIED",
    recoverable: true,
    recoverySuggestion,
    metadata: { action, error: message, ...(sandbox ? { sandbox } : {}) }
  };
}

function slashToolErrorCode(error: unknown, message: string): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "ENOENT") return "FS_NOT_FOUND";
    if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
    if (code === "ENOTDIR" || code === "EISDIR") return "INVALID_INPUT";
  }
  if (/permission|denied|approval/i.test(message)) return "PERMISSION_DENIED";
  if (/requires|invalid|unsupported/i.test(message)) return "INVALID_INPUT";
  if (/not found|ENOENT/i.test(message)) return "FS_NOT_FOUND";
  return "TOOL_FAILED";
}

function slashToolRecoverySuggestion(action: string, errorCode: string, message: string): string {
  if (errorCode === "PERMISSION_DENIED") {
    return "Inspect the approval or permission mode, then retry with a narrower command or explicitly allow it.";
  }
  if (errorCode === "FS_NOT_FOUND") {
    return "Use /glob, /grep, /read, or /shell pwd to confirm the path or command, then retry with the resolved value.";
  }
  if (errorCode === "INVALID_INPUT") {
    return "Fix the slash command arguments and retry; use /help for the command shape.";
  }
  if (/timeout/i.test(message)) {
    return "Retry with a narrower command or a longer timeout argument where supported.";
  }
  if (action === "file.edit") {
    return "Re-read the target region and retry with a unique oldText or precise insert line.";
  }
  return "Inspect the error, adjust the command or inputs, and retry from the current workspace state.";
}

function parseLineRange(value: string | undefined): { startLine?: number; endLine?: number } {
  if (!value) {
    return {};
  }
  const [start, end] = value.split(":");
  const startLine = start ? Number(start) : undefined;
  const endLine = end ? Number(end) : undefined;
  return {
    startLine: Number.isFinite(startLine) ? startLine : undefined,
    endLine: Number.isFinite(endLine) ? endLine : undefined
  };
}

function isPermissionMode(value: string): value is PermissionMode {
  return value === "ask" || value === "auto-edit" || value === "full-auto" || value === "yolo";
}

function normalizeRunMode(value: string): RunMode {
  if (value === "auto") {
    return "auto";
  }
  if (value === "fast" || value === "coding" || value === "coding_loop") {
    return "coding_loop";
  }
  if (value === "swarm" || value === "full" || value === "full_swarm") {
    return "full_swarm";
  }
  if (value === "chat") {
    return "chat";
  }
  throw new Error("Usage: /mode auto|fast|swarm|chat");
}

function roleColor(role: ChatMessage["role"]): "cyan" | "green" | "gray" {
  if (role === "assistant") {
    return "green";
  }
  if (role === "system") {
    return "gray";
  }
  return "cyan";
}

function fieldLabel(field: OnboardField): string {
  return {
    provider: "Provider id",
    apiKey: "Plaintext API key",
    planner: "Planner model",
    worker: "Worker model",
    aggregator: "Aggregator model",
    customName: "Custom endpoint name",
    customBaseURL: "Custom base URL",
    customModel: "Custom model"
  }[field];
}

function maskField(field: OnboardField, value: string): string {
  if (field === "apiKey" && value) {
    return "*".repeat(Math.min(12, value.length));
  }
  return value;
}

function mergeWorkerRecords(live: Map<string, WorkerRecord>, persisted: WorkerRecord[], limit: number): WorkerRecord[] {
  const records = [...live.values(), ...persisted].reduce((next, worker) => {
    const existing = next.get(worker.worker_id);
    if (!existing || existing.updated_at < worker.updated_at) {
      next.set(worker.worker_id, worker);
    }
    return next;
  }, new Map<string, WorkerRecord>());
  return Array.from(records.values())
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, limit);
}

function workerStatusColor(status: WorkerRecord["status"]): string {
  switch (status) {
    case "pending": return "yellow";
    case "running": return "cyan";
    case "completed": return "green";
    case "failed": return "red";
    case "stopped": return "yellow";
  }
  return "white";
}

function shouldOfferAiDetail(detail: string): boolean {
  const lineCount = detail.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(detail, "utf8");
  return lineCount > 18 || bytes > 2_200;
}

function stripCommandDetailHint(value: string): string {
  return value
    .replace(/\s*Ctrl\+O[^.]*\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function compactPreview(value: string | undefined): React.ReactElement | null {
  const preview = commandOutputPreview(value, 1, 240) ?? value;
  const line = firstLine(preview ?? "", 92);
  return line ? <Text color="gray" wrap="truncate">{indentPreview(line, "  ")}</Text> : null;
}

function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 10) : value;
}

function shortPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : normalized;
}

function firstLine(value: string, maxLength: number): string {
  const line = value.split(/\r?\n/).find((item) => item.trim())?.trim() ?? "";
  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 1))}…` : line;
}

function statusIcon(status: string): string {
  return statusBadge(status);
}
