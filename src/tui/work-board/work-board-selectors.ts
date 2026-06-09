import type { WorkBoard, WorkBoardArtifact, WorkBoardCheck, WorkBoardSession, WorkBoardTask, WorkBoardWorker } from "../../runtime/work-board.js";
import type { BlackboardEntry, WorkItem } from "../../protocol/types.js";
import type { ApprovalRecord } from "../../storage/approval-store.js";
import type { WorkerRecord } from "../../storage/worker-state-store.js";
import type { SymphonyDaemonRecord } from "../../symphony/daemon.js";
import type { SkillRecord } from "../../extensions/skills.js";
import type { WorkBoardColumnId, WorkBoardColumnView, WorkBoardItemTone, WorkBoardItemView, WorkBoardSurfaceView, WorkBoardThreadView } from "./work-board-types.js";

export type SelectWorkBoardSurfaceInput = {
  board?: WorkBoard;
  fallbackSessions?: WorkBoardSession[];
  memoryWorkers?: WorkerRecord[];
  approvals?: ApprovalRecord[];
  daemons?: SymphonyDaemonRecord[];
  skills?: SkillRecord[];
  blackboard?: BlackboardEntry[];
  recentMessages?: Array<{ role: string; brief: string }>;
  selectedId?: string;
  limitPerColumn?: number;
};

export function selectWorkBoardSurface(input: SelectWorkBoardSurfaceInput): WorkBoardSurfaceView {
  const board = input.board;
  const limit = Math.max(1, input.limitPerColumn ?? 4);
  const sessions = board?.sessions ?? input.fallbackSessions ?? [];
  const workers = board?.workers ?? [];
  const tasks = board?.tasks ?? [];
  const approvals = input.approvals ?? [];
  const memoryWorkers = input.memoryWorkers ?? [];
  const skills = input.skills ?? [];
  const blackboard = input.blackboard ?? [];
  const rows = [
    ...tasks.map((task) => itemFromTask(task, workers)),
    ...sessions.map((session) => itemFromSession(session, workers)),
    ...workers
      .filter((worker) => !tasks.some((task) => task.session_id === worker.session_id && task.task_id === worker.worker_id))
      .map(itemFromWorker)
  ];
  const columns = buildColumns(dedupeItems(rows), limit);
  const selected = selectThread({
    selectedId: input.selectedId,
    columns,
    sessions,
    tasks,
    workers,
    checks: board?.checks ?? [],
    artifacts: board?.artifacts ?? [],
    changedFiles: board?.changed_files ?? [],
    blackboard,
    recentMessages: input.recentMessages ?? []
  });
  const activeTasks = board?.summary.active_sessions ?? sessions.filter((session) => isActiveStatus(session.status)).length;
  const blockers = (board?.summary.blocked ?? 0) + (board?.summary.failed ?? 0);
  const activity = [
    ...((board?.next_actions ?? []).slice(0, 3).map((action) => `${action.source}:${shortId(action.id)} ${firstLine(action.action, 84)}`)),
    ...memoryWorkers.filter((worker) => worker.status === "running").slice(0, 2).map((worker) => `${worker.display_name} is working on ${firstLine(worker.objective, 64)}`)
  ].slice(0, 5);
  const enabledSkillCount = enabledSkills(skills).length;
  return {
    title: "Board",
    subtitle: workBoardSubtitle(activeTasks, approvals.length, blockers),
    columns,
    selected,
    summary: {
      activeTasks,
      approvals: approvals.length,
      blockers,
      skills: enabledSkillCount,
      activity
    },
    empty: rows.length === 0 && blackboard.length === 0 && input.recentMessages?.length === 0
  };
}

function workBoardSubtitle(activeTasks: number, approvals: number, blockers: number): string {
  const parts = [
    countLabel(activeTasks, "active task"),
    countLabel(approvals, "approval"),
    countLabel(blockers, "need")
  ].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : "Ready";
}

function countLabel(count: number, label: string): string | undefined {
  const value = Math.max(0, Math.floor(count));
  if (value === 0) {
    return undefined;
  }
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

function buildColumns(items: WorkBoardItemView[], limit: number): WorkBoardColumnView[] {
  const specs: Array<{ id: WorkBoardColumnId; title: string }> = [
    { id: "backlog", title: "Backlog" },
    { id: "running", title: "Working" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
    { id: "blocked", title: "Needs" }
  ];
  return specs.map((spec) => {
    const matching = items.filter((item) => columnForStatus(item.status) === spec.id);
    return {
      ...spec,
      count: matching.length,
      items: matching.slice(0, limit)
    };
  });
}

function itemFromSession(session: WorkBoardSession, workers: WorkBoardWorker[]): WorkBoardItemView {
  const source = session.source;
  const owner = workers.find((worker) => worker.session_id === session.session_id)?.display_name;
  return {
    id: session.session_id,
    title: sourceLabel(source) ?? firstLine(session.objective, 80),
    status: session.status,
    subtitle: firstLine(session.objective, 96),
    owner,
    meta: [
      shortId(session.session_id),
      session.next_action ? "next action" : undefined,
      session.workspace_path ? shortPath(session.workspace_path) : undefined
    ].filter((value): value is string => Boolean(value)),
    tone: toneForStatus(session.status)
  };
}

function itemFromTask(task: WorkBoardTask, workers: WorkBoardWorker[]): WorkBoardItemView {
  const owner = workers.find((worker) => worker.session_id === task.session_id || worker.worker_id === task.task_id)?.display_name;
  return {
    id: task.task_id,
    title: task.title,
    status: task.status,
    subtitle: task.capability,
    owner,
    meta: [
      task.session_id ? shortId(task.session_id) : undefined,
      task.write_policy?.replace("_", "-"),
      task.file_scope.length ? `${task.file_scope.length} files` : undefined
    ].filter((value): value is string => Boolean(value)),
    tone: toneForStatus(task.status)
  };
}

function itemFromWorker(worker: WorkBoardWorker): WorkBoardItemView {
  return {
    id: worker.worker_id,
    title: worker.display_name,
    status: worker.status,
    subtitle: firstLine(worker.objective, 96),
    owner: worker.role_title ?? worker.agent_spec_id ?? worker.capability,
    meta: [
      worker.session_id ? shortId(worker.session_id) : undefined,
      worker.file_scope.length ? `${worker.file_scope.length} files` : undefined,
      worker.last_artifact ? "artifact" : undefined
    ].filter((value): value is string => Boolean(value)),
    tone: toneForStatus(worker.status)
  };
}

function selectThread(input: {
  selectedId?: string;
  columns: WorkBoardColumnView[];
  sessions: WorkBoardSession[];
  tasks: WorkBoardTask[];
  workers: WorkBoardWorker[];
  checks: WorkBoardCheck[];
  artifacts: WorkBoardArtifact[];
  changedFiles: string[];
  blackboard: BlackboardEntry[];
  recentMessages: Array<{ role: string; brief: string }>;
}): WorkBoardThreadView | undefined {
  const selectedId = input.selectedId ?? input.columns.flatMap((column) => column.items)[0]?.id;
  if (!selectedId) {
    return emptyThread(input);
  }
  const task = input.tasks.find((item) => item.task_id === selectedId);
  if (task) {
    return threadFromTask(task, input);
  }
  const session = input.sessions.find((item) => item.session_id === selectedId);
  if (session) {
    return threadFromSession(session, input);
  }
  const worker = input.workers.find((item) => item.worker_id === selectedId);
  if (worker) {
    return threadFromWorker(worker, input);
  }
  return emptyThread(input);
}

function threadFromSession(session: WorkBoardSession, input: Parameters<typeof selectThread>[0]): WorkBoardThreadView {
  const workers = input.workers.filter((worker) => worker.session_id === session.session_id);
  const checks = input.checks.filter((check) => check.session_id === session.session_id);
  const artifacts = input.artifacts.filter((artifact) => artifact.session_id === session.session_id);
  return {
    id: session.session_id,
    title: sourceLabel(session.source) ?? firstLine(session.objective, 80),
    status: session.status,
    objective: session.objective,
    assignee: workers[0]?.display_name,
    risk: workers.some((worker) => worker.write_policy === "workspace_write") ? "Med" : undefined,
    source: session.source?.source ?? "user",
    plan: [
      session.next_action
    ].filter((value): value is string => Boolean(value)),
    timeline: [
      ...workers.slice(0, 4).map((worker) => `${worker.display_name}: ${worker.status} · ${firstLine(worker.objective, 70)}`),
      ...artifacts.slice(0, 2).map((artifact) => `Output: ${shortPath(artifact.path)}`)
    ],
    changedFiles: input.changedFiles.slice(0, 5),
    checks: checks.map((check) => `${check.value} [${check.status}]`).slice(0, 5),
    comments: input.recentMessages.slice(-3).map((message) => `${message.role}: ${message.brief}`),
    actions: session.next_action ? [session.next_action] : [defaultActionForStatus(session.status)]
  };
}

function threadFromTask(task: WorkBoardTask, input: Parameters<typeof selectThread>[0]): WorkBoardThreadView {
  const workers = input.workers.filter((worker) => worker.session_id === task.session_id || worker.worker_id === task.task_id);
  const session = task.session_id ? input.sessions.find((item) => item.session_id === task.session_id) : undefined;
  const checks = input.checks.filter((check) => check.session_id === task.session_id);
  return {
    id: task.task_id,
    title: task.title,
    status: task.status,
    objective: session?.objective ?? task.title,
    assignee: workers[0]?.display_name ?? task.capability,
    risk: task.write_policy === "workspace_write" ? "Med" : task.write_policy === "read_only" ? "Low" : undefined,
    source: "task",
    plan: [
      session?.next_action,
      task.dependencies.length ? `Waiting on: ${dependencyLabels(task.dependencies, input.tasks).join(", ")}` : undefined,
      task.file_scope.length ? `Files: ${task.file_scope.slice(0, 3).map(shortPath).join(", ")}` : undefined,
      task.last_error,
    ].filter((value): value is string => Boolean(value)),
    timeline: workers.slice(0, 4).map((worker) => `${worker.display_name}: ${worker.status} · ${firstLine(worker.objective, 70)}`),
    changedFiles: task.file_scope.slice(0, 5),
    checks: checks.map((check) => `${check.value} [${check.status}]`).slice(0, 5),
    comments: input.recentMessages.slice(-3).map((message) => `${message.role}: ${message.brief}`),
    actions: task.recovery ? [task.recovery] : [defaultActionForStatus(task.status)]
  };
}

function threadFromWorker(worker: WorkBoardWorker, input: Parameters<typeof selectThread>[0]): WorkBoardThreadView {
  return {
    id: worker.worker_id,
    title: worker.display_name,
    status: worker.status,
    objective: worker.objective,
    assignee: worker.role_title ?? worker.agent_spec_id ?? worker.capability,
    risk: worker.write_policy === "workspace_write" ? "Med" : worker.write_policy === "read_only" ? "Low" : undefined,
    source: "worker",
    plan: [
      worker.recovery,
      worker.resume_command,
      worker.file_scope.length ? `Files: ${worker.file_scope.slice(0, 3).map(shortPath).join(", ")}` : undefined
    ].filter((value): value is string => Boolean(value)),
    timeline: [
      worker.last_artifact ? `Output: ${shortPath(worker.last_artifact)}` : undefined,
      worker.trajectory?.report ? firstLine(worker.trajectory.report, 88) : undefined
    ].filter((value): value is string => Boolean(value)),
    changedFiles: worker.trajectory?.changed_files.slice(0, 5) ?? worker.file_scope.slice(0, 5),
    checks: worker.trajectory?.checks.slice(0, 5) ?? [],
    comments: input.recentMessages.slice(-3).map((message) => `${message.role}: ${message.brief}`),
    actions: worker.recovery ? [worker.recovery] : [defaultActionForWorker(worker)]
  };
}

function dependencyLabels(dependencies: string[], tasks: WorkBoardTask[]): string[] {
  return dependencies.map((dependency) => {
    const task = tasks.find((item) => item.task_id === dependency);
    const title = firstLine(task?.title, 48);
    return title || shortId(dependency);
  });
}

function emptyThread(input: Pick<SelectWorkBoardSurfaceInput, "recentMessages">): WorkBoardThreadView {
  return {
    id: "new-task",
    title: "Start a task",
    status: "ready",
    objective: "Ask Swarm to review or plan this workspace.",
    source: "user",
    plan: [],
    timeline: [],
    changedFiles: [],
    checks: [],
    comments: input.recentMessages?.slice(-3).map((message) => `${message.role}: ${message.brief}`) ?? [],
    actions: ["Review this workspace", "Plan a change"]
  };
}

function columnForStatus(status: string): WorkBoardColumnId {
  const normalized = status.toLowerCase();
  if (["failed", "cancelled", "blocked", "stopped", "stale", "timeout", "conflict"].includes(normalized)) return "blocked";
  if (["completed", "complete", "success", "done"].includes(normalized)) return "done";
  if (["reviewing", "aggregating", "verifying", "review"].includes(normalized)) return "review";
  if (["running", "started", "processing", "planning", "created"].includes(normalized)) return "running";
  return "backlog";
}

function defaultActionForStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (["failed", "stopped", "cancelled", "timeout"].includes(normalized)) {
    return "Review output";
  }
  if (columnForStatus(status) === "blocked") {
    return "Resolve";
  }
  return "Continue";
}

function defaultActionForWorker(worker: WorkBoardWorker): string {
  if (worker.resume_command) {
    return "Continue";
  }
  if (["failed", "stopped", "cancelled", "timeout"].includes(worker.status.toLowerCase())) {
    return "Review output";
  }
  if (columnForStatus(worker.status) === "blocked") {
    return "Resolve";
  }
  return "Review result";
}

function toneForStatus(status: string): WorkBoardItemTone {
  const column = columnForStatus(status);
  if (column === "blocked") return status.toLowerCase() === "failed" ? "danger" : "warning";
  if (column === "done") return "success";
  if (column === "running" || column === "review") return "running";
  return "muted";
}

function isActiveStatus(status: string): boolean {
  return columnForStatus(status) === "running" || columnForStatus(status) === "review";
}

function enabledSkills(skills: SkillRecord[]): SkillRecord[] {
  return skills.filter((skill) => !skill.shadowedBy && skill.trust !== "disabled" && skill.trust !== "untrusted");
}

function dedupeItems(items: WorkBoardItemView[]): WorkBoardItemView[] {
  const seen = new Set<string>();
  const output: WorkBoardItemView[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    output.push(item);
  }
  return output;
}

function sourceLabel(source: WorkItem | undefined): string | undefined {
  return source?.human_id ?? source?.source_id ?? source?.external_id ?? source?.title;
}

function firstLine(value: string | undefined, maxLength: number): string {
  const line = (value ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line.length <= maxLength) {
    return line;
  }
  return `${line.slice(0, Math.max(0, maxLength - 3))}...`;
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function shortPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || normalized;
}
