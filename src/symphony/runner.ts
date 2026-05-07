import type { ExecutionResult } from "../runtime/orchestrator.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { SymphonyDispatchRecord } from "./scheduler.js";

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
            attempt
          },
          created_by: { agent_id: "symphony", role: "runner" },
          tags: ["symphony", "runner", "cancelled", "work-kernel"]
        });
        this.runtime.events.emitEvent({ type: "blackboard", entry });
        this.runtime.events.emitEvent({
          type: "log",
          level: "warn",
          message: `Symphony runner cancelled ${dispatch.session.session_id}: ${result.outcome?.final_summary ?? firstLine(result.content)}`
        });
        return { dispatch, status: "cancelled", result };
      }
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
          attempt
        },
        created_by: { agent_id: "symphony", role: "runner" },
        tags: ["symphony", "runner", "completed", "work-kernel"]
      });
      this.runtime.events.emitEvent({ type: "blackboard", entry });
      this.runtime.events.emitEvent({
        type: "log",
        level: "info",
        message: `Symphony runner completed ${dispatch.session.session_id}: ${result.outcome?.final_summary ?? firstLine(result.content)}`
      });
      return { dispatch, status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtime.runAttemptStore.upsert({
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
        tags: ["symphony", "runner", "failed", "work-kernel"]
      });
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

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "";
}
