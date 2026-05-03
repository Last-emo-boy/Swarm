import { resolve } from "node:path";
import process from "node:process";
import type { AgentCard, AgentResultPayload, BlackboardEntry, ReviewResult, SwarmEnvelope } from "../protocol/types.js";
import { createEnvelope } from "../protocol/envelope.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { getSwarmPaths, loadSwarmSettings } from "../config/settings.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import type { AgentDelegateAction, ToolResult } from "../tools/types.js";
import { getDebugLogger, type DebugLogger } from "../runtime/debug-logger.js";

const spec = parseAgentSpec();
const provider = new OpenAIProvider();
const workspace = resolve(process.env.SWARM_WORKSPACE ?? process.cwd());
const debug: DebugLogger | null = getDebugLogger(getSwarmPaths().logsDir);

debug?.info("child-entry", `${spec.agent_id} started. role=${spec.role} pid=${process.pid} capabilities=${spec.capabilities.join(", ")}`);

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

  if (envelope.type === "task.assign") {
    await handleWorkerTask(envelope);
    return;
  }

  sendReply(envelope, "ack", "agent.ack", { status: "ignored", reason: `Unsupported message ${envelope.type}` });
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

  const content = await provider.generateText({
    model: provider.workerModel,
    system:
      "You are a worker agent in an Agent Swarm Protocol runtime. Complete only the assigned task. Use the provided blackboard context as evidence. Return concise Markdown.",
    user: JSON.stringify({ task, context: payload.context ?? [] }, null, 2)
  });

  const result: AgentResultPayload = {
    status: "completed",
    summary: firstLine(content),
    content
  };
  debug?.debug("worker", `completed: ${firstLine(content)}`);
  sendReply(envelope, "task.result", "task.completed", result);
  stopTimer?.();
}

async function handleReview(envelope: SwarmEnvelope): Promise<void> {
  const stopTimer = debug?.time("reviewer", `review ${envelope.task_id ?? "all"}`);
  const payload = envelope.payload as { target_task_id?: string; context?: BlackboardEntry[] };
  const modelText = await provider.generateText({
    model: provider.workerModel,
    system:
      "You are a reviewer agent. Assess whether the swarm output satisfies the objective. Return JSON with verdict, score, summary, and issues.",
    user: JSON.stringify(payload, null, 2)
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
    issues: Array.isArray(parsed.issues) ? parsed.issues : []
  };

  debug?.info("reviewer", `verdict=${review.verdict} score=${review.score} issues=${review.issues?.length ?? 0}`);
  sendReply(envelope, "review.result", "review.completed", review);
  stopTimer?.();
}

async function handleAggregationTask(envelope: SwarmEnvelope): Promise<void> {
  const stopTimer = debug?.time("aggregator", `aggregate ${envelope.task_id ?? "?"}`);
  const payload = envelope.payload as { objective?: string; context?: BlackboardEntry[] };

  const content = await provider.generateText({
    model: provider.aggregatorModel,
    system:
      "You are an aggregator agent in a swarm. Produce the final answer from blackboard entries. Keep claims grounded in the supplied entries. Return Markdown.",
    user: JSON.stringify(payload, null, 2)
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
    const payload = envelope.payload as { inputs?: Record<string, unknown>; task?: { required_capabilities?: string[] } };
    const inputs = payload.inputs ?? {};
    const action = normalizeToolAction(inputs, payload.task?.required_capabilities?.[0] ?? envelope.intent);
    const stopTimer = debug?.time("tool", `${action.type} ${envelope.task_id ?? "?"}`);
    debug?.debug("tool", `executing ${action.type}`, { input: inputs });
    const result = await runLocalTool(action, {
      workspace,
      settings: loadSwarmSettings(workspace),
      delegate: (delegateAction) => delegateToAgent(delegateAction, envelope)
    });

    debug?.debug("tool", `result: ${result.summary}`);
    sendReply(envelope, "task.result", "tool.completed", {
      status: result.metadata?.error ? "failed" : "completed",
      summary: result.summary,
      data: result.data ?? result.metadata,
      content: renderToolResultDetail(result)
    } satisfies AgentResultPayload);
    stopTimer?.();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const detail = error instanceof Error ? error.stack : undefined;
    debug?.error("tool", `failed: ${reason}`, { stack: detail });
    sendReply(envelope, "task.result", "tool.failed", {
      status: "failed",
      summary: reason,
      content: detail,
      data: { error: reason, action: (envelope.payload as { inputs?: Record<string, unknown> })?.inputs?.action }
    } satisfies AgentResultPayload);
  }
}

async function delegateToAgent(
  delegateAction: AgentDelegateAction,
  parentEnvelope: SwarmEnvelope
): Promise<ToolResult> {
  const delegateId = `delegate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `subtask_${delegateId}`;

  const delegateEnvelope = createEnvelope({
    swarm_id: parentEnvelope.swarm_id,
    session_id: parentEnvelope.session_id,
    task_id: taskId,
    from: { agent_id: spec.agent_id, role: spec.role },
    to: { capability: delegateAction.capability },
    type: "task.assign",
    intent: delegateAction.capability,
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
      summary: `delegation to ${delegateAction.capability} timed out`,
      data: { capability: delegateAction.capability, task: delegateAction.task, timedOut: true }
    };
  }

  const resultPayload = response.payload as AgentResultPayload;
  return {
    action: "agent.delegate",
    summary: `delegated to ${delegateAction.capability}: ${resultPayload?.summary ?? "completed"}`,
    content: resultPayload?.content ?? JSON.stringify(resultPayload),
    data: {
      capability: delegateAction.capability,
      task: delegateAction.task,
      status: resultPayload?.status,
      summary: resultPayload?.summary
    }
  };
}

function waitForReply(correlationId: string, timeoutMs: number): Promise<SwarmEnvelope | null> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      process.off("message", handler);
      resolvePromise(null);
    }, timeoutMs);

    function handler(message: unknown) {
      const env = message as SwarmEnvelope;
      if (env.correlation_id === correlationId && (env.type === "task.result" || env.type === "task.fail")) {
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
      reply_to: incoming.id
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

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 180) ?? "Completed";
}
