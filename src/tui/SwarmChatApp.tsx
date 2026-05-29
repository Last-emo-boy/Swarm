import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "./ui.js";
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
import { buildPermissionReport, buildReadRootPreflightReport } from "../runtime/permission-report.js";
import { buildWorkRecordFromRuntimeEvent } from "../runtime/work-protocol.js";
import { buildSessionWorkBoard, buildWorkspaceWorkBoard, formatWorkBoard, isWorkBoardFilter, type WorkBoardFilter } from "../runtime/work-board.js";
import type { CaseWorkbenchDetail, CaseWorkbenchItem } from "../runtime/case-workbench.js";
import { buildLatestRunDiagnosis } from "../runtime/latest-diagnosis.js";
import { buildProtocolDebugTimeline, formatProtocolDebugTimeline, type ProtocolTimelineCategory, type ProtocolTimelineFilter } from "../runtime/protocol-debug-timeline.js";
import type { RunMode, RunSandboxMode } from "../runtime/execution-router.js";
import type { ExecutionResult, PlannedSession } from "../runtime/orchestrator.js";
import { buildResultCardFromSnapshot, type ResultCard as RuntimeResultCard } from "../runtime/result-card.js";
import { formatPromptCacheBrief, formatPromptCacheDetailWithTrend } from "../runtime/prompt-cache-status.js";
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
import { buildOfflineParityReleaseGate, runCacheLabReport, runLocalEvals, runTuiReplayReport } from "../evals/local-evals.js";
import { buildDoctorReport } from "../doctor/report.js";
import { restoreSessionFromRow } from "../sessions/session-row.js";
import { getSymphonyStatus, type SymphonyStatus } from "../symphony/status.js";
import { cleanupSymphonyWorkspaces, type SymphonyCleanupResult } from "../symphony/cleanup.js";
import { SymphonyDaemonManager, type SymphonyDaemonRecord } from "../symphony/daemon.js";
import { runSymphonyTick, type SymphonyTickResult } from "../symphony/scheduler.js";
import { workItemLabel } from "../symphony/work-item.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowLoadResult } from "../symphony/workflow.js";
import { createWorkSourceFromConfig } from "../symphony/work-source.js";
import { mainPaneLabels, mainPaneOrder, mainPaneShortLabels, normalizeMainPaneId, type MainPaneId } from "./main-panes.js";
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
import { buildResumeCommandResult, decideResumeExecution } from "./resume-control.js";
import { ChatCommandCandidates, ChatInputArea, emptyChatCompletionState, type ChatCompletionState, type ChatInputTelemetryEvent } from "./ChatInputArea.js";
import { createChatInputControllerState, type ChatInputControllerState } from "./chat-input-controller.js";
import { displayWidth, fitToDisplayWidth, padToDisplayWidth } from "./display-width.js";
import {
  emptyIdlePaneSnapshot,
  idlePaneSnapshotSignature,
  readIdlePaneSnapshot,
  symphonyDaemonRecordsSignature,
  type IdlePaneSnapshot
} from "./idle-pane-snapshot.js";
import { approvalInputDecision } from "./approval-input.js";
import { editOnboardFieldInput } from "./onboard-input.js";
import { messageToActionRow, renderActionRowDetail, runtimeEventToActionRow, type TuiActionRow } from "./action-log.js";
import { applyTaskAttemptToTuiState, applyWorkRecordToTuiState, summarizeTaskWritePolicies, type TuiTaskState, type TuiWorkState } from "./work-state.js";
import { ActionLog } from "./components/ActionLog.js";
import { appendTuiLoopActivity, appendTuiRuntimeEvent, runtimeEventDisplaySignature, sameRuntimeEventDisplay } from "./tui-event-buffer.js";
import { ActivityTimeline, activityTimelineLimit } from "./components/ActivityTimeline.js";
import { ApprovalOverlay, type ApprovalOverlayDecision } from "./components/ApprovalOverlay.js";
import { CurrentActionRow } from "./components/CurrentActionRow.js";
import { InspectorPane } from "./components/InspectorPane.js";
import { PlanApprovalOverlay } from "./components/PlanApprovalOverlay.js";
import {
  SwarmWorkbenchLayout,
  compactWorkbenchTitle,
  swarmWorkbenchMetrics,
  workbenchModeCard,
  workbenchPolicyCard,
  workbenchSandboxCard,
  type SwarmWorkbenchNavigationItem,
  type SwarmWorkbenchRenderInput,
  type SwarmWorkbenchSessionItem,
  type SwarmWorkbenchToolItem,
  type SwarmWorkbenchWorkerItem
} from "./components/SwarmWorkbenchLayout.js";
import { ConversationFirstPane } from "./components/ConversationFirstPane.js";
import { ConversationBottomChrome, ConversationFullscreenLayout, ConversationResultLine, ConversationStatusLine } from "./components/ConversationFullscreenLayout.js";
import { CollaborationOverlayPanel } from "./components/CollaborationOverlayPanel.js";
import {
  compactValue,
  policyBadge,
  policyTone,
  progressBar,
  routeBadge,
  sandboxBadge,
  sandboxTone,
  sectionLabel,
  resolveTuiColor,
  statusBadge,
  statusTone,
  toneColor,
  visualTokenColor,
  type TuiColorRef,
  type TuiResolvedColor,
  type TuiTone
} from "./theme.js";
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
  detailOpenInputIntent,
  detailTitleForSource,
  detailOpenTargetForPane,
  fullscreenConversationRows,
  resetConversationViewport,
  shouldOpenDetailFromInput,
  tuiFocusTransitionForInput,
  resolveTuiDensity,
  tuiScreenMode,
  type TuiDensity,
  type TuiDensityPreference,
  type ConversationViewportState,
  type ConversationMessage,
  type TuiFocusTransitionDecision
} from "./conversation-layout.js";
import { compactWorkSnapshotLines, formatSessionMemory, formatWorkSnapshot } from "./work-snapshot-display.js";
import type { McpServerRecord } from "../extensions/mcp.js";
import { renderPluginSlashCommandObjective, type PluginContributionRecord, type PluginRecord } from "../extensions/plugins.js";
import type { SkillRecord, ActivatedSkill } from "../extensions/skills.js";
import { renderCustomCommandObjective, type CustomCommandRecord } from "../extensions/custom-commands.js";
import type { CapabilityDescriptor, CapabilityProviderSnapshot } from "../extensions/types.js";
import { summarizeCapabilityCatalog, summarizeMcpCatalog, summarizePluginCatalog, summarizeSkillCatalog } from "../extensions/catalog-summary.js";
import { mcpSettingsSnapshot } from "../extensions/mcp-report.js";
import { skillSettingsSnapshot } from "../extensions/skill-report.js";
import { getGlobalLspManager, type LspStatusReport } from "../lsp/manager.js";
import { lspHealthStatusFromReport, lspStatusSummaryFromReport } from "./lsp-status.js";
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
  buildSwarmSurfaceProjection,
  formatSwarmSurface,
  formatSwarmTopologySummary,
  formatSwarmWorkbench,
  type SwarmSurfaceMode,
  type SwarmSurfaceProjection
} from "./swarm-surface.js";
import {
  buildTranscriptSearchIndex,
  closeTranscriptSearch,
  createTranscriptSearchState,
  currentTranscriptSearchMatch,
  refreshTranscriptSearch,
  stepTranscriptSearch,
  transcriptSearchSummary,
  updateTranscriptSearch,
  type TranscriptSearchState
} from "./transcript-search.js";
import { appendDetailShortcut, detailOpenHint, transcriptSearchHint } from "./shortcuts.js";
import {
  buildCollaborationActionIntent,
  buildCollaborationCockpitView,
  buildCollaborationTelemetryEvent,
  collaborationOverlayActionForInput,
  collaborationShortcutActionForInput,
  filterCollaborationOverlayView,
  selectCollaborationOverlay,
  type CollaborationOverlayRow,
  type CollaborationActionIntentView,
  type CollaborationOverlayTarget
} from "./collaboration-cockpit.js";
import {
  createMessageCursorState,
  messageCursorReducer,
  selectedConversationMessage,
  type MessageCursorState
} from "./message-folding.js";
import { createInitialRunBoardState, reduceRunBoardActions } from "./run-board/run-board-reducer.js";
import { runBoardActionsFromRuntimeEvent } from "./run-board/runtime-event-to-run-board.js";
import { selectDebugRefsForRow, selectRunBoardSurface } from "./run-board/run-board-selectors.js";
import { selectProductResultCardView } from "./run-board/product-result-card-selectors.js";
import { runBoardAttentionActionForKey } from "./run-board/attention-key-routing.js";
import { RunBoardSurface } from "./run-board/RunBoardSurface.js";
import { ProductResultCard } from "./run-board/ProductResultCard.js";
import { formatElapsed } from "./run-board/run-board-row-format.js";
import type { AttentionAction, AttentionItemView, RunBoardPhase, RunBoardResultAction, RunBoardState, WorkerBoardRow } from "./run-board/run-board-types.js";
import { WorkBoardSurface } from "./work-board/WorkBoardSurface.js";
import { selectWorkBoardSurface } from "./work-board/work-board-selectors.js";

type ChatMessage = ConversationMessage;

type SlashCommandResult = {
  brief: string;
  detail?: string;
  detailSource?: "ai" | "command" | "event";
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

const ROUTE_LABELS: Record<string, string> = {
  chat: "ask",
  ask: "ask",
  coding: "work",
  coding_loop: "work",
  work: "work",
  full_swarm: "team",
  swarm: "team",
  team: "team"
};

type CapabilityProviderSummaryRow = CapabilityProviderSnapshot;

type RecentSessionRow = ReturnType<SwarmRuntime["sessionStore"]["listRecent"]>[number];
type ApprovalStoreRecord = ReturnType<SwarmRuntime["approvalStore"]["list"]>[number];
export type CompactIdleRowData = {
  key: string;
  id: string;
  title: string;
  status?: string;
  badge?: string;
  tone?: TuiTone;
  meta?: Array<string | undefined>;
  priority?: number;
  order?: number;
};
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
const TUI_DENSITIES: TuiDensity[] = ["compact", "default", "comfortable"];

function createChatSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `chat-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function SwarmChatApp({ forceOnboarding = false }: Props): React.ReactElement {
  const { exit } = useApp();
  const { rows: stdoutRows, columns: stdoutColumns } = useStdout();
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
  const [collaborationOverlayTarget, setCollaborationOverlayTarget] = useState<CollaborationOverlayTarget | undefined>();
  const [collaborationOverlayIndex, setCollaborationOverlayIndex] = useState(0);
  const [collaborationOverlayFilter, setCollaborationOverlayFilter] = useState("");
  const [collaborationOverlayFiltering, setCollaborationOverlayFiltering] = useState(false);
  const [decisionTrailExpanded, setDecisionTrailExpanded] = useState(false);
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
  const [lspStatusReport, setLspStatusReport] = useState<LspStatusReport | undefined>();
  const [lastSessionId, setLastSessionId] = useState<string | undefined>();
  const [lastRoute, setLastRoute] = useState<RouteState | undefined>();
  const [latestResultCard, setLatestResultCard] = useState<RuntimeResultCard | undefined>();
  const [runBoardState, setRunBoardState] = useState<RunBoardState>(() => createInitialRunBoardState());
  const [runMode, setRunMode] = useState<RunMode>("auto");
  const [runSandboxMode, setRunSandboxMode] = useState<RunSandboxMode>("workspace-write");
  const [tuiDensity, setTuiDensity] = useState<TuiDensityPreference>("auto");
  const [mainPane, setMainPane] = useState<MainPaneId>("board");
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
  const lspStatusReportSignatureRef = useRef<string | undefined>();
  const chatInputState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const lastActionLogEventSignatureRef = useRef<string | undefined>(undefined);
  const previousActionLogLengthRef = useRef(actionLogRows.length);
  const [motionTick, setMotionTick] = useState(0);

  const terminalRows = stdoutRows || 32;
  const terminalColumns = stdoutColumns || 100;
  const screenDensity = resolveTuiDensity({ density: tuiDensity, pane: mainPane, columns: terminalColumns });
  const detailHeight = Math.max(12, terminalRows - 6);
  const actionLogPageRows = Math.max(4, terminalRows - 12 - completionRows);
  const shouldAnimate = !detailOpen && !onboard.enabled && (busy || Boolean(approval) || Boolean(pendingPlan));
  const extensionCommandCandidates = runtime
    ? [
      ...customSlashCommandCandidates(runtime.listCustomCommands()),
      ...pluginSlashCommandCandidates(runtime.listPlugins())
    ]
    : [];
  const lspHealthStatus = lspHealthStatusFromReport(lspStatusReport);
  const mcpRuntimeSummary = runtime
    ? summarizeMcpCatalog(runtime.listMcpServers(), mcpSettingsSnapshot(runtime)).runtime
    : undefined;
  const skillRuntimeSummary = runtime
    ? summarizeSkillCatalog(runtime.listSkills(), skillSettingsSnapshot(runtime)).runtime
    : undefined;
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
      brief: appendDetailShortcut(report.brief),
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
      setRunBoardState((previous) => {
        const workerId = runBoardWorkerIdFromRuntimeEvent(event);
        const withResolvedSlow = workerId
          ? reduceRunBoardActions(previous, [{
              type: "attention/archive-derived-slow",
              at: eventTimestampForRunBoard(event),
              workerIds: [workerId],
              resolution: "Worker produced new evidence after the slow period."
            }])
          : previous;
        return reduceRunBoardActions(withResolvedSlow, runBoardActionsFromRuntimeEvent(event, {
          latestResultCard
        }));
      });
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
        setRunBoardState((previous) => reduceRunBoardActions(previous, [
          { type: "run/reset", runId: event.session_id, at: new Date().toISOString() },
          ...runBoardActionsFromRuntimeEvent(event)
        ]));
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
    if (!runtime) {
      lspStatusReportSignatureRef.current = undefined;
      setLspStatusReport(undefined);
      return;
    }
    const activeRuntime = runtime;
    let cancelled = false;
    async function refreshLspStatus(): Promise<void> {
      try {
        const report = await getGlobalLspManager(activeRuntime.workspaceRoot()).status();
        if (cancelled) {
          return;
        }
        updateLspStatusReport(report);
      } catch {
        if (!cancelled) {
          lspStatusReportSignatureRef.current = undefined;
          setLspStatusReport(undefined);
        }
      }
    }
    void refreshLspStatus();
    const timer = setInterval(() => {
      void refreshLspStatus();
    }, 5_000);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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

  function updateLspStatusReport(report: LspStatusReport): void {
    const signature = lspStatusReportSignature(report);
    if (signature !== lspStatusReportSignatureRef.current) {
      lspStatusReportSignatureRef.current = signature;
      setLspStatusReport(report);
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

  function appendChatTranscriptMessage(message: ChatMessage, options: { preserveSearch?: boolean } = {}): void {
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
      setTranscriptSearch((state) => options.preserveSearch
        ? refreshTranscriptSearch(state, buildTranscriptSearchIndex(next))
        : closeTranscriptSearch(state));
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
    appendChatTranscriptMessage(message, { preserveSearch: true });
  }

  function emitTuiFocusTransition(
    decision: TuiFocusTransitionDecision,
    keyEvent: Extract<RuntimeEvent, { type: "tui_focus" }>["key_event"],
    actionId?: string
  ): void {
    runtimeRef.current?.events.emitEvent({
      type: "tui_focus",
      key_event: keyEvent,
      focus_before: decision.focusBefore,
      focus_after: decision.focusAfter,
      detail_before: decision.detailBefore,
      detail_after: decision.detailAfter,
      detail_source: decision.detailSource,
      detail_reason: decision.reason,
      allowed: decision.allowed,
      blocked_reason: decision.blockedReason,
      pane_before: decision.paneBefore,
      pane_after: decision.paneAfter,
      route: lastRoute?.mode ?? latestResultCard?.route,
      session_id: lastSessionId,
      action_id: actionId
    });
  }

  function focusDecisionForInput(
    character: string | undefined,
    key: { ctrl?: boolean; return?: boolean; escape?: boolean },
    options: {
      focusBefore?: TuiFocusTransitionDecision["focusBefore"];
      hasFocusedTarget?: boolean;
    } = {}
  ): TuiFocusTransitionDecision {
    return tuiFocusTransitionForInput({
      character,
      key,
      focusBefore: options.focusBefore,
      detailOpen,
      pane: mainPane,
      latestDetailSource,
      hasFocusedTarget: options.hasFocusedTarget
    });
  }

  function logTuiInputTelemetry(event: ChatInputTelemetryEvent): void {
    runtimeRef.current?.debug?.debug("tui-input", `${event.key} len=${event.promptLengthAfter} changed=${event.changed} submitted=${event.submitted}`, {
      key: event.key,
      inputLength: event.inputLength,
      promptLengthBefore: event.promptLengthBefore,
      promptLengthAfter: event.promptLengthAfter,
      cursorBefore: event.cursorBefore,
      cursorAfter: event.cursorAfter,
      changed: event.changed,
      submitted: event.submitted,
      completionOpen: event.completionOpen,
      source: event.source,
      pane: mainPane,
      detailOpen,
      busy,
      approval: Boolean(approval),
      onboard: onboard.enabled
    });
  }

  function logTuiExitTelemetry(reason: "onboarding" | "interrupt-requested" | "exit"): void {
    runtimeRef.current?.debug?.debug("tui-exit", `ctrl+c ${reason}`, {
      pane: mainPane,
      detailOpen,
      busy,
      approval: Boolean(approval),
      onboard: onboard.enabled,
      session_id: lastSessionId,
      route: lastRoute?.mode
    });
  }

  useInput((character, key) => {
    if (detailOpen) {
      if (key.escape || (key.ctrl && (character === "o" || character === "c")) || character === "q") {
        emitTuiFocusTransition(
          focusDecisionForInput(character, key, { focusBefore: "detail", hasFocusedTarget: true }),
          tuiKeyEventForInput(character, key)
        );
        setDetailOpen(false);
        setCollaborationOverlayTarget(undefined);
        return;
      }
      handleDetailInput(key);
      return;
    }

    if (approval && handleApprovalInput(character, key)) {
      return;
    }

    if (handleCollaborationOverlayInput(character, key)) {
      return;
    }

    if (handleCollaborationShortcutInput(character, key)) {
      return;
    }

    if (handleRunBoardAttentionKey(character, key)) {
      return;
    }

    if (onboard.enabled) {
      if (key.ctrl && character === "c") {
        logTuiExitTelemetry("onboarding");
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
          logTuiExitTelemetry("interrupt-requested");
          setLastSessionId(target.session_id);
          appendChatMessage({ role: "system", brief: `Interrupt requested for ${target.session_id}. Swarm will reassess at the next safe boundary.` });
        } catch (error) {
          pushError(error);
        }
        return;
      }
      logTuiExitTelemetry("exit");
      exit();
      return;
    }

    if (detailOpenInputIntent({ character, key }) === "explicit") {
      const target = detailOpenTargetForPane({
        pane: mainPane,
        actionCount: actionLogRows.length,
        hasLatestDetail: latestDetailSource !== "none"
      });
      if (target === "selected-action") {
        const row = actionLogRows[selectedActionIndex] ?? actionLogRows.at(-1);
        emitTuiFocusTransition(
          focusDecisionForInput(character, key, { focusBefore: "action-log", hasFocusedTarget: actionLogRows.length > 0 }),
          tuiKeyEventForInput(character, key),
          row?.id
        );
        openSelectedActionDetail(true);
        return;
      }
      if (target === "latest") {
        emitTuiFocusTransition(
          focusDecisionForInput(character, key, { focusBefore: "input", hasFocusedTarget: true }),
          tuiKeyEventForInput(character, key)
        );
        setDetailOpen(true);
      }
      return;
    }

    if (key.return && chatInputState.current.input.value.trim().length === 0 && !transcriptSearch.active) {
      emitTuiFocusTransition(
        focusDecisionForInput(character, key, { focusBefore: "input", hasFocusedTarget: latestDetailSource !== "none" }),
        tuiKeyEventForInput(character, key)
      );
      return;
    }

    if (key.ctrl && character === "t") {
      openTaskDetail();
      return;
    }

    if (handleCollaborationShortcutInput(character, key)) {
      return;
    }

    if (handleTranscriptSearchInput(character, key)) {
      return;
    }

    if (!busy && pendingPlan) {
      const normalized = normalizeActionLogControlCharacter(character);
      if (normalized === "y") {
        void executePendingPlan();
        return;
      }
      if (normalized === "n") {
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
    appendReadRootPreflightMessage(objective);
    try {
      const result = await runtime.run(objective, { mode: runMode, sandboxMode: runSandboxMode, tuiChatSessionId: chatSessionId.current });
      const display = formatExecutionResultDisplay(result, runtime);
      setLatestResultCard(result.result_card);
      recordRunBoardResultCard(result.result_card);
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
      recordRunBoardResultCard(result.result_card);
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

  function recordRunBoardResultCard(card: RuntimeResultCard | undefined): void {
    if (!card) {
      return;
    }
    const at = new Date().toISOString();
    setRunBoardState((previous) => reduceRunBoardActions(previous, [{
      type: "attention/archive-derived-slow",
      at,
      resolution: "Run completed after the slow period."
    }, {
      type: "result/final",
      card,
      at
    }]));
  }

  function recordCommandDetail(detail: string, open = false): void {
    setLatestDetail(detail);
    setLatestDetailSource("command");
    setDetailScroll(0);
    setDetailOpen(open);
  }

  function recordEventDetail(detail: string): void {
    setLatestDetail(detail);
    setLatestDetailSource("event");
    setDetailScroll(0);
    setDetailOpen(false);
  }

  function appendReadRootPreflightMessage(objective: string): void {
    const report = buildReadRootPreflightReport({
      objective,
      permissions: settingsSnapshot.permissions,
      sandboxMode: runSandboxMode,
      workspace: runtime?.workspaceRoot() ?? process.cwd()
    });
    if (!report) {
      return;
    }
    recordEventDetail(report.detail);
    appendChatMessage({
      role: "system",
      kind: "progress",
      status: "warning",
      brief: report.brief,
      detail: report.detail,
      preview: detailPreview(report.detail),
      title: "Read-root preflight"
    });
  }

  function openTaskDetail(): void {
    setLatestDetail(renderTaskDetail());
    setLatestDetailSource("task");
    setDetailScroll(0);
    setDetailOpen(true);
  }

  function clearDetailState(): void {
    setDetailOpen(false);
    closeCollaborationOverlay();
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

  function openRunBoardWorkerDetail(row: WorkerBoardRow): void {
    const refs = selectDebugRefsForRow(runBoardState, row.id);
    const lines = [
      `${row.label} ${row.status}`,
      "",
      `Action: ${row.currentAction}`,
      `Age: ${formatElapsed(row.elapsedMs)}`,
      `Risk: ${row.risk}`,
      row.waitingOn ? `Waiting on: ${row.waitingOn}` : undefined,
      row.lastEvidence ? `Evidence: ${row.lastEvidence}` : undefined,
      row.owns.length ? `Owns: ${row.owns.join(", ")}` : undefined,
      refs.length ? "" : undefined,
      refs.length ? "Debug refs:" : undefined,
      ...refs.map((ref) => `  ${ref}`)
    ].filter((line): line is string => line !== undefined);
    setLatestDetail(lines.join("\n"));
    setLatestDetailSource("event");
    setDetailScroll(0);
    setDetailOpen(true);
  }

  function executeRunBoardAttentionAction(item: AttentionItemView, action: AttentionAction): void {
    if (action.enabled === false) {
      return;
    }
    if (action.command) {
      void handleSlashCommand(action.command);
      return;
    }
    if (item.kind === "approval" && approval) {
      if (action.key === "y") {
        resolveApprovalDecision({ approved: true, rememberForSession: false });
        return;
      }
      if (action.key === "n") {
        resolveApprovalDecision({ approved: false, rememberForSession: false });
        return;
      }
    }
    const detail = [
      item.title,
      "",
      item.summary,
      "",
      `Recommendation: ${item.recommendation}`,
      ...item.evidence.map((evidence) => `Evidence: ${evidence}`)
    ].join("\n");
    recordEventDetail(detail);
    setDetailOpen(true);
  }

  function handleRunBoardAttentionAction(item: AttentionItemView, action: AttentionAction): void {
    executeRunBoardAttentionAction(item, action);
  }

  function handleRunBoardAttentionKey(character: string | undefined, key: { ctrl?: boolean; meta?: boolean; return?: boolean; escape?: boolean }): boolean {
    if (key.ctrl || key.meta || key.return || key.escape) {
      return false;
    }
    if (chatInputState.current.input.value.length > 0) {
      return false;
    }
    const item = selectRunBoardSurface(runBoardState, {
      now: new Date().toISOString(),
      repo: "Swarm",
      mode: routeLabel,
      risk: runSandboxMode,
      session: latestResultCard?.sessionId ?? lastSessionId ?? runBoardState.runId
    }).attention[0];
    const action = runBoardAttentionActionForKey(item, character, key);
    if (!action) {
      return false;
    }
    executeRunBoardAttentionAction(item, action);
    return true;
  }

  function handleRunBoardResultAction(action: RunBoardResultAction): void {
    if (action.command.startsWith("/")) {
      void handleSlashCommand(action.command);
      return;
    }
    recordEventDetail([
      `Next action: ${action.label}`,
      "",
      action.command
    ].join("\n"));
    setDetailOpen(true);
  }

  function executeCollaborationAction(target: CollaborationOverlayTarget | "reassign"): void {
    if (!isCollaborationUiEnabled()) {
      return;
    }
    if (target === "reassign") {
      recordCollaborationReassignIntent();
      return;
    }
    setCollaborationOverlayTarget(target);
    setCollaborationOverlayIndex(0);
    setCollaborationOverlayFilter("");
    setCollaborationOverlayFiltering(false);
    logCollaborationTelemetry("tui.topology.open", {
      target,
      result: "opened"
    });
    if (target === "approval") {
      void openFooterDetail("approvals");
    }
  }

  function closeCollaborationOverlay(): void {
    setCollaborationOverlayTarget(undefined);
    setCollaborationOverlayIndex(0);
    setCollaborationOverlayFilter("");
    setCollaborationOverlayFiltering(false);
  }

  function handleCollaborationOverlayInput(
    character: string | undefined,
    key: { ctrl?: boolean; meta?: boolean; return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean; upArrow?: boolean; downArrow?: boolean }
  ): boolean {
    if (!collaborationOverlayTarget) {
      return false;
    }
    if (key.escape) {
      if (collaborationOverlayFiltering || collaborationOverlayFilter) {
        setCollaborationOverlayFiltering(false);
        setCollaborationOverlayFilter("");
      } else {
        closeCollaborationOverlay();
      }
      return true;
    }
    if (collaborationOverlayFiltering) {
      if (key.return) {
        setCollaborationOverlayFiltering(false);
        setCollaborationOverlayIndex(0);
        return true;
      }
      if (key.backspace || (key.delete && !character)) {
        setCollaborationOverlayFilter((value) => value.slice(0, -1));
        setCollaborationOverlayIndex(0);
        return true;
      }
      if (!key.ctrl && !key.meta && character && character.length === 1) {
        setCollaborationOverlayFilter((value) => value + character);
        setCollaborationOverlayIndex(0);
        return true;
      }
      return true;
    }
    if (key.upArrow) {
      setCollaborationOverlayIndex((value) => Math.max(0, value - 1));
      return true;
    }
    if (key.downArrow) {
      const overlay = currentCollaborationOverlayView();
      setCollaborationOverlayIndex((value) => Math.min(Math.max(0, (overlay?.rows.length ?? 1) - 1), value + 1));
      return true;
    }
    if (key.return) {
      openSelectedCollaborationOverlayRow();
      return true;
    }
    const action = collaborationOverlayActionForInput({ target: collaborationOverlayTarget, character, key });
    if (!action) {
      return false;
    }
    if (action === "detail") {
      openSelectedCollaborationOverlayRow();
      return true;
    }
    if (action === "filter") {
      setCollaborationOverlayFiltering(true);
      return true;
    }
    executeCollaborationOverlayAction(action);
    return true;
  }

  function executeCollaborationOverlayAction(action: "take-over" | "reassign" | "resolve" | "copy-id"): void {
    const overlay = currentCollaborationOverlayView();
    if (!overlay) {
      return;
    }
    const row = overlay.rows[collaborationOverlayIndex];
    const intent = buildCollaborationActionIntent({
      action,
      overlay,
      row,
      reassign: collaborationCockpit.reassign,
      policyMode: settingsSnapshot.permissions.defaultMode
    });
    if (action === "reassign") {
      recordCollaborationReassignIntent(intent);
      return;
    }
    appendChatMessage({
      role: "system",
      brief: `${intent.summary}: ${intent.result}.`,
      detail: intent.detail.join("\n")
    });
    logCollaborationTelemetry(action === "copy-id" ? "tui.collab.shortcut" : "tui.reassign.intent", {
      action,
      target: intent.targetId,
      source: "keyboard",
      result: intent.result
    });
  }

  function handleCollaborationShortcutInput(
    character: string | undefined,
    key: { ctrl?: boolean; meta?: boolean; return?: boolean; escape?: boolean }
  ): boolean {
    const action = collaborationShortcutActionForInput({
      character,
      key,
      enabled: isCollaborationUiEnabled(),
      inputIsEmpty: !approval
        && !pendingPlan
        && chatInputState.current.input.value.length === 0
        && !transcriptSearch.active
        && footerNavigation.selectedId === undefined
        && messageCursor.selectedIndex === undefined
    });
    if (!action) {
      return false;
    }
    logCollaborationTelemetry("tui.collab.shortcut", {
      action,
      source: "keyboard"
    });
    if (action === "reassign") {
      executeCollaborationAction("reassign");
      return true;
    }
    executeCollaborationAction(action === "open" ? "ownership" : action);
    return true;
  }

  function currentCollaborationOverlayView() {
    const cockpit = buildCollaborationCockpitView({
      enabled: isCollaborationUiEnabled(),
      swarmSurface: runtimeRef.current ? safeSwarmSurface(runtimeRef.current, 30) : undefined,
      runBoard: selectRunBoardSurface(runBoardState, {
        now: new Date().toISOString(),
        repo: "Swarm",
        mode: lastRoute?.mode ?? latestResultCard?.route ?? "work",
        risk: runSandboxMode,
        session: latestResultCard?.sessionId ?? lastSessionId ?? runBoardState.runId
      }),
      approvalsPending: footerPendingApprovalCount(approval, idlePaneSnapshot.approvals),
      policyMode: settingsSnapshot.permissions.defaultMode,
      sandboxMode: runSandboxMode
    });
    return filterCollaborationOverlayView(
      selectCollaborationOverlay(cockpit, collaborationOverlayTarget),
      collaborationOverlayFilter
    );
  }

  function openSelectedCollaborationOverlayRow(): void {
    const overlay = currentCollaborationOverlayView();
    const row = overlay?.rows[collaborationOverlayIndex];
    if (!row) {
      return;
    }
    openCollaborationOverlayRow(row, collaborationOverlayIndex);
  }

  function openCollaborationOverlayRow(row: CollaborationOverlayRow, index: number): void {
    setCollaborationOverlayIndex(index);
    const detail = [
      row.label,
      "",
      `status=${row.status}`,
      row.evidence ? `evidence=${row.evidence}` : undefined,
      "",
      ...row.detail
    ].filter((line): line is string => Boolean(line)).join("\n");
    recordEventDetail(detail);
    logCollaborationTelemetry("tui.topology.open", {
      target: collaborationOverlayTarget ?? "topology",
      row: row.id,
      result: "opened"
    });
  }

  function recordCollaborationReassignIntent(prebuiltIntent?: CollaborationActionIntentView): void {
    if (prebuiltIntent) {
      if (prebuiltIntent.result === "noop") {
        appendChatMessage({ role: "system", brief: prebuiltIntent.summary, detail: prebuiltIntent.detail.join("\n") });
      } else {
        setCollaborationOverlayTarget("ownership");
        appendChatMessage({
          role: "system",
          brief: `${prebuiltIntent.summary}: ${prebuiltIntent.result}.`,
          detail: prebuiltIntent.detail.join("\n")
        });
      }
      logCollaborationTelemetry("tui.reassign.intent", {
        action: prebuiltIntent.action,
        target: prebuiltIntent.targetId,
        source: prebuiltIntent.overlay,
        result: prebuiltIntent.result
      });
      return;
    }
    const cockpit = buildCollaborationCockpitView({
      enabled: isCollaborationUiEnabled(),
      swarmSurface: runtimeRef.current ? safeSwarmSurface(runtimeRef.current, 30) : undefined,
      runBoard: selectRunBoardSurface(runBoardState, {
        now: new Date().toISOString(),
        repo: "Swarm",
        mode: lastRoute?.mode ?? latestResultCard?.route ?? "work",
        risk: runSandboxMode,
        session: latestResultCard?.sessionId ?? lastSessionId ?? runBoardState.runId
      }),
      approvalsPending: footerPendingApprovalCount(approval, idlePaneSnapshot.approvals),
      policyMode: settingsSnapshot.permissions.defaultMode,
      sandboxMode: runSandboxMode
    });
    const ownershipOverlay = cockpit.overlays.find((overlay) => overlay.target === "ownership");
    if (!ownershipOverlay) {
      return;
    }
    const intent = buildCollaborationActionIntent({
      action: "reassign",
      overlay: ownershipOverlay,
      reassign: cockpit.reassign,
      policyMode: settingsSnapshot.permissions.defaultMode
    });
    if (intent.result === "noop") {
      appendChatMessage({ role: "system", brief: intent.summary, detail: intent.detail.join("\n") });
      logCollaborationTelemetry("tui.reassign.intent", { result: "noop" });
      return;
    }
    setCollaborationOverlayTarget("ownership");
    appendChatMessage({
      role: "system",
      brief: `${intent.summary}: ${intent.result}.`,
      detail: intent.detail.join("\n")
    });
    logCollaborationTelemetry("tui.reassign.intent", {
      target: intent.targetId,
      source: intent.overlay,
      risk: intent.risk,
      policy: intent.policy,
      result: intent.result
    });
  }

  function recordCollaborationOverlayCopyId(): void {
    const overlay = currentCollaborationOverlayView();
    const row = overlay?.rows[collaborationOverlayIndex];
    if (!row) {
      return;
    }
    appendChatMessage({ role: "system", brief: `Copied collaboration id ${row.id}.` });
    logCollaborationTelemetry("tui.collab.shortcut", {
      action: "copy-id",
      target: row.id,
      result: "queued"
    });
  }

  function toggleDecisionTrail(): void {
    setDecisionTrailExpanded((value) => !value);
    logCollaborationTelemetry("tui.decision_trail.expand", {
      result: decisionTrailExpanded ? "collapsed" : "expanded"
    });
  }

  function logCollaborationTelemetry(event: string, payload: Record<string, unknown>): void {
    const telemetry = buildCollaborationTelemetryEvent({
      event: event as Parameters<typeof buildCollaborationTelemetryEvent>[0]["event"],
      overlay: typeof payload.target === "string" ? payload.target as CollaborationOverlayTarget : collaborationOverlayTarget,
      action: typeof payload.action === "string" ? payload.action : undefined,
      target: typeof payload.row === "string" ? payload.row : typeof payload.target === "string" ? payload.target : undefined,
      source: typeof payload.source === "string" ? payload.source : undefined,
      result: typeof payload.result === "string" ? payload.result : undefined,
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : 0
    });
    runtimeRef.current?.debug?.debug("tui-collaboration", event, {
      ...telemetry,
      session_id: latestResultCard?.sessionId ?? lastSessionId
    });
  }

  function handleActionLogInput(character: string | undefined, key: { ctrl?: boolean; pageUp?: boolean; pageDown?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean }): boolean {
    if (mainPane !== "trace") {
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
    const detailIntent = detailOpenInputIntent({ character, key });
    if (inputIsEmpty && shouldOpenDetailFromInput({ intent: detailIntent, hasFocusedTarget: actionLogRows.length > 0 })) {
      const row = actionLogRows[selectedActionIndex] ?? actionLogRows.at(-1);
      emitTuiFocusTransition(
        focusDecisionForInput(character, key, { focusBefore: "action-log", hasFocusedTarget: actionLogRows.length > 0 }),
        tuiKeyEventForInput(character, key),
        row?.id
      );
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
    key: { ctrl?: boolean; home?: boolean; end?: boolean; pageUp?: boolean; pageDown?: boolean }
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
    const halfPageRows = Math.max(2, Math.floor(pageRows / 2));
    if (key.end || (key.ctrl && normalized === "e") || character === "G") {
      setConversationViewport(resetConversationViewport());
      return true;
    }
    const delta = key.home || character === "g"
      ? Number.POSITIVE_INFINITY
      : key.pageUp || (key.ctrl && normalized === "b")
        ? pageRows
        : key.pageDown || (key.ctrl && normalized === "f")
          ? -pageRows
          : key.ctrl && normalized === "u"
            ? halfPageRows
            : key.ctrl && normalized === "d"
              ? -halfPageRows
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
    const detailIntent = detailOpenInputIntent({ character, key });
    if (shouldOpenDetailFromInput({ intent: detailIntent, hasFocusedTarget: Boolean(selectedFooterPill(footerNavigation, footerItems)) })) {
      const id = selectedFooterPill(footerNavigation, footerItems)?.id;
      if (id) {
        emitTuiFocusTransition(
          focusDecisionForInput(character, key, { focusBefore: "footer", hasFocusedTarget: true }),
          tuiKeyEventForInput(character, key),
          `footer:${id}`
        );
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
      if (chatInputState.current.input.value.length === 0 && !key.ctrl && (character === "n" || character === "N") && transcriptSearch.query.trim()) {
        const nextSearch = stepTranscriptSearch(transcriptSearch, character === "n" ? 1 : -1);
        const match = currentTranscriptSearchMatch(nextSearch);
        setTranscriptSearch(nextSearch);
        if (match) {
          jumpToConversationMessage(match.messageIndex);
          setMessageCursor((state) => messageCursorReducer(state, { type: "select", index: match.messageIndex }, messages));
        }
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
    key: { ctrl?: boolean; return?: boolean }
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
    const detailIntent = detailOpenInputIntent({ character, key });
    if (shouldOpenDetailFromInput({ intent: detailIntent, hasFocusedTarget: messageCursor.selectedIndex !== undefined })) {
      emitTuiFocusTransition(
        focusDecisionForInput(character, key, { focusBefore: "message", hasFocusedTarget: true }),
        tuiKeyEventForInput(character, key),
        messageCursor.selectedIndex === undefined ? undefined : `message:${messageCursor.selectedIndex}`
      );
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
    const caseDetail = runtime && lastSessionId ? safeCaseWorkbenchDetail(runtime, lastSessionId) : undefined;
    if (caseDetail) {
      return formatCaseWorkbenchDetail(caseDetail);
    }
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
      const presentation = footerDetailPresentation(id);
      setLatestDetail(detail);
      setLatestDetailSource(presentation.source);
      setDetailScroll(0);
      setDetailOpen(true);
    } catch (error) {
      pushError(error);
    }
  }

  function footerDetailPresentation(id: FooterPillId): {
    source: "task" | "event";
  } {
    return {
      source: id === "tasks" ? "task" : "event"
    };
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
      return formatPromptCacheDetailWithTrend(promptCacheStatus, runtime?.getPromptCacheTrend());
    }
    if (id === "gateway") {
      return renderGatewayStatusDetail();
    }
    if (id === "mcp") {
      return renderMcpStatusDetail();
    }
    if (id === "skills") {
      return renderSkillStatusDetail();
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

  function renderMcpStatusDetail(): string {
    if (!runtime) {
      return "Runtime is not ready.";
    }
    const servers = runtime.listMcpServers();
    const settings = mcpSettingsSnapshot(runtime);
    const summary = summarizeMcpCatalog(servers, settings);
    return [
      "MCP",
      summary.runtime ? `${summary.runtime.label} state=${summary.runtime.state} severity=${summary.runtime.severity} evidence=${summary.runtime.evidence}` : undefined,
      summary.runtime ? `reason=${summary.runtime.reason}` : undefined,
      summary.runtime ? `next=${summary.runtime.nextAction}` : undefined,
      "",
      formatMcpServersSummary(servers)
    ].filter(Boolean).join("\n");
  }

  function renderSkillStatusDetail(): string {
    if (!runtime) {
      return "Runtime is not ready.";
    }
    const skills = runtime.listSkills();
    const settings = skillSettingsSnapshot(runtime);
    const summary = summarizeSkillCatalog(skills, settings);
    return [
      "Skills",
      summary.runtime ? `${summary.runtime.label} state=${summary.runtime.state} severity=${summary.runtime.severity} evidence=${summary.runtime.evidence}` : undefined,
      summary.runtime ? `reason=${summary.runtime.reason}` : undefined,
      summary.runtime ? `next=${summary.runtime.nextAction}` : undefined,
      "",
      formatSkillsSummary(skills)
    ].filter(Boolean).join("\n");
  }

  async function renderLspStatusDetail(): Promise<string> {
    const workspace = runtime?.workspaceRoot() ?? process.cwd();
    const report = await getGlobalLspManager(workspace).status();
    updateLspStatusReport(report);
    return formatLspStatusReport(report);
  }

  function handleOnboardInput(
    character: string | undefined,
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
      } else if (result.detailSource === "event") {
        recordEventDetail(result.detail ?? result.brief);
      } else if (result.detail) {
        recordCommandDetail(result.detail);
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
          : "Slash command catalog. Use /help main for the concise main path or /help all for advanced commands.",
        detail
      };
    }

    if (command === "case" || command === "cases" || command === "inbox") {
      if (!runtime) throw new Error("Runtime is not ready.");
      if (command === "inbox") {
        const projection = runtime.buildGlobalCaseWorkbench(50);
        const detail = projection.inbox.length
          ? projection.inbox.map((item) => `${item.severity} ${item.kind} ${item.case_id}: ${item.reason} Next: ${item.recommended_action}`).join("\n")
          : "Inbox is empty.";
        return { brief: appendDetailShortcut(`Inbox: ${projection.inbox.length} item(s)`), detail };
      }
      const target = args[0] ?? lastSessionId;
      if (command === "case" && target) {
        const detail = runtime.getCaseWorkbenchDetail(target);
        if (!detail) {
          throw new Error(`Unknown case: ${target}`);
        }
        setLastSessionId(detail.case_id);
        return {
          brief: appendDetailShortcut(`Case ${detail.case_id}: ${detail.status}, sessions=${detail.sessions.length}`),
          detail: formatCaseWorkbenchDetail(detail)
        };
      }
      const projection = runtime.buildGlobalCaseWorkbench(50);
      const detail = [
        `Cases ${projection.summary.cases}  active=${projection.summary.active} blocked=${projection.summary.blocked} inbox=${projection.summary.inbox} no_workspace=${projection.summary.no_workspace}`,
        "",
        ...(projection.cases.length
          ? projection.cases.map(formatCaseWorkbenchRow)
          : ["No cases yet."])
      ].join("\n");
      return { brief: appendDetailShortcut(`${projection.summary.cases} global case(s)`), detail };
    }

    if (command === "work") {
      const subcommand = args[0]?.toLowerCase();
      if (!subcommand) {
        return { brief: appendDetailShortcut("Work commands"), detail: renderSlashHelp({ namespace: "work" }) };
      }
      if (subcommand === "board") {
        if (!runtime) throw new Error("Runtime is not ready.");
        const first = args[1]?.toLowerCase();
        const second = args[2]?.toLowerCase();
        const sessionId = first && first !== "workspace" && !isWorkBoardFilter(first) ? args[1] : undefined;
        const filter: WorkBoardFilter | undefined = isWorkBoardFilter(first) ? first : isWorkBoardFilter(second) ? second : undefined;
        const board = sessionId
          ? buildSessionWorkBoard(runtime, sessionId)
          : buildWorkspaceWorkBoard(runtime, { limit: 8 });
        return {
          brief: appendDetailShortcut(`Work board: sessions=${board.summary.sessions}, workers=${board.summary.workers}, tasks=${board.summary.tasks}, claims=${board.summary.claims}, blocked=${board.summary.blocked}, failed=${board.summary.failed}, resumable=${board.summary.resumable}`),
          detail: formatWorkBoard(board, { filter })
        };
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
          brief: appendDetailShortcut(`${rows.length} ${label} for ${sessionId}`),
          detail: rows.length ? rows.join("\n") : `(no ${label})`
        };
      }
      throw new Error("Usage: /work board|sessions|attempts|output|files|checks|workers");
    }

    if (command === "debug") {
      const subcommand = args[0]?.toLowerCase();
      if (!subcommand) {
        return { brief: appendDetailShortcut("Debug commands"), detail: renderSlashHelp({ namespace: "debug" }) };
      }
      if (subcommand === "trace") return runSlashCommand("trace", args.slice(1), parsed);
      if (subcommand === "blackboard") return runSlashCommand("blackboard", args.slice(1), parsed);
      if (subcommand === "audit") return runSlashCommand("audit", args.slice(1), parsed);
      if (subcommand === "usage") return runSlashCommand("usage", args.slice(1), parsed);
      if (subcommand === "latest") {
        const workspace = runtime?.workspaceRoot() ?? process.cwd();
        const lspReport = lspStatusReport ?? await getGlobalLspManager(workspace).status().catch(() => undefined);
        if (lspReport) {
          updateLspStatusReport(lspReport);
        }
        const diagnosis = buildLatestRunDiagnosis({
          events,
          resultCard: latestResultCard,
          latestDetail: {
            source: latestDetailSource,
            title: latestDetailSource === "none" ? undefined : detailTitleForSource(latestDetailSource),
            route: lastRoute?.mode ?? latestResultCard?.route,
            sessionId: lastSessionId
          },
          promptCache: runtime?.getPromptCacheStatus(),
          promptCacheTrend: runtime?.getPromptCacheTrend(),
          lspStatusReport: lspReport,
          artifactPaths: {
            logPath: runtime?.debug?.logPath
          },
          workspace
        });
        return { ...diagnosis, detailSource: "event" };
      }
      if (subcommand === "cache") {
        if (!runtime) throw new Error("Runtime is not ready.");
        const cache = runtime.getPromptCacheStatus();
        return { brief: formatPromptCacheBrief(cache), detail: formatPromptCacheDetailWithTrend(cache, runtime.getPromptCacheTrend()) };
      }
      if (subcommand === "timeline") {
        const filter = parseProtocolTimelineFilter(args.slice(1));
        const capturedEvents = events.map((event, index) => ({
          at: new Date(index).toISOString(),
          event
        }));
        const timeline = buildProtocolDebugTimeline({ capturedEvents, limit: filter.limit ?? 80 });
        const detail = formatProtocolDebugTimeline({
          events: timeline.events,
          filter,
          limit: filter.limit ?? 80,
          title: "Protocol Timeline"
        });
        const filterLabel = formatProtocolTimelineFilter(filter);
        return {
          brief: appendDetailShortcut(`Protocol timeline: events=${timeline.total_events}, correlations=${timeline.correlations.length}${filterLabel ? `, ${filterLabel}` : ""}`),
          detail: [
            `schema=${timeline.schema_version}`,
            `total=${timeline.total_events}`,
            `correlations=${timeline.correlations.length}`,
            filterLabel ? `filter=${filterLabel}` : undefined,
            "",
            detail
          ].filter((line): line is string => typeof line === "string").join("\n"),
          detailSource: "event"
        };
      }
      if (subcommand === "events") {
        const detail = events.slice(-80).map((event) => JSON.stringify(event)).join("\n");
        return { brief: appendDetailShortcut(`${Math.min(events.length, 80)} recent runtime events`), detail: detail || "No runtime events yet." };
      }
      throw new Error("Usage: /debug latest|timeline|trace|blackboard|audit|usage|cache|events");
    }

    if (command === "ext") {
      const subcommand = args[0]?.toLowerCase();
      if (!subcommand) {
        return { brief: appendDetailShortcut("Extension commands"), detail: renderSlashHelp({ namespace: "ext" }) };
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
          brief: appendDetailShortcut(`Current view: ${mainPaneLabels[mainPane]}`, "views"),
          detail: mainPaneOrder.map((pane) => `${pane}${pane === mainPane ? " (current)" : ""} - ${mainPaneLabels[pane]}`).join("\n")
        };
      }
      const pane = normalizeMainPaneId(target);
      if (!pane) {
        throw new Error("Usage: /view board|tasks|workers|activity|output|skills|automations|trace|chat|run");
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
        return { brief: appendDetailShortcut(`Current provider: ${current}`, "providers"), detail };
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
      return { brief: appendDetailShortcut(`${providerId}: ${models.length} models`, "list"), detail };
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
        return { brief: appendDetailShortcut(`${providerId}: model discovery failed`), detail: result.error };
      }
      return { brief: `${providerId}: discovered ${result.models.length} models.`, detail: result.models.join("\n") };
    }

    if (command === "symphony") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const subcommand = args[0]?.toLowerCase();
      if (subcommand === "help") {
        return { brief: appendDetailShortcut("Symphony commands"), detail: renderSlashHelp({ namespace: "symphony" }) };
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
        brief: appendDetailShortcut(`Symphony: sessions=${status.totals.sessions}, running=${status.totals.running}, retrying=${status.totals.retrying}, capacity=${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent}`),
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
        brief: appendDetailShortcut(`Work items: active=${active.length}, terminal=${terminal.length}, source=${source.kind}`),
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
        brief: appendDetailShortcut(`Symphony ${command === "symphony-run-once" ? "run-once" : "tick"}: candidates=${result.candidates.length}, dispatched=${result.dispatched.length}, skipped=${result.skipped.length}, failed=${result.failed.length}, runs=${runs.length}`),
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
        brief: appendDetailShortcut(`Symphony daemons: total=${records.length}, active=${active}`),
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
        brief: appendDetailShortcut(`Symphony daemon ${result.created ? "started" : "already running"}: ${result.daemon.daemon_id} ticks=${result.daemon.tick_count}`),
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
        brief: appendDetailShortcut(`Symphony stop requested: ${records.length} daemon(s)`),
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
        brief: appendDetailShortcut(`Symphony cleanup ${result.execute ? "execute" : "dry-run"}: inspected=${result.inspected}, removed=${result.removed}, skipped=${result.skipped}, failed=${result.failed}`),
        detail
      };
    }

    if (command === "session") {
      if (args[0] === "new") {
        chatSessionId.current = createChatSessionId();
        resetDebugLogger();
        setPendingPlan(undefined);
        setRunBoardState(createInitialRunBoardState());
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
        return { brief: appendDetailShortcut(`${snapshot.session.session_id}: ${snapshot.session.status}, attempts=${snapshot.attempts.length}, changed=${snapshot.changed_files.length}`), detail };
      }
      const rows = runtime?.listRecentSessionsForWorkspace(10) ?? [];
      const detail = rows.length
        ? rows.map((row) => `${row.session_id} [${row.status}] ${row.updated_at} ${row.objective}`).join("\n")
        : "No sessions yet.";
      return { brief: appendDetailShortcut(`${rows.length} recent sessions`), detail };
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
      return { brief: appendDetailShortcut(`Memory for ${sessionId}: ${summary}`), detail };
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
        recordRunBoardResultCard(result.result_card);
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
      return buildResumeCommandResult({
        command,
        sessionId,
        route: execution.route,
        detail
      });
    }

    if (command === "replay") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      if (!sessionId) throw new Error("Usage: /replay <session_id>");
      const detail = runtime.replaySession(sessionId);
      return { brief: appendDetailShortcut(`Replay loaded for ${sessionId}`), detail };
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
        return { brief: appendDetailShortcut(`${rows.length} persisted task states`), detail };
      }
      const rows = [...taskStates.entries()];
      const detail = rows.length
        ? rows.map(([id, state]) => `${id} [${state.status}${state.attempt ? ` attempt ${state.attempt}` : ""}] ${state.title}`).join("\n")
        : "No active task state in this chat.";
      return { brief: appendDetailShortcut(`${rows.length} task states`), detail };
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
      return { brief: appendDetailShortcut(`${graph.tasks.length} task graph nodes for ${sessionId}`), detail };
    }

    if (command === "task") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const taskId = args[0];
      const sessionId = args[1] ?? lastSessionId;
      if (!taskId || !sessionId) throw new Error("Usage: /task <task_id> [session_id]");
      const detail = JSON.stringify(runtime.getTaskDetail(sessionId, taskId), null, 2);
      return { brief: appendDetailShortcut(`Task ${taskId}`), detail };
    }

    if (command === "trace") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0];
      if (!sessionId) throw new Error("Usage: /trace <session_id>");
      const trace = runtime.traceStore.list(sessionId);
      const detail = trace.length
        ? trace.map((env) => `${env.created_at} ${env.type} ${env.from.agent_id ?? env.from.role ?? "?"} -> ${Array.isArray(env.to) ? env.to.length : env.to.agent_id ?? env.to.capability ?? env.to.role ?? "?"} ${env.task_id ?? ""} ${env.trace?.trace_id ?? ""}/${env.trace?.span_id ?? ""}`).join("\n")
        : "No trace envelopes for this session.";
      return { brief: appendDetailShortcut(`${trace.length} trace envelopes`), detail };
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
        brief: appendDetailShortcut(`${rows.length} attempts${sessionId ? ` for ${sessionId}` : " in this workspace"}`),
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
        brief: appendDetailShortcut(`${rows.length} workspace leases${target ? ` for ${target}` : " in this workspace"}`),
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
      return { brief: appendDetailShortcut(`${trace.length} envelopes, ${audit.length} audit records`), detail };
    }

    if (command === "approvals") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      const rows = sessionId ? runtime.listApprovalsForSessionFamily(sessionId, 80) : runtime.listRecentApprovalsForWorkspace(80);
      const detail = rows.length ? rows.map(formatApprovalRecord).join("\n\n") : "No approvals recorded.";
      return { brief: appendDetailShortcut(`${rows.length} approvals${sessionId ? ` for ${sessionId}` : " in this workspace"}`), detail };
    }

    if (command === "approval") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const approvalId = args[0];
      if (!approvalId) return runSlashCommand("approvals", [], parsed);
      const approval = runtime.approvalStore.get(approvalId);
      if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
      return { brief: appendDetailShortcut(`${approval.approval_id}: ${approval.status}`), detail: formatApprovalRecord(approval) };
    }

    if (command === "audit") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0] ?? lastSessionId;
      const rows = runtime.auditStore.list(sessionId, 100);
      const detail = rows.length ? rows.map(formatAuditRecord).join("\n") : "No audit records.";
      return { brief: appendDetailShortcut(`${rows.length} audit records${sessionId ? ` for ${sessionId}` : ""}`), detail };
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
      return { brief: appendDetailShortcut(`${sessionId} usage: ${Object.keys(summary).length} counters`), detail };
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
      return { brief: appendDetailShortcut(`${rows.length} workspace changes${sessionId ? ` for ${sessionId}` : ""}`), detail };
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
      return { brief: appendDetailShortcut(`${rows.length} blackboard entries${sessionId ? ` for ${sessionId}` : ""}`), detail };
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
          ? appendDetailShortcut(`${capabilities.length} capabilities across ${providers.length} providers`)
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
        brief: appendDetailShortcut(`Capability ${capabilityId} updated`),
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
          ? appendDetailShortcut(`${selected.length} plugin${selected.length === 1 ? "" : "s"}`)
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
        brief: appendDetailShortcut(`Plugin root ${command === "plugin-install" ? "installed" : "removed"}`, "plugin list"),
        detail: formatPlugins(plugins)
      };
    }

    if (command === "plugin-update") {
      if (!runtime) throw new Error("Runtime is not ready.");
      runtime.reloadSettings();
      await runtime.refreshCapabilities();
      const plugins = runtime.listPlugins();
      return {
        brief: appendDetailShortcut(`Plugin catalog refreshed: ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`),
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
        brief: appendDetailShortcut(`Plugin ${pluginId} ${enabled ? "enabled" : "disabled"}`, "plugin list"),
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
          ? appendDetailShortcut(`${active} custom commands, ${pluginSlashCommands.length} plugin slash commands, ${commands.length - active} shadowed`)
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
          ? appendDetailShortcut(`${active} active skills, ${skills.length - active} shadowed`)
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
        brief: appendDetailShortcut(`Skill activated: ${skill.name}`, "instructions"),
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
          ? appendDetailShortcut(`${selected.length} MCP server${selected.length === 1 ? "" : "s"}`)
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
        brief: appendDetailShortcut(`MCP ${server.id}: ${server.status}, tools=${server.toolCount}`),
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
        brief: appendDetailShortcut(`${resources.length} MCP resources from ${serverId}`),
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
        brief: appendDetailShortcut(`MCP resource ${uri}`, "contents"),
        detail: formatMcpResourceReadResult(result)
      };
    }

    if (command === "mcp-prompts") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const serverId = args[0];
      if (!serverId) throw new Error("Usage: /mcp-prompts <server_id>");
      const prompts = runtime.listMcpPrompts(serverId);
      return {
        brief: appendDetailShortcut(`${prompts.length} MCP prompts from ${serverId}`),
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
        brief: appendDetailShortcut(`MCP prompt ${name}`, "rendered messages"),
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
      return { brief: appendDetailShortcut(`${specs.length} agent specs`), detail };
    }

    if (command === "swarm") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const selection = parseSwarmWorkbenchSelection(args);
      const surface = buildTuiSwarmSurface(runtime, selection.mode === "summary" ? 30 : 100);
      return {
        brief: appendDetailShortcut(`Swarm: ${formatSwarmTopologySummary(surface)}`),
        detail: formatSwarmWorkbench(surface, {
          mode: selection.mode,
          actorId: selection.actorId,
          columns: terminalColumns,
          rows: detailHeight,
          limit: terminalColumns < 100 ? 6 : 14
        })
      };
    }

    if (command === "ownership") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const surface = buildTuiSwarmSurface(runtime, 40);
      return {
        brief: appendDetailShortcut(`Ownership: ${surface.summary.ownership_items} items, ${surface.summary.conflicts} conflicts`),
        detail: formatSwarmSurface(surface, { mode: "ownership", limit: 30 })
      };
    }

    if (command === "mailbox") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const actorId = args[0];
      if (!actorId) throw new Error("Usage: /mailbox <actor_id>");
      const surface = buildTuiSwarmSurface(runtime, 100);
      return {
        brief: appendDetailShortcut(`Mailbox ${actorId}`),
        detail: formatSwarmSurface(surface, { mode: "mailbox", actorId, limit: 30 })
      };
    }

    if (command === "agent") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const agentId = args[0];
      if (!agentId) throw new Error("Usage: /agent <actor_id|agent_spec_id>");
      if (runtime.agentActorStore.get(agentId)) {
        const surface = buildTuiSwarmSurface(runtime, 100);
        return {
          brief: appendDetailShortcut(`Agent actor ${agentId}`),
          detail: formatSwarmSurface(surface, { mode: "agent", actorId: agentId, limit: 30 })
        };
      }
      const detail = runtime.renderAgentSpec(agentId);
      if (!detail) throw new Error(`Unknown agent actor or spec: ${agentId}`);
      return { brief: appendDetailShortcut(`Agent spec ${agentId}`), detail };
    }

    if (command === "workers") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const rows = runtime.listRecentWorkersForWorkspace(30);
      const detail = rows.length
        ? rows.map(formatWorkerBrief).join("\n")
        : "No persisted workers yet.";
      return { brief: appendDetailShortcut(`${rows.length} workers in this workspace`), detail };
    }

    if (command === "worker") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const workerId = args[0];
      if (!workerId) throw new Error("Usage: /worker <worker_id>");
      const worker = runtime.workerStateStore.get(workerId);
      if (!worker) throw new Error(`Unknown worker: ${workerId}`);
      return { brief: appendDetailShortcut(`${worker.worker_id}: ${worker.status}`), detail: formatWorkerDetail(worker) };
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
      return { brief: appendDetailShortcut(`${rows.length} handoffs in this workspace`), detail };
    }

    if (command === "handoff") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const handoffId = args[0];
      if (!handoffId) throw new Error("Usage: /handoff <handoff_id>");
      const handoff = runtime.getHandoff(handoffId);
      if (!handoff) throw new Error(`Unknown handoff: ${handoffId}`);
      return { brief: appendDetailShortcut(`${handoff.handoff_id}: ${handoff.status}`), detail: formatHandoff(handoff) };
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
      if (args.includes("--cache-lab")) {
        const detail = runCacheLabReport().join("\n");
        runtime?.events.emitEvent({
          type: "eval_result",
          name: "Cache lab report",
          status: "pass",
          message: "Offline cache lab report generated."
        });
        return {
          brief: appendDetailShortcut("Cache lab report ready"),
          detail,
          detailSource: "event"
        };
      }
      if (args.includes("--tui-replay")) {
        const detail = runTuiReplayReport().join("\n");
        const failed = /status=fail/.test(detail);
        runtime?.events.emitEvent({
          type: "eval_result",
          name: "TUI replay report",
          status: failed ? "fail" : "pass",
          message: failed ? "Offline TUI replay reported failures." : "Offline TUI replay passed."
        });
        return {
          brief: appendDetailShortcut(`TUI replay ${failed ? "failed" : "passed"}`),
          detail,
          detailSource: "event"
        };
      }
      if (args.includes("--release-gate")) {
        const gate = buildOfflineParityReleaseGate();
        const detail = [
          `status=${gate.status}`,
          `profile=${gate.profile}`,
          `compared_to=${gate.compared_to}`,
          `next_task=${gate.next_task ?? "-"}`,
          "",
          "Dimensions",
          ...gate.dimensions.map((dimension) => `- ${dimension.id}: ${dimension.status} score=${dimension.score} next=${dimension.next_task ?? "-"}`),
          "",
          "Red Lines",
          ...gate.red_lines.map((redLine) => `- ${redLine.id}: ${redLine.status} next=${redLine.next_task ?? "-"}`),
          "",
          "Near Claude Code",
          ...gate.near_claude_code.map((item) => `- ${item}`),
          "",
          "Gaps",
          ...gate.gaps.map((item) => `- ${item}`)
        ].join("\n");
        runtime?.events.emitEvent({
          type: "eval_result",
          name: "Claude Code parity release gate",
          status: gate.status,
          message: gate.summary
        });
        return {
          brief: appendDetailShortcut(`Release gate ${gate.status}. Next: ${gate.next_task ?? "none"}`),
          detail,
          detailSource: "event"
        };
      }
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
        lspStatusReport,
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
        brief: appendDetailShortcut(`Interrupt requested for ${target.session_id} (${target.route})`),
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
        brief: appendDetailShortcut(`Live reply sent to ${target.session_id} (${target.route})`),
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
        brief: appendDetailShortcut(`Additional read directory added: ${directory}`),
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
          ? appendDetailShortcut(`Additional read directory removed: ${args[0]}`)
          : appendDetailShortcut(`Additional read directory not found: ${args[0]}`),
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
        brief: appendDetailShortcut(`Permission mode set to ${mode}`),
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
        brief: next.changed ? appendDetailShortcut(next.brief) : appendDetailShortcut(report.brief),
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

    if (command === "density") {
      const value = args[0]?.toLowerCase();
      if (!value) {
        return {
          brief: `TUI density: ${tuiDensity === "auto" ? `auto (${screenDensity})` : tuiDensity}.`,
          detail: [
            "compact - smallest chrome, terse summaries, best for narrow terminals",
            "default - balanced hierarchy",
            "comfortable - full operator labels and wider detail panes",
            "auto - choose from pane and terminal width"
          ].join("\n")
        };
      }
      if (value === "auto" || TUI_DENSITIES.includes(value as TuiDensity)) {
        setTuiDensity(value as TuiDensity | "auto");
        return {
          brief: value === "auto"
            ? `TUI density set to auto (${resolveTuiDensity({ density: "auto", pane: mainPane, columns: terminalColumns })}).`
            : `TUI density set to ${value}.`
        };
      }
      throw new Error("Usage: /density [auto|compact|default|comfortable]");
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

  function resolveApprovalDecision(decision: ApprovalOverlayDecision): void {
    if (decision.rememberForSession && approval) {
      sessionApprovalAllow.current.add(approvalSessionRuleKey(approval, runtimeRef.current));
    }
    approvalResolver.current?.(decision.approved);
    approvalResolver.current = undefined;
    setApproval(undefined);
  }

  function handleApprovalInput(character: string | undefined, key: { ctrl?: boolean; escape?: boolean }): boolean {
    const decision = approvalInputDecision(character ?? "", key);
    if (!decision.handled) {
      return false;
    }
    resolveApprovalDecision({
      approved: decision.approved,
      rememberForSession: decision.rememberForSession
    });
    return true;
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
  const collaborationUiEnabled = isCollaborationUiEnabled();
  const displayedProductResultCard = displayedResultCard;
  const workspaceWorkBoard = runtime ? safeWorkspaceWorkBoard(runtime, 12) : undefined;
  const caseWorkbench = runtime ? safeGlobalCaseWorkbench(runtime, 20) : undefined;
  const selectedCase = runtime && lastSessionId ? safeCaseWorkbenchDetail(runtime, lastSessionId) : undefined;
  const swarmSurface = runtime ? safeSwarmSurface(runtime, 12) : undefined;
  const promptCacheStatus = runtime?.getPromptCacheStatus();
  const cacheStatus = promptCacheStatus?.status ?? displayedProductResultCard?.cache?.status;
  const cacheHitRate = promptCacheStatus?.hitRate ?? displayedProductResultCard?.cache?.hitRate;
  const checkpointLabel = runtime?.getLastCheckpoint()?.name ?? displayedProductResultCard?.checkpoint?.name;
  const routeLabel = displayedProductResultCard?.route
    ?? lastRoute?.mode
    ?? (runMode === "chat" ? "ask" : runMode === "full_swarm" ? "team" : "work");
  const runBoardView = selectRunBoardSurface(runBoardState, {
    now: new Date().toISOString(),
    repo: "Swarm",
    mode: routeLabel,
    risk: runSandboxMode,
    session: displayedProductResultCard?.sessionId ?? lastSessionId ?? runBoardState.runId
  });
  const runBoardPhase = runBoardView.phase;
  const collaborationCockpit = buildCollaborationCockpitView({
    enabled: collaborationUiEnabled,
    swarmSurface,
    runBoard: runBoardView,
    approvalsPending: footerPendingApprovalCount(approval, idlePaneSnapshot.approvals),
    policyMode: settingsSnapshot.permissions.defaultMode,
    sandboxMode: runSandboxMode
  });
  const activeCollaborationOverlay = filterCollaborationOverlayView(
    selectCollaborationOverlay(collaborationCockpit, collaborationOverlayTarget),
    collaborationOverlayFilter
  );
  const shouldRenderRunBoard = busy
    || Boolean(approval)
    || Boolean(pendingPlan)
    || isActiveRunBoardPhase(runBoardPhase);
  const displayedRunBoardPhase = approval || pendingPlan
    ? "waiting-attention"
    : shouldRenderRunBoard && runBoardPhase === "idle"
      ? "planning"
      : runBoardPhase;
  const currentAction = loopActivity
    ? formatLoopActivityLine(loopActivity)
    : runBoardView.focus
      ? runBoardView.focus
      : busy
        ? "Starting local coding loop..."
        : pendingPlan
          ? "Awaiting approval for the plan."
          : displayedProductResultCard
            ? displayedProductResultCard.summary
            : "Waiting for your first task.";
  const currentPhase = displayedRunBoardPhase === "idle" && displayedProductResultCard
    ? displayedProductResultCard.status
    : displayedRunBoardPhase;
  const screenMode = tuiScreenMode({
    pane: mainPane,
    columns: terminalColumns,
    busy,
    hasApproval: Boolean(approval),
    hasPendingPlan: Boolean(pendingPlan),
    hasResult: Boolean(displayedProductResultCard),
    hasRunBoard: shouldRenderRunBoard,
    density: tuiDensity
  });
  const showCurrentAction = screenMode.showCurrentAction;
  const needYou = approval
    ? `Approve ${approval.summary}`
    : pendingPlan
      ? "approve with y or cancel with n"
      : activeCollaborationOverlay
        ? `${activeCollaborationOverlay.title}: Enter detail, Esc close`
      : runBoardView.attention[0]
        ? runBoardView.attention[0].recommendation
        : "no";
  const progress = isActiveRunBoardPhase(displayedRunBoardPhase)
    ? `${progressBar(runBoardView.resultPreview.checks.filter((check) => check.status === "passed").length, runBoardView.resultPreview.checks.length || 0, 10)} workers ${runBoardView.workers.length} | files ${runBoardView.resultPreview.changedFiles.length}`
    : undefined;
  const timelineItems = busy
    ? loopActivityTimeline.slice(-5).map(formatLoopActivityLine)
    : displayedProductResultCard
      ? compactResultCardLines(displayedProductResultCard)
      : messages.slice(-3).map((message) => `${message.role}: ${message.brief}`);
  const productResultCardView = selectProductResultCardView(runBoardState, {
    card: displayedProductResultCard,
    detailHint: latestDetailSource !== "none" ? detailOpenHint() : undefined,
    decisionTrailEnabled: collaborationUiEnabled
  });
  const shouldShowRunBoardSurface = shouldRenderRunBoard || Boolean(displayedProductResultCard);
  const collaborationOverlayPanel = activeCollaborationOverlay ? (
    <CollaborationOverlayPanel
      overlay={activeCollaborationOverlay}
      selectedIndex={collaborationOverlayIndex}
      reassign={collaborationCockpit.reassign}
      filter={collaborationOverlayFilter}
      filtering={collaborationOverlayFiltering}
      onRowClick={openCollaborationOverlayRow}
    />
  ) : null;
  const overviewSurface = shouldRenderRunBoard
    ? (
      <Box flexDirection="column" width="100%">
        <RunBoardSurface
          view={runBoardView}
          workerLimit={screenDensity === "compact" ? 4 : 6}
          attentionLimit={screenDensity === "compact" ? 1 : 2}
          onWorkerClick={openRunBoardWorkerDetail}
          onAttentionAction={handleRunBoardAttentionAction}
          onResultAction={handleRunBoardResultAction}
        />
        <ActiveWorkSummary
          taskStates={taskStates}
          taskCompleted={taskCompleted}
          taskTotal={taskTotal}
          toolResults={toolResults}
          density={screenDensity}
        />
      </Box>
    )
    : displayedProductResultCard
      ? <Box flexDirection="column" width="100%">
        <ProductResultCard
          view={productResultCardView}
          density={screenDensity}
          onNextAction={handleRunBoardResultAction}
          decisionTrailExpanded={decisionTrailExpanded}
          onDecisionTrailToggle={toggleDecisionTrail}
        />
      </Box>
      : <Box flexDirection="column" width="100%">
        <ProductResultCard
          view={productResultCardView}
          density={screenDensity}
          decisionTrailExpanded={decisionTrailExpanded}
          onDecisionTrailToggle={toggleDecisionTrail}
        />
      </Box>;
  const workbenchMetrics = swarmWorkbenchMetrics({
    columns: terminalColumns,
    rows: terminalRows,
    centerBottomRows: conversationBottomRows()
  });
  const activeSearchMatch = currentTranscriptSearchMatch(transcriptSearch);
  const activeSearchSummary = transcriptSearchSummary(transcriptSearch);
  const chatFooterHint = "/help  /continue  /memory  PgUp/PgDn scroll  / search  Ctrl+O details";
  const bottomFooterHint = transcriptSearch.active
    ? transcriptSearchHint(activeSearchSummary)
    : chatFooterHint;
  const footerItems = buildFooterPills({
    taskCompleted,
    taskTotal,
    pendingApprovals: footerPendingApprovalCount(approval, idlePaneSnapshot.approvals),
    cacheStatus,
    cacheHitRate,
    gatewayStatus: "local",
    mcpStatus: mcpRuntimeSummary?.state,
    skillStatus: skillRuntimeSummary?.state,
    symphonyRunning: symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping").length,
    symphonyRetrying: 0,
    lspStatus: lspHealthStatus
  });
  const activeWorkers = mergeWorkerRecords(workers, idlePaneSnapshot.workers, 6);
  const workBoardSurface = selectWorkBoardSurface({
    board: workspaceWorkBoard,
    fallbackSessions: workspaceWorkBoard?.sessions,
    memoryWorkers: activeWorkers,
    approvals: idlePaneSnapshot.approvals,
    daemons: symphonyDaemons,
    skills: runtime?.listSkills() ?? [],
    blackboard: idlePaneSnapshot.blackboard,
    recentMessages: messages.slice(-4),
    limitPerColumn: screenDensity === "compact" ? 2 : 4
  });
  const workbenchNavigation: SwarmWorkbenchNavigationItem[] = mainPaneOrder.map((pane, index) => ({
    id: pane,
    label: mainPaneLabels[pane],
    shortcut: index < 9 ? String(index + 1) : undefined,
    active: pane === mainPane
  }));
  const workbenchSessions: SwarmWorkbenchSessionItem[] = caseWorkbench?.cases.map((item) => ({
    id: item.case_id,
    title: compactWorkbenchTitle(item.title, item.case_id),
    age: shortAge(item.updated_at),
    status: item.status,
    subtitle: item.workspace_label,
    badge: item.status,
    tone: caseWorkbenchTone(item),
    attention: item.pending_approvals + item.failed_checks + (item.workspace_path ? 0 : 1),
    active: selectedCase ? item.case_id === selectedCase.case_id : item.case_id === lastSessionId
  })) ?? idlePaneSnapshot.sessions.slice(0, 5).map((session) => ({
    id: session.session_id,
    title: compactWorkbenchTitle(session.objective, session.session_id),
    age: shortAge(session.updated_at),
    status: session.status,
    active: session.session_id === lastSessionId
  }));
  const pendingApprovalCount = footerPendingApprovalCount(approval, idlePaneSnapshot.approvals);
  const activeSymphonyDaemons = symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping").length;
  const workbenchTools: SwarmWorkbenchToolItem[] = [
    { name: "Skills", status: `${workBoardSurface.summary.skills} ready`, tone: workBoardSurface.summary.skills > 0 ? "status.success" : "text.muted", active: workBoardSurface.summary.skills > 0 },
    { name: "Automations", status: activeSymphonyDaemons > 0 ? `${activeSymphonyDaemons} running` : "Idle", tone: activeSymphonyDaemons > 0 ? "role.swarm" : "text.muted", active: activeSymphonyDaemons > 0 },
    { name: "Approvals", status: `${pendingApprovalCount} pending`, tone: pendingApprovalCount > 0 ? "status.pending" : "text.muted", active: pendingApprovalCount > 0 },
    { name: "MCP", status: mcpRuntimeSummary?.state === "connected" ? "On" : "Off", tone: mcpRuntimeSummary?.state === "connected" ? "status.success" : "text.muted", active: mcpRuntimeSummary?.state === "connected" },
    { name: "LSP", status: lspHealthStatus === "ready" ? "Ready" : "Not connected", tone: lspHealthStatus === "ready" ? "status.success" : "text.muted", active: lspHealthStatus === "ready" }
  ];
  const workbenchWorkers: SwarmWorkbenchWorkerItem[] = activeWorkers.map((worker) => ({
    id: worker.worker_id,
    label: workerDisplayLabel(worker),
    status: worker.status,
    tone: workerStatusColor(worker.status)
  }));
  const workbenchFooterItems = workbenchCommandFooterItems();
  const workbenchWorkspace = {
    path: selectedCase?.workspace_label ?? caseWorkbench?.cases[0]?.workspace_label ?? runtime?.workspaceRoot() ?? process.cwd(),
    git: selectedCase
      ? caseLeaseStatus(selectedCase)
      : checkpointLabel
        ? `checkpoint ${checkpointLabel}`
        : undefined,
    status: busy ? "running" : selectedCase?.status ?? displayedProductResultCard?.status
  };
  const selectedModel = settingsSnapshot.models.worker || settingsSnapshot.models.planner || settingsSnapshot.models.defaultProvider || "unset";
  const modelParts = selectedModel.split("/");
  const providerName = modelParts.length > 1 ? modelParts[0] : undefined;
  const workbenchModel = {
    title: modelParts.length > 1 ? modelParts.slice(1).join("/") : selectedModel,
    subtitle: providerName ? `Provider: ${providerName}` : "Provider: local",
    badge: selectedModel === "unset" ? "SETUP" : "READY",
    tone: selectedModel === "unset" ? "status.pending" : "role.gateway"
  } satisfies React.ComponentProps<typeof SwarmWorkbenchLayout>["model"];
  const workbenchFooterHint = mainPane === "board"
    ? "Reply to selected case  /continue  /case  /view chat  /view workers  Ctrl+O details"
    : chatFooterHint;
  const workbenchSubtitle = mainPane === "board"
    ? caseWorkbenchSubtitle(selectedCase, caseWorkbench?.summary.inbox ?? 0, workBoardSurface.subtitle)
    : workbenchStatusSubtitle({
    executing: isActiveRunBoardPhase(displayedRunBoardPhase),
    workerCount: activeWorkers.length,
    fileCount: displayedProductResultCard?.changedFiles.length ?? latestSnapshot?.changed_files.length ?? 0,
    approvalCount: pendingApprovalCount,
    currentAction,
    needYou,
    progress
  });
  const workbenchHeaderDetail = busy
    ? currentAction
    : mainPane === "board"
      ? selectedCase?.next_action ?? "Cases are the workbench source of truth. Chat below coordinates the selected case."
      : "Waiting for your first task.";
  const workbenchCurrentAction = showCurrentAction ? (
    <CurrentActionRow
      message={currentAction}
      phase={currentPhase}
      status={loopActivity ? loopActivityStatus(loopActivity.phase) : statusForRunBoardPhase(displayedRunBoardPhase, displayedProductResultCard?.status)}
      tone={loopActivity ? loopActivityTone(loopActivity.phase) : toneForRunBoardPhase(displayedRunBoardPhase, displayedProductResultCard?.status)}
      progress={progress}
      needYou={needYou === "no" ? undefined : needYou}
      motionFrame={shouldAnimate ? motionTick : undefined}
      density={screenDensity}
    />
  ) : undefined;
  const renderWorkbenchBottom = ({ columns }: SwarmWorkbenchRenderInput): React.ReactNode => {
    if (approval) {
      return <ApprovalOverlay request={approval} onDecision={resolveApprovalDecision} />;
    }
    if (pendingPlan) {
      return <PlanApprovalOverlay summary={pendingPlan.plan.summary} taskCount={pendingPlan.plan.tasks.length} />;
    }
    return (
        <ChatInputArea
          onSubmit={submitObjective}
          onEmptyShortcut={handleConversationScrollInput}
          onCompletionRowsChange={setCompletionRows}
        onCompletionStateChange={setChatCompletion}
        controllerStateRef={chatInputState}
        extraCommands={extensionCommandCandidates}
        promptLabel={mainPane === "board" ? "case" : routeBadge(routeLabel).toLowerCase()}
        sandboxLabel={sandboxBadge(runSandboxMode).toLowerCase()}
        placeholder={mainPane === "board" ? "Reply to selected case or create the next case" : undefined}
        footerHint={workbenchFooterHint}
        footerActivityLabel={transcriptSearch.active ? "search" : undefined}
        footerActivityValue={transcriptSearch.active ? activeSearchSummary?.replace(/^search\s*/u, "") || transcriptSearch.query || "active" : undefined}
        footerActivityTone={transcriptSearch.active ? "surface.searchMatch" : undefined}
        footerItems={[]}
        onFooterItemClick={(id) => {
          emitTuiFocusTransition(
            focusDecisionForInput(undefined, {}, { focusBefore: "footer", hasFocusedTarget: true }),
            "other",
            `footer:${id}`
          );
          void openFooterDetail(id);
        }}
        onInputTelemetry={logTuiInputTelemetry}
        density={screenDensity}
        columns={columns}
      />
    );
  };
  const renderWorkbenchOverlay = ({ rows, columns }: SwarmWorkbenchRenderInput): React.ReactNode => {
    if (approval || pendingPlan || chatCompletion.candidates.length === 0) {
      return undefined;
    }
    return (
      <ChatCommandCandidates
        candidates={chatCompletion.candidates}
        selectedIndex={chatCompletion.selectedIndex}
        maxRows={workbenchCompletionOverlayRows(rows)}
        columns={columns}
        overlay
      />
    );
  };
  const renderWorkbenchPrimary = ({ rows, columns }: SwarmWorkbenchRenderInput): React.ReactNode => {
    const contentRows = Math.max(1, rows);
    const contentColumns = Math.max(20, columns);
    if (mainPane === "trace" || screenMode.primarySurface === "trace") {
      return (
        <Box flexDirection="column" width="100%" height={contentRows} overflow="hidden">
          <Text color={mutedColor()}>Runtime and protocol events</Text>
          <ActionLog
            rows={actionLogRows}
            height={Math.max(1, contentRows - 1)}
            columns={contentColumns}
            scrollOffset={actionLogScrollOffset}
            onScrollOffsetChange={setActionLogScrollOffset}
            motionFrame={shouldAnimate ? motionTick : undefined}
            selectedIndex={selectedActionIndex}
          />
        </Box>
      );
    }
    if (mainPane === "board") {
      const boardOverlay = collaborationOverlayPanel;
      return (
        <Box flexDirection="column" width="100%" height={contentRows} overflow="hidden">
          {boardOverlay}
          {selectedCase ? (
            <SelectedCasePanel
              detail={selectedCase}
              inboxCount={caseWorkbench?.summary.inbox ?? 0}
            />
          ) : null}
          <WorkBoardSurface
            view={workBoardSurface}
            rows={Math.max(8, contentRows - (boardOverlay ? 5 : 0) - (selectedCase ? 8 : 0))}
            columns={contentColumns}
          />
        </Box>
      );
    }
    if (mainPane === "chat") {
      const resultRows = displayedProductResultCard ? (screenDensity === "compact" ? 8 : 12) : 0;
      const activityRows = busy && loopActivityTimeline.length ? 2 : 0;
      const transcriptRows = Math.max(4, contentRows - resultRows - activityRows - (resultRows > 0 ? 1 : 0));
      return (
        <Box flexDirection="column" width="100%" height={contentRows} overflow="hidden">
          {renderConversationPane({
            rows: transcriptRows,
            columns: contentColumns
          })}
          {activityRows > 0 ? (
            <ActivityTimeline
              title="Activity"
              items={timelineItems}
              emptyLabel="No activity yet."
              limit={1}
              density={screenDensity}
            />
          ) : null}
          {displayedProductResultCard ? (
            <Box flexDirection="column" width="100%" height={resultRows} marginTop={1} overflow="hidden">
              <ProductResultCard
                view={productResultCardView}
                density={screenDensity}
                onNextAction={handleRunBoardResultAction}
                decisionTrailExpanded={decisionTrailExpanded}
                onDecisionTrailToggle={toggleDecisionTrail}
              />
            </Box>
          ) : messages.length === 0 ? (
            <Text color={mutedColor()}>Waiting for your first task.</Text>
          ) : null}
        </Box>
      );
    }
    if (mainPane === "plan" && shouldShowRunBoardSurface) {
      return overviewSurface;
    }
    return (
      <Box flexDirection="column" width="100%" height={contentRows} overflow="hidden">
        <IdleKernelView
          pane={mainPane}
          rows={contentRows}
          columns={contentColumns}
          messages={messages.slice(-4)}
          toolOutputs={toolResults.slice(-4)}
          sessions={idlePaneSnapshot.sessions}
          attempts={idlePaneSnapshot.attempts}
          leases={idlePaneSnapshot.leases}
          approvals={idlePaneSnapshot.approvals}
          workers={activeWorkers}
          blackboard={idlePaneSnapshot.blackboard}
          swarmSurface={swarmSurface}
          symphonyDaemons={symphonyDaemons.slice(0, 4)}
          skills={runtime?.listSkills() ?? []}
          lastSessionId={lastSessionId}
          lastRoute={lastRoute}
          lastSnapshot={latestSnapshot}
        />
      </Box>
    );
  };
  const renderConversationPane = ({ rows, columns }: SwarmWorkbenchRenderInput): React.ReactElement => (
    <ConversationFirstPane
      messages={messages}
      rows={rows}
      columns={columns}
      scrollOffset={conversationViewport.scrollOffset}
      newMessageCount={conversationViewport.newMessageCount}
      unseenStartIndex={conversationViewport.unseenStartIndex}
      expandedMessageKeys={messageCursor.expandedKeys}
      selectedMessageIndex={messageCursor.selectedIndex}
      searchMatchMessageIndex={activeSearchMatch?.messageIndex}
      searchMatchQuery={transcriptSearch.query}
      tailRows={conversationTailRows({ busy, hasResult: Boolean(displayedProductResultCard) })}
      tail={conversationTail({
        busy,
        activity: loopActivityTimeline.at(-1) ? formatConversationActivityLine(loopActivityTimeline.at(-1)!) : undefined,
        motionFrame: shouldAnimate ? motionTick : undefined,
        resultCard: displayedProductResultCard,
        detailAvailable: latestDetailSource !== "none"
      })}
    />
  );
  if (screenMode.primarySurface === "conversation") {
    const bottomRows = conversationBottomRows();
    const conversationRows = fullscreenConversationRows(terminalRows, bottomRows);
    const inputCapacity = chatInputCapacity();
    const renderConversationBottom = ({ columns }: SwarmWorkbenchRenderInput): React.ReactNode => {
      if (approval) {
        return <ApprovalOverlay request={approval} onDecision={resolveApprovalDecision} />;
      }
      if (pendingPlan) {
        return <PlanApprovalOverlay summary={pendingPlan.plan.summary} taskCount={pendingPlan.plan.tasks.length} />;
      }
      return (
        <ConversationBottomChrome
          busy={busy}
          activity={loopActivityTimeline.at(-1) ? formatConversationActivityLine(loopActivityTimeline.at(-1)!) : undefined}
          motionFrame={shouldAnimate ? motionTick : undefined}
          resultCard={displayedProductResultCard}
          detailAvailable={latestDetailSource !== "none"}
          input={
            <ChatInputArea
              onSubmit={submitObjective}
              onEmptyShortcut={handleConversationScrollInput}
              onCompletionRowsChange={setCompletionRows}
              onCompletionStateChange={setChatCompletion}
              controllerStateRef={chatInputState}
              extraCommands={extensionCommandCandidates}
              promptLabel={routeLabel === "auto" ? undefined : routeBadge(routeLabel).toLowerCase()}
              sandboxLabel={runSandboxMode === "workspace-write" ? undefined : sandboxBadge(runSandboxMode).toLowerCase()}
              footerHint={workbenchMetrics.enabled ? workbenchFooterHint : bottomFooterHint}
              footerActivityLabel={transcriptSearch.active ? "search" : undefined}
              footerActivityValue={transcriptSearch.active ? activeSearchSummary?.replace(/^search\s*/u, "") || transcriptSearch.query || "active" : undefined}
              footerActivityTone={transcriptSearch.active ? "surface.searchMatch" : undefined}
              footerItems={workbenchMetrics.enabled ? [] : footerItems}
              selectedFooterItem={workbenchMetrics.enabled ? undefined : selectedFooterPill(footerNavigation, footerItems)?.id}
              footerModeLabel={workbenchMetrics.enabled ? undefined : routeBadge(routeLabel)}
              footerPermissionLabel={workbenchMetrics.enabled ? undefined : policyBadge(settingsSnapshot.permissions.defaultMode)}
              footerPermissionTone={workbenchMetrics.enabled ? undefined : policyTone(settingsSnapshot.permissions.defaultMode)}
              footerSandboxLabel={workbenchMetrics.enabled ? undefined : sandboxBadge(runSandboxMode)}
              footerSandboxTone={workbenchMetrics.enabled ? undefined : sandboxTone(runSandboxMode)}
              onFooterItemClick={(id) => {
                emitTuiFocusTransition(
                  focusDecisionForInput(undefined, {}, { focusBefore: "footer", hasFocusedTarget: true }),
                  "other",
                  `footer:${id}`
                );
                void openFooterDetail(id);
              }}
              onInputTelemetry={logTuiInputTelemetry}
              completionPlacement="overlay"
              density={screenDensity}
              columns={columns}
              maxRows={bottomRows}
              maxInputRows={inputCapacity.maxInputRows}
            />
          }
        />
      );
    };
    const renderConversationOverlay = ({ rows, columns }: SwarmWorkbenchRenderInput): React.ReactNode => {
      if (approval || pendingPlan || chatCompletion.candidates.length === 0) {
        return undefined;
      }
      return (
        <ChatCommandCandidates
          candidates={chatCompletion.candidates}
          selectedIndex={chatCompletion.selectedIndex}
          maxRows={workbenchMetrics.enabled ? workbenchCompletionOverlayRows(rows) : chatCompletionOverlayRows(terminalRows, bottomRows)}
          columns={columns}
          overlay
        />
      );
    };
    if (workbenchMetrics.enabled) {
      return (
        <SwarmWorkbenchLayout
          columns={terminalColumns}
          rows={terminalRows}
          version="0.1.0"
          title="Chat"
          subtitle={workbenchSubtitle}
          headerDetail={workbenchHeaderDetail}
          workspace={workbenchWorkspace}
          navigation={workbenchNavigation}
          sessions={workbenchSessions}
          mode={workbenchModeCard(routeLabel)}
          runtime={{ title: "Local Runtime", subtitle: "Gateway connected", badge: "READY", tone: "role.gateway" }}
          permission={workbenchPolicyCard(settingsSnapshot.permissions.defaultMode)}
          sandbox={workbenchSandboxCard(runSandboxMode)}
          model={workbenchModel}
          memory={{
            title: taskTotal > 0 ? `${taskCompleted}/${taskTotal} tasks` : "Session not started",
            subtitle: lastSessionId ? `Session ${shortId(lastSessionId)}` : "No saved context yet",
            badge: taskTotal > 0 ? currentPhase : undefined,
            tone: taskCompleted < taskTotal ? "status.running" : "text.muted"
          }}
          tools={workbenchTools}
          workers={workbenchWorkers}
          activity={{
            title: `${workBoardSurface.summary.activeTasks} active · ${workBoardSurface.summary.blockers} blocked`,
            subtitle: workBoardSurface.summary.activity[0] ?? "No activity yet",
            badge: workBoardSurface.summary.blockers ? "RISK" : "READY",
            tone: workBoardSurface.summary.blockers ? "status.warning" : "status.success"
          }}
          footer={workbenchFooterItems}
          centerBottomRows={bottomRows}
          renderCenterContent={({ rows, columns }) => (
            <Box flexDirection="column" width="100%" height={rows} overflow="hidden" position="relative">
              {workbenchCurrentAction}
              <Box flexDirection="column" width="100%" flexGrow={1} flexShrink={1} overflow="hidden" marginTop={workbenchCurrentAction ? 1 : 0}>
                {renderConversationPane({
                  rows: centerContentRows(rows, Boolean(workbenchCurrentAction)),
                  columns
                })}
              </Box>
              {renderConversationOverlay({ rows, columns })}
            </Box>
          )}
          renderCenterBottom={renderConversationBottom}
          onNavigate={(id) => {
            if (mainPaneOrder.includes(id as MainPaneId)) {
              setMainPane(id as MainPaneId);
            }
          }}
          onSelectSession={(id) => {
            setLastSessionId(id);
            setMainPane("board");
          }}
        />
      );
    }
    return (
      <ConversationFullscreenLayout
        columns={terminalColumns}
        rows={terminalRows}
        bottomRows={bottomRows}
        completionOverlay={renderConversationOverlay({ rows: terminalRows, columns: terminalColumns })}
        completionOverlayRows={chatCompletionOverlayRows(terminalRows, bottomRows)}
        scrollable={renderConversationPane({ rows: conversationRows, columns: conversationTextColumns() })}
        bottom={renderConversationBottom({ rows: bottomRows, columns: terminalColumns })}
      />
    );
  }
  return (
    <SwarmWorkbenchLayout
      columns={terminalColumns}
      rows={terminalRows}
      version="0.1.0"
      title={mainPaneLabels[mainPane]}
      subtitle={workbenchSubtitle}
      headerDetail={workbenchHeaderDetail}
      workspace={workbenchWorkspace}
      navigation={workbenchNavigation}
      sessions={workbenchSessions}
      mode={workbenchModeCard(routeLabel)}
      runtime={{ title: "Local Runtime", subtitle: "Gateway connected", badge: "READY", tone: "role.gateway" }}
      permission={workbenchPolicyCard(settingsSnapshot.permissions.defaultMode)}
      sandbox={workbenchSandboxCard(runSandboxMode)}
      model={workbenchModel}
      memory={{
        title: taskTotal > 0 ? `${taskCompleted}/${taskTotal} tasks` : "Session not started",
        subtitle: lastSessionId ? `Session ${shortId(lastSessionId)}` : "No saved context yet",
        badge: taskTotal > 0 ? currentPhase : undefined,
        tone: taskCompleted < taskTotal ? "status.running" : "text.muted"
      }}
      tools={workbenchTools}
      workers={workbenchWorkers}
      activity={{
        title: `${workBoardSurface.summary.activeTasks} active · ${workBoardSurface.summary.blockers} blocked`,
        subtitle: workBoardSurface.summary.activity[0] ?? "No activity yet",
        badge: workBoardSurface.summary.blockers ? "RISK" : "READY",
        tone: workBoardSurface.summary.blockers ? "status.warning" : "status.success"
      }}
      footer={workbenchFooterItems}
      centerBottomRows={conversationBottomRows()}
      renderCenterContent={({ rows, columns }) => (
        <Box flexDirection="column" width="100%" height={rows} overflow="hidden" position="relative">
          {workbenchCurrentAction}
          <Box flexDirection="column" width="100%" flexGrow={1} flexShrink={1} overflow="hidden" marginTop={workbenchCurrentAction ? 1 : 0}>
            {renderWorkbenchPrimary({
              rows: centerContentRows(rows, Boolean(workbenchCurrentAction)),
              columns
            })}
          </Box>
          {renderWorkbenchOverlay({ rows, columns })}
        </Box>
      )}
      renderCenterBottom={renderWorkbenchBottom}
      onNavigate={(id) => {
        if (mainPaneOrder.includes(id as MainPaneId)) {
          setMainPane(id as MainPaneId);
        }
      }}
      onSelectSession={(id) => {
        setLastSessionId(id);
        setMainPane("board");
      }}
    />
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
        <Text color={visualTokenColor("brand.focus")}>Swarm Onboarding</Text>
        <Text color={mutedColor()}>  Enter/Tab next. Use a provider id, custom-openai:id, or custom-claude:id.</Text>
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1} width="100%">
        {readiness.map((item, index) => (
          <Text key={`${item.modelRef}:${index}`} color={item.configured ? successColor() : pendingColor()}>
            {item.modelRef}: {item.configured ? "configured" : item.reason}
          </Text>
        ))}
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1} width="100%">
        {visibleFields.map((field) => (
          <Text key={field} color={field === state.field ? visualTokenColor("role.user") : undefined}>
            {fieldLabel(field)}: {maskField(field, state.values[field])}
          </Text>
        ))}
      </Box>
      {state.error && (
        <Box marginTop={1}>
          <Text color={dangerColor()}>{state.error}</Text>
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
  swarmSurface?: SwarmSurfaceProjection;
  symphonyDaemons: SymphonyDaemonRecord[];
  skills: SkillRecord[];
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
      {input.pane === "plan" && <IdlePlanPane input={input} rows={input.rows} activeDaemons={activeDaemons} lastSnapshot={input.lastSnapshot} />}
      {input.pane === "activity" && <IdleActivityPane rows={input.rows} workers={input.workers} approvals={input.approvals} daemons={activeDaemons} toolOutputs={input.toolOutputs} />}
      {input.pane === "output" && <IdleOutputPane rows={input.rows} outputs={input.toolOutputs} />}
      {input.pane === "sessions" && <IdleSessionsPane rows={input.rows} columns={input.columns} sessions={input.sessions} leases={input.leases} lastSessionId={input.lastSessionId} />}
      {input.pane === "workers" && <IdleWorkersPane rows={input.rows} workers={input.workers} attempts={input.attempts} swarmSurface={input.swarmSurface} />}
      {input.pane === "board" && <IdleBoardPane rows={input.rows} swarmSurface={input.swarmSurface} blackboard={input.blackboard} messages={input.messages} />}
      {input.pane === "skills" && <IdleSkillsPane rows={input.rows} skills={input.skills} />}
      {input.pane === "automations" && <IdleAutomationsPane rows={input.rows} daemons={input.symphonyDaemons} />}
    </Box>
  );
}

function PaneHeader({ pane, columns }: { pane: MainPaneId; columns: number }): React.ReactElement {
  const compact = columns < 96;
  const current = compact ? mainPaneShortLabels[pane] : mainPaneLabels[pane];
  const shortcut = columns < 72 ? "/view" : "use /view";
  return (
    <Box flexDirection="column" width="100%">
      <Text wrap="truncate">
        <Text color={paneAccentColor(pane)} bold>{sectionLabel(current)}</Text>
        <Text color={mutedColor()}>  {shortcut} · </Text>
      {mainPaneOrder.map((item, index) => (
        <Text key={item} color={item === pane ? paneAccentColor(pane) : mutedColor()}>
          {item === pane ? `> ${compact ? mainPaneShortLabels[item] : mainPaneLabels[item]}` : compact ? mainPaneShortLabels[item] : mainPaneLabels[item]}
          {index < mainPaneOrder.length - 1 ? " " : ""}
        </Text>
      ))}
      </Text>
      <PaneDivider columns={columns} tone={paneAccentToken(pane)} />
    </Box>
  );
}

function PaneDivider({ columns = 96, tone = "surface.line" }: { columns?: number; tone?: TuiColorRef }): React.ReactElement {
  return (
    <Text color={resolveTuiColor(tone)} wrap="truncate">
      {paneRule(columns)}
    </Text>
  );
}

function PaneSection({
  title,
  tone = "text.primary",
  children,
  marginTop = 1
}: {
  title: string;
  tone?: TuiColorRef;
  children: React.ReactNode;
  marginTop?: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" marginTop={marginTop}>
      <Text wrap="truncate">
        <Text color={resolveTuiColor(tone)} bold>{sectionLabel(title)}</Text>
        <Text color={mutedColor()}>{paneSectionRule(title, 96)}</Text>
      </Text>
      {children}
    </Box>
  );
}

function paneRule(columns: number): string {
  return "-".repeat(Math.max(1, Math.floor(columns)));
}

function paneSectionRule(title: string, columns: number): string {
  const label = sectionLabel(title);
  const width = Math.max(0, Math.floor(columns) - displayWidth(label) - 1);
  return width > 0 ? ` ${"-".repeat(width)}` : "";
}

function paneAccentToken(pane: MainPaneId): TuiColorRef {
  switch (pane) {
    case "output": return "role.tool";
    case "sessions": return "role.gateway";
    case "activity": return "role.swarm";
    case "workers": return "role.worker";
    case "board": return "role.swarm";
    case "skills": return "status.success";
    case "automations": return "role.swarm";
    case "plan": return "brand.focus";
    case "chat": return "text.primary";
    case "trace": return "text.primary";
  }
}

function paneAccentColor(pane: MainPaneId): TuiResolvedColor {
  return resolveTuiColor(paneAccentToken(pane));
}

function SelectedCasePanel({ detail, inboxCount }: { detail: CaseWorkbenchDetail; inboxCount: number }): React.ReactElement {
  return (
    <PaneSection title="Selected Case" tone={caseWorkbenchTone(detail)} marginTop={0}>
      <Text color={resolveTuiColor(caseWorkbenchTone(detail))} wrap="truncate">
        {detail.case_id} [{detail.status}] {detail.title}
      </Text>
      <Text color={mutedColor()} wrap="truncate">
        lease: {detail.workspace_label}  sessions: {detail.session_count}  workers: {detail.active_workers}/{detail.worker_count}  inbox: {inboxCount}
      </Text>
      <Text color={detail.workspace_path ? mutedColor() : visualTokenColor("status.warning")} wrap="truncate">
        {detail.next_action}
      </Text>
      <Text color={mutedColor()} wrap="truncate">
        {detail.badges.slice(0, 5).join("  ") || "no badges"}
      </Text>
    </PaneSection>
  );
}

function IdlePlanPane({ input, rows, activeDaemons, lastSnapshot }: {
  input: Parameters<typeof IdleKernelView>[0];
  rows: number;
  activeDaemons: SymphonyDaemonRecord[];
  lastSnapshot?: ReturnType<SwarmRuntime["getWorkSnapshot"]>;
}): React.ReactElement {
  const latestUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
  const recentMessages = rows >= 48 ? 3 : rows >= 36 ? 2 : 1;
  return (
    <>
      <PaneSection title="Objective" tone="brand.focus">
        <Text color={visualTokenColor("text.primary")} wrap="truncate">
          {latestUserMessage?.brief ?? lastSnapshot?.session?.objective ?? "No active objective yet."}
        </Text>
      </PaneSection>

      <PaneSection title="Current Plan" tone="role.gateway">
        {lastSnapshot
          ? compactWorkSnapshotLines(lastSnapshot).slice(0, rows >= 40 ? 5 : 3).map((line) => (
              <Text key={line} wrap="truncate" color={mutedColor()}>
                {line}
              </Text>
            ))
          : (
            <>
              <Text color={mutedColor()}>1. Ask Swarm to inspect, edit, test, or explain this workspace.</Text>
              <Text color={mutedColor()}>2. Swarm will turn the request into a plan before editing.</Text>
              <Text color={mutedColor()}>3. Results and checks will appear after work starts.</Text>
            </>
          )}
      </PaneSection>

      <PaneSection title="Next Action" tone="status.pending">
        {input.approvals.length
          ? input.approvals.slice(0, 2).map((approval) => (
              <Text key={approval.approval_id} wrap="truncate" color={pendingColor()}>
                Approve {approval.action} for {firstLine(approval.target, 68)}
              </Text>
            ))
          : activeDaemons.length
            ? activeDaemons.slice(0, 2).map((daemon) => (
                <Text key={daemon.daemon_id} wrap="truncate" color={visualTokenColor("role.swarm")}>
                  Background worker {shortId(daemon.daemon_id)} is {daemon.status}.
                </Text>
              ))
            : <Text color={mutedColor()}>Waiting for your first task.</Text>}
      </PaneSection>

      <PaneSection title="Recent Messages" tone="text.primary">
        {input.messages.length ? input.messages.slice(-recentMessages).map((message, index) => (
          <Box key={`${message.role}-${index}`} flexDirection="column">
            <Text wrap="truncate" color={roleColor(message.role)}>
              {message.role}: {message.brief}
            </Text>
          </Box>
      )) : <Text color={mutedColor()}>No command output yet.</Text>}
      </PaneSection>

      {input.toolOutputs.length > 0 && (
        <PaneSection title="Latest Output" tone="role.tool">
          {input.toolOutputs.slice(-1).map((result, index) => {
            return (
              <Box key={`${result.task_id}-${index}`} flexDirection="column">
                <Text wrap="truncate">
                  {statusIcon(result.status ?? "completed")} {result.action} {firstLine(result.summary, 88)}{result.outputRef ? " (saved)" : ""}
                </Text>
                {result.recoverySuggestion && <Text color={pendingColor()} wrap="truncate">{indentPreview(firstLine(result.recoverySuggestion, 88), "  ")}</Text>}
                {compactPreview(result.content)}
              </Box>
            );
          })}
        </PaneSection>
      )}
    </>
  );
}

function IdleOutputPane({ rows, outputs }: { rows: number; outputs: ToolResultState[] }): React.ReactElement {
  const outputLimit = rows >= 48 ? 5 : rows >= 36 ? 3 : 2;
  const outputRows = orderCompactIdleRows(outputs.map((result, index) => compactIdleOutputRow(result, index))).slice(0, outputLimit);
  return (
    <PaneSection title="Output" tone="role.tool">
      {outputRows.length ? outputRows.map(({ row, source }) => (
        <Box key={row.key} flexDirection="column">
          <CompactIdleRow row={row} />
          {source.recoverySuggestion && <Text color={pendingColor()} wrap="truncate">{indentPreview(firstLine(source.recoverySuggestion, 92), "  ")}</Text>}
          {source.outputRef && <Text color={mutedColor()} wrap="truncate">{indentPreview(`full: ${shortPath(source.outputRef)}`, "  ")}</Text>}
          {compactPreview(source.content)}
        </Box>
      )) : (
        <Box flexDirection="column" width="100%">
          <Text color={mutedColor()}>No command output yet.</Text>
          <Text color={mutedColor()}>Command output will appear here when Swarm runs shell commands, tests, build steps, or tools that produce stdout/stderr.</Text>
        </Box>
      )}
    </PaneSection>
  );
}

type CompactIdleOutputRow = {
  row: CompactIdleRowData;
  source: ToolResultState;
};

function CompactIdleRow({ row }: { row: CompactIdleRowData }): React.ReactElement {
  const parts = compactIdleRowParts(row);
  const tone = row.tone ?? statusTone(row.status);
  const color = toneColor(tone);
  return (
      <Text wrap="truncate">
        <Text color={color}>{parts.badge}</Text>
        <Text> {parts.id} {parts.title}</Text>
        {parts.status ? <Text color={color}> [{parts.status}]</Text> : null}
      {parts.meta.length ? <Text color={mutedColor()}> · {parts.meta.join(" · ")}</Text> : null}
    </Text>
  );
}

export function formatCompactIdleRow(row: CompactIdleRowData): string {
  const parts = compactIdleRowParts(row);
  return [
    `${parts.badge} ${parts.id} ${parts.title}${parts.status ? ` [${parts.status}]` : ""}`,
    parts.meta.length ? parts.meta.join(" · ") : undefined
  ].filter(Boolean).join(" · ");
}

export function formatCompactIdleRows(rows: CompactIdleRowData[]): string[] {
  return orderCompactIdleRows(rows).map(formatCompactIdleRow);
}

function compactIdleRowParts(row: CompactIdleRowData): {
  badge: string;
  id: string;
  title: string;
  status?: string;
  meta: string[];
} {
  return {
    badge: row.badge ?? statusBadge(row.status),
    id: compactIdleText(row.id, 14) || "-",
    title: compactIdleText(row.title, 56) || "(untitled)",
    status: row.status ? compactIdleText(row.status, 18) : undefined,
    meta: (row.meta ?? [])
      .map((item) => compactIdleText(item ?? "", 28))
      .filter((item) => item.length > 0)
  };
}

function compactIdleText(value: string, maxLength: number): string {
  return compactValue(firstLine(value, maxLength), maxLength);
}

function orderCompactIdleRows<T extends CompactIdleRowData | { row: CompactIdleRowData }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftRow = compactIdleSortData(left.row);
      const rightRow = compactIdleSortData(right.row);
      const priority = (rightRow.priority ?? 0) - (leftRow.priority ?? 0);
      if (priority !== 0) {
        return priority;
      }
      return (leftRow.order ?? left.index) - (rightRow.order ?? right.index);
    })
    .map((item) => item.row);
}

function compactIdleSortData<T extends CompactIdleRowData | { row: CompactIdleRowData }>(item: T): CompactIdleRowData {
  return (item as { row?: CompactIdleRowData }).row ?? (item as CompactIdleRowData);
}

function compactIdleOutputRow(result: ToolResultState, index: number): CompactIdleOutputRow {
  const status = result.status ?? "completed";
  return {
    row: {
      key: `${result.task_id}-${result.attempt ?? 0}-${index}`,
      id: result.agentLabel ?? result.workerId ?? result.task_id,
      title: result.summary || result.title || result.action,
      status,
      meta: [
        result.action,
        result.outputRef ? "saved" : undefined,
        result.errorCode ? `error=${result.errorCode}` : undefined
      ],
      priority: compactIdlePriority(status, result.recoverySuggestion ? 8 : 0),
      order: index
    },
    source: result
  };
}

function compactIdleSessionRow(session: RecentSessionRow, lastSessionId: string | undefined, index: number): CompactIdleRowData {
  const source = sessionSourceKind(session.source_json);
  return {
    key: session.session_id,
    id: session.session_id,
    title: session.objective,
    status: session.status,
    meta: [
      source,
      session.session_id === lastSessionId ? "last" : undefined,
      `updated=${compactTimestamp(session.updated_at)}`
    ],
    priority: compactIdlePriority(session.status, session.session_id === lastSessionId ? 2 : 0),
    order: index
  };
}

function compactIdleLeaseRow(lease: WorkspaceLease, index: number): CompactIdleRowData {
  return {
    key: lease.lease_id,
    id: lease.session_id,
    title: shortPath(lease.workspace_path),
    status: lease.write_boundary,
    badge: lease.write_boundary === "read_only" ? "[RO]" : lease.write_boundary === "workspace" ? "[RW]" : "[FS]",
    tone: lease.write_boundary === "read_only" ? "warning" : "muted",
    meta: [
      lease.scope.length ? compactScope(lease.scope) : undefined,
      `created=${compactTimestamp(lease.created_at)}`
    ],
    priority: lease.write_boundary === "read_only" ? 45 : 10,
    order: index
  };
}

function compactIdleAttemptRow(attempt: RunAttempt, index: number): CompactIdleRowData {
  const owner = attempt.task_id ?? attempt.runner_id ?? attempt.session_id;
  return {
    key: attempt.attempt_id,
    id: owner,
    title: attempt.title ?? attempt.session_id,
    status: attempt.status,
    meta: [
      attempt.kind,
      `#${attempt.attempt}`,
      shortId(attempt.session_id),
      attempt.error_code ? `error=${attempt.error_code}` : undefined
    ],
    priority: compactIdlePriority(attempt.status, attempt.recovery_suggestion ? 8 : 0),
    order: index
  };
}

function compactIdleWorkerRow(worker: WorkerRecord, index: number): CompactIdleRowData {
  const agent = worker.agent_spec_id
    ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}`
    : worker.capability;
  return {
    key: worker.worker_id,
    id: workerDisplayLabel(worker),
    title: worker.objective,
    status: worker.status,
    tone: worker.blocked_reason ? "warning" : undefined,
    meta: [
      agent,
      worker.file_scope.length ? compactScope(worker.file_scope) : undefined,
      worker.last_result ? "result" : undefined
    ],
    priority: compactIdlePriority(worker.status, worker.blocked_reason ? 18 : 0),
    order: index
  };
}

function compactIdleApprovalRow(approval: ApprovalStoreRecord, index: number): CompactIdleRowData {
  return {
    key: approval.approval_id,
    id: approval.approval_id,
    title: `${approval.action} ${approval.target}`,
    status: approval.status,
    meta: [
      `${approval.risk_class}/${approval.risk}`,
      approval.task_id ? `task=${shortId(approval.task_id)}` : undefined,
      approval.session_id ? `session=${shortId(approval.session_id)}` : undefined
    ],
    priority: compactIdlePriority(approval.status, approval.status === "pending" ? 20 + riskClassPriority(approval.risk_class) : 0),
    order: index
  };
}

function compactIdleDaemonRow(daemon: SymphonyDaemonRecord, index: number): CompactIdleRowData {
  return {
    key: daemon.daemon_id,
    id: daemon.daemon_id,
    title: shortPath(daemon.workflow_path ?? daemon.daemon_id),
    status: daemon.status,
    tone: daemon.status === "stopping" ? "warning" : undefined,
    meta: [
      `ticks=${daemon.tick_count}`,
      daemon.last_error ? `error=${firstLine(daemon.last_error, 24)}` : undefined
    ],
    priority: compactIdlePriority(daemon.status, daemon.last_error ? 12 : 0),
    order: index
  };
}

function compactIdleBlackboardRow(entry: BlackboardEntry, index: number): CompactIdleRowData {
  return {
    key: entry.entry_id,
    id: entry.type,
    title: entry.key,
    status: entry.visibility,
    badge: blackboardTypeBadge(entry.type),
    tone: entry.type === "critique" ? "warning" : entry.type === "decision" ? "brand" : "muted",
    meta: [
      shortId(entry.session_id),
      entry.task_id ? `task=${shortId(entry.task_id)}` : undefined,
      (entry.tags ?? []).length ? `tags=${(entry.tags ?? []).slice(0, 2).join(",")}` : undefined,
      `v${entry.version}`
    ],
    priority: blackboardTypePriority(entry.type),
    order: index
  };
}

function compactIdlePriority(status: string | undefined, bonus = 0): number {
  const normalized = (status ?? "").toLowerCase();
  let base = 35;
  if (["failed", "failure", "error", "denied", "reject", "cancelled"].includes(normalized)) {
    base = 95;
  } else if (["blocked", "stopped", "needs_revision", "partial", "warn", "warning"].includes(normalized)) {
    base = 85;
  } else if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval"].includes(normalized)) {
    base = 80;
  } else if (["running", "started", "processing", "applied", "thinking", "executing", "planning", "reviewing", "aggregating", "stopping"].includes(normalized)) {
    base = 75;
  } else if (["completed", "complete", "success", "approved", "pass", "done", "ok"].includes(normalized)) {
    base = 10;
  }
  return base + bonus;
}

function riskClassPriority(riskClass: string): number {
  const match = /^r(\d+)$/i.exec(riskClass);
  return match ? Number(match[1]) : 0;
}

function compactScope(paths: string[]): string {
  const visible = paths.slice(0, 2).map(shortPath).join(",");
  return `scope=${visible}${paths.length > 2 ? `,+${paths.length - 2}` : ""}`;
}

function compactTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const time = /T(\d{2}:\d{2})/.exec(value)?.[1];
  return time ?? compactValue(value, 16);
}

function blackboardTypeBadge(type: BlackboardEntry["type"]): string {
  return {
    plan: "[PLN]",
    observation: "[OBS]",
    evidence: "[EVD]",
    result: "[RES]",
    critique: "[CRT]",
    decision: "[DEC]",
    artifact: "[ART]"
  }[type];
}

function blackboardTypePriority(type: BlackboardEntry["type"]): number {
  return {
    critique: 70,
    decision: 60,
    evidence: 50,
    observation: 40,
    plan: 30,
    result: 20,
    artifact: 20
  }[type];
}

function IdleSessionsPane({ rows, columns, sessions, leases, lastSessionId }: {
  rows: number;
  columns: number;
  sessions: RecentSessionRow[];
  leases: WorkspaceLease[];
  lastSessionId?: string;
}): React.ReactElement {
  const sessionLimit = rows >= 48 ? 7 : rows >= 36 ? 4 : 2;
  const leaseLimit = rows >= 48 ? 3 : rows >= 36 ? 2 : 1;
  const currentSession = currentIdleSession(sessions, lastSessionId);
  const currentLease = currentSession
    ? leases.find((lease) => lease.lease_id === currentSession.workspace_lease_id || lease.session_id === currentSession.session_id)
    : undefined;
  const sessionRows = orderCompactIdleRows(sessions.map((session, index) => compactIdleSessionRow(session, lastSessionId, index))).slice(0, sessionLimit);
  const leaseRows = orderCompactIdleRows(leases.map((lease, index) => compactIdleLeaseRow(lease, index))).slice(0, leaseLimit);
  return (
    <>
      <PaneSection title="Current Session" tone="role.gateway">
        {currentSession ? (
          <Box flexDirection="column" width="100%">
            <SessionDetailRow label="id" value={currentSession.session_id} columns={columns} tone={resolveTuiColor("role.gateway")} />
            <SessionDetailRow label="status" value={currentSession.status} columns={columns} tone={toneColor(statusTone(currentSession.status))} />
            <SessionDetailRow label="workspace" value={currentLease?.workspace_path ?? "(workspace unavailable)"} columns={columns} />
            <SessionDetailRow label="mode" value={sessionSourceKind(currentSession.source_json) ?? "local"} columns={columns} />
            <SessionDetailRow label="started" value={compactTimestamp(currentSession.created_at) ?? "-"} columns={columns} />
            <SessionDetailRow label="updated" value={compactTimestamp(currentSession.updated_at) ?? "-"} columns={columns} />
            <SessionDetailRow label="objective" value={currentSession.objective || "(untitled)"} columns={columns} />
          </Box>
        ) : (
          <Box flexDirection="column" width="100%">
            <Text color={mutedColor()}>No current session yet.</Text>
            <Text color={mutedColor()}>Start a chat or resume a recent session.</Text>
          </Box>
        )}
      </PaneSection>

      <PaneSection title="Recent Sessions" tone="role.gateway">
        {sessionRows.length ? sessionRows.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>(none)</Text>}
      </PaneSection>

      <PaneSection title="Workspace Access" tone="role.gateway">
        {leaseRows.length ? leaseRows.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>(none)</Text>}
      </PaneSection>
    </>
  );
}

function currentIdleSession(sessions: RecentSessionRow[], lastSessionId: string | undefined): RecentSessionRow | undefined {
  if (lastSessionId) {
    return sessions.find((session) => session.session_id === lastSessionId) ?? sessions[0];
  }
  return sessions[0];
}

function SessionDetailRow({
  label,
  value,
  columns,
  tone
}: {
  label: string;
  value: string;
  columns: number;
  tone?: TuiResolvedColor;
}): React.ReactElement {
  const labelWidth = 10;
  const valueWidth = Math.max(8, columns - labelWidth - 2);
  return (
    <Text wrap="truncate">
      <Text color={mutedColor()}>{padToDisplayWidth(label, labelWidth)}</Text>
      <Text color={tone ?? visualTokenColor("text.primary")}>{fitToDisplayWidth(firstLine(value, 240), valueWidth)}</Text>
    </Text>
  );
}

function IdleAttemptsPane({ rows, attempts }: { rows: number; attempts: RunAttempt[] }): React.ReactElement {
  const attemptLimit = rows >= 48 ? 8 : rows >= 36 ? 5 : 3;
  const attemptRows = orderCompactIdleRows(attempts.map((attempt, index) => compactIdleAttemptRow(attempt, index))).slice(0, attemptLimit);
  const attemptById = new Map(attempts.map((attempt) => [attempt.attempt_id, attempt]));
  return (
    <PaneSection title="Run Attempts" tone="status.warning">
      {attemptRows.length ? attemptRows.map((row) => {
        const attempt = attemptById.get(row.key);
        return (
        <Box key={row.key} flexDirection="column">
          <CompactIdleRow row={row} />
          {attempt?.recovery_suggestion && <Text color={pendingColor()} wrap="truncate">  Recovery: {firstLine(attempt.recovery_suggestion, 92)}</Text>}
        </Box>
        );
      }) : <Text color={mutedColor()}>(none)</Text>}
    </PaneSection>
  );
}

function IdleActivityPane({ rows, workers, approvals, daemons, toolOutputs }: {
  rows: number;
  workers: WorkerRecord[];
  approvals: ApprovalStoreRecord[];
  daemons: SymphonyDaemonRecord[];
  toolOutputs: ToolResultState[];
}): React.ReactElement {
  const workerLimit = rows >= 48 ? 6 : 3;
  const approvalLimit = rows >= 48 ? 4 : rows >= 36 ? 3 : 2;
  const daemonLimit = rows >= 48 ? 4 : rows >= 36 ? 3 : 2;
  const outputLimit = rows >= 48 ? 4 : rows >= 36 ? 3 : 2;
  const workerRows = orderCompactIdleRows(workers.map((worker, index) => compactIdleWorkerRow(worker, index))).slice(0, workerLimit);
  const workerById = new Map(workers.map((worker) => [worker.worker_id, worker]));
  const approvalRows = orderCompactIdleRows(approvals.map((approval, index) => compactIdleApprovalRow(approval, index))).slice(0, approvalLimit);
  const daemonRows = orderCompactIdleRows(daemons.map((daemon, index) => compactIdleDaemonRow(daemon, index))).slice(0, daemonLimit);
  const outputRows = orderCompactIdleRows(toolOutputs.map((result, index) => compactIdleOutputRow(result, index))).slice(0, outputLimit);
  return (
    <>
      <PaneSection title="Timeline" tone="role.swarm">
        {workerRows.length ? workerRows.map((row) => {
          const worker = workerById.get(row.key);
          return (
            <Box key={row.key} flexDirection="column">
              <CompactIdleRow row={row} />
              {worker?.last_result && <Text wrap="truncate" color={mutedColor()}>{indentPreview(firstLine(worker.last_result, 90), "  ")}</Text>}
              {worker?.blocked_reason && <Text wrap="truncate" color={pendingColor()}>{indentPreview(firstLine(worker.blocked_reason, 90), "  ")}</Text>}
            </Box>
          );
        }) : <Text color={mutedColor()}>No workers have started yet.</Text>}
      </PaneSection>

      <PaneSection title="Approvals" tone="status.pending">
        {approvalRows.length ? approvalRows.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>No approvals pending.</Text>}
      </PaneSection>

      <PaneSection title="Tool Calls" tone="role.tool">
        {outputRows.length ? outputRows.map(({ row }) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>No tool calls yet.</Text>}
      </PaneSection>

      <PaneSection title="Background Work" tone="role.swarm">
        {daemonRows.length ? daemonRows.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>No background work running.</Text>}
      </PaneSection>
    </>
  );
}

function IdleSkillsPane({ rows, skills }: { rows: number; skills: SkillRecord[] }): React.ReactElement {
  const active = skills.filter((skill) => !skill.shadowedBy && skill.trust !== "disabled" && skill.trust !== "untrusted");
  const diagnostics = skills.flatMap((skill) => skill.diagnostics.map((diagnostic) => ({ skill, diagnostic })));
  const visibleLimit = rows >= 48 ? 8 : rows >= 36 ? 5 : 3;
  return (
    <>
      <PaneSection title="Skills" tone="status.success">
        {active.length ? active.slice(0, visibleLimit).map((skill) => (
          <Box key={skill.name} flexDirection="column">
            <Text color={visualTokenColor("status.success")} wrap="truncate">
              {skill.displayName || skill.name} [{skill.scope}/{skill.trust}]
            </Text>
            <Text color={mutedColor()} wrap="truncate">
              {firstLine(skill.description, 96)}
            </Text>
          </Box>
        )) : (
          <Box flexDirection="column" width="100%">
            <Text color={mutedColor()}>No active skills discovered.</Text>
            <Text color={mutedColor()}>Skills become reusable teammate capabilities once trusted.</Text>
          </Box>
        )}
      </PaneSection>

      <PaneSection title="Capability Reuse" tone="role.gateway">
        <Text color={mutedColor()} wrap="truncate">
          {active.length} active · {skills.length - active.length} inactive/shadowed · {diagnostics.length} diagnostics
        </Text>
        <Text color={mutedColor()} wrap="truncate">
          Use /skills all for paths, trust, allowed tools, and full diagnostics.
        </Text>
      </PaneSection>

      {diagnostics.length > 0 && (
        <PaneSection title="Diagnostics" tone="status.warning">
          {diagnostics.slice(0, Math.min(visibleLimit, 4)).map(({ skill, diagnostic }, index) => (
            <Text key={`${skill.name}-${diagnostic.code ?? index}`} color={diagnostic.severity === "error" ? dangerColor() : pendingColor()} wrap="truncate">
              {skill.name}: {diagnostic.code ?? "diagnostic"} {firstLine(diagnostic.message, 82)}
            </Text>
          ))}
        </PaneSection>
      )}
    </>
  );
}

function IdleAutomationsPane({ rows, daemons }: { rows: number; daemons: SymphonyDaemonRecord[] }): React.ReactElement {
  const visibleLimit = rows >= 48 ? 8 : rows >= 36 ? 5 : 3;
  const active = daemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping");
  const daemonRows = orderCompactIdleRows(daemons.map((daemon, index) => compactIdleDaemonRow(daemon, index))).slice(0, visibleLimit);
  return (
    <>
      <PaneSection title="Automations" tone="role.swarm">
        {daemonRows.length ? daemonRows.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : (
          <Box flexDirection="column" width="100%">
            <Text color={mutedColor()}>No automations running.</Text>
            <Text color={mutedColor()}>Automations are Symphony workflows surfaced as local workspace routines.</Text>
          </Box>
        )}
      </PaneSection>

      <PaneSection title="Runtime" tone={active.length ? "status.running" : "text.muted"}>
        <Text color={mutedColor()} wrap="truncate">
          {active.length} active · {daemons.length} known · {daemons.reduce((sum, daemon) => sum + daemon.tick_count, 0)} ticks
        </Text>
        <Text color={mutedColor()} wrap="truncate">
          Use /symphony status, /symphony daemon, or /view activity for execution detail.
        </Text>
      </PaneSection>

      {daemons.some((daemon) => daemon.last_error) && (
        <PaneSection title="Blockers" tone="status.warning">
          {daemons.filter((daemon): daemon is SymphonyDaemonRecord & { last_error: string } => Boolean(daemon.last_error)).slice(0, Math.min(visibleLimit, 4)).map((daemon) => (
            <Text key={daemon.daemon_id} color={dangerColor()} wrap="truncate">
              {shortId(daemon.daemon_id)} {firstLine(daemon.last_error, 90)}
            </Text>
          ))}
        </PaneSection>
      )}
    </>
  );
}

function SwarmSurfacePanel({ surface, limit = 4 }: { surface?: SwarmSurfaceProjection; limit?: number }): React.ReactElement | null {
  if (!surface) {
    return null;
  }
  const visibleLimit = Math.max(1, Math.min(limit, 6));
  const tone: TuiColorRef = surface.summary.conflicts > 0 ? "status.warning" : "role.swarm";
  const ownership = surface.ownership.slice(0, visibleLimit);
  const conflicts = surface.conflicts.slice(0, visibleLimit);
  return (
    <PaneSection title="Shared Board" tone={tone}>
      <Text color={mutedColor()} wrap="truncate">
        {formatSwarmTopologySummary(surface)}
      </Text>
      {surface.actors.slice(0, visibleLimit).map((actor) => (
        <Text key={actor.actor_id} color={actor.heartbeat_state === "fresh" ? visualTokenColor("role.swarm") : pendingColor()} wrap="truncate">
          {actor.actor_id} [{actor.kind}/{actor.status}/{actor.heartbeat_state}] in={actor.mailbox.inbox_total}/{actor.mailbox.inbox_pending + actor.mailbox.inbox_failed} out={actor.mailbox.outbox_total}/{actor.mailbox.outbox_pending + actor.mailbox.outbox_failed}{actor.current_task_id ? ` task=${actor.current_task_id}` : ""}{actor.current_worker_id ? ` worker=${actor.current_worker_id}` : ""}
        </Text>
      ))}
      {ownership.length > 0 && (
        <Text color={mutedColor()} wrap="truncate">
          Workspace Claims {ownership.map((item) => `${item.kind}:${item.id}->${item.owner ?? "-"}`).join(" | ")}
        </Text>
      )}
      {conflicts.map((item) => (
        <Text key={`${item.kind}:${item.id}`} color={item.severity === "error" ? dangerColor() : pendingColor()} wrap="truncate">
          warning {item.kind}:{item.id} {firstLine(productizeSwarmConflictSummary(item.summary), 72)}
        </Text>
      ))}
    </PaneSection>
  );
}

function productizeSwarmConflictSummary(summary: string): string {
  return summary
    .replace(/stale\s+heartbeat/giu, "worker heartbeat missed")
    .replace(/offline\s+heartbeat/giu, "worker disconnected")
    .replace(/heartbeat\s+conflict/giu, "worker heartbeat missed")
    .replace(/\bstale\b/giu, "inactive")
    .replace(/\bownership\b/giu, "Workspace Claims");
}

function IdleWorkersPane({ rows, workers, attempts, swarmSurface }: {
  rows: number;
  workers: WorkerRecord[];
  attempts: RunAttempt[];
  swarmSurface?: SwarmSurfaceProjection;
}): React.ReactElement {
  const workerLimit = rows >= 48 ? 8 : rows >= 36 ? 5 : 3;
  const attemptLimit = rows >= 48 ? 4 : 2;
  const workerRows = orderCompactIdleRows(workers.map((worker, index) => compactIdleWorkerRow(worker, index))).slice(0, workerLimit);
  const recentAttempts = orderCompactIdleRows(attempts.map((attempt, index) => compactIdleAttemptRow(attempt, index))).slice(0, attemptLimit);
  const handoffs = swarmSurface?.ownership.filter((item) => item.kind === "handoff").slice(0, workerLimit) ?? [];
  return (
    <>
      <PaneSection title="Workers" tone="role.worker">
        {workerRows.length ? workerRows.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>No workers have started yet.</Text>}
      </PaneSection>

      <PaneSection title="Handoffs" tone="role.swarm">
        {handoffs.length ? handoffs.map((item) => (
          <Text key={`${item.kind}:${item.id}`} color={item.severity === "error" ? dangerColor() : pendingColor()} wrap="truncate">
            {item.id} {workerStatusProductLabel(item.status)} {item.owner ? `to ${item.owner}` : ""}
          </Text>
        )) : <Text color={mutedColor()}>None</Text>}
      </PaneSection>

      <PaneSection title="Recent Results" tone="status.warning">
        {recentAttempts.length ? recentAttempts.map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>No worker results yet.</Text>}
      </PaneSection>
    </>
  );
}

function IdleBoardPane({ rows, swarmSurface, blackboard, messages }: {
  rows: number;
  swarmSurface?: SwarmSurfaceProjection;
  blackboard: BlackboardEntry[];
  messages: ChatMessage[];
}): React.ReactElement {
  const limit = rows >= 48 ? 6 : rows >= 36 ? 4 : 3;
  const boardRows = orderCompactIdleRows(blackboard.map((entry, index) => compactIdleBlackboardRow(entry, index))).slice(0, limit);
  const recentMessages = rows >= 48 ? 3 : rows >= 36 ? 2 : 1;
  return (
    <>
      <PaneSection title="Shared collaboration state" tone="role.swarm">
        {swarmSurface ? (
          <>
            <Text color={mutedColor()} wrap="truncate">Participants active {swarmSurface.summary.active_participants} inactive {swarmSurface.summary.stale_participants} waiting {swarmSurface.summary.inbox_pending}</Text>
            <Text color={mutedColor()} wrap="truncate">Workspace Claims {swarmSurface.summary.ownership_items}</Text>
          </>
        ) : (
          <Text color={mutedColor()}>No shared board data yet.</Text>
        )}
      </PaneSection>

      <PaneSection title="Workspace Claims" tone="role.swarm">
        {swarmSurface?.ownership.length ? swarmSurface.ownership.slice(0, limit).map((item) => (
          <Text key={`${item.kind}:${item.id}`} color={item.severity === "error" ? dangerColor() : mutedColor()} wrap="truncate">
            {item.kind}:{item.id} claimed by {item.owner ?? "unassigned"} {workerStatusProductLabel(item.status)}
          </Text>
        )) : <Text color={mutedColor()}>No workspace claims yet.</Text>}
      </PaneSection>

      <PaneSection title="Decisions" tone="brand.focus">
        {boardRows.filter((row) => row.id === "decision").length ? boardRows.filter((row) => row.id === "decision").map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : <Text color={mutedColor()}>No decisions yet.</Text>}
      </PaneSection>

      <PaneSection title="Proposals" tone="text.primary">
        {boardRows.filter((row) => row.id !== "decision").length ? boardRows.filter((row) => row.id !== "decision").map((row) => (
          <CompactIdleRow key={row.key} row={row} />
        )) : messages.length ? messages.slice(-recentMessages).map((message, index) => (
          <Text key={`${message.role}-${index}`} wrap="truncate" color={roleColor(message.role)}>
            {message.role}: {message.brief}
          </Text>
        )) : <Text color={mutedColor()}>No proposals yet.</Text>}
      </PaneSection>
    </>
  );
}

function workerStatusProductLabel(status: string): string {
  if (status === "completed" || status === "complete" || status === "success") return "Done";
  if (status === "running" || status === "active") return "Running";
  if (status === "pending" || status === "queued" || status === "waiting") return "Planning";
  if (status === "stale") return "inactive";
  return status;
}

function ActiveWorkSummary(input: {
  taskStates: Map<string, TaskState>;
  taskCompleted: number;
  taskTotal: number;
  toolResults: ToolResultState[];
  density?: TuiDensity;
}): React.ReactElement {
  const latestTask = [...input.taskStates.entries()].slice(-1)[0];
  const latestOutput = input.toolResults.slice(-1)[0];
  const policySummary = summarizeTaskWritePolicies(input.taskStates);
  const scopePreview = policySummary.scopedTargets.slice(0, 3).join(", ");
  const scopeSuffix = policySummary.scopedTargets.length > 3 ? ` +${policySummary.scopedTargets.length - 3} more` : "";
  const compact = input.density === "compact";
  return (
    <Box flexDirection="column" width="100%">
      <Text color={visualTokenColor("role.swarm")} bold>{sectionLabel("Work")}</Text>
      <Text color={mutedColor()} wrap="truncate">
        in progress · tasks {input.taskCompleted}/{input.taskTotal || 0} · tool outputs {input.toolResults.length}
      </Text>
      {!compact && (
        <Text color={mutedColor()} wrap="truncate">
          policies: ro {policySummary.readOnly} · scoped {policySummary.scopedWrite} · workspace {policySummary.workspaceWrite}
        </Text>
      )}
      {policySummary.scopedTargets.length > 0 && (
        <Text color={mutedColor()} wrap="truncate">
          scope: {scopePreview}{scopeSuffix}
        </Text>
      )}
      <Text color={mutedColor()} wrap="truncate">
        task: {latestTask ? `${statusIcon(latestTask[1].status)} ${latestTask[1].title || latestTask[0]}${formatTaskStatePolicyHint(latestTask[1])}` : "(waiting)"}
      </Text>
      <Text color={mutedColor()} wrap="truncate">
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
  return <Text color={mutedColor()}>No active background work.</Text>;
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
      <Text wrap="truncate" color={mutedColor()}>
        {worker.worker_id} {agent}{worker.file_scope.length ? ` scope=${worker.file_scope.slice(0, 3).join(",")}` : ""}
      </Text>
      {!compact && <Text wrap="truncate">{worker.objective}</Text>}
      {result && <Text wrap="truncate" color={mutedColor()}>{result}</Text>}
    </Box>
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

function DetailView({ content, scroll, height, sessionId, route, source, title, density }: {
  content: string;
  scroll: number;
  height: number;
  sessionId?: string;
  route?: string;
  source?: "ai" | "command" | "task" | "event";
  title?: string;
  density?: TuiDensity;
}): React.ReactElement {
  const lines = content.split(/\r?\n/);
  const visible = lines.slice(scroll, scroll + height);
  return (
    <Box flexDirection="column" width="100%">
      <InspectorPane
        title={title ?? detailTitleForSource(source)}
        sessionId={sessionId}
        route={route ? routeDisplayLabel(route) : undefined}
        selected={`lines ${Math.min(scroll + 1, lines.length)}-${Math.min(scroll + height, lines.length)} / ${lines.length}`}
        tabs={source === "command" ? undefined : ["output", "files", "checks", "workers", "attempts", "debug"]}
        content={visible.join("\n") || " "}
        density={density}
      />
    </Box>
  );
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
  if (character === "\x03") {
    return "c";
  }
  if (character === "\x0f") {
    return "o";
  }
  if (character === "\x02") {
    return "b";
  }
  if (character === "\x06") {
    return "f";
  }
  return character.toLowerCase();
}

function tuiKeyEventForInput(
  character: string | undefined,
  key: { ctrl?: boolean; return?: boolean; escape?: boolean }
): Extract<RuntimeEvent, { type: "tui_focus" }>["key_event"] {
  const normalized = normalizeActionLogControlCharacter(character);
  if (key.return) {
    return "return";
  }
  if (key.escape) {
    return "escape";
  }
  if (key.ctrl && normalized === "o") {
    return "ctrl+o";
  }
  if (!key.ctrl && normalized === "o") {
    return "o";
  }
  if (!key.ctrl && normalized === "q") {
    return "q";
  }
  return "other";
}

function loopActivityStatus(phase: LoopActivityState["phase"]): string {
  switch (phase) {
    case "failed": return "failed";
    case "completed": return "completed";
    case "stopped": return "stopped";
    case "waiting_approval": return "awaiting approval";
    case "turn_complete": return "idle";
    default: return "running";
  }
}

function loopActivityTone(phase: LoopActivityState["phase"]): TuiTone {
  switch (phase) {
    case "failed": return "danger";
    case "completed": return "success";
    case "stopped": return "warning";
    case "waiting_approval": return "pending";
    case "turn_complete": return "muted";
    default: return "running";
  }
}

function isActiveRunBoardPhase(phase: RunBoardPhase): boolean {
  return phase === "planning"
    || phase === "working"
    || phase === "reviewing"
    || phase === "waiting-attention"
    || phase === "verifying";
}

function statusForRunBoardPhase(phase: RunBoardPhase, resultStatus?: string): string {
  if (phase === "waiting-attention") return "awaiting approval";
  if (phase === "planning" || phase === "working" || phase === "reviewing" || phase === "verifying") return "running";
  if (phase === "done") return resultStatus ?? "completed";
  if (phase === "failed") return "failed";
  return resultStatus ?? "idle";
}

function toneForRunBoardPhase(phase: RunBoardPhase, resultStatus?: string): TuiColorRef {
  if (phase === "waiting-attention") return "status.pending";
  if (phase === "planning" || phase === "working" || phase === "reviewing" || phase === "verifying") return "status.running";
  if (phase === "done") return statusTone(resultStatus ?? "completed") as TuiColorRef;
  if (phase === "failed") return "status.danger";
  return statusTone(resultStatus ?? "idle") as TuiColorRef;
}

function isCollaborationUiEnabled(): boolean {
  const value = process.env.SWARM_TUI_EXPERIMENTAL_COLLAB;
  return value !== "0" && value?.toLowerCase() !== "false" && value?.toLowerCase() !== "off";
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
  lspStatusReport?: LspStatusReport;
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
  const workBoard = input.runtime ? safeWorkspaceWorkBoard(input.runtime, 8) : undefined;
  const swarmSurface = input.runtime ? safeSwarmSurface(input.runtime, 12) : undefined;
  const lastSnapshot = input.runtime && input.lastSessionId
    ? safeWorkSnapshot(input.runtime, input.lastSessionId)
    : undefined;
  const symphony = input.symphonyStatus;
  const lspHealthStatus = lspHealthStatusFromReport(input.lspStatusReport);
  const extensionDiagnostics = extensionRuntimeDiagnostics(input.runtime);
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
    "Work Board",
    workBoard
      ? `sessions=${workBoard.summary.sessions} active=${workBoard.summary.active_sessions} workers=${workBoard.summary.workers} active_workers=${workBoard.summary.active_workers} resumable=${workBoard.summary.resumable} tasks=${workBoard.summary.tasks} claims=${workBoard.summary.claims} blocked=${workBoard.summary.blocked} failed=${workBoard.summary.failed} checks=${workBoard.summary.checks} artifacts=${workBoard.summary.artifacts}`
      : "(none)",
    ...(workBoard?.next_actions.length
      ? workBoard.next_actions.slice(0, 5).map((action) => `next=${action.severity} ${action.source}:${action.id} ${action.action}`)
      : []),
    "",
    "Shared Board",
    ...(swarmSurface
      ? [
        formatSwarmTopologySummary(swarmSurface),
        ...swarmSurface.actors.slice(0, 6).map((actor) => `${actor.actor_id} [${actor.kind}/${actor.status}/${actor.heartbeat_state}] in=${actor.mailbox.inbox_total}/${actor.mailbox.inbox_pending + actor.mailbox.inbox_failed} out=${actor.mailbox.outbox_total}/${actor.mailbox.outbox_pending + actor.mailbox.outbox_failed}${actor.current_task_id ? ` task=${actor.current_task_id}` : ""}${actor.current_worker_id ? ` worker=${actor.current_worker_id}` : ""}`),
        ...swarmSurface.ownership.slice(0, 5).map((item) => `owner=${item.kind}:${item.id} [${item.status}] agent=${item.owner ?? "-"}${item.envelope_id ? ` env=${item.envelope_id}` : ""}`),
        ...swarmSurface.conflicts.slice(0, 5).map((item) => `conflict=${item.kind}:${item.id} severity=${item.severity} ${item.summary}`)
      ]
      : ["(none)"]),
    "",
    "Run Attempts",
    ...(attempts.length
      ? attempts.map(formatRunAttemptSummary)
      : ["(none)"]),
    "",
    "Workspace Access",
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
    symphony
      ? `live_control=${symphony.live_control.status} severity=${symphony.live_control.severity}${symphony.live_control.next_action ? ` next=${symphony.live_control.next_action}` : ""}`
      : "live_control=unknown",
    activeDaemons.length
      ? `daemons=${activeDaemons.map((daemon) => `${daemon.daemon_id}:${daemon.status}:ticks=${daemon.tick_count}`).join(" ")}`
      : "daemons=(none)",
    ...(symphony?.scheduler.running.length
      ? symphony.scheduler.running.slice(0, 5).map((item) => `${item.session_id} [${item.status}] live=${item.live_control.status}/${item.live_control.severity} ${workItemLabel(item.work_item)}`)
      : []),
    "",
    formatServiceStatusSection({
      cache: input.cacheStatus,
      gatewayStatus: "local",
      mcpStatus: extensionDiagnostics.mcp?.state,
      mcpSummary: extensionDiagnostics.mcp?.reason,
      skillStatus: extensionDiagnostics.skills?.state,
      skillSummary: extensionDiagnostics.skills?.reason,
      symphonyStatus: symphonyStatusForServiceSection(symphony),
      symphonyLiveControl: symphony?.live_control,
      lspStatus: lspHealthStatus
    }),
    "",
    "Board",
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
  return status.live_control.status;
}

function extensionRuntimeDiagnostics(runtime: SwarmRuntime | undefined): {
  mcp?: ReturnType<typeof summarizeMcpCatalog>["runtime"];
  skills?: ReturnType<typeof summarizeSkillCatalog>["runtime"];
} {
  if (!runtime || typeof runtime.listMcpServers !== "function" || typeof runtime.listSkills !== "function") {
    return {};
  }
  const mcpSettings = mcpSettingsSnapshot(runtime);
  const skillSettings = skillSettingsSnapshot(runtime);
  return {
    mcp: summarizeMcpCatalog(runtime.listMcpServers(), mcpSettings).runtime,
    skills: summarizeSkillCatalog(runtime.listSkills(), skillSettings).runtime
  };
}

function footerPendingApprovalCount(
  activeApproval: ToolApprovalRequest | undefined,
  recentApprovals: readonly { status?: string }[]
): number {
  const persisted = recentApprovals.filter((approval) => approval.status === "pending").length;
  return Math.max(persisted, activeApproval ? 1 : 0);
}

function runBoardWorkerIdFromRuntimeEvent(event: RuntimeEvent): string | undefined {
  if (event.type === "worker" || event.type === "agent_run_started" || event.type === "agent_run_completed") {
    return `worker:${event.worker.worker_id}`;
  }
  if (event.type === "handoff_started" || event.type === "handoff_returned" || event.type === "handoff_taken_back") {
    return `worker:${event.handoff.worker_id}`;
  }
  if (event.type === "task" || event.type === "task_attempt") {
    return `task:${event.task_id}`;
  }
  if (event.type === "tool_result") {
    return event.agent?.worker_id ? `worker:${event.agent.worker_id}` : `task:${event.task_id}`;
  }
  if (event.type === "loop_activity" && event.agent?.worker_id) {
    return `worker:${event.agent.worker_id}`;
  }
  if (event.type === "verification_completed" && event.result.worker_id) {
    return `worker:${event.result.worker_id}`;
  }
  return undefined;
}

function eventTimestampForRunBoard(event: RuntimeEvent): string {
  if (event.type === "worker" || event.type === "agent_run_started" || event.type === "agent_run_completed") {
    return event.worker.updated_at;
  }
  if (event.type === "handoff_started" || event.type === "handoff_returned" || event.type === "handoff_taken_back") {
    return event.handoff.updated_at;
  }
  return new Date().toISOString();
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
  const summary = lspStatusSummaryFromReport(report);
  return [
    "LSP",
    `workspace=${report.workspace}`,
    `generated=${report.generatedAt}`,
    `health=${summary.health} providers=${summary.providers} ready=${summary.readyProviders} fallback=${summary.fallbackProviders} partial=${summary.partialProviders} unavailable=${summary.unavailableProviders} failed=${summary.failedProviders}`,
    `semantic_graph=${summary.semanticGraphHealth}${summary.semanticEvidenceSources.length ? ` sources=${summary.semanticEvidenceSources.join(",")}` : ""}`,
    `semantic_planning=${summary.semanticPlanningState}${summary.semanticPlanningParticipant ? ` participant=${summary.semanticPlanningParticipant}` : ""}${summary.semanticPlanningEvidenceSources.length ? ` sources=${summary.semanticPlanningEvidenceSources.join(",")}` : ""}`,
    summary.semanticPlanningDegradedReason ? `semantic_planning_reason=${summary.semanticPlanningDegradedReason}` : undefined,
    summary.semanticPlanningNextAction ? `semantic_planning_next=${summary.semanticPlanningNextAction}` : undefined,
    summary.staleReasons.length ? `stale_reasons=${summary.staleReasons.join(",")}` : undefined,
    summary.fallbackReasons.length ? `fallback_reasons=${summary.fallbackReasons.join(",")}` : undefined,
    summary.nextActions.length ? `next=${summary.nextActions.join(" | ")}` : undefined,
    "",
    ...report.providers.map((provider) => [
      `${provider.providerId} [${provider.status}] detected=${provider.detected ? "yes" : "no"} available=${provider.available ? "yes" : "no"}`,
      ...formatLspCapabilityLines(provider.capabilities),
      provider.command ? `command=${[provider.command, ...(provider.args ?? [])].join(" ")}` : undefined,
      provider.pid ? `pid=${provider.pid}` : undefined,
      provider.reason ? `reason=${provider.reason}` : undefined,
      provider.lastError ? `error=${provider.lastError}` : undefined,
      `log=${provider.logPath}`
    ].filter(Boolean).join("\n")).join("\n\n")
  ].filter(Boolean).join("\n");
}

function formatLspCapabilityLines(capabilities: LspStatusReport["providers"][number]["capabilities"]): string[] {
  if (!capabilities?.length) {
    return [];
  }
  const modes = uniqueStrings(capabilities.map((capability) => capability.mode));
  const fallbackReasons = uniqueStrings(capabilities.flatMap((capability) => capability.fallback_reason ? [capability.fallback_reason] : []));
  const nextActions = uniqueStrings(capabilities.flatMap((capability) => capability.next_action ? [capability.next_action] : [])).slice(0, 2);
  return [
    `capabilities=${capabilities.filter((capability) => capability.available).length}/${capabilities.length} modes=${modes.join(",")}`,
    fallbackReasons.length ? `fallback_reasons=${fallbackReasons.join(",")}` : undefined,
    nextActions.length ? `next=${nextActions.join(" | ")}` : undefined
  ].filter((line): line is string => Boolean(line));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function lspStatusReportSignature(report: LspStatusReport): string {
  const semanticPlanning = report.semanticPlanning
    ? [
        "semantic",
        report.semanticPlanning.state,
        report.semanticPlanning.participant_id,
        report.semanticPlanning.degraded_reason ?? "",
        report.semanticPlanning.next_action ?? "",
        ...report.semanticPlanning.providers.map((provider) => [
          provider.provider_id,
          provider.state,
          provider.reason ?? "",
          provider.next_action ?? "",
          provider.evidence_sources.join(",")
        ].join("="))
      ].join(":")
    : "semantic:none";
  return [
    semanticPlanning,
    ...report.providers
    .map((provider) => [
      provider.providerId,
      provider.status,
      provider.detected ? "detected" : "undetected",
      provider.available ? "available" : "unavailable",
      provider.pid ?? "-",
      provider.exitCode ?? "-",
      provider.signal ?? "-",
      provider.lastError ?? "",
      provider.reason ?? "",
      ...(provider.capabilities ?? []).map((capability) => [
        capability.action,
        capability.available ? "available" : "unavailable",
        capability.mode,
        capability.fallback_reason ?? "",
        capability.next_action ?? ""
      ].join("="))
    ].join(":"))
  ].join("|");
}

function routeStateFromControllerEvent(event: ControllerEvent): RouteState | undefined {
  const route = event.details?.route;
  if (typeof route !== "object" || route === null) {
    return {
      mode: canonicalRouteMode(event.action.replace(/^run_/, "")),
      reason: event.reason
    };
  }
  const value = route as Record<string, unknown>;
  const mode = canonicalRouteMode(typeof value.mode === "string" ? value.mode : event.action.replace(/^run_/, ""));
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
    `${routeDisplayLabel(route.mode)}${typeof route.confidence === "number" ? `/${Math.round(route.confidence * 100)}%` : ""}`,
    route.requiresWorkspace === undefined ? undefined : `workspace=${route.requiresWorkspace}`,
    route.needsParallelism === undefined ? undefined : `parallel=${route.needsParallelism}`,
    route.fallbackMode ? `fallback=${route.fallbackMode}` : undefined,
    `reason=${route.reason}`
  ].filter(Boolean).join(" ");
}

function canonicalRouteMode(mode: string): string {
  if (mode === "coding" || mode === "fast") {
    return "coding_loop";
  }
  if (mode === "swarm") {
    return "full_swarm";
  }
  return mode;
}

function routeDisplayLabel(mode: string): string {
  return ROUTE_LABELS[mode] ?? mode;
}

function safeWorkSnapshot(runtime: SwarmRuntime, sessionId: string): ReturnType<SwarmRuntime["getWorkSnapshot"]> | undefined {
  try {
    return runtime.getWorkSnapshot(sessionId);
  } catch {
    return undefined;
  }
}

function safeWorkspaceWorkBoard(runtime: SwarmRuntime, limit: number): ReturnType<typeof buildWorkspaceWorkBoard> | undefined {
  try {
    return buildWorkspaceWorkBoard(runtime, { limit });
  } catch {
    return undefined;
  }
}

function safeGlobalCaseWorkbench(runtime: SwarmRuntime, limit: number): ReturnType<SwarmRuntime["buildGlobalCaseWorkbench"]> | undefined {
  try {
    return runtime.buildGlobalCaseWorkbench(limit);
  } catch {
    return undefined;
  }
}

function safeCaseWorkbenchDetail(runtime: SwarmRuntime, caseId: string): CaseWorkbenchDetail | undefined {
  try {
    return runtime.getCaseWorkbenchDetail(caseId);
  } catch {
    return undefined;
  }
}

function buildTuiSwarmSurface(runtime: SwarmRuntime, limit = 30): SwarmSurfaceProjection {
  return buildSwarmSurfaceProjection({
    runtime,
    workBoard: safeWorkspaceWorkBoard(runtime, Math.min(limit, 12)),
    limit
  });
}

function safeSwarmSurface(runtime: SwarmRuntime, limit = 12): SwarmSurfaceProjection | undefined {
  try {
    return buildTuiSwarmSurface(runtime, limit);
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
    `Live Control: status=${status.live_control.status} severity=${status.live_control.severity}${status.live_control.next_action ? ` next=${status.live_control.next_action}` : ""}`,
    "",
    "Totals",
    `sessions=${status.totals.sessions} running=${status.totals.running} completed=${status.totals.completed} failed=${status.totals.failed} cancelled=${status.totals.cancelled} retrying=${status.totals.retrying}`,
    `capacity=${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent} available=${status.scheduler.capacity.available}`,
    "",
    "Running",
    ...(status.scheduler.running.length
      ? status.scheduler.running.map((item) => `${item.session_id} [${item.status}] live=${item.live_control.status}/${item.live_control.severity} ${workItemLabel(item.work_item)} workspace=${item.workspace_path || "-"}`)
      : ["(none)"]),
    "",
    "Retrying",
    ...(status.scheduler.retrying.length
      ? status.scheduler.retrying.map((item) => `${workItemLabel(item.work_item)} live=${item.live_control.status}/${item.live_control.severity} attempt=${item.attempt} due=${item.due_at}${item.error ? ` error=${item.error}` : ""}${item.live_control.next_action ? ` next=${item.live_control.next_action}` : ""}`)
      : ["(none)"]),
    "",
    "Recent Sessions",
    ...(status.sessions.length
      ? status.sessions.map((session) => `${session.session_id} [${session.status}] live=${session.live_control.status}/${session.live_control.severity} ${workItemLabel(session.work_item)}${session.runner_attempt ? ` runner=${session.runner_attempt.status}` : ""}${session.next_retry_at ? ` retry=${session.next_retry_at}` : ""}${session.live_control.next_action ? ` next=${session.live_control.next_action}` : ""}`)
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
  const settings = defaultSkillSettingsSnapshot();
  const summary = summarizeSkillCatalog(skills, settings);
  if (summary.totals.skills === 0) {
    return [
      "Skill summary",
      summary.runtime ? `${summary.runtime.label} state=${summary.runtime.state} evidence=${summary.runtime.evidence}` : undefined,
      "No skills discovered.",
      summary.runtime?.reason,
      summary.runtime?.nextAction
    ].filter(Boolean).join("\n");
  }

  return [
    "Skill summary",
    summary.runtime ? `${summary.runtime.label} state=${summary.runtime.state} evidence=${summary.runtime.evidence}` : undefined,
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
    summary.runtime?.nextAction ?? "Use /skills all for the full catalog."
  ].filter(Boolean).join("\n");
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
  const settings = defaultMcpSettingsSnapshot(servers);
  const summary = summarizeMcpCatalog(servers, settings);
  if (summary.totals.servers === 0) {
    return [
      "MCP summary",
      summary.runtime ? `${summary.runtime.label} state=${summary.runtime.state} evidence=${summary.runtime.evidence}` : undefined,
      "No MCP servers configured.",
      summary.runtime?.reason,
      summary.runtime?.nextAction
    ].filter(Boolean).join("\n");
  }

  return [
    "MCP summary",
    summary.runtime ? `${summary.runtime.label} state=${summary.runtime.state} evidence=${summary.runtime.evidence}` : undefined,
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
    summary.runtime?.nextAction ?? "Use /mcp all for the full catalog."
  ].filter(Boolean).join("\n");
}

function defaultSkillSettingsSnapshot(): ReturnType<typeof skillSettingsSnapshot> {
  return {
    enabled: true,
    load_project_skills: "trustedWorkspaces",
    configured_roots: [],
    max_skills: 100
  };
}

function defaultMcpSettingsSnapshot(servers: McpServerRecord[]): ReturnType<typeof mcpSettingsSnapshot> {
  return {
    enabled: servers.length > 0,
    expose_gateway_server: false,
    configured_servers: servers.length,
    runtime_config: "unknown"
  };
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
  const knownKinds = new Set(["local_tool", "lsp_tool", "mcp_tool", "mcp_resource", "mcp_prompt", "skill", "slash_command", "agent_spec", "plugin"]);
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

function parseProtocolTimelineFilter(tokens: string[]): ProtocolTimelineFilter {
  const filter: ProtocolTimelineFilter = {};
  const text: string[] = [];
  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator < 0) {
      if (token.trim()) text.push(token.trim());
      continue;
    }
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "actor" || key === "actor_id") {
      filter.actorId = value;
    } else if (key === "task" || key === "task_id") {
      filter.taskId = value;
    } else if (key === "corr" || key === "correlation" || key === "correlation_id") {
      filter.correlationId = value;
    } else if (key === "category" || key === "kind") {
      if (isProtocolTimelineCategory(value)) {
        filter.category = value;
      } else {
        text.push(token);
      }
    } else if (key === "text" || key === "q") {
      text.push(value);
    } else if (key === "limit") {
      const limit = Number(value);
      if (Number.isFinite(limit) && limit > 0) {
        filter.limit = Math.floor(limit);
      }
    } else {
      text.push(token);
    }
  }
  if (text.length) {
    filter.text = text.join(" ");
  }
  return filter;
}

function isProtocolTimelineCategory(value: string): value is ProtocolTimelineCategory {
  return value === "envelope" ||
    value === "ownership" ||
    value === "blackboard" ||
    value === "capability" ||
    value === "cache";
}

function formatProtocolTimelineFilter(filter: ProtocolTimelineFilter): string {
  return [
    filter.actorId ? `actor=${filter.actorId}` : undefined,
    filter.taskId ? `task=${filter.taskId}` : undefined,
    filter.correlationId ? `correlation=${filter.correlationId}` : undefined,
    filter.category ? `category=${filter.category}` : undefined,
    filter.text ? `text=${filter.text}` : undefined,
    filter.limit ? `limit=${filter.limit}` : undefined
  ].filter(Boolean).join(" ");
}

function parseSwarmWorkbenchSelection(args: string[]): { mode: SwarmSurfaceMode; actorId?: string } {
  const [rawMode, rawActor] = args;
  const mode = rawMode?.trim().toLowerCase();
  if (!mode || mode === "summary" || mode === "topology" || mode === "overview") {
    return { mode: "summary" };
  }
  if (mode === "ownership" || mode === "owners" || mode === "leases") {
    return { mode: "ownership" };
  }
  if (mode === "mailbox" || mode === "inbox" || mode === "outbox") {
    if (!rawActor?.trim()) {
      throw new Error("Usage: /swarm mailbox <actor_id>");
    }
    return { mode: "mailbox", actorId: rawActor.trim() };
  }
  if (mode === "agent" || mode === "actor" || mode === "participant") {
    if (!rawActor?.trim()) {
      throw new Error("Usage: /swarm agent <actor_id>");
    }
    return { mode: "agent", actorId: rawActor.trim() };
  }
  throw new Error("Usage: /swarm [summary|ownership|mailbox <actor_id>|agent <actor_id>]");
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

function roleColor(role: ChatMessage["role"]): TuiResolvedColor {
  if (role === "assistant") {
    return visualTokenColor("text.primary");
  }
  if (role === "system") {
    return visualTokenColor("text.muted");
  }
  return visualTokenColor("role.user");
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

function workerStatusColor(status: WorkerRecord["status"]): TuiColorRef {
  switch (status) {
    case "pending": return "status.pending";
    case "running": return "status.running";
    case "completed": return "status.success";
    case "failed": return "status.danger";
    case "stopped": return "status.warning";
  }
  return "text.primary";
}

function footerPillToneRef(tone: FooterPill["tone"]): TuiColorRef {
  if (tone === "running") return "status.running";
  if (tone === "success") return "status.success";
  if (tone === "pending") return "status.pending";
  if (tone === "warning") return "status.warning";
  if (tone === "danger") return "status.danger";
  if (tone === "muted") return "text.muted";
  return "text.primary";
}

function workbenchCommandFooterItems(): Array<{ key: string; label: string; tone?: TuiColorRef }> {
  return [
    { key: "help", label: "/help", tone: "brand.focus" },
    { key: "continue", label: "/continue", tone: "brand.focus" },
    { key: "memory", label: "/memory", tone: "brand.focus" },
    { key: "scroll", label: "PgUp/PgDn scroll", tone: "text.muted" },
    { key: "search", label: "/ search", tone: "text.muted" },
    { key: "details", label: "Ctrl+O details", tone: "text.muted" }
  ];
}

function workbenchStatusSubtitle(input: {
  executing: boolean;
  workerCount: number;
  fileCount: number;
  approvalCount: number;
  currentAction?: string;
  needYou: string;
  progress?: string;
}): string {
  const status = input.executing ? "Executing" : "Waiting";
  const base = `Run: ${status}  Workers: ${Math.max(0, input.workerCount)}  Files: ${Math.max(0, input.fileCount)}  Approvals: ${Math.max(0, input.approvalCount)}`;
  if (!input.executing) {
    return base;
  }
  return [
    base,
    input.needYou !== "no" ? `Needs you: ${input.needYou}` : undefined,
    input.progress,
    input.currentAction
  ].filter((part): part is string => Boolean(part)).join("  ");
}

function caseWorkbenchTone(item: Pick<CaseWorkbenchItem, "status" | "severity" | "workspace_path">): TuiColorRef {
  if (!item.workspace_path) return "status.warning";
  if (item.severity === "error" || item.status === "failed") return "status.danger";
  if (item.severity === "warning" || item.status === "blocked" || item.status === "review") return "status.warning";
  if (item.status === "active") return "status.running";
  if (item.status === "done") return "status.success";
  return "text.muted";
}

function caseWorkbenchSubtitle(
  detail: CaseWorkbenchDetail | undefined,
  inboxCount: number,
  fallback: string
): string {
  if (!detail) {
    return inboxCount > 0 ? `${fallback}  Inbox: ${inboxCount}` : fallback;
  }
  return [
    detail.status,
    `${detail.session_count} session${detail.session_count === 1 ? "" : "s"}`,
    `${detail.active_workers}/${detail.worker_count} active workers`,
    `${detail.pending_approvals} approvals`,
    `lease=${detail.workspace_label}`,
    inboxCount > 0 ? `inbox=${inboxCount}` : undefined
  ].filter((part): part is string => Boolean(part)).join("  ");
}

function caseLeaseStatus(detail: CaseWorkbenchDetail): string {
  if (!detail.workspace_path) {
    return "lease: none; workspace-write locked";
  }
  return `lease: ${detail.write_boundary ?? "workspace"}; ${detail.workspace_path}`;
}

function formatCaseWorkbenchRow(item: CaseWorkbenchItem): string {
  return [
    `${item.case_id} [${item.status}] ${item.title}`,
    `workspace=${item.workspace_label}`,
    `sessions=${item.session_count}`,
    `workers=${item.active_workers}/${item.worker_count}`,
    item.pending_approvals ? `approvals=${item.pending_approvals}` : undefined,
    item.failed_checks ? `failed_checks=${item.failed_checks}` : undefined,
    `next=${item.next_action}`
  ].filter((part): part is string => Boolean(part)).join(" | ");
}

function formatCaseWorkbenchDetail(detail: CaseWorkbenchDetail): string {
  return [
    `Case ${detail.case_id}`,
    `title: ${detail.title}`,
    `status: ${detail.status} severity=${detail.severity}`,
    `source: ${detail.source} owner=${detail.owner}`,
    `workspace: ${detail.workspace_path ?? "no workspace"}`,
    `write_boundary: ${detail.write_boundary ?? "none"}`,
    `next: ${detail.next_action}`,
    detail.badges.length ? `badges: ${detail.badges.join(", ")}` : undefined,
    "",
    "Sessions",
    ...(detail.sessions.length
      ? detail.sessions.map((session) => `${session.session_id} [${session.status}]${session.parent_session_id ? ` parent=${session.parent_session_id}` : ""} workspace=${session.workspace_path ?? "none"} ${session.objective}`)
      : ["(none)"]),
    "",
    "Workers",
    ...(detail.workers.length
      ? detail.workers.map((worker) => `${worker.worker_id} [${worker.status}] ${worker.display_name ?? worker.role_title ?? "worker"} ${worker.objective}${worker.blocked_reason ? ` blocker=${worker.blocked_reason}` : ""}`)
      : ["(none)"]),
    "",
    "Approvals",
    ...(detail.approvals.length
      ? detail.approvals.map((approval) => `${approval.approval_id} [${approval.status}/${approval.risk_class}] ${approval.summary}`)
      : ["(none)"]),
    "",
    "Attempts",
    ...(detail.attempts.length
      ? detail.attempts.map((attempt) => `${attempt.attempt_id} [${attempt.kind}/${attempt.status}] workspace=${attempt.workspace_path ?? "-"} ${attempt.title ?? ""}${attempt.recovery_suggestion ? ` recovery=${attempt.recovery_suggestion}` : ""}`)
      : ["(none)"]),
    "",
    "Artifacts",
    ...(detail.artifacts.length
      ? detail.artifacts.map((artifact) => `${artifact.artifact_id} ${artifact.type} ${artifact.path}${artifact.summary ? ` - ${artifact.summary}` : ""}`)
      : ["(none)"]),
    "",
    "Timeline",
    ...(detail.timeline.length ? detail.timeline : ["(none)"])
  ].filter((line): line is string => line !== undefined).join("\n");
}

function centerContentRows(rows: number, hasCurrentAction: boolean): number {
  return Math.max(1, Math.floor(rows) - (hasCurrentAction ? 3 : 0));
}

function workbenchCompletionOverlayRows(rows: number): number {
  return Math.max(1, Math.min(5, Math.floor(rows) - 1));
}

function shortAge(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return compactTimestamp(value);
  }
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) {
    return "now";
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
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
  return line ? <Text color={mutedColor()} wrap="truncate">{indentPreview(line, "  ")}</Text> : null;
}

function mutedColor(): TuiResolvedColor {
  return visualTokenColor("text.muted");
}

function pendingColor(): TuiResolvedColor {
  return visualTokenColor("status.pending");
}

function successColor(): TuiResolvedColor {
  return visualTokenColor("status.success");
}

function dangerColor(): TuiResolvedColor {
  return visualTokenColor("status.danger");
}

function selectedTextColor(): TuiResolvedColor {
  return resolveTuiColor("black");
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
