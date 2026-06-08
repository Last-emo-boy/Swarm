import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { LOCAL_TOOL_SCHEMAS, localToolSchemaForModel, validateLocalToolActionInputs } from "../tools/tool-contracts.js";
import { createToolApprovalRequest, decideToolPermission } from "../tools/permissions.js";
import type { AgentDelegateAction, FileLockEvent, LocalToolContext, ToolAction, ToolResult, WorkspaceChangeMetadata } from "../tools/types.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import { ToolContentReplacementStore } from "../storage/tool-content-replacement-store.js";
import { OpenAIProvider, type PromptBlock } from "../providers/openai-provider.js";
import type { SwarmSettings } from "../config/settings.js";
import { RuntimeEvents, type RuntimeAgentIdentity, type SessionOutcome } from "./events.js";
import type { CheckpointSummary } from "./checkpoints.js";
import type { ExecutionResult, ToolApprovalHandler } from "./orchestrator.js";
import { WorkerStateStore } from "../storage/worker-state-store.js";
import { listAgentSpecs, type AgentInvocationRequest, type AgentSpec, type AgentSpecSource } from "./agent-specs.js";
import { delegatedToolStatus, workerStatusFromExecutionStatus } from "./execution-status.js";
import { SKILL_ACTIVATE_CAPABILITY_ID, SKILL_ACTIVATE_TOOL_NAME } from "../extensions/skills.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import { renderHostEnvironmentPrompt } from "./host-context.js";
import { applyToolResultBudget, createContentReplacementState, type ContentReplacementState } from "./tool-result-budget.js";
import type { WorkspaceIndex } from "./workspace-index.js";
import { workspaceIndexSummary } from "./workspace-index.js";
import type { RecoveryAdvice } from "./recovery.js";
import { formatRecoveryAdvice, recoveryAdviceFromToolFailure } from "./recovery.js";
import {
  assertCapabilityAllowedBySandbox,
  assertToolActionAllowedBySandbox,
  formatSandboxFailureDetail,
  sandboxDecisionFromError,
  sandboxDecisionFromUnknown,
  sandboxFailureSummary,
  sandboxRecoverySuggestion,
  isReadOnlySandboxAction,
  type SandboxDecision,
  type SandboxWritePolicy
} from "./sandbox-policy.js";
import { taskContractForToolAction } from "./tool-task-sandbox.js";
import { attachApprovalGovernance, shouldRecordGovernanceEvidence } from "./safety-governance.js";
import type { LspRange } from "../lsp/types.js";

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
  recovery?: RecoveryAdvice;
  metadata?: Record<string, unknown>;
  sandbox?: SandboxDecision;
};

type SemanticEvidencePromptItem = {
  evidence_id: string;
  source: string;
  action: string;
  status: string;
  lsp_status?: string;
  symbol?: string;
  range?: LspRange;
  confidence?: number;
  staleness?: string;
  stale_reason?: string;
  fallback_used?: boolean;
  fallback_reason?: string;
  fallback_tools?: string[];
  next_action?: string;
  summary?: string;
  result_keys?: string[];
  primary_refs?: string[];
  changed_files?: string[];
  tool_result_id: string;
  tool_status: string;
};

type DeferredToolCatalogSummary = {
  deferred_mcp_tools: number;
  searchable_skills: number;
  providers: Array<{ provider_id: string; count: number }>;
  hint: string;
};

type ToolSearchMatch = {
  action: string;
  capabilityId: string;
  kind: string;
  name: string;
  title?: string;
  description: string;
  providerId: string;
  permissionName: string;
  searchHint?: string;
  readOnly?: boolean;
  concurrencyClass?: ToolConcurrencyClass;
  loadNextTurn: boolean;
  activationName?: string;
  score?: number;
};

export type ToolConcurrencyClass =
  | "read_parallel"
  | "delegate_parallel"
  | "write_exclusive"
  | "verify_exclusive"
  | "background_process"
  | "network_limited";

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

export type CodingLoopOutcomeSignals = {
  changed_files: string[];
  intermediate_artifacts: string[];
};

export type CodingLoopCacheLabQualityVerdict = "pass" | "warning" | "fail";

export type CodingLoopCacheLabReplay = {
  label: string;
  cacheKey?: string;
  system: PromptBlock[];
  user: PromptBlock[];
  cachedInputTokens?: number;
  totalInputWithCacheTokens?: number;
  qualityVerdict?: CodingLoopCacheLabQualityVerdict;
  qualityReason?: string;
};

export type CodingLoopCacheLabResult = {
  label: string;
  cacheKey?: string;
  stablePrefixIdentity?: string;
  stableSectionHashes: Record<string, string>;
  stablePrefixTokensEstimate: number;
  volatileTailTokensEstimate: number;
  hitRate?: number;
  cachedInputTokens?: number;
  totalInputWithCacheTokens?: number;
  prefixDrift: boolean;
  changedSections: string[];
  missReason?: "cold_start" | "prefix_drift" | "provider_omitted_usage" | "unknown";
  qualityVerdict: CodingLoopCacheLabQualityVerdict;
  qualityReason?: string;
};

export type CodingLoopCacheLabReport = {
  baseline?: CodingLoopCacheLabResult;
  replays: CodingLoopCacheLabResult[];
  stablePrefixSections: string[];
  volatileTailSections: string[];
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

export type ControlDecision = {
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
  checkpoint?: CheckpointSummary;
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
  workspaceIndex?: WorkspaceIndex;
  invokeAgent?: (request: AgentInvocationRequest) => Promise<ToolResult>;
  agentControl?: LocalToolContext["agentControl"];
  taskControl?: LocalToolContext["taskControl"];
  worktreeControl?: LocalToolContext["worktreeControl"];
  runtimeControl?: LocalToolContext["runtimeControl"];
  externalContext?: LocalToolContext["externalContext"];
  workspaceForSession?: (sessionId: string) => string;
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
      writePolicy?: SandboxWritePolicy;
      fileScope?: string[];
    }
  ) => Promise<ToolResult>;
  durableContext?: (sessionId: string) => string | Promise<string>;
  agentMemoryContext?: (sessionId: string) => string | Promise<string>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  agentInstructions?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  writePolicy?: SandboxWritePolicy;
  fileScope?: string[];
  expectedSideEffects?: string;
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
const WORKSPACE_CONTEXT_BLOCK_LIMIT = 20;
const WORKSPACE_CONTEXT_TOKEN_BUDGET = 4_000;
const TOOL_RESULT_PER_TURN_BUDGET_BYTES = 24_000;
const TOOL_RESULT_FRESH_BUDGET_BYTES = 8_000;
const MODEL_OUTPUT_TOKENS_MAIN_LOOP = 8_000;
const MODEL_OUTPUT_TOKENS_WORKER_LOOP = 6_000;
const MODEL_OUTPUT_TOKENS_CONTROL = 1_200;
const MODEL_OUTPUT_TOKENS_REPAIR = MODEL_OUTPUT_TOKENS_MAIN_LOOP;
const ACTIVITY_PREVIEW_LENGTH = 80;
const TOOL_SEARCH_TOOL_NAME = "ToolSearch";
export const DEFAULT_TOOL_NAMES = [
  "Read",
  "Glob",
  "Grep",
  "lsp.diagnostics",
  "lsp.hover",
  "lsp.definition",
  "lsp.references",
  "lsp.document_symbols",
  "lsp.workspace_symbols",
  "lsp.completion",
  "lsp.code_actions",
  "lsp.rename_preview",
  "lsp.format",
  "Write",
  "Edit",
  "file.delete",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "code.test",
  "code.lint",
  "ProcessStart",
  "ProcessStatus",
  "ProcessList",
  "ProcessTail",
  "ProcessGrep",
  "ProcessStop",
  "WebSearch",
  "WebFetch",
  "Config",
  "McpResources",
  "McpRead",
  "McpAuth",
  "McpCall",
  "SkillInvoke",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "BlackboardWrite",
  "BlackboardSearch",
  "BlackboardRead",
  "BlackboardList",
  "AgentList",
  "AgentStatus",
  "AgentStop",
  "AgentContinue",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "AgentMessage",
  "RuntimeSleep",
  "StructuredOutput",
  "ReplMode",
  "ScheduleCreate",
  "ScheduleList",
  "ScheduleDelete",
  "RemoteTrigger",
  "TeamCreate",
  "TeamDelete"
] as const;

export class CodingAgentLoop {
  private readonly liveMessages: LiveUserMessage[] = [];
  private readonly controlDecisions: ControlDecision[] = [];
  private readonly discoveredDynamicToolNames = new Set<string>();
  private nextLiveSeq = 1;
  private sessionId = "";
  private currentPhase = "idle";
  private lastResultSummary = "";
  private interruptRequested = false;
  private stopRequested = false;
  private stopReason = "";

  constructor(private readonly options: CodingLoopOptions) {}

  private activityAgentIdentity(): RuntimeAgentIdentity | undefined {
    if (!this.options.workerId) {
      return undefined;
    }
    const worker = this.options.workerStore?.get(this.options.workerId);
    return {
      worker_id: this.options.workerId,
      agent_id: worker?.agent_spec_id ?? worker?.capability ?? this.options.workerId,
      role: this.options.role ?? "worker",
      capability: worker?.capability,
      display_name: worker?.display_name,
      role_title: worker?.role_title,
      agent_spec_id: worker?.agent_spec_id,
      invocation_mode: worker?.invocation_mode
    };
  }

  async submitUserMessage(content: string, options: { requestId?: string } = {}): Promise<ControlDecision> {
    const message: LiveUserMessage = {
      id: options.requestId ?? `live_${randomUUID()}`,
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

  requestInterrupt(instruction: string, options: { requestId?: string } = {}): ControlDecision {
    const message: LiveUserMessage = {
      id: options.requestId ?? `live_${randomUUID()}`,
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
    return decision;
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
      this.emitActivity(sessionId, "thinking", `${role === "worker" ? "Worker" : "Swarm"} is thinking`, { turn, maxTurns, taskId: turnTaskId });
      this.options.events.emitEvent({
        type: "task_attempt",
        session_id: sessionId,
        task_id: turnTaskId,
        title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
        attempt: turn,
        status: "started"
      });
      let modelCapabilities: CapabilityDescriptor[] = [];
      try {
        const delegateAvailable = (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) > 0;
        modelCapabilities = await this.options.listModelCapabilities?.() ?? [];
        const durableContext = await this.options.durableContext?.(sessionId) ?? "";
        const agentMemoryContext = await this.options.agentMemoryContext?.(sessionId) ?? "";
        const availableTools = allowedToolNames(
          this.options.allowedTools,
          this.options.disallowedTools,
          delegateAvailable,
          modelCapabilities,
          this.discoveredDynamicToolNames,
          this.options.writePolicy
        );
        const dynamicToolSchemas = dynamicCapabilityToolSchemas(modelCapabilities, this.discoveredDynamicToolNames);
        const deferredToolCatalog = renderDeferredToolCatalog(modelCapabilities, this.discoveredDynamicToolNames);
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
          systemPrompt: this.options.systemPrompt,
          appendSystemPrompt: this.options.appendSystemPrompt,
          agentInstructions: this.options.agentInstructions,
          availableTools,
          writePolicy: this.options.writePolicy,
          expectedSideEffects: this.options.expectedSideEffects,
          additionalReadDirectories: this.options.settings.permissions.additionalDirectories
        });
        const userPrompt = codingLoopUserPrompt({
          objective,
          role,
          parentSessionId: this.options.parentSessionId,
          availableTools,
          dynamicToolSchemas,
          deferredToolCatalog,
          settings: this.options.settings,
          workspace: this.options.workspace,
          durableContext,
          agentMemoryContext,
          workspaceIndex: this.options.workspaceIndex,
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
          responseFormat: "json_object",
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
      const workspaceCompletionGap = workspaceCompletionGapResult(lastResult, changedFiles, {
        expectedSideEffects: this.options.expectedSideEffects,
        writePolicy: this.options.writePolicy
      });
      if (workspaceCompletionGap) {
        toolResults.push(workspaceCompletionGap);
        this.options.events.emitEvent({
          type: "tool_result",
          session_id: sessionId,
          task_id: workspaceCompletionGap.id,
          title: "Verify workspace completion claim",
          action: workspaceCompletionGap.action,
          summary: workspaceCompletionGap.summary,
          content: workspaceCompletionGap.content,
          status: workspaceCompletionGap.status,
          errorCode: workspaceCompletionGap.errorCode,
          recoverySuggestion: workspaceCompletionGap.recoverySuggestion,
          attempt: turn,
          agent: this.activityAgentIdentity()
        });
        if (turn < maxTurns) {
          lastResult = {
            status: "continue",
            summary: workspaceCompletionGap.summary,
            message: workspaceCompletionGap.content ?? workspaceCompletionGap.summary,
            tool_calls: [],
            files_touched: [],
            next_actions: ["Use file.write or file.edit to make the requested workspace change, then report only verified changes."]
          };
          this.emitActivity(sessionId, "turn_complete", `Needs workspace evidence: ${workspaceCompletionGap.summary}`, { turn, maxTurns, taskId: turnTaskId });
          this.options.events.emitEvent({
            type: "task_attempt",
            session_id: sessionId,
            task_id: turnTaskId,
            title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
            attempt: turn,
            status: "completed"
          });
          if (this.options.emitProgress !== false) {
            this.options.events.emitEvent({ type: "progress", completed: turn, total: maxTurns });
          }
          continue;
        }
        lastResult = {
          status: "failed",
          summary: workspaceCompletionGap.summary,
          message: workspaceCompletionGap.content ?? workspaceCompletionGap.summary,
          tool_calls: [],
          files_touched: [],
          next_actions: ["Retry with enough turns to perform the requested write through file.write or file.edit."]
        };
      }

      const verificationCompletionGap = verificationCompletionGapResult(objective, lastResult, testsRun, toolResults);
      if (verificationCompletionGap) {
        toolResults.push(verificationCompletionGap);
        this.options.events.emitEvent({
          type: "tool_result",
          session_id: sessionId,
          task_id: verificationCompletionGap.id,
          title: "Verify completion evidence",
          action: verificationCompletionGap.action,
          summary: verificationCompletionGap.summary,
          content: verificationCompletionGap.content,
          status: verificationCompletionGap.status,
          errorCode: verificationCompletionGap.errorCode,
          recoverySuggestion: verificationCompletionGap.recoverySuggestion,
          attempt: turn,
          agent: this.activityAgentIdentity()
        });
        if (turn < maxTurns) {
          lastResult = {
            status: "continue",
            summary: verificationCompletionGap.summary,
            message: verificationCompletionGap.content ?? verificationCompletionGap.summary,
            tool_calls: [],
            files_touched: [...changedFiles],
            next_actions: [verificationCompletionGap.recoverySuggestion ?? "Run the required verification command or report a concrete blocker."]
          };
          this.emitActivity(sessionId, "turn_complete", `Needs verification evidence: ${verificationCompletionGap.summary}`, { turn, maxTurns, taskId: turnTaskId });
          this.options.events.emitEvent({
            type: "task_attempt",
            session_id: sessionId,
            task_id: turnTaskId,
            title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
            attempt: turn,
            status: "completed"
          });
          if (this.options.emitProgress !== false) {
            this.options.events.emitEvent({ type: "progress", completed: turn, total: maxTurns });
          }
          continue;
        }
        lastResult = {
          status: "failed",
          summary: verificationCompletionGap.summary,
          message: verificationCompletionGap.content ?? verificationCompletionGap.summary,
          tool_calls: [],
          files_touched: [...changedFiles],
          next_actions: [verificationCompletionGap.recoverySuggestion ?? "Retry with enough turns to run verification."]
        };
      }

      const workspaceTransactionConflict = lastResult.status === "completed"
        ? await workspaceTransactionConflictResult(this.options.workspace, changedFiles)
        : undefined;
      if (workspaceTransactionConflict) {
        toolResults.push(workspaceTransactionConflict);
        this.options.events.emitEvent({
          type: "tool_result",
          session_id: sessionId,
          task_id: workspaceTransactionConflict.id,
          title: "Inspect workspace transaction",
          action: workspaceTransactionConflict.action,
          summary: workspaceTransactionConflict.summary,
          content: workspaceTransactionConflict.content,
          status: workspaceTransactionConflict.status,
          errorCode: workspaceTransactionConflict.errorCode,
          recoverySuggestion: workspaceTransactionConflict.recoverySuggestion,
          attempt: turn,
          agent: this.activityAgentIdentity()
        });
        if (turn < maxTurns) {
          lastResult = {
            status: "continue",
            summary: workspaceTransactionConflict.summary,
            message: workspaceTransactionConflict.content ?? workspaceTransactionConflict.summary,
            tool_calls: [],
            files_touched: [...changedFiles],
            next_actions: [workspaceTransactionConflict.recoverySuggestion ?? "Repair the detected workspace conflict before returning completed."]
          };
          this.emitActivity(sessionId, "turn_complete", `Needs transaction repair: ${workspaceTransactionConflict.summary}`, { turn, maxTurns, taskId: turnTaskId });
          this.options.events.emitEvent({
            type: "task_attempt",
            session_id: sessionId,
            task_id: turnTaskId,
            title: role === "worker" ? "Worker loop turn" : "Coding loop turn",
            attempt: turn,
            status: "completed"
          });
          if (this.options.emitProgress !== false) {
            this.options.events.emitEvent({ type: "progress", completed: turn, total: maxTurns });
          }
          continue;
        }
        lastResult = {
          status: "failed",
          summary: workspaceTransactionConflict.summary,
          message: workspaceTransactionConflict.content ?? workspaceTransactionConflict.summary,
          tool_calls: [],
          files_touched: [...changedFiles],
          next_actions: [workspaceTransactionConflict.recoverySuggestion ?? "Repair the detected workspace conflict and retry."]
        };
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
        this.emitActivity(sessionId, "turn_complete", `Step complete: ${firstLine(lastResult.summary) || "no tools requested"}`, { turn, maxTurns, taskId: turnTaskId });
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

      const turnDiscoveredToolNames = new Set<string>();
      const batches = partitionToolCalls(lastResult.tool_calls, {
        agentSpecs: listAgentSpecs({ settings: this.options.settings, workspace: this.options.workspace }),
        maxParallel: this.options.settings.runtime.maxParallelTasks
      });
      let stopToolExecutionForFeedback = false;
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
            calls.map((call) => this.executeToolCall(call, sessionId, turn, modelCapabilities, turnDiscoveredToolNames))
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
            const item = await this.executeToolCall(call, sessionId, turn, modelCapabilities, turnDiscoveredToolNames);
            toolCallCount += 1;
            toolResults.push(item.result);
            collectOutcome(item.result, changedFiles, testsRun, intermediateArtifacts);
            if (item.result.status === "failed") {
              stopToolExecutionForFeedback = true;
              break;
            }
          }
        }
        if (stopToolExecutionForFeedback) {
          break;
        }
        if (this.interruptRequested) {
          this.interruptRequested = false;
          break;
        }
      }

      for (const toolName of turnDiscoveredToolNames) {
        this.discoveredDynamicToolNames.add(toolName);
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
      this.emitActivity(sessionId, "turn_complete", `Step complete: ${firstLine(lastResult.summary) || "tools finished"}`, { turn, maxTurns, taskId: turnTaskId });
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
      this.options.events.emitEvent({ type: "final", session_id: sessionId, content, outcome, status: finalStatus.status, checkpoint: this.options.checkpoint });
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
      responseFormat: "json_object",
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

  private async executeToolCall(
    call: CodingLoopToolCall,
    sessionId: string,
    turn: number | undefined,
    modelCapabilities: CapabilityDescriptor[],
    turnDiscoveredToolNames: Set<string>
  ): Promise<{ result: CodingLoopToolResult }> {
    const id = call.id ?? `tool_${randomUUID()}`;
    let actionName = typeof call.action === "string"
      ? call.action
      : typeof call.inputs?.action === "string"
        ? call.inputs.action
        : "unknown";
    let taskContract: ReturnType<typeof taskContractForToolAction> | undefined;
    try {
      assertRawToolAllowedByPolicy(call.action ?? call.inputs?.action, this.options.allowedTools, this.options.disallowedTools);
      const toolSearchResult = await this.tryExecuteToolSearch(call, id, sessionId, turn, modelCapabilities, turnDiscoveredToolNames);
      if (toolSearchResult) {
        return toolSearchResult;
      }
      const capabilityResult = await this.tryExecuteDynamicCapability(call, id, sessionId, turn, modelCapabilities);
      if (capabilityResult) {
        return capabilityResult;
      }
      const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
      actionName = action.type;
      taskContract = taskContractForToolAction(action, {
        writePolicy: this.options.writePolicy,
        fileScope: this.options.fileScope
      });
      if (this.options.allowedTools && !isToolAllowedForPersona(action.type, this.options.allowedTools)) {
        throw new Error(`Tool action denied by run tool policy: ${action.type}`);
      }
      if (this.options.disallowedTools && isToolDeniedByPolicy(action.type, this.options.disallowedTools)) {
        throw new Error(`Tool action denied by run tool policy: ${action.type}`);
      }
      const workspace = this.workspaceForToolSession(sessionId);
      assertToolActionAllowedBySandbox(action, {
        writePolicy: this.options.writePolicy,
        workspace,
        fileScope: this.options.fileScope
      });
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
            source: "coding_loop",
            writePolicy: this.options.writePolicy,
            fileScope: this.options.fileScope
          }
        );
        return { result: codingLoopResultFromTool(id, action.type, rawResult) };
      }
      const permissionDecision = decideToolPermission(action, this.options.settings, { workspace });
      if (permissionDecision.decision === "deny") {
        throw new Error(`Tool action denied by ~/.swarm/settings.json permissions: ${describeToolAction(action)}`);
      }
      if (permissionDecision.decision === "ask") {
        if (!this.options.approvalHandler) {
          throw new Error(`Tool action requires approval but no approval handler is available: ${action.type}`);
        }
        const request = createToolApprovalRequest(action, permissionDecision);
        request.session_id = sessionId;
        request.task_id = id;
        attachApprovalGovernance(request, {
          status: "requested",
          decision_source: "tool.permission",
          actor_id: this.options.workerId ?? "main_swarm"
        });
        this.emitActivity(sessionId, "waiting_approval", `Waiting for approval: ${describeToolAction(action)}`, { turn, tool: action.type, taskId: id });
        this.options.events.emitEvent({ type: "approval", request, status: "pending" });
        const approved = await this.options.approvalHandler(request);
        this.options.events.emitEvent({ type: "approval", request, status: approved ? "approved" : "denied" });
        if (!approved) {
          throw new Error(`Tool action denied: ${action.type}`);
        }
      } else {
        const request = createToolApprovalRequest(action, permissionDecision);
        request.session_id = sessionId;
        request.task_id = id;
        attachApprovalGovernance(request, {
          status: "evidence",
          decision_source: "tool.permission",
          actor_id: this.options.workerId ?? "main_swarm"
        });
        if (request.governance && shouldRecordGovernanceEvidence(request)) {
          this.options.events.emitEvent({ type: "governance", governance: request.governance });
        }
      }

      const toolContext: LocalToolContext = {
        workspace,
        settings: this.options.settings,
        sessionId,
        taskId: id,
        attempt: 0,
        serverWebSearch: (searchAction) => this.options.provider.webSearch(searchAction),
        onWorkspaceChange: this.options.onWorkspaceChange,
        onFileLock: this.options.onFileLock,
        agentControl: this.options.agentControl,
        taskControl: this.options.taskControl,
        worktreeControl: this.options.worktreeControl,
        runtimeControl: this.options.runtimeControl,
        externalContext: this.options.externalContext,
        delegate: (this.options.delegateDepth ?? MAX_DELEGATE_DEPTH) > 0
          ? (action) => this.delegateWorker(action, sessionId, id)
          : undefined
      };
      const rawResult = await runLocalTool(action, toolContext);
      const prepared = await prepareToolOutput(sessionId, id, rawResult, renderToolResultDetail(rawResult));
      const recovery = rawResult.recovery ?? recoveryAdviceForRawToolResult(action.type, rawResult);
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
        recoverySuggestion: rawResult.recoverySuggestion,
        recovery,
        metadata: rawResult.metadata
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
        recoverySuggestion: rawResult.recoverySuggestion,
        recovery,
        metadata: rawResult.metadata,
        write_policy: taskContract.write_policy,
        file_scope: taskContract.file_scope,
        sandbox: result.sandbox,
        agent: this.activityAgentIdentity()
      });
      return { result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const errorCode = classifyToolError(error);
      const sandbox = sandboxDecisionFromError(error);
      const summary = sandbox ? sandboxFailureSummary(sandbox) : reason;
      const recoverySuggestion = recoverySuggestionForToolError(errorCode, reason, sandbox);
      const recovery = recoveryAdviceFromToolFailure({
        action: actionName,
        reason,
        errorCode,
        recoverySuggestion,
        sandbox
      });
      const result: CodingLoopToolResult = {
        id,
        action: actionName,
        status: "failed",
        summary,
        content: formatToolFailureContent(actionName, summary, errorCode, recoverySuggestion, sandbox, recovery),
        errors: [reason],
        errorCode,
        recoverySuggestion,
        recovery,
        sandbox
      };
      this.options.events.emitEvent({
        type: "tool_result",
        session_id: sessionId,
        task_id: id,
        title: call.reason ?? String(result.action),
        action: String(result.action),
        summary,
        content: result.content,
        status: "failed",
        errorCode: result.errorCode,
        recoverySuggestion: result.recoverySuggestion,
        recovery: result.recovery,
        write_policy: taskContract?.write_policy,
        file_scope: taskContract?.file_scope,
        sandbox: result.sandbox,
        agent: this.activityAgentIdentity()
      });
      return { result };
    }
  }

  private emitActivity(
    sessionId: string,
    phase: LoopActivityPhase,
    message: string,
    options: { turn?: number; maxTurns?: number; tool?: string; taskId?: string } = {}
  ): void {
    this.options.events.emitEvent({
      type: "loop_activity",
      session_id: sessionId,
      phase,
      message,
      turn: options.turn,
      max_turns: options.maxTurns,
      tool: options.tool,
      task_id: options.taskId,
      agent: this.activityAgentIdentity()
    });
  }

  private async tryExecuteDynamicCapability(
    call: CodingLoopToolCall,
    id: string,
    sessionId: string,
    turn: number | undefined,
    capabilities: CapabilityDescriptor[]
  ): Promise<{ result: CodingLoopToolResult } | undefined> {
    if (!this.options.invokeCapability || !isDynamicCapabilityAction(call.action)) {
      return undefined;
    }
    const action = call.action;
    const capability = capabilities.find((item) => dynamicCapabilityMatchesAction(item, action));
    if (!capability) {
      return undefined;
    }
    assertDynamicCapabilityAllowedByToolPolicy(capability, this.options.allowedTools, this.options.disallowedTools);
    assertCapabilityAllowedBySandbox(capability, this.options.writePolicy);
    if (!isDynamicCapabilityLoaded(capability, this.discoveredDynamicToolNames)) {
      const recoverySuggestion = capability.kind === "mcp_tool"
        ? `Use ToolSearch with a focused query such as ${JSON.stringify(capability.title ?? capability.name)} or ${JSON.stringify(capability.searchHint ?? capability.providerId)} first, then retry on the next turn.`
        : "Use ToolSearch to discover the relevant capability first.";
      const summary = `Tool ${capability.name} is deferred and not yet loaded.`;
      const recovery = recoveryAdviceFromToolFailure({
        action: capability.name,
        reason: summary,
        errorCode: "TOOL_DEFERRED",
        recoverySuggestion
      });
      const rawResult: ToolResult = {
        action: capability.name,
        status: "failed",
        summary,
        content: formatToolFailureContent(capability.name, summary, "TOOL_DEFERRED", recoverySuggestion, undefined, recovery),
        errorCode: "TOOL_DEFERRED",
        recoverySuggestion,
        recovery,
        data: {
          capability_id: capability.id,
          provider_id: capability.providerId,
          should_defer: capability.shouldDefer ?? false,
          search_hint: capability.searchHint
        }
      };
      const prepared = await prepareToolOutput(sessionId, id, rawResult, rawResult.content ?? rawResult.summary);
      const result: CodingLoopToolResult = {
        id,
        action: capability.name,
        status: "failed",
        summary,
        content: prepared.content,
        outputRef: prepared.outputRef,
        data: prepared.data,
        errors: [summary],
        errorCode: "TOOL_DEFERRED",
        recoverySuggestion,
        recovery
      };
      this.options.events.emitEvent({
        type: "tool_result",
        session_id: sessionId,
        task_id: id,
        title: call.reason ?? capability.name,
        action: capability.name,
        summary,
        content: result.content,
        status: "failed",
        outputRef: prepared.outputRef,
        errorCode: result.errorCode,
        recoverySuggestion: result.recoverySuggestion,
        recovery: result.recovery,
        write_policy: this.options.writePolicy ?? (capability.readOnly ? "read_only" : undefined),
        file_scope: this.options.fileScope,
        sandbox: result.sandbox,
        agent: this.activityAgentIdentity()
      });
      return { result };
    }
    this.emitActivity(sessionId, "running_tool", `Running ${capability.name}`, { turn, tool: capability.name, taskId: id });
    const rawResult = await this.options.invokeCapability(capability.id, call.inputs ?? {}, sessionId, {
      taskId: id,
      title: call.reason ?? capability.name,
      source: "coding_loop",
      writePolicy: this.options.writePolicy,
      fileScope: this.options.fileScope
    });
    const result = codingLoopResultFromTool(id, capability.name, rawResult);
    return { result };
  }

  private async tryExecuteToolSearch(
    call: CodingLoopToolCall,
    id: string,
    sessionId: string,
    turn: number | undefined,
    capabilities: CapabilityDescriptor[],
    turnDiscoveredToolNames: Set<string>
  ): Promise<{ result: CodingLoopToolResult } | undefined> {
    if (!isToolSearchAction(call.action)) {
      return undefined;
    }
    const search = parseToolSearchInputs(call.inputs ?? {});
    this.emitActivity(sessionId, "running_tool", `Searching deferred tools: ${previewActivityValue(search.query ?? "all")}`, { turn, tool: TOOL_SEARCH_TOOL_NAME, taskId: id });
    const matches = searchDeferredCapabilities(capabilities, search, this.discoveredDynamicToolNames);
    const loadedToolNames = matches
      .filter((match) => match.kind === "mcp_tool" && match.loadNextTurn)
      .map((match) => match.name);
    for (const toolName of loadedToolNames) {
      turnDiscoveredToolNames.add(toolName);
    }
    const rawResult: ToolResult = {
      action: TOOL_SEARCH_TOOL_NAME,
      status: "success",
      summary: matches.length
        ? `ToolSearch found ${matches.length} matching capabilities and loaded ${loadedToolNames.length} MCP tools for the next turn.`
        : "ToolSearch found no matching deferred capabilities.",
      content: renderToolSearchDetail(search, matches, loadedToolNames),
      data: {
        query: search.query ?? "",
        limit: search.limit,
        match_count: matches.length,
        loaded_tool_names: loadedToolNames,
        matches
      }
    };
    const prepared = await prepareToolOutput(sessionId, id, rawResult, rawResult.content ?? rawResult.summary);
    const result: CodingLoopToolResult = {
      id,
      action: TOOL_SEARCH_TOOL_NAME,
      status: "success",
      summary: rawResult.summary,
      content: prepared.content,
      outputRef: prepared.outputRef,
      data: prepared.data
    };
    this.options.events.emitEvent({
      type: "tool_result",
      session_id: sessionId,
      task_id: id,
      title: call.reason ?? TOOL_SEARCH_TOOL_NAME,
      action: TOOL_SEARCH_TOOL_NAME,
      summary: rawResult.summary,
      content: result.content,
      status: "success",
      outputRef: prepared.outputRef,
      write_policy: "read_only",
      agent: this.activityAgentIdentity()
    });
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
        preferred_mode: action.run_in_background ? "parallel" : action.preferred_mode,
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
      emitProgress: false,
      disallowedTools: this.options.disallowedTools,
      fileScope: action.file_scope,
      onSessionStart: (workerSessionId) => {
        const startedRecord = this.options.workerStore?.setResult({
          worker_id: workerId,
          status: "running",
          worker_session_id: workerSessionId
        });
        if (startedRecord) {
          this.options.events.emitEvent({
            type: "worker",
            worker: startedRecord,
            status: startedRecord.status,
            message: `Worker session ${workerSessionId} started.`
          });
        }
      }
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

  private workspaceForToolSession(sessionId: string): string {
    return this.options.workspaceForSession?.(sessionId) ?? this.options.workspace;
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
    case "ask_user_question":
      return `Ask user ${previewActivityValue(action.prompt)}`;
    case "plan.enter":
      return `Enter plan mode ${previewActivityValue(action.objective ?? "planning mode")}`;
    case "plan.exit":
      return `Request plan approval ${previewActivityValue(action.summary ?? "approval requested")}`;
    case "worktree.enter":
      return `worktree.enter ${previewActivityValue(action.name ?? "new worktree")}`;
    case "worktree.exit":
      return `worktree.exit ${action.mode}`;
    case "blackboard.write":
      return `Save shared fact ${previewActivityValue(action.key)}`;
    case "blackboard.read":
      return `Read shared fact ${previewActivityValue(action.entryId ?? action.key ?? "entry")}`;
    case "blackboard.search":
      return `Search shared facts ${previewActivityValue(action.query ?? action.keyPrefix ?? action.tag ?? "entries")}`;
    case "blackboard.list":
      return `List shared facts ${previewActivityValue(action.keyPrefix ?? action.tag ?? "entries")}`;
    case "shell.exec":
      return `shell.exec ${previewActivityValue(action.command)}`;
    case "powershell.exec":
      return `powershell.exec ${previewActivityValue(action.command)}`;
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
    case "config.get":
      return `config.get ${previewActivityValue(action.setting ?? "safe settings")}`;
    case "config.set":
      return `config.set ${previewActivityValue(action.setting)}`;
    case "mcp.resources":
      return `mcp.resources ${previewActivityValue(action.server ?? "all servers")}`;
    case "mcp.read":
      return `mcp.read ${previewActivityValue(`${action.server}:${action.uri}`)}`;
    case "mcp.auth":
      return `mcp.auth ${previewActivityValue(action.server ?? "all servers")}`;
    case "mcp.call":
      return `mcp.call ${previewActivityValue(action.capabilityId ?? `${action.server ?? "server"}:${action.tool ?? "tool"}`)}`;
    case "skill.invoke":
      return `skill.invoke ${previewActivityValue(action.name)}`;
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
    case "lsp.diagnostics":
      return `lsp.diagnostics ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.hover":
      return `lsp.hover ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.definition":
      return `lsp.definition ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.references":
      return `lsp.references ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.document_symbols":
      return `lsp.document_symbols ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.workspace_symbols":
      return `lsp.workspace_symbols ${previewActivityValue(action.query ?? ".")}`;
    case "lsp.completion":
      return `lsp.completion ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.code_actions":
      return `lsp.code_actions ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.rename_preview":
      return `lsp.rename_preview ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "lsp.format":
      return `lsp.format ${previewActivityValue(action.path ?? action.file ?? ".")}`;
    case "agent.delegate":
      return `agent.delegate ${previewActivityValue(action.capability)}: ${previewActivityValue(action.task)}`;
    case "agent.list":
      return `agent.list ${previewActivityValue(action.parent_session_id ?? action.status ?? "workers")}`;
    case "agent.status":
      return `agent.status ${previewActivityValue(action.worker_id)}`;
    case "agent.stop":
      return `agent.stop ${previewActivityValue(action.worker_id)}`;
    case "agent.continue":
      return `agent.continue ${previewActivityValue(action.worker_id)}: ${previewActivityValue(action.message)}`;
    case "agent.message":
      return `agent.message ${previewActivityValue(action.worker_id ?? action.agent_id ?? action.role ?? action.capability ?? "agent")}`;
    case "runtime.sleep":
      return `runtime.sleep ${Math.min(Math.max(0, Math.floor(action.duration_ms)), 30000)}ms`;
    case "structured.output":
      return `structured.output ${previewActivityValue(action.label ?? "schema output")}`;
    case "repl.mode":
      return `repl.mode ${previewActivityValue(action.mode ?? "interactive")}`;
    case "schedule.create":
      return `schedule.create ${previewActivityValue(action.cron)}`;
    case "schedule.list":
      return `schedule.list ${previewActivityValue(action.status ?? "schedules")}`;
    case "schedule.delete":
      return `schedule.delete ${previewActivityValue(action.schedule_id)}`;
    case "remote.trigger":
      return `remote.trigger ${previewActivityValue(action.endpoint ?? action.capability ?? "unconfigured")}`;
    case "team.create":
      return `team.create ${previewActivityValue(action.name ?? action.objective)}`;
    case "team.delete":
      return `team.delete ${previewActivityValue(action.team_id)}`;
    case "task.create":
      return `task.create ${previewActivityValue(action.title)}`;
    case "task.update":
      return `task.update ${previewActivityValue(action.task_id)}`;
    case "task.get":
      return `task.get ${previewActivityValue(action.task_id)}`;
    case "task.list":
      return `task.list ${previewActivityValue(action.session_id ?? action.status ?? "current session")}`;
    case "task.output":
      return `task.output ${previewActivityValue(action.output_ref ?? action.worker_id ?? action.task_id ?? "output")}`;
    case "task.stop":
      return `task.stop ${previewActivityValue(action.task_id)}`;
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
  systemPrompt?: string;
  appendSystemPrompt?: string;
  agentInstructions?: string;
  availableTools: string[];
  writePolicy?: "read_only" | "scoped_write" | "workspace_write";
  expectedSideEffects?: string;
  additionalReadDirectories?: string[];
}): PromptBlock[] {
  const tools = input.availableTools.join(", ");
  const defaultBehaviorInstructions = [
    input.role === "worker"
      ? "You are a Swarm worker agent running inside the main Swarm controller."
      : "You are Swarm's default coding agent, a local coding CLI agent.",
    input.role === "worker"
      ? "You are not user-facing. Produce internal findings, edits, or verification for the main Swarm to synthesize."
      : "You are user-facing through the main Swarm conversation.",
    "Work efficiently in a loop: inspect files, edit when needed, verify when useful, then answer concisely."
  ].filter(Boolean).join(" ");
  const behaviorInstructions = input.systemPrompt !== undefined ? input.systemPrompt : defaultBehaviorInstructions;
  const runtimeProtocolInstructions = [
    "You are running inside Swarm's local coding-loop protocol. These protocol rules keep the CLI tool bridge working even when the behavioral system prompt is customized.",
    "Return exactly one JSON object with keys: status, summary, message, files_touched, next_actions, tool_calls.",
    "status must be continue, completed, or failed.",
    "files_touched means files you read, inspected, or changed; it is not by itself proof of a workspace modification.",
    "Use tool_calls when you need to act. Use [] when done.",
    "status=continue must include at least one executable tool_call; when no tool is needed, use status=completed or status=failed.",
    "A failed tool result is feedback, not a global stop. Read the error, adjust inputs or command, and continue unless the task is truly blocked.",
    "If a shell command times out, retry with a narrower command or a larger timeoutMs when the command is still necessary.",
    "Use status=failed only when you cannot recover or continue after inspecting the latest tool results.",
    `Allowed tools: ${tools}.`,
    "Some MCP tools are deferred to reduce prompt churn. Use ToolSearch to discover them first; discovered MCP schemas become available on the next turn.",
    renderHostEnvironmentPrompt(input.workspace, input.additionalReadDirectories),
    input.expectedSideEffects ? `Expected side effects: ${input.expectedSideEffects}.` : undefined,
    expectsWorkspaceModification(input.expectedSideEffects) ? "This objective is expected to modify the workspace. Do not return completed until a write/edit tool result proves the requested change was made." : undefined,
    input.writePolicy ? `Write policy: ${input.writePolicy}. Never use tools outside this policy.` : undefined,
    input.writePolicy === "read_only" ? "In read_only policy, code.test and code.lint are allowed verification commands; do not use write/edit tools or commands that intentionally modify source files." : undefined,
    "Read existing files before editing them. For edits, read the full file first.",
    "Prefer file.edit for existing files and file.write for new files. Do not write final reports unless requested.",
    "Use file.delete for deleting workspace files or cleanup artifacts; do not use shell deletion commands such as rm, del, or Remove-Item for workspace cleanup.",
    "Use code.test for npm test and CLI smoke verification. When running commands on Windows, prefer the cwd input instead of cd/&& shell chaining, and use PowerShell syntax unless explicitly invoking another shell.",
    "Keep long verification commands to one or two tool_calls per turn so failures can be inspected before continuing.",
    "Do not append cleanup deletion to shell or test commands; leave temporary smoke artifacts or delete them later with file.delete.",
    "For tool_calls, each item is {id, action, inputs, reason}. The action must match an allowed tool, and inputs must match the tool_schemas in the user payload.",
    input.delegateAvailable
      ? "You may dynamically upgrade the coding loop into an internal swarm by using Agent when the task naturally splits into independent roles, workstreams, or expert checks. The main Swarm remains responsible for user-facing synthesis and final decisions."
      : "Do not use Agent in this loop.",
    input.delegateAvailable && input.role === "main"
      ? "When delegating, choose from available_agent_specs and pass structured inputs: capability, task, context, preferred_agent_spec_id, preferred_mode, run_in_background, and file_scope when known. Use run_in_background=true or preferred_mode=parallel for independent side work that should not block the main agent. For explicit swarm or team-role requests, spawn the relevant architect/researcher/reviewer/verifier/coder workers early instead of doing all reasoning alone. Prefer read-only researcher/reviewer/critic/verifier subagents before write delegation. Use handoff only for focused deep work across multiple turns."
      : undefined,
    "Keep message grounded in actual tool results. Mention verification commands that were run.",
    input.role === "main"
      ? "Live user messages are part of the main Swarm conversation, not side-channel chat."
      : "Live user messages are controller context; do not treat them as direct worker chat.",
    "Always obey the newest live user messages and control_decisions. If they redirect the task, stop pursuing the old target after the current safe boundary."
  ].filter(Boolean).join(" ");
  return [
    { text: behaviorInstructions, cache: true, section: "system" },
    { text: runtimeProtocolInstructions, cache: true, section: "system" },
    ...(input.appendSystemPrompt !== undefined ? [{ text: input.appendSystemPrompt, cache: true, section: "system" as const }] : []),
    ...(input.agentInstructions ? [{ text: input.agentInstructions, cache: false, section: "context" as const }] : [])
  ];
}

function codingLoopUserPrompt(input: {
  objective: string;
  role: "main" | "worker";
  parentSessionId?: string;
  availableTools: string[];
  dynamicToolSchemas: Record<string, Record<string, unknown>>;
  deferredToolCatalog?: DeferredToolCatalogSummary;
  settings: SwarmSettings;
  workspace: string;
  durableContext?: string;
  agentMemoryContext?: string;
  workspaceIndex?: WorkspaceIndex;
  delegateAvailable: boolean;
  toolResults: CodingLoopToolResult[];
  liveMessages: LiveUserMessage[];
  controlDecisions: ControlDecision[];
  turn: number;
  remainingTurns: number;
  remainingToolCalls: number;
}): PromptBlock[] {
  const stableSystemPayload = {
    role: input.role
  };
  const stableWorkspacePayload = {
    workspace_index: input.workspaceIndex ? renderStableWorkspaceIndexForPrompt(input.workspaceIndex) : undefined
  };
  const stableToolPayload = {
    role: input.role,
    tool_schemas: renderToolSchemas(input.availableTools, input.dynamicToolSchemas),
    tool_concurrency_classes: TOOL_CONCURRENCY_POLICY,
    available_agent_specs: input.role === "main" && input.delegateAvailable
      ? renderAvailableAgentSpecs({ settings: input.settings, workspace: input.workspace })
      : undefined,
    delegation_policy: input.role === "main" && input.delegateAvailable
      ? codingLoopDelegationPolicy()
      : undefined
  };
  const taskPayload = {
    objective: input.objective,
    role: input.role,
    parent_session_id: input.parentSessionId
  };
  const contextPayload = {
    durable_session_context: input.durableContext ? `Durable session context:\n${input.durableContext}` : undefined,
    agent_memory_context: input.agentMemoryContext ? `Agent memory continuity:\n${input.agentMemoryContext}` : undefined,
    workspace_state: input.workspaceIndex ? renderDynamicWorkspaceStateForPrompt(input.workspaceIndex) : undefined,
    semantic_evidence: semanticEvidencePrompt(input.toolResults),
    deferred_tool_catalog: input.deferredToolCatalog
  };
  const volatilePayload = {
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
  return nonEmptyPromptBlocks([
    { text: stableJsonStringify(stableSystemPayload), cache: true, section: "system" },
    { text: stableJsonStringify(stableToolPayload), cache: true, section: "tools" },
    { text: stableJsonStringify(stableWorkspacePayload), cache: true, section: "workspace" },
    { text: stableJsonStringify(taskPayload), cache: false, section: "task" },
    { text: stableJsonStringify(contextPayload), cache: false, section: "context" },
    { text: stableJsonStringify(volatilePayload), cache: false, section: "volatile_footer" }
  ]);
}

function nonEmptyPromptBlocks(blocks: PromptBlock[]): PromptBlock[] {
  return blocks.filter((block) => block.text.trim() !== "{}" && block.text.trim().length > 0);
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortJsonValue(value[key])])
  );
}

function renderStableWorkspaceIndexForPrompt(index: WorkspaceIndex): Record<string, unknown> {
  const scripts = Object.fromEntries(
    Object.entries(index.scripts)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 20)
  );
  return {
    summary: stableWorkspaceIndexSummary(index),
    detected: [...index.detected].sort((left, right) => left.localeCompare(right)),
    package_manager: index.packageManager,
    scripts,
    counts: index.counts
  };
}

function renderDynamicWorkspaceStateForPrompt(index: WorkspaceIndex): Record<string, unknown> {
  const packed = packWorkspaceContextBlocks(workspaceContextBlocks(index));
  return {
    summary: workspaceIndexSummary(index),
    prompt_packing: {
      stable_prefix_sections: ["system", "tools", "workspace"],
      dynamic_sections: ["task", "context", "volatile_footer"],
      context_order: "source,path,relevance_desc",
      included_context_blocks: packed.included.length,
      dropped_context_blocks: packed.dropped,
      context_block_limit: WORKSPACE_CONTEXT_BLOCK_LIMIT,
      stable_prefix_budget_tokens: estimateTokenCount(stableWorkspaceIndexSummary(index)),
      volatile_tail_budget_tokens: packed.tokenBudget,
      included_context_tokens_estimate: packed.includedTokensEstimate,
      dropped_context_tokens_estimate: packed.droppedTokensEstimate,
      overflow_reason: packed.overflowReason,
      prefix_identity_hint: stablePrefixIdentityFromText(stableWorkspaceIndexSummary(index))
    },
    context_blocks: packed.included,
    recent_files: packed.included
      .filter((block) => block.source === "recent_file")
      .map((block) => block.path),
    git: index.git
      ? {
          branch: index.git.branch,
          head: index.git.head?.slice(0, 12),
          status: index.git.statusSummary,
          dirty_files: [...index.git.dirtyFiles]
            .map((item) => normalizeWorkspacePath(index, item))
            .sort((left, right) => left.localeCompare(right))
            .slice(0, WORKSPACE_CONTEXT_BLOCK_LIMIT)
        }
      : undefined
  };
}

function stableWorkspaceIndexSummary(index: WorkspaceIndex): string {
  const detectedList = [...index.detected].sort((left, right) => left.localeCompare(right));
  const detected = detectedList.length ? detectedList.join(", ") : "unknown";
  const scripts = Object.keys(index.scripts).sort((left, right) => left.localeCompare(right)).slice(0, 4);
  return [
    `detected=${detected}`,
    `files=${index.counts.files}`,
    `scripts=${scripts.length ? scripts.join(", ") : "(none)"}`
  ].join(" | ");
}

type WorkspacePromptContextBlock = {
  source: "git_dirty" | "recent_file";
  path: string;
  relevance: number;
  reason: string;
  size?: number;
};

function workspaceContextBlocks(index: WorkspaceIndex): WorkspacePromptContextBlock[] {
  const recentByMtime = [...index.recentFiles]
    .map((file) => ({
      file,
      path: normalizeWorkspacePath(index, file.path)
    }))
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, WORKSPACE_CONTEXT_BLOCK_LIMIT);
  const recentBlocks = recentByMtime.map((item, rank): WorkspacePromptContextBlock => ({
    source: "recent_file",
    path: item.path,
    relevance: WORKSPACE_CONTEXT_BLOCK_LIMIT - rank,
    reason: "recent_workspace_file",
    size: item.file.size
  }));
  const dirtyBlocks = (index.git?.dirtyFiles ?? []).map((path): WorkspacePromptContextBlock => ({
    source: "git_dirty",
    path: normalizeWorkspacePath(index, path),
    relevance: WORKSPACE_CONTEXT_BLOCK_LIMIT + 1,
    reason: "git_dirty_file"
  }));
  return [...dirtyBlocks, ...recentBlocks];
}

function packWorkspaceContextBlocks(blocks: WorkspacePromptContextBlock[]): {
  included: WorkspacePromptContextBlock[];
  dropped: number;
  tokenBudget: number;
  includedTokensEstimate: number;
  droppedTokensEstimate: number;
  overflowReason?: "context_block_limit" | "volatile_tail_budget";
} {
  const byKey = new Map<string, WorkspacePromptContextBlock>();
  for (const block of blocks) {
    const key = `${block.source}:${block.path}`;
    const previous = byKey.get(key);
    if (!previous || block.relevance > previous.relevance) {
      byKey.set(key, block);
    }
  }
  const sorted = [...byKey.values()].sort(compareWorkspaceContextBlocks);
  const included: WorkspacePromptContextBlock[] = [];
  const droppedBlocks: WorkspacePromptContextBlock[] = [];
  let includedTokensEstimate = 0;
  let overflowReason: "context_block_limit" | "volatile_tail_budget" | undefined;
  for (const block of sorted) {
    const tokenEstimate = workspaceContextBlockTokenEstimate(block);
    if (included.length >= WORKSPACE_CONTEXT_BLOCK_LIMIT) {
      overflowReason ??= "context_block_limit";
      droppedBlocks.push(block);
      continue;
    }
    if (included.length > 0 && includedTokensEstimate + tokenEstimate > WORKSPACE_CONTEXT_TOKEN_BUDGET) {
      overflowReason ??= "volatile_tail_budget";
      droppedBlocks.push(block);
      continue;
    }
    included.push(block);
    includedTokensEstimate += tokenEstimate;
  }
  const droppedTokensEstimate = droppedBlocks.reduce((total, block) => total + workspaceContextBlockTokenEstimate(block), 0);
  return {
    included,
    dropped: droppedBlocks.length,
    tokenBudget: WORKSPACE_CONTEXT_TOKEN_BUDGET,
    includedTokensEstimate,
    droppedTokensEstimate,
    overflowReason
  };
}

function compareWorkspaceContextBlocks(left: WorkspacePromptContextBlock, right: WorkspacePromptContextBlock): number {
  return left.source.localeCompare(right.source)
    || left.path.localeCompare(right.path)
    || right.relevance - left.relevance
    || left.reason.localeCompare(right.reason);
}

function normalizeWorkspacePath(index: WorkspaceIndex, path: string): string {
  const workspaceRelative = isAbsolute(path) ? relative(index.root, path) : path;
  return workspaceRelative.replace(/\\/g, "/");
}

function workspaceContextBlockTokenEstimate(block: WorkspacePromptContextBlock): number {
  return estimateTokenCount([
    block.source,
    block.path,
    block.reason,
    typeof block.size === "number" ? String(block.size) : ""
  ].join(" "));
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

export function evaluateCodingLoopCacheLab(replays: CodingLoopCacheLabReplay[]): CodingLoopCacheLabReport {
  const baseline = replays[0] ? codingLoopCacheLabResult(replays[0], undefined, true) : undefined;
  return {
    baseline,
    replays: replays.map((replay, index) => codingLoopCacheLabResult(replay, baseline, index === 0)),
    stablePrefixSections: ["system", "tools", "workspace"],
    volatileTailSections: ["task", "context", "volatile_footer"]
  };
}

export function selectBestCodingLoopCacheLabResult(report: CodingLoopCacheLabReport): CodingLoopCacheLabResult | undefined {
  return [...report.replays].sort(compareCacheLabResultsByQualityGuard)[0];
}

export function selectTopHitCodingLoopCacheLabResult(report: CodingLoopCacheLabReport): CodingLoopCacheLabResult | undefined {
  return [...report.replays].sort(compareCacheLabResultsByTopHit)[0];
}

export function formatCodingLoopCacheLabReport(report: CodingLoopCacheLabReport): string[] {
  const baseline = report.baseline;
  const best = selectBestCodingLoopCacheLabResult(report);
  const topHit = selectTopHitCodingLoopCacheLabResult(report);
  const guardNote = best && topHit && best.label !== topHit.label
    ? `top hit ${topHit.label} is excluded by the quality guard because quality=${topHit.qualityVerdict}`
    : "top hit is also the quality-safe best profile.";
  const failureReasons = cacheLabFailureReasons(report);
  return [
    "Cache Lab",
    `baseline=${baseline ? cacheLabResultSummary(baseline) : "(none)"}`,
    `best_profile=${best ? cacheLabResultSummary(best) : "(none)"}`,
    `top_hit_profile=${topHit ? cacheLabResultSummary(topHit) : "(none)"}`,
    `quality_guard=${guardNote}`,
    `profiles=${report.replays.length}`,
    `stable_prefix_sections=${report.stablePrefixSections.join(",")}`,
    `volatile_tail_sections=${report.volatileTailSections.join(",")}`,
    "",
    "Profiles",
    ...report.replays.map((replay) => `- ${cacheLabResultSummary(replay)}${replay.qualityReason ? ` reason=${replay.qualityReason}` : ""}`),
    "",
    "Failure Reasons",
    ...(failureReasons.length ? failureReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "Recommendation",
    ...cacheLabRecommendations(report, best, topHit)
  ];
}

function codingLoopCacheLabResult(
  replay: CodingLoopCacheLabReplay,
  baseline?: CodingLoopCacheLabResult,
  isBaseline = false
): CodingLoopCacheLabResult {
  const blocks = [...replay.system, ...replay.user];
  const stableBlocks = blocks.filter((block) => block.cache === true);
  const stablePrefix = stableBlocks.map((block) => block.text).join("\n\n");
  const dynamicTail = blocks.filter((block) => block.cache !== true).map((block) => block.text).join("\n\n");
  const stablePrefixIdentity = stablePrefix ? stablePrefixIdentityFromText(stablePrefix) : undefined;
  const stableSectionHashes = promptBlockSectionHashes(stableBlocks);
  const prefixDrift = Boolean(baseline?.stablePrefixIdentity && stablePrefixIdentity && baseline.stablePrefixIdentity !== stablePrefixIdentity);
  const hitRate = typeof replay.cachedInputTokens === "number" && typeof replay.totalInputWithCacheTokens === "number" && replay.totalInputWithCacheTokens > 0
    ? replay.cachedInputTokens / replay.totalInputWithCacheTokens
    : undefined;
  const changedSections = baseline?.stablePrefixIdentity
    ? changedCacheSections(baseline, replay)
    : [];
  return {
    label: replay.label,
    cacheKey: replay.cacheKey,
    stablePrefixIdentity,
    stableSectionHashes,
    stablePrefixTokensEstimate: estimateTokenCount(stablePrefix),
    volatileTailTokensEstimate: estimateTokenCount(dynamicTail),
    hitRate,
    cachedInputTokens: replay.cachedInputTokens,
    totalInputWithCacheTokens: replay.totalInputWithCacheTokens,
    prefixDrift,
    changedSections,
    missReason: prefixDrift
      ? "prefix_drift"
      : isBaseline
        ? "cold_start"
        : hitRate === 0
          ? "provider_omitted_usage"
          : undefined,
    qualityVerdict: replay.qualityVerdict ?? "pass",
    qualityReason: replay.qualityReason
  };
}

function changedCacheSections(baseline: CodingLoopCacheLabResult, replay: CodingLoopCacheLabReplay): string[] {
  if (!baseline.stablePrefixIdentity) {
    return [];
  }
  const sectionHashes = promptBlockSectionHashes([...replay.system, ...replay.user].filter((block) => block.cache === true));
  const sections = new Set([...Object.keys(baseline.stableSectionHashes), ...Object.keys(sectionHashes)]);
  return [...sections]
    .filter((section) => baseline.stableSectionHashes[section] !== sectionHashes[section])
    .sort((left, right) => left.localeCompare(right));
}

function promptBlockSectionHashes(blocks: PromptBlock[]): Record<string, string> {
  const bySection = new Map<string, string[]>();
  for (const block of blocks) {
    const section = block.section ?? "task";
    bySection.set(section, [...(bySection.get(section) ?? []), block.text]);
  }
  return Object.fromEntries([...bySection.entries()].map(([section, texts]) => [
    section,
    createHash("sha256").update(texts.join("\n\n")).digest("hex").slice(0, 16)
  ]));
}

function stablePrefixIdentityFromText(text: string): string {
  return `pcx:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

function estimateTokenCount(text: string): number {
  return text.trim() ? Math.ceil(text.length / 4) : 0;
}

function compareCacheLabResultsByQualityGuard(left: CodingLoopCacheLabResult, right: CodingLoopCacheLabResult): number {
  const qualityRank = cacheLabQualityRank(left.qualityVerdict) - cacheLabQualityRank(right.qualityVerdict);
  if (qualityRank !== 0) {
    return qualityRank;
  }
  const hitRank = compareHitRate(right.hitRate, left.hitRate);
  if (hitRank !== 0) {
    return hitRank;
  }
  const driftRank = Number(left.prefixDrift) - Number(right.prefixDrift);
  if (driftRank !== 0) {
    return driftRank;
  }
  const tailRank = left.volatileTailTokensEstimate - right.volatileTailTokensEstimate;
  if (tailRank !== 0) {
    return tailRank;
  }
  return left.label.localeCompare(right.label);
}

function compareCacheLabResultsByTopHit(left: CodingLoopCacheLabResult, right: CodingLoopCacheLabResult): number {
  const hitRank = compareHitRate(left.hitRate, right.hitRate);
  if (hitRank !== 0) {
    return hitRank;
  }
  const qualityRank = cacheLabQualityRank(left.qualityVerdict) - cacheLabQualityRank(right.qualityVerdict);
  if (qualityRank !== 0) {
    return qualityRank;
  }
  const driftRank = Number(left.prefixDrift) - Number(right.prefixDrift);
  if (driftRank !== 0) {
    return driftRank;
  }
  const tailRank = left.volatileTailTokensEstimate - right.volatileTailTokensEstimate;
  if (tailRank !== 0) {
    return tailRank;
  }
  return left.label.localeCompare(right.label);
}

function compareHitRate(left: number | undefined, right: number | undefined): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return right - left;
}

function cacheLabQualityRank(verdict: CodingLoopCacheLabQualityVerdict): number {
  if (verdict === "pass") {
    return 0;
  }
  if (verdict === "warning") {
    return 1;
  }
  return 2;
}

function cacheLabFailureReasons(report: CodingLoopCacheLabReport): string[] {
  return report.replays.flatMap((replay) => {
    const reasons: string[] = [];
    if (replay.qualityVerdict === "warning") {
      reasons.push(`${replay.label}: quality warning${replay.qualityReason ? ` - ${replay.qualityReason}` : ""}`);
    }
    if (replay.qualityVerdict === "fail") {
      reasons.push(`${replay.label}: quality failure${replay.qualityReason ? ` - ${replay.qualityReason}` : ""}`);
    }
    if (replay.prefixDrift) {
      reasons.push(`${replay.label}: prefix drift in ${replay.changedSections.join(", ") || "stable prefix"}`);
    }
    if (replay.missReason && replay.missReason !== "cold_start") {
      reasons.push(`${replay.label}: miss reason ${replay.missReason}`);
    }
    return reasons;
  });
}

function cacheLabRecommendations(
  report: CodingLoopCacheLabReport,
  best: CodingLoopCacheLabResult | undefined,
  topHit: CodingLoopCacheLabResult | undefined
): string[] {
  if (!best) {
    return ["- No cache lab profiles were provided."];
  }
  const lines = [
    `- Prefer ${best.label} as the default profile for this lab; it balances cache gain and quality safety.`
  ];
  if (topHit && topHit.label !== best.label) {
    lines.push(`- Keep ${topHit.label} as a high-cache experiment only; its quality verdict is ${topHit.qualityVerdict}.`);
  }
  if (report.baseline && best.label !== report.baseline.label) {
    lines.push(`- Compare ${best.label} against baseline ${report.baseline.label} when reviewing tail churn.`);
  }
  return lines;
}

function cacheLabResultSummary(result: CodingLoopCacheLabResult): string {
  const hitRate = result.hitRate === undefined ? "unknown" : `${Math.round(result.hitRate * 100)}%`;
  const drift = result.prefixDrift ? "drift=yes" : "drift=no";
  const quality = result.qualityVerdict;
  const miss = result.missReason ? ` miss=${result.missReason}` : "";
  const changed = result.changedSections.length ? ` changed=${result.changedSections.join(",")}` : "";
  return `${result.label} quality=${quality} hit=${hitRate} ${drift}${miss}${changed}`.trim();
}

function renderAvailableAgentSpecs(source: AgentSpecSource): Array<Record<string, unknown>> {
  return [...listAgentSpecs(source)].sort(compareAgentSpecsForPrompt).map((spec) => ({
    id: spec.id,
    role: spec.role,
    description: spec.description,
    when_to_use: spec.when_to_use,
    capabilities: [...spec.capabilities].sort((left, right) => left.localeCompare(right)),
    write_policy: spec.write_policy,
    budget: spec.default_budget,
    output_contract: spec.output_contract
  }));
}

function compareAgentSpecsForPrompt(left: AgentSpec, right: AgentSpec): number {
  return left.id.localeCompare(right.id) ||
    left.role.localeCompare(right.role) ||
    left.name.localeCompare(right.name);
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
      "coder/scoped_write only with file_scope, and parallel only when sibling file_scope values are concrete and non-overlapping.",
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

function semanticEvidencePrompt(toolResults: CodingLoopToolResult[]): Record<string, unknown> | undefined {
  const items = toolResults
    .slice(-20)
    .flatMap((result) => semanticEvidencePromptItems(result))
    .slice(-12);
  if (!items.length) {
    return undefined;
  }
  return {
    schema_version: "swarm.semantic_evidence.prompt.v1",
    guidance: "Use these semantic_evidence ids when planning edits. Treat staleness values other than fresh as refresh/fallback evidence, and if fallback_used=true prefer the listed fallback_tools before editing.",
    items
  };
}

function semanticEvidencePromptItems(result: CodingLoopToolResult): SemanticEvidencePromptItem[] {
  const evidence = semanticEvidenceRecord(result.metadata?.semantic_evidence) ?? semanticEvidenceRecord(result.data);
  if (!evidence) {
    return [];
  }
  return [{
    evidence_id: semanticString(evidence.evidence_id) ?? `${result.id}:${result.action}`,
    source: semanticString(evidence.source) ?? "unknown",
    action: semanticString(evidence.action) ?? String(result.action),
    status: semanticString(evidence.status) ?? result.status,
    lsp_status: semanticString(evidence.lsp_status),
    symbol: semanticString(evidence.symbol),
    range: semanticRange(evidence.range),
    confidence: semanticNumber(evidence.confidence),
    staleness: semanticString(evidence.staleness),
    stale_reason: semanticString(evidence.stale_reason),
    fallback_used: semanticBoolean(evidence.fallback_used),
    fallback_reason: semanticString(evidence.fallback_reason),
    fallback_tools: semanticStringArray(evidence.fallback_tools),
    next_action: semanticString(evidence.next_action),
    summary: semanticString(evidence.summary) ?? result.summary,
    result_keys: semanticStringArray(evidence.result_keys),
    primary_refs: semanticStringArray(evidence.primary_refs),
    changed_files: semanticStringArray(evidence.changed_files),
    tool_result_id: result.id,
    tool_status: result.status
  }];
}

function semanticEvidenceRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.schema_version === "swarm.semantic_evidence.v1") {
    return value;
  }
  const nested = value.semantic_evidence;
  return isRecord(nested) && nested.schema_version === "swarm.semantic_evidence.v1" ? nested : undefined;
}

function semanticString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function semanticNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function semanticBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function semanticRange(value: unknown): LspRange | undefined {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) {
    return undefined;
  }
  const startLine = semanticNumber(value.start.line);
  const startColumn = semanticNumber(value.start.column);
  const endLine = semanticNumber(value.end.line);
  const endColumn = semanticNumber(value.end.column);
  if (startLine === undefined || startColumn === undefined || endLine === undefined || endColumn === undefined) {
    return undefined;
  }
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn }
  };
}

function semanticStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : undefined;
}

function allowedToolNames(
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  delegateAvailable: boolean,
  capabilities: CapabilityDescriptor[] = [],
  discoveredDynamicToolNames: Set<string> = new Set<string>(),
  writePolicy?: SandboxWritePolicy
): string[] {
  const hasAllowList = Boolean(allowedTools?.length);
  const tools = hasAllowList ? [...allowedTools!] : [...DEFAULT_TOOL_NAMES];
  const withDelegate = !hasAllowList && delegateAvailable && !tools.includes("Agent")
    ? [...tools, "Agent"]
    : tools.filter((tool) => delegateAvailable || (tool !== "Agent" && tool !== "agent.delegate"));
  const sandboxVisibleTools = withDelegate.filter((tool) => isToolVisibleInSandboxPrompt(tool, writePolicy));
  const alwaysLoadedDynamicTools = capabilities
    .filter((capability) => isVisibleActiveCapability(capability) && capability.alwaysLoad && isCapabilityAllowedByRunToolPolicy(capability, allowedTools, disallowedTools) && isCapabilityVisibleInSandboxPrompt(capability, writePolicy))
    .sort(compareCapabilitiesForPrompt)
    .map((capability) => capability.name);
  const discoveredDynamicTools = capabilities
    .filter((capability) => isVisibleMcpCapability(capability) && discoveredDynamicToolNames.has(capability.name) && isCapabilityAllowedByRunToolPolicy(capability, allowedTools, disallowedTools) && isCapabilityVisibleInSandboxPrompt(capability, writePolicy))
    .sort(compareCapabilitiesForPrompt)
    .map((capability) => capability.name);
  let result = [...sandboxVisibleTools, ...alwaysLoadedDynamicTools, ...discoveredDynamicTools]
    .filter((tool) => !isToolDeniedByPolicy(tool, disallowedTools));
  if (!hasAllowList && !result.includes(TOOL_SEARCH_TOOL_NAME) && !isToolDeniedByPolicy(TOOL_SEARCH_TOOL_NAME, disallowedTools)) {
    result.push(TOOL_SEARCH_TOOL_NAME);
  } else if (hasAllowList && allowedTools!.some((tool) => toolNameMatches(tool, TOOL_SEARCH_TOOL_NAME)) && !result.includes(TOOL_SEARCH_TOOL_NAME) && !isToolDeniedByPolicy(TOOL_SEARCH_TOOL_NAME, disallowedTools)) {
    result.push(TOOL_SEARCH_TOOL_NAME);
  }
  return sortToolNamesForPrompt([...new Set(result)]);
}

function sortToolNamesForPrompt(tools: string[]): string[] {
  return [...tools].sort(compareToolNamesForPrompt);
}

function compareToolNamesForPrompt(left: string, right: string): number {
  return toolPromptOrder(left) - toolPromptOrder(right) || left.localeCompare(right);
}

function toolPromptOrder(tool: string): number {
  const index = DEFAULT_TOOL_NAMES.findIndex((candidate) => toolNameMatches(candidate, tool));
  return index >= 0 ? index : DEFAULT_TOOL_NAMES.length;
}

function isToolVisibleInSandboxPrompt(tool: string, writePolicy?: SandboxWritePolicy): boolean {
  if (writePolicy !== "read_only" || tool === TOOL_SEARCH_TOOL_NAME || tool === "tool.search") {
    return true;
  }
  try {
    return isReadOnlySandboxAction(normalizeToolAction({ action: tool }));
  } catch {
    return false;
  }
}

function isCapabilityVisibleInSandboxPrompt(capability: CapabilityDescriptor, writePolicy?: SandboxWritePolicy): boolean {
  return writePolicy !== "read_only" || capability.readOnly === true || capability.id === SKILL_ACTIVATE_CAPABILITY_ID;
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

function assertRawToolAllowedByPolicy(rawAction: unknown, allowedTools?: string[], disallowedTools?: string[]): void {
  if (typeof rawAction !== "string" || !rawAction.trim()) {
    return;
  }
  if (allowedTools?.length && !isToolNameAllowedByPolicy(rawAction, allowedTools)) {
    throw new Error(`Tool action denied by run tool policy: ${rawAction}`);
  }
  if (isToolDeniedByPolicy(rawAction, disallowedTools)) {
    throw new Error(`Tool action denied by run tool policy: ${rawAction}`);
  }
}

function assertDynamicCapabilityAllowedByToolPolicy(
  capability: CapabilityDescriptor,
  allowedTools?: string[],
  disallowedTools?: string[]
): void {
  if (!isCapabilityAllowedByRunToolPolicy(capability, allowedTools, disallowedTools)) {
    throw new Error(`Tool action denied by run tool policy: ${capability.name}`);
  }
}

function isCapabilityAllowedByRunToolPolicy(
  capability: CapabilityDescriptor,
  allowedTools?: string[],
  disallowedTools?: string[]
): boolean {
  if (allowedTools?.length && !capabilityToolNames(capability).some((name) => isToolNameAllowedByPolicy(name, allowedTools))) {
    return false;
  }
  if (capabilityToolNames(capability).some((name) => isToolDeniedByPolicy(name, disallowedTools))) {
    return false;
  }
  return true;
}

function capabilityToolNames(capability: CapabilityDescriptor): string[] {
  return [
    capability.name,
    capability.id,
    capability.permissionName,
    capability.title ?? "",
    capability.providerId
  ].filter(Boolean);
}

function isToolNameAllowedByPolicy(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.some((allowed) => toolNameMatches(allowed, toolName));
}

function isToolDeniedByPolicy(toolName: string, disallowedTools: string[] | undefined): boolean {
  return Boolean(disallowedTools?.some((denied) => toolNameMatches(denied, toolName)));
}

function toolNameMatches(pattern: string, toolName: string): boolean {
  const left = pattern.trim();
  const right = toolName.trim();
  if (!left || !right) {
    return false;
  }
  if (left === right || left.toLowerCase() === right.toLowerCase()) {
    return true;
  }
  try {
    const leftAction = normalizeToolAction({ action: left }).type;
    const rightAction = normalizeToolAction({ action: right }).type;
    return leftAction === rightAction;
  } catch {
    return false;
  }
}

function localCapabilityIdForAction(action: ToolAction["type"]): string {
  const visibleNameByAction: Partial<Record<ToolAction["type"], string>> = {
    "file.read": "Read",
    "file.list": "LS",
    "file.glob": "Glob",
    "file.grep": "Grep",
    "file.write": "Write",
    "file.edit": "Edit",
    "file.delete": "file.delete",
    "notebook.edit": "NotebookEdit",
    "shell.exec": "Bash",
    "powershell.exec": "PowerShell",
    "process.start": "ProcessStart",
    "process.status": "ProcessStatus",
    "process.list": "ProcessList",
    "process.tail": "ProcessTail",
    "process.grep": "ProcessGrep",
    "process.stop": "ProcessStop",
    "web.search": "WebSearch",
    "web.fetch": "WebFetch",
    "config.get": "Config",
    "config.set": "Config",
    "mcp.resources": "McpResources",
    "mcp.read": "McpRead",
    "mcp.auth": "McpAuth",
    "mcp.call": "McpCall",
    "skill.invoke": "SkillInvoke",
    "todo.write": "TodoWrite",
    "ask_user_question": "AskUserQuestion",
    "plan.enter": "EnterPlanMode",
    "plan.exit": "ExitPlanMode",
    "worktree.enter": "EnterWorktree",
    "worktree.exit": "ExitWorktree",
    "blackboard.write": "BlackboardWrite",
    "blackboard.search": "BlackboardSearch",
    "blackboard.read": "BlackboardRead",
    "blackboard.list": "BlackboardList",
    "agent.list": "AgentList",
    "agent.status": "AgentStatus",
    "agent.stop": "AgentStop",
    "agent.continue": "AgentContinue",
    "agent.message": "AgentMessage",
    "runtime.sleep": "RuntimeSleep",
    "structured.output": "StructuredOutput",
    "repl.mode": "ReplMode",
    "schedule.create": "ScheduleCreate",
    "schedule.list": "ScheduleList",
    "schedule.delete": "ScheduleDelete",
    "remote.trigger": "RemoteTrigger",
    "team.create": "TeamCreate",
    "team.delete": "TeamDelete",
    "task.create": "TaskCreate",
    "task.update": "TaskUpdate",
    "task.get": "TaskGet",
    "task.list": "TaskList",
    "task.output": "TaskOutput",
    "task.stop": "TaskStop",
    "lsp.diagnostics": "lsp_diagnostics",
    "lsp.hover": "lsp_hover",
    "lsp.definition": "lsp_definition",
    "lsp.references": "lsp_references",
    "lsp.document_symbols": "lsp_document_symbols",
    "lsp.workspace_symbols": "lsp_workspace_symbols",
    "lsp.completion": "lsp_completion",
    "lsp.code_actions": "lsp_code_actions",
    "lsp.rename_preview": "lsp_rename_preview",
    "lsp.format": "lsp_format",
    "agent.delegate": "Agent"
  };
  return `local_tool.${visibleNameByAction[action] ?? action}`;
}

function isDynamicCapabilityAction(action: string | undefined): action is string {
  return typeof action === "string" && (action.startsWith("mcp__") || action === SKILL_ACTIVATE_TOOL_NAME);
}

function isVisibleCapability(capability: CapabilityDescriptor): boolean {
  return capability.modelVisible && capability.status !== "disabled";
}

function isVisibleMcpCapability(capability: CapabilityDescriptor): boolean {
  return capability.kind === "mcp_tool" && isVisibleCapability(capability);
}

function isVisibleActiveCapability(capability: CapabilityDescriptor): boolean {
  return (capability.kind === "mcp_tool" || capability.id === SKILL_ACTIVATE_CAPABILITY_ID) && isVisibleCapability(capability);
}

function isDynamicCapabilityLoaded(capability: CapabilityDescriptor, discoveredDynamicToolNames: Set<string>): boolean {
  if (!isVisibleActiveCapability(capability)) {
    return false;
  }
  if (capability.alwaysLoad) {
    return true;
  }
  if (capability.kind === "mcp_tool") {
    return discoveredDynamicToolNames.has(capability.name);
  }
  return false;
}

function dynamicCapabilityMatchesAction(capability: CapabilityDescriptor, action: string): boolean {
  if (capability.kind === "mcp_tool") {
    return capability.name === action;
  }
  return capability.id === SKILL_ACTIVATE_CAPABILITY_ID && capability.name === action;
}

function dynamicCapabilityToolSchemas(
  capabilities: CapabilityDescriptor[],
  discoveredDynamicToolNames: Set<string> = new Set<string>()
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    capabilities
      .filter((capability) => isVisibleActiveCapability(capability) && (capability.alwaysLoad || discoveredDynamicToolNames.has(capability.name)))
      .sort(compareCapabilitiesForPrompt)
      .map((capability) => [
        capability.name,
        {
          action: capability.name,
          description: capability.description,
          inputs: capability.inputSchema ?? { type: "object" },
          input_schema: capability.inputSchema ?? { type: "object" },
          output: capability.outputSchema,
          risk_class: capability.riskClass,
          read_only: capability.readOnly === true,
          concurrency_class: capability.concurrencyClass,
          permission: capability.permissionName,
          provider: capability.providerId
        }
      ])
  );
}

function compareCapabilitiesForPrompt(left: CapabilityDescriptor, right: CapabilityDescriptor): number {
  return left.kind.localeCompare(right.kind) ||
    left.providerId.localeCompare(right.providerId) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id);
}

function renderToolSchemas(allowedTools: string[], dynamicSchemas: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> {
  return allowedTools.map((tool) => {
    const dynamicSchema = dynamicSchemas[tool];
    if (dynamicSchema) {
      return dynamicSchema;
    }
    const localSchema = LOCAL_TOOL_SCHEMAS[tool];
    if (localSchema) {
      return localToolSchemaForModel(localSchema);
    }
    return {
      action: tool,
      inputs: { action: tool },
      input_schema: {
        type: "object",
        properties: { action: { type: "string", description: tool } },
        additionalProperties: true
      },
      notes: "No detailed schema is registered for this tool."
    };
  });
}

function renderDeferredToolCatalog(capabilities: CapabilityDescriptor[], discoveredDynamicToolNames: Set<string>): DeferredToolCatalogSummary | undefined {
  const deferredMcpTools = capabilities.filter((capability) => isVisibleMcpCapability(capability) && !discoveredDynamicToolNames.has(capability.name));
  const searchableSkills = capabilities.filter((capability) => capability.kind === "skill" && capability.id !== SKILL_ACTIVATE_CAPABILITY_ID && capability.modelVisible && capability.status !== "disabled");
  if (!deferredMcpTools.length && !searchableSkills.length) {
    return undefined;
  }
  const providerCounts = new Map<string, number>();
  for (const capability of deferredMcpTools) {
    providerCounts.set(capability.providerId, (providerCounts.get(capability.providerId) ?? 0) + 1);
  }
  return {
    deferred_mcp_tools: deferredMcpTools.length,
    searchable_skills: searchableSkills.length,
    providers: [...providerCounts.entries()]
      .map(([provider_id, count]) => ({ provider_id, count }))
      .sort((a, b) => b.count - a.count || a.provider_id.localeCompare(b.provider_id))
      .slice(0, 12),
    hint: "Use ToolSearch(query, limit) to discover deferred MCP tools or skill names. Deferred MCP schemas are loaded on the next turn after discovery."
  };
}

function isToolSearchAction(action: string | undefined): action is string {
  return typeof action === "string" && (action === TOOL_SEARCH_TOOL_NAME || action === "tool.search");
}

function parseToolSearchInputs(inputs: Record<string, unknown>): { query?: string; limit: number; kind?: string; provider?: string } {
  const query = normalizeSearchText(inputs.query ?? inputs.search ?? inputs.q);
  const limit = clampToolSearchLimit(inputs.limit ?? inputs.max_results ?? inputs.maxResults);
  const kind = normalizeSearchText(inputs.kind);
  const provider = normalizeSearchText(inputs.provider ?? inputs.provider_id ?? inputs.providerId);
  return {
    query: query || undefined,
    limit,
    kind: kind || undefined,
    provider: provider || undefined
  };
}

function searchDeferredCapabilities(
  capabilities: CapabilityDescriptor[],
  search: { query?: string; limit: number; kind?: string; provider?: string },
  discoveredDynamicToolNames: Set<string>
): ToolSearchMatch[] {
  const candidates = capabilities
    .filter((capability) => shouldIncludeInToolSearch(capability, search, discoveredDynamicToolNames))
    .map((capability): ToolSearchMatch | undefined => {
      const score = scoreToolSearchCapability(capability, search.query);
      if (search.query && score === undefined) {
        return undefined;
      }
      return {
        action: toolSearchActionForCapability(capability),
        capabilityId: capability.id,
        kind: capability.kind,
        name: capability.name,
        title: capability.title,
        description: capability.description,
        providerId: capability.providerId,
        permissionName: capability.permissionName,
        searchHint: capability.searchHint,
        readOnly: capability.readOnly,
        concurrencyClass: capability.concurrencyClass,
        loadNextTurn: capability.kind === "mcp_tool" && !discoveredDynamicToolNames.has(capability.name),
        activationName: capability.kind === "skill" ? capability.name : undefined,
        score
      };
    })
    .filter((match): match is ToolSearchMatch => match !== undefined);
  return candidates
    .sort((a, b) => {
      const scoreA = a.score ?? Number.POSITIVE_INFINITY;
      const scoreB = b.score ?? Number.POSITIVE_INFINITY;
      return scoreA - scoreB ||
        kindPriorityForToolSearch(a.kind) - kindPriorityForToolSearch(b.kind) ||
        a.providerId.localeCompare(b.providerId) ||
        a.name.localeCompare(b.name);
    })
    .slice(0, search.limit);
}

function shouldIncludeInToolSearch(
  capability: CapabilityDescriptor,
  search: { query?: string; kind?: string; provider?: string },
  discoveredDynamicToolNames: Set<string>
): boolean {
  if (!isVisibleCapability(capability)) {
    return false;
  }
  if (capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
    return false;
  }
  if (search.kind && capability.kind !== search.kind) {
    return false;
  }
  if (search.provider) {
    const provider = search.provider.toLowerCase();
    const providerId = capability.providerId.toLowerCase();
    const providerName = String(capability.metadata?.server_id ?? "").toLowerCase();
    if (!providerId.includes(provider) && !providerName.includes(provider)) {
      return false;
    }
  }
  if (capability.kind === "mcp_tool" && discoveredDynamicToolNames.has(capability.name)) {
    return false;
  }
  if (capability.kind !== "local_tool" && capability.kind !== "lsp_tool" && capability.kind !== "mcp_tool" && capability.kind !== "skill") {
    return false;
  }
  return true;
}

function toolSearchActionForCapability(capability: CapabilityDescriptor): string {
  if (capability.kind === "skill") {
    return SKILL_ACTIVATE_TOOL_NAME;
  }
  const metadataAction = capability.metadata?.action;
  return typeof metadataAction === "string" && metadataAction.trim().length > 0
    ? metadataAction
    : capability.name;
}

function scoreToolSearchCapability(capability: CapabilityDescriptor, query?: string): number | undefined {
  if (!query) {
    return 0;
  }
  const normalizedQuery = query.toLowerCase();
  const aliases = Array.isArray(capability.metadata?.aliases)
    ? capability.metadata.aliases.filter((alias): alias is string => typeof alias === "string")
    : [];
  const fields = [
    capability.name,
    toolSearchActionForCapability(capability),
    ...aliases,
    capability.title ?? "",
    capability.permissionName,
    capability.description,
    capability.providerId,
    capability.searchHint ?? "",
    JSON.stringify(capability.metadata ?? {})
  ].map((field) => field.toLowerCase());
  if (fields.some((field) => field === normalizedQuery)) {
    return 0;
  }
  if (fields.some((field) => field.startsWith(normalizedQuery))) {
    return 1;
  }
  if (fields.some((field) => field.includes(normalizedQuery))) {
    return 2;
  }
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (terms.length > 1) {
    const joinedFields = fields.join(" ");
    if (terms.every((term) => joinedFields.includes(term))) {
      return 3;
    }
  }
  return undefined;
}

function kindPriorityForToolSearch(kind: string): number {
  if (kind === "mcp_tool") {
    return 0;
  }
  if (kind === "skill") {
    return 1;
  }
  return 2;
}

function renderToolSearchDetail(
  search: { query?: string; limit: number; kind?: string; provider?: string },
  matches: ToolSearchMatch[],
  loadedToolNames: string[]
): string {
  const lines = [
    `ToolSearch query=${JSON.stringify(search.query ?? "")} limit=${search.limit}${search.kind ? ` kind=${search.kind}` : ""}${search.provider ? ` provider=${search.provider}` : ""}`,
    matches.length ? `Matches: ${matches.length}` : "Matches: none"
  ];
  if (loadedToolNames.length) {
    lines.push(`Loaded for next turn: ${loadedToolNames.join(", ")}`);
  }
  for (const [index, match] of matches.entries()) {
    lines.push(`${index + 1}. ${match.action}${match.loadNextTurn ? " (load next turn)" : ""}`);
    if (match.name !== match.action) {
      lines.push(`   name: ${match.name}`);
    }
    lines.push(`   kind: ${match.kind}`);
    lines.push(`   provider: ${match.providerId}`);
    lines.push(`   title: ${previewActivityValue(match.title ?? match.name)}`);
    lines.push(`   description: ${previewActivityValue(match.description)}`);
    if (match.searchHint) {
      lines.push(`   hint: ${previewActivityValue(match.searchHint)}`);
    }
    if (match.activationName) {
      lines.push(`   activate with: skill.activate { name: ${JSON.stringify(match.activationName)} }`);
    }
  }
  return lines.join("\n");
}

function normalizeSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampToolSearchLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 8;
  }
  return Math.min(Math.floor(parsed), 12);
}

async function parseCodingLoopModelResultWithRepair(
  text: string,
  objective: string,
  provider: OpenAIProvider
): Promise<CodingLoopModelResult> {
  const parsed = parseCodingLoopModelResult(text);
  const validationError = validateCodingLoopModelResult(parsed);
  if (validationError) {
    return repairCodingLoopModelResult(text, objective, provider, validationError);
  }
  if (parsed.message !== text || parsed.tool_calls.length > 0 || parsed.status !== "continue") {
    return parsed;
  }
  return repairCodingLoopModelResult(text, objective, provider);
}

async function repairCodingLoopModelResult(
  text: string,
  objective: string,
  provider: OpenAIProvider,
  validationError?: string
): Promise<CodingLoopModelResult> {
  const repaired = await provider.generateText({
    model: provider.workerModel,
    system: [{
      text: [
        "You repair invalid JSON for Swarm's coding loop.",
        "Return exactly one valid JSON object and nothing else.",
        "The object must have keys: status, summary, message, files_touched, next_actions, tool_calls.",
        "status must be continue, completed, or failed.",
        "tool_calls must be an array.",
        "status=continue must include at least one executable tool_call; if no tool is needed, set status=completed or status=failed.",
        "Every tool call must include a non-empty action string that matches an allowed tool.",
        validationError ? `Validation error: ${validationError}` : undefined
      ].filter(Boolean).join(" "),
      cache: true
    }],
    user: JSON.stringify({
      objective,
      invalid_output: text,
      validation_error: validationError
    }, null, 2),
    usage: { purpose: "coding_loop_json_repair" },
    responseFormat: "json_object",
    maxOutputTokens: MODEL_OUTPUT_TOKENS_REPAIR
  });
  const parsed = parseCodingLoopModelResult(repaired);
  const repairedValidationError = validateCodingLoopModelResult(parsed);
  if (repairedValidationError) {
    const safeFallback = completedResultFromRepairedBareContinue(parsed, repaired, repairedValidationError);
    if (safeFallback) {
      return safeFallback;
    }
    return invalidCodingLoopModelResult(repairedValidationError, repaired);
  }
  return parsed;
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
        inputs: toolCallInputs(item),
        reason: typeof item.reason === "string" ? item.reason : undefined
      };
    })
    .filter((item): item is CodingLoopToolCall => item !== undefined);
}

function toolCallInputs(item: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["inputs", "parameters", "arguments", "args"]) {
    if (isRecord(item[key])) {
      return item[key];
    }
  }
  return flatToolCallInputs(item);
}

function flatToolCallInputs(item: Record<string, unknown>): Record<string, unknown> {
  const inputs = { ...item };
  delete inputs.id;
  delete inputs.action;
  delete inputs.type;
  delete inputs.reason;
  delete inputs.inputs;
  delete inputs.parameters;
  delete inputs.arguments;
  delete inputs.args;
  return inputs;
}

function workspaceCompletionGapResult(
  result: CodingLoopModelResult,
  changedFiles: Set<string>,
  options: { expectedSideEffects?: string; writePolicy?: SandboxWritePolicy } = {}
): CodingLoopToolResult | undefined {
  if (result.status !== "completed") {
    return undefined;
  }
  const claimedFiles = uniqueNonEmptyStrings(result.files_touched);
  const unverifiedClaims = claimedFiles.filter((file) => !changedFiles.has(file));
  if (expectsWorkspaceModification(options.expectedSideEffects) && options.writePolicy !== "read_only" && unverifiedClaims.length > 0) {
    return {
      id: `workspace_claim_unverified_${randomUUID()}`,
      action: "workspace.verify",
      status: "failed",
      summary: `Unverified workspace change claim: ${unverifiedClaims.slice(0, 6).join(", ")}`,
      content: [
        `The model claimed changed files, but no successful write/edit tool result recorded those paths: ${unverifiedClaims.join(", ")}.`,
        "Use file.write or file.edit to make the requested change before returning completed."
      ].join("\n"),
      errorCode: "UNVERIFIED_WORKSPACE_CHANGE",
      recoverySuggestion: "Make the requested workspace change through file.write or file.edit, then report only paths confirmed by tool results."
    };
  }
  if (expectsWorkspaceModification(options.expectedSideEffects) && changedFiles.size === 0) {
    return {
      id: `workspace_change_missing_${randomUUID()}`,
      action: "workspace.verify",
      status: "failed",
      summary: "Expected workspace modification, but no files changed",
      content: [
        "The execution route expects this task to modify the workspace, but no successful write/edit tool result was recorded.",
        "Do not claim the file was created or updated until a write/edit tool result proves it."
      ].join("\n"),
      errorCode: "WORKSPACE_CHANGE_MISSING",
      recoverySuggestion: "Use file.write or file.edit for the requested workspace change, or return failed with a concrete blocker."
    };
  }
  return undefined;
}

function verificationCompletionGapResult(
  objective: string,
  result: CodingLoopModelResult,
  testsRun: Set<string>,
  toolResults: CodingLoopToolResult[]
): CodingLoopToolResult | undefined {
  if (result.status !== "completed" || testsRun.size > 0) {
    return undefined;
  }
  const finalText = `${result.summary}\n${result.message}\n${result.next_actions.join("\n")}`;
  if (!expectsVerificationCommand(objective, finalText)) {
    return undefined;
  }
  const hasVerificationToolAttempt = toolResults.some((toolResult) => isVerificationToolAction(toolResult.action));
  if (hasVerificationToolAttempt && !claimsVerificationPassed(finalText)) {
    return undefined;
  }
  return {
    id: `verification_claim_unverified_${randomUUID()}`,
    action: "verification.verify",
    status: "failed",
    summary: "Expected verification command evidence, but no check was recorded",
    content: [
      "The objective or final answer requires running verification, but no successful code.test/code.lint result was recorded.",
      "Do not claim tests, lint, build, or verification passed from reasoning alone.",
      "In read_only policy, use code.test or code.lint for verification commands. If no command is suitable, return a concrete verification gap instead of completed."
    ].join("\n"),
    errorCode: "UNVERIFIED_VERIFICATION_CLAIM",
    recoverySuggestion: "Run the required verification via code.test/code.lint, or return failed/blocked with the exact reason verification cannot be performed."
  };
}

function expectsVerificationCommand(objective: string, finalText: string): boolean {
  if (claimsVerificationPassed(finalText)) {
    return true;
  }
  return explicitlyRequestsVerificationCommand(objective);
}

function explicitlyRequestsVerificationCommand(text: string): boolean {
  const actionableText = stripHistoricalVerificationEvidence(text);
  const lowered = actionableText.toLowerCase();
  const verificationTargets = "(?:test suite|tests?|lint|linter|typecheck|type check|build|checks|check command)";
  const namedVerificationCommands = "(?:code\\.test|code\\.lint)|(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|lint|build|check|typecheck)|(?:cargo|go|mvn|gradle)\\s+test|pytest";
  if (
    new RegExp(`\\b(run|execute|rerun|start|use)\\b[\\s\\S]{0,80}\\b${verificationTargets}\\b`).test(lowered)
    || new RegExp(`\\b(run|execute|rerun|start|use)\\b[\\s\\S]{0,80}\\b(?:${namedVerificationCommands})\\b`).test(lowered)
    || /\b(verification|verify)\s+command\b/.test(lowered)
  ) {
    return true;
  }
  return /(?:运行|执行|跑|重跑|重新运行)[\s\S]{0,40}(?:测试|单测|用例|验证|检查|构建|类型检查|lint|build|typecheck|npm test|npm run|pnpm|yarn)/.test(actionableText);
}

function stripHistoricalVerificationEvidence(text: string): string {
  return text
    .replace(/"tests_run"\s*:\s*\[[\s\S]*?\]/gi, "")
    .replace(/\btests_run\b\s*[:=][^\r\n]+/gi, "")
    .replace(/\bchecks_run\b\s*[:=][^\r\n]+/gi, "")
    .replace(/\btests run\b\s*[:=][^\r\n]+/gi, "")
    .replace(/\bchecks run\b\s*[:=][^\r\n]+/gi, "");
}

function claimsVerificationPassed(text: string): boolean {
  const lowered = text.toLowerCase();
  return /\b(tests?|lint|build|typecheck|checks?|verification)\s+(passed|succeeded|successful|green)\b/.test(lowered)
    || /(测试|验证|检查|构建).*(通过|成功)|通过.*(测试|验证|检查|构建)/.test(text);
}

function isVerificationToolAction(action: string): boolean {
  return ["code.test", "code.lint", "code.build", "shell.exec", "powershell.exec", "exec"].includes(action);
}

type WorkspaceTransactionIssue = {
  kind: "semantic_conflict" | "formatting_risk";
  file: string;
  source: string;
  selector: string;
  firstLine: number;
  secondLine: number;
  overlappingProperties: string[];
  summary: string;
  detail: string;
};

type CssRuleRecord = {
  selector: string;
  normalizedSelector: string;
  properties: Set<string>;
  source: string;
  line: number;
};

const CSS_TRANSACTION_EXTENSIONS = new Set([".css", ".html", ".htm"]);
const CSS_TRANSACTION_PROPERTIES = new Set([
  "animation",
  "background",
  "border-radius",
  "content",
  "filter",
  "height",
  "inset",
  "left",
  "opacity",
  "position",
  "right",
  "top",
  "transform",
  "width",
  "z-index"
]);

async function workspaceTransactionConflictResult(
  workspace: string,
  changedFiles: Set<string>
): Promise<CodingLoopToolResult | undefined> {
  if (changedFiles.size === 0) {
    return undefined;
  }

  const issues: WorkspaceTransactionIssue[] = [];
  for (const file of changedFiles) {
    const absolutePath = resolveChangedWorkspacePath(workspace, file);
    if (!absolutePath || !CSS_TRANSACTION_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
      continue;
    }
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const displayFile = file.replace(/\\/g, "/");
    issues.push(...inspectFormattingTransactionIssues(displayFile, absolutePath, content));
    issues.push(...inspectCssTransactionConflicts(file.replace(/\\/g, "/"), absolutePath, content));
    if (issues.length >= 3) {
      break;
    }
  }

  if (issues.length === 0) {
    return undefined;
  }

  const first = issues[0];
  const issueLines = issues.slice(0, 3).map((issue) => [
    `- ${issue.summary}`,
    `  ${issue.detail}`
  ].join("\n"));
  return {
    id: `workspace_transaction_${randomUUID()}`,
    action: "workspace.transaction",
    status: "failed",
    summary: first.kind === "formatting_risk"
      ? `Workspace formatting risk in ${first.file}`
      : `Potential semantic conflict in ${first.file}: ${first.selector}`,
    content: [
      "Swarm's workspace transaction inspector found a likely self-overwrite before accepting completion.",
      ...issueLines,
      "Repair the file, then return completed only after the duplicate rule is consolidated or split into distinct selectors."
    ].join("\n"),
    data: { issues },
    errorCode: first.kind === "formatting_risk" ? "TRANSACTION_FORMATTING_RISK" : "TRANSACTION_SEMANTIC_CONFLICT",
    recoverySuggestion: first.kind === "formatting_risk"
      ? "Rewrite generated HTML/CSS/JS with stable line breaks and indentation before completion so reviews, diffs, and follow-up edits are reliable."
      : "Consolidate duplicate global pseudo-element CSS rules, or use distinct elements/selectors so a later rule does not override the earlier visual layer."
  };
}

function resolveChangedWorkspacePath(workspace: string, file: string): string | undefined {
  const root = resolve(workspace);
  const absolutePath = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return absolutePath;
  }
  return undefined;
}

function inspectCssTransactionConflicts(file: string, absolutePath: string, content: string): WorkspaceTransactionIssue[] {
  const extension = extname(absolutePath).toLowerCase();
  const sources = extension === ".css"
    ? [{ name: file, css: content, startLine: 1 }]
    : extractInlineCssSources(file, content);
  return sources.flatMap((source) => inspectCssSourceForTransactionConflicts(file, source.name, source.css, source.startLine));
}

function inspectFormattingTransactionIssues(file: string, absolutePath: string, content: string): WorkspaceTransactionIssue[] {
  const extension = extname(absolutePath).toLowerCase();
  if (![".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx"].includes(extension)) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (content.length < 8_000 || lines.length > 5 || longestLine < 4_000) {
    return [];
  }
  return [{
    kind: "formatting_risk",
    file,
    source: file,
    selector: "file formatting",
    firstLine: 1,
    secondLine: 1,
    overlappingProperties: [],
    summary: `${file}:1 is a generated ${extension.slice(1)} file with ${content.length} bytes across ${lines.length} line(s)`,
    detail: "Large single-line generated files make diffs, reviews, transaction checks, and follow-up edits unreliable."
  }];
}

function extractInlineCssSources(file: string, content: string): Array<{ name: string; css: string; startLine: number }> {
  const sources: Array<{ name: string; css: string; startLine: number }> = [];
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = stylePattern.exec(content)) !== null) {
    const fullMatch = match[0];
    const css = match[1] ?? "";
    const openTagEnd = fullMatch.indexOf(">") + 1;
    const cssStart = match.index + Math.max(openTagEnd, 0);
    sources.push({
      name: `${file}<style#${sources.length + 1}>`,
      css,
      startLine: lineNumberAt(content, cssStart)
    });
  }
  return sources;
}

function inspectCssSourceForTransactionConflicts(
  file: string,
  source: string,
  css: string,
  startLine: number
): WorkspaceTransactionIssue[] {
  const rules = parseCssRuleRecords(source, css, startLine);
  const previousBySelector = new Map<string, CssRuleRecord[]>();
  const issues: WorkspaceTransactionIssue[] = [];
  for (const rule of rules) {
    const previousRules = previousBySelector.get(rule.normalizedSelector) ?? [];
    for (const previous of previousRules) {
      const overlappingProperties = [...rule.properties]
        .filter((property) => previous.properties.has(property) && CSS_TRANSACTION_PROPERTIES.has(property))
        .sort();
      if (isConflictingGlobalPseudoOverride(rule.normalizedSelector, overlappingProperties)) {
        issues.push({
          kind: "semantic_conflict",
          file,
          source,
          selector: rule.selector,
          firstLine: previous.line,
          secondLine: rule.line,
          overlappingProperties,
          summary: `${source}:${rule.line} redefines ${rule.selector} from line ${previous.line}`,
          detail: `Both rules set high-impact pseudo-element properties (${overlappingProperties.join(", ")}), so the later CSS rule can erase the earlier visual layer.`
        });
        break;
      }
    }
    previousRules.push(rule);
    previousBySelector.set(rule.normalizedSelector, previousRules);
  }
  return issues;
}

function parseCssRuleRecords(source: string, css: string, startLine: number): CssRuleRecord[] {
  const withoutComments = maskCssComments(css);
  const rules: CssRuleRecord[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(withoutComments)) !== null) {
    const selectorText = (match[1] ?? "").trim();
    if (!selectorText || selectorText.startsWith("@") || selectorText.includes("@keyframes")) {
      continue;
    }
    const properties = parseCssTransactionProperties(match[2] ?? "");
    if (properties.size === 0) {
      continue;
    }
    const line = startLine + lineNumberAt(withoutComments, match.index) - 1;
    for (const selector of selectorText.split(",").map((item) => item.trim()).filter(Boolean)) {
      rules.push({
        selector,
        normalizedSelector: normalizeCssSelector(selector),
        properties,
        source,
        line
      });
    }
  }
  return rules;
}

function parseCssTransactionProperties(body: string): Set<string> {
  const properties = new Set<string>();
  for (const declaration of body.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) {
      continue;
    }
    const property = normalizeCssProperty(declaration.slice(0, separator));
    if (property && CSS_TRANSACTION_PROPERTIES.has(property)) {
      properties.add(property);
    }
  }
  return properties;
}

function normalizeCssSelector(selector: string): string {
  return selector.replace(/\s+/g, "").toLowerCase();
}

function normalizeCssProperty(property: string): string {
  const normalized = property.trim().toLowerCase();
  if (normalized === "background" || normalized.startsWith("background-")) {
    return "background";
  }
  if (normalized === "animation" || normalized.startsWith("animation-")) {
    return "animation";
  }
  if (normalized === "border-radius" || normalized.startsWith("border-") && normalized.endsWith("-radius")) {
    return "border-radius";
  }
  return normalized;
}

function isConflictingGlobalPseudoOverride(selector: string, overlappingProperties: string[]): boolean {
  if (!/^(?:body|html|:root)(?::before|::before|:after|::after)$/i.test(selector)) {
    return false;
  }
  return overlappingProperties.length >= 2
    || overlappingProperties.includes("content") && overlappingProperties.some((property) => property !== "content");
}

function maskCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(index, 0), text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function expectsWorkspaceModification(expectedSideEffects: string | undefined): boolean {
  return expectedSideEffects === "modify_workspace";
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validateCodingLoopToolCalls(toolCalls: CodingLoopToolCall[]): string | undefined {
  const invalid = toolCalls.find((call) => typeof call.action !== "string" || !call.action.trim());
  if (invalid) {
    return "tool_calls contained an empty or missing action value.";
  }
  const malformed = toolCalls
    .map((call) => validateLocalToolCallInputs(call))
    .find((message): message is string => Boolean(message));
  if (malformed) {
    return malformed;
  }
  return undefined;
}

function validateCodingLoopModelResult(result: CodingLoopModelResult): string | undefined {
  if (result.status === "continue" && result.tool_calls.length === 0) {
    return CONTINUE_WITHOUT_TOOL_CALLS_ERROR;
  }
  return validateCodingLoopToolCalls(result.tool_calls);
}

const CONTINUE_WITHOUT_TOOL_CALLS_ERROR = "status=continue requires at least one executable tool_call. Use status=completed or status=failed when no tool is needed.";

function completedResultFromRepairedBareContinue(
  result: CodingLoopModelResult,
  repairedText: string,
  validationError: string
): CodingLoopModelResult | undefined {
  if (validationError !== CONTINUE_WITHOUT_TOOL_CALLS_ERROR) {
    return undefined;
  }
  const repaired = parseJsonObject(repairedText);
  const hasMessage = typeof repaired.message === "string" && repaired.message.trim().length > 0;
  const hasSummary = typeof repaired.summary === "string" && repaired.summary.trim().length > 0;
  if (repaired.status !== "continue" || !Array.isArray(repaired.tool_calls) || repaired.tool_calls.length > 0 || (!hasMessage && !hasSummary)) {
    return undefined;
  }
  return {
    ...result,
    status: "completed",
    tool_calls: []
  };
}

function validateLocalToolCallInputs(call: CodingLoopToolCall): string | undefined {
  if (isToolSearchAction(call.action) || isDynamicCapabilityAction(call.action)) {
    return undefined;
  }
  try {
    const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
    return validateLocalToolActionInputs(action);
  } catch (error) {
    return `tool_call ${call.id ?? call.action ?? "unknown"} has invalid inputs: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function invalidCodingLoopModelResult(validationError: string, text: string): CodingLoopModelResult {
  return {
    status: "failed",
    message: [
      `Swarm could not repair the model tool call JSON: ${validationError}`,
      `Model output preview: ${truncateTextBytes(text, 2_000)}`
    ].join("\n"),
    summary: `Invalid model tool call JSON: ${validationError}`,
    tool_calls: [],
    files_touched: [],
    next_actions: ["Retry the request or narrow it so the model emits valid tool_calls with explicit action names."]
  };
}

function partitionToolCalls(
  calls: CodingLoopToolCall[],
  options: { agentSpecs?: AgentSpec[]; maxParallel?: number } = {}
): Array<{ concurrent: boolean; concurrencyClass: ToolConcurrencyClass; calls: CodingLoopToolCall[] }> {
  const batches: Array<{ concurrent: boolean; concurrencyClass: ToolConcurrencyClass; calls: CodingLoopToolCall[] }> = [];
  const maxParallel = Math.max(1, options.maxParallel ?? calls.length);
  for (const call of calls) {
    let concurrencyClass: ToolConcurrencyClass = "write_exclusive";
    try {
      if (call.action === TOOL_SEARCH_TOOL_NAME || call.action === "tool.search") {
        concurrencyClass = "read_parallel";
      } else if (call.action?.startsWith("mcp__")) {
        concurrencyClass = "network_limited";
      } else if (call.action === SKILL_ACTIVATE_TOOL_NAME) {
        concurrencyClass = "write_exclusive";
      } else {
        concurrencyClass = classifyToolCallConcurrency(call, options.agentSpecs);
      }
    } catch {
      concurrencyClass = "write_exclusive";
    }
    const concurrent = concurrencyClass === "read_parallel" || concurrencyClass === "delegate_parallel";
    const last = batches[batches.length - 1];
    if (concurrent && canShareConcurrentBatch(last, call, concurrencyClass, options.agentSpecs ?? [], maxParallel)) {
      last.calls.push(call);
    } else {
      batches.push({ concurrent, concurrencyClass, calls: [call] });
    }
  }
  return batches;
}

function classifyToolCallConcurrency(call: CodingLoopToolCall, agentSpecs: AgentSpec[] = []): ToolConcurrencyClass {
  const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
  if (isParallelReadOnlyDelegateAction(action, agentSpecs)) {
    return "read_parallel";
  }
  if (isParallelScopedWriteDelegateAction(action, agentSpecs)) {
    return "delegate_parallel";
  }
  return classifyToolConcurrency(action);
}

function canShareConcurrentBatch(
  last: { concurrent: boolean; concurrencyClass: ToolConcurrencyClass; calls: CodingLoopToolCall[] } | undefined,
  call: CodingLoopToolCall,
  concurrencyClass: ToolConcurrencyClass,
  agentSpecs: AgentSpec[],
  maxParallel: number
): boolean {
  if (!last?.concurrent || last.concurrencyClass !== concurrencyClass || last.calls.length >= maxParallel) {
    return false;
  }
  if (concurrencyClass !== "delegate_parallel") {
    return true;
  }
  return canBatchParallelScopedWriteDelegate(last.calls, call, agentSpecs);
}

function isParallelReadOnlyDelegateAction(action: ToolAction, agentSpecs: AgentSpec[]): boolean {
  if (action.type !== "agent.delegate" || action.preferred_mode !== "parallel") {
    return false;
  }
  const spec = findDelegateAgentSpec(action, agentSpecs);
  return spec?.write_policy === "read_only";
}

function isParallelScopedWriteDelegateAction(
  action: ToolAction,
  agentSpecs: AgentSpec[]
): action is Extract<ToolAction, { type: "agent.delegate" }> {
  if (action.type !== "agent.delegate" || action.preferred_mode !== "parallel") {
    return false;
  }
  const spec = findDelegateAgentSpec(action, agentSpecs);
  return spec?.write_policy === "scoped_write" && parallelScopedWriteScope(action.file_scope) !== undefined;
}

function findDelegateAgentSpec(action: Extract<ToolAction, { type: "agent.delegate" }>, agentSpecs: AgentSpec[]): AgentSpec | undefined {
  const preferredId = action.preferred_agent_spec_id?.trim();
  if (preferredId) {
    return agentSpecs.find((spec) => spec.id === preferredId);
  }
  const capability = action.capability.trim();
  return agentSpecs.find((spec) => spec.id === capability);
}

function canBatchParallelScopedWriteDelegate(
  existingCalls: CodingLoopToolCall[],
  nextCall: CodingLoopToolCall,
  agentSpecs: AgentSpec[]
): boolean {
  const nextScope = parallelScopedWriteScopeForCall(nextCall, agentSpecs);
  if (!nextScope) {
    return false;
  }
  for (const call of existingCalls) {
    const existingScope = parallelScopedWriteScopeForCall(call, agentSpecs);
    if (!existingScope || scopesOverlap(existingScope, nextScope)) {
      return false;
    }
  }
  return true;
}

function parallelScopedWriteScopeForCall(call: CodingLoopToolCall, agentSpecs: AgentSpec[]): string[] | undefined {
  const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
  if (!isParallelScopedWriteDelegateAction(action, agentSpecs)) {
    return undefined;
  }
  return parallelScopedWriteScope(action.file_scope);
}

function parallelScopedWriteScope(fileScope: string[] | undefined): string[] | undefined {
  if (!fileScope?.length) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const item of fileScope) {
    const candidate = normalizeParallelScopePath(item);
    if (!candidate) {
      return undefined;
    }
    normalized.push(candidate);
  }
  return [...new Set(normalized)];
}

function normalizeParallelScopePath(path: string): string | undefined {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized || normalized === "." || /[*?[\]{}!]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => pathScopesOverlap(leftPath, rightPath)));
}

function pathScopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function classifyToolConcurrency(action: ToolAction): ToolConcurrencyClass {
  if ([
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
    "blackboard.read",
    "blackboard.search",
    "blackboard.list",
    "agent.list",
    "agent.status",
    "runtime.sleep",
    "structured.output",
    "repl.mode",
    "schedule.list",
    "task.get",
    "task.list",
    "task.output",
    "process.status",
    "process.list",
    "process.tail",
    "process.grep",
    "config.get",
    "mcp.resources",
    "mcp.read",
    "mcp.auth",
    "ToolSearch",
    "tool.search"
  ].includes(action.type)) {
    return "read_parallel";
  }
  if (action.type === "process.start") {
    return "background_process";
  }
  if (action.type === "web.search" || action.type === "web.fetch" || action.type === "mcp.call" || action.type === "skill.invoke" || action.type === "remote.trigger") {
    return "network_limited";
  }
  if (action.type === "agent.message") {
    return "write_exclusive";
  }
  if (action.type === "code.test" || action.type === "code.lint" || action.type === "code.build" || action.type === "shell.exec" || action.type === "powershell.exec" || action.type === "exec" || action.type === "package.install") {
    return "verify_exclusive";
  }
  return "write_exclusive";
}

const TOOL_CONCURRENCY_POLICY: Record<ToolConcurrencyClass, string[]> = {
  read_parallel: ["Read", "Glob", "Grep", "file.stat", "package.info", "project.detect", "git.status", "git.diff", "ToolSearch", "tool.search", "runtime.sleep", "structured.output", "repl.mode", "Agent with preferred_mode=parallel and a read_only agent spec"],
  delegate_parallel: ["Agent with preferred_mode=parallel and a scoped_write agent spec whose file_scope is concrete and non-overlapping with sibling delegates"],
  write_exclusive: ["Write", "Edit", "NotebookEdit", "json.edit", "todo.write", "blackboard.write", "agent.delegate", "agent.message"],
  verify_exclusive: ["Bash", "PowerShell", "exec", "code.test", "code.lint", "code.build", "package.install"],
  background_process: ["ProcessStart"],
  network_limited: ["WebSearch", "WebFetch", "McpCall", "SkillInvoke", "mcp__*"]
};

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
  const sandbox = sandboxDecisionFromUnknown(result.metadata?.sandbox ?? result.data);
  const recovery = result.recovery ?? recoveryAdviceForRawToolResult(action, result, sandbox);
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
    recoverySuggestion: result.recoverySuggestion,
    recovery,
    metadata: result.metadata,
    sandbox
  };
}

function recoveryAdviceForRawToolResult(action: string, result: ToolResult, sandbox?: SandboxDecision): RecoveryAdvice | undefined {
  if ((result.status ?? "success") !== "failed" && !result.recoverySuggestion && !result.errorCode) {
    return undefined;
  }
  if (result.recovery) {
    return result.recovery;
  }
  if (!result.recoverySuggestion && !result.errorCode) {
    return undefined;
  }
  return recoveryAdviceFromToolFailure({
    action,
    reason: result.errors?.[0] ?? result.content ?? result.summary,
    errorCode: result.errorCode,
    recoverySuggestion: result.recoverySuggestion,
    sandbox
  });
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
  if (result.action === "code.test" || result.action === "code.lint" || result.action === "code.build") {
    testsRun.add(result.summary);
  }
  const signals = collectCodingLoopOutcomeSignals(result.data);
  signals.changed_files.forEach((path) => changedFiles.add(path));
  signals.intermediate_artifacts.forEach((path) => intermediateArtifacts.add(path));
}

export function collectCodingLoopOutcomeSignals(value: unknown): CodingLoopOutcomeSignals {
  const changedFiles = new Set<string>();
  const intermediateArtifacts = new Set<string>();
  collectPaths(value, changedFiles, intermediateArtifacts);
  return {
    changed_files: [...changedFiles],
    intermediate_artifacts: [...intermediateArtifacts]
  };
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
  if (path && isWorkspaceMutationOperation(operation)) {
    changedFiles.add(path);
  }
  const change = value.change;
  if (isRecord(change) && typeof change.path === "string") {
    const changeOperation = typeof change.operation === "string" ? change.operation : "";
    if (isWorkspaceMutationOperation(changeOperation)) {
      changedFiles.add(change.path);
    }
  }
  const destination = typeof value.destination === "string" ? value.destination : undefined;
  if (destination && (operation === "move" || operation === "copy")) {
    changedFiles.add(destination);
  }
  const outputRef = value.outputRef;
  if (isRecord(outputRef) && typeof outputRef.path === "string") {
    intermediateArtifacts.add(outputRef.path);
  }
  Object.entries(value).forEach(([key, nested]) => {
    if (key !== "outputRef") {
      collectPaths(nested, changedFiles, intermediateArtifacts);
    }
  });
}

function isWorkspaceMutationOperation(operation: string): boolean {
  return ["create", "update", "edit", "delete", "mkdir", "move", "copy", "set", "merge"].includes(operation);
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
  if (input.modelStatus === "continue") {
    return {
      status: "failed",
      summary: [summary, "Model requested continuation without executable tool calls."].filter(Boolean).join(" ")
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
  recoverySuggestion?: string,
  sandbox?: SandboxDecision,
  recovery?: RecoveryAdvice
): string {
  const advice = recovery ?? (recoverySuggestion || errorCode || sandbox
    ? recoveryAdviceFromToolFailure({ action, reason, errorCode, recoverySuggestion, sandbox })
    : undefined);
  return [
    `ERROR: ${reason}`,
    errorCode ? `Error code: ${errorCode}` : undefined,
    sandbox ? formatSandboxFailureDetail(sandbox) : undefined,
    recoverySuggestion ? `Recovery: ${recoverySuggestion}` : undefined,
    advice ? formatRecoveryAdvice(advice) : undefined,
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

function recoverySuggestionForToolError(errorCode: string | undefined, message: string, sandbox?: SandboxDecision): string {
  if (sandbox?.decision === "deny") {
    return sandboxRecoverySuggestion(sandbox);
  }
  if (/file\.edit str_replace requires exactly one match/i.test(message) || /file\.edit replace_all requires at least one match/i.test(message)) {
    return "Re-read the target file or use file.grep to locate the current text, then retry file.edit with a unique oldText or set replaceAll only when all matches should change.";
  }
  if (/Refusing to modify .*after only reading lines/i.test(message) || /Refusing to modify existing file before reading it/i.test(message)) {
    return "Read the full target file with file.read before retrying file.edit; partial reads are not enough for existing-file edits.";
  }
  if (/because it changed after the last read/i.test(message)) {
    return "Re-read the target file to refresh the edit snapshot, then retry file.edit against the current content.";
  }
  if (errorCode === "TOOL_DEFERRED") {
    return "Use ToolSearch with a focused query first, then retry on the next turn after the tool is loaded.";
  }
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
