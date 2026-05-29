import type { RunAttempt, SwarmSession, WorkItem } from "../protocol/types.js";
import { liveControlFromCounts, liveControlFromSessionStatus, type LiveControlProjection } from "../runtime/live-control-status.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { buildWorkBoardFromSnapshots, type WorkBoard, type WorkBoardClaim } from "../runtime/work-board.js";
import type { AgentMailboxProjection } from "../storage/agent-actor-store.js";
import type { SessionRow } from "../storage/session-store.js";
import { latestSymphonyActionFact, type SymphonyActionFact } from "./action-lifecycle.js";
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
  latest_action?: SymphonyActionFact;
  live_control: LiveControlProjection;
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
      live_control: LiveControlProjection;
    }>;
    retrying: Array<{
      key: string;
      work_item: WorkItem;
      attempt: number;
      due_at: string;
      error?: string;
      live_control: LiveControlProjection;
    }>;
    capacity: {
      max_concurrent: number;
      running: number;
      available: number;
    };
  };
  participant?: SymphonyParticipantStatus;
  live_control: LiveControlProjection;
  latest_action?: SymphonyActionFact;
  work_board: WorkBoard;
  sessions: SymphonySessionStatus[];
};

export type SymphonyParticipantStatus = {
  actor_id: string;
  role: string;
  status: string;
  heartbeat_state: string;
  capabilities: string[];
  last_heartbeat_at?: string;
  current_task_id?: string;
  current_session_id?: string;
  mailbox: AgentMailboxProjection;
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
  const totals = {
    sessions: sessions.length,
    running: sessions.filter((session) => isActiveSession(session.status)).length,
    completed: sessions.filter((session) => session.status === "completed").length,
    failed: sessions.filter((session) => session.status === "failed").length,
    cancelled: sessions.filter((session) => session.status === "cancelled").length,
    retrying: sessions.filter((session) => session.retry_attempt && session.retry_attempt.status === "started").length
  };
  const latestAction = latestSymphonyActionFact(sessions.flatMap((session) => session.latest_action ? [session.latest_action] : []));
  const workBoard = buildSymphonyWorkBoard(input.runtime, sessions, scheduler, latestAction ? [latestAction] : []);
  return {
    workflow,
    generated_at: new Date().toISOString(),
    totals,
    scheduler,
    participant: symphonyParticipantStatus(input.runtime),
    live_control: workflow.ok
      ? liveControlFromCounts({
        source: "symphony",
        total: totals.sessions,
        running: totals.running,
        completed: totals.completed,
        failed: totals.failed + totals.cancelled,
        retrying: totals.retrying,
        summary: `symphony sessions=${totals.sessions} running=${totals.running} retrying=${totals.retrying}`
      })
      : liveControlFromCounts({
        source: "symphony",
        degraded: true,
        summary: `symphony workflow error: ${workflow.error.message}`,
        nextAction: "Fix the workflow path or front matter, then reload Symphony status."
      }),
    latest_action: latestAction,
    work_board: workBoard,
    sessions
  };
}

function symphonyParticipantStatus(runtime: SwarmRuntime): SymphonyParticipantStatus | undefined {
  const actor = runtime.agentActorStore?.get("symphony.scheduler");
  if (!actor) {
    return undefined;
  }
  return {
    actor_id: actor.actor_id,
    role: actor.role,
    status: actor.status,
    heartbeat_state: actor.heartbeat_state,
    capabilities: actor.capabilities,
    last_heartbeat_at: actor.last_heartbeat_at,
    current_task_id: actor.current_task_id,
    current_session_id: actor.current_session_id,
    mailbox: runtime.agentActorStore.mailbox(actor.actor_id)
  };
}

function buildSymphonyWorkBoard(
  runtime: SwarmRuntime,
  sessions: SymphonySessionStatus[],
  scheduler: SymphonyStatus["scheduler"],
  actions: SymphonyActionFact[]
): WorkBoard {
  const snapshots = typeof runtime.getWorkSnapshot === "function"
    ? sessions
      .map((session) => {
        try {
          return runtime.getWorkSnapshot(session.session_id);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is ReturnType<SwarmRuntime["getWorkSnapshot"]> => Boolean(item))
    : [];
  const claims: WorkBoardClaim[] = [
    ...scheduler.running.map((item) => ({
      claim_id: `symphony:${item.key}`,
      kind: "symphony" as const,
      session_id: item.session_id,
      work_item_key: item.key,
      status: item.status,
      target: item.workspace_path || item.work_item.title,
      updated_at: item.started_at,
      recovery: item.live_control.next_action
    })),
    ...scheduler.retrying.map((item) => ({
      claim_id: `symphony-retry:${item.key}`,
      kind: "symphony" as const,
      work_item_key: item.key,
      status: "retrying",
      target: item.due_at,
      updated_at: item.due_at,
      recovery: item.live_control.next_action
    }))
  ];
  return buildWorkBoardFromSnapshots({
    runtime: typeof runtime.artifactStore === "object" ? runtime : undefined,
    scope: {
      kind: "symphony",
      workspace_path: typeof runtime.getWorkspacePath === "function" ? runtime.getWorkspacePath() : undefined
    },
    snapshots,
    extraClaims: claims,
    extraActions: actions
  });
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
      status: session.status,
      live_control: session.live_control
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
      error: session.retry_attempt?.terminal_reason ?? session.last_error,
      live_control: liveControlFromCounts({
        source: "symphony.retry",
        retrying: 1,
        summary: `symphony retry ${session.work_item_key} attempt=${session.retry_attempt?.attempt ?? 0}`,
        nextAction: `Retry is scheduled for ${session.next_retry_at}. Inspect the last error before forcing a retry.`
      })
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
  const operatorEntries = runtime.blackboardStore?.query(row.session_id, { tag: "operator" }) ?? [];
  const latestAction = latestSymphonyActionFact([
    ...attempts.map((attempt) => attempt.metadata),
    ...operatorEntries.map((entry) => entry.value)
  ]);
  const workspace = row.workspace_lease_id
    ? runtime.workspaceLeaseStore.get(row.workspace_lease_id)
    : runtime.workspaceLeaseStore.getBySession(row.session_id);
  const nextRetryAt = typeof retryAttempt?.metadata.due_at === "string" ? retryAttempt.metadata.due_at : undefined;
  const retrying = retryAttempt?.status === "started" && Boolean(nextRetryAt);
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
    last_error: runnerAttempt?.terminal_reason ?? retryAttempt?.terminal_reason ?? latestAttempt?.terminal_reason,
    latest_action: latestAction,
    live_control: liveControlFromSessionStatus({
      status: row.status,
      source: "symphony.session",
      retrying,
      summary: `symphony.session ${row.session_id}: ${row.status}`,
      nextAction: retrying && nextRetryAt
        ? `Retry is scheduled for ${nextRetryAt}. Inspect the last error before forcing a retry.`
        : undefined
    })
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
