import type { ResultCard } from "../../runtime/result-card.js";

export type RunBoardPhase =
  | "idle"
  | "planning"
  | "working"
  | "reviewing"
  | "waiting-attention"
  | "verifying"
  | "done"
  | "failed";

export type WorkerBoardRole = "main" | "code" | "test" | "review" | "research" | "memory" | "custom";

export type WorkerBoardStatus = "queued" | "active" | "waiting" | "blocked" | "stuck" | "done" | "failed";

export type RunBoardRisk = "low" | "medium" | "high";

export type AttentionKind = "slow" | "blocked" | "conflicted" | "uncertain" | "failed" | "approval";

export type AttentionSeverity = "info" | "warning" | "blocking" | "failed";

export type AttentionAction = {
  key: string;
  label: string;
  command?: string;
  enabled?: boolean;
};

export type RunBoardEvidenceKind =
  | "action"
  | "approval"
  | "artifact"
  | "check"
  | "command"
  | "file"
  | "handoff"
  | "review"
  | "summary"
  | "tool"
  | "worker";

export type RunBoardEvidence = {
  id: string;
  kind: RunBoardEvidenceKind;
  summary: string;
  at: string;
  workerId?: string;
  workerLabel?: string;
  taskId?: string;
  command?: string;
  file?: string;
  status?: "success" | "partial" | "failed" | "running" | "pending" | "skipped" | "unknown";
  source?: string;
};

export type RunBoardWorker = {
  id: string;
  label: string;
  role: WorkerBoardRole;
  status: WorkerBoardStatus;
  currentAction: string;
  statusChangedAt: string;
  updatedAt: string;
  waitingOn?: string;
  lastEvidenceId?: string;
  owns: string[];
  risk: RunBoardRisk;
  canStop: boolean;
  canRetry: boolean;
  canTakeBack: boolean;
  sourceIds: {
    workerId?: string;
    taskId?: string;
    handoffId?: string;
    agentSpecId?: string;
    sessionId?: string;
  };
};

export type WorkerBoardRow = {
  id: string;
  label: string;
  role: WorkerBoardRole;
  status: WorkerBoardStatus;
  currentAction: string;
  waitingOn?: string;
  lastEvidence?: string;
  elapsedMs: number;
  owns: string[];
  risk: RunBoardRisk;
  canStop: boolean;
  canRetry: boolean;
  canTakeBack: boolean;
};

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  kind: AttentionKind;
  title: string;
  subjectWorkerId?: string;
  summary: string;
  evidenceIds: string[];
  recommendation: string;
  actions: AttentionAction[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolution?: string;
};

export type AttentionItemView = Omit<AttentionItem, "evidenceIds"> & {
  evidence: string[];
};

export type ResultPreview = {
  status: "empty" | "pending" | "blocked" | "ready" | "failed";
  summary: string;
  hypothesis?: string;
  changedFiles: string[];
  checks: Array<{ command: string; status: "passed" | "failed" | "skipped" | "running" | "unknown" }>;
  artifacts: string[];
  blockers: string[];
  confidence: "low" | "medium" | "high";
  contributors: Array<{ workerId: string; label: string; contribution: string }>;
  risks: Array<{ level: RunBoardRisk; summary: string }>;
  nextActions: string[];
};

export type RunBoardConfig = {
  maxEvidence: number;
  slowThresholdMs: number;
  now?: string;
};

export type RunBoardState = {
  runId?: string;
  objective?: string;
  phase: RunBoardPhase;
  startedAt?: string;
  updatedAt?: string;
  workersById: Map<string, RunBoardWorker>;
  evidenceById: Map<string, RunBoardEvidence>;
  attentionById: Map<string, AttentionItem>;
  resultPreview: ResultPreview;
  finalResult?: ResultCard;
  config: RunBoardConfig;
};

export type RunBoardAction =
  | { type: "run/reset"; runId?: string; objective?: string; at: string }
  | { type: "run/identity"; runId?: string; objective?: string; at: string }
  | { type: "run/phase"; phase: RunBoardPhase; at: string }
  | { type: "worker/upsert"; worker: RunBoardWorkerPatch; at: string }
  | { type: "evidence/append"; evidence: RunBoardEvidence }
  | { type: "attention/upsert"; item: AttentionItemPatch; at: string }
  | { type: "attention/resolve"; id: string; at: string; resolution?: string }
  | { type: "attention/materialize-slow"; at: string; workerIds?: string[]; resolution?: string }
  | { type: "result/preview"; preview: Partial<ResultPreview>; at: string }
  | { type: "result/final"; card: ResultCard; at: string };

export type RunBoardWorkerPatch = {
  id: string;
  label?: string;
  role?: WorkerBoardRole;
  status?: WorkerBoardStatus;
  currentAction?: string;
  waitingOn?: string;
  lastEvidenceId?: string;
  owns?: string[];
  risk?: RunBoardRisk;
  canStop?: boolean;
  canRetry?: boolean;
  canTakeBack?: boolean;
  sourceIds?: Partial<RunBoardWorker["sourceIds"]>;
};

export type AttentionItemPatch = {
  id: string;
  severity: AttentionSeverity;
  kind: AttentionKind;
  title: string;
  subjectWorkerId?: string;
  summary: string;
  evidenceIds?: string[];
  recommendation: string;
  actions?: AttentionAction[];
  resolvedAt?: string;
  resolution?: string;
};

export type RunBoardSurfaceView = {
  title: string;
  objective?: string;
  phase: RunBoardPhase;
  focus?: string;
  meta?: {
    repo?: string;
    mode?: string;
    risk?: RunBoardRisk | string;
    session?: string;
  };
  workers: WorkerBoardRow[];
  attention: AttentionItemView[];
  resultPreview: ResultPreview;
  finalResult?: ResultCard;
};

export type RunBoardResultAction = {
  command: string;
  label: string;
  source: "preview" | "final";
};
