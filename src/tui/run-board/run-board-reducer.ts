import type {
  AttentionItem,
  ResultPreview,
  RunBoardAction,
  RunBoardConfig,
  RunBoardEvidence,
  RunBoardState,
  RunBoardWorker
} from "./run-board-types.js";
import { derivedSlowAttentionItems } from "./run-board-derived-attention.js";

export const DEFAULT_RUN_BOARD_CONFIG: RunBoardConfig = {
  maxEvidence: 200,
  slowThresholdMs: 90_000
};

export function createInitialRunBoardState(input: {
  runId?: string;
  objective?: string;
  now?: string;
  config?: Partial<RunBoardConfig>;
} = {}): RunBoardState {
  const now = input.now ?? new Date().toISOString();
  return {
    runId: input.runId,
    objective: input.objective,
    phase: input.runId || input.objective ? "planning" : "idle",
    startedAt: input.runId || input.objective ? now : undefined,
    updatedAt: now,
    workersById: new Map(),
    evidenceById: new Map(),
    attentionById: new Map(),
    resultPreview: emptyResultPreview(),
    config: {
      ...DEFAULT_RUN_BOARD_CONFIG,
      ...input.config
    }
  };
}

export function runBoardReducer(previous: RunBoardState, action: RunBoardAction): RunBoardState {
  switch (action.type) {
    case "run/reset":
      return createInitialRunBoardState({
        runId: action.runId,
        objective: action.objective,
        now: action.at,
        config: previous.config
      });
    case "run/identity":
      return {
        ...previous,
        runId: action.runId ?? previous.runId,
        objective: action.objective ?? previous.objective,
        startedAt: previous.startedAt ?? action.at,
        updatedAt: action.at,
        phase: previous.phase === "idle" ? "planning" : previous.phase
      };
    case "run/phase":
      return {
        ...previous,
        phase: action.phase,
        updatedAt: action.at
      };
    case "worker/upsert":
      return upsertWorker(previous, action);
    case "evidence/append":
      return appendEvidence(previous, action.evidence);
    case "attention/upsert":
      return upsertAttention(previous, action);
    case "attention/resolve":
      return resolveAttention(previous, action);
    case "attention/archive-derived-slow":
      return archiveDerivedSlowAttention(previous, action);
    case "result/preview":
      return {
        ...previous,
        updatedAt: action.at,
        resultPreview: mergeResultPreview(previous.resultPreview, action.preview)
      };
    case "result/final":
      return {
        ...previous,
        updatedAt: action.at,
        phase: action.card.status === "failed" || action.card.status === "stopped" ? "failed" : "done",
        finalResult: action.card,
        resultPreview: mergeResultPreview(previous.resultPreview, {
          status: action.card.status === "failed" || action.card.status === "stopped" ? "failed" : "ready",
          summary: action.card.summary,
          changedFiles: action.card.changedFiles,
          checks: action.card.checks.map((check) => ({
            command: check.command,
            status: check.status === "passed" || check.status === "failed" || check.status === "skipped" ? check.status : "unknown"
          })),
          artifacts: action.card.artifacts,
          blockers: [
            ...previous.resultPreview.blockers,
            ...action.card.risks.map((risk) => risk.message)
          ],
          confidence: action.card.status === "completed" ? "high" : "medium",
          risks: action.card.risks.map((risk) => ({ level: risk.level, summary: risk.message })),
          nextActions: action.card.next
        })
      };
    default:
      return previous;
  }
}

export function reduceRunBoardActions(state: RunBoardState, actions: readonly RunBoardAction[]): RunBoardState {
  return actions.reduce(runBoardReducer, state);
}

function upsertWorker(previous: RunBoardState, action: Extract<RunBoardAction, { type: "worker/upsert" }>): RunBoardState {
  const patch = action.worker;
  const existing = previous.workersById.get(patch.id);
  const status = patch.status ?? existing?.status ?? "active";
  const worker: RunBoardWorker = {
    id: patch.id,
    label: patch.label ?? existing?.label ?? "Worker",
    role: patch.role ?? existing?.role ?? "custom",
    status,
    currentAction: patch.currentAction ?? existing?.currentAction ?? "working",
    statusChangedAt: existing && existing.status === status ? existing.statusChangedAt : action.at,
    updatedAt: action.at,
    waitingOn: patch.waitingOn ?? existing?.waitingOn,
    lastEvidenceId: patch.lastEvidenceId ?? existing?.lastEvidenceId,
    owns: patch.owns ?? existing?.owns ?? [],
    risk: patch.risk ?? existing?.risk ?? "low",
    canStop: patch.canStop ?? existing?.canStop ?? false,
    canRetry: patch.canRetry ?? existing?.canRetry ?? false,
    canTakeBack: patch.canTakeBack ?? existing?.canTakeBack ?? false,
    sourceIds: {
      ...existing?.sourceIds,
      ...patch.sourceIds
    }
  };
  const workersById = new Map(previous.workersById);
  workersById.set(worker.id, worker);
  return {
    ...previous,
    updatedAt: action.at,
    phase: phaseAfterWorkerUpdate(previous, worker),
    workersById
  };
}

function appendEvidence(previous: RunBoardState, evidence: RunBoardEvidence): RunBoardState {
  const evidenceById = new Map(previous.evidenceById);
  const existing = evidenceById.get(evidence.id);
  if (existing && sameEvidence(existing, evidence)) {
    return {
      ...previous,
      updatedAt: evidence.at
    };
  }
  evidenceById.set(evidence.id, evidence);
  const maxEvidence = Math.max(1, previous.config.maxEvidence);
  while (evidenceById.size > maxEvidence) {
    const oldest = [...evidenceById.values()].sort((left, right) => left.at.localeCompare(right.at))[0];
    if (!oldest) break;
    evidenceById.delete(oldest.id);
  }
  return {
    ...previous,
    updatedAt: evidence.at,
    evidenceById,
    resultPreview: previewAfterEvidence(previous.resultPreview, evidence)
  };
}

function sameEvidence(left: RunBoardEvidence, right: RunBoardEvidence): boolean {
  return left.kind === right.kind
    && left.summary === right.summary
    && left.workerId === right.workerId
    && left.workerLabel === right.workerLabel
    && left.taskId === right.taskId
    && left.command === right.command
    && left.file === right.file
    && left.status === right.status
    && left.source === right.source;
}

function upsertAttention(previous: RunBoardState, action: Extract<RunBoardAction, { type: "attention/upsert" }>): RunBoardState {
  const existing = previous.attentionById.get(action.item.id);
  const item: AttentionItem = {
    id: action.item.id,
    severity: action.item.severity,
    kind: action.item.kind,
    title: action.item.title,
    subjectWorkerId: action.item.subjectWorkerId ?? existing?.subjectWorkerId,
    summary: action.item.summary,
    evidenceIds: action.item.evidenceIds ?? existing?.evidenceIds ?? [],
    recommendation: action.item.recommendation,
    actions: action.item.actions ?? existing?.actions ?? [],
    createdAt: existing?.createdAt ?? action.at,
    updatedAt: action.at,
    resolvedAt: action.item.resolvedAt ?? existing?.resolvedAt,
    resolution: action.item.resolution ?? existing?.resolution
  };
  const attentionById = new Map(previous.attentionById);
  attentionById.set(item.id, item);
  return {
    ...previous,
    updatedAt: action.at,
    phase: item.resolvedAt ? previous.phase : "waiting-attention",
    attentionById,
    resultPreview: mergeResultPreview(previous.resultPreview, {
      status: item.severity === "failed" ? "failed" : "blocked",
      blockers: [
        ...previous.resultPreview.blockers,
        item.summary
      ],
      risks: [
        ...previous.resultPreview.risks,
        { level: item.severity === "failed" ? "high" : "medium", summary: item.summary }
      ]
    })
  };
}

function archiveDerivedSlowAttention(
  previous: RunBoardState,
  action: Extract<RunBoardAction, { type: "attention/archive-derived-slow" }>
): RunBoardState {
  const slowItems = derivedSlowAttentionItems(previous, {
    now: action.at,
    workerIds: action.workerIds
  });
  if (slowItems.length === 0) {
    return previous;
  }
  const attentionById = new Map(previous.attentionById);
  for (const slow of slowItems) {
    const existing = attentionById.get(slow.id);
    if (existing?.resolvedAt) {
      continue;
    }
    attentionById.set(slow.id, {
      ...existing,
      ...slow,
      evidenceIds: slow.evidenceIds.length ? slow.evidenceIds : existing?.evidenceIds ?? [],
      createdAt: existing?.createdAt ?? slow.createdAt,
      updatedAt: action.at,
      resolvedAt: action.at,
      resolution: action.resolution ?? "Worker produced new evidence after the slow period."
    });
  }
  return {
    ...previous,
    updatedAt: action.at,
    attentionById
  };
}

function resolveAttention(previous: RunBoardState, action: Extract<RunBoardAction, { type: "attention/resolve" }>): RunBoardState {
  const existing = previous.attentionById.get(action.id);
  if (!existing) {
    return previous;
  }
  const attentionById = new Map(previous.attentionById);
  attentionById.set(action.id, {
    ...existing,
    updatedAt: action.at,
    resolvedAt: action.at,
    resolution: action.resolution
  });
  return {
    ...previous,
    updatedAt: action.at,
    phase: hasOpenAttention(attentionById) ? previous.phase : "working",
    attentionById
  };
}

function phaseAfterWorkerUpdate(previous: RunBoardState, worker: RunBoardWorker): RunBoardState["phase"] {
  if (previous.phase === "done" || previous.phase === "failed") {
    return previous.phase;
  }
  if (worker.status === "failed") {
    return "waiting-attention";
  }
  if (worker.status === "blocked" || worker.status === "stuck") {
    return "waiting-attention";
  }
  if (worker.status === "active" || worker.status === "queued" || worker.status === "waiting") {
    return "working";
  }
  return previous.phase === "idle" ? "working" : previous.phase;
}

function hasOpenAttention(attentionById: Map<string, AttentionItem>): boolean {
  return [...attentionById.values()].some((item) => !item.resolvedAt);
}

function previewAfterEvidence(previous: ResultPreview, evidence: RunBoardEvidence): ResultPreview {
  const changedFiles = evidence.file ? unique([...previous.changedFiles, evidence.file]) : previous.changedFiles;
  const contributors = evidence.workerId && evidence.status && evidence.status !== "running" && evidence.status !== "pending"
    ? upsertContributor(previous.contributors, {
        workerId: evidence.workerId,
        label: evidence.workerLabel ?? labelFromWorkerId(evidence.workerId),
        contribution: evidence.summary
      })
    : previous.contributors;
  const checks = evidence.kind === "check" || evidence.command
    ? upsertCheck(previous.checks, {
        command: evidence.command ?? evidence.summary,
        status: evidence.status === "success"
          ? "passed"
          : evidence.status === "failed"
            ? "failed"
            : evidence.status === "running"
              ? "running"
              : "unknown"
      })
    : previous.checks;
  const artifacts = evidence.kind === "artifact" ? unique([...previous.artifacts, evidence.summary]) : previous.artifacts;
  return mergeResultPreview(previous, {
    status: previous.status === "empty" ? "pending" : previous.status,
    summary: evidence.summary || previous.summary,
    changedFiles,
    checks,
    artifacts,
    contributors
  });
}

export function emptyResultPreview(): ResultPreview {
  return {
    status: "empty",
    summary: "Ask Swarm to review or plan this workspace.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    blockers: [],
    confidence: "low",
    contributors: [],
    risks: [],
    nextActions: []
  };
}

function mergeResultPreview(previous: ResultPreview, patch: Partial<ResultPreview>): ResultPreview {
  return {
    ...previous,
    ...patch,
    changedFiles: patch.changedFiles ? unique(patch.changedFiles) : previous.changedFiles,
    checks: patch.checks ?? previous.checks,
    artifacts: patch.artifacts ? unique(patch.artifacts) : previous.artifacts,
    blockers: patch.blockers ? unique(patch.blockers) : previous.blockers,
    contributors: patch.contributors ?? previous.contributors,
    risks: patch.risks ? dedupeRisks(patch.risks) : previous.risks,
    nextActions: patch.nextActions ? unique(patch.nextActions) : previous.nextActions
  };
}

function upsertCheck(
  checks: ResultPreview["checks"],
  next: ResultPreview["checks"][number]
): ResultPreview["checks"] {
  const byCommand = new Map(checks.map((check) => [check.command, check]));
  byCommand.set(next.command, next);
  return [...byCommand.values()];
}

function upsertContributor(
  contributors: ResultPreview["contributors"],
  next: ResultPreview["contributors"][number]
): ResultPreview["contributors"] {
  const byWorker = new Map(contributors.map((contributor) => [contributor.workerId, contributor]));
  byWorker.set(next.workerId, next);
  return [...byWorker.values()];
}

function labelFromWorkerId(workerId: string): string {
  const compact = workerId.replace(/^worker:/u, "").replace(/[_-]+/g, " ").trim();
  if (!compact) return "Worker";
  return compact
    .split(" ")
    .slice(0, 3)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeRisks(risks: ResultPreview["risks"]): ResultPreview["risks"] {
  const seen = new Set<string>();
  return risks.filter((risk) => {
    const key = `${risk.level}:${risk.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
