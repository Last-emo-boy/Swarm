import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  addCustomProvider,
  ensureSwarmHome,
  getProviderModels,
  getSelectedModelReadiness,
  getSwarmPaths,
  hasUsableModelConfiguration,
  loadSwarmConfig,
  loadSwarmSettings,
  setModelSelection,
  setPermissionMode,
  setProviderApiKey
} from "../config/settings.js";
import { refreshProviderModels } from "../providers/model-discovery.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import { resetDebugLogger } from "../runtime/debug-logger.js";
import type { RuntimeEvent } from "../runtime/events.js";
import { formatRuntimeEventBrief, formatWhyReport, formatWorkerBrief, formatWorkerDetail } from "../runtime/event-formatters.js";
import type { RunMode } from "../runtime/execution-router.js";
import type { ExecutionResult, PlannedSession } from "../runtime/orchestrator.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, toolRequiresApproval } from "../tools/permissions.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";
import type { PermissionMode } from "../config/settings.js";
import { readTaskOutput, writeTaskOutput } from "../storage/task-output-store.js";
import type { BlackboardEntry, GeneratedPlan, RunAttempt, SwarmPolicy, SwarmSession, WorkItem, WorkspaceLease } from "../protocol/types.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import { runLocalEvals } from "../evals/local-evals.js";
import { getSymphonyStatus, type SymphonyStatus } from "../symphony/status.js";
import { cleanupSymphonyWorkspaces, type SymphonyCleanupResult } from "../symphony/cleanup.js";
import { SymphonyDaemonManager, type SymphonyDaemonRecord } from "../symphony/daemon.js";
import { runSymphonyTick, type SymphonyTickResult } from "../symphony/scheduler.js";
import { workItemLabel } from "../symphony/work-item.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowLoadResult } from "../symphony/workflow.js";
import { runSymphonyPreflight } from "../symphony/preflight.js";
import { createWorkSourceFromConfig } from "../symphony/work-source.js";
import { mainPaneLabels, mainPaneOrder, nextMainPane, type MainPaneId } from "./main-panes.js";
import {
  commandOutputPreview,
  formatToolOutputPreview,
  indentPreview,
  parseSlashCommandLine,
  rawSlashArgsAfter,
  renderSlashHelp
} from "./slash-commands.js";
import { ChatInputArea } from "./ChatInputArea.js";
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
import { appendTuiLoopActivity, appendTuiRuntimeEvent, sameRuntimeEventDisplay } from "./tui-event-buffer.js";
import type { CapabilityDescriptor } from "../extensions/types.js";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  brief: string;
  detail?: string;
  preview?: string;
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

type TaskState = {
  title: string;
  status: string;
  attempt?: number;
};

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

type RecentSessionRow = ReturnType<SwarmRuntime["sessionStore"]["listRecent"]>[number];
type ApprovalStoreRecord = ReturnType<SwarmRuntime["approvalStore"]["list"]>[number];

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

function createChatSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `chat-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function SwarmChatApp({ forceOnboarding = false }: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const settings = useMemo(() => {
    ensureSwarmHome();
    return loadSwarmSettings();
  }, []);
  const needsOnboarding = forceOnboarding || !hasUsableModelConfiguration(settings);
  const approvalResolver = useRef<((approved: boolean) => void) | undefined>();
  const sessionApprovalAllow = useRef<Set<string>>(new Set());
  const chatSessionId = useRef(createChatSessionId());
  const symphonyDaemonManager = useRef<SymphonyDaemonManager | undefined>();
  const [approval, setApproval] = useState<ToolApprovalRequest | undefined>();
  const [runtime, setRuntime] = useState<SwarmRuntime | undefined>(() => (needsOnboarding ? undefined : createRuntime()));
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "system", brief: needsOnboarding ? "Provider setup required." : "Swarm chat ready. Enter an objective." }
  ]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [pendingPlan, setPendingPlan] = useState<PlannedSession | undefined>();
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailScroll, setDetailScroll] = useState(0);
  const [latestDetail, setLatestDetail] = useState("");
  const [onboard, setOnboard] = useState<OnboardState>(() => createOnboardState(needsOnboarding));
  const [taskStates, setTaskStates] = useState<Map<string, TaskState>>(new Map());
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskCompleted, setTaskCompleted] = useState(0);
  const [toolResults, setToolResults] = useState<ToolResultState[]>([]);
  const [loopActivity, setLoopActivity] = useState<LoopActivityState | undefined>();
  const [loopActivityTimeline, setLoopActivityTimeline] = useState<LoopActivityState[]>([]);
  const [workers, setWorkers] = useState<Map<string, WorkerRecord>>(new Map());
  const [handoffs, setHandoffs] = useState<Map<string, HandoffSessionRecord>>(new Map());
  const [symphonyDaemons, setSymphonyDaemons] = useState<SymphonyDaemonRecord[]>([]);
  const [lastSessionId, setLastSessionId] = useState<string | undefined>();
  const [lastRoute, setLastRoute] = useState<RouteState | undefined>();
  const [runMode, setRunMode] = useState<RunMode>("auto");
  const [mainPane, setMainPane] = useState<MainPaneId>("overview");
  const [idlePaneSnapshot, setIdlePaneSnapshot] = useState<IdlePaneSnapshot>(() => emptyIdlePaneSnapshot());
  const idlePaneSnapshotSignatureRef = useRef(idlePaneSnapshotSignature(idlePaneSnapshot));
  const [completionRows, setCompletionRows] = useState(0);
  const symphonyDaemonRecordsSignatureRef = useRef(symphonyDaemonRecordsSignature(symphonyDaemons));
  const chatInputState = useRef<ChatInputControllerState>(createChatInputControllerState());

  const terminalRows = stdout.rows || 32;
  // Keep live output below the terminal height; Ink clears the terminal when outputHeight >= rows.
  const reservedRows = 7 + completionRows;
  const chatHeight = Math.max(4, terminalRows - reservedRows);
  const detailHeight = Math.max(12, terminalRows - 6);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    symphonyDaemonManager.current = new SymphonyDaemonManager(runtime);
    const unsubscribe = runtime.events.onEvent((event) => {
      setEvents((previous) => appendTuiRuntimeEvent(previous, event));

      if (event.type === "task") {
        setTaskStates((prev) => {
          const next = new Map(prev);
          const existing = next.get(event.task_id);
          next.set(event.task_id, { title: event.title, status: event.status, attempt: existing?.attempt });
          return next;
        });
      }
      if (event.type === "task_attempt") {
        setTaskStates((prev) => {
          const next = new Map(prev);
          const existing = next.get(event.task_id);
          next.set(event.task_id, { title: event.title, status: event.status, attempt: event.attempt });
          return next;
        });
      }
      if (event.type === "progress") {
        setTaskCompleted((previous) => previous === event.completed ? previous : event.completed);
        setTaskTotal((previous) => previous === event.total ? previous : event.total);
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
            recoverySuggestion: event.recoverySuggestion
          }
        ]);
        if (event.content) {
          setLatestDetail(event.content);
          setDetailScroll(0);
        } else if (event.outputRef) {
          setLatestDetail(`Full output: ${event.outputRef}`);
          setDetailScroll(0);
        }
      }
      if (event.type === "plan") {
        setLastSessionId(event.session_id);
        setTaskTotal(event.plan.tasks.length);
        setTaskCompleted(0);
        setTaskStates(new Map());
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
    refreshIdlePaneSnapshot(readIdlePaneSnapshot(runtime));
  }, [runtime, mainPane, messages.length, toolResults.length, lastSessionId]);

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
        runtime.interrupt("User pressed Ctrl+C. Stop unstarted work and reassess the current objective before continuing.");
        setMessages((previous) => [...previous, { role: "system", brief: "Interrupt requested. Swarm will reassess at the next safe boundary." }]);
        return;
      }
      exit();
      return;
    }

    if (key.ctrl && character === "o") {
      setDetailOpen((value) => !value);
      return;
    }

    if (key.ctrl && character === "t") {
      setLatestDetail(renderTaskDetail());
      setDetailScroll(0);
      setDetailOpen(true);
      return;
    }

    if (!busy && pendingPlan) {
      if (character.toLowerCase() === "y") {
        void executePendingPlan();
        return;
      }
      if (character.toLowerCase() === "n") {
        setMessages((previous) => [...previous, { role: "system", brief: "Plan cancelled." }]);
        setPendingPlan(undefined);
        return;
      }
    }

    if (key.ctrl && character === "n") {
      setMainPane((value) => nextMainPane(value, 1));
      return;
    }

    if (key.ctrl && character === "p") {
      setMainPane((value) => nextMainPane(value, -1));
      return;
    }

    // Normal text editing is owned by ChatInputArea so typing does not re-render this dashboard.
  });

  async function submitObjective(objective: string): Promise<void> {
    objective = objective.trim();
    if (!objective) {
      return;
    }

    if (objective.startsWith("/")) {
      await handleSlashCommand(objective);
      return;
    }

    if (!runtime) {
      setOnboard(createOnboardState(true));
      return;
    }

    if (busy) {
      setMessages((previous) => [...previous, { role: "user", brief: objective }]);
      await runtime.sendUserMessage(objective).catch(pushError);
      return;
    }

    setBusy(true);
    setLoopActivity(undefined);
    setLoopActivityTimeline([]);
    setMessages((previous) => [...previous, { role: "user", brief: objective }]);
    try {
      const result = await runtime.run(objective, { mode: runMode });
      setLatestDetail(result.content);
      setDetailScroll(0);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          brief: briefForExecutionResult(result),
          detail: result.content
        }
      ]);
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
    setMessages((previous) => [...previous, { role: "system", brief: "Executing approved swarm plan." }]);
    try {
      const result = await runtime.execute(planned);
      setLatestDetail(result.content);
      setDetailScroll(0);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          brief: briefForExecutionResult(result),
          detail: result.content
        }
      ]);
    } catch (error) {
      pushError(error);
    } finally {
      setBusy(false);
      setTaskStates(new Map());
      setTaskTotal(0);
      setTaskCompleted(0);
      setToolResults([]);
      setLoopActivity(undefined);
      setLoopActivityTimeline([]);
    }
  }

  function pushError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    setLatestDetail(message);
    setMessages((previous) => [...previous, { role: "system", brief: message, detail: message }]);
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
        setRuntime(createRuntime());
        setMessages([{ role: "system", brief: message }]);
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
      const result = await runSlashCommand(parsed.command, parsed.args, parsed);
      setLatestDetail(result.detail ?? result.brief);
      setDetailScroll(0);
      setMessages((previous) => [
        ...previous,
        {
          role: "system",
          brief: result.brief,
          detail: result.detail,
          preview: commandOutputPreview(result.detail, 6, 700)
        }
      ]);
    } catch (error) {
      pushError(error);
    }
  }

  async function runSlashCommand(command: string, args: string[], parsed?: ReturnType<typeof parseSlashCommandLine>): Promise<{ brief: string; detail?: string }> {
    if (command === "help") {
      const detail = renderSlashHelp();
      return { brief: "Slash commands grouped by Core, Kernel, Symphony, Agents, Tools, and Config. Ctrl+O for details.", detail };
    }

    if (command === "onboard") {
      setOnboard(createOnboardState(true));
      return { brief: "Opening onboarding." };
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
        return { brief: `${role} model set to ${model}.` };
      }
      if (!args[0].includes("/") && !settings.models.defaultProvider) {
        throw new Error("No default provider selected. Use /provider <id> first or pass <provider/model>.");
      }
      const modelRef = args[0].includes("/") ? args[0] : `${settings.models.defaultProvider}/${args[0]}`;
      setModelSelection({ planner: modelRef, worker: modelRef, aggregator: modelRef });
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
      if (result.error) {
        return { brief: `${providerId}: model discovery failed. Ctrl+O for details.`, detail: result.error };
      }
      return { brief: `${providerId}: discovered ${result.models.length} models.`, detail: result.models.join("\n") };
    }

    if (command === "symphony") {
      if (!runtime) throw new Error("Runtime is not ready.");
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
        setLatestDetail("");
        setTaskStates(new Map());
        setTaskTotal(0);
        setTaskCompleted(0);
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
      const rows = runtime?.sessionStore.listRecent(10) ?? [];
      const detail = rows.length
        ? rows.map((row) => `${row.session_id} [${row.status}] ${row.updated_at} ${row.objective}`).join("\n")
        : "No sessions yet.";
      return { brief: `${rows.length} recent sessions. Ctrl+O for details.`, detail };
    }

    if (command === "resume" || command === "continue") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const target = parseResumeTarget(runtime, lastSessionId, parsed, args, command);
      const sessionId = target.sessionId;
      if (!sessionId) throw new Error(command === "continue" ? "Usage: /continue [message]" : "Usage: /resume [session_id] [message]");
      const row = runtime.sessionStore.get(sessionId);
      if (!row) throw new Error(`Unknown session: ${sessionId}`);
      const instruction = target.instruction;
      setBusy(true);
      setLoopActivity(undefined);
      setLoopActivityTimeline([]);
      setMessages((previous) => [...previous, { role: "system", brief: `Resuming ${sessionId}.` }]);
      const runPromise = row.plan_json
        ? runtime.execute({ session: sessionFromRow(row), plan: JSON.parse(row.plan_json) as GeneratedPlan })
        : runtime.executeWorkSession({
            session_id: sessionId,
            prompt: buildResumePrompt(runtime, sessionId, instruction)
          });
      void runPromise.then((result) => {
        setLatestDetail(result.content);
        setLastSessionId(result.session_id);
        setMessages((previous) => [...previous, { role: "assistant", brief: briefForExecutionResult(result), detail: result.content }]);
      }).catch((error: unknown) => {
        pushError(error);
      }).finally(() => setBusy(false));
      return { brief: `${command === "continue" ? "Continue" : "Resume"} started for ${sessionId}${row.plan_json ? " from stored plan" : " through local coding loop"}.` };
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
        : runtime.runAttemptStore.listRecent(50);
      const detail = rows.length
        ? rows.map(formatRunAttempt).join("\n\n")
        : sessionId
          ? `No run attempts recorded for ${sessionId}.`
          : "No run attempts recorded.";
      return {
        brief: `${rows.length} attempts${sessionId ? ` for ${sessionId}` : " across recent sessions"}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "leases") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const target = args[0] ?? lastSessionId;
      const rows = target
        ? leaseRowsForTarget(runtime, target)
        : runtime.workspaceLeaseStore.listRecent(50);
      const detail = rows.length
        ? rows.map(formatWorkspaceLease).join("\n\n")
        : target
          ? `No workspace leases recorded for ${target}.`
          : "No workspace leases recorded.";
      return {
        brief: `${rows.length} workspace leases${target ? ` for ${target}` : " across recent sessions"}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "span") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const id = args[0];
      if (!id) throw new Error("Usage: /span <trace_id|span_id>");
      const sessions = runtime.sessionStore.listRecent(50);
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
      const rows = runtime.approvalStore.list(sessionId, 80);
      const detail = rows.length ? rows.map(formatApprovalRecord).join("\n\n") : "No approvals recorded.";
      return { brief: `${rows.length} approvals${sessionId ? ` for ${sessionId}` : ""}. Ctrl+O for details.`, detail };
    }

    if (command === "approval") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const approvalId = args[0];
      if (!approvalId) throw new Error("Usage: /approval <approval_id>");
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
            ? `${toolResults.length} tool outputs. Latest: ${latest.action} ${latest.summary}. Ctrl+O for full list.`
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
        brief: `${result.action}: ${result.summary}. Ctrl+O for details.`,
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
      const filter = parseCapabilityCommandFilter(args);
      const [capabilities, providers] = await Promise.all([
        runtime.listCapabilities(filter),
        runtime.listCapabilityProviders()
      ]);
      const detail = formatCapabilities(capabilities, providers);
      return {
        brief: `${capabilities.length} capabilities across ${providers.length} providers. Ctrl+O for details.`,
        detail
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
      const rows = runtime.workerStateStore.listRecent(30);
      const detail = rows.length
        ? rows.map(formatWorkerBrief).join("\n")
        : "No persisted workers yet.";
      return { brief: `${rows.length} workers. Ctrl+O for details.`, detail };
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
      const rows = runtime.listHandoffs(30);
      const detail = rows.length
        ? rows.map(formatHandoff).join("\n\n")
        : "No handoff sessions yet.";
      return { brief: `${rows.length} handoffs. Ctrl+O for details.`, detail };
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
      return { brief: "Recent route, delegation, worker, review, and verification decisions. Ctrl+O for details.", detail };
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
      return { brief: review.summary, detail };
    }

    if (command === "improve-self") {
      if (!runtime) throw new Error("Runtime is not ready.");
      setBusy(true);
      try {
        const result = await runtime.improveSelf();
        setLatestDetail(result.content);
        setLastSessionId(result.session_id);
        return { brief: briefForExecutionResult(result), detail: result.content };
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
      return { brief: `${results.length - failed.length}/${results.length} evals passed. Ctrl+O for details.`, detail };
    }

    if (command === "prd") {
      const path = resolve(process.cwd(), "docs/PRD.md");
      const detail = readFileSync(path, "utf8");
      return { brief: "Swarm PRD loaded. Ctrl+O for details.", detail };
    }

    if (command === "doctor") {
      const detail = await formatDoctorReport(runtime, args[0]);
      const failed = detail.split(/\r?\n/).filter((line) => line.startsWith("FAIL ")).length;
      const warnings = detail.split(/\r?\n/).filter((line) => line.startsWith("WARN ")).length;
      return {
        brief: `Doctor: ${failed} failed, ${warnings} warnings. Ctrl+O for details.`,
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
        events
      });
      const sessionCount = runtime?.sessionStore.listRecent(100).length ?? 0;
      return {
        brief: `Kernel: ${busy ? "running" : "idle"}, sessions=${sessionCount}, workers=${workers.size}, symphony=${activeDaemons}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "interrupt") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const message = parsed?.rawArgs || args.join(" ").trim() || "User requested an interrupt. Reassess before continuing.";
      runtime.interrupt(message);
      return { brief: "Interrupt requested. Swarm will reassess at the next safe boundary." };
    }

    if (command === "permissions") {
      const settings = loadSwarmSettings();
      const detail = JSON.stringify(settings.permissions, null, 2);
      return { brief: `Permission mode: ${settings.permissions.defaultMode}. Ctrl+O for details.`, detail };
    }

    if (command === "permission-mode") {
      const mode = args[0];
      if (!mode) {
        const settings = loadSwarmSettings();
        return { brief: `Permission mode: ${settings.permissions.defaultMode}.` };
      }
      if (!isPermissionMode(mode)) {
        throw new Error("Usage: /permission-mode ask|auto-edit|full-auto|yolo");
      }
      setPermissionMode(mode);
      return { brief: `Permission mode set to ${mode}.` };
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

    throw new Error(`Unknown command: /${command}. Try /help.`);
  }

  async function executeSlashTool(inputs: Record<string, unknown>): Promise<{ brief: string; detail?: string }> {
    runtime?.ensureTuiChatSession(chatSessionId.current);
    const settings = loadSwarmSettings();
    const action = normalizeToolAction(inputs);
    if (toolRequiresApproval(action, settings, { workspace: process.cwd() })) {
      const request = createToolApprovalRequest(action);
      request.session_id = chatSessionId.current;
      request.task_id = `slash.${action.type}`;
      runtime?.events.emitEvent({ type: "approval", request, status: "pending" });
      const approved = await requestToolApproval(request);
      runtime?.events.emitEvent({ type: "approval", request, status: approved ? "approved" : "denied" });
      if (!approved) {
        throw new Error(`Tool action denied: ${action.type}`);
      }
    }
    const provider = new OpenAIProvider();
    const result = await runLocalTool(action, {
      workspace: process.cwd(),
      settings: loadSwarmSettings(),
      sessionId: chatSessionId.current,
      taskId: `slash.${action.type}`,
      serverWebSearch: (searchAction) => provider.webSearch(searchAction)
    }).catch((error: unknown) => slashToolFailureResult(action.type, error));
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
      recoverySuggestion: result.recoverySuggestion
    });
    if (result.status === "failed") {
      setLatestDetail(prepared.detail);
      setDetailScroll(0);
    }
    return {
      brief: `${result.summary}${result.recoverySuggestion ? ` Recovery: ${result.recoverySuggestion}` : ""}${prepared.outputRef ? " (full output saved)" : ""}. Ctrl+O for details.`,
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
    if (sessionApprovalAllow.current.has(approvalSessionRuleKey(request))) {
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
      sessionApprovalAllow.current.add(approvalSessionRuleKey(approval));
    }
    approvalResolver.current?.(decision.approved);
    approvalResolver.current = undefined;
    setApproval(undefined);
  }

  if (detailOpen) {
    return <DetailView content={latestDetail || "No detail output yet."} scroll={detailScroll} height={detailHeight} />;
  }

  if (onboard.enabled) {
    return <OnboardView state={onboard} />;
  }

  const recentEvents = events.slice(-12);
  const agents = events
    .filter((event): event is Extract<RuntimeEvent, { type: "agent" }> => event.type === "agent")
    .slice(-8);
  const activeSymphonyDaemons = symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping").length;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan">Swarm</Text>
        <Text color="gray">
          {"  "}
          {busy
            ? ` running [${taskCompleted}/${taskTotal}]`
            : pendingPlan
              ? " awaiting approval"
              : " idle"}
          {`  mode:${runMode}`}
          {lastRoute ? `->${lastRoute.mode}${typeof lastRoute.confidence === "number" ? `:${Math.round(lastRoute.confidence * 100)}%` : ""}` : ""}
          {activeSymphonyDaemons ? `  symphony:${activeSymphonyDaemons}` : ""}
          {`  pane:${mainPaneLabels[mainPane]}`}
          {"  /kernel status"}
          {"  Ctrl+O details"}
          {"  Ctrl+T tasks"}
          {"  Ctrl+N/P panes"}
        </Text>
      </Box>

      <Box flexDirection="row" marginTop={1} height={chatHeight}>
        <Box flexDirection="column" width="68%" paddingRight={1}>
          <Box borderStyle="round" flexDirection="column" paddingX={1} height={chatHeight}>
            {busy ? (
              <>
                <Text color="yellow" bold>Tasks</Text>
                <Text color={loopActivity ? loopActivityColor(loopActivity.phase) : "cyan"} wrap="truncate">
                  {loopActivity ? loopActivity.message : "Starting local coding loop..."}
                </Text>
                {loopActivityTimeline.length > 1 && (
                  <>
                    <Text color="yellow" bold>Activity</Text>
                    {loopActivityTimeline.slice(0, -1).slice(-4).map((activity, index) => (
                      <Text key={`${activity.phase}-${activity.turn ?? 0}-${activity.task_id ?? ""}-${index}`} color={loopActivityColor(activity.phase)} wrap="truncate">
                        {formatLoopActivityLine(activity)}
                      </Text>
                    ))}
                  </>
                )}
                {[...taskStates.entries()].slice(-10).map(([id, state]) => (
                  <Text key={id} wrap="truncate">{statusIcon(state.status)} {state.attempt ? `#${state.attempt} ` : ""}{state.title || id}</Text>
                ))}
                {taskStates.size === 0 && <Text color="gray">Waiting for tasks to start...</Text>}
                {toolResults.length > 0 && (
                  <>
                    <Box marginTop={1}>
                      <Text color="yellow" bold>Recent tool outputs</Text>
                    </Box>
                    {toolResults.slice(-5).map((tr, i) => (
                      <Box key={`${tr.task_id}-${i}`} flexDirection="column">
                        <Text wrap="truncate" color="gray">
                          [{tr.status ?? "unknown"}{tr.errorCode ? `/${tr.errorCode}` : ""}] {tr.summary}{tr.outputRef ? " (full output saved)" : ""}
                        </Text>
                        {tr.recoverySuggestion && (
                          <Text color="yellow" wrap="truncate">  Recovery: {tr.recoverySuggestion}</Text>
                        )}
                        {commandOutputPreview(tr.content, 2, 260) && (
                          <Text color="gray" wrap="truncate">{indentPreview(commandOutputPreview(tr.content, 2, 260) ?? "", "  ")}</Text>
                        )}
                      </Box>
                    ))}
                  </>
                )}
              </>
            ) : (
              <IdleKernelView
                pane={mainPane}
                messages={messages.slice(-4)}
                toolOutputs={toolResults.slice(-4)}
                sessions={idlePaneSnapshot.sessions}
                attempts={idlePaneSnapshot.attempts}
                leases={idlePaneSnapshot.leases}
                approvals={idlePaneSnapshot.approvals}
                blackboard={idlePaneSnapshot.blackboard}
                symphonyDaemons={symphonyDaemons.slice(0, 4)}
                lastSessionId={lastSessionId}
                lastRoute={lastRoute}
              />
            )}
          </Box>
        </Box>

        <Box flexDirection="column" width="32%">
          <Box borderStyle="round" flexDirection="column" paddingX={1} height={Math.floor(chatHeight / 2)}>
            <Text color="yellow">Agents</Text>
            {agents.map((event) => (
              <Text key={`${event.card.agent_id}-${event.card.status}`}>
                {event.card.agent_id} [{event.card.status}] {event.card.load.running_tasks}/{event.card.load.max_tasks}
              </Text>
            ))}
          </Box>
          <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1} height={Math.ceil(chatHeight / 2) - 1}>
            <Text color="yellow">Trace</Text>
            {recentEvents.map((event, index) => (
              <Text key={index} color={event.type === "error" ? "red" : undefined}>
                {formatRuntimeEventBrief(event)}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>

      {approval ? (
        <ApprovalView request={approval} />
      ) : pendingPlan ? (
        <Box marginTop={1} borderStyle="single" paddingX={1}>
          <Text color="yellow">Approve plan with y, cancel with n</Text>
        </Box>
      ) : (
        <ChatInputArea
          onSubmit={submitObjective}
          onCompletionRowsChange={setCompletionRows}
          controllerStateRef={chatInputState}
        />
      )}
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
  const readiness = getSelectedModelReadiness();
  const visibleFields = state.custom || isCustomProviderInput(state.values.provider) ? customFieldOrder : fieldOrder;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan">Swarm Onboarding</Text>
        <Text color="gray">  Enter/Tab next. Use a provider id, custom-openai:id, or custom-claude:id.</Text>
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
        {readiness.map((item, index) => (
          <Text key={`${item.modelRef}:${index}`} color={item.configured ? "green" : "yellow"}>
            {item.modelRef}: {item.configured ? "configured" : item.reason}
          </Text>
        ))}
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
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
  messages: ChatMessage[];
  toolOutputs: ToolResultState[];
  sessions: RecentSessionRow[];
  attempts: RunAttempt[];
  leases: WorkspaceLease[];
  approvals: ApprovalStoreRecord[];
  blackboard: BlackboardEntry[];
  symphonyDaemons: SymphonyDaemonRecord[];
  lastSessionId?: string;
  lastRoute?: RouteState;
}): React.ReactElement {
  const activeDaemons = input.symphonyDaemons.filter((daemon) => daemon.status === "running" || daemon.status === "stopping");
  return (
    <>
      <Text color="yellow" bold>{mainPaneLabels[input.pane]}</Text>
      <Text color="gray">
        {`Ctrl+N/P switch  ${mainPaneOrder.map((pane) => pane === input.pane ? `[${mainPaneLabels[pane]}]` : mainPaneLabels[pane]).join(" ")}`}
      </Text>
      {input.pane === "overview" && <IdleOverviewPane input={input} activeDaemons={activeDaemons} />}
      {input.pane === "output" && <IdleOutputPane outputs={input.toolOutputs} />}
      {input.pane === "sessions" && <IdleSessionsPane sessions={input.sessions} leases={input.leases} lastSessionId={input.lastSessionId} />}
      {input.pane === "attempts" && <IdleAttemptsPane attempts={input.attempts} />}
      {input.pane === "agents" && <IdleAgentsPane approvals={input.approvals} daemons={activeDaemons} />}
      {input.pane === "blackboard" && <IdleBlackboardPane blackboard={input.blackboard} messages={input.messages} />}
    </>
  );
}

function IdleOverviewPane({ input, activeDaemons }: {
  input: Parameters<typeof IdleKernelView>[0];
  activeDaemons: SymphonyDaemonRecord[];
}): React.ReactElement {
  return (
    <>
      <Box marginTop={1}>
        <Text color="yellow">Status</Text>
      </Box>
      <Text color="gray">
        {`sessions=${input.sessions.length} attempts=${input.attempts.length} outputs=${input.toolOutputs.length} approvals=${input.approvals.length} symphony=${activeDaemons.length} last=${input.lastSessionId ?? "-"}`}
      </Text>
      {input.lastRoute && (
        <Text color="cyan" wrap="truncate">
          latest route={input.lastRoute.mode}{typeof input.lastRoute.confidence === "number" ? ` ${Math.round(input.lastRoute.confidence * 100)}%` : ""} - {input.lastRoute.reason}
        </Text>
      )}

      {(input.approvals.length > 0 || activeDaemons.length > 0) && (
        <>
          <Box marginTop={1}>
            <Text color="yellow">Attention</Text>
          </Box>
          {input.approvals.slice(0, 2).map((approval) => (
            <Text key={approval.approval_id} wrap="truncate" color="yellow">
              approval {approval.risk_class}/{approval.risk} {approval.action} {approval.target}
            </Text>
          ))}
          {activeDaemons.slice(0, 2).map((daemon) => (
            <Text key={daemon.daemon_id} wrap="truncate" color="cyan">
              symphony {daemon.daemon_id} [{daemon.status}] ticks={daemon.tick_count} next={daemon.next_tick_at ?? "-"}
            </Text>
          ))}
        </>
      )}

      <Box marginTop={1}>
        <Text color="yellow">Recent Messages</Text>
      </Box>
      {input.messages.length ? input.messages.slice(-3).map((message, index) => (
        <Box key={`${message.role}-${index}`} flexDirection="column">
          <Text wrap="truncate" color={roleColor(message.role)}>
            {message.role}: {message.brief}
          </Text>
          {message.preview && (
            <Text color="gray" wrap="truncate">{indentPreview(commandOutputPreview(message.preview, 2, 300) ?? message.preview, "  ")}</Text>
          )}
        </Box>
      )) : <Text color="gray">(none)</Text>}

      {input.toolOutputs.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text color="yellow">Latest Output</Text>
          </Box>
          {input.toolOutputs.slice(-1).map((result, index) => {
            const preview = commandOutputPreview(result.content, 2, 320);
            return (
              <Box key={`${result.task_id}-${index}`} flexDirection="column">
                <Text wrap="truncate">{statusIcon(result.status ?? "completed")} {result.action} {result.summary}{result.outputRef ? " (full output saved)" : ""}</Text>
                {result.recoverySuggestion && <Text color="yellow" wrap="truncate">  Recovery: {result.recoverySuggestion}</Text>}
                {preview && <Text color="gray" wrap="truncate">{indentPreview(preview, "  ")}</Text>}
              </Box>
            );
          })}
        </>
      )}
    </>
  );
}

function IdleOutputPane({ outputs }: { outputs: ToolResultState[] }): React.ReactElement {
  return (
    <>
      <Box marginTop={1}>
        <Text color="yellow">Command Output</Text>
      </Box>
      {outputs.length ? outputs.slice(-4).map((result, index) => {
        const preview = commandOutputPreview(result.content, 4, 520);
        return (
          <Box key={`${result.task_id}-${result.attempt ?? 0}-${index}`} flexDirection="column">
            <Text wrap="truncate">
              {statusIcon(result.status ?? "completed")} {result.action} {result.summary}{result.outputRef ? " (full output saved)" : ""}
            </Text>
            {result.recoverySuggestion && <Text color="yellow" wrap="truncate">  Recovery: {result.recoverySuggestion}</Text>}
            {result.outputRef && <Text color="gray" wrap="truncate">  Full output: {result.outputRef}</Text>}
            {preview && <Text color="gray" wrap="truncate">{indentPreview(preview, "  ")}</Text>}
          </Box>
        );
      }) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleSessionsPane({ sessions, leases, lastSessionId }: {
  sessions: RecentSessionRow[];
  leases: WorkspaceLease[];
  lastSessionId?: string;
}): React.ReactElement {
  return (
    <>
      <Box marginTop={1}>
        <Text color="yellow">Recent Sessions</Text>
      </Box>
      {lastSessionId && <Text color="gray">last={lastSessionId}</Text>}
      {sessions.length ? sessions.slice(0, 6).map((session) => (
        <Text key={session.session_id} wrap="truncate">
          {statusIcon(session.status)} {session.session_id} [{session.status}] {session.objective}
        </Text>
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="yellow">Workspace Leases</Text>
      </Box>
      {leases.length ? leases.slice(0, 4).map((lease) => (
        <Text key={lease.lease_id} wrap="truncate" color={lease.write_boundary === "read_only" ? "yellow" : undefined}>
          {lease.session_id} [{lease.write_boundary}] {lease.workspace_path}
        </Text>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleAttemptsPane({ attempts }: { attempts: RunAttempt[] }): React.ReactElement {
  return (
    <>
      <Box marginTop={1}>
        <Text color="yellow">Recent Attempts</Text>
      </Box>
      {attempts.length ? attempts.slice(0, 8).map((attempt) => (
        <Box key={attempt.attempt_id} flexDirection="column">
          <Text wrap="truncate">
            {statusIcon(attempt.status)} {attempt.kind} {attempt.task_id ?? attempt.runner_id ?? "-"} [{attempt.status}] {attempt.title ?? attempt.session_id}
          </Text>
          {attempt.recovery_suggestion && <Text color="yellow" wrap="truncate">  Recovery: {attempt.recovery_suggestion}</Text>}
        </Box>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleAgentsPane({ approvals, daemons }: {
  approvals: ApprovalStoreRecord[];
  daemons: SymphonyDaemonRecord[];
}): React.ReactElement {
  return (
    <>
      <Box marginTop={1}>
        <Text color="yellow">Approvals</Text>
      </Box>
      {approvals.length ? approvals.slice(0, 6).map((approval) => (
        <Text key={approval.approval_id} wrap="truncate" color={approval.status === "pending" ? "yellow" : undefined}>
          {approval.approval_id} [{approval.status}] {approval.risk_class}/{approval.risk} {approval.action} {approval.target}
        </Text>
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="yellow">Symphony Daemons</Text>
      </Box>
      {daemons.length ? daemons.slice(0, 6).map((daemon) => (
        <Text key={daemon.daemon_id} wrap="truncate" color="cyan">
          {daemon.daemon_id} [{daemon.status}] ticks={daemon.tick_count} next={daemon.next_tick_at ?? "-"}
        </Text>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function IdleBlackboardPane({ blackboard, messages }: {
  blackboard: BlackboardEntry[];
  messages: ChatMessage[];
}): React.ReactElement {
  return (
    <>
      <Box marginTop={1}>
        <Text color="yellow">Blackboard</Text>
      </Box>
      {blackboard.length ? blackboard.slice(0, 6).map((entry) => (
        <Text key={entry.entry_id} wrap="truncate" color="gray">
          {entry.key} [{entry.type}] {entry.session_id}
        </Text>
      )) : <Text color="gray">(none)</Text>}

      <Box marginTop={1}>
        <Text color="yellow">Recent Messages</Text>
      </Box>
      {messages.length ? messages.map((message, index) => (
        <Text key={`${message.role}-${index}`} wrap="truncate" color={roleColor(message.role)}>
          {message.role}: {message.brief}
        </Text>
      )) : <Text color="gray">(none)</Text>}
    </>
  );
}

function ApprovalView({ request }: { request: ToolApprovalRequest }): React.ReactElement {
  const detailLines = request.detail.split(/\r?\n/).filter((line) => line.trim()).slice(0, 5);
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
      <Text color="yellow">Approval required  y/a allow once  s allow session  n/d deny</Text>
      <Box flexDirection="column">
        <Text color={request.risk === "shell" || request.risk_class === "r4" ? "red" : "yellow"}>
          {request.summary} [{request.risk_class}/{request.risk}]
        </Text>
        <Text wrap="truncate">Target: {request.target}</Text>
        <Text wrap="truncate">Why now: {request.why_now}</Text>
        <Text wrap="truncate">Impact: {request.predicted_impact}</Text>
        <Text wrap="truncate">Rollback: {request.rollback_plan}</Text>
        {detailLines.map((line, index) => (
          <Text key={index} wrap="truncate">{line}</Text>
        ))}
        {request.summary_diff && (
          <Box flexDirection="column">
            <Text color="yellow">Diff</Text>
            {request.summary_diff.split(/\r?\n/).slice(0, 8).map((line, index) => (
              <Text key={`diff-${index}`} wrap="truncate">{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function approvalSessionRuleKey(request: ToolApprovalRequest): string {
  return `${request.action}\0${request.target}`;
}

function DetailView({ content, scroll, height }: { content: string; scroll: number; height: number }): React.ReactElement {
  const lines = content.split(/\r?\n/);
  const visible = lines.slice(scroll, scroll + height);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan">Detail</Text>
        <Text color="gray">
          {"  "}
          Ctrl+O back  lines {Math.min(scroll + 1, lines.length)}-{Math.min(scroll + height, lines.length)} / {lines.length}
        </Text>
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} height={height + 2}>
        {visible.map((line, index) => (
          <Text key={index} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
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

function sessionFromRow(row: {
  session_id: string;
  swarm_id: string;
  objective: string;
  status: SwarmSession["status"];
  policy_json: string;
  participants_json: string;
  created_at: string;
  updated_at: string;
}): SwarmSession {
  return {
    swarm_id: row.swarm_id,
    session_id: row.session_id,
    user_request_id: row.session_id,
    objective: row.objective,
    status: row.status,
    coordinator: { agent_id: "orchestrator", role: "coordinator" },
    participants: JSON.parse(row.participants_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    policy: JSON.parse(row.policy_json) as SwarmPolicy
  };
}

function briefForOutput(
  content: string,
  outcome?: { changed_files: string[]; tests_run: string[]; intermediate_artifacts: string[] },
  artifactPath?: string
): string {
  const lines = content.split(/\r?\n/);
  const first = lines.find((line) => line.trim())?.replace(/^#+\s*/, "").trim() ?? "Swarm output";
  const bytes = Buffer.byteLength(content, "utf8");
  const changed = outcome?.changed_files.length ?? 0;
  const tests = outcome?.tests_run.length ?? 0;
  const artifact = artifactPath ? ` Artifact: ${artifactPath}.` : "";
  return `${first} ... ${lines.length} lines, ${bytes} bytes. Changed files: ${changed}. Checks: ${tests}.${artifact} Ctrl+O for details.`;
}

function briefForExecutionResult(result: Pick<ExecutionResult, "content" | "outcome" | "artifact_path" | "status">): string {
  const brief = briefForOutput(result.content, result.outcome, result.artifact_path);
  if (result.status === "failed") {
    return `Failed: ${brief}`;
  }
  if (result.status === "stopped") {
    return `Stopped: ${brief}`;
  }
  return brief;
}

function formatLoopActivityLine(activity: LoopActivityState): string {
  const turn = activity.turn ? `#${activity.turn} ` : "";
  const tool = activity.tool ? `${activity.tool} ` : "";
  return `${turn}${activity.phase}: ${tool}${activity.message}`;
}

function loopActivityColor(phase: LoopActivityState["phase"]): string {
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
  const paths = getSwarmPaths();
  const settings = loadSwarmSettings();
  const config = loadSwarmConfig();
  const readiness = getSelectedModelReadiness(settings, config);
  const workflow = loadWorkflow(workflowPath);
  const lines: string[] = [
    "Swarm Doctor",
    `cwd=${process.cwd()}`,
    `home=${paths.home}`,
    `database=${settings.runtime.databasePath}`,
    "",
    "Models",
    ...readiness.map((item) => `${item.configured ? "OK" : "FAIL"} ${item.modelRef} provider=${item.providerId || "-"}${item.reason ? ` - ${item.reason}` : ""}`),
    "",
    "Permissions",
    `mode=${settings.permissions.defaultMode} allow=${settings.permissions.allow.length} ask=${settings.permissions.ask.length} deny=${settings.permissions.deny.length}`,
    settings.permissions.defaultMode === "yolo" ? "WARN yolo mode disables approval prompts." : "OK approval policy configured.",
    "",
    "Kernel Stores"
  ];

  if (!runtime) {
    lines.push("FAIL runtime is not ready.");
  } else {
    const sessions = runtime.sessionStore.listRecent(20);
    const attempts = runtime.runAttemptStore.listRecent(20);
    const leases = runtime.workspaceLeaseStore.listRecent(20);
    const approvals = runtime.approvalStore.list(undefined, 20);
    const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
    const workers = runtime.workerStateStore.listRecent(20);
    const handoffs = runtime.listHandoffs(20);
    const blackboard = runtime.blackboardStore.listRecent(20);
    lines.push(
      `OK sessions=${sessions.length} attempts=${attempts.length} leases=${leases.length} workers=${workers.length} handoffs=${handoffs.length}`,
      `${pendingApprovals.length ? "WARN" : "OK"} pending_approvals=${pendingApprovals.length} approvals=${approvals.length}`,
      `OK blackboard_entries=${blackboard.length}`,
      `OK symphony_daemons=${runtime ? "available" : "unavailable"}`
    );
  }

  lines.push("", "Symphony");
  if (!workflow.ok) {
    lines.push(`WARN ${workflow.error.code}: ${workflow.error.message}`);
    return lines.join("\n");
  }

  const workflowConfig = normalizeWorkflowConfig(workflow.workflow);
  const source = createWorkSourceFromConfig(workflowConfig);
  let active: WorkItem[] = [];
  let terminal: WorkItem[] = [];
  let sourceError: string | undefined;
  try {
    [active, terminal] = await Promise.all([
      source.fetchCandidateItems(),
      source.listTerminalItems()
    ]);
  } catch (error) {
    sourceError = error instanceof Error ? error.message : String(error);
  }
  lines.push(
    `OK workflow=${workflow.workflow.path}`,
    `${sourceError ? "FAIL" : "OK"} work_source=${source.kind} path=${workflowConfig.work_source.path ?? "WORK_ITEMS.md"} active=${active.length} terminal=${terminal.length}${sourceError ? ` - ${sourceError}` : ""}`,
    `OK workspace_root=${workflowConfig.workspace.root}`,
    `OK max_concurrent_agents=${workflowConfig.agent.max_concurrent_agents}`
  );

  if (runtime) {
    const preflight = runSymphonyPreflight({
      runtime,
      workflow: workflow.workflow,
      config: workflowConfig,
      candidates: active
    });
    lines.push(`${preflight.ok ? "OK" : "FAIL"} preflight issues=${preflight.issues.length}`);
    for (const issue of preflight.issues) {
      lines.push(`${issue.severity === "error" ? "FAIL" : "WARN"} ${issue.code}${issue.field ? ` ${issue.field}` : ""}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

function formatKernelStatusView(input: {
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
  events: RuntimeEvent[];
}): string {
  const sessions = input.runtime?.sessionStore.listRecent(8) ?? [];
  const attempts = input.runtime?.runAttemptStore.listRecent(12) ?? [];
  const leases = input.runtime?.workspaceLeaseStore.listRecent(8) ?? [];
  const persistedWorkers = input.runtime?.workerStateStore.listRecent(8) ?? [];
  const approvals = input.runtime?.approvalStore.list(undefined, 8) ?? [];
  const persistedHandoffs = input.runtime?.listHandoffs(8) ?? [];
  const recentBlackboard = input.runtime?.blackboardStore.listRecent(8) ?? [];
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
      ? [...input.taskStates.entries()].slice(-10).map(([id, state]) => `${statusIcon(state.status)} ${id} [${state.status}]${state.attempt ? ` #${state.attempt}` : ""} ${state.title}`)
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
    "Blackboard",
    ...(recentBlackboard.length
      ? recentBlackboard.map((entry) => `${entry.created_at} ${entry.session_id} ${entry.key} [${entry.type}] tags=${(entry.tags ?? []).join(",")}`)
      : ["(none)"]),
    "",
    "Recent Events",
    ...(input.events.length ? input.events.slice(-20).map(formatRuntimeEventBrief) : ["(none)"])
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

function compactWorkSnapshotLines(snapshot: ReturnType<SwarmRuntime["getWorkSnapshot"]>): string[] {
  return [
    `${snapshot.session.session_id} [${snapshot.session.status}] source=${snapshot.session.source?.source ?? "unknown"}`,
    `workspace=${snapshot.workspace?.workspace_path ?? "-"} boundary=${snapshot.workspace?.write_boundary ?? "-"}`,
    `attempts=${snapshot.attempts.length} tasks=${snapshot.graph.tasks.length} workers=${snapshot.workers.length} changes=${snapshot.changed_files.length} checks=${snapshot.checks.length}`,
    snapshot.review ? `review=${snapshot.review.verdict} score=${snapshot.review.score} ${snapshot.review.summary}` : "review=(none)",
    `usage=${JSON.stringify(snapshot.usage_summary)}`
  ];
}

function formatWorkSnapshot(snapshot: ReturnType<SwarmRuntime["getWorkSnapshot"]>): string {
  return [
    `${snapshot.session.session_id} [${snapshot.session.status}]`,
    `source=${snapshot.session.source?.source ?? "unknown"}${snapshot.session.parent_session_id ? ` parent=${snapshot.session.parent_session_id}` : ""}`,
    snapshot.session.objective,
    "",
    "Workspace",
    snapshot.workspace ? `${snapshot.workspace.workspace_path} boundary=${snapshot.workspace.write_boundary}` : "(none)",
    "",
    `Attempts: ${snapshot.attempts.length}`,
    ...(snapshot.attempts.length
      ? snapshot.attempts.map(formatRunAttemptSummary)
      : ["(none)"]),
    "",
    `Tasks: ${snapshot.graph.tasks.length}`,
    ...(snapshot.graph.tasks.length
      ? snapshot.graph.tasks.map((task) => `${task.task_id} [${task.status}] #${task.attempt} deps=${task.dependencies.join(",") || "-"} ${task.title}${task.last_error ? ` - ${task.last_error}` : ""}`)
      : ["(none)"]),
    "",
    `Workers: ${snapshot.workers.length}`,
    ...(snapshot.workers.length
      ? snapshot.workers.map((worker) => formatWorkerBrief(worker as Parameters<typeof formatWorkerBrief>[0]))
      : ["(none)"]),
    "",
    `Changes: ${snapshot.changed_files.length}`,
    ...(snapshot.changed_files.length ? snapshot.changed_files : ["(none)"]),
    "",
    `Verification: ${snapshot.checks.length}`,
    ...(snapshot.checks.length ? snapshot.checks : ["(none)"]),
    "",
    `Review: ${snapshot.review ? `${snapshot.review.verdict} ${snapshot.review.score} - ${snapshot.review.summary}` : "(none)"}`,
    "",
    "Blackboard",
    JSON.stringify(snapshot.blackboard_counts, null, 2),
    "",
    "Usage",
    JSON.stringify(snapshot.usage_summary, null, 2),
    "",
    `Final: ${snapshot.final_outcome?.final_summary ?? "(none)"}`
  ].join("\n");
}

function buildResumePrompt(runtime: SwarmRuntime, sessionId: string, instruction: string): string {
  const snapshot = runtime.getWorkSnapshot(sessionId);
  const replay = runtime.replaySession(sessionId);
  return [
    `Continue the previous local Swarm WorkSession ${sessionId}.`,
    "",
    `Original objective: ${snapshot.session.objective}`,
    instruction ? `Newest user instruction: ${instruction}` : "Newest user instruction: continue from the previous session state.",
    "",
    "Use this Work Kernel snapshot as context. Do not repeat completed work unless needed. Inspect the workspace before editing.",
    "",
    replay.slice(0, 12_000)
  ].join("\n");
}

function parseResumeTarget(
  runtime: SwarmRuntime,
  lastSessionId: string | undefined,
  parsed: ReturnType<typeof parseSlashCommandLine>,
  args: string[],
  command: "resume" | "continue"
): { sessionId?: string; instruction: string } {
  const latestSessionId = lastSessionId ?? runtime.sessionStore.listRecent(1)[0]?.session_id;
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

function formatCapabilities(
  capabilities: CapabilityDescriptor[],
  providers: Array<{ providerId: string; title: string; capabilities: number; diagnostics: Array<{ severity: string; message: string; code?: string }> }>
): string {
  const providerLines = providers.map((provider) => {
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

function formatApprovalRecord(approval: ReturnType<SwarmRuntime["approvalStore"]["list"]>[number]): string {
  return [
    `${approval.approval_id} [${approval.status}] ${approval.risk_class}/${approval.risk}`,
    `session=${approval.session_id ?? "-"} task=${approval.task_id ?? "-"}`,
    `action=${approval.action} target=${approval.target}`,
    approval.summary,
    `why=${approval.challenge.why_now}`,
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
  return {
    action: action as ToolResult["action"],
    status: "failed",
    summary: message,
    content: `ERROR: ${message}`,
    errors: [message],
    errorCode,
    retryable: errorCode !== "INVALID_INPUT" && errorCode !== "PERMISSION_DENIED",
    recoverable: true,
    recoverySuggestion: slashToolRecoverySuggestion(action, errorCode, message),
    metadata: { action, error: message }
  };
}

function slashToolErrorCode(error: unknown, message: string): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "ENOENT") return "FS_NOT_FOUND";
    if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
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

function statusIcon(status: string): string {
  switch (status) {
    case "assigned": return "->";
    case "running": return "..";
    case "started": return "..";
    case "completed": return "OK";
    case "failed": return "!!";
    default: return "-";
  }
}
