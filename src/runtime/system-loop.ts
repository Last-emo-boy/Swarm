import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SwarmRuntime } from "./runtime.js";
import type { RuntimeEvent } from "./events.js";
import { SymphonyScheduler, type SymphonyTickResult } from "../symphony/scheduler.js";
import type { SymphonyRunner } from "../symphony/runner.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowRuntimeConfig } from "../symphony/workflow.js";

export type RuntimeSystemLoopOptions = {
  workflowPath?: string;
  createWorkspace?: boolean;
  execute?: boolean;
  startupTick?: boolean;
  tickOnEvents?: boolean;
  debounceMs?: number;
  maxRunnerTurns?: number;
  maxRunnerToolCalls?: number;
  runner?: SymphonyRunner;
};

export type RuntimeSystemLoopRunResult =
  | { status: "skipped"; reason: "stopped" | "missing_workflow" | "disabled" | "already_running"; workflowPath: string }
  | { status: "ticked"; reason: string; workflowPath: string; execute: boolean; result: SymphonyTickResult };

export class RuntimeSystemLoop {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<RuntimeSystemLoopRunResult>;
  private stopped = true;
  private schedulerKey?: string;
  private scheduler?: SymphonyScheduler;

  constructor(
    private readonly runtime: SwarmRuntime,
    private readonly options: RuntimeSystemLoopOptions = {}
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.unsubscribe = this.runtime.events.onEvent((event) => this.handleEvent(event));
    const config = this.workflowSystemLoopConfig();
    if (this.options.startupTick !== false && config?.startup_tick !== false && config?.enabled !== false) {
      this.wake("startup");
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  wake(reason: string): void {
    if (this.stopped || systemLoopDisabledByEnv()) {
      return;
    }
    const workflowPath = this.workflowPath();
    if (!existsSync(workflowPath)) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delay = Math.max(0, this.options.debounceMs ?? this.workflowSystemLoopConfig()?.debounce_ms ?? 250);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce(reason).catch((error: unknown) => {
        this.runtime.events.emitEvent({
          type: "log",
          level: "warn",
          message: `System loop Symphony tick failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
    }, delay);
    this.timer.unref?.();
  }

  async runOnce(reason = "manual"): Promise<RuntimeSystemLoopRunResult> {
    if (this.stopped || systemLoopDisabledByEnv()) {
      return { status: "skipped", reason: "stopped", workflowPath: this.workflowPath() };
    }
    if (this.running) {
      return { status: "skipped", reason: "already_running", workflowPath: this.workflowPath() };
    }
    const run = this.runOnceInternal(reason);
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) {
        this.running = undefined;
      }
    }
  }

  private async runOnceInternal(reason: string): Promise<RuntimeSystemLoopRunResult> {
    const workflowPath = this.workflowPath();
    const workflow = loadWorkflow(workflowPath);
    if (!workflow.ok) {
      return { status: "skipped", reason: "missing_workflow", workflowPath };
    }
    const config = normalizeWorkflowConfig(workflow.workflow);
    if (config.system_loop?.enabled === false) {
      return { status: "skipped", reason: "disabled", workflowPath };
    }
    const execute = effectiveExecute(config, this.options.execute);
    const scheduler = this.schedulerFor(workflowPath, execute, config);
    const result = await scheduler.tick();
    const runs = result.runs ?? [];
    if (result.candidates.length || result.dispatched.length || result.failed.length || runs.length) {
      this.runtime.events.emitEvent({
        type: "log",
        level: result.failed.length ? "warn" : "info",
        message: [
          `System loop Symphony tick (${reason})`,
          `candidates=${result.candidates.length}`,
          `dispatched=${result.dispatched.length}`,
          `failed=${result.failed.length}`,
          `runs=${runs.length}`
        ].join(" ")
      });
    }
    this.scheduleRetryWake(result.snapshot.retrying);
    return { status: "ticked", reason, workflowPath, execute, result };
  }

  private schedulerFor(workflowPath: string, execute: boolean, config: WorkflowRuntimeConfig): SymphonyScheduler {
    const key = JSON.stringify({
      workflowPath,
      execute,
      createWorkspace: this.options.createWorkspace !== false,
      maxRunnerTurns: this.options.maxRunnerTurns ?? config.system_loop?.max_runner_turns,
      maxRunnerToolCalls: this.options.maxRunnerToolCalls ?? config.system_loop?.max_runner_tool_calls
    });
    if (this.scheduler && this.schedulerKey === key) {
      return this.scheduler;
    }
    this.schedulerKey = key;
    this.scheduler = new SymphonyScheduler({
      runtime: this.runtime,
      workflowPath,
      createWorkspace: this.options.createWorkspace !== false,
      execute,
      maxRunnerTurns: this.options.maxRunnerTurns ?? config.system_loop?.max_runner_turns,
      maxRunnerToolCalls: this.options.maxRunnerToolCalls ?? config.system_loop?.max_runner_tool_calls,
      runner: this.options.runner
    });
    return this.scheduler;
  }

  private handleEvent(event: RuntimeEvent): void {
    if (this.stopped || systemLoopDisabledByEnv()) {
      return;
    }
    const workflowPath = this.workflowPath();
    if (!existsSync(workflowPath)) {
      return;
    }
    const workflow = loadWorkflow(workflowPath);
    if (!workflow.ok) {
      return;
    }
    const config = normalizeWorkflowConfig(workflow.workflow);
    if (config.system_loop?.enabled === false || config.system_loop?.tick_on_events === false || this.options.tickOnEvents === false) {
      return;
    }
    if (shouldWakeSystemLoop(event)) {
      this.wake(eventWakeReason(event));
    }
  }

  private scheduleRetryWake(retrying: SymphonyTickResult["snapshot"]["retrying"]): void {
    if (!retrying.length) {
      return;
    }
    const nextDue = retrying
      .map((item) => Date.parse(item.due_at))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)[0];
    if (!nextDue) {
      return;
    }
    const delay = Math.max(0, nextDue - Date.now());
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce("retry_due").catch((error: unknown) => {
        this.runtime.events.emitEvent({
          type: "log",
          level: "warn",
          message: `System loop Symphony retry tick failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
    }, delay);
    this.timer.unref?.();
  }

  private workflowPath(): string {
    return resolve(this.options.workflowPath ?? resolve(this.runtime.workspaceRoot(), "WORKFLOW.md"));
  }

  private workflowSystemLoopConfig(): WorkflowRuntimeConfig["system_loop"] | undefined {
    const workflowPath = this.workflowPath();
    if (!existsSync(workflowPath)) {
      return undefined;
    }
    const workflow = loadWorkflow(workflowPath);
    return workflow.ok ? normalizeWorkflowConfig(workflow.workflow).system_loop : undefined;
  }
}

function shouldWakeSystemLoop(event: RuntimeEvent): boolean {
  if (event.type === "final") {
    return true;
  }
  if (event.type === "session") {
    return event.status === "completed" || event.status === "failed" || event.status === "cancelled";
  }
  if (event.type === "envelope") {
    return event.envelope.type === "task.create" ||
      event.envelope.type === "task.cancel" ||
      event.envelope.type === "artifact.create" ||
      event.envelope.type === "artifact.update" ||
      event.envelope.type === "blackboard.write";
  }
  if (event.type !== "blackboard") {
    return false;
  }
  if (event.entry.created_by.agent_id === "symphony") {
    return false;
  }
  const tags = event.entry.tags ?? [];
  return event.entry.key.startsWith("work.") ||
    event.entry.key.startsWith("symphony.work.") ||
    tags.includes("work-source") ||
    tags.includes("work-item") ||
    tags.includes("symphony");
}

function eventWakeReason(event: RuntimeEvent): string {
  if (event.type === "blackboard") {
    return `blackboard:${event.entry.key}`;
  }
  if (event.type === "envelope") {
    return `envelope:${event.envelope.type}`;
  }
  if (event.type === "session") {
    return `session:${event.status}`;
  }
  return event.type;
}

function effectiveExecute(config: WorkflowRuntimeConfig, optionExecute: boolean | undefined): boolean {
  if (optionExecute !== undefined) {
    return optionExecute;
  }
  const env = process.env.SWARM_SYSTEM_LOOP_EXECUTE ?? process.env.SWARM_SYMPHONY_AUTO_EXECUTE;
  if (env === "1" || env === "true") {
    return true;
  }
  if (env === "0" || env === "false") {
    return false;
  }
  return config.system_loop?.execute === true;
}

function systemLoopDisabledByEnv(): boolean {
  const value = process.env.SWARM_SYSTEM_LOOP;
  return value === "0" || value === "false";
}
