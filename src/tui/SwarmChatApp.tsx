import { randomUUID } from "node:crypto";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  addCustomProvider,
  ensureSwarmHome,
  getProviderModels,
  getSelectedModelReadiness,
  hasUsableModelConfiguration,
  loadSwarmSettings,
  setModelSelection,
  setPermissionMode,
  setProviderApiKey
} from "../config/settings.js";
import { refreshProviderModels } from "../providers/model-discovery.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import { resetDebugLogger } from "../runtime/debug-logger.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { RunMode } from "../runtime/execution-router.js";
import type { PlannedSession } from "../runtime/orchestrator.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, toolRequiresApproval } from "../tools/permissions.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import type { PermissionMode } from "../config/settings.js";
import { readTaskOutput } from "../storage/task-output-store.js";
import type { GeneratedPlan, SwarmPolicy, SwarmSession } from "../protocol/types.js";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  brief: string;
  detail?: string;
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
  const chatSessionId = useRef(createChatSessionId());
  const [approval, setApproval] = useState<ToolApprovalRequest | undefined>();
  const [runtime, setRuntime] = useState<SwarmRuntime | undefined>(() => (needsOnboarding ? undefined : createRuntime()));
  const [input, setInput] = useState("");
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
  const [runMode, setRunMode] = useState<RunMode>("auto");

  const height = stdout.rows || 32;
  const chatHeight = Math.max(10, height - 9);
  const detailHeight = Math.max(12, height - 6);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    const unsubscribe = runtime.events.onEvent((event) => {
      setEvents((previous) => [...previous.slice(-80), event]);

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
        setTaskCompleted(event.completed);
        setTaskTotal(event.total);
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
            errorCode: event.errorCode
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
        setTaskTotal(event.plan.tasks.length);
        setTaskCompleted(0);
        setTaskStates(new Map());
        setToolResults([]);
      }
    });
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  }, [runtime]);

  useInput((character, key) => {
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

    if (approval) {
      handleApprovalInput(character);
      return;
    }

    if (detailOpen) {
      handleDetailInput(key);
      return;
    }

    if (onboard.enabled) {
      handleOnboardInput(character, key);
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

    if (key.return) {
      void submitObjective();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    if (character && !key.ctrl && !key.meta) {
      setInput((value) => value + character);
    }
  });

  async function submitObjective(): Promise<void> {
    const objective = input.trim();
    if (!objective) {
      return;
    }

    setInput("");
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
    setMessages((previous) => [...previous, { role: "user", brief: objective }]);
    try {
      const result = await runtime.run(objective, { mode: runMode });
      setLatestDetail(result.content);
      setDetailScroll(0);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          brief: briefForOutput(result.content, result.outcome, result.artifact_path),
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
    setMessages((previous) => [...previous, { role: "system", brief: "Executing approved swarm plan." }]);
    try {
      const result = await runtime.execute(planned);
      setLatestDetail(result.content);
      setDetailScroll(0);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          brief: briefForOutput(result.content, result.outcome, result.artifact_path),
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
        result.outputRef ? `Full output: ${result.outputRef}` : undefined
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
    key: { return?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean }
  ): void {
    if (key.return || key.tab) {
      advanceOnboard();
      return;
    }
    if (key.backspace || key.delete) {
      setOnboard((state) => ({
        ...state,
        values: { ...state.values, [state.field]: state.values[state.field].slice(0, -1) }
      }));
      return;
    }
    if (character && !["\r", "\n"].includes(character)) {
      setOnboard((state) => ({
        ...state,
        custom: state.field === "provider" && isCustomProviderInput(state.values.provider + character),
        values: { ...state.values, [state.field]: state.values[state.field] + character },
        error: undefined
      }));
    }
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
    const [command, ...args] = commandLine.slice(1).trim().split(/\s+/).filter(Boolean);
    if (!command) {
      return;
    }

    try {
      const result = await runSlashCommand(command, args);
      setLatestDetail(result.detail ?? result.brief);
      setDetailScroll(0);
      setMessages((previous) => [...previous, { role: "system", brief: result.brief, detail: result.detail }]);
    } catch (error) {
      pushError(error);
    }
  }

  async function runSlashCommand(command: string, args: string[]): Promise<{ brief: string; detail?: string }> {
    if (command === "help") {
      const detail = [
        "/help",
        "/provider [id]",
        "/model",
        "/model <model>",
        "/model planner|worker|aggregator <provider/model>",
        "/models [provider]",
        "/refresh-models [provider]",
        "/permissions",
        "/permission-mode [ask|auto-edit|full-auto]",
        "/mode [auto|fast|swarm|chat]",
        "/read <path> [start:end]",
        "/grep <pattern> [root]",
        "/glob <pattern> [root]",
        "/shell <command>",
        "/session",
        "/session <session_id>",
        "/session new",
        "/resume <session_id>",
        "/trace <session_id>",
        "/tasks",
        "/tasks <session_id>",
        "/output <task_id>",
        "/status",
        "/interrupt <message>",
        "/onboard"
      ].join("\n");
      return { brief: "Slash commands: /provider /model /mode /read /grep /glob /shell /session /tasks /trace", detail };
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
        if (runtime) {
          runtime.dispose();
          setRuntime(createRuntime());
        }
        return { brief: "Started a new chat state." };
      }
      if (args[0]) {
        if (!runtime) throw new Error("Runtime is not ready.");
        const row = runtime.sessionStore.get(args[0]);
        if (!row) throw new Error(`Unknown session: ${args[0]}`);
        const tasks = runtime.taskStateStore.list(row.session_id);
        const trace = runtime.traceStore.list(row.session_id);
        const detail = [
          `${row.session_id} [${row.status}]`,
          row.objective,
          "",
          `Tasks: ${tasks.length}`,
          ...tasks.map((task) => `${task.task_id} [${task.status}] #${task.attempt} ${task.title}${task.last_error ? ` - ${task.last_error}` : ""}`),
          "",
          `Trace envelopes: ${trace.length}`,
          ...trace.slice(-20).map((env) => `${env.created_at} ${env.type} ${env.task_id ?? ""} ${env.intent}`)
        ].join("\n");
        return { brief: `${row.session_id}: ${row.status}. Ctrl+O for details.`, detail };
      }
      const rows = runtime?.sessionStore.listRecent(10) ?? [];
      const detail = rows.length
        ? rows.map((row) => `${row.session_id} [${row.status}] ${row.updated_at} ${row.objective}`).join("\n")
        : "No sessions yet.";
      return { brief: `${rows.length} recent sessions. Ctrl+O for details.`, detail };
    }

    if (command === "resume") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const sessionId = args[0];
      if (!sessionId) throw new Error("Usage: /resume <session_id>");
      const row = runtime.sessionStore.get(sessionId);
      if (!row?.plan_json) throw new Error(`Session has no stored plan: ${sessionId}`);
      const session = sessionFromRow(row);
      const plan = JSON.parse(row.plan_json) as GeneratedPlan;
      setBusy(true);
      setMessages((previous) => [...previous, { role: "system", brief: `Resuming ${sessionId}.` }]);
      void runtime.execute({ session, plan }).then((result) => {
        setLatestDetail(result.content);
        setMessages((previous) => [...previous, { role: "assistant", brief: briefForOutput(result.content, result.outcome, result.artifact_path), detail: result.content }]);
      }).catch((error: unknown) => {
        pushError(error);
      }).finally(() => setBusy(false));
      return { brief: `Resume started for ${sessionId}.` };
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

    if (command === "output") {
      const taskId = args[0];
      if (!taskId) {
        const detail = toolResults.length
          ? toolResults
              .map((result) => `${result.task_id}${result.attempt ? `#${result.attempt}` : ""} ${result.action} [${result.status ?? "unknown"}]: ${result.summary}${result.outputRef ? ` -> ${result.outputRef}` : ""}`)
              .join("\n")
          : "No tool outputs in this chat.";
        return { brief: `${toolResults.length} tool outputs. Ctrl+O for details.`, detail };
      }
      const result = [...toolResults].reverse().find((item) => item.task_id === taskId);
      if (!result) {
        throw new Error(`No output found for task: ${taskId}`);
      }
      const detail = result.outputRef ? await readTaskOutput(result.outputRef) : result.content ?? result.summary;
      return {
        brief: `${result.action}: ${result.summary}. Ctrl+O for details.`,
        detail
      };
    }

    if (command === "status") {
      const detail = [
        `busy=${busy}`,
        `mode=${runMode}`,
        `tasks=${taskCompleted}/${taskTotal}`,
        `tools=${toolResults.length}`,
        "",
        "Recent events:",
        ...events.slice(-20).map(formatEvent)
      ].join("\n");
      return { brief: `Swarm status: ${busy ? "running" : "idle"}, mode=${runMode}. Ctrl+O for details.`, detail };
    }

    if (command === "interrupt") {
      if (!runtime) throw new Error("Runtime is not ready.");
      const message = args.join(" ").trim() || "User requested an interrupt. Reassess before continuing.";
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
        throw new Error("Usage: /permission-mode ask|auto-edit|full-auto");
      }
      setPermissionMode(mode);
      return { brief: `Permission mode set to ${mode}.` };
    }

    if (command === "mode") {
      const mode = args[0];
      if (!mode) {
        return { brief: `Execution mode: ${runMode}.` };
      }
      const normalized = normalizeRunMode(mode);
      setRunMode(normalized);
      return { brief: `Execution mode set to ${normalized}.` };
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
      const shellCommand = args.join(" ");
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

    throw new Error(`Unknown command: /${command}. Try /help.`);
  }

  async function executeSlashTool(inputs: Record<string, unknown>): Promise<{ brief: string; detail?: string }> {
    const settings = loadSwarmSettings();
    const action = normalizeToolAction(inputs);
    if (toolRequiresApproval(action, settings)) {
      const approved = await requestToolApproval(createToolApprovalRequest(action));
      if (!approved) {
        throw new Error(`Tool action denied: ${action.type}`);
      }
    }
    const result = await runLocalTool(action, { workspace: process.cwd(), settings: loadSwarmSettings() });
    return {
      brief: `${result.summary}. Ctrl+O for details.`,
      detail: renderToolResultDetail(result)
    };
  }

  function createRuntime(): SwarmRuntime {
    return new SwarmRuntime({ approvalHandler: requestToolApproval, debugSessionId: chatSessionId.current });
  }

  function requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
    approvalResolver.current?.(false);
    return new Promise((resolve) => {
      approvalResolver.current = resolve;
      setApproval(request);
    });
  }

  function handleApprovalInput(character: string): void {
    const value = character.toLowerCase();
    if (value !== "y" && value !== "n") {
      return;
    }
    const approved = value === "y";
    approvalResolver.current?.(approved);
    approvalResolver.current = undefined;
    setApproval(undefined);
  }

  if (approval) {
    return <ApprovalView request={approval} />;
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
          {"  Ctrl+O details"}
          {"  Ctrl+T tasks"}
        </Text>
      </Box>

      <Box flexDirection="row" marginTop={1} height={chatHeight}>
        <Box flexDirection="column" width="68%" paddingRight={1}>
          <Box borderStyle="round" flexDirection="column" paddingX={1} height={chatHeight}>
            {busy ? (
              <>
                <Text color="yellow" bold>Tasks</Text>
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
                      <Text key={`${tr.task_id}-${i}`} wrap="truncate" color="gray">
                        [{tr.status ?? "unknown"}{tr.errorCode ? `/${tr.errorCode}` : ""}] {tr.summary}{tr.outputRef ? " (full output saved)" : ""}
                      </Text>
                    ))}
                  </>
                )}
              </>
            ) : (
              messages.slice(-8).map((message, index) => (
                <Box key={`${message.role}-${index}`} flexDirection="column" marginBottom={1}>
                  <Text color={roleColor(message.role)}>{message.role}</Text>
                  <Text wrap="truncate">{message.brief}</Text>
                </Box>
              ))
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
                {formatEvent(event)}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="single" paddingX={1}>
        <Text color={pendingPlan ? "yellow" : "green"}>
          {pendingPlan ? "Approve plan with y, cancel with n" : "> "}
        </Text>
        {!pendingPlan && <Text>{input}</Text>}
      </Box>
    </Box>
  );
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

function ApprovalView({ request }: { request: ToolApprovalRequest }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" paddingX={1}>
        <Text color="yellow">Swarm Approval</Text>
        <Text color="gray">  y approve  n deny</Text>
      </Box>
      <Box borderStyle="round" flexDirection="column" paddingX={1} marginTop={1}>
        <Text color={request.risk === "shell" ? "red" : "yellow"}>{request.summary}</Text>
        {request.detail.split(/\r?\n/).map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
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

function currentModelBrief(settings: ReturnType<typeof loadSwarmSettings>): string {
  const planner = settings.models.planner || "not set";
  const worker = settings.models.worker || "not set";
  const aggregator = settings.models.aggregator || "not set";
  return `planner=${planner} worker=${worker} aggregator=${aggregator}`;
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
  return value === "ask" || value === "auto-edit" || value === "full-auto";
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

function formatEvent(event: RuntimeEvent): string {
  switch (event.type) {
    case "task":
      return `${statusIcon(event.status)} ${event.status}: ${event.title || event.task_id}`;
    case "task_attempt":
      return `${statusIcon(event.status)} attempt ${event.attempt}: ${event.title || event.task_id}`;
    case "tool_result":
      return `  tool: ${event.action} [${event.status ?? "unknown"}] - ${event.summary.slice(0, 60)}`;
    case "progress":
      return `progress: ${event.completed}/${event.total}`;
    case "envelope":
      return `${event.envelope.type} ${event.envelope.task_id ?? ""}`.trim();
    case "blackboard":
      return `bb: ${event.entry.key}`;
    case "agent":
      return `agent: ${event.card.agent_id} [${event.card.status}]`;
    case "approval":
      return `approval: ${event.status} ${event.request.action}`;
    case "live_message":
      return `live: ${event.status} ${event.content.slice(0, 60)}`;
    case "control":
      return `control: ${event.action} - ${event.reason.slice(0, 60)}`;
    case "controller":
      return `controller: ${event.action} - ${event.reason.slice(0, 60)}`;
    case "queue":
      return `queue: ${event.operation} ${event.priority ?? ""} size=${event.size}`;
    case "plan":
      return `plan: ${event.session_id}`;
    case "final":
      return `final: ${event.outcome?.changed_files.length ?? 0} changed`;
    case "log":
      return `${event.level}: ${event.message}`;
    case "error":
      return `ERROR: ${event.message}`;
  }
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
