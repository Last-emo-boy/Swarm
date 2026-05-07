import type { RunAttempt, SwarmSession, WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { SessionRow } from "../storage/session-store.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowLoadResult } from "./workflow.js";
import { SYMPHONY_SESSION_SOURCES, workItemKey } from "./work-item.js";

export type SymphonySessionStatus = {
  session_id: string;
  swarm_id: string;
  objective: string;
  status: SwarmSession["status"];
  work_item: WorkItem;
  work_item_key: string;
  workspace_path?: string;
  updated_at: string;
  latest_attempt?: RunAttempt;
  runner_attempt?: RunAttempt;
  retry_attempt?: RunAttempt;
  dispatch_attempt?: RunAttempt;
  next_retry_at?: string;
  last_error?: string;
};

export type SymphonyStatus = {
  workflow: WorkflowLoadResult;
  generated_at: string;
  totals: {
    sessions: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    retrying: number;
  };
  scheduler: {
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
  sessions: SymphonySessionStatus[];
};

export function getSymphonyStatus(input: {
  runtime: SwarmRuntime;
  workflowPath?: string;
  limit?: number;
}): SymphonyStatus {
  const workflow = loadWorkflow(input.workflowPath);
  const scheduler = schedulerSnapshotFromKernel(input.runtime, workflow);
  const rows = input.runtime.sessionStore.listBySources([...SYMPHONY_SESSION_SOURCES], Math.min(input.limit ?? 100, 500));
  const sessions = rows
    .map((row) => sessionStatusFromRow(input.runtime, row))
    .filter((item): item is SymphonySessionStatus => Boolean(item));
  return {
    workflow,
    generated_at: new Date().toISOString(),
    totals: {
      sessions: sessions.length,
      running: sessions.filter((session) => isActiveSession(session.status)).length,
      completed: sessions.filter((session) => session.status === "completed").length,
      failed: sessions.filter((session) => session.status === "failed").length,
      cancelled: sessions.filter((session) => session.status === "cancelled").length,
      retrying: sessions.filter((session) => session.retry_attempt && session.retry_attempt.status === "started").length
    },
    scheduler,
    sessions
  };
}

function schedulerSnapshotFromKernel(runtime: SwarmRuntime, workflow: WorkflowLoadResult): SymphonyStatus["scheduler"] {
  if (!workflow.ok) {
    const maxConcurrent = runtime.settings.runtime.maxAgents;
    return {
      claimed: [],
      completed: [],
      running: [],
      retrying: [],
      capacity: {
        max_concurrent: maxConcurrent,
        running: 0,
        available: maxConcurrent
      }
    };
  }
  const config = normalizeWorkflowConfig(workflow.workflow);
  const maxConcurrent = config.agent.max_concurrent_agents;
  const sessions = runtime.sessionStore.listBySources([...SYMPHONY_SESSION_SOURCES], 1_000)
    .map((row) => sessionStatusFromRow(runtime, row))
    .filter((item): item is SymphonySessionStatus => Boolean(item));
  const running = sessions
    .filter((session) => isActiveSession(session.status))
    .map((session) => ({
      key: session.work_item_key,
      session_id: session.session_id,
      work_item: session.work_item,
      workspace_path: session.workspace_path ?? "",
      started_at: session.dispatch_attempt?.started_at ?? session.latest_attempt?.started_at ?? session.updated_at,
      status: session.status
    }))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const completed = sessions
    .filter((session) => session.status === "completed" || session.runner_attempt?.status === "completed")
    .map((session) => session.work_item_key)
    .sort();
  const retrying = sessions
    .filter((session) => session.retry_attempt?.status === "started" && session.next_retry_at)
    .map((session) => ({
      key: session.work_item_key,
      work_item: session.work_item,
      attempt: session.retry_attempt?.attempt ?? 0,
      due_at: session.next_retry_at ?? "",
      error: session.retry_attempt?.terminal_reason ?? session.last_error
    }))
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
  return {
    claimed: running.map((session) => session.key).sort(),
    completed,
    running,
    retrying,
    capacity: {
      max_concurrent: maxConcurrent,
      running: running.length,
      available: Math.max(0, maxConcurrent - running.length)
    }
  };
}

function sessionStatusFromRow(runtime: SwarmRuntime, row: SessionRow): SymphonySessionStatus | undefined {
  const workItem = parseWorkItem(row.source_json);
  if (!workItem) {
    return undefined;
  }
  const attempts = runtime.runAttemptStore.list(row.session_id);
  const latestAttempt = latestAttemptByTime(attempts);
  const dispatchAttempt = latestAttemptMatching(attempts, (attempt) => attempt.task_id === "symphony.dispatch");
  const runnerAttempt = latestAttemptMatching(attempts, (attempt) => attempt.task_id === "symphony.runner");
  const retryAttempt = latestAttemptMatching(attempts, (attempt) => attempt.task_id === "symphony.retry");
  const workspace = row.workspace_lease_id
    ? runtime.workspaceLeaseStore.get(row.workspace_lease_id)
    : runtime.workspaceLeaseStore.getBySession(row.session_id);
  const nextRetryAt = typeof retryAttempt?.metadata.due_at === "string" ? retryAttempt.metadata.due_at : undefined;
  return {
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    objective: row.objective,
    status: row.status,
    work_item: workItem,
    work_item_key: workItemKey(workItem),
    workspace_path: workspace?.workspace_path ?? latestAttempt?.workspace_path,
    updated_at: row.updated_at,
    latest_attempt: latestAttempt,
    runner_attempt: runnerAttempt,
    retry_attempt: retryAttempt,
    dispatch_attempt: dispatchAttempt,
    next_retry_at: nextRetryAt,
    last_error: runnerAttempt?.terminal_reason ?? retryAttempt?.terminal_reason ?? latestAttempt?.terminal_reason
  };
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

function latestAttemptByTime(attempts: RunAttempt[]): RunAttempt | undefined {
  return attempts
    .slice()
    .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at) || b.started_at.localeCompare(a.started_at))[0];
}

function latestAttemptMatching(attempts: RunAttempt[], predicate: (attempt: RunAttempt) => boolean): RunAttempt | undefined {
  return latestAttemptByTime(attempts.filter(predicate));
}

function isActiveSession(status: SwarmSession["status"]): boolean {
  return status === "created" || status === "planning" || status === "running" || status === "reviewing" || status === "aggregating";
}
