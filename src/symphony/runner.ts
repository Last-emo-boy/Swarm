import { createEnvelope } from "../protocol/envelope.js";
import type { SwarmEnvelope } from "../protocol/types.js";
import type { ExecutionResult } from "../runtime/orchestrator.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { SymphonyDispatchRecord } from "./scheduler.js";
import { workItemKey } from "./work-item.js";

export type SymphonyRunnerInput = {
  dispatch: SymphonyDispatchRecord;
  maxTurns?: number;
  maxToolCalls?: number;
};

export type SymphonyRunRecord = {
  dispatch: SymphonyDispatchRecord;
  status: "completed" | "failed" | "skipped" | "cancelled";
  result?: ExecutionResult;
  error?: string;
};

export type SymphonyRunner = {
  readonly runner_id: string;
  run(input: SymphonyRunnerInput): Promise<SymphonyRunRecord>;
};

export class LocalCodingLoopSymphonyRunner implements SymphonyRunner {
  readonly runner_id = "symphony.local_coding_loop";

  constructor(private readonly runtime: SwarmRuntime) {}

  async run(input: SymphonyRunnerInput): Promise<SymphonyRunRecord> {
    const dispatch = input.dispatch;
    if (!dispatch.session || !dispatch.prompt) {
      return { dispatch, status: "skipped", error: "dispatch_missing_session_or_prompt" };
    }
    try {
      const result = await this.runtime.executeWorkSession({
        session_id: dispatch.session.session_id,
        prompt: dispatch.prompt,
        workspace_path: dispatch.workspace_path,
        maxTurns: input.maxTurns,
        maxToolCalls: input.maxToolCalls
      });
      if (result.status === "stopped") {
        const envelope = createRunnerEnvelope(dispatch, "task.cancel", {
          status: "cancelled",
          result,
          summary: result.outcome?.final_summary ?? firstLine(result.content)
        });
        const attempt = this.runtime.runAttemptStore.upsert({
          session_id: dispatch.session.session_id,
          task_id: "symphony.runner",
          runner_id: this.runner_id,
          kind: "coding_turn",
          status: "cancelled",
          attempt: dispatch.attempt?.attempt ?? 0,
          title: "Symphony local coding loop",
          terminal_reason: result.outcome?.final_summary ?? firstLine(result.content),
          workspace_path: dispatch.workspace_path,
          metadata: {
            result_session_id: result.session_id,
            outcome: result.outcome
          }
        });
        const entry = this.runtime.blackboardStore.write({
          swarm_id: dispatch.session.swarm_id,
          session_id: dispatch.session.session_id,
          task_id: "symphony.runner",
          key: "symphony.runner.cancelled",
          type: "decision",
          value: {
            result,
            attempt,
            result_envelope_id: envelope.id
          },
          created_by: { agent_id: "symphony", role: "runner" },
          tags: ["symphony", "runner", "cancelled", "work-kernel"],
          metadata: blackboardMetadataFromRunnerEnvelope(dispatch, envelope, "decision")
        });
        receiveRunnerEnvelope(this.runtime, envelope);
        this.runtime.events.emitEvent({ type: "blackboard", entry });
        this.runtime.events.emitEvent({
          type: "log",
          level: "warn",
          message: `Symphony runner cancelled ${dispatch.session.session_id}: ${result.outcome?.final_summary ?? firstLine(result.content)}`
        });
        return { dispatch, status: "cancelled", result };
      }
      const envelope = createRunnerEnvelope(dispatch, "task.result", {
        status: "completed",
        result,
        summary: result.outcome?.final_summary ?? firstLine(result.content)
      });
      const attempt = this.runtime.runAttemptStore.upsert({
        session_id: dispatch.session.session_id,
        task_id: "symphony.runner",
        runner_id: this.runner_id,
        kind: "coding_turn",
        status: "completed",
        attempt: dispatch.attempt?.attempt ?? 0,
        title: "Symphony local coding loop",
        terminal_reason: result.outcome?.final_summary ?? firstLine(result.content),
        workspace_path: dispatch.workspace_path,
        metadata: {
          result_session_id: result.session_id,
          outcome: result.outcome
        }
      });
      const entry = this.runtime.blackboardStore.write({
        swarm_id: dispatch.session.swarm_id,
        session_id: dispatch.session.session_id,
        task_id: "symphony.runner",
        key: "symphony.runner.completed",
        type: "result",
        value: {
          result,
          attempt,
          result_envelope_id: envelope.id
        },
        created_by: { agent_id: "symphony", role: "runner" },
        tags: ["symphony", "runner", "completed", "work-kernel"],
        metadata: blackboardMetadataFromRunnerEnvelope(dispatch, envelope, "result")
      });
      receiveRunnerEnvelope(this.runtime, envelope);
      this.runtime.events.emitEvent({ type: "blackboard", entry });
      this.runtime.events.emitEvent({
        type: "log",
        level: "info",
        message: `Symphony runner completed ${dispatch.session.session_id}: ${result.outcome?.final_summary ?? firstLine(result.content)}`
      });
      return { dispatch, status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const envelope = createRunnerEnvelope(dispatch, "task.fail", {
        status: "failed",
        error: message,
        message,
        summary: message,
        recoverable: true
      });
      const attempt = this.runtime.runAttemptStore.upsert({
        session_id: dispatch.session.session_id,
        task_id: "symphony.runner",
        runner_id: this.runner_id,
        kind: "coding_turn",
        status: "failed",
        attempt: dispatch.attempt?.attempt ?? 0,
        title: "Symphony local coding loop",
        terminal_reason: message,
        workspace_path: dispatch.workspace_path,
        error_code: classifyRunnerError(message),
        recovery_suggestion: "retry_same_agent",
        metadata: { error: message }
      });
      const entry = this.runtime.blackboardStore.write({
        swarm_id: dispatch.session.swarm_id,
        session_id: dispatch.session.session_id,
        task_id: "symphony.runner",
        key: "symphony.runner.failed",
        type: "evidence",
        value: { error: message },
        created_by: { agent_id: "symphony", role: "runner" },
        tags: ["symphony", "runner", "failed", "work-kernel"],
        metadata: {
          ...blackboardMetadataFromRunnerEnvelope(dispatch, envelope, "result"),
          attempt_id: attempt.attempt_id,
          result_envelope_id: envelope.id
        }
      });
      receiveRunnerEnvelope(this.runtime, envelope);
      this.runtime.events.emitEvent({ type: "blackboard", entry });
      this.runtime.events.emitEvent({
        type: "log",
        level: "warn",
        message: `Symphony runner failed ${dispatch.session.session_id}: ${message}`
      });
      return { dispatch, status: "failed", error: message };
    }
  }
}

export async function runDispatchedSymphonyWork(input: {
  runtime: SwarmRuntime;
  dispatches: SymphonyDispatchRecord[];
  maxTurns?: number;
  maxToolCalls?: number;
  runner?: SymphonyRunner;
}): Promise<SymphonyRunRecord[]> {
  const runner = input.runner ?? new LocalCodingLoopSymphonyRunner(input.runtime);
  const records: SymphonyRunRecord[] = [];
  for (const dispatch of input.dispatches) {
    records.push(await runner.run({
      dispatch,
      maxTurns: input.maxTurns,
      maxToolCalls: input.maxToolCalls
    }));
  }
  return records;
}

function classifyRunnerError(message: string): string {
  if (/missing api key|no model|no provider/i.test(message)) {
    return "MODEL_NOT_CONFIGURED";
  }
  if (/permission|approval/i.test(message)) {
    return "PERMISSION_REQUIRED";
  }
  return "RUNNER_FAILED";
}

function createRunnerEnvelope(
  dispatch: SymphonyDispatchRecord,
  type: Extract<SwarmEnvelope["type"], "task.result" | "task.fail" | "task.cancel">,
  payload: Record<string, unknown>
): SwarmEnvelope {
  const workKey = workItemKey(dispatch.work_item);
  const assignment = dispatch.assignment_envelope;
  const taskCreate = dispatch.task_create_envelope;
  return createEnvelope({
    swarm_id: dispatch.session?.swarm_id ?? assignment?.swarm_id ?? taskCreate?.swarm_id ?? `swarm_${dispatch.session?.session_id ?? "symphony"}`,
    session_id: dispatch.session?.session_id ?? assignment?.session_id ?? taskCreate?.session_id ?? "symphony",
    task_id: assignment?.task_id ?? taskCreate?.task_id ?? "symphony.dispatch",
    attempt: dispatch.attempt?.attempt,
    from: { agent_id: "symphony.scheduler", role: "scheduler" },
    to: { agent_id: "main_swarm", role: "controller" },
    type,
    intent: type === "task.result"
      ? "symphony.runner.result"
      : type === "task.fail"
        ? "symphony.runner.fail"
        : "symphony.runner.cancel",
    payload: {
      source: "symphony",
      work_item_key: workKey,
      claim_key: `symphony:${workKey}`,
      owner_id: "symphony.scheduler",
      runner: "symphony.local_coding_loop",
      runner_task_id: "symphony.runner",
      assignment_envelope_id: assignment?.id,
      task_create_envelope_id: taskCreate?.id,
      protocol: "symphony_source_adapter",
      ...payload
    },
    correlation_id: assignment?.id ?? taskCreate?.id,
    reply_to: assignment?.id,
    trace: {
      trace_id: assignment?.trace?.trace_id ?? dispatch.session?.session_id ?? taskCreate?.trace?.trace_id ?? "symphony",
      span_id: `span_symphony_runner_${type.replace(/[^A-Za-z0-9]+/g, "_")}_${Date.now()}`,
      parent_span_id: assignment?.trace?.span_id ?? taskCreate?.trace?.span_id
    }
  });
}

function receiveRunnerEnvelope(runtime: SwarmRuntime, envelope: SwarmEnvelope): void {
  if (runtime.router) {
    runtime.router.receive(envelope);
    return;
  }
  runtime.traceStore?.append(envelope);
  runtime.events.emitEvent({ type: "envelope", envelope });
}

function blackboardMetadataFromRunnerEnvelope(
  dispatch: SymphonyDispatchRecord,
  envelope: SwarmEnvelope,
  kind: "decision" | "result"
): Record<string, unknown> {
  const sourceEnvelopeIds = [
    dispatch.task_create_envelope?.id,
    dispatch.assignment_envelope?.id,
    envelope.id
  ].filter((item): item is string => Boolean(item));
  return {
    kind,
    source_envelope_id: envelope.id,
    source_envelope_ids: sourceEnvelopeIds,
    correlation_id: envelope.correlation_id,
    reply_to: envelope.reply_to,
    claim_key: `symphony:${workItemKey(dispatch.work_item)}`,
    owner_agent_id: "symphony.scheduler",
    source_agent_id: "symphony.scheduler"
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "";
}
