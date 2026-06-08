import type { ExecutionResult } from "./orchestrator.js";
import type { WorkSnapshot } from "../protocol/types.js";
import type { ResultCardPromptCacheStatus } from "./prompt-cache-status.js";
import { buildPromptCacheRoi, formatPromptCacheInline, promptCacheTrendFromResultCardCache } from "./prompt-cache-status.js";
import type { RecoveryAdvice } from "./recovery.js";
import {
  formatRecoveryAdviceInline,
  recoveryAdviceFromCacheStatus,
  recoveryAdviceFromSuggestion
} from "./recovery.js";

export type ResultCardRoute = "ask" | "work" | "team" | "daemon";

export type ResultCard = {
  sessionId: string;
  status: "completed" | "failed" | "stopped";
  route: ResultCardRoute;
  summary: string;
  changedFiles: string[];
  checks: Array<{
    command: string;
    status: "passed" | "failed" | "skipped" | "unknown";
  }>;
  review: {
    status: "passed" | "warning" | "failed" | "skipped";
    summary: string;
  };
  risks: Array<{
    level: "low" | "medium" | "high";
    message: string;
  }>;
  recovery?: RecoveryAdvice[];
  reviewFindings?: ReviewFinding[];
  artifacts: string[];
  next: string[];
  memory?: {
    entries: number;
    compactions: number;
    latestCompactionId?: string;
  };
  contracts?: {
    tasks: {
      total: number;
      pending: number;
      running: number;
      blocked: number;
      failed: number;
      readOnly: number;
      scopedWrite: number;
      workspaceWrite: number;
      scopedTargets: string[];
    };
    work: {
      activeWorkers: number;
      runningWorkers: number;
      pendingWorkers: number;
      resumableWorkers: number;
      activeHandoffs: number;
      readOnly: number;
      scopedWrite: number;
      workspaceWrite: number;
      scopedTargets: string[];
    };
    activeWorkers: string[];
    resumableWorkers: string[];
    activeHandoffs: string[];
  };
  checkpoint?: {
    id: string;
    name: string;
    mode: "git" | "snapshot";
    revertAvailable: boolean;
  };
  cache?: ResultCardPromptCacheStatus;
  decisionTrail?: DecisionTrail;
};

export type ReviewFinding = {
  severity: "low" | "medium" | "high";
  title: string;
  file?: string;
  line?: number;
  recommendation?: string;
  confidence?: "low" | "medium" | "high";
  evidence?: string[];
};

export type DecisionTrail = {
  split?: string[];
  assign?: string[];
  verify?: string[];
  decide?: string[];
  risk?: string[];
};

export type ResultCardInput = {
  result: Pick<ExecutionResult, "session_id" | "content" | "outcome" | "artifact_path" | "status">;
  route?: string;
  snapshot?: WorkSnapshot;
  checkpoint?: {
    id: string;
    name: string;
    mode: "git" | "snapshot";
    revertAvailable: boolean;
  };
  cache?: ResultCardPromptCacheStatus;
  recovery?: RecoveryAdvice[];
};

export function buildResultCard(input: ResultCardInput): ResultCard {
  const snapshot = input.snapshot;
  const changedFiles = uniqueStrings([
    ...(snapshot?.changed_files ?? []),
    ...(input.result.outcome?.changed_files ?? [])
  ]);
  const checks = uniqueStrings([
    ...(snapshot?.checks ?? []),
    ...(input.result.outcome?.tests_run ?? [])
  ]).map((command) => ({
    command,
    status: inferCheckStatus(command)
  }));
  const reviewSummary = snapshot?.review
    ? `${snapshot.review.verdict} ${snapshot.review.score} - ${snapshot.review.summary}`
    : snapshot?.final_outcome?.final_summary
      ? snapshot.final_outcome.final_summary
      : "not recorded";
  const summary = firstLine(input.result.outcome?.final_summary ?? snapshot?.final_outcome?.final_summary ?? input.result.content, 220)
    || "Swarm output";
  return {
    sessionId: input.result.session_id,
    status: input.result.status ?? (snapshot?.session.status === "failed" ? "failed" : snapshot?.session.status === "cancelled" ? "stopped" : "completed"),
    route: normalizeRoute(input.route),
    summary,
    changedFiles,
    checks,
    review: {
      status: reviewStatus(snapshot?.review),
      summary: reviewSummary
    },
    risks: buildRisks(snapshot, input.result),
    recovery: buildRecoveryAdvice(input.result, snapshot, input.cache, input.recovery),
    reviewFindings: buildReviewFindings(snapshot),
    artifacts: uniqueStrings([
      ...(snapshot?.verification && typeof snapshot.verification === "object" && "worker_id" in snapshot.verification && typeof (snapshot.verification as { worker_id?: unknown }).worker_id === "string"
        ? [(snapshot.verification as { worker_id?: string }).worker_id as string]
        : []),
      ...(input.result.outcome?.intermediate_artifacts ?? []),
      ...(input.result.artifact_path ? [input.result.artifact_path] : [])
    ]),
    next: buildNextActions(input.result, snapshot),
    memory: snapshot?.context_summary
      ? {
          entries: snapshot.context_summary.entries,
          compactions: snapshot.context_summary.compactions,
          latestCompactionId: snapshot.context_summary.latest_compaction?.compaction_id
        }
      : undefined,
    contracts: snapshot ? buildContractCard(snapshot) : undefined,
    checkpoint: input.checkpoint,
    cache: input.cache,
    decisionTrail: buildDecisionTrail(snapshot, input.result)
  };
}

function reviewStatus(review: WorkSnapshot["review"] | undefined): ResultCard["review"]["status"] {
  if (!review) {
    return "skipped";
  }
  if (review.verdict === "reject") {
    return "failed";
  }
  if (review.verdict === "needs_revision" || review.score < 90 || Boolean(review.issues?.length)) {
    return "warning";
  }
  return "passed";
}

export function buildResultCardFromSnapshot(snapshot: WorkSnapshot, route?: string): ResultCard {
  return buildResultCard({
    result: {
      session_id: snapshot.session.session_id,
      content: snapshot.final_outcome?.final_summary ?? snapshot.session.objective,
      outcome: snapshot.final_outcome,
      status: snapshot.session.status === "failed" ? "failed" : snapshot.session.status === "cancelled" ? "stopped" : "completed",
      artifact_path: undefined
    },
    route,
    snapshot
  });
}

export function formatResultCardText(card: ResultCard): string {
  const lines = [
    "Result",
    `${card.sessionId} [${card.status}] ${card.route}`,
    `Summary: ${card.summary}`,
    "",
    `Changed (${card.changedFiles.length})`,
    ...formatList(card.changedFiles),
    "",
    `Checks (${card.checks.length})`,
    ...formatList(card.checks.length ? card.checks.map((check) => `${check.command} [${check.status}]`) : [], "(none)"),
    "",
    `Review: ${card.review.status} - ${card.review.summary}`,
    "",
    `Risks (${card.risks.length})`,
    ...formatList(card.risks.map((risk) => `${risk.level}: ${risk.message}`), "(none)"),
    "",
    `Recovery (${card.recovery?.length ?? 0})`,
    ...formatList((card.recovery ?? []).map(formatRecoveryAdviceInline), "(none)"),
    "",
    `Findings (${card.reviewFindings?.length ?? 0})`,
    ...formatReviewFindingLines(card.reviewFindings),
    "",
    `Artifacts (${card.artifacts.length})`,
    ...formatList(card.artifacts),
    "",
    "Memory Freshness",
    card.memory
      ? `  entries=${card.memory.entries} compactions=${card.memory.compactions}${card.memory.latestCompactionId ? ` latest=${card.memory.latestCompactionId}` : ""}. Resume refreshes workspace facts before trusting memory.`
      : "  No saved session memory yet.",
    "",
    ...formatContractLines(card),
    "",
    `Next (${card.next.length})`,
    ...formatList(card.next),
  ];
  const decisionTrail = formatDecisionTrailText(card.decisionTrail);
  if (decisionTrail.length) {
    lines.push("", "Decision Trail", ...decisionTrail);
  }
  if (card.checkpoint) {
    lines.push(
      "",
      `Checkpoint: ${card.checkpoint.name} [${card.checkpoint.mode}] ${card.checkpoint.revertAvailable ? "revert available" : "revert unavailable"}`
    );
  }
  if (card.cache) {
    const roi = buildPromptCacheRoi(promptCacheTrendFromResultCardCache(card.cache));
    lines.push("", `Cache: ${formatPromptCacheInline(card.cache)?.replace(/^cache:/, "") ?? card.cache.status}${roi ? ` | ROI ${roi.saved_tokens}t${typeof roi.stable_prefix_ratio === "number" ? ` ${Math.round(roi.stable_prefix_ratio * 100)}% stable` : ""}` : ""}`);
  }
  return lines.join("\n");
}

function buildDecisionTrail(snapshot: WorkSnapshot | undefined, result: ResultCardInput["result"]): DecisionTrail | undefined {
  const trail: DecisionTrail = {};
  if (snapshot?.session.objective) {
    trail.split = [`Objective adopted: ${firstLine(snapshot.session.objective, 160)}`];
  }
  const activeWorkers = snapshot?.work_contracts.active_workers.map((worker) => `${worker.worker_id} owns ${formatDecisionTrailWorkerScope(worker)}`) ?? [];
  const resumableWorkers = snapshot?.work_contracts.resumable_workers.map((worker) => `${worker.worker_id} resumable ${formatDecisionTrailWorkerScope(worker)}`) ?? [];
  if (activeWorkers.length || resumableWorkers.length) {
    trail.assign = uniqueStrings([...activeWorkers, ...resumableWorkers]).slice(0, 5);
  }
  const checks = [
    ...(snapshot?.checks ?? []),
    ...(result.outcome?.tests_run ?? [])
  ];
  if (checks.length) {
    trail.verify = uniqueStrings(checks).slice(0, 5);
  } else if (snapshot?.verification) {
    trail.verify = [typeof snapshot.verification === "string" ? firstLine(snapshot.verification, 160) : "Verification evidence recorded"];
  }
  if (snapshot?.review) {
    trail.decide = [`Review ${snapshot.review.verdict} score=${snapshot.review.score}: ${firstLine(snapshot.review.summary, 160)}`];
  } else if (snapshot?.final_outcome?.final_summary ?? result.outcome?.final_summary) {
    trail.decide = [firstLine(snapshot?.final_outcome?.final_summary ?? result.outcome?.final_summary ?? "", 160)];
  }
  const risks = buildRisks(snapshot, result);
  if (risks.length) {
    trail.risk = risks.map((risk) => `${risk.level}: ${risk.message}`);
  }
  return Object.values(trail).some((items) => (items?.length ?? 0) > 0) ? trail : undefined;
}

function buildReviewFindings(snapshot: WorkSnapshot | undefined): ReviewFinding[] | undefined {
  const issues = snapshot?.review?.issues ?? [];
  if (!issues.length) {
    return undefined;
  }
  return issues.slice(0, 8).map((issue) => {
    const location = parseEvidenceLocation(issue.evidence);
    return {
      severity: issue.severity,
      title: issue.message,
      file: location.file,
      line: location.line,
      recommendation: issue.suggested_fix,
      confidence: snapshot?.review && snapshot.review.score >= 90
        ? "high"
        : snapshot?.review && snapshot.review.score >= 70 ? "medium" : "low",
      evidence: issue.evidence ? [issue.evidence] : undefined
    };
  });
}

function formatReviewFindingLines(findings: ReviewFinding[] | undefined): string[] {
  if (!findings?.length) {
    return ["  (none)"];
  }
  return findings.slice(0, 8).map((finding) => {
    const location = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
    const confidence = finding.confidence ? ` confidence=${finding.confidence}` : "";
    const recommendation = finding.recommendation ? ` fix=${finding.recommendation}` : "";
    return `  - ${finding.severity}:${location} ${firstLine(finding.title, 120)}${confidence}${recommendation}`;
  });
}

function parseEvidenceLocation(evidence: string | undefined): { file?: string; line?: number } {
  if (!evidence) {
    return {};
  }
  const match = /(?<file>[\w./\\-]+\.[A-Za-z0-9]+)(?::(?<line>\d+))?/.exec(evidence);
  const file = match?.groups?.file;
  const lineText = match?.groups?.line;
  return {
    file,
    line: lineText ? Number.parseInt(lineText, 10) : undefined
  };
}

function formatDecisionTrailWorkerScope(worker: WorkSnapshot["work_contracts"]["active_workers"][number]): string {
  return worker.role_title ?? worker.capability ?? firstLine(worker.objective, 80) ?? "work";
}

function formatDecisionTrailText(trail: DecisionTrail | undefined): string[] {
  if (!trail) {
    return [];
  }
  return (["split", "assign", "verify", "decide", "risk"] as const).flatMap((section) => {
    const items = trail[section] ?? [];
    if (!items.length) {
      return [];
    }
    return [
      `  ${section}:`,
      ...items.map((item) => `    - ${item}`)
    ];
  });
}

function buildContractCard(snapshot: WorkSnapshot): NonNullable<ResultCard["contracts"]> {
  const taskSummary = snapshot.task_contracts.summary;
  const workSummary = snapshot.work_contracts.summary;
  return {
    tasks: {
      total: taskSummary.total,
      pending: taskSummary.pending,
      running: taskSummary.running,
      blocked: taskSummary.blocked,
      failed: taskSummary.failed,
      readOnly: taskSummary.read_only,
      scopedWrite: taskSummary.scoped_write,
      workspaceWrite: taskSummary.workspace_write,
      scopedTargets: taskSummary.scoped_targets
    },
    work: {
      activeWorkers: workSummary.active_workers,
      runningWorkers: workSummary.running_workers,
      pendingWorkers: workSummary.pending_workers,
      resumableWorkers: workSummary.resumable_workers,
      activeHandoffs: workSummary.active_handoffs,
      readOnly: workSummary.read_only,
      scopedWrite: workSummary.scoped_write,
      workspaceWrite: workSummary.workspace_write,
      scopedTargets: workSummary.scoped_targets
    },
    activeWorkers: snapshot.work_contracts.active_workers.map(formatWorkerContractLine),
    resumableWorkers: snapshot.work_contracts.resumable_workers.map(formatWorkerContractLine),
    activeHandoffs: snapshot.work_contracts.active_handoffs.map(formatHandoffContractLine)
  };
}

function formatContractLines(card: ResultCard): string[] {
  if (!card.contracts) {
    return ["Contracts", "  (no work contracts recorded)"];
  }
  const tasks = card.contracts.tasks;
  const work = card.contracts.work;
  const taskScope = tasks.scopedTargets.length ? ` scope=${truncateJoin(tasks.scopedTargets)}` : "";
  const workScope = work.scopedTargets.length ? ` scope=${truncateJoin(work.scopedTargets)}` : "";
  return [
    "Contracts",
    `  tasks total=${tasks.total} pending=${tasks.pending} running=${tasks.running} blocked=${tasks.blocked} failed=${tasks.failed} policies ro=${tasks.readOnly} scoped=${tasks.scopedWrite} workspace=${tasks.workspaceWrite}${taskScope}`,
    `  work active=${work.activeWorkers} running=${work.runningWorkers} pending=${work.pendingWorkers} resumable=${work.resumableWorkers} handoffs=${work.activeHandoffs} policies ro=${work.readOnly} scoped=${work.scopedWrite} workspace=${work.workspaceWrite}${workScope}`,
    ...formatContractPreview("active workers", card.contracts.activeWorkers),
    ...formatContractPreview("resumable workers", card.contracts.resumableWorkers),
    ...formatContractPreview("active handoffs", card.contracts.activeHandoffs)
  ];
}

function formatContractPreview(label: string, rows: string[]): string[] {
  if (!rows.length) {
    return [];
  }
  return [
    `  ${label}`,
    ...rows.slice(0, 3).map((row) => `    - ${firstLine(row, 180)}`),
    ...(rows.length > 3 ? [`    ... ${rows.length - 3} more`] : [])
  ];
}

function formatWorkerContractLine(worker: WorkSnapshot["work_contracts"]["active_workers"][number]): string {
  return [
    `${worker.worker_id} [${worker.status}]`,
    worker.agent_spec_id ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}` : worker.capability,
    worker.write_policy ? `policy=${worker.write_policy}` : undefined,
    worker.file_scope.length ? `scope=${truncateJoin(worker.file_scope)}` : undefined,
    worker.blocked_reason ? `blocked=${worker.blocked_reason}` : undefined
  ].filter(Boolean).join(" ");
}

function formatHandoffContractLine(handoff: WorkSnapshot["work_contracts"]["active_handoffs"][number]): string {
  return [
    `${handoff.handoff_id} [${handoff.status}]`,
    `worker=${handoff.worker_id}`,
    `-> ${handoff.target_agent_spec_id}`,
    `policy=${handoff.write_policy}`,
    handoff.file_scope.length ? `scope=${truncateJoin(handoff.file_scope)}` : undefined
  ].filter(Boolean).join(" ");
}

function truncateJoin(values: string[], limit = 3): string {
  const visible = values.slice(0, limit).join(",");
  const remaining = values.length - limit;
  return remaining > 0 ? `${visible},+${remaining} more` : visible;
}

function normalizeRoute(route?: string): ResultCardRoute {
  if (route === "ask" || route === "work" || route === "team" || route === "daemon") {
    return route;
  }
  if (route === "chat") {
    return "ask";
  }
  if (route === "full_swarm") {
    return "team";
  }
  if (route === "coding_loop") {
    return "work";
  }
  return "work";
}

function buildRisks(snapshot: WorkSnapshot | undefined, result: Pick<ExecutionResult, "content" | "outcome" | "artifact_path" | "status">): ResultCard["risks"] {
  const risks: ResultCard["risks"] = [];
  const checkTexts = uniqueStrings([
    ...(snapshot?.checks ?? []),
    ...(result.outcome?.tests_run ?? [])
  ]);
  if (result.status === "failed") {
    risks.push({ level: "high", message: "Run ended in failure." });
  }
  if (result.status === "stopped") {
    risks.push({ level: "medium", message: "Run was stopped before completion." });
  }
  if (!result.outcome?.tests_run.length && !snapshot?.checks.length) {
    risks.push({ level: "medium", message: "No verification command was recorded." });
  }
  if (checkTexts.some((check) => inferCheckStatus(check) === "failed")) {
    risks.push({ level: "high", message: "At least one recorded verification check failed." });
  }
  if (!snapshot?.changed_files.length && result.outcome?.changed_files.length) {
    risks.push({ level: "low", message: "Changes were recorded but the snapshot has not caught up yet." });
  }
  if (snapshot?.review && reviewStatus(snapshot.review) === "warning") {
    risks.push({ level: "medium", message: "Reviewer reported findings or reduced confidence; inspect review details before trusting the result." });
  }
  return risks;
}

function buildNextActions(result: Pick<ExecutionResult, "content" | "outcome" | "artifact_path" | "status">, snapshot?: WorkSnapshot): string[] {
  const next: string[] = [];
  if (result.status === "failed") {
    next.push("inspect the error and rerun the narrowest failing step");
  } else if (result.status === "stopped") {
    next.push("resume from the current workspace state");
  } else {
    next.push("open the inspector and verify the diff");
  }
  if (!snapshot?.checks.length && !result.outcome?.tests_run.length) {
    next.push("run a focused check or test before trusting the change");
  }
  return next;
}

function buildRecoveryAdvice(
  result: Pick<ExecutionResult, "content" | "outcome" | "artifact_path" | "status">,
  snapshot: WorkSnapshot | undefined,
  cache: ResultCardPromptCacheStatus | undefined,
  explicit: RecoveryAdvice[] | undefined
): RecoveryAdvice[] {
  const items: RecoveryAdvice[] = [...(explicit ?? [])];
  const latestAttempts = [...(snapshot?.attempts ?? [])]
    .filter((attempt) => attempt.status === "failed" || attempt.recovery_suggestion)
    .slice(-6)
    .reverse();
  for (const attempt of latestAttempts) {
    if (!attempt.recovery_suggestion) {
      continue;
    }
    items.push(recoveryAdviceFromSuggestion({
      suggestion: attempt.recovery_suggestion,
      errorCode: attempt.error_code,
      summary: attempt.terminal_reason ?? attempt.title ?? (typeof attempt.metadata.summary === "string" ? attempt.metadata.summary : undefined)
    }));
  }
  const contentRecovery = extractRecoverySuggestion(result.content);
  if (contentRecovery) {
    items.push(recoveryAdviceFromSuggestion({
      suggestion: contentRecovery,
      summary: firstLine(result.content, 180)
    }));
  }
  const cacheRecovery = recoveryAdviceFromCacheStatus(cache);
  if (cacheRecovery) {
    items.push(cacheRecovery);
  }
  return uniqueRecoveryAdvice(items).slice(0, 5);
}

function extractRecoverySuggestion(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^Recovery:\s*(?!\[)(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

function uniqueRecoveryAdvice(items: RecoveryAdvice[]): RecoveryAdvice[] {
  const seen = new Set<string>();
  const unique: RecoveryAdvice[] = [];
  for (const item of items) {
    const key = `${item.category}\0${item.summary}\0${item.nextAction}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function inferCheckStatus(command: string): "passed" | "failed" | "skipped" | "unknown" {
  const lowered = command.toLowerCase();
  if (lowered.includes("skip")) {
    return "skipped";
  }
  if (lowered.includes("fail") || lowered.includes("error")) {
    return "failed";
  }
  if (
    lowered.includes("check")
    || lowered.includes("test")
    || lowered.includes("lint")
    || lowered.includes("build")
    || lowered.includes("diff")
    || lowered.includes("completed")
    || lowered.includes("verified")
    || lowered.includes("success")
  ) {
    return "passed";
  }
  return "unknown";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function formatList(items: string[], empty = "(none)"): string[] {
  if (!items.length) {
    return [`  ${empty}`];
  }
  return items.slice(0, 8).map((item) => `  - ${firstLine(item, 180)}`);
}

function firstLine(value: string | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }
  const line = value.split(/\r?\n/).find((item) => item.trim())?.trim() ?? "";
  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 1))}…` : line;
}
