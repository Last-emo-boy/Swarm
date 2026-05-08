import { createHash, randomUUID } from "node:crypto";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, toolRequiresApproval } from "../tools/permissions.js";
import type { AgentDelegateAction, FileLockEvent, LocalToolContext, ToolAction, ToolApprovalRequest, ToolResult, WorkspaceChangeMetadata } from "../tools/types.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import { ToolContentReplacementStore } from "../storage/tool-content-replacement-store.js";
import { OpenAIProvider, type PromptBlock } from "../providers/openai-provider.js";
import type { SwarmSettings } from "../config/settings.js";
import { RuntimeEvents, type SessionOutcome } from "./events.js";
import type { ExecutionResult, ToolApprovalHandler } from "./orchestrator.js";
import { WorkerStateStore } from "../storage/worker-state-store.js";
import { listAgentSpecs, type AgentInvocationRequest, type AgentSpecSource } from "./agent-specs.js";
import { delegatedToolStatus, workerStatusFromExecutionStatus } from "./execution-status.js";
import { SKILL_ACTIVATE_CAPABILITY_ID, SKILL_ACTIVATE_TOOL_NAME } from "../extensions/skills.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import { renderHostEnvironmentPrompt } from "./host-context.js";
import { applyToolResultBudget, createContentReplacementState, type ContentReplacementState } from "./tool-result-budget.js";

type CodingLoopToolCall = {
  id?: string;
  action?: string;
  inputs?: Record<string, unknown>;
  reason?: string;
};

type CodingLoopModelResult = {
  status: "continue" | "completed" | "failed";
  message: string;
  summary: string;
  tool_calls: CodingLoopToolCall[];
  files_touched: string[];
  next_actions: string[];
};

type CodingLoopToolResult = {
  id: string;
  action: ToolAction["type"] | string;
  status: "success" | "partial" | "failed";
  summary: string;
  content?: string;
  outputRef?: string;
  data?: unknown;
  errors?: string[];
  errorCode?: string;
  recoverySuggestion?: string;
};

export type CodingLoopFinalStatusInput = {
  stopRequested: boolean;
  modelStatus: CodingLoopModelResult["status"];
  toolResults: Array<Pick<CodingLoopToolResult, "status" | "summary">>;
  content: string;
  budgetExhausted?: boolean;
  unresolvedFailure?: boolean;
};

export type ToolFailureRecoveryStateInput = {
  toolResults: Array<{ status: "success" | "partial" | "failed"; summary: string }>;
  finalText?: string;
};

export type CodingLoopFinalStatus = {
  status: ExecutionResult["status"];
  summary: string;
};

type LoopActivityPhase = Extract<Parameters<RuntimeEvents["emitEvent"]>[0], { type: "loop_activity" }>["phase"];

export function finalActivityPhase(finalStatus: CodingLoopFinalStatus): LoopActivityPhase {
  if (finalStatus.status === "stopped") {
    return "stopped";
  }
  if (finalStatus.status === "failed") {
    return "failed";
  }
  return "completed";
}

export function finalActivityMessage(finalStatus: CodingLoopFinalStatus, stopReason?: string): string {
  if (finalStatus.status === "stopped") {
    return `Stopped: ${stopReason || finalStatus.summary}`;
  }
  if (finalStatus.status === "failed") {
    return `Failed: ${finalStatus.summary}`;
  }
  return `Completed: ${finalStatus.summary}`;
}

type LiveUserMessage = {
  id: string;
  seq: number;
  content: string;
  createdAt: string;
};

type ControlDecision = {
  message_id: string;
  action: "continue_current" | "inject_next_turn" | "interrupt_and_redirect" | "ask_clarification";
  reason: string;
  instruction: string;
};

type CodingLoopOptions = {
  workspace: string;
  settings: SwarmSettings;
  provider: OpenAIProvider;
  events: RuntimeEvents;
  approvalHandler?: ToolApprovalHandler;
  role?: "main" | "worker";
  parentSessionId?: string;
  delegateDepth?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  sessionId?: string;
  sessionObjective?: string;
  emitFinal?: boolean;
  emitProgress?: boolean;
  workerId?: string;
  workerStore?: WorkerStateStore;
  toolReplacementStore?: ToolContentReplacementStore;
  initialContentReplacementState?: ContentReplacementState;
  invokeAgent?: (request: AgentInvocationRequest) => Promise<ToolResult>;
  listModelCapabilities?: () => Promise<CapabilityDescriptor[]>;
  invokeCapability?: (
    capabilityId: string,
    args: Record<string, unknown>,
    sessionId?: string,
    options?: {
      taskId?: string;
      title?: string;
      allowDelegate?: boolean;
      source?: "coding_loop" | "gateway" | "runtime";
    }
  ) => Promise<ToolResult>;
  durableContext?: (sessionId: string) => string | Promise<string>;
  agentInstructions?: string;
  allowedTools?: string[];
  writePolicy?: "read_only" | "scoped_write" | "workspace_write";
  onWorkspaceChange?: (change: WorkspaceChangeMetadata) => void;
  onFileLock?: (event: FileLockEvent) => void;
  onSessionStart?: (sessionId: string, objective: string) => void;
};

const MAX_LOOP_TURNS = 12;
const MAX_TOOL_CALLS = 50;
const MAX_DELEGATE_DEPTH = 1;
const TOOL_RESULT_FULL_HISTORY_LIMIT = 6;
const TOOL_RESULT_SUMMARY_PREVIEW_BYTES = 1_500;
const TOOL_RESULT_PERSIST_PREVIEW_BYTES = 2_000;
const TOOL_RESULT_PERSIST_THRESHOLD_BYTES = 8_000;
const TOOL_RESULT_PER_TURN_BUDGET_BYTES = 24_000;
const TOOL_RESULT_FRESH_BUDGET_BYTES = 8_000;
const MODEL_OUTPUT_TOKENS_MAIN_LOOP = 8_000;
const MODEL_OUTPUT_TOKENS_WORKER_LOOP = 6_000;
const MODEL_OUTPUT_TOKENS_CONTROL = 1_200;
const MODEL_OUTPUT_TOKENS_REPAIR = 1_500;
const ACTIVITY_PREVIEW_LENGTH = 80;
const DEFAULT_TOOL_NAMES = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "ProcessStart",
  "ProcessStatus",
  "ProcessList",
  "ProcessTail",
  "ProcessGrep",
  "ProcessStop",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "BlackboardWrite",
  "BlackboardSearch",
  "BlackboardRead",
  "BlackboardList"
] as const;

export class CodingAgentLoop {
  private readonly liveMessages: LiveUserMessage[] = [];
  private readonly controlDecisions: ControlDecision[] = [];
  private nextLiveSeq = 1;
  private sessionId = "";
  private currentPhase = "idle";
  private lastResultSummary = "";
  private interruptRequested = false;
  private stopRequested = false;
  private stopReason = "";

  constructor(private readonly options: CodingLoopOptions) {}

  async submitUserMessage(content: string): Promise<ControlDecision> {
    const message: LiveUserMessage = {
      id: `live_${randomUUID()}`,
      seq: this.nextLiveSeq,
      content,
      createdAt: new Date().toISOString()
    };
    this.nextLiveSeq += 1;
    this.liveMessages.push(message);
    this.options.events.emitEvent({ type: "live_message", id: message.id, session_id: this.sessionId || undefined, content, status: "received" });
    this.options.events.emitEvent({ type: "live_message", id: message.id, session_id: this.sessionId || undefined, content, status: "processing" });
    const decision = await this.decideControl(message).catch((error: unknown): ControlDecision => ({
      message_id: message.id,
      action: "inject_next_turn",
      reason: `Control decision failed: ${error instanceof Error ? error.message : String(error)}`,
      instruction: content
    }));
    this.controlDecisions.push(decision);
    if (decision.action === "interrupt_and_redirect" || decision.action === "ask_clarification") {
      this.interruptRequested = true;
    }
    this.options.events.emitEvent({ type: "control", ...decision });
    this.options.events.emitEvent({ type: "live_message", id: message.id, session_id: this.sessionId || undefined, content, status: "applied" });
    return decision;
  }

  requestInterrupt(instruction: string): void {
    const message: LiveUserMessage = {
      id: `live_${randomUUID()}`,
      seq: this.nextLiveSeq,
      content: instruction,
      createdAt: new Date().toISOString()
    };
    this.nextLiveSeq += 1;
    this.liveMessages.push(message);
    const decision: ControlDecision = {
      message_id: message.id,
      action: "interrupt_and_redirect",
      reason: "Explicit user interrupt.",
      instruction
    };
    this.controlDecisions.push(decision);
    this.interruptRequested = true;
    this.options.events.emitEvent({ type: "live_message", id: message.id, session_id: this.sessionId || undefined, content: instruction, status: "applied" });
    this.options.events.emitEvent({ type: "control", ...decision });
  }

  requestStop(reason: string): void {
    this.stopRequested = true;
    this.stopReason = reason;
    this.requestInterrupt(reason);
  }

  isSession(sessionId: string): boolean {
    return this.sessionId === sessionId || this.options.sessionId === sessionId;
  }

  async run(objective: string): Promise<ExecutionResult> {
    const role = this.options.role ?? "main";
    const maxTurns = this.options.maxTurns ?? MAX_LOOP_TURNS;
    const maxToolCalls = this.options.maxToolCalls ?? MAX_TOOL_CALLS;
    const sessionId = this.options.sessionId ?? (role === "worker" ? `worker_loop_${randomUUID()}` : `loop_${randomUUID()}`);
    this.sessionId = sessionId;
    this.options.onSessionStart?.(sessionId, this.options.sessionObjective ?? objective);
    const toolResults: CodingLoopToolResult[] = [];
    const replacementState = this.options.initialContentReplacementState
      ?? createContentReplacementState({
        sessionId,
        scopeKind: role === "worker" ? "worker" : "session",
        scopeId: role === "worker" ? this.options.workerId ?? sessionId : sessionId,
        records: this.options.toolReplacementStore?.listForScope(
          role === "worker" ? "worker" : "session",
          role === "worker" ? this.options.workerId ?? sessionId : sessionId
        )
      });
    const changedFiles = new Set<string>();
    const testsRun = new Set<string>();
    const intermediateArtifacts = new Set<string>();
    let toolCallCount = 0;
    let lastResult: CodingLoopModelResult = {
      status: "continue",
      message: "",
      summary: "Starting coding loop",
      tool_calls: [],
      files_touched: [],
      next_actions: []
    };

    this.options.events.emitEvent({ type: "log", level: "info", message: `${role === "worker" ? "Worker" : "Coding"} loop started: ${sessionId}` });
    if (this.options.emitProgress !== false) {
      this.options.events.emitEvent({ type: "progress", completed: 0, total: maxTurns });
    }

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (this.isStopRequested()) {
        lastResult = {
          status: "failed",
          summary: this.stopReason || "Worker stopped by main Swarm",
          message: this.stopReason || "Worker stopped before completion.",
          tool_calls: [],
          files_touched: [],
          next_actions: []
        };
        break;
      }
      this.currentPhase = `turn_${turn}:thinking`;
      const turnTaskId = `${role === "worker" ? sessionId : "coding"}_turn_${turn}`;
      this.emitActivity(sessionId, "thinking", `${role === "worker" ? "Worker" : "Swarm"} thinking turn ${turn}/${maxTurns}`, { turn, taskId: turnTaskId });
      this.options.events.emitEvent({
        type: "task_attempt",
        session_id: sessionId,
        task_id: turnTaskId,
        title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
        attempt: turn,
        status: "started"
      });
      try {
        const delegateAvailable = (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) > 0;
        const modelCapabilities = await this.options.listModelCapabilities?.() ?? [];
        const durableContext = await this.options.durableContext?.(sessionId) ?? "";
        const availableTools = allowedToolNames(this.options.allowedTools, delegateAvailable, modelCapabilities);
        const dynamicToolSchemas = dynamicCapabilityToolSchemas(modelCapabilities);
        const budgetedToolResults = await applyToolResultBudget(compactToolResultHistory(toolResults), {
          sessionId,
          taskIdPrefix: turnTaskId,
          state: replacementState,
          store: this.options.toolReplacementStore,
          maxFreshBytes: TOOL_RESULT_FRESH_BUDGET_BYTES,
          maxTotalBytes: TOOL_RESULT_PER_TURN_BUDGET_BYTES,
          previewBytes: TOOL_RESULT_PERSIST_PREVIEW_BYTES
        });
        const systemPrompt = codingLoopSystemPrompt({
          role,
          workspace: this.options.workspace,
          delegateAvailable,
          agentInstructions: this.options.agentInstructions,
          durableContext,
          allowedTools: availableTools,
          writePolicy: this.options.writePolicy
        });
        const userPrompt = codingLoopUserPrompt({
          objective,
          role,
          parentSessionId: this.options.parentSessionId,
          availableTools,
          dynamicToolSchemas,
          settings: this.options.settings,
          workspace: this.options.workspace,
          delegateAvailable,
          toolResults: budgetedToolResults,
          liveMessages: this.liveMessages,
          controlDecisions: this.controlDecisions,
          turn,
          remainingTurns: maxTurns - turn,
          remainingToolCalls: maxToolCalls - toolCallCount
        });
        const modelText = await this.options.provider.generateText({
          model: this.options.provider.workerModel,
          system: systemPrompt,
          user: userPrompt,
          cache: {
            key: codingLoopCacheKey({
              role,
              sessionId,
              workerId: this.options.workerId,
              systemPrompt,
              userPrompt
            }),
            ttlSeconds: 3600
          },
          usage: {
            sessionId,
            taskId: turnTaskId,
            purpose: `${role}_coding_loop`
          },
          maxOutputTokens: role === "worker" ? MODEL_OUTPUT_TOKENS_WORKER_LOOP : MODEL_OUTPUT_TOKENS_MAIN_LOOP
        });
        lastResult = await parseCodingLoopModelResultWithRepair(modelText, objective, this.options.provider);
      } catch (error) {
        this.options.events.emitEvent({
          type: "task_attempt",
          session_id: sessionId,
          task_id: turnTaskId,
          title: error instanceof Error ? error.message : String(error),
          attempt: turn,
          status: "failed"
        });
        throw error;
      }
      this.lastResultSummary = lastResult.summary;
      for (const file of lastResult.files_touched) {
        changedFiles.add(file);
      }

      if (lastResult.status !== "continue" || lastResult.tool_calls.length === 0 || toolCallCount >= maxToolCalls) {
        if (lastResult.status === "continue" && lastResult.tool_calls.length > 0 && toolCallCount >= maxToolCalls) {
          lastResult = {
            status: "failed",
            summary: `Tool budget exhausted after ${toolCallCount}/${maxToolCalls} tool calls.`,
            message: `Tool budget exhausted before Swarm could run the next requested tool. Last request: ${summarizeToolBatch(lastResult.tool_calls.slice(0, 3))}`,
            tool_calls: [],
            files_touched: [...changedFiles],
            next_actions: ["Increase maxToolCalls or continue with a narrower objective."]
          };
        }
        this.emitActivity(sessionId, "turn_complete", `Turn ${turn}/${maxTurns} complete: ${firstLine(lastResult.summary) || "no tools requested"}`, { turn, taskId: turnTaskId });
        this.options.events.emitEvent({
          type: "task_attempt",
          session_id: sessionId,
          task_id: turnTaskId,
          title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
          attempt: turn,
          status: lastResult.status === "failed" ? "failed" : "completed"
        });
        if (this.options.emitProgress !== false) {
          this.options.events.emitEvent({ type: "progress", completed: turn, total: maxTurns });
        }
        break;
      }

      const batches = partitionToolCalls(lastResult.tool_calls);
      for (const batch of batches) {
        if (toolCallCount >= maxToolCalls) {
          lastResult = {
            status: "failed",
            summary: `Tool budget exhausted after ${toolCallCount}/${maxToolCalls} tool calls.`,
            message: "Tool budget exhausted before Swarm could finish the requested tool batch.",
            tool_calls: [],
            files_touched: [...changedFiles],
            next_actions: ["Increase maxToolCalls or continue with a narrower objective."]
          };
          break;
        }
        if (this.isStopRequested()) {
          lastResult = {
            status: "failed",
            summary: this.stopReason || "Worker stopped by main Swarm",
            message: this.stopReason || "Worker stopped before starting the next tool batch.",
            tool_calls: [],
            files_touched: [...changedFiles],
            next_actions: []
          };
          break;
        }
        if (this.interruptRequested) {
          this.interruptRequested = false;
          break;
        }
        this.currentPhase = batch.concurrent ? "running read-only tool batch" : "running tool";
        if (batch.concurrent) {
          const calls = batch.calls.slice(0, maxToolCalls - toolCallCount);
          this.emitActivity(sessionId, "running_tools", `Running ${calls.length} read-only tools: ${summarizeToolBatch(calls)}`, { turn, taskId: turnTaskId });
          const executed = await Promise.all(
            calls.map((call) => this.executeToolCall(call, sessionId, turn))
          );
          toolCallCount += executed.length;
          for (const item of executed) {
            toolResults.push(item.result);
            collectOutcome(item.result, changedFiles, testsRun, intermediateArtifacts);
          }
        } else {
          for (const call of batch.calls) {
            if (toolCallCount >= maxToolCalls) {
              lastResult = {
                status: "failed",
                summary: `Tool budget exhausted after ${toolCallCount}/${maxToolCalls} tool calls.`,
                message: "Tool budget exhausted before Swarm could finish the requested tool batch.",
                tool_calls: [],
                files_touched: [...changedFiles],
                next_actions: ["Increase maxToolCalls or continue with a narrower objective."]
              };
              break;
            }
            if (this.isStopRequested()) {
              lastResult = {
                status: "failed",
                summary: this.stopReason || "Worker stopped by main Swarm",
                message: this.stopReason || "Worker stopped before starting the next tool.",
                tool_calls: [],
                files_touched: [...changedFiles],
                next_actions: []
              };
              break;
            }
            const item = await this.executeToolCall(call, sessionId, turn);
            toolCallCount += 1;
            toolResults.push(item.result);
            collectOutcome(item.result, changedFiles, testsRun, intermediateArtifacts);
          }
        }
        if (this.interruptRequested) {
          this.interruptRequested = false;
          break;
        }
      }

      if (lastResult.status === "continue" && toolCallCount >= maxToolCalls) {
        lastResult = {
          status: "failed",
          summary: `Tool budget exhausted after ${toolCallCount}/${maxToolCalls} tool calls.`,
          message: "Tool budget exhausted before Swarm could complete another model turn.",
          tool_calls: [],
          files_touched: [...changedFiles],
          next_actions: ["Increase maxToolCalls or continue with a narrower objective."]
        };
      }
      this.options.events.emitEvent({
        type: "task_attempt",
        session_id: sessionId,
        task_id: turnTaskId,
        title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
        attempt: turn,
        status: lastResult.status === "failed" ? "failed" : "completed"
      });
      this.emitActivity(sessionId, "turn_complete", `Turn ${turn}/${maxTurns} complete: ${firstLine(lastResult.summary) || "tools finished"}`, { turn, taskId: turnTaskId });
      if (this.options.emitProgress !== false) {
        this.options.events.emitEvent({ type: "progress", completed: turn, total: maxTurns });
      }
    }

    const content = lastResult.message || lastResult.summary || "Coding loop completed.";
    const finalStatus = summarizeCodingLoopFinalStatus({
      stopRequested: this.stopRequested,
      modelStatus: lastResult.status,
      toolResults,
      content,
      budgetExhausted: lastResult.status === "continue" && lastResult.tool_calls.length > 0,
      unresolvedFailure: hasUnresolvedToolFailure({
        toolResults,
        finalText: `${lastResult.summary}\n${lastResult.message}`
      })
    });
    const outcome: SessionOutcome = {
      changed_files: [...changedFiles],
      intermediate_artifacts: [...intermediateArtifacts],
      tests_run: [...testsRun],
      final_summary: finalStatus.summary
    };
    if (this.options.emitFinal !== false) {
      this.options.events.emitEvent({ type: "final", session_id: sessionId, content, outcome, status: finalStatus.status });
    }
    this.emitActivity(
      sessionId,
      finalActivityPhase(finalStatus),
      finalActivityMessage(finalStatus, this.stopReason),
      { taskId: "final" }
    );
    this.currentPhase = "idle";
    return { session_id: sessionId, content, outcome, status: finalStatus.status };
  }

  private isStopRequested(): boolean {
    if (this.stopRequested) {
      return true;
    }
    if (!this.options.workerId || !this.options.workerStore) {
      return false;
    }
    return this.options.workerStore.get(this.options.workerId)?.status === "stopped";
  }

  private async decideControl(message: LiveUserMessage): Promise<ControlDecision> {
    const content = await this.options.provider.generateText({
      model: this.options.provider.workerModel,
      system: [{
        text: [
          "You are Swarm's live control plane for a local coding CLI.",
          "The user is always talking to the main Swarm, even while work is running.",
          "Decide how the active run should react to the newest user message.",
          "Return exactly one JSON object with keys: action, reason, instruction.",
          "action must be one of: continue_current, inject_next_turn, interrupt_and_redirect, ask_clarification.",
          "continue_current: the current work can continue; still apply the message in a later turn if relevant.",
          "inject_next_turn: do not interrupt an active tool, but the next model turn must process this message.",
          "interrupt_and_redirect: stop unstarted tool calls and redirect to the user's newest instruction.",
          "ask_clarification: pause because the new message conflicts with the current objective and cannot be safely inferred.",
          "Do not include Markdown fences or prose outside JSON."
        ].join(" "),
        cache: true
      }],
      user: JSON.stringify({
        live_message: message,
        current_phase: this.currentPhase,
        last_result_summary: this.lastResultSummary,
        recent_live_messages: this.liveMessages.slice(-6),
        recent_control_decisions: this.controlDecisions.slice(-6)
      }, null, 2),
      usage: {
        sessionId: this.sessionId,
        taskId: `control_${message.id}`,
        purpose: "coding_loop_control"
      },
      maxOutputTokens: MODEL_OUTPUT_TOKENS_CONTROL
    });
    const parsed = parseJsonObject(content);
    const action = parsed.action === "continue_current" ||
      parsed.action === "inject_next_turn" ||
      parsed.action === "interrupt_and_redirect" ||
      parsed.action === "ask_clarification"
      ? parsed.action
      : "inject_next_turn";
    return {
      message_id: message.id,
      action,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 500) : "Swarm control decision.",
      instruction: typeof parsed.instruction === "string" && parsed.instruction.trim() ? parsed.instruction.trim() : message.content
    };
  }

  private async executeToolCall(call: CodingLoopToolCall, sessionId: string, turn?: number): Promise<{ result: CodingLoopToolResult }> {
    const id = call.id ?? `tool_${randomUUID()}`;
    try {
      const capabilityResult = await this.tryExecuteDynamicCapability(call, id, sessionId, turn);
      if (capabilityResult) {
        return capabilityResult;
      }
      const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
      if (this.options.allowedTools && !isToolAllowedForPersona(action.type, this.options.allowedTools)) {
        throw new Error(`Tool action is not allowed for this agent persona: ${action.type}`);
      }
      this.emitActivity(sessionId, "running_tool", `Running ${describeToolAction(action)}`, { turn, tool: action.type, taskId: id });
      if (this.options.invokeCapability) {
        const capabilityId = localCapabilityIdForAction(action.type);
        const rawResult = await this.options.invokeCapability(
          capabilityId,
          { ...(call.inputs ?? {}), action: call.action ?? action.type },
          sessionId,
          {
            taskId: id,
            title: call.reason ?? action.type,
            allowDelegate: (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) > 0,
            source: "coding_loop"
          }
        );
        return { result: codingLoopResultFromTool(id, action.type, rawResult) };
      }
      if (toolRequiresApproval(action, this.options.settings, { workspace: this.options.workspace })) {
        if (!this.options.approvalHandler) {
          throw new Error(`Tool action requires approval but no approval handler is available: ${action.type}`);
        }
        const request = createToolApprovalRequest(action);
        request.session_id = sessionId;
        request.task_id = id;
        this.emitActivity(sessionId, "waiting_approval", `Waiting for approval: ${describeToolAction(action)}`, { turn, tool: action.type, taskId: id });
        this.options.events.emitEvent({ type: "approval", request, status: "pending" });
        const approved = await this.options.approvalHandler(request);
        this.options.events.emitEvent({ type: "approval", request, status: approved ? "approved" : "denied" });
        if (!approved) {
          throw new Error(`Tool action denied: ${action.type}`);
        }
      }

      const toolContext: LocalToolContext = {
        workspace: this.options.workspace,
        settings: this.options.settings,
        sessionId,
        taskId: id,
        attempt: 0,
        serverWebSearch: (searchAction) => this.options.provider.webSearch(searchAction),
        onWorkspaceChange: this.options.onWorkspaceChange,
        onFileLock: this.options.onFileLock,
        delegate: (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) > 0
          ? (action) => this.delegateWorker(action, sessionId, id)
          : undefined
      };
      const rawResult = await runLocalTool(action, toolContext);
      const prepared = await prepareToolOutput(sessionId, id, rawResult, renderToolResultDetail(rawResult));
      const result: CodingLoopToolResult = {
        id,
        action: action.type,
        status: rawResult.status ?? "success",
        summary: rawResult.summary,
        content: prepared.content,
        outputRef: prepared.outputRef,
        data: prepared.data,
        errors: rawResult.errors,
        errorCode: rawResult.errorCode,
        recoverySuggestion: rawResult.recoverySuggestion
      };
      this.options.events.emitEvent({
        type: "tool_result",
        session_id: sessionId,
        task_id: id,
        title: call.reason ?? action.type,
        action: action.type,
        summary: rawResult.summary,
        content: prepared.content,
        status: result.status,
        outputRef: prepared.outputRef,
        errorCode: rawResult.errorCode,
        recoverySuggestion: rawResult.recoverySuggestion
      });
      return { result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const errorCode = classifyToolError(error);
      const recoverySuggestion = recoverySuggestionForToolError(errorCode, reason);
      const actionName = typeof call.action === "string"
        ? call.action
        : typeof call.inputs?.action === "string"
          ? call.inputs.action
          : "unknown";
      const result: CodingLoopToolResult = {
        id,
        action: actionName,
        status: "failed",
        summary: reason,
        content: formatToolFailureContent(actionName, reason, errorCode, recoverySuggestion),
        errors: [reason],
        errorCode,
        recoverySuggestion
      };
      this.options.events.emitEvent({
        type: "tool_result",
        session_id: sessionId,
        task_id: id,
        title: call.reason ?? String(result.action),
        action: String(result.action),
        summary: reason,
        content: result.content,
        status: "failed",
        errorCode: result.errorCode,
        recoverySuggestion: result.recoverySuggestion
      });
      return { result };
    }
  }

  private emitActivity(
    sessionId: string,
    phase: LoopActivityPhase,
    message: string,
    options: { turn?: number; tool?: string; taskId?: string } = {}
  ): void {
    this.options.events.emitEvent({
      type: "loop_activity",
      session_id: sessionId,
      phase,
      message,
      turn: options.turn,
      tool: options.tool,
      task_id: options.taskId
    });
  }

  private async tryExecuteDynamicCapability(
    call: CodingLoopToolCall,
    id: string,
    sessionId: string,
    turn?: number
  ): Promise<{ result: CodingLoopToolResult } | undefined> {
    if (!this.options.invokeCapability || !isDynamicCapabilityAction(call.action)) {
      return undefined;
    }
    const action = call.action;
    const capabilities = await this.options.listModelCapabilities?.() ?? [];
    const capability = capabilities.find((item) => dynamicCapabilityMatchesAction(item, action));
    if (!capability) {
      return undefined;
    }
    this.emitActivity(sessionId, "running_tool", `Running ${capability.name}`, { turn, tool: capability.name, taskId: id });
    const rawResult = await this.options.invokeCapability(capability.id, call.inputs ?? {}, sessionId, {
      taskId: id,
      title: call.reason ?? capability.name,
      source: "coding_loop"
    });
    const result = codingLoopResultFromTool(id, capability.name, rawResult);
    return { result };
  }

  private async delegateWorker(action: AgentDelegateAction, sessionId: string, parentTaskId: string): Promise<ToolResult> {
    if (this.options.invokeAgent) {
      return this.options.invokeAgent({
        parent_session_id: sessionId,
        requested_by: this.options.workerId ?? "main_swarm",
        capability: action.capability,
        task: action.task,
        context: action.context,
        preferred_agent_spec_id: action.preferred_agent_spec_id,
        preferred_mode: action.preferred_mode,
        file_scope: action.file_scope,
        spawn_reason: `agent.delegate from ${parentTaskId}`
      });
    }

    const workerId = `worker_${randomUUID()}`;
    const toolBudget = { max_turns: 6, max_tool_calls: 20 };
    const workerRecord = this.options.workerStore?.create({
      worker_id: workerId,
      parent_session_id: sessionId,
      capability: action.capability,
      objective: action.task,
      tool_budget: toolBudget
    });
    this.options.events.emitEvent({
      type: "controller",
      id: workerId,
      action: "spawn_worker",
      reason: action.capability,
      instruction: action.task
    });
    if (workerRecord) {
      this.options.events.emitEvent({ type: "worker", worker: workerRecord, status: workerRecord.status, message: action.task });
    }
    const worker = new CodingAgentLoop({
      workspace: this.options.workspace,
      settings: this.options.settings,
      provider: this.options.provider,
      events: this.options.events,
      approvalHandler: this.options.approvalHandler,
      role: "worker",
      parentSessionId: sessionId,
      workerId,
      workerStore: this.options.workerStore,
      delegateDepth: Math.max(0, (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) - 1),
      maxTurns: toolBudget.max_turns,
      maxToolCalls: toolBudget.max_tool_calls,
      emitFinal: false,
      emitProgress: false
    });
    try {
      const result = await worker.run([
        `Delegated capability: ${action.capability}`,
        `Delegated task: ${action.task}`,
        action.context ? `Context:\n${action.context}` : undefined,
        "Return internal findings for the main Swarm to synthesize. Do not address the user directly."
      ].filter(Boolean).join("\n\n"));
      const stopped = this.options.workerStore?.get(workerId)?.status === "stopped";
      const status = workerStatusFromExecutionStatus(result.status, stopped);
      const content = result.content;
      const finalRecord = this.options.workerStore?.setResult({
        worker_id: workerId,
        status,
        worker_session_id: result.session_id,
        last_result: content,
        outcome: result.outcome
      });
      if (finalRecord) {
        this.options.events.emitEvent({ type: "worker", worker: finalRecord, status: finalRecord.status, message: firstLine(content) });
      }
      this.options.events.emitEvent({
        type: "controller",
        id: workerId,
        action: "worker_notification",
        reason: `Worker ${workerId} ${status}`,
        instruction: content
      });
      return {
        action: "agent.delegate",
        status: delegatedToolStatus(status),
        summary: `Worker ${workerId} ${status}: ${firstLine(content)}`,
        content,
        data: {
          worker_id: workerId,
          worker_session_id: result.session_id,
          capability: action.capability,
          task: action.task,
          outcome: result.outcome,
          worker_status: status
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRecord = this.options.workerStore?.setResult({
        worker_id: workerId,
        status: "failed",
        last_result: message
      });
      if (failedRecord) {
        this.options.events.emitEvent({ type: "worker", worker: failedRecord, status: failedRecord.status, message });
      }
      throw error;
    }
  }
}

function summarizeToolBatch(calls: CodingLoopToolCall[]): string {
  const names = calls.map((call) => String(call.action ?? call.inputs?.action ?? "unknown"));
  const unique = [...new Set(names)].slice(0, 4);
  return unique.join(", ") + (names.length > unique.length ? `, +${names.length - unique.length}` : "");
}

function describeToolAction(action: ToolAction): string {
  switch (action.type) {
    case "file.read":
      return `file.read ${previewActivityValue(action.path ?? action.paths?.join(", ") ?? ".")}`;
    case "file.list":
      return `file.list ${previewActivityValue(action.root)}`;
    case "file.glob":
      return `file.glob ${previewActivityValue(action.pattern)} in ${previewActivityValue(action.root)}`;
    case "file.grep":
      return `file.grep ${previewActivityValue(action.pattern)} in ${previewActivityValue(action.root)}`;
    case "file.stat":
      return `file.stat ${previewActivityValue(action.path)}`;
    case "file.resolve":
      return `file.resolve ${previewActivityValue(action.path)}`;
    case "file.write":
      return `file.write ${previewActivityValue(action.path)}`;
    case "file.edit":
      return `file.edit ${previewActivityValue(action.path)}`;
    case "file.mkdir":
      return `file.mkdir ${previewActivityValue(action.path)}`;
    case "file.move":
      return `file.move ${previewActivityValue(action.source)} -> ${previewActivityValue(action.destination)}`;
    case "file.copy":
      return `file.copy ${previewActivityValue(action.source)} -> ${previewActivityValue(action.destination)}`;
    case "file.delete":
      return `file.delete ${previewActivityValue(action.path)}`;
    case "file.patch":
      return `file.patch ${previewActivityValue(action.path)}`;
    case "json.read":
      return `json.read ${previewActivityValue(action.path)}`;
    case "json.edit":
      return `json.edit ${previewActivityValue(action.path)} ${previewActivityValue(action.pointer)}`;
    case "todo.write":
      return `todo.write ${action.todos.length} item(s)`;
    case "blackboard.write":
      return `BlackboardWrite ${previewActivityValue(action.key)}`;
    case "blackboard.read":
      return `BlackboardRead ${previewActivityValue(action.entryId ?? action.key ?? "entry")}`;
    case "blackboard.search":
      return `BlackboardSearch ${previewActivityValue(action.query ?? action.keyPrefix ?? action.tag ?? "entries")}`;
    case "blackboard.list":
      return `BlackboardList ${previewActivityValue(action.keyPrefix ?? action.tag ?? "entries")}`;
    case "shell.exec":
      return `shell.exec ${previewActivityValue(action.command)}`;
    case "exec":
      return `exec ${previewActivityValue(action.command)}`;
    case "process.start":
      return `process.start ${previewActivityValue(action.command)}`;
    case "process.status":
      return `process.status ${previewActivityValue(action.processId ?? "recent")}`;
    case "process.list":
      return `process.list ${previewActivityValue(action.status ?? action.sessionId ?? "recent")}`;
    case "process.tail":
      return `process.tail ${previewActivityValue(action.processId)}`;
    case "process.grep":
      return `process.grep ${previewActivityValue(action.pattern)} in ${previewActivityValue(action.processId)}`;
    case "process.stop":
      return `process.stop ${previewActivityValue(action.processId)}`;
    case "web.search":
      return `web.search ${previewActivityValue(action.query)}`;
    case "web.fetch":
      return `web.fetch ${previewActivityValue(action.url)}`;
    case "notebook.edit":
      return `NotebookEdit ${previewActivityValue(action.notebookPath)}`;
    case "code.test":
      return `code.test ${previewActivityValue(action.command)}`;
    case "code.lint":
      return `code.lint ${previewActivityValue(action.root ?? action.include ?? ".")}`;
    case "code.build":
      return `code.build ${previewActivityValue(action.command)}`;
    case "git.status":
      return `git.status ${previewActivityValue(action.cwd ?? ".")}`;
    case "git.diff":
      return `git.diff ${previewActivityValue(action.cwd ?? ".")}${action.staged ? " --staged" : ""}`;
    case "git.log":
      return `git.log ${previewActivityValue(action.cwd ?? ".")}`;
    case "git.branch":
      return `git.branch ${action.action ?? "list"}${action.name ? ` ${previewActivityValue(action.name)}` : ""}`;
    case "git.show":
      return `git.show ${previewActivityValue(action.revision ?? action.path ?? "HEAD")}`;
    case "package.install":
      return `package.install ${previewActivityValue(action.command)}`;
    case "package.info":
      return `package.info ${previewActivityValue(action.cwd ?? action.manifest ?? ".")}`;
    case "project.detect":
      return `project.detect ${previewActivityValue(action.root ?? ".")}`;
    case "agent.delegate":
      return `agent.delegate ${previewActivityValue(action.capability)}: ${previewActivityValue(action.task)}`;
  }
}

function previewActivityValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > ACTIVITY_PREVIEW_LENGTH
    ? `${normalized.slice(0, ACTIVITY_PREVIEW_LENGTH - 1)}…`
    : normalized;
}

function codingLoopSystemPrompt(input: {
  role: "main" | "worker";
  workspace: string;
  delegateAvailable: boolean;
  agentInstructions?: string;
  durableContext?: string;
  allowedTools?: string[];
  writePolicy?: "read_only" | "scoped_write" | "workspace_write";
}): PromptBlock[] {
  const tools = allowedToolNames(input.allowedTools, input.delegateAvailable).join(", ");
  const staticInstructions = [
    input.role === "worker"
      ? "You are a Swarm worker agent running inside the main Swarm controller."
      : "You are Swarm's default coding agent, a local coding CLI agent.",
    input.role === "worker"
      ? "You are not user-facing. Produce internal findings, edits, or verification for the main Swarm to synthesize."
      : "You are user-facing through the main Swarm conversation.",
    "Work efficiently in a loop: inspect files, edit when needed, verify when useful, then answer concisely.",
    "Return exactly one JSON object with keys: status, summary, message, files_touched, next_actions, tool_calls.",
    "status must be continue, completed, or failed.",
    "Use tool_calls when you need to act. Use [] when done.",
    "A failed tool result is feedback, not a global stop. Read the error, adjust inputs or command, and continue unless the task is truly blocked.",
    "If a shell command times out, retry with a narrower command or a larger timeoutMs when the command is still necessary.",
    "Use status=failed only when you cannot recover or continue after inspecting the latest tool results.",
    `Allowed tools: ${tools}.`,
    renderHostEnvironmentPrompt(input.workspace),
    input.writePolicy ? `Write policy: ${input.writePolicy}. Never use tools outside this policy.` : undefined,
    "Read existing files before editing them. For edits, read the full file first.",
    "Prefer file.edit for existing files and file.write for new files. Do not write final reports unless requested.",
    "For tool_calls, each item is {id, action, inputs, reason}. The action must match an allowed tool, and inputs must match the tool_schemas in the user payload.",
    input.delegateAvailable
      ? "You may dynamically upgrade the coding loop into an internal swarm by using Agent when the task naturally splits into independent roles, workstreams, or expert checks. The main Swarm remains responsible for user-facing synthesis and final decisions."
      : "Do not use Agent in this loop.",
    input.delegateAvailable && input.role === "main"
      ? "When delegating, choose from available_agent_specs and pass structured inputs: capability, task, context, preferred_agent_spec_id, preferred_mode, and file_scope when known. For explicit swarm or team-role requests, spawn the relevant architect/researcher/reviewer/verifier/coder workers early instead of doing all reasoning alone. Prefer read-only researcher/reviewer/critic/verifier subagents before write delegation. Use handoff only for focused deep work across multiple turns."
      : undefined,
    "Keep message grounded in actual tool results. Mention verification commands that were run.",
    input.role === "main"
      ? "Live user messages are part of the main Swarm conversation, not side-channel chat."
      : "Live user messages are controller context; do not treat them as direct worker chat.",
    "Always obey the newest live user messages and control_decisions. If they redirect the task, stop pursuing the old target after the current safe boundary."
  ].filter(Boolean).join(" ");
  return [
    { text: staticInstructions, cache: true },
    ...(input.agentInstructions ? [{ text: input.agentInstructions, cache: false }] : []),
    ...(input.durableContext ? [{ text: `Durable session context that must survive compaction:\n${input.durableContext}`, cache: false }] : [])
  ];
}

function codingLoopUserPrompt(input: {
  objective: string;
  role: "main" | "worker";
  parentSessionId?: string;
  availableTools: string[];
  dynamicToolSchemas: Record<string, Record<string, unknown>>;
  settings: SwarmSettings;
  workspace: string;
  delegateAvailable: boolean;
  toolResults: CodingLoopToolResult[];
  liveMessages: LiveUserMessage[];
  controlDecisions: ControlDecision[];
  turn: number;
  remainingTurns: number;
  remainingToolCalls: number;
}): PromptBlock[] {
  const stablePayload = {
    role: input.role,
    tool_schemas: renderToolSchemas(input.availableTools, input.dynamicToolSchemas),
    available_agent_specs: input.role === "main" && input.delegateAvailable
      ? renderAvailableAgentSpecs({ settings: input.settings, workspace: input.workspace })
      : undefined,
    delegation_policy: input.role === "main" && input.delegateAvailable
      ? codingLoopDelegationPolicy()
      : undefined
  };
  const dynamicPayload = {
    objective: input.objective,
    role: input.role,
    parent_session_id: input.parentSessionId,
    swarm_runtime_state: input.role === "main" && input.delegateAvailable
      ? swarmRuntimeState(input.toolResults, input.turn)
      : undefined,
    live_user_messages: input.liveMessages,
    control_decisions: input.controlDecisions,
    tool_results: input.toolResults,
    loop: {
      turn: input.turn,
      remaining_turns: input.remainingTurns,
      remaining_tool_calls: input.remainingToolCalls
    }
  };
  return [
    { text: JSON.stringify(stablePayload, null, 2), cache: true },
    { text: JSON.stringify(dynamicPayload, null, 2), cache: false }
  ];
}

function codingLoopCacheKey(input: {
  role: "main" | "worker";
  sessionId: string;
  workerId?: string;
  systemPrompt: PromptBlock[];
  userPrompt: PromptBlock[];
}): string {
  const stablePrompt = [...input.systemPrompt, ...input.userPrompt]
    .filter((block) => block.cache)
    .map((block) => block.text)
    .join("\n\n");
  const stableHash = createHash("sha256").update(stablePrompt).digest("hex").slice(0, 16);
  return `swarm:${input.role}:stable:${stableHash}`;
}

function renderAvailableAgentSpecs(source: AgentSpecSource): Array<Record<string, unknown>> {
  return listAgentSpecs(source).map((spec) => ({
    id: spec.id,
    role: spec.role,
    description: spec.description,
    when_to_use: spec.when_to_use,
    capabilities: spec.capabilities,
    write_policy: spec.write_policy,
    budget: spec.default_budget,
    output_contract: spec.output_contract
  }));
}

function codingLoopDelegationPolicy(): Record<string, unknown> {
  return {
    main_swarm_owns_user_facing_answer: true,
    dynamic_escalation: {
      enabled: true,
      principle: "The run may move from single-agent coding_loop into an internal swarm when new task shape, risk, or user instruction justifies it.",
      strong_triggers: [
        "The user explicitly asks to use Agent Swarm, subagents, a team, or multiple named roles.",
        "The task includes separable architecture, frontend, backend, data, security, review, or verification tracks.",
        "A design decision would benefit from independent critique before edits.",
        "Implementation has finished and fresh review or verification would reduce regression risk."
      ]
    },
    delegate_when: [
      "A bounded read-only exploration can run independently while the main Swarm plans or implements another part.",
      "An explicit swarm/team-role request names independent workstreams such as architecture, frontend, backend, database, review, or verification.",
      "A fresh reviewer, critic, or verifier can catch defects after edits or before risky changes.",
      "A focused specialist can own a clearly scoped implementation or deep-work segment."
    ],
    avoid_delegate_when: [
      "The next step is on the critical path and delegation would only add latency.",
      "The task is small enough for the main coding loop.",
      "The subagent would need broad unsupervised write access without a clear file scope."
    ],
    preferred_patterns: [
      "architect/call_subagent for upfront system architecture and module boundaries.",
      "researcher/call_subagent for parallel repo exploration and evidence gathering.",
      "reviewer or critic/call_subagent for independent checks.",
      "verifier/call_subagent after workspace changes.",
      "coder/scoped_write only with file_scope.",
      "handoff only when a focused specialist should preserve context across several turns."
    ]
  };
}

function swarmRuntimeState(toolResults: CodingLoopToolResult[], turn: number): Record<string, unknown> {
  const delegationResults = toolResults.filter((result) => result.action === "agent.delegate");
  return {
    turn,
    internal_swarm_available: true,
    delegated_workers_started: delegationResults.length,
    no_workers_started_yet: delegationResults.length === 0,
    escalation_hint: delegationResults.length === 0
      ? "If the objective has separable roles or explicitly requests swarm/team execution, consider spawning appropriate Agent workers before continuing alone."
      : "Use existing worker results to coordinate, fill gaps, review, or verify before final synthesis."
  };
}

function allowedToolNames(allowedTools: string[] | undefined, delegateAvailable: boolean, capabilities: CapabilityDescriptor[] = []): string[] {
  const tools = allowedTools?.length ? allowedTools : [...DEFAULT_TOOL_NAMES];
  const withDelegate = delegateAvailable && !tools.includes("Agent")
    ? [...tools, "Agent"]
    : tools.filter((tool) => delegateAvailable || (tool !== "Agent" && tool !== "agent.delegate"));
  if (allowedTools?.length) {
    return withDelegate;
  }
  const dynamicTools = capabilities
    .filter((capability) => (capability.kind === "mcp_tool" || capability.id === SKILL_ACTIVATE_CAPABILITY_ID) && capability.modelVisible && capability.status !== "disabled")
    .map((capability) => capability.name);
  return [...new Set([...withDelegate, ...dynamicTools])];
}

function isToolAllowedForPersona(action: ToolAction["type"], allowedTools: string[]): boolean {
  return allowedTools.some((tool) => {
    if (tool === action) {
      return true;
    }
    try {
      return normalizeToolAction({ action: tool }).type === action;
    } catch {
      return false;
    }
  });
}

function localCapabilityIdForAction(action: ToolAction["type"]): string {
  const visibleNameByAction: Partial<Record<ToolAction["type"], string>> = {
    "file.read": "Read",
    "file.list": "LS",
    "file.glob": "Glob",
    "file.grep": "Grep",
    "file.write": "Write",
    "file.edit": "Edit",
    "notebook.edit": "NotebookEdit",
    "shell.exec": "Bash",
    "process.start": "ProcessStart",
    "process.status": "ProcessStatus",
    "process.list": "ProcessList",
    "process.tail": "ProcessTail",
    "process.grep": "ProcessGrep",
    "process.stop": "ProcessStop",
    "web.search": "WebSearch",
    "web.fetch": "WebFetch",
    "todo.write": "TodoWrite",
    "blackboard.write": "BlackboardWrite",
    "blackboard.search": "BlackboardSearch",
    "blackboard.read": "BlackboardRead",
    "blackboard.list": "BlackboardList",
    "agent.delegate": "Agent"
  };
  return `local_tool.${visibleNameByAction[action] ?? action}`;
}

function isDynamicCapabilityAction(action: string | undefined): action is string {
  return typeof action === "string" && (action.startsWith("mcp__") || action === SKILL_ACTIVATE_TOOL_NAME);
}

function dynamicCapabilityMatchesAction(capability: CapabilityDescriptor, action: string): boolean {
  if (capability.kind === "mcp_tool") {
    return capability.name === action;
  }
  return capability.id === SKILL_ACTIVATE_CAPABILITY_ID && capability.name === action;
}

function dynamicCapabilityToolSchemas(capabilities: CapabilityDescriptor[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    capabilities
      .filter((capability) => (capability.kind === "mcp_tool" || capability.id === SKILL_ACTIVATE_CAPABILITY_ID) && capability.modelVisible && capability.status !== "disabled")
      .map((capability) => [
        capability.name,
        {
          action: capability.name,
          description: capability.description,
          inputs: capability.inputSchema ?? { type: "object" },
          output: capability.outputSchema,
          risk_class: capability.riskClass,
          permission: capability.permissionName,
          provider: capability.providerId
        }
      ])
  );
}

function renderToolSchemas(allowedTools: string[], dynamicSchemas: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> {
  return allowedTools.map((tool) => dynamicSchemas[tool] ?? TOOL_SCHEMAS[tool] ?? {
    action: tool,
    inputs: { action: tool },
    notes: "No detailed schema is registered for this tool."
  });
}

const TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  "Read": {
    action: "Read",
    inputs: { file_path: "file path", offset: "optional line offset", limit: "optional line count", path: "compat path" },
    notes: "Use a full Read before editing an existing file."
  },
  "LS": {
    action: "LS",
    inputs: { path: "directory path", root: "compat directory path", maxFiles: "optional number", maxDepth: "optional number" }
  },
  "Glob": {
    action: "Glob",
    inputs: { pattern: "glob pattern", path: "optional directory path" }
  },
  "Grep": {
    action: "Grep",
    inputs: { pattern: "regex pattern", path: "optional file or directory path", glob: "optional glob", output_mode: "content | files_with_matches | count", context: "optional number", head_limit: "optional number", multiline: "optional boolean" }
  },
  "Write": {
    action: "Write",
    inputs: { file_path: "workspace path", content: "complete file content", path: "compat path" },
    notes: "Use for new files or complete replacement. Prefer Edit for existing files after a full Read."
  },
  "Edit": {
    action: "Edit",
    inputs: { file_path: "workspace path", old_string: "must match exactly once unless replace_all=true", new_string: "replacement", replace_all: "optional boolean", path: "compat path" }
  },
  "NotebookEdit": {
    action: "NotebookEdit",
    inputs: { notebook_path: "ipynb path", cell_id: "optional cell id", new_source: "cell source", cell_type: "code | markdown", edit_mode: "replace | insert | delete" }
  },
  "Bash": {
    action: "Bash",
    inputs: { command: "command string", timeout: "optional ms", description: "optional concise description", run_in_background: "boolean for persistent commands", cwd: "optional cwd", maxLogBytes: "optional background log cap" },
    notes: "Use run_in_background=true or ProcessStart for servers, dev servers, watchers, and commands whose logs must be inspected later."
  },
  "ProcessStart": {
    action: "ProcessStart",
    inputs: { command: "persistent command string", cwd: "optional workspace-relative cwd", description: "short label", timeoutMs: "optional maximum lifetime in ms", maxLogBytes: "optional log cap in bytes" },
    notes: "Starts a command in the background and returns processId plus logPath immediately. Use for backend servers, dev servers, and watchers."
  },
  "ProcessStatus": {
    action: "ProcessStatus",
    inputs: { processId: "optional process id; omit to list recent session processes", sessionId: "optional session id" }
  },
  "ProcessList": {
    action: "ProcessList",
    inputs: { sessionId: "optional session id", status: "optional running | completed | failed | stopped | unknown", limit: "optional number" }
  },
  "ProcessTail": {
    action: "ProcessTail",
    inputs: { processId: "process id", sessionId: "optional session id", lines: "optional line count", maxBytes: "optional byte cap" }
  },
  "ProcessGrep": {
    action: "ProcessGrep",
    inputs: { processId: "process id", sessionId: "optional session id", pattern: "regex or literal text", maxMatches: "optional number", contextLines: "optional number" }
  },
  "ProcessStop": {
    action: "ProcessStop",
    inputs: { processId: "process id", sessionId: "optional session id" },
    notes: "Stops a running background process."
  },
  "exec": {
    action: "exec",
    inputs: { command: "command string", cwd: "optional workspace-relative cwd", timeoutMs: "optional ms", maxOutputBytes: "optional bytes" }
  },
  "WebSearch": {
    action: "WebSearch",
    inputs: { query: "search query", allowed_domains: "optional string[]", blocked_domains: "optional string[]" }
  },
  "WebFetch": {
    action: "WebFetch",
    inputs: { url: "http(s) URL", prompt: "what to extract from the page", timeoutMs: "optional ms", maxBytes: "optional bytes" }
  },
  "TodoWrite": {
    action: "TodoWrite",
    inputs: { todos: "array of {content:string,activeForm?:string,status:'pending'|'in_progress'|'completed'}" }
  },
  "BlackboardWrite": {
    action: "BlackboardWrite",
    inputs: { key: "stable dotted key", type: "plan | observation | evidence | result | critique | decision | artifact", value: "JSON-serializable value", visibility: "optional private | team | public", tags: "optional string[]" },
    notes: "Write shared Swarm session state for other agents. Do not construct raw envelopes."
  },
  "BlackboardSearch": {
    action: "BlackboardSearch",
    inputs: { query: "optional text search", type: "optional entry type", tag: "optional tag", key_prefix: "optional key prefix", task_id: "optional task id", agent_id: "optional agent id", limit: "optional number" }
  },
  "BlackboardRead": {
    action: "BlackboardRead",
    inputs: { entry_id: "entry id", key: "entry key", limit: "optional number for key history" }
  },
  "BlackboardList": {
    action: "BlackboardList",
    inputs: { type: "optional entry type", tag: "optional tag", key_prefix: "optional key prefix", task_id: "optional task id", agent_id: "optional agent id", limit: "optional number" }
  },
  "Agent": {
    action: "Agent",
    inputs: { description: "short task description", prompt: "task for the agent", subagent_type: "optional agent type", model: "optional model", run_in_background: "reserved boolean", capability: "compat capability", task: "compat task", file_scope: "optional string[]" }
  },
  "file.read": {
    action: "file.read",
    inputs: {
      action: "file.read",
      path: "string path, or use paths",
      paths: "optional string[] for multiple small files",
      startLine: "optional 1-based line number",
      endLine: "optional 1-based line number; -1 means EOF",
      maxBytes: "optional byte budget"
    },
    notes: "Use a full file.read before editing an existing file."
  },
  "file.list": {
    action: "file.list",
    inputs: { action: "file.list", root: "directory path", maxFiles: "optional number", maxDepth: "optional number" }
  },
  "file.glob": {
    action: "file.glob",
    inputs: { action: "file.glob", root: "directory path", pattern: "glob pattern", maxResults: "optional number", maxDepth: "optional number" }
  },
  "file.grep": {
    action: "file.grep",
    inputs: { action: "file.grep", root: "file or directory path", pattern: "regex pattern", include: "optional glob", maxMatches: "optional number", contextLines: "optional number" }
  },
  "file.stat": {
    action: "file.stat",
    inputs: { action: "file.stat", path: "path" }
  },
  "file.write": {
    action: "file.write",
    inputs: { action: "file.write", path: "workspace path", content: "complete file content" },
    notes: "Use for new files or complete replacement. Prefer file.edit for existing files after a full read."
  },
  "file.edit": {
    action: "file.edit",
    inputs: {
      action: "file.edit",
      path: "workspace path",
      operation: "str_replace | insert",
      oldText: "required for str_replace; must match exactly once",
      newText: "replacement text for str_replace",
      line: "1-based insertion line for insert",
      content: "inserted text for insert"
    }
  },
  "shell.exec": {
    action: "shell.exec",
    inputs: { action: "shell.exec", command: "command string", cwd: "optional workspace-relative cwd", timeoutMs: "optional ms", maxOutputBytes: "optional bytes", run_in_background: "optional boolean", description: "optional label", maxLogBytes: "optional bytes" }
  },
  "process.start": {
    action: "process.start",
    inputs: { action: "process.start", command: "persistent command string", cwd: "optional cwd", description: "short label", timeoutMs: "optional ms", maxLogBytes: "optional bytes" }
  },
  "process.status": {
    action: "process.status",
    inputs: { action: "process.status", processId: "optional process id", sessionId: "optional session id" }
  },
  "process.list": {
    action: "process.list",
    inputs: { action: "process.list", sessionId: "optional session id", status: "optional status", limit: "optional number" }
  },
  "process.tail": {
    action: "process.tail",
    inputs: { action: "process.tail", processId: "process id", sessionId: "optional session id", lines: "optional number", maxBytes: "optional bytes" }
  },
  "process.grep": {
    action: "process.grep",
    inputs: { action: "process.grep", processId: "process id", sessionId: "optional session id", pattern: "regex or literal", maxMatches: "optional number", contextLines: "optional number" }
  },
  "process.stop": {
    action: "process.stop",
    inputs: { action: "process.stop", processId: "process id", sessionId: "optional session id" }
  },
  "code.test": {
    action: "code.test",
    inputs: { action: "code.test", command: "test/check command string", cwd: "optional cwd", timeoutMs: "optional ms" }
  },
  "code.lint": {
    action: "code.lint",
    inputs: { action: "code.lint", root: "optional root", include: "optional glob" }
  },
  "git.status": {
    action: "git.status",
    inputs: { action: "git.status", cwd: "optional cwd" }
  },
  "git.diff": {
    action: "git.diff",
    inputs: { action: "git.diff", cwd: "optional cwd", staged: "optional boolean" }
  },
  "git.log": {
    action: "git.log",
    inputs: { action: "git.log", cwd: "optional cwd", maxCommits: "optional number" }
  },
  "web.search": {
    action: "web.search",
    inputs: { action: "web.search", query: "search query", allowed_domains: "optional string[]", blocked_domains: "optional string[]", maxUses: "optional number" }
  },
  "web.fetch": {
    action: "web.fetch",
    inputs: { action: "web.fetch", url: "http(s) URL", timeoutMs: "optional ms", maxBytes: "optional bytes" }
  },
  "todo.write": {
    action: "todo.write",
    inputs: {
      action: "todo.write",
      todos: "array of {content:string,status:'pending'|'in_progress'|'completed'}"
    }
  },
  "blackboard.write": {
    action: "blackboard.write",
    inputs: { action: "blackboard.write", key: "stable dotted key", type: "entry type", value: "JSON value", visibility: "optional private | team | public", tags: "optional string[]" }
  },
  "blackboard.search": {
    action: "blackboard.search",
    inputs: { action: "blackboard.search", query: "optional text search", type: "optional entry type", tag: "optional tag", keyPrefix: "optional key prefix", taskId: "optional task id", agentId: "optional agent id", limit: "optional number" }
  },
  "blackboard.read": {
    action: "blackboard.read",
    inputs: { action: "blackboard.read", entryId: "entry id", key: "entry key", limit: "optional number" }
  },
  "blackboard.list": {
    action: "blackboard.list",
    inputs: { action: "blackboard.list", type: "optional entry type", tag: "optional tag", keyPrefix: "optional key prefix", taskId: "optional task id", agentId: "optional agent id", limit: "optional number" }
  },
  "agent.delegate": {
    action: "agent.delegate",
    inputs: {
      action: "agent.delegate",
      capability: "requested capability such as code.research, code.review, verify, architecture.design, bug.fix",
      task: "bounded internal task for the specialist",
      context: "optional concise context and evidence",
      preferred_agent_spec_id: "optional agent spec id from available_agent_specs",
      preferred_mode: "optional call_subagent | handoff | parallel",
      file_scope: "optional string[]; required for scoped_write implementation delegation"
    }
  }
};

async function parseCodingLoopModelResultWithRepair(
  text: string,
  objective: string,
  provider: OpenAIProvider
): Promise<CodingLoopModelResult> {
  const parsed = parseCodingLoopModelResult(text);
  if (parsed.message !== text || parsed.tool_calls.length > 0 || parsed.status !== "continue") {
    return parsed;
  }
  const repaired = await provider.generateText({
    model: provider.workerModel,
    system: [{
      text: [
        "You repair invalid JSON for Swarm's coding loop.",
        "Return exactly one valid JSON object and nothing else.",
        "The object must have keys: status, summary, message, files_touched, next_actions, tool_calls.",
        "status must be continue, completed, or failed.",
        "tool_calls must be an array."
      ].join(" "),
      cache: true
    }],
    user: JSON.stringify({
      objective,
      invalid_output: text
    }, null, 2),
    usage: { purpose: "coding_loop_json_repair" },
    maxOutputTokens: MODEL_OUTPUT_TOKENS_REPAIR
  });
  return parseCodingLoopModelResult(repaired);
}

function parseCodingLoopModelResult(text: string): CodingLoopModelResult {
  const parsed = parseJsonObject(text);
  const message = typeof parsed.message === "string" && parsed.message.trim()
    ? parsed.message
    : typeof parsed.details === "string" && parsed.details.trim()
      ? parsed.details
      : text;
  const status = parsed.status === "failed" ? "failed" : parsed.status === "completed" ? "completed" : "continue";
  return {
    status,
    message,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 240) : firstLine(message),
    tool_calls: parseToolCalls(parsed.tool_calls),
    files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.map(String) : [],
    next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map(String) : []
  };
}

function parseToolCalls(value: unknown): CodingLoopToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): CodingLoopToolCall | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        action: typeof item.action === "string" ? item.action : typeof item.type === "string" ? item.type : undefined,
        inputs: isRecord(item.inputs) ? item.inputs : {},
        reason: typeof item.reason === "string" ? item.reason : undefined
      };
    })
    .filter((item): item is CodingLoopToolCall => item !== undefined);
}

function partitionToolCalls(calls: CodingLoopToolCall[]): Array<{ concurrent: boolean; calls: CodingLoopToolCall[] }> {
  const batches: Array<{ concurrent: boolean; calls: CodingLoopToolCall[] }> = [];
  for (const call of calls) {
    let concurrent = false;
    try {
      if (call.action?.startsWith("mcp__")) {
        concurrent = false;
      } else if (call.action === SKILL_ACTIVATE_TOOL_NAME) {
        concurrent = false;
      } else {
        concurrent = isReadOnlyToolAction(normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action }));
      }
    } catch {
      concurrent = false;
    }
    const last = batches[batches.length - 1];
    if (concurrent && last?.concurrent) {
      last.calls.push(call);
    } else {
      batches.push({ concurrent, calls: [call] });
    }
  }
  return batches;
}

function isReadOnlyToolAction(action: ToolAction): boolean {
  return [
    "file.read",
    "file.list",
    "file.glob",
    "file.grep",
    "file.stat",
    "file.resolve",
    "json.read",
    "package.info",
    "project.detect",
    "git.status",
    "git.diff",
    "git.log",
    "web.search",
    "web.fetch",
    "blackboard.read",
    "blackboard.search",
    "blackboard.list"
  ].includes(action.type);
}

async function prepareToolOutput(
  sessionId: string,
  taskId: string,
  result: ToolResult,
  detail: string
): Promise<{ content?: string; outputRef?: string; data?: unknown }> {
  const data = result.data ?? result.metadata;
  const bytes = Buffer.byteLength(detail, "utf8");
  const shouldPersist = result.status === "failed" || bytes > TOOL_RESULT_PERSIST_THRESHOLD_BYTES;
  if (!shouldPersist) {
    return { content: detail, outputRef: result.outputRef, data };
  }
  const ref = await writeTaskOutput({ sessionId, taskId, attempt: 0, content: detail });
  return {
    content: bytes <= TOOL_RESULT_PERSIST_THRESHOLD_BYTES
      ? detail
      : truncateMiddle(detail, TOOL_RESULT_PERSIST_PREVIEW_BYTES, ref.bytes, ref.lines, ref.path),
    outputRef: ref.path,
    data: isRecord(data) ? { ...data, outputRef: ref } : { value: data, outputRef: ref }
  };
}

function compactToolResultHistory(results: CodingLoopToolResult[]): CodingLoopToolResult[] {
  const keepFullFrom = Math.max(0, results.length - TOOL_RESULT_FULL_HISTORY_LIMIT);
  return results.map((result, index) => index >= keepFullFrom ? result : compactHistoricalToolResult(result));
}

function compactHistoricalToolResult(result: CodingLoopToolResult): CodingLoopToolResult {
  const ref = outputRefPath(result.outputRef) ?? outputRefPathFromData(result.data);
  const metadata = outputRefMetadata(result.outputRef, result.data);
  const content = [
    `${result.action}: ${result.summary}`,
    ref ? `Full output: ${ref}` : undefined,
    metadata ? `Original output: ${metadata}` : undefined,
    result.content ? `Preview:\n${truncateTextBytes(result.content, TOOL_RESULT_SUMMARY_PREVIEW_BYTES)}` : undefined
  ].filter(Boolean).join("\n");
  return {
    ...result,
    content,
    data: compactToolResultData(result.data, ref)
  };
}

function compactToolResultData(data: unknown, ref?: string): unknown {
  if (isRecord(data)) {
    const compacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if ((key === "content" || key === "stdout" || key === "stderr" || key === "text") && typeof value === "string") {
        compacted[`${key}_preview`] = truncateTextBytes(value, TOOL_RESULT_SUMMARY_PREVIEW_BYTES);
        continue;
      }
      compacted[key] = value;
    }
    if (ref) {
      compacted.outputRef = compacted.outputRef ?? ref;
    }
    return compacted;
  }
  return ref ? { outputRef: ref } : data;
}

function outputRefPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (isRecord(value) && typeof value.path === "string") {
    return value.path;
  }
  return undefined;
}

function outputRefPathFromData(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  return outputRefPath(data.outputRef);
}

function outputRefMetadata(outputRef: unknown, data: unknown): string | undefined {
  const value = isRecord(outputRef)
    ? outputRef
    : isRecord(data) && isRecord(data.outputRef)
      ? data.outputRef
      : undefined;
  if (!value) {
    return undefined;
  }
  const bytes = typeof value.bytes === "number" ? `${value.bytes} bytes` : undefined;
  const lines = typeof value.lines === "number" ? `${value.lines} lines` : undefined;
  return [bytes, lines].filter(Boolean).join(", ") || undefined;
}

function codingLoopResultFromTool(
  id: string,
  action: string,
  result: ToolResult
): CodingLoopToolResult {
  return {
    id,
    action,
    status: result.status ?? "success",
    summary: result.summary,
    content: result.content,
    outputRef: result.outputRef,
    data: result.data ?? result.metadata,
    errors: result.errors,
    errorCode: result.errorCode,
    recoverySuggestion: result.recoverySuggestion
  };
}

function collectOutcome(
  result: CodingLoopToolResult,
  changedFiles: Set<string>,
  testsRun: Set<string>,
  intermediateArtifacts: Set<string>
): void {
  if (result.outputRef) {
    intermediateArtifacts.add(result.outputRef);
  }
  if (result.action === "code.test" || result.action === "code.lint") {
    testsRun.add(result.summary);
  }
  collectPaths(result.data, changedFiles, intermediateArtifacts);
}

function collectPaths(value: unknown, changedFiles: Set<string>, intermediateArtifacts: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPaths(item, changedFiles, intermediateArtifacts));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const operation = typeof value.operation === "string" ? value.operation : "";
  const path = typeof value.path === "string" ? value.path : undefined;
  if (path && ["create", "update", "edit"].includes(operation)) {
    changedFiles.add(path);
  }
  const outputRef = value.outputRef;
  if (isRecord(outputRef) && typeof outputRef.path === "string") {
    intermediateArtifacts.add(outputRef.path);
  }
}

export function summarizeCodingLoopFinalStatus(input: CodingLoopFinalStatusInput): CodingLoopFinalStatus {
  const lastFailure = [...input.toolResults].reverse().find((result) => result.status === "failed");
  const summary = firstLine(input.content);
  if (input.stopRequested) {
    return { status: "stopped", summary };
  }
  if (input.modelStatus === "failed") {
    return { status: "failed", summary };
  }
  if (input.budgetExhausted) {
    return {
      status: "failed",
      summary: [summary, "Budget exhausted before completion."].filter(Boolean).join(" ")
    };
  }
  if (input.unresolvedFailure && lastFailure) {
    return {
      status: "failed",
      summary: [summary, `Failed tool: ${firstLine(lastFailure.summary)}`].filter(Boolean).join(" ")
    };
  }
  return { status: "completed", summary };
}

export function hasUnresolvedToolFailure(input: ToolFailureRecoveryStateInput): boolean {
  if (!input.toolResults.length) {
    return false;
  }
  const lastFailedIndex = findLastToolResultIndex(input.toolResults, (result) => result.status === "failed");
  if (lastFailedIndex < 0) {
    return false;
  }
  const hasLaterSuccess = input.toolResults.slice(lastFailedIndex + 1).some((result) => result.status === "success" || result.status === "partial");
  if (hasLaterSuccess) {
    return false;
  }
  const finalText = (input.finalText ?? "").toLowerCase();
  return !/\b(recovered|resolved|fixed|reran|retried|passed|succeeded|worked around)\b/.test(finalText);
}

function findLastToolResultIndex(
  results: Array<{ status: "success" | "partial" | "failed"; summary: string }>,
  predicate: (result: { status: "success" | "partial" | "failed"; summary: string }) => boolean
): number {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (predicate(results[index])) {
      return index;
    }
  }
  return -1;
}

export function formatToolFailureContent(
  action: string,
  reason: string,
  errorCode?: string,
  recoverySuggestion?: string
): string {
  return [
    `ERROR: ${reason}`,
    errorCode ? `Error code: ${errorCode}` : undefined,
    recoverySuggestion ? `Recovery: ${recoverySuggestion}` : undefined,
    `Action: ${action}`
  ].filter(Boolean).join("\n");
}

function truncateMiddle(content: string, maxBytes: number, totalBytes: number, totalLines: number, path: string): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = maxBytes - headBytes;
  const omitted = Math.max(0, totalBytes - headBytes - tailBytes);
  return [
    buffer.subarray(0, headBytes).toString("utf8").trimEnd(),
    "",
    `[... ${omitted} bytes omitted from ${totalLines} lines. Full output: ${path}]`,
    "",
    buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8").trimStart()
  ].join("\n");
}

function truncateTextBytes(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  return [
    buffer.subarray(0, maxBytes).toString("utf8").trimEnd(),
    "",
    `[... ${buffer.length - maxBytes} bytes omitted]`
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function classifyToolError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "ENOENT") return "FS_NOT_FOUND";
    if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
    if (code === "ENOTDIR" || code === "EISDIR") return "INVALID_INPUT";
    if (code) return `FS_${code}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied/i.test(message)) return "PERMISSION_DENIED";
  if (/requires|invalid|unsupported/i.test(message)) return "INVALID_INPUT";
  return "TOOL_FAILED";
}

function recoverySuggestionForToolError(errorCode: string | undefined, message: string): string {
  if (errorCode === "PERMISSION_DENIED") {
    return "Inspect the approval or permission rule, then retry with a narrower command or explicitly allow the action.";
  }
  if (errorCode === "FS_NOT_FOUND") {
    return "Run file.list, file.glob, or git.status to confirm the path, then retry with the resolved workspace-relative path.";
  }
  if (errorCode === "INVALID_INPUT") {
    return "Correct the tool arguments and retry; use file.read or tool context to build a more precise request.";
  }
  if (/timeout|timed out/i.test(message)) {
    return "Retry with a longer timeout or a narrower command that produces less output.";
  }
  return "Inspect the tool output, adjust the command or inputs, and retry from the current workspace state.";
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "Completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
