import type {
  AttentionItem,
  AttentionItemView,
  RunBoardState,
  RunBoardSurfaceView,
  WorkerBoardRow,
  WorkerBoardStatus
} from "./run-board-types.js";
import { derivedSlowAttentionItems } from "./run-board-derived-attention.js";

export function selectRunBoardSurface(state: RunBoardState, input: {
  now?: string;
  repo?: string;
  mode?: string;
  risk?: string;
  session?: string;
} = {}): RunBoardSurfaceView {
  const resultRisk = state.finalResult?.risks?.[0]?.level;
  return {
    title: "Swarm Board",
    objective: state.objective,
    phase: selectRunBoardPhase(state, input),
    focus: selectRunBoardFocus(state, input),
    meta: {
      repo: input.repo,
      mode: input.mode,
      risk: input.risk ?? resultRisk ?? selectHighestWorkerRisk(state),
      session: input.session ?? state.runId
    },
    workers: selectWorkerRows(state, input),
    attention: selectAttentionItems(state, input),
    resultPreview: state.resultPreview,
    finalResult: state.finalResult
  };
}

export function selectWorkerRows(state: RunBoardState, input: { now?: string } = {}): WorkerBoardRow[] {
  const nowMs = Date.parse(input.now ?? state.config.now ?? new Date().toISOString());
  return [...state.workersById.values()]
    .map((worker): WorkerBoardRow => {
      const evidence = worker.lastEvidenceId ? state.evidenceById.get(worker.lastEvidenceId) : undefined;
      return {
        id: worker.id,
        label: worker.label,
        role: worker.role,
        status: worker.status,
        currentAction: worker.currentAction,
        waitingOn: worker.waitingOn,
        lastEvidence: evidence?.summary,
        elapsedMs: Math.max(0, nowMs - Date.parse(worker.statusChangedAt)),
        owns: worker.owns,
        risk: worker.risk,
        canStop: worker.canStop,
        canRetry: worker.canRetry,
        canTakeBack: worker.canTakeBack
      };
    })
    .sort(compareWorkerRows);
}

export function selectAttentionItems(state: RunBoardState, input: { now?: string } = {}): AttentionItemView[] {
  return [...state.attentionById.values(), ...derivedSlowAttentionItems(state, input)]
    .filter((item) => !item.resolvedAt)
    .sort(compareAttentionItems)
    .map((item) => ({
      ...item,
      evidence: item.evidenceIds
        .map((id) => state.evidenceById.get(id)?.summary)
        .filter((value): value is string => Boolean(value))
    }));
}

export function selectAttentionHistory(state: RunBoardState): AttentionItemView[] {
  return [...state.attentionById.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((item) => ({
      ...item,
      evidence: item.evidenceIds
        .map((id) => state.evidenceById.get(id)?.summary)
        .filter((value): value is string => Boolean(value))
    }));
}

export function selectRunBoardPhase(state: RunBoardState, input: { now?: string } = {}): RunBoardState["phase"] {
  if (state.phase === "done" || state.phase === "failed" || state.phase === "idle") {
    return state.phase;
  }
  return selectAttentionItems(state, input).length ? "waiting-attention" : state.phase;
}

export function selectDebugRefsForRow(state: RunBoardState, rowId: string): string[] {
  const worker = state.workersById.get(rowId);
  if (!worker) return [];
  return [
    worker.sourceIds.workerId ? `worker:${worker.sourceIds.workerId}` : undefined,
    worker.sourceIds.taskId ? `task:${worker.sourceIds.taskId}` : undefined,
    worker.sourceIds.handoffId ? `handoff:${worker.sourceIds.handoffId}` : undefined,
    worker.sourceIds.sessionId ? `session:${worker.sourceIds.sessionId}` : undefined,
    worker.lastEvidenceId ? `evidence:${worker.lastEvidenceId}` : undefined
  ].filter((value): value is string => Boolean(value));
}

export function summarizeRunBoardCounts(state: RunBoardState, input: { now?: string } = {}): {
  workers: number;
  blocked: number;
  stuck: number;
  files: number;
  checks: number;
  passedChecks: number;
  approvals: number;
} {
  const attention = selectAttentionItems(state, input);
  return {
    workers: state.workersById.size,
    blocked: [...state.workersById.values()].filter((worker) => worker.status === "blocked" || worker.status === "waiting").length,
    stuck: [...state.workersById.values()].filter((worker) => worker.status === "stuck").length + attention.filter((item) => item.kind === "slow").length,
    files: state.resultPreview.changedFiles.length,
    checks: state.resultPreview.checks.length,
    passedChecks: state.resultPreview.checks.filter((check) => check.status === "passed").length,
    approvals: attention.filter((item) => item.kind === "approval").length
  };
}

function compareWorkerRows(left: WorkerBoardRow, right: WorkerBoardRow): number {
  const statusRank = workerStatusRank(left.status) - workerStatusRank(right.status);
  if (statusRank !== 0) return statusRank;
  const roleRank = roleRankFor(left.role) - roleRankFor(right.role);
  if (roleRank !== 0) return roleRank;
  return left.label.localeCompare(right.label);
}

function workerStatusRank(status: WorkerBoardStatus): number {
  switch (status) {
    case "failed": return 0;
    case "stuck": return 1;
    case "blocked": return 2;
    case "active": return 3;
    case "waiting": return 4;
    case "queued": return 5;
    case "done": return 6;
  }
}

function roleRankFor(role: WorkerBoardRow["role"]): number {
  switch (role) {
    case "main": return 0;
    case "code": return 1;
    case "test": return 2;
    case "review": return 3;
    case "research": return 4;
    case "memory": return 5;
    case "custom": return 6;
  }
}

function selectRunBoardFocus(state: RunBoardState, input: { now?: string } = {}): string | undefined {
  const attention = selectAttentionItems(state, input);
  const subjectWorkerId = attention[0]?.subjectWorkerId;
  if (subjectWorkerId) {
    return state.workersById.get(subjectWorkerId)?.label ?? attention[0]?.title;
  }
  if (attention[0]) {
    return attention[0].title;
  }
  const activeWorker = [...state.workersById.values()]
    .sort((left, right) => roleRankFor(left.role) - roleRankFor(right.role))
    .find((worker) => worker.status === "active" || worker.status === "blocked" || worker.status === "stuck");
  if (activeWorker) {
    return activeWorker.currentAction;
  }
  return state.resultPreview.hypothesis ?? state.resultPreview.summary;
}

function selectHighestWorkerRisk(state: RunBoardState): string | undefined {
  const risks = [...state.workersById.values()].map((worker) => worker.risk);
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  if (risks.includes("low")) return "low";
  return undefined;
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  const severityRank = attentionSeverityRank(left.severity) - attentionSeverityRank(right.severity);
  if (severityRank !== 0) return severityRank;
  const kindRank = attentionKindRank(left.kind) - attentionKindRank(right.kind);
  if (kindRank !== 0) return kindRank;
  return left.createdAt.localeCompare(right.createdAt);
}

function attentionSeverityRank(severity: AttentionItem["severity"]): number {
  switch (severity) {
    case "failed": return 0;
    case "blocking": return 1;
    case "warning": return 2;
    case "info": return 3;
  }
}

function attentionKindRank(kind: AttentionItem["kind"]): number {
  switch (kind) {
    case "failed": return 0;
    case "approval": return 1;
    case "conflicted": return 2;
    case "blocked": return 3;
    case "slow": return 4;
    case "uncertain": return 5;
  }
}
