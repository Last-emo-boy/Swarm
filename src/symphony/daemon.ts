import { randomUUID } from "node:crypto";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { SymphonyScheduler, type SymphonyTickResult } from "./scheduler.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowError } from "./workflow.js";

export type SymphonyDaemonStatus = "running" | "stopping" | "stopped" | "failed";

export type SymphonyDaemonRecord = {
  daemon_id: string;
  daemon_key: string;
  status: SymphonyDaemonStatus;
  workflow_path?: string;
  create_workspace: boolean;
  execute: boolean;
  max_runner_turns?: number;
  max_runner_tool_calls?: number;
  max_ticks?: number;
  tick_count: number;
  created_at: string;
  started_at: string;
  updated_at: string;
  stopped_at?: string;
  last_tick_at?: string;
  next_tick_at?: string;
  last_error?: string;
  stop_reason?: string;
  last_result?: SymphonyDaemonTickSummary;
  history: SymphonyDaemonTickSummary[];
};

export type SymphonyDaemonTickSummary = {
  tick: number;
  status: SymphonyDaemonStatus;
  timestamp: string;
  workflow_path?: string;
  candidates: number;
  dispatched: number;
  skipped: number;
  failed: number;
  running: number;
  retrying: number;
  max_concurrent: number;
  preflight_ok?: boolean;
  preflight_issues?: number;
  preflight_issue_summaries?: Array<{
    severity: "warning" | "error";
    code: string;
    message: string;
  }>;
  runs?: Array<"completed" | "failed" | "skipped" | "cancelled">;
};

export type StartSymphonyDaemonInput = {
  workflowPath?: string;
  createWorkspace?: boolean;
  execute?: boolean;
  maxRunnerTurns?: number;
  maxRunnerToolCalls?: number;
  maxTicks?: number;
};

export type StartSymphonyDaemonResult =
  | { ok: true; daemon: SymphonyDaemonRecord; created: boolean }
  | { ok: false; error: WorkflowError };

type ManagedSymphonyDaemon = {
  record: SymphonyDaemonRecord;
  scheduler: SymphonyScheduler;
  stopRequested: boolean;
  wake?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  loop?: Promise<void>;
};

export class SymphonyDaemonManager {
  private readonly daemons = new Map<string, ManagedSymphonyDaemon>();

  constructor(private readonly runtime: SwarmRuntime) {}

  async start(input: StartSymphonyDaemonInput = {}): Promise<StartSymphonyDaemonResult> {
    const workflow = loadWorkflow(input.workflowPath);
    if (!workflow.ok) {
      return { ok: false, error: workflow.error };
    }

    const config = normalizeWorkflowConfig(workflow.workflow);
    const createWorkspace = input.createWorkspace !== false;
    const execute = input.execute === true;
    const daemonKey = symphonyDaemonKey({
      workflowPath: workflow.workflow.path,
      createWorkspace,
      execute,
      maxRunnerTurns: input.maxRunnerTurns,
      maxRunnerToolCalls: input.maxRunnerToolCalls,
      maxTicks: input.maxTicks
    });
    const existing = [...this.daemons.values()].find((daemon) =>
      daemon.record.daemon_key === daemonKey && (daemon.record.status === "running" || daemon.record.status === "stopping")
    );
    if (existing) {
      return { ok: true, daemon: existing.record, created: false };
    }

    const scheduler = new SymphonyScheduler({
      runtime: this.runtime,
      workflowPath: input.workflowPath,
      createWorkspace,
      execute,
      maxRunnerTurns: input.maxRunnerTurns,
      maxRunnerToolCalls: input.maxRunnerToolCalls
    });
    const now = new Date().toISOString();
    const daemon: ManagedSymphonyDaemon = {
      scheduler,
      stopRequested: false,
      record: {
        daemon_id: `symphony_daemon_${randomUUID()}`,
        daemon_key: daemonKey,
        status: "running",
        workflow_path: workflow.workflow.path,
        create_workspace: createWorkspace,
        execute,
        max_runner_turns: input.maxRunnerTurns,
        max_runner_tool_calls: input.maxRunnerToolCalls,
        max_ticks: input.maxTicks,
        tick_count: 0,
        created_at: now,
        started_at: now,
        updated_at: now,
        next_tick_at: new Date(Date.now() + config.polling.interval_ms).toISOString(),
        history: []
      }
    };
    this.daemons.set(daemon.record.daemon_id, daemon);
    daemon.loop = this.runLoop(daemon);
    this.runtime.events.emitEvent({
      type: "log",
      level: "info",
      message: `Symphony daemon ${daemon.record.daemon_id} started for ${daemon.record.workflow_path}.`
    });
    return { ok: true, daemon: daemon.record, created: true };
  }

  listRecords(): SymphonyDaemonRecord[] {
    return [...this.daemons.values()]
      .map((daemon) => daemon.record)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getRecord(daemonId: string): SymphonyDaemonRecord | undefined {
    return this.daemons.get(daemonId)?.record;
  }

  requestStop(input: {
    daemonId?: string;
    reason?: string;
    cancelRunning?: boolean;
  } = {}): SymphonyDaemonRecord[] {
    const targets = input.daemonId
      ? [this.requireDaemon(input.daemonId)]
      : [...this.daemons.values()].filter((daemon) => daemon.record.status === "running" || daemon.record.status === "stopping");
    for (const daemon of targets) {
      this.requestStopDaemon(daemon, input.reason ?? "operator_stop", input.cancelRunning === true);
    }
    return targets.map((daemon) => daemon.record);
  }

  async stopAll(reason = "shutdown", cancelRunning = true): Promise<void> {
    const targets = this.requestStop({ reason, cancelRunning });
    await Promise.all(targets.map((record) => this.daemons.get(record.daemon_id)?.loop?.catch(() => undefined)));
  }

  private async runLoop(daemon: ManagedSymphonyDaemon): Promise<void> {
    try {
      while (!daemon.stopRequested && daemon.record.status === "running") {
        if (daemon.record.max_ticks !== undefined && daemon.record.tick_count >= daemon.record.max_ticks) {
          daemon.record.stop_reason = "max_ticks_reached";
          break;
        }

        daemon.record.last_tick_at = new Date().toISOString();
        daemon.record.next_tick_at = undefined;
        daemon.record.updated_at = daemon.record.last_tick_at;
        const result = await daemon.scheduler.tick();
        daemon.record.tick_count += 1;
        daemon.record.last_result = summarizeSymphonyTick(result, daemon.record.tick_count, daemon.record.status);
        daemon.record.history = [...daemon.record.history.slice(-19), daemon.record.last_result];
        daemon.record.updated_at = new Date().toISOString();

        if (!result.workflow.ok) {
          daemon.record.status = "failed";
          daemon.record.last_error = `${result.workflow.error.code}: ${result.workflow.error.message}`;
          this.runtime.events.emitEvent({
            type: "log",
            level: "error",
            message: `Symphony daemon ${daemon.record.daemon_id} failed: ${daemon.record.last_error}`
          });
          return;
        }

        if (daemon.record.max_ticks !== undefined && daemon.record.tick_count >= daemon.record.max_ticks) {
          daemon.record.stop_reason = "max_ticks_reached";
          break;
        }
        if (daemon.stopRequested || daemon.record.status !== "running") {
          break;
        }

        const interval = normalizeWorkflowConfig(result.workflow.workflow).polling.interval_ms;
        daemon.record.next_tick_at = new Date(Date.now() + interval).toISOString();
        daemon.record.updated_at = new Date().toISOString();
        await this.waitForInterval(daemon, interval);
      }

      if (daemon.record.status !== "failed") {
        daemon.record.status = "stopped";
        daemon.record.stopped_at = new Date().toISOString();
        daemon.record.updated_at = daemon.record.stopped_at;
        daemon.record.next_tick_at = undefined;
        daemon.record.stop_reason = daemon.record.stop_reason ?? (daemon.stopRequested ? "stop_requested" : "loop_completed");
        this.runtime.events.emitEvent({
          type: "log",
          level: "info",
          message: `Symphony daemon ${daemon.record.daemon_id} stopped: ${daemon.record.stop_reason}.`
        });
      }
    } catch (error) {
      daemon.record.status = "failed";
      daemon.record.last_error = error instanceof Error ? error.message : String(error);
      daemon.record.stopped_at = new Date().toISOString();
      daemon.record.updated_at = daemon.record.stopped_at;
      daemon.record.next_tick_at = undefined;
      this.runtime.events.emitEvent({
        type: "log",
        level: "error",
        message: `Symphony daemon ${daemon.record.daemon_id} failed: ${daemon.record.last_error}`
      });
    } finally {
      if (daemon.timer) {
        clearTimeout(daemon.timer);
        daemon.timer = undefined;
      }
      daemon.wake = undefined;
    }
  }

  private waitForInterval(daemon: ManagedSymphonyDaemon, intervalMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (daemon.timer === timer) {
          daemon.timer = undefined;
        }
        daemon.wake = undefined;
        resolve();
      }, intervalMs);
      timer.unref?.();
      daemon.timer = timer;
      daemon.wake = () => {
        clearTimeout(timer);
        if (daemon.timer === timer) {
          daemon.timer = undefined;
        }
        daemon.wake = undefined;
        resolve();
      };
    });
  }

  private requestStopDaemon(daemon: ManagedSymphonyDaemon, reason: string, cancelRunning: boolean): void {
    if (daemon.record.status === "stopped" || daemon.record.status === "failed") {
      return;
    }
    daemon.stopRequested = true;
    daemon.record.status = "stopping";
    daemon.record.stop_reason = reason;
    daemon.record.next_tick_at = undefined;
    daemon.record.updated_at = new Date().toISOString();
    if (cancelRunning) {
      for (const running of daemon.scheduler.snapshot().running) {
        this.runtime.interruptWorkSession(running.session_id, reason);
      }
    }
    daemon.wake?.();
    this.runtime.events.emitEvent({
      type: "log",
      level: "warn",
      message: `Symphony daemon ${daemon.record.daemon_id} stop requested: ${reason}.`
    });
  }

  private requireDaemon(daemonId: string): ManagedSymphonyDaemon {
    const daemon = this.daemons.get(daemonId);
    if (!daemon) {
      throw new Error(`Unknown Symphony daemon: ${daemonId}`);
    }
    return daemon;
  }
}

function symphonyDaemonKey(input: {
  workflowPath: string;
  createWorkspace: boolean;
  execute: boolean;
  maxRunnerTurns?: number;
  maxRunnerToolCalls?: number;
  maxTicks?: number;
}): string {
  return JSON.stringify({
    workflowPath: input.workflowPath,
    createWorkspace: input.createWorkspace,
    execute: input.execute,
    maxRunnerTurns: input.maxRunnerTurns,
    maxRunnerToolCalls: input.maxRunnerToolCalls,
    maxTicks: input.maxTicks
  });
}

function summarizeSymphonyTick(
  result: SymphonyTickResult,
  tick: number,
  status: SymphonyDaemonStatus
): SymphonyDaemonTickSummary {
  return {
    tick,
    status,
    timestamp: new Date().toISOString(),
    workflow_path: result.workflow.ok ? result.workflow.workflow.path : undefined,
    candidates: result.candidates.length,
    dispatched: result.dispatched.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    running: result.snapshot.capacity.running,
    retrying: result.snapshot.retrying.length,
    max_concurrent: result.snapshot.capacity.max_concurrent,
    preflight_ok: result.preflight?.ok,
    preflight_issues: result.preflight?.issues.length,
    preflight_issue_summaries: result.preflight?.issues.slice(0, 3).map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message
    })),
    runs: result.runs?.map((run) => run.status)
  };
}
