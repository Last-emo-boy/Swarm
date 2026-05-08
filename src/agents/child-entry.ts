import { resolve } from "node:path";
import process from "node:process";
import type { AgentCard, AgentResultPayload, BlackboardEntry, ReviewResult, SwarmEnvelope } from "../protocol/types.js";
import { createEnvelope } from "../protocol/envelope.js";
import { OpenAIProvider, type PromptBlock, type ProviderUsageReport } from "../providers/openai-provider.js";
import { getSwarmPaths, loadSwarmSettings } from "../config/settings.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import type { AgentDelegateAction, BlackboardListAction, BlackboardReadAction, BlackboardSearchAction, BlackboardToolContext, BlackboardWriteAction, ToolAction, ToolResult, WebSearchAction } from "../tools/types.js";
import { getDebugLogger, type DebugLogger } from "../runtime/debug-logger.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import { renderHostEnvironmentPrompt } from "../runtime/host-context.js";
import { applyToolResultBudget, createContentReplacementState } from "../runtime/tool-result-budget.js";

const spec = parseAgentSpec();
const provider = new OpenAIProvider({ onUsage: (usage) => sendProviderUsage(usage) });
const workspace = resolve(process.env.SWARM_WORKSPACE ?? process.cwd());
const debug: DebugLogger | null = getDebugLogger(getSwarmPaths().logsDir);

const CHILD_CONTROL_MAX_OUTPUT_TOKENS = 1_200;
const CHILD_WORKER_LOOP_MAX_OUTPUT_TOKENS = 6_000;
const CHILD_REVIEW_MAX_OUTPUT_TOKENS = 3_000;
const CHILD_AGGREGATION_MAX_OUTPUT_TOKENS = 4_000;

debug?.info("child-entry", `${spec.agent_id} started. role=${spec.role} pid=${process.pid} capabilities=${spec.capabilities.join(", ")}`);

function sendProviderUsage(usage: ProviderUsageReport): void {
  process.send?.({
    type: "provider_usage",
    usage
  });
}

process.on("message", (message: unknown) => {
  const env = message as SwarmEnvelope;
  debug?.debug("child-entry", `recv ${env.type} intent=${env.intent} task_id=${env.task_id ?? "-"} from=${env.from.agent_id ?? env.from.capability ?? "?"}`, { id: env.id });
  handleEnvelope(env).catch((error: unknown) => {
    const incoming = message as SwarmEnvelope;
    const reason = error instanceof Error ? error.message : String(error);
    const detail = error instanceof Error ? error.stack : undefined;
    debug?.error("child-entry", `unhandled error handling ${incoming.type}: ${reason}`, { stack: detail });
    // Last-resort safety net — handler-specific catches should have already returned a proper result.
    if (incoming.type === "task.assign") {
      sendReply(incoming, "task.result", "agent.error", {
        status: "failed",
        summary: reason,
        content: detail,
        data: { error: reason, stack: detail }
      } satisfies AgentResultPayload);
    } else {
      sendReply(incoming, "error", "agent.error", {
        error_code: "TASK_FAILED",
        message: reason,
        retryable: false,
        failed_agent: { agent_id: spec.agent_id, role: spec.role },
        failed_task_id: incoming.task_id,
        recovery_suggestion: "retry_different_agent"
      });
    }
  });
});

async function handleEnvelope(envelope: SwarmEnvelope): Promise<void> {
  if (envelope.type === "task.assign" && spec.role === "tool") {
    await handleToolTask(envelope);
    return;
  }

  if (envelope.type === "task.assign" && spec.role === "aggregator") {
    await handleAggregationTask(envelope);
    return;
  }

  if (envelope.type === "review.request" && spec.role === "reviewer") {
    await handleReview(envelope);
    return;
  }

  if (envelope.type === "bid.request") {
    handleBidRequest(envelope);
    return;
  }

  if (envelope.type === "bid.award") {
    sendReply(envelope, "ack", "bid.award.ack", { accepted: true, task_id: envelope.task_id });
    return;
  }

  if (envelope.type === "consensus.request") {
    await handleConsensusRequest(envelope);
    return;
  }

  if (envelope.type === "task.assign") {
    await handleWorkerTask(envelope);
    return;
  }

  debug?.debug("child-entry", `ignored ${envelope.type} intent=${envelope.intent}`);
}

function handleBidRequest(envelope: SwarmEnvelope): void {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const required = Array.isArray(payload.required_capabilities)
    ? payload.required_capabilities.map(String)
    : typeof payload.capability === "string"
      ? [payload.capability]
      : [];
  const matching = required.length === 0
    ? spec.capabilities
    : spec.capabilities.filter((capability) => required.includes(capability));
  const load = spec.load?.running_tasks ?? 0;
  const successRate = spec.reliability?.success_rate ?? 0.5;
  const confidence = Math.max(0.1, Math.min(0.99, (matching.length ? 0.7 : 0.35) + successRate * 0.2 - load * 0.05));
  process.send?.(createEnvelope({
    swarm_id: envelope.swarm_id,
    session_id: envelope.session_id,
    task_id: stringField(payload.task_id ?? payload.taskId) ?? envelope.task_id,
    from: { agent_id: spec.agent_id, role: spec.role },
    to: envelope.from,
    type: "bid.submit",
    intent: "bid.submit",
    payload: {
      task_id: stringField(payload.task_id ?? payload.taskId) ?? envelope.task_id,
      confidence,
      estimated_time_ms: estimateBidTimeMs(load),
      estimated_cost: estimateBidCost(load, matching.length),
      reason: matching.length
        ? `Matches capabilities: ${matching.join(", ")}.`
        : "No exact capability match, but agent can provide adjacent support.",
      agent: {
        agent_id: spec.agent_id,
        role: spec.role,
        capabilities: spec.capabilities
      }
    },
    correlation_id: envelope.correlation_id ?? envelope.id,
    reply_to: envelope.id
  }));
}

async function handleConsensusRequest(envelope: SwarmEnvelope): Promise<void> {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const question = typeof payload.question === "string"
    ? payload.question
    : typeof payload.proposal === "string"
      ? payload.proposal
      : JSON.stringify(payload);
  let vote = "approve";
  let reason = "No blocking issue found in the consensus payload.";
  let confidence = 0.6;
  if (spec.role === "reviewer" || spec.role === "critic") {
    const modelText = await provider.generateText({
      model: provider.workerModel,
      system: [{
        text: [
          "You are a Swarm consensus voter.",
          "Return exactly one JSON object with keys: vote, confidence, reason.",
          "vote must be approve, reject, or abstain.",
          "Reject only for a concrete protocol, safety, or correctness blocker grounded in the supplied payload."
        ].join(" "),
        cache: true
      }],
      user: JSON.stringify({ question, payload, agent: spec }, null, 2),
      usage: {
        sessionId: envelope.session_id,
        taskId: envelope.task_id,
        purpose: "child_consensus"
      },
      maxOutputTokens: CHILD_CONTROL_MAX_OUTPUT_TOKENS
    });
    const parsed = parseJsonObject(modelText);
    vote = parsed.vote === "reject" || parsed.vote === "abstain" ? parsed.vote : "approve";
    confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : confidence;
    reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : reason;
  }
  process.send?.(createEnvelope({
    swarm_id: envelope.swarm_id,
    session_id: envelope.session_id,
    task_id: envelope.task_id,
    from: { agent_id: spec.agent_id, role: spec.role },
    to: envelope.from,
    type: "consensus.vote",
    intent: "consensus.vote",
    payload: {
      vote,
      confidence,
      reason,
      mode: typeof payload.mode === "string" ? payload.mode : undefined
    },
    correlation_id: envelope.correlation_id ?? envelope.id,
    reply_to: envelope.id
  }));
}

async function handleWorkerTask(envelope: SwarmEnvelope): Promise<void> {
  const stopTimer = debug?.time("worker", `task=${envelope.task_id ?? "?"}`);
  sendReply(envelope, "task.accept", "task.accepted", { task_id: envelope.task_id });
  sendReply(envelope, "task.start", "task.started", { task_id: envelope.task_id });

  const payload = envelope.payload as {
    task?: { title?: string; description?: string; objective?: string; acceptance_criteria?: string[] };
    context?: BlackboardEntry[];
  };
  const task = payload.task;
  debug?.debug("worker", `generating for "${task?.title ?? envelope.task_id ?? "?"}"`);

  const parsed = await runWorkerLoop(envelope, payload);
  const result: AgentResultPayload = {
    status: parsed.status,
    summary: parsed.summary,
    content: parsed.details,
    data: {
      files_touched: parsed.files_touched,
      next_actions: parsed.next_actions,
      loop_turns: parsed.loop_turns,
      tool_results: parsed.tool_results
    }
  };
  debug?.debug("worker", `completed: ${result.summary}`);
  sendReply(envelope, "task.result", "task.completed", result);
  stopTimer?.();
}

const MAX_WORKER_LOOP_TURNS = 6;
const MAX_WORKER_TOOL_CALLS = 12;

type WorkerToolCall = {
  id?: string;
  action?: string;
  inputs?: Record<string, unknown>;
  reason?: string;
};

type WorkerToolResult = {
  id: string;
  action: string;
  reason?: string;
  status?: string;
  summary: string;
  content?: string;
  outputRef?: string;
  data?: unknown;
  errors?: unknown;
  errorCode?: string;
  retryable?: boolean;
  recoverable?: boolean;
};

type WorkerLoopResult = ReturnType<typeof parseWorkerResult> & {
  loop_turns: number;
  tool_results: WorkerToolResult[];
};

async function runWorkerLoop(
  envelope: SwarmEnvelope,
  payload: {
    task?: { title?: string; description?: string; objective?: string; acceptance_criteria?: string[] };
    context?: BlackboardEntry[];
  }
): Promise<WorkerLoopResult> {
  const toolResults: WorkerToolResult[] = [];
  const replacementState = createContentReplacementState({
    sessionId: envelope.session_id,
    scopeKind: "child",
    scopeId: spec.agent_id
  });
  let executedToolCalls = 0;
  let lastParsed = parseWorkerResult("{}");

  for (let turn = 1; turn <= MAX_WORKER_LOOP_TURNS; turn += 1) {
    const budgetedToolResults = await applyToolResultBudget(toolResults, {
      sessionId: envelope.session_id,
      taskIdPrefix: `${envelope.task_id ?? "child_worker"}_turn_${turn}`,
      state: replacementState,
      maxFreshBytes: CHILD_TOOL_RESULT_FRESH_BUDGET_BYTES,
      maxTotalBytes: CHILD_TOOL_RESULT_TOTAL_BUDGET_BYTES,
      previewBytes: CHILD_TOOL_RESULT_PREVIEW_BYTES
    });
    const content = await provider.generateText({
      model: provider.workerModel,
      system: workerLoopSystemPrompt(workspace),
      user: JSON.stringify(
        {
          task: payload.task,
          context: payload.context ?? [],
          tool_results: budgetedToolResults,
          loop: {
            turn,
            remaining_turns: MAX_WORKER_LOOP_TURNS - turn,
            remaining_tool_calls: MAX_WORKER_TOOL_CALLS - executedToolCalls
          }
        },
        null,
        2
      ),
      cache: { key: `swarm:child-worker:${envelope.session_id ?? envelope.task_id ?? "unknown"}`, ttlSeconds: 3600 },
      usage: {
        sessionId: envelope.session_id,
        taskId: envelope.task_id,
        purpose: "child_worker_loop"
      },
      maxOutputTokens: CHILD_WORKER_LOOP_MAX_OUTPUT_TOKENS
    });

    const parsed = parseWorkerResult(content);
    lastParsed = parsed;
    const toolCalls = parseWorkerToolCalls(content);
    if (toolCalls.length === 0 || executedToolCalls >= MAX_WORKER_TOOL_CALLS) {
      return { ...parsed, loop_turns: turn, tool_results: toolResults };
    }

    for (const call of toolCalls) {
      if (executedToolCalls >= MAX_WORKER_TOOL_CALLS) {
        break;
      }
      executedToolCalls += 1;
      const result = await executeWorkerToolCall(call, envelope);
      toolResults.push(result);
      sendProgress(envelope, {
        message: `Worker tool ${String(result.action ?? call.action ?? "unknown")} ${String(result.status ?? "completed")}`,
        tool_calls_completed: executedToolCalls,
        remaining_tool_calls: MAX_WORKER_TOOL_CALLS - executedToolCalls
      });
    }
  }

  return {
    ...lastParsed,
    status: lastParsed.status === "failed" ? "failed" : "completed",
    summary: lastParsed.summary || "Worker loop reached its turn limit",
    details: lastParsed.details || "Worker loop reached its turn limit before producing more detail.",
    loop_turns: MAX_WORKER_LOOP_TURNS,
    tool_results: toolResults
  };
}

function workerLoopSystemPrompt(workspace = process.cwd()): PromptBlock[] {
  return [{
    text: [
      "You are a worker agent in a local Swarm coding CLI runtime.",
      "Complete only the assigned task using the supplied task, inputs, blackboard entries, and tool_results.",
      "Return exactly one JSON object. Do not use Markdown fences or prose outside JSON.",
      "The JSON object must contain keys: status, summary, details, files_touched, next_actions, tool_calls.",
      "status must be completed or failed. details must be Markdown for the user.",
      "tool_calls must be an array. Use it only when you need more evidence before completing.",
      "Allowed worker-loop tools: file.read, file.list, file.glob, file.grep, file.stat, git.status, git.diff, git.log, web.search, web.fetch, todo.write, BlackboardWrite, BlackboardSearch, BlackboardRead, BlackboardList.",
      renderHostEnvironmentPrompt(workspace),
      "Do not request Write, Edit, Bash, exec, package.install, code.test, code.lint, git.branch, Agent, or agent.delegate inside this loop.",
      "For todo.write, inputs.todos is an array of objects with content and status pending, in_progress, or completed.",
      "When you have enough evidence, return tool_calls: [] and a completed or failed result."
    ].join(" "),
    cache: true
  }];
}

async function executeWorkerToolCall(call: WorkerToolCall, envelope: SwarmEnvelope): Promise<WorkerToolResult> {
  const id = call.id ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const inputs = { ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action };
    const action = normalizeToolAction(inputs);
    if (!isWorkerLoopToolAllowed(action)) {
      return {
        id,
        action: action.type,
        status: "failed",
        summary: `${action.type} is not allowed inside the worker loop`,
        errorCode: "PERMISSION_DENIED",
        recoverable: true,
        content: "Mutating, shell, install, verification, branch, compile, and delegation tools must be planned as normal Swarm tasks so approvals and scheduling stay enforced."
      };
    }

    const toolContext = {
      workspace,
      settings: loadSwarmSettings(workspace),
      sessionId: envelope.session_id,
      taskId: envelope.task_id,
      attempt: envelope.attempt,
      serverWebSearch: (searchAction: WebSearchAction) => provider.webSearch(searchAction),
      blackboard: childBlackboardTools(envelope),
      agent: { agent_id: spec.agent_id, role: spec.role },
      delegate: (delegateAction: AgentDelegateAction) => delegateToAgent(delegateAction, envelope)
    };
    const result = await runLocalTool(action, toolContext);
    const prepared = await prepareToolOutput(envelope, result, renderToolResultDetail(result));
    return {
      id,
      action: action.type,
      reason: call.reason,
      status: result.status ?? "success",
      summary: result.summary,
      content: prepared.content,
      outputRef: prepared.outputRef,
      data: prepared.data,
      errors: result.errors,
      errorCode: result.errorCode,
      retryable: result.retryable,
      recoverable: result.recoverable
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      id,
      action: typeof call.action === "string"
        ? call.action
        : typeof call.inputs?.action === "string"
          ? call.inputs.action
          : "unknown",
      status: "failed",
      summary: reason,
      errors: [reason],
      errorCode: classifyToolError(error),
      retryable: false,
      recoverable: true
    };
  }
}

function isWorkerLoopToolAllowed(action: ToolAction): boolean {
  return [
    "file.read",
    "file.list",
    "file.glob",
    "file.grep",
    "file.stat",
    "git.status",
    "git.diff",
    "git.log",
    "web.search",
    "web.fetch",
    "todo.write",
    "blackboard.write",
    "blackboard.search",
    "blackboard.read",
    "blackboard.list"
  ].includes(action.type);
}

async function handleReview(envelope: SwarmEnvelope): Promise<void> {
  const stopTimer = debug?.time("reviewer", `review ${envelope.task_id ?? "all"}`);
  const payload = envelope.payload as { target_task_id?: string; context?: BlackboardEntry[] };
  const modelText = await provider.generateText({
    model: provider.workerModel,
    system: [{
      text: [
        "You are a reviewer agent. Assess whether the swarm output satisfies the objective.",
        "This product is a coding CLI. For implementation/refactor/create-project requests, success means the workspace was actually changed and then verified, not merely described.",
        "For pure analysis or audit requests, a grounded final response is acceptable without file changes.",
        "Return exactly one JSON object with keys: verdict, score, summary, issues.",
        "verdict must be approve, needs_revision, or reject.",
        "Every issue should include severity, message, suggested_fix, and task_id when it maps to a known task_id from the blackboard plan."
      ].join(" "),
      cache: true
    }],
    user: JSON.stringify(payload, null, 2),
    usage: {
      sessionId: envelope.session_id,
      taskId: envelope.task_id,
      purpose: "child_review"
    },
    maxOutputTokens: CHILD_REVIEW_MAX_OUTPUT_TOKENS
  });

  const parsed = parseJsonObject(modelText);
  if (!parsed.verdict || typeof parsed.summary !== "string") {
    throw new Error("Reviewer returned invalid JSON. Expected verdict, score, summary, and issues.");
  }
  const review: ReviewResult = {
    target_task_id: payload.target_task_id ?? envelope.task_id ?? "all",
    reviewer: { agent_id: spec.agent_id, role: spec.role },
    verdict: parsed.verdict === "reject" || parsed.verdict === "needs_revision" ? parsed.verdict : "approve",
    score: typeof parsed.score === "number" ? parsed.score : 0,
    summary: parsed.summary,
    issues: normalizeReviewIssues(parsed.issues)
  };

  debug?.info("reviewer", `verdict=${review.verdict} score=${review.score} issues=${review.issues?.length ?? 0}`);
  sendReply(envelope, "review.result", "review.completed", review);
  stopTimer?.();
}

async function handleAggregationTask(envelope: SwarmEnvelope): Promise<void> {
  const stopTimer = debug?.time("aggregator", `aggregate ${envelope.task_id ?? "?"}`);
  const payload = envelope.payload as { objective?: string; context?: BlackboardEntry[]; outcome?: unknown };

  const content = await provider.generateText({
    model: provider.aggregatorModel,
    system: [{
      text: [
        "You are an aggregator agent for a local coding CLI.",
        "Produce the final user-visible answer from blackboard entries and the supplied outcome summary.",
        "Default to a concise implementation summary: what changed, what was verified, and any remaining risk.",
        "Do not claim a final report file was written unless an explicit final artifact path is present.",
        "If no workspace files changed, say so plainly and frame the result as analysis or planning.",
        "Keep claims grounded in the supplied entries. Return Markdown."
      ].join(" "),
      cache: true
    }],
    user: JSON.stringify(payload, null, 2),
    usage: {
      sessionId: envelope.session_id,
      taskId: envelope.task_id,
      purpose: "child_aggregation"
    },
    maxOutputTokens: CHILD_AGGREGATION_MAX_OUTPUT_TOKENS
  });

  debug?.debug("aggregator", `completed: ${firstLine(content)}`);
  sendReply(envelope, "task.result", "aggregation.completed", {
    status: "completed",
    summary: firstLine(content),
    content
  } satisfies AgentResultPayload);
  stopTimer?.();
}

async function handleToolTask(envelope: SwarmEnvelope): Promise<void> {
  sendReply(envelope, "task.accept", "task.accepted", { task_id: envelope.task_id });
  sendReply(envelope, "task.start", "task.started", { task_id: envelope.task_id });

  try {
    const payload = envelope.payload as {
      inputs?: Record<string, unknown>;
      task?: { required_capabilities?: string[] };
      context?: BlackboardEntry[];
      attempt?: number;
    };
    const inputs = payload.inputs ?? {};
    const action = normalizeToolAction(inputs, payload.task?.required_capabilities?.[0] ?? envelope.intent);
    const toolContext = {
      workspace,
      settings: loadSwarmSettings(workspace),
      sessionId: envelope.session_id,
      taskId: envelope.task_id,
      attempt: envelope.attempt,
      serverWebSearch: (searchAction: WebSearchAction) => provider.webSearch(searchAction),
      blackboard: childBlackboardTools(envelope),
      agent: { agent_id: spec.agent_id, role: spec.role },
      delegate: (delegateAction: AgentDelegateAction) => delegateToAgent(delegateAction, envelope)
    };
    const stopTimer = debug?.time("tool", `${action.type} ${envelope.task_id ?? "?"}`);
    debug?.debug("tool", `executing ${action.type}`, { input: inputs });
    let result = await runLocalTool(action, toolContext);

    if (action.type === "file.read" && result.status === "failed") {
      const fallbackPaths = selectFallbackReadPaths(payload.context ?? []);
      if (fallbackPaths.length > 0) {
        const fallbackAction: Extract<ToolAction, { type: "file.read" }> = {
          type: "file.read",
          paths: fallbackPaths,
          startLine: action.startLine,
          endLine: action.endLine ?? 240,
          maxBytes: Math.min(action.maxBytes ?? 200_000, 80_000)
        };
        debug?.warn("tool", `file.read failed; retrying with ${fallbackPaths.length} discovered path(s)`);
        const fallbackResult = await runLocalTool(fallbackAction, toolContext);
        result = {
          ...fallbackResult,
          summary: `adaptive read fallback: ${fallbackResult.summary}`,
          data: {
            requested: action.paths ?? action.path,
            fallbackPaths,
            fallback: fallbackResult.data,
            originalErrors: result.errors
          },
          metadata: {
            ...(fallbackResult.metadata ?? {}),
            adaptiveFallback: true,
            originalSummary: result.summary
          }
        };
      }
    }

    if (action.type === "file.grep" && result.status === "failed" && result.recoverable) {
      const fallbackRoot = selectFallbackGrepRoot(payload.context ?? [], action.root);
      if (fallbackRoot && fallbackRoot !== action.root) {
        const fallbackAction: Extract<ToolAction, { type: "file.grep" }> = {
          ...action,
          root: fallbackRoot
        };
        debug?.warn("tool", `file.grep failed for root=${action.root}; retrying with root=${fallbackRoot}`);
        const fallbackResult = await runLocalTool(fallbackAction, toolContext);
        result = {
          ...fallbackResult,
          summary: `adaptive grep fallback (${action.root} -> ${fallbackRoot}): ${fallbackResult.summary}`,
          data: {
            requestedRoot: action.root,
            fallbackRoot,
            fallback: fallbackResult.data,
            originalErrors: result.errors
          },
          metadata: {
            ...(fallbackResult.metadata ?? {}),
            adaptiveFallback: true,
            originalSummary: result.summary,
            requestedRoot: action.root,
            fallbackRoot
          }
        };
      }
    }

    debug?.debug("tool", `result: ${result.summary}`);
    const detail = renderToolResultDetail(result);
    const prepared = await prepareToolOutput(envelope, result, detail);
    sendReply(envelope, "task.result", "tool.completed", {
      status: result.status === "failed" ? "failed" : "completed",
      summary: result.summary,
      data: prepared.data,
      content: prepared.content,
      outputRef: prepared.outputRef,
      toolStatus: result.status ?? (result.metadata?.error ? "failed" : "success"),
      errors: result.errors,
      errorCode: result.errorCode,
      retryable: result.retryable,
      recoverable: result.recoverable
    } satisfies AgentResultPayload);
    stopTimer?.();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const detail = error instanceof Error ? error.stack : undefined;
    const errorCode = classifyToolError(error);
    debug?.error("tool", `failed: ${reason}`, { stack: detail });
    sendReply(envelope, "task.result", "tool.failed", {
      status: "failed",
      summary: reason,
      content: detail,
      toolStatus: "failed",
      errors: [reason],
      errorCode,
      retryable: isRetryableToolError(errorCode),
      data: { error: reason, action: (envelope.payload as { inputs?: Record<string, unknown> })?.inputs?.action }
    } satisfies AgentResultPayload);
  }
}

async function delegateToAgent(
  delegateAction: AgentDelegateAction,
  parentEnvelope: SwarmEnvelope
): Promise<ToolResult> {
  const capability = routeableDelegateCapability(delegateAction.capability);
  if (!capability) {
    return {
      action: "agent.delegate",
      status: "failed",
      summary: "agent.delegate failed: missing delegate capability.",
      errors: ["Missing required input: capability"],
      errorCode: "DELEGATE_CAPABILITY_MISSING",
      recoverable: true,
      retryable: false,
      recoverySuggestion: "Retry agent.delegate with a concrete routeable capability such as design.reason, code.inspect, research.summarize, or review.general.",
      data: { capability: delegateAction.capability, task: delegateAction.task }
    };
  }
  const delegateId = `delegate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `subtask_${delegateId}`;

  const delegateEnvelope = createEnvelope({
    swarm_id: parentEnvelope.swarm_id,
    session_id: parentEnvelope.session_id,
    task_id: taskId,
    from: { agent_id: spec.agent_id, role: spec.role },
    to: { capability },
    type: "task.assign",
    intent: capability,
    payload: {
      task: {
        task_id: taskId,
        title: `Delegated: ${delegateAction.task.slice(0, 80)}`,
        description: delegateAction.task,
        context: delegateAction.context
      },
      inputs: { task: delegateAction.task, context: delegateAction.context }
    },
    correlation_id: delegateId,
    routing: { mode: "capability" }
  });

  const responsePromise = waitForReply(delegateId, 120_000);
  process.send?.(delegateEnvelope);
  const response = await responsePromise;

  if (!response) {
    return {
      action: "agent.delegate",
      status: "failed",
      summary: `delegation to ${capability} timed out`,
      errors: ["delegation timed out"],
      data: { capability, requested_capability: delegateAction.capability, task: delegateAction.task, timedOut: true }
    };
  }

  if (response.type === "error") {
    const errorPayload = response.payload as { message?: string };
    return {
      action: "agent.delegate",
      status: "failed",
      summary: `delegation to ${capability} failed: ${errorPayload.message ?? "unknown error"}`,
      errors: [errorPayload.message ?? "unknown error"],
      data: { capability, requested_capability: delegateAction.capability, task: delegateAction.task, error: errorPayload.message ?? "unknown error" }
    };
  }

  const resultPayload = response.payload as AgentResultPayload;
  return {
    action: "agent.delegate",
    status: resultPayload?.status === "failed" ? "failed" : "success",
    summary: `delegated to ${capability}: ${resultPayload?.summary ?? "completed"}`,
    content: resultPayload?.content ?? JSON.stringify(resultPayload),
    outputRef: resultPayload?.outputRef,
    errors: resultPayload?.errors,
    data: {
      capability,
      requested_capability: delegateAction.capability,
      task: delegateAction.task,
      status: resultPayload?.status,
      summary: resultPayload?.summary
    }
  };
}

function childBlackboardTools(parentEnvelope: SwarmEnvelope): {
  write: (action: BlackboardWriteAction, context: BlackboardToolContext) => Promise<BlackboardEntry>;
  read: (action: BlackboardReadAction, context: BlackboardToolContext) => Promise<BlackboardEntry[]>;
  search: (action: BlackboardSearchAction, context: BlackboardToolContext) => Promise<BlackboardEntry[]>;
  list: (action: BlackboardListAction, context: BlackboardToolContext) => Promise<BlackboardEntry[]>;
} {
  return {
    write: (action, context) => childBlackboardWrite(action, parentEnvelope, context),
    read: (action, context) => childBlackboardRead(action, parentEnvelope, context),
    search: (action, context) => childBlackboardSearch(action, parentEnvelope, context),
    list: (action, context) => childBlackboardList(action, parentEnvelope, context)
  };
}

async function childBlackboardWrite(
  action: BlackboardWriteAction,
  parentEnvelope: SwarmEnvelope,
  context: BlackboardToolContext
): Promise<BlackboardEntry> {
  const correlationId = `bb_write_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = action.sessionId ?? context.blackboardSessionId ?? context.sessionId ?? parentEnvelope.session_id;
  const envelope = createEnvelope({
    swarm_id: parentEnvelope.swarm_id,
    session_id: sessionId,
    task_id: action.taskId ?? context.taskId ?? parentEnvelope.task_id,
    attempt: context.attempt ?? parentEnvelope.attempt,
    from: { agent_id: spec.agent_id, role: spec.role },
    to: { agent_id: "blackboard", role: "blackboard" },
    type: "blackboard.write",
    intent: "blackboard.write",
    payload: {
      key: action.key,
      type: action.entryType,
      value: action.value,
      visibility: action.visibility,
      tags: action.tags,
      task_id: action.taskId ?? context.taskId ?? parentEnvelope.task_id
    },
    correlation_id: correlationId
  });
  const responsePromise = waitForReply(correlationId, 30_000);
  process.send?.(envelope);
  const response = await responsePromise;
  if (!response) {
    throw new Error("BlackboardWrite timed out waiting for runtime ack");
  }
  if (response.type === "error") {
    throw new Error(errorMessageFromEnvelope(response));
  }
  const payload = response.payload as { entry?: BlackboardEntry };
  if (!payload.entry) {
    throw new Error("BlackboardWrite ack did not include an entry");
  }
  return payload.entry;
}

async function childBlackboardRead(
  action: BlackboardReadAction,
  parentEnvelope: SwarmEnvelope,
  context: BlackboardToolContext
): Promise<BlackboardEntry[]> {
  return childBlackboardReadEnvelope({
    parentEnvelope,
    context,
    intent: "blackboard.read",
    payload: {
      entry_id: action.entryId,
      key: action.key,
      session_id: action.sessionId,
      limit: action.limit
    }
  });
}

async function childBlackboardSearch(
  action: BlackboardSearchAction,
  parentEnvelope: SwarmEnvelope,
  context: BlackboardToolContext
): Promise<BlackboardEntry[]> {
  const entries = await childBlackboardReadEnvelope({
    parentEnvelope,
    context,
    intent: "blackboard.search",
    payload: {
      session_id: action.sessionId,
      type: action.entryType,
      tag: action.tag,
      key_prefix: action.keyPrefix,
      task_id: action.taskId,
      agent_id: action.agentId,
      limit: action.limit
    }
  });
  return filterBlackboardEntries(entries, action.query);
}

async function childBlackboardList(
  action: BlackboardListAction,
  parentEnvelope: SwarmEnvelope,
  context: BlackboardToolContext
): Promise<BlackboardEntry[]> {
  return childBlackboardReadEnvelope({
    parentEnvelope,
    context,
    intent: "blackboard.list",
    payload: {
      session_id: action.sessionId,
      type: action.entryType,
      tag: action.tag,
      key_prefix: action.keyPrefix,
      task_id: action.taskId,
      agent_id: action.agentId,
      limit: action.limit
    }
  });
}

async function childBlackboardReadEnvelope(input: {
  parentEnvelope: SwarmEnvelope;
  context: BlackboardToolContext;
  intent: string;
  payload: Record<string, unknown>;
}): Promise<BlackboardEntry[]> {
  const correlationId = `bb_read_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = typeof input.payload.session_id === "string" && input.payload.session_id
    ? input.payload.session_id
    : input.context.blackboardSessionId ?? input.context.sessionId ?? input.parentEnvelope.session_id;
  const envelope = createEnvelope({
    swarm_id: input.parentEnvelope.swarm_id,
    session_id: sessionId,
    task_id: input.context.taskId ?? input.parentEnvelope.task_id,
    attempt: input.context.attempt ?? input.parentEnvelope.attempt,
    from: { agent_id: spec.agent_id, role: spec.role },
    to: { agent_id: "blackboard", role: "blackboard" },
    type: "blackboard.read",
    intent: input.intent,
    payload: input.payload,
    correlation_id: correlationId
  });
  const responsePromise = waitForReply(correlationId, 30_000);
  process.send?.(envelope);
  const response = await responsePromise;
  if (!response) {
    throw new Error(`${input.intent} timed out waiting for runtime ack`);
  }
  if (response.type === "error") {
    throw new Error(errorMessageFromEnvelope(response));
  }
  const payload = response.payload as { entries?: BlackboardEntry[] };
  return payload.entries ?? [];
}

function filterBlackboardEntries(entries: BlackboardEntry[], query: string | undefined): BlackboardEntry[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) {
    return entries;
  }
  return entries.filter((entry) => {
    const haystack = [
      entry.key,
      entry.type,
      entry.tags?.join(" "),
      JSON.stringify(entry.value)
    ].filter(Boolean).join("\n").toLowerCase();
    return haystack.includes(needle);
  });
}

function errorMessageFromEnvelope(envelope: SwarmEnvelope): string {
  const payload = envelope.payload;
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }
  return `${envelope.type}: ${envelope.intent}`;
}

function routeableDelegateCapability(capability: string | undefined): string | undefined {
  const normalized = (capability ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  if (CHILD_ROUTABLE_CAPABILITIES.has(normalized)) {
    return normalized;
  }
  return CHILD_DELEGATE_CAPABILITY_ALIASES[normalized];
}

const CHILD_ROUTABLE_CAPABILITIES = new Set([
  "analysis.synthesize",
  "research.summarize",
  "code.inspect",
  "design.reason",
  "review.general",
  "review.security",
  "review.code",
  "critique.result",
  "aggregation.summarize",
  "artifact.compose"
]);

const CHILD_DELEGATE_CAPABILITY_ALIASES: Record<string, string> = {
  "architecture.design": "design.reason",
  "refactor.plan": "design.reason",
  "protocol.design": "design.reason",
  "code.research": "code.inspect",
  "file.search": "code.inspect",
  "docs.summarize": "research.summarize",
  "log.analysis": "research.summarize",
  "risk.analysis": "critique.result",
  "architecture.critique": "critique.result",
  "security.review": "review.security",
  "code.review": "review.code",
  "diff.review": "review.code",
  "test.review": "review.code"
};

const LONG_OUTPUT_THRESHOLD_BYTES = 8_000;
const LONG_OUTPUT_PREVIEW_BYTES = 2_000;
const CHILD_TOOL_RESULT_TOTAL_BUDGET_BYTES = 24_000;
const CHILD_TOOL_RESULT_FRESH_BUDGET_BYTES = 8_000;
const CHILD_TOOL_RESULT_PREVIEW_BYTES = 2_000;

async function prepareToolOutput(
  envelope: SwarmEnvelope,
  result: ToolResult,
  detail: string
): Promise<{ content?: string; outputRef?: string; data?: unknown }> {
  const data = result.data ?? result.metadata;
  const bytes = Buffer.byteLength(detail, "utf8");
  const shouldPersist = result.status === "failed";
  if (!shouldPersist && bytes <= LONG_OUTPUT_THRESHOLD_BYTES) {
    return { content: detail, outputRef: result.outputRef, data };
  }

  const ref = await writeTaskOutput({
    sessionId: envelope.session_id,
    taskId: envelope.task_id ?? "task",
    attempt: envelope.attempt ?? 0,
    content: detail
  });
  return {
    content: bytes <= LONG_OUTPUT_THRESHOLD_BYTES
      ? detail
      : truncateMiddle(detail, LONG_OUTPUT_PREVIEW_BYTES, ref.bytes, ref.lines, ref.path),
    outputRef: ref.path,
    data: attachOutputRefData(data, ref)
  };
}

function truncateMiddle(content: string, maxBytes: number, totalBytes: number, totalLines: number, path: string): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = maxBytes - headBytes;
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8");
  const omitted = Math.max(0, totalBytes - headBytes - tailBytes);
  return [
    head.trimEnd(),
    "",
    `[... ${omitted} bytes omitted from ${totalLines} lines. Full output: ${path}]`,
    "",
    tail.trimStart()
  ].join("\n");
}

function attachOutputRefData(data: unknown, ref: { path: string; bytes: number; lines: number }): unknown {
  const outputRef = { path: ref.path, bytes: ref.bytes, lines: ref.lines };
  if (isRecord(data)) {
    return { ...data, outputRef };
  }
  if (data === undefined) {
    return { outputRef };
  }
  return { value: data, outputRef };
}

function selectFallbackReadPaths(context: BlackboardEntry[]): string[] {
  const candidates = new Set<string>();
  for (const entry of context) {
    collectPathCandidates(entry.value, candidates, 0);
  }
  return [...candidates]
    .map((path) => path.trim())
    .filter((path) => scoreCandidatePath(path) > 0)
    .sort((a, b) => scoreCandidatePath(b) - scoreCandidatePath(a) || a.localeCompare(b))
    .slice(0, 12);
}

function selectFallbackGrepRoot(context: BlackboardEntry[], requestedRoot: string): string | undefined {
  const discoveredPaths = selectFallbackReadPaths(context);
  const roots = new Map<string, number>();
  for (const path of discoveredPaths) {
    const normalized = path.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length > 1) {
      roots.set(parts[0], (roots.get(parts[0]) ?? 0) + scoreCandidatePath(path));
    }
  }
  const best = [...roots.entries()]
    .filter(([root]) => root !== requestedRoot && !["node_modules", "dist", ".git", ".swarm"].includes(root))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return best ?? ".";
}

function collectPathCandidates(value: unknown, target: Set<string>, depth: number): void {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (looksLikeFilePath(value)) {
      target.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, target, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const directPath = value.path;
  if (typeof directPath === "string" && looksLikeFilePath(directPath)) {
    target.add(directPath);
  }
  for (const key of ["data", "files", "paths", "fallbackPaths", "metadata"]) {
    if (key in value) {
      collectPathCandidates(value[key], target, depth + 1);
    }
  }
}

function looksLikeFilePath(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 300 || /[\r\n]/.test(text) || /^https?:\/\//i.test(text)) {
    return false;
  }
  const lower = text.replace(/\\/g, "/").toLowerCase();
  return lower.includes("/") || /\.[a-z0-9]{1,8}$/.test(lower) || ["readme", "makefile", "dockerfile"].includes(lower);
}

function scoreCandidatePath(path: string): number {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (!normalized || ["node_modules/", "dist/", ".git/", ".swarm/", "coverage/", ".next/"].some((part) => normalized.includes(part))) {
    return -1;
  }
  const base = normalized.split("/").pop() ?? normalized;
  if (["package.json", "requirements.txt", "pyproject.toml", "cargo.toml", "go.mod", "makefile", "dockerfile"].includes(base)) {
    return 100;
  }
  if (base === "readme.md" || base === "readme") {
    return 90;
  }
  if (/\.(py|ts|tsx|js|jsx|go|rs|java|cs|php|rb|swift|kt)$/.test(normalized)) {
    return 80;
  }
  if (/\.(json|yaml|yml|toml|md|sol|sql|sh|ps1)$/.test(normalized)) {
    return 60;
  }
  if (/\.(lock|png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|bin|exe|dll)$/.test(normalized)) {
    return -1;
  }
  return normalized.includes("/") ? 10 : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function estimateBidTimeMs(load: number): number {
  return 15_000 + Math.max(0, load) * 10_000;
}

function estimateBidCost(load: number, matchingCapabilities: number): number {
  return Math.max(1, 1_000 + load * 250 - matchingCapabilities * 100);
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
  if (/not found|no such file|ENOENT/i.test(message)) return "FS_NOT_FOUND";
  if (/permission|denied|EACCES|EPERM/i.test(message)) return "PERMISSION_DENIED";
  if (/requires|invalid|unsupported/i.test(message)) return "INVALID_INPUT";
  return "TOOL_FAILED";
}

function isRetryableToolError(errorCode: string): boolean {
  return !["FS_NOT_FOUND", "INVALID_INPUT", "PERMISSION_DENIED"].includes(errorCode);
}

function waitForReply(correlationId: string, timeoutMs: number): Promise<SwarmEnvelope | null> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      process.off("message", handler);
      resolvePromise(null);
    }, timeoutMs);

    function handler(message: unknown) {
      const env = message as SwarmEnvelope;
      if (env.correlation_id === correlationId && (env.type === "task.result" || env.type === "task.fail" || env.type === "error" || env.type === "ack")) {
        clearTimeout(timer);
        process.off("message", handler);
        resolvePromise(env);
      }
    }

    process.on("message", handler);
  });
}

function sendReply<T>(
  incoming: SwarmEnvelope,
  type: SwarmEnvelope<T>["type"],
  intent: string,
  payload: T
): void {
  process.send?.(
    createEnvelope({
      swarm_id: incoming.swarm_id,
      session_id: incoming.session_id,
      task_id: incoming.task_id,
      from: { agent_id: spec.agent_id, role: spec.role },
      to: incoming.from,
      type,
      intent,
      payload,
      correlation_id: incoming.correlation_id ?? incoming.id,
      reply_to: incoming.id,
      attempt: incoming.attempt
    })
  );
}

function sendProgress(incoming: SwarmEnvelope, payload: Record<string, unknown>): void {
  process.send?.(
    createEnvelope({
      swarm_id: incoming.swarm_id,
      session_id: incoming.session_id,
      task_id: incoming.task_id,
      from: { agent_id: spec.agent_id, role: spec.role },
      to: { agent_id: "runtime", role: "runtime" },
      type: "task.progress",
      intent: "task.progress",
      payload,
      correlation_id: incoming.correlation_id ?? incoming.id,
      reply_to: incoming.id,
      attempt: incoming.attempt
    })
  );
}

function parseAgentSpec(): AgentCard {
  const raw = process.env.SWARM_AGENT_SPEC;
  if (!raw) {
    throw new Error("Missing SWARM_AGENT_SPEC");
  }
  return JSON.parse(raw) as AgentCard;
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

function parseWorkerResult(text: string): {
  status: "completed" | "failed";
  summary: string;
  details: string;
  files_touched: string[];
  next_actions: string[];
} {
  const parsed = parseJsonObject(text);
  const details = typeof parsed.details === "string" && parsed.details.trim() ? parsed.details : text;
  return {
    status: parsed.status === "failed" ? "failed" : "completed",
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 240) : firstLine(details),
    details,
    files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.map(String) : [],
    next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map(String) : []
  };
}

function parseWorkerToolCalls(text: string): WorkerToolCall[] {
  const parsed = parseJsonObject(text);
  if (!Array.isArray(parsed.tool_calls)) {
    return [];
  }
  return parsed.tool_calls
    .map((item): WorkerToolCall | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const rawInputs = item.inputs;
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        action: typeof item.action === "string" ? item.action : typeof item.type === "string" ? item.type : undefined,
        inputs: isRecord(rawInputs) ? rawInputs : {},
        reason: typeof item.reason === "string" ? item.reason : undefined
      };
    })
    .filter((item): item is WorkerToolCall => item !== undefined);
}

function normalizeReviewIssues(value: unknown): ReviewResult["issues"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const severity = record.severity === "high" || record.severity === "medium" || record.severity === "low"
      ? record.severity
      : "medium";
    return {
      severity,
      task_id: typeof record.task_id === "string" ? record.task_id : undefined,
      message: typeof record.message === "string" ? record.message : "Review issue",
      evidence: typeof record.evidence === "string" ? record.evidence : undefined,
      suggested_fix: typeof record.suggested_fix === "string" ? record.suggested_fix : undefined
    };
  });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 180) ?? "Completed";
}
