import { randomUUID } from "node:crypto";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, toolRequiresApproval } from "../tools/permissions.js";
import type { AgentDelegateAction, LocalToolContext, ToolAction, ToolApprovalRequest, ToolResult } from "../tools/types.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import type { SwarmSettings } from "../config/settings.js";
import { RuntimeEvents, type SessionOutcome } from "./events.js";
import type { ExecutionResult, ToolApprovalHandler } from "./orchestrator.js";
import { WorkerStateStore } from "../storage/worker-state-store.js";
import type { AgentInvocationRequest } from "./agent-specs.js";

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
};

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
  emitFinal?: boolean;
  emitProgress?: boolean;
  workerId?: string;
  workerStore?: WorkerStateStore;
  invokeAgent?: (request: AgentInvocationRequest) => Promise<ToolResult>;
  agentInstructions?: string;
  allowedTools?: string[];
  writePolicy?: "read_only" | "scoped_write" | "workspace_write";
};

const MAX_LOOP_TURNS = 12;
const MAX_TOOL_CALLS = 50;
const MAX_DELEGATE_DEPTH = 1;
const LONG_OUTPUT_THRESHOLD_BYTES = 32_000;
const LONG_OUTPUT_PREVIEW_BYTES = 18_000;

export class CodingAgentLoop {
  private readonly liveMessages: LiveUserMessage[] = [];
  private readonly controlDecisions: ControlDecision[] = [];
  private nextLiveSeq = 1;
  private sessionId = "";
  private currentPhase = "idle";
  private lastResultSummary = "";
  private interruptRequested = false;

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

  async run(objective: string): Promise<ExecutionResult> {
    const role = this.options.role ?? "main";
    const maxTurns = this.options.maxTurns ?? MAX_LOOP_TURNS;
    const maxToolCalls = this.options.maxToolCalls ?? MAX_TOOL_CALLS;
    const sessionId = role === "worker" ? `worker_loop_${randomUUID()}` : `loop_${randomUUID()}`;
    this.sessionId = sessionId;
    const toolResults: CodingLoopToolResult[] = [];
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
          summary: "Worker stopped by main Swarm",
          message: "Worker stopped before completion.",
          tool_calls: [],
          files_touched: [],
          next_actions: []
        };
        break;
      }
      this.currentPhase = `turn_${turn}:thinking`;
      const turnTaskId = `${role === "worker" ? sessionId : "coding"}_turn_${turn}`;
      this.options.events.emitEvent({
        type: "task_attempt",
        task_id: turnTaskId,
        title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
        attempt: turn,
        status: "started"
      });
      const modelText = await this.options.provider.generateText({
        model: this.options.provider.workerModel,
        system: codingLoopSystemPrompt({
          role,
          delegateAvailable: (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) > 0,
          agentInstructions: this.options.agentInstructions,
          allowedTools: this.options.allowedTools,
          writePolicy: this.options.writePolicy
        }),
        user: JSON.stringify(
          {
            objective,
            role,
            parent_session_id: this.options.parentSessionId,
            live_user_messages: this.liveMessages,
            control_decisions: this.controlDecisions,
            tool_results: toolResults,
            loop: {
              turn,
              remaining_turns: maxTurns - turn,
              remaining_tool_calls: maxToolCalls - toolCallCount
            }
          },
          null,
          2
        )
      });
      lastResult = await parseCodingLoopModelResultWithRepair(modelText, objective, this.options.provider);
      this.lastResultSummary = lastResult.summary;
      for (const file of lastResult.files_touched) {
        changedFiles.add(file);
      }

      if (lastResult.status !== "continue" || lastResult.tool_calls.length === 0 || toolCallCount >= maxToolCalls) {
        this.options.events.emitEvent({
          type: "task_attempt",
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
          break;
        }
        if (this.isStopRequested()) {
          lastResult = {
            status: "failed",
            summary: "Worker stopped by main Swarm",
            message: "Worker stopped before starting the next tool batch.",
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
          const executed = await Promise.all(
            batch.calls.slice(0, maxToolCalls - toolCallCount).map((call) => this.executeToolCall(call, sessionId))
          );
          toolCallCount += executed.length;
          for (const item of executed) {
            toolResults.push(item.result);
            collectOutcome(item.result, changedFiles, testsRun, intermediateArtifacts);
          }
        } else {
          for (const call of batch.calls) {
            if (toolCallCount >= maxToolCalls) {
              break;
            }
            if (this.isStopRequested()) {
              lastResult = {
                status: "failed",
                summary: "Worker stopped by main Swarm",
                message: "Worker stopped before starting the next tool.",
                tool_calls: [],
                files_touched: [...changedFiles],
                next_actions: []
              };
              break;
            }
            const item = await this.executeToolCall(call, sessionId);
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

      this.options.events.emitEvent({
        type: "task_attempt",
        task_id: turnTaskId,
        title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
        attempt: turn,
        status: "completed"
      });
      if (this.options.emitProgress !== false) {
        this.options.events.emitEvent({ type: "progress", completed: turn, total: maxTurns });
      }
    }

    const content = lastResult.message || lastResult.summary || "Coding loop completed.";
    const outcome: SessionOutcome = {
      changed_files: [...changedFiles],
      intermediate_artifacts: [...intermediateArtifacts],
      tests_run: [...testsRun],
      final_summary: firstLine(content)
    };
    if (this.options.emitFinal !== false) {
      this.options.events.emitEvent({ type: "final", session_id: sessionId, content, outcome });
    }
    this.currentPhase = "idle";
    return { session_id: sessionId, content, outcome };
  }

  private isStopRequested(): boolean {
    if (!this.options.workerId || !this.options.workerStore) {
      return false;
    }
    return this.options.workerStore.get(this.options.workerId)?.status === "stopped";
  }

  private async decideControl(message: LiveUserMessage): Promise<ControlDecision> {
    const content = await this.options.provider.generateText({
      model: this.options.provider.workerModel,
      system: [
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
      user: JSON.stringify({
        live_message: message,
        current_phase: this.currentPhase,
        last_result_summary: this.lastResultSummary,
        recent_live_messages: this.liveMessages.slice(-6),
        recent_control_decisions: this.controlDecisions.slice(-6)
      }, null, 2)
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

  private async executeToolCall(call: CodingLoopToolCall, sessionId: string): Promise<{ result: CodingLoopToolResult }> {
    const id = call.id ?? `tool_${randomUUID()}`;
    try {
      const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
      if (this.options.allowedTools && !this.options.allowedTools.includes(action.type)) {
        throw new Error(`Tool action is not allowed for this agent persona: ${action.type}`);
      }
      if (toolRequiresApproval(action, this.options.settings)) {
        if (!this.options.approvalHandler) {
          throw new Error(`Tool action requires approval but no approval handler is available: ${action.type}`);
        }
        const request = createToolApprovalRequest(action);
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
        errorCode: rawResult.errorCode
      };
      this.options.events.emitEvent({
        type: "tool_result",
        task_id: id,
        title: call.reason ?? action.type,
        action: action.type,
        summary: rawResult.summary,
        content: prepared.content,
        status: result.status,
        outputRef: prepared.outputRef,
        errorCode: rawResult.errorCode
      });
      return { result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
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
        errors: [reason],
        errorCode: classifyToolError(error)
      };
      this.options.events.emitEvent({
        type: "tool_result",
        task_id: id,
        title: call.reason ?? String(result.action),
        action: String(result.action),
        summary: reason,
        status: "failed",
        errorCode: result.errorCode
      });
      return { result };
    }
  }

  private async delegateWorker(action: AgentDelegateAction, sessionId: string, parentTaskId: string): Promise<ToolResult> {
    if (this.options.invokeAgent) {
      return this.options.invokeAgent({
        parent_session_id: sessionId,
        requested_by: this.options.workerId ?? "main_swarm",
        capability: action.capability,
        task: action.task,
        context: action.context,
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
      const status = stopped ? "stopped" : "completed";
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
        status: status === "completed" ? "success" : "partial",
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

function codingLoopSystemPrompt(input: {
  role: "main" | "worker";
  delegateAvailable: boolean;
  agentInstructions?: string;
  allowedTools?: string[];
  writePolicy?: "read_only" | "scoped_write" | "workspace_write";
}): string {
  const defaultTools = [
    "file.read",
    "file.list",
    "file.glob",
    "file.grep",
    "file.stat",
    "file.write",
    "file.edit",
    "shell.exec",
    "code.test",
    "code.lint",
    "git.status",
    "git.diff",
    "git.log",
    "todo.write",
    input.delegateAvailable ? "agent.delegate" : undefined
  ].filter(Boolean) as string[];
  const tools = input.allowedTools?.length ? input.allowedTools.join(", ") : defaultTools.join(", ");
  return [
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
    `Allowed tools: ${tools}.`,
    input.writePolicy ? `Write policy: ${input.writePolicy}. Never use tools outside this policy.` : undefined,
    input.agentInstructions,
    "Read existing files before editing them. For edits, read the full file first.",
    "Prefer file.edit for existing files and file.write for new files. Do not write final reports unless requested.",
    "For tool_calls, each item is {id, action, inputs, reason}.",
    input.delegateAvailable
      ? "Use agent.delegate only for bounded research, critique, or planning help; the main Swarm remains responsible for user-facing synthesis and real workspace edits."
      : "Do not use agent.delegate in this loop.",
    "Keep message grounded in actual tool results. Mention verification commands that were run."
    , input.role === "main"
      ? "Live user messages are part of the main Swarm conversation, not side-channel chat."
      : "Live user messages are controller context; do not treat them as direct worker chat.",
    "Always obey the newest live user messages and control_decisions. If they redirect the task, stop pursuing the old target after the current safe boundary."
  ].filter(Boolean).join(" ");
}

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
    system: [
      "You repair invalid JSON for Swarm's coding loop.",
      "Return exactly one valid JSON object and nothing else.",
      "The object must have keys: status, summary, message, files_touched, next_actions, tool_calls.",
      "status must be continue, completed, or failed.",
      "tool_calls must be an array."
    ].join(" "),
    user: JSON.stringify({
      objective,
      invalid_output: text
    }, null, 2)
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
      concurrent = isReadOnlyToolAction(normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action }));
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
    "git.status",
    "git.diff",
    "git.log"
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
  if (bytes <= LONG_OUTPUT_THRESHOLD_BYTES) {
    return { content: detail, outputRef: result.outputRef, data };
  }
  const ref = await writeTaskOutput({ sessionId, taskId, attempt: 0, content: detail });
  return {
    content: truncateMiddle(detail, LONG_OUTPUT_PREVIEW_BYTES, ref.bytes, ref.lines, ref.path),
    outputRef: ref.path,
    data: isRecord(data) ? { ...data, outputRef: ref } : { value: data, outputRef: ref }
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
    if (code) return `FS_${code}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied/i.test(message)) return "PERMISSION_DENIED";
  if (/requires|invalid|unsupported/i.test(message)) return "INVALID_INPUT";
  return "TOOL_FAILED";
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "Completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
