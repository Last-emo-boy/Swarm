import type { SwarmEnvelope } from "../protocol/types.js";
import type { ProviderUsageReport } from "../providers/openai-provider.js";
import type { RuntimeChildTransportMessageInput, RuntimeChildTransportMessageResult } from "./runtime.js";
import { createEnvelope } from "../protocol/envelope.js";
import { isRecord, firstLine } from "./common-utilities.js";

export function handleRuntimeChildTransportMessage(input: RuntimeChildTransportMessageInput): RuntimeChildTransportMessageResult {
  if (input.disposed) {
    return { handled: false, kind: "disposed" };
  }
  if (isChildProviderUsageMessage(input.message)) {
    input.events.emitEvent({ type: "provider_usage", usage: input.message.usage });
    return { handled: true, kind: "provider_usage" };
  }

  const envelope = input.message as SwarmEnvelope;
  if (isChildRuntimeEnvelope(envelope)) {
    input.router.dispatch(envelope).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      input.events.emitEvent({ type: "error", message: reason });
      input.child.send(
        createEnvelope({
          swarm_id: envelope.swarm_id,
          session_id: envelope.session_id,
          task_id: envelope.task_id,
          from: { agent_id: "runtime", role: "router" },
          to: envelope.from,
          type: "error",
          intent: "router.dispatch_failed",
          payload: {
            error_code: "CAPABILITY_NOT_FOUND",
            message: reason,
            retryable: false,
            failed_task_id: envelope.task_id,
            recovery_suggestion: "abort_swarm"
          },
          correlation_id: envelope.correlation_id ?? envelope.id,
          reply_to: envelope.id
        })
      );
    });
    return { handled: true, kind: "runtime_envelope" };
  }

  if (envelope.type === "task.progress") {
    input.router.receive(envelope);
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const action = typeof payload.action === "string" && payload.action.trim() ? payload.action.trim() : undefined;
    const status = typeof payload.status === "string" && payload.status.trim() ? payload.status.trim() : undefined;
    const summary = typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : undefined;
    const message = typeof payload.message === "string"
      ? payload.message
      : action
        ? `Worker tool ${action} ${status ?? "completed"}${summary ? `: ${firstLine(summary)}` : ""}`
        : typeof payload.summary === "string"
          ? payload.summary
          : `Progress from ${envelope.from.agent_id ?? envelope.from.role ?? "agent"}`;
    input.events.emitEvent({
      type: "loop_activity",
      session_id: envelope.session_id,
      phase: action ? "running_tool" : "turn_complete",
      message,
      status,
      summary,
      errorCode: typeof payload.errorCode === "string" && payload.errorCode.trim() ? payload.errorCode.trim() : undefined,
      recoverySuggestion: typeof payload.recoverySuggestion === "string" && payload.recoverySuggestion.trim()
        ? payload.recoverySuggestion.trim()
        : undefined,
      tool: action,
      task_id: envelope.task_id,
      agent: {
        worker_id: envelope.from.agent_id,
        agent_id: envelope.from.agent_id,
        role: envelope.from.role,
        capability: envelope.from.capability,
        display_name: envelope.from.agent_id,
        role_title: envelope.from.role
      }
    });
    return { handled: true, kind: "task_progress" };
  }

  input.router.receive(envelope);
  input.forwardToAddressedAgent(envelope);
  return { handled: true, kind: "reply" };
}

export function isChildRuntimeEnvelope(envelope: SwarmEnvelope): boolean {
  return envelope.type === "task.assign" ||
    envelope.type === "review.request" ||
    envelope.type === "bid.submit" ||
    envelope.type === "consensus.vote" ||
    envelope.type === "blackboard.write" ||
    envelope.type === "blackboard.read" ||
    envelope.type === "blackboard.update" ||
    envelope.type === "blackboard.lock" ||
    envelope.type === "blackboard.unlock";
}

export function isChildProviderUsageMessage(value: unknown): value is { type: "provider_usage"; usage: ProviderUsageReport } {
  return isRecord(value) && value.type === "provider_usage" && isRecord(value.usage);
}
