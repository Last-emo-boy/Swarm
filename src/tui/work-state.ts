import type { WorkProtocolRecord, WorkTaskRecord } from "../runtime/work-protocol.js";

export type TuiTaskState = {
  title: string;
  status: string;
  phase?: WorkTaskRecord["phase"];
  workerId?: string;
  attempt?: number;
  capability?: string;
  writePolicy?: WorkTaskRecord["write_policy"];
  fileScope?: string[];
};

export type TuiWorkState = {
  taskStates: Map<string, TuiTaskState>;
  taskCompleted: number;
  taskTotal: number;
};

export type TuiTaskPolicySummary = {
  readOnly: number;
  scopedWrite: number;
  workspaceWrite: number;
  mutating: number;
  scopedTargets: string[];
};

export function applyWorkRecordToTuiState(previous: TuiWorkState, work: WorkProtocolRecord): TuiWorkState {
  if (work.kind !== "task") {
    return previous;
  }

  const nextTasks = new Map(previous.taskStates);
  const existing = nextTasks.get(work.task_id);
  nextTasks.set(work.task_id, {
    title: work.title,
    status: work.status ?? work.phase,
    phase: work.phase,
    workerId: work.worker_id,
    attempt: work.attempt ?? existing?.attempt,
    capability: work.capability ?? existing?.capability,
    writePolicy: work.write_policy ?? existing?.writePolicy,
    fileScope: work.file_scope ?? existing?.fileScope
  });
  return {
    taskStates: nextTasks,
    taskTotal: Math.max(previous.taskTotal, nextTasks.size),
    taskCompleted: countCompletedTasks(nextTasks)
  };
}

export function applyTaskAttemptToTuiState(
  previous: TuiWorkState,
  attempt: { task_id: string; title: string; status: string; attempt: number }
): TuiWorkState {
  const nextTasks = new Map(previous.taskStates);
  const existing = nextTasks.get(attempt.task_id);
  nextTasks.set(attempt.task_id, {
    title: attempt.title,
    status: attempt.status,
    phase: existing?.phase,
    workerId: existing?.workerId,
    attempt: attempt.attempt,
    capability: existing?.capability,
    writePolicy: existing?.writePolicy,
    fileScope: existing?.fileScope
  });
  return {
    taskStates: nextTasks,
    taskTotal: Math.max(previous.taskTotal, nextTasks.size),
    taskCompleted: countCompletedTasks(nextTasks)
  };
}

function countCompletedTasks(tasks: Map<string, TuiTaskState>): number {
  let completed = 0;
  for (const task of tasks.values()) {
    if (task.phase === "completed" || task.status === "completed" || task.status.endsWith("/completed")) {
      completed += 1;
    }
  }
  return completed;
}

export function summarizeTaskWritePolicies(tasks: Map<string, TuiTaskState>): TuiTaskPolicySummary {
  let readOnly = 0;
  let scopedWrite = 0;
  let workspaceWrite = 0;
  const scopedTargets = new Set<string>();
  for (const task of tasks.values()) {
    if (task.writePolicy === "read_only") {
      readOnly += 1;
    } else if (task.writePolicy === "scoped_write") {
      scopedWrite += 1;
    } else if (task.writePolicy === "workspace_write") {
      workspaceWrite += 1;
    }
    for (const path of task.fileScope ?? []) {
      scopedTargets.add(path);
    }
  }
  return {
    readOnly,
    scopedWrite,
    workspaceWrite,
    mutating: scopedWrite + workspaceWrite,
    scopedTargets: [...scopedTargets]
  };
}
