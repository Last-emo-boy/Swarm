import type { BlackboardEntry, RunAttempt, SwarmSession, WorkItem, WorkSnapshot } from "../protocol/types.js";
import { createEnvelope } from "../protocol/envelope.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { SessionRow } from "../storage/session-store.js";
import { loadWorkflow, normalizeWorkflowConfig, renderWorkflowPrompt, type WorkflowDefinition, type WorkflowLoadResult, type WorkflowRuntimeConfig } from "./workflow.js";
import { createWorkSourceFromConfig, isTerminalWorkSourceItem, workSourceIdentity, type LocalWorkRecord, type WorkSource } from "./work-source.js";
import { createSymphonyWorkSession, workItemToTemplateIssue } from "./kernel.js";
import { SYMPHONY_SESSION_SOURCES, workItemKey, workItemLabel } from "./work-item.js";
import { prepareWorkItemWorkspace } from "./workspace.js";
import { isFatalHookResult, runSymphonyHook } from "./hooks.js";
import { persistSymphonyPreflight, runSymphonyPreflight, type SymphonyPreflightIssue } from "./preflight.js";
import type { SymphonyRunner } from "./runner.js";

export type SymphonyDispatchStatus = "dispatched" | "skipped" | "failed";

export type SymphonyDispatchRecord = {
  status: SymphonyDispatchStatus;
  reason?: string;
  work_item: WorkItem;
  session?: SwarmSession;
  workspace_path?: string;
  prompt?: string;
  blackboard_entry?: BlackboardEntry;
  attempt?: RunAttempt;
  snapshot?: WorkSnapshot;
  error?: string;
};

export type SymphonyTickResult = {
  workflow: WorkflowLoadResult;
  candidates: WorkItem[];
  dispatched: SymphonyDispatchRecord[];
  skipped: SymphonyDispatchRecord[];
  failed: SymphonyDispatchRecord[];
  preflight?: {
    ok: boolean;
    issues: SymphonyPreflightIssue[];
  };
  runs?: Array<{
    session_id?: string;
    status: "completed" | "failed" | "skipped" | "cancelled";
    error?: string;
  }>;
  snapshot: SymphonySchedulerSnapshot;
};

export type SymphonySchedulerSnapshot = {
  claimed: string[];
  completed: string[];
  running: Array<{
    key: string;
    session_id: string;
    work_item: WorkItem;
    workspace_path: string;
    started_at: string;
    status: SwarmSession["status"];
  }>;
  retrying: Array<{
    key: string;
    work_item: WorkItem;
    attempt: number;
    due_at: string;
    error?: string;
  }>;
  capacity: {
    max_concurrent: number;
    running: number;
    available: number;
  };
};

type RunningRecord = {
  key: string;
  session_id: string;
  work_item: WorkItem;
  workspace_path: string;
  started_at: string;
  status: SwarmSession["status"];
};

type RetryRecord = {
  key: string;
  work_item: WorkItem;
  attempt: number;
  due_at_ms: number;
  error?: string;
};

export class SymphonyScheduler {
  private readonly claimed = new Set<string>();
  private readonly running = new Map<string, RunningRecord>();
  private readonly retrying = new Map<string, RetryRecord>();
  private readonly completed = new Set<string>();
  private readonly source: WorkSource;

  constructor(
    private readonly input: {
      runtime: SwarmRuntime;
      workflowPath?: string;
      source?: WorkSource;
      records?: LocalWorkRecord[];
      createWorkspace?: boolean;
      execute?: boolean;
      maxRunnerTurns?: number;
      maxRunnerToolCalls?: number;
      runner?: SymphonyRunner;
    }
  ) {
    this.source = input.source ?? createSchedulerWorkSource(input.workflowPath, input.records);
  }

  recover(): void {
    const workflow = loadWorkflow(this.input.workflowPath);
    if (!workflow.ok) {
      return;
    }
    this.recoverFromKernel(normalizeWorkflowConfig(workflow.workflow));
    this.reconcileFinishedSessions();
  }

  async tick(): Promise<SymphonyTickResult> {
    const workflow = loadWorkflow(this.input.workflowPath);
    if (!workflow.ok) {
      const snapshot = this.snapshot(undefined);
      return { workflow, candidates: [], dispatched: [], skipped: [], failed: [], snapshot };
    }

    const config = normalizeWorkflowConfig(workflow.workflow);
    this.recoverFromKernel(config);
    this.reconcileFinishedSessions();
    await this.reconcileSourceState(config);
    const candidates = await this.source.fetchCandidateItems();
    const dispatched: SymphonyDispatchRecord[] = [];
    const skipped: SymphonyDispatchRecord[] = [];
    const failed: SymphonyDispatchRecord[] = [];
    const preflight = runSymphonyPreflight({
      runtime: this.input.runtime,
      workflow: workflow.workflow,
      config,
      candidates
    });
    if (!preflight.ok) {
      persistSymphonyPreflight({
        runtime: this.input.runtime,
        workflow: workflow.workflow,
        result: preflight
      });
      return {
        workflow,
        candidates,
        dispatched,
        skipped,
        failed: candidates.map((item) => ({
          status: "failed",
          reason: "preflight_failed",
          work_item: item,
          error: preflight.issues.find((issue) => issue.severity === "error")?.message ?? "Symphony preflight failed."
        })),
        preflight,
        snapshot: this.snapshot(config)
      };
    }
    if (preflight.issues.length > 0) {
      persistSymphonyPreflight({
        runtime: this.input.runtime,
        workflow: workflow.workflow,
        result: preflight
      });
    }

    for (const item of sortWorkItems(candidates)) {
      const key = workItemKey(item);
      if (!isActiveItem(item, config)) {
        const recovered = this.running.get(key);
        if (recovered) {
          this.cancelRecoveredSession(recovered, item, "work_item_state_inactive");
        }
        skipped.push({ status: "skipped", reason: "not_active_state", work_item: item });
        continue;
      }
      const retry = this.retrying.get(key);
      if (retry && retry.due_at_ms <= Date.now()) {
        this.retrying.delete(key);
      }
      if (this.claimed.has(key)) {
        skipped.push({ status: "skipped", reason: "already_claimed", work_item: item });
        continue;
      }
      if (this.completed.has(key)) {
        skipped.push({ status: "skipped", reason: "already_completed", work_item: item });
        continue;
      }
      if (retry && retry.due_at_ms > Date.now()) {
        skipped.push({ status: "skipped", reason: "retry_not_due", work_item: item });
        continue;
      }
      if (this.running.size >= config.agent.max_concurrent_agents) {
        skipped.push({ status: "skipped", reason: "capacity_full", work_item: item });
        continue;
      }

      this.claimed.add(key);
      try {
        const record = await this.dispatchItem(item, config, workflow.workflow, retry?.attempt ?? 0);
        this.running.set(key, {
          key,
          session_id: record.session?.session_id ?? "",
          work_item: item,
          workspace_path: record.workspace_path ?? "",
          started_at: new Date().toISOString(),
          status: record.session?.status ?? "created"
        });
        this.retrying.delete(key);
        dispatched.push(record);
      } catch (error) {
        const context = error instanceof SymphonyDispatchError ? error.context : {};
        const retryRecord = this.scheduleRetry(item, retry, config, error, context);
        failed.push({
          status: "failed",
          reason: "dispatch_failed",
          work_item: item,
          error: error instanceof Error ? error.message : String(error)
        });
        this.input.runtime.events.emitEvent({
          type: "log",
          level: "warn",
          message: `Symphony dispatch failed for ${workItemLabel(item)}; retry ${retryRecord.attempt} scheduled.`
        });
      }
    }

    const runs = this.input.execute
      ? await this.runDispatchedWork(dispatched, config)
      : undefined;

    return {
      workflow,
      candidates,
      dispatched,
      skipped,
      failed,
      preflight,
      runs,
      snapshot: this.snapshot(config)
    };
  }

  snapshot(config?: WorkflowRuntimeConfig): SymphonySchedulerSnapshot {
    const maxConcurrent = config?.agent.max_concurrent_agents ?? this.input.runtime.settings.runtime.maxAgents;
    return {
      claimed: [...this.claimed].sort(),
      completed: [...this.completed].sort(),
      running: [...this.running.values()].sort((a, b) => a.started_at.localeCompare(b.started_at)),
      retrying: [...this.retrying.values()]
        .sort((a, b) => a.due_at_ms - b.due_at_ms)
        .map((item) => ({
          key: item.key,
          work_item: item.work_item,
          attempt: item.attempt,
          due_at: new Date(item.due_at_ms).toISOString(),
          error: item.error
        })),
      capacity: {
        max_concurrent: maxConcurrent,
        running: this.running.size,
        available: Math.max(0, maxConcurrent - this.running.size)
      }
    };
  }

  private async dispatchItem(
    item: WorkItem,
    config: WorkflowRuntimeConfig,
    workflow: WorkflowDefinition,
    retryAttempt: number
  ): Promise<SymphonyDispatchRecord> {
    const issue = workItemToTemplateIssue(item);
    const prompt = renderWorkflowPrompt({
      workflow,
      issue,
      attempt: retryAttempt > 0 ? retryAttempt : null
    });
    const session = createSymphonyWorkSession({
      item,
      maxAgents: config.agent.max_concurrent_agents,
      timeoutMs: this.input.runtime.settings.runtime.taskTimeoutMs,
      status: "running"
    });
    const prepared = prepareWorkItemWorkspace({
      item,
      session_id: session.session_id,
      workspace_root: config.workspace.root,
      create: this.input.createWorkspace ?? true
    });
    const lease = this.input.runtime.workspaceLeaseStore.create(prepared.lease);
    session.workspace_lease_id = lease.lease_id;
    this.input.runtime.sessionStore.createIfMissing(session);
    this.input.runtime.sessionStore.updateMetadata(session.session_id, {
      source: item,
      workspace_lease_id: lease.lease_id
    });

    if (prepared.created_now) {
      const hook = await runSymphonyHook("after_create", {
        runtime: this.input.runtime,
        session,
        work_item: item,
        workspace_path: prepared.workspace_path,
        workspace_created_now: prepared.created_now,
        config
      });
      if (isFatalHookResult("after_create", hook)) {
        this.input.runtime.sessionStore.setStatus(session.session_id, "failed");
        this.input.runtime.events.emitEvent({
          type: "session",
          session_id: session.session_id,
          status: "failed",
          objective: session.objective
        });
        throw new SymphonyDispatchError(hook.reason ?? "Symphony after_create hook failed.", {
          session_id: session.session_id,
          swarm_id: session.swarm_id,
          workspace_path: prepared.workspace_path
        });
      }
    }

    const task = this.input.runtime.taskStateStore.upsert({
      session_id: session.session_id,
      swarm_id: session.swarm_id,
      task: {
        task_id: "symphony.dispatch",
        title: `Dispatch ${workItemLabel(item)}`,
        description: "Symphony scheduler created a Work Kernel session for a local work item.",
        objective: prompt,
        type: "planning",
        status: "assigned",
        required_capabilities: ["code.implement", "code.review"],
        inputs: {
          work_item: item,
          workflow_path: workflow.path,
          workspace_path: prepared.workspace_path
        },
        expected_output: { format: "markdown" },
        dependencies: []
      },
      status: "assigned",
      attempt: retryAttempt,
      assigned_to: { agent_id: "symphony", role: "scheduler" }
    });

    const attempt = this.input.runtime.runAttemptStore.upsert({
      session_id: session.session_id,
      task_id: task.task_id,
      runner_id: "symphony.scheduler",
      kind: "swarm_task",
      status: "completed",
      attempt: retryAttempt,
      title: task.title,
      terminal_reason: "Dispatched to Work Kernel.",
      workspace_path: prepared.workspace_path,
      metadata: {
        work_item_key: workItemKey(item),
        workflow_path: workflow.path,
        workspace_created_now: prepared.created_now,
        prompt_preview: firstLine(prompt)
      }
    });

    const envelope = createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: task.task_id,
      attempt: retryAttempt,
      from: { agent_id: "symphony", role: "scheduler" },
      to: { agent_id: "main_swarm", role: "controller" },
      type: "task.assign",
      intent: "symphony.dispatch",
      priority: priorityForItem(item),
      idempotency_key: `${session.swarm_id}:${task.task_id}:symphony.dispatch:${retryAttempt}`,
      payload: {
        work_item: item,
        workflow_path: workflow.path,
        workspace_path: prepared.workspace_path,
        prompt,
        runner: "pending"
      }
    });
    this.input.runtime.traceStore.append(envelope);
    this.input.runtime.events.emitEvent({ type: "envelope", envelope });

    const blackboardEntry = this.input.runtime.blackboardStore.write({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: task.task_id,
      key: "symphony.dispatch",
      type: "decision",
      value: {
        workflow_path: workflow.path,
        work_item: item,
        workspace_path: prepared.workspace_path,
        workspace_created_now: prepared.created_now,
        prompt,
        attempt: retryAttempt
      },
      created_by: { agent_id: "symphony", role: "scheduler" },
      tags: ["symphony", "dispatch", "workflow", "work-kernel"]
    });

    this.input.runtime.events.emitEvent({ type: "blackboard", entry: blackboardEntry });
    this.input.runtime.events.emitEvent({
      type: "session",
      session_id: session.session_id,
      status: "running",
      objective: session.objective
    });

    return {
      status: "dispatched",
      work_item: item,
      session,
      workspace_path: prepared.workspace_path,
      prompt,
      blackboard_entry: blackboardEntry,
      attempt,
      snapshot: this.input.runtime.getWorkSnapshot(session.session_id)
    };
  }

  private scheduleRetry(
    item: WorkItem,
    previous: RetryRecord | undefined,
    config: WorkflowRuntimeConfig,
    error: unknown,
    context: { session_id?: string; swarm_id?: string; workspace_path?: string } = {}
  ): RetryRecord {
    const key = workItemKey(item);
    const attempt = (previous?.attempt ?? 0) + 1;
    const backoff = Math.min(config.agent.max_retry_backoff_ms, 1_000 * (2 ** Math.max(0, attempt - 1)));
    const dueAtMs = Date.now() + backoff;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const retry: RetryRecord = {
      key,
      work_item: item,
      attempt,
      due_at_ms: dueAtMs,
      error: errorMessage
    };
    this.retrying.set(key, retry);
    this.claimed.delete(key);
    this.running.delete(key);
    if (context.session_id) {
      this.input.runtime.runAttemptStore.upsert({
        session_id: context.session_id,
        task_id: "symphony.retry",
        runner_id: "symphony.scheduler",
        kind: "swarm_task",
        status: "started",
        attempt,
        attempt_id: `attempt_${sanitizeAttemptId(context.session_id)}_symphony.retry_${attempt}`,
        title: `Retry ${workItemLabel(item)}`,
        terminal_reason: errorMessage,
        workspace_path: context.workspace_path,
        error_code: "SYMPHONY_RETRY_SCHEDULED",
        recovery_suggestion: "retry_same_agent",
        metadata: {
          work_item_key: key,
          due_at: new Date(dueAtMs).toISOString(),
          error: errorMessage
        }
      });
      const entry = this.input.runtime.blackboardStore.write({
        swarm_id: context.swarm_id ?? `swarm_${context.session_id}`,
        session_id: context.session_id,
        task_id: "symphony.retry",
        key: "symphony.retry.scheduled",
        type: "decision",
        value: {
          work_item: item,
          work_item_key: key,
          attempt,
          due_at: new Date(dueAtMs).toISOString(),
          error: errorMessage
        },
        created_by: { agent_id: "symphony", role: "scheduler" },
        tags: ["symphony", "retry", "scheduler", "work-kernel"]
      });
      this.input.runtime.events.emitEvent({ type: "blackboard", entry });
    }
    return retry;
  }

  private recoverFromKernel(config: WorkflowRuntimeConfig): void {
    const rows = this.input.runtime.sessionStore.listBySources([...SYMPHONY_SESSION_SOURCES], 1_000);
    const seen = new Set<string>();
    for (const row of rows) {
      const item = parseWorkItem(row.source_json);
      if (!item) {
        continue;
      }
      const attempts = this.input.runtime.runAttemptStore.list(row.session_id);
      const dispatch = latestAttempt(attempts, (attempt) => attempt.task_id === "symphony.dispatch");
      const retry = latestAttempt(attempts, (attempt) => attempt.task_id === "symphony.retry");
      const runner = latestAttempt(attempts, (attempt) => attempt.task_id === "symphony.runner");
      const hook = latestAttempt(attempts, (attempt) => attempt.task_id?.startsWith("symphony.hook.") === true);
      const anchor = dispatch ?? retry ?? hook ?? runner;
      if (!anchor) {
        continue;
      }
      const key = workItemKey(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (!isActiveItem(item, config)) {
        const recovered = this.running.get(key);
        if (recovered) {
          this.cancelRecoveredSession(recovered, item, "work_item_state_inactive");
        } else {
          this.running.delete(key);
          this.retrying.delete(key);
          this.claimed.delete(key);
        }
        continue;
      }
      const workspacePath = workspacePathForSession(this.input.runtime, row, anchor);

      if (row.status === "completed" && runner?.status !== "failed") {
        this.completed.add(key);
        this.running.delete(key);
        this.retrying.delete(key);
        this.claimed.delete(key);
        continue;
      }

      if (runner?.status === "completed") {
        this.completed.add(key);
        this.running.delete(key);
        this.retrying.delete(key);
        this.claimed.delete(key);
        continue;
      }

      const recoveredRetry = retryStateFromAttempt(item, retry);
      if (recoveredRetry.state === "pending") {
        this.retrying.set(key, recoveredRetry);
        this.running.delete(key);
        this.claimed.delete(key);
        continue;
      }

      if (recoveredRetry.state === "due") {
        this.retrying.set(key, recoveredRetry);
        this.running.delete(key);
        this.claimed.delete(key);
        continue;
      }

      if (row.status === "failed" || row.status === "cancelled" || isTerminalAttempt(runner)) {
        const attempt = retryAttemptNumber(attempts);
        const dueAtMs = Date.now() + Math.min(config.agent.max_retry_backoff_ms, 1_000 * (2 ** Math.max(0, attempt - 1)));
        this.retrying.set(key, {
          key,
          work_item: item,
          attempt,
          due_at_ms: dueAtMs,
          error: runner?.terminal_reason ?? row.status
        });
        this.running.delete(key);
        this.claimed.delete(key);
        continue;
      }

      if (isActiveSession(row.status)) {
        this.running.set(key, {
          key,
          session_id: row.session_id,
          work_item: item,
          workspace_path: workspacePath,
          started_at: anchor.started_at,
          status: row.status
        });
        this.claimed.add(key);
      }
    }
  }

  private async reconcileSourceState(config: WorkflowRuntimeConfig): Promise<void> {
    const tracked = uniqueWorkItems([
      ...[...this.running.values()].map((record) => record.work_item),
      ...[...this.retrying.values()].map((record) => record.work_item)
    ]);
    if (tracked.length === 0) {
      return;
    }
    try {
      const refreshed = await this.source.refreshItems(tracked);
      for (const item of tracked) {
        const key = workItemKey(item);
        const current = refreshed.get(workSourceIdentity(item));
        const running = this.running.get(key);
        if (!current) {
          if (running) {
            this.cancelRecoveredSession(running, item, "work_item_missing_from_source");
          } else {
            this.retrying.delete(key);
            this.claimed.delete(key);
          }
          continue;
        }
        if (!isActiveItem(current, config)) {
          if (running) {
            this.cancelRecoveredSession(
              running,
              current,
              isTerminalWorkSourceItem(current, { active: config.work_source.active_states, terminal: config.work_source.terminal_states })
                ? "work_item_terminal"
                : "work_item_state_inactive"
            );
          } else {
            this.retrying.delete(key);
            this.claimed.delete(key);
          }
          continue;
        }
        const refreshedKey = workItemKey(current);
        if (running) {
          running.work_item = current;
        }
        const retry = this.retrying.get(key);
        if (retry) {
          this.retrying.delete(key);
          this.retrying.set(refreshedKey, {
            ...retry,
            key: refreshedKey,
            work_item: current
          });
        }
      }
    } catch (error) {
      this.input.runtime.events.emitEvent({
        type: "log",
        level: "warn",
        message: `Symphony work source refresh failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private cancelRecoveredSession(record: RunningRecord, item: WorkItem, reason: string): void {
    const liveStopRequested = this.input.runtime.interruptWorkSession(record.session_id, reason);
    this.input.runtime.sessionStore.setStatus(record.session_id, "cancelled");
    this.running.delete(record.key);
    this.retrying.delete(record.key);
    this.claimed.delete(record.key);
    this.input.runtime.runAttemptStore.upsert({
      session_id: record.session_id,
      task_id: "symphony.reconcile",
      runner_id: "symphony.scheduler",
      kind: "swarm_task",
      status: "cancelled",
      attempt: 0,
      attempt_id: `attempt_${sanitizeAttemptId(record.session_id)}_symphony.reconcile_0`,
      title: `Reconcile ${workItemLabel(item)}`,
      terminal_reason: reason,
      workspace_path: record.workspace_path,
      metadata: {
        work_item_key: record.key,
        work_item: item,
        reason,
        live_stop_requested: liveStopRequested
      }
    });
    const row = this.input.runtime.sessionStore.get(record.session_id);
    if (row) {
      const entry = this.input.runtime.blackboardStore.write({
        swarm_id: row.swarm_id,
        session_id: row.session_id,
        task_id: "symphony.reconcile",
        key: "symphony.reconcile.cancelled",
        type: "decision",
        value: {
          work_item: item,
          reason,
          live_stop_requested: liveStopRequested
        },
        created_by: { agent_id: "symphony", role: "scheduler" },
        tags: ["symphony", "reconcile", "cancelled", "work-kernel"]
      });
      this.input.runtime.events.emitEvent({ type: "blackboard", entry });
      this.input.runtime.events.emitEvent({
        type: "session",
        session_id: row.session_id,
        status: "cancelled",
        objective: row.objective
      });
    }
  }

  private reconcileFinishedSessions(): void {
    for (const [key, record] of this.running) {
      const row = this.input.runtime.sessionStore.get(record.session_id);
      if (!row || row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
        this.running.delete(key);
        this.claimed.delete(key);
        continue;
      }
      record.status = row.status;
    }
  }

  private async runDispatchedWork(
    dispatched: SymphonyDispatchRecord[],
    config: WorkflowRuntimeConfig
  ): Promise<NonNullable<SymphonyTickResult["runs"]>> {
    const { runDispatchedSymphonyWork } = await import("./runner.js");
    const executable: SymphonyDispatchRecord[] = [];
    const skippedByHook: Awaited<ReturnType<typeof runDispatchedSymphonyWork>> = [];
    for (const dispatch of dispatched) {
      if (!dispatch.session) {
        skippedByHook.push({ dispatch, status: "skipped", error: "dispatch_missing_session" });
        continue;
      }
      const hook = await runSymphonyHook("before_run", {
        runtime: this.input.runtime,
        session: dispatch.session,
        work_item: dispatch.work_item,
        workspace_path: dispatch.workspace_path ?? "",
        config
      });
      if (isFatalHookResult("before_run", hook)) {
        this.input.runtime.sessionStore.setStatus(dispatch.session.session_id, "failed");
        this.input.runtime.events.emitEvent({
          type: "session",
          session_id: dispatch.session.session_id,
          status: "failed",
          objective: dispatch.session.objective
        });
        skippedByHook.push({
          dispatch,
          status: "failed",
          error: hook.reason ?? "Symphony before_run hook failed."
        });
        continue;
      }
      executable.push(dispatch);
    }

    const runRecords = await runDispatchedSymphonyWork({
      runtime: this.input.runtime,
      dispatches: executable,
      maxTurns: this.input.maxRunnerTurns,
      maxToolCalls: this.input.maxRunnerToolCalls,
      runner: this.input.runner
    });
    const records = [...skippedByHook, ...runRecords];
    for (const record of records) {
      const key = workItemKey(record.dispatch.work_item);
      if (record.dispatch.session) {
        await runSymphonyHook("after_run", {
          runtime: this.input.runtime,
          session: record.dispatch.session,
          work_item: record.dispatch.work_item,
          workspace_path: record.dispatch.workspace_path ?? "",
          config,
          result: {
            status: record.status,
            error: record.error,
            summary: record.result?.outcome?.final_summary
          }
        });
      }
      if (record.status === "completed" || record.status === "failed" || record.status === "skipped" || record.status === "cancelled") {
        this.running.delete(key);
        this.claimed.delete(key);
      }
      if (record.status === "completed") {
        this.completed.add(key);
      }
      if (record.status === "failed") {
        this.scheduleRetry(record.dispatch.work_item, undefined, config, record.error ?? "runner_failed", {
          session_id: record.dispatch.session?.session_id,
          swarm_id: record.dispatch.session?.swarm_id,
          workspace_path: record.dispatch.workspace_path
        });
      }
    }
    return records.map((record) => ({
      session_id: record.dispatch.session?.session_id,
      status: record.status,
      error: record.error
    }));
  }
}

export async function runSymphonyTick(input: {
  runtime: SwarmRuntime;
  workflowPath?: string;
  source?: WorkSource;
  records?: LocalWorkRecord[];
  createWorkspace?: boolean;
  execute?: boolean;
  maxRunnerTurns?: number;
  maxRunnerToolCalls?: number;
  runner?: SymphonyRunner;
}): Promise<SymphonyTickResult> {
  const scheduler = new SymphonyScheduler(input);
  return scheduler.tick();
}

function createSchedulerWorkSource(workflowPath: string | undefined, records: LocalWorkRecord[] | undefined): WorkSource {
  const workflow = loadWorkflow(workflowPath);
  return createWorkSourceFromConfig(
    workflow.ok
      ? normalizeWorkflowConfig(workflow.workflow)
      : normalizeWorkflowConfig({ path: "", config: {}, prompt_template: "" }),
    { records }
  );
}

function isActiveItem(item: WorkItem, config: WorkflowRuntimeConfig): boolean {
  if (!item.state) {
    return true;
  }
  const state = item.state.toLowerCase();
  return config.work_source.active_states.some((active) => active.toLowerCase() === state);
}

function uniqueWorkItems(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  const unique: WorkItem[] = [];
  for (const item of items) {
    const identity = workSourceIdentity(item);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    unique.push(item);
  }
  return unique;
}

function sortWorkItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const priorityA = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
    const priorityB = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    const updatedA = typeof a.metadata.updated_at === "string" ? a.metadata.updated_at : "";
    const updatedB = typeof b.metadata.updated_at === "string" ? b.metadata.updated_at : "";
    return updatedA.localeCompare(updatedB);
  });
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "";
}

function priorityForItem(item: WorkItem): "low" | "normal" | "high" | "critical" {
  if (typeof item.priority !== "number") {
    return "normal";
  }
  if (item.priority <= 0) return "critical";
  if (item.priority <= 2) return "high";
  if (item.priority >= 5) return "low";
  return "normal";
}

function parseWorkItem(value: string | null | undefined): WorkItem | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as WorkItem;
    return isWorkItem(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isWorkItem(value: unknown): value is WorkItem {
  return typeof value === "object" &&
    value !== null &&
    "source" in value &&
    "title" in value &&
    "labels" in value &&
    "metadata" in value &&
    typeof (value as { source?: unknown }).source === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    Array.isArray((value as { labels?: unknown }).labels) &&
    typeof (value as { metadata?: unknown }).metadata === "object" &&
    (value as { metadata?: unknown }).metadata !== null;
}

function latestAttempt(attempts: RunAttempt[], predicate: (attempt: RunAttempt) => boolean): RunAttempt | undefined {
  return attempts
    .filter(predicate)
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at) || b.started_at.localeCompare(a.started_at))[0];
}

type RecoveredRetry =
  | (RetryRecord & { state: "pending" | "due" })
  | { state: "missing" };

function retryStateFromAttempt(item: WorkItem, attempt: RunAttempt | undefined): RecoveredRetry {
  if (!attempt || attempt.status !== "started") {
    return { state: "missing" };
  }
  const dueAt = typeof attempt.metadata.due_at === "string" ? Date.parse(attempt.metadata.due_at) : NaN;
  if (!Number.isFinite(dueAt)) {
    return { state: "missing" };
  }
  return {
    state: dueAt <= Date.now() ? "due" : "pending",
    key: workItemKey(item),
    work_item: item,
    attempt: attempt.attempt,
    due_at_ms: dueAt,
    error: typeof attempt.metadata.error === "string" ? attempt.metadata.error : attempt.terminal_reason
  };
}

function retryAttemptNumber(attempts: RunAttempt[]): number {
  return Math.max(
    1,
    ...attempts
      .filter((attempt) => attempt.task_id === "symphony.runner" || attempt.task_id === "symphony.retry")
      .map((attempt) => attempt.attempt + 1)
  );
}

function isTerminalAttempt(attempt: RunAttempt | undefined): boolean {
  return attempt?.status === "failed" || attempt?.status === "cancelled" || attempt?.status === "stopped";
}

function isActiveSession(status: SwarmSession["status"]): boolean {
  return status === "created" || status === "planning" || status === "running" || status === "reviewing" || status === "aggregating";
}

function workspacePathForSession(runtime: SwarmRuntime, row: SessionRow, fallback: RunAttempt): string {
  const lease = row.workspace_lease_id
    ? runtime.workspaceLeaseStore.get(row.workspace_lease_id)
    : runtime.workspaceLeaseStore.getBySession(row.session_id);
  return lease?.workspace_path ?? fallback.workspace_path ?? "";
}

function sanitizeAttemptId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
}

class SymphonyDispatchError extends Error {
  constructor(
    message: string,
    readonly context: { session_id?: string; swarm_id?: string; workspace_path?: string }
  ) {
    super(message);
  }
}
