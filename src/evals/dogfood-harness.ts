import type {
  HeadlessArtifactIndex,
  HeadlessRunReport,
  HeadlessTelemetry,
  HeadlessTrajectory
} from "../runtime/headless-artifacts.js";
import {
  buildPromptCacheRoi,
  formatPromptCacheRoiInline,
  promptCacheTrendFromResultCardCache,
  type CacheRoi
} from "../runtime/prompt-cache-status.js";
import type { ResultCard } from "../runtime/result-card.js";

export type DogfoodFailureCategory = "quality" | "verification" | "provider" | "cache" | "tui" | "report";

export type DogfoodFixtureContract = {
  id: string;
  objective: string;
  workspaceSeed: {
    kind: "fixture" | "directory";
    path: string;
  };
  expectedStatus: ResultCard["status"];
  expectedChangedFiles: string[];
  expectedTests: string[];
  enforceMinimalDiff?: boolean;
  allowReviewWarningWhenVerified?: boolean;
  cacheExpectation?: {
    requireCacheFacts?: boolean;
    minHitRate?: number;
    expectedOutcome?: "hit" | "miss" | "unknown";
  };
  artifactExpectation?: {
    requireReport?: boolean;
    requireTelemetry?: boolean;
    requireTrajectory?: boolean;
    requireDebugLog?: boolean;
    requireStdout?: boolean;
    requireStderr?: boolean;
    requireDiffSummary?: boolean;
  };
};

export type DogfoodReplayEvidence = {
  resultCard?: ResultCard;
  report?: HeadlessRunReport;
  telemetry?: HeadlessTelemetry;
  trajectory?: HeadlessTrajectory;
  artifactIndex?: HeadlessArtifactIndex;
  stdout?: string;
  stderr?: string;
  diffSummary?: string;
};

export type DogfoodQualityFinding = {
  category: DogfoodFailureCategory;
  severity: "info" | "warning" | "error";
  message: string;
};

export type DogfoodQualityReport = {
  fixtureId: string;
  status: "pass" | "fail";
  summary: string;
  finalStatus?: ResultCard["status"] | HeadlessRunReport["status"];
  reviewStatus?: ResultCard["review"]["status"];
  reviewSeverity: "none" | "low" | "medium" | "high";
  verificationStatus: "passed" | "failed" | "missing";
  changedFiles: string[];
  tests: string[];
  cacheHitRate?: number;
  cacheRoi?: CacheRoi;
  trajectoryPath?: string;
  artifactKinds: string[];
  failureCategories: DogfoodFailureCategory[];
  findings: DogfoodQualityFinding[];
};

export function evaluateDogfoodReplay(
  contract: DogfoodFixtureContract,
  evidence: DogfoodReplayEvidence
): DogfoodQualityReport {
  const artifactIndex = evidence.artifactIndex ?? evidence.report?.artifact_index;
  const card = evidence.resultCard ?? evidence.report?.result?.result_card;
  const changedFiles = unique([
    ...(card?.changedFiles ?? []),
    ...(evidence.report?.result?.outcome?.changed_files ?? [])
  ]);
  const tests = unique([
    ...(card?.checks.map((check) => check.command) ?? []),
    ...(evidence.report?.result?.outcome?.tests_run ?? [])
  ]);
  const artifactKinds = artifactIndex?.artifacts.map((artifact) => artifact.kind) ?? [];
  const findings: DogfoodQualityFinding[] = [];
  const finalStatus = card?.status ?? evidence.report?.status;
  const reviewStatus = card?.review.status;
  const reviewSeverity = inferReviewSeverity(card?.review);
  const failedChecks = card?.checks.filter((check) => check.status === "failed") ?? [];
  const verificationStatus = tests.length === 0
    ? "missing"
    : failedChecks.length > 0
      ? "failed"
      : "passed";
  const cacheHitRate = evidence.telemetry?.llm.cache_hit_rate ?? card?.cache?.hitRate;
  const cacheRoi = evidence.telemetry?.llm.cache_roi
    ?? (card?.cache ? buildPromptCacheRoi(promptCacheTrendFromResultCardCache(card.cache)) : undefined);
  const trajectoryPath = artifactPath(artifactIndex, "trajectory") ?? evidence.report?.artifacts.trajectory_path;

  if (!card) {
    findings.push(error("report", "result_card is missing from dogfood evidence."));
  }
  if (!evidence.report) {
    findings.push(error("report", "headless report is missing from dogfood evidence."));
  }
  if (finalStatus !== contract.expectedStatus) {
    findings.push(error(
      providerErrorMessage(evidence.report?.error?.message) ? "provider" : "verification",
      `expected status ${contract.expectedStatus}, got ${finalStatus ?? "missing"}.`
    ));
  }
  if (evidence.report && card && evidence.report.status !== card.status) {
    findings.push(error("report", `report status ${evidence.report.status} diverges from result card status ${card.status}.`));
  }

  for (const file of contract.expectedChangedFiles) {
    if (!changedFiles.includes(file)) {
      findings.push(error("quality", `expected changed file missing: ${file}.`));
    }
  }
  if (contract.enforceMinimalDiff) {
    const extras = changedFiles.filter((file) => !contract.expectedChangedFiles.includes(file));
    if (extras.length) {
      findings.push(error("quality", `unexpected changed files: ${extras.join(", ")}.`));
    }
  }

  for (const test of contract.expectedTests) {
    if (!tests.some((recorded) => recorded.includes(test))) {
      findings.push(error("verification", `expected verification missing: ${test}.`));
    }
  }
  if (verificationStatus === "missing") {
    findings.push(error("verification", "no verification command was recorded."));
  }
  for (const check of failedChecks) {
    findings.push(error("verification", `verification check failed: ${check.command}.`));
  }

  if (reviewStatus === "failed") {
    findings.push(error("quality", `review failed: ${card?.review.summary ?? "no summary"}.`));
  } else if (reviewStatus === "warning") {
    const severity = reviewSeverity === "none" ? "medium" : reviewSeverity;
    if (!contract.allowReviewWarningWhenVerified || verificationStatus !== "passed" || severity === "high") {
      findings.push(error("quality", `review warning requires action: ${card?.review.summary ?? "no summary"}.`));
    } else {
      findings.push({
        category: "quality",
        severity: "warning",
        message: `review warning preserved without failing verified work: ${card?.review.summary ?? "no summary"}.`
      });
    }
  }

  const cacheExpectation = contract.cacheExpectation;
  if (cacheExpectation?.requireCacheFacts && cacheHitRate === undefined) {
    findings.push(error("cache", "cache facts are missing from result card and telemetry."));
  }
  if (cacheExpectation?.minHitRate !== undefined && (cacheHitRate === undefined || cacheHitRate < cacheExpectation.minHitRate)) {
    findings.push(error("cache", `cache hit rate ${formatRate(cacheHitRate)} is below ${formatRate(cacheExpectation.minHitRate)}.`));
  }
  if (cacheExpectation?.expectedOutcome && cacheExpectation.expectedOutcome !== "unknown" && card?.cache?.outcome && card.cache.outcome !== cacheExpectation.expectedOutcome) {
    findings.push(error("cache", `expected cache outcome ${cacheExpectation.expectedOutcome}, got ${card.cache.outcome}.`));
  }
  if (evidence.telemetry?.llm.cache_slo.status === "fail") {
    findings.push(error("cache", evidence.telemetry.llm.cache_slo.summary));
  }

  const artifactExpectation = contract.artifactExpectation ?? {};
  for (const [required, kind] of [
    [artifactExpectation.requireReport, "report"],
    [artifactExpectation.requireTelemetry, "telemetry"],
    [artifactExpectation.requireTrajectory, "trajectory"],
    [artifactExpectation.requireDebugLog, "debug_log"],
    [artifactExpectation.requireStdout, "stdout"],
    [artifactExpectation.requireStderr, "stderr"],
    [artifactExpectation.requireDiffSummary, "diff_summary"]
  ] as const) {
    if (required && !artifactKinds.includes(kind)) {
      findings.push(error("report", `required artifact missing: ${kind}.`));
    }
  }
  if (artifactExpectation.requireTrajectory && !evidence.trajectory && !trajectoryPath) {
    findings.push(error("report", "trajectory evidence is missing."));
  }
  if (evidence.trajectory && evidence.trajectory.steps.length === 0) {
    findings.push(error("report", "trajectory contains no steps."));
  }

  const combinedText = [
    evidence.report?.error?.message,
    evidence.report?.result?.content,
    card?.summary,
    evidence.stdout,
    evidence.stderr
  ].filter(Boolean).join("\n");
  if (/COMMAND OUTPUT\s+session:-/i.test(combinedText)) {
    findings.push(error("tui", "TUI command output detail takeover marker appeared in dogfood evidence."));
  }
  if (providerErrorMessage(evidence.report?.error?.message)) {
    findings.push(error("provider", evidence.report?.error?.message ?? "provider error"));
  }

  const blocking = findings.filter((finding) => finding.severity === "error");
  const failureCategories = unique(blocking.map((finding) => finding.category));
  return {
    fixtureId: contract.id,
    status: blocking.length ? "fail" : "pass",
    summary: blocking.length
      ? `dogfood ${contract.id} failed: ${failureCategories.join(", ")}`
      : `dogfood ${contract.id} passed with ${changedFiles.length} changed files, ${tests.length} checks, cache hit ${formatRate(cacheHitRate)}.`,
    finalStatus,
    reviewStatus,
    reviewSeverity,
    verificationStatus,
    changedFiles,
    tests,
    cacheHitRate,
    cacheRoi,
    trajectoryPath,
    artifactKinds,
    failureCategories,
    findings
  };
}

export function formatDogfoodQualityReport(report: DogfoodQualityReport): string[] {
  return [
    `dogfood=${report.fixtureId} status=${report.status} final=${report.finalStatus ?? "missing"} review=${report.reviewStatus ?? "missing"} review_severity=${report.reviewSeverity} verification=${report.verificationStatus}`,
    `changed_files=${report.changedFiles.join(",") || "(none)"}`,
    `tests=${report.tests.join(" | ") || "(none)"}`,
    `cache_hit_rate=${formatRate(report.cacheHitRate)}`,
    `cache_roi=${formatPromptCacheRoiInline(report.cacheRoi) ?? "(missing)"}`,
    `trajectory=${report.trajectoryPath ?? "(missing)"}`,
    `artifacts=${report.artifactKinds.join(",") || "(none)"}`,
    ...report.findings.map((finding) => `${finding.severity.toUpperCase()} ${finding.category}: ${finding.message}`)
  ];
}

function artifactPath(index: HeadlessArtifactIndex | undefined, kind: string): string | undefined {
  return index?.artifacts.find((artifact) => artifact.kind === kind)?.path;
}

function inferReviewSeverity(review: ResultCard["review"] | undefined): DogfoodQualityReport["reviewSeverity"] {
  if (!review || review.status === "passed" || review.status === "skipped") {
    return "none";
  }
  if (review.status === "failed") {
    return "high";
  }
  const summary = review.summary.toLowerCase();
  if (/\bhigh|critical|blocker\b/.test(summary)) {
    return "high";
  }
  if (/\blow|minor|nit\b/.test(summary)) {
    return "low";
  }
  if (/\bmedium|needs[_ -]?revision\b/.test(summary)) {
    return "medium";
  }
  return "medium";
}

function providerErrorMessage(message: string | undefined): boolean {
  return Boolean(message && /provider|rate.?limit|quota|401|403|429|api[_-]?key|auth/i.test(message));
}

function error(category: DogfoodFailureCategory, message: string): DogfoodQualityFinding {
  return { category, severity: "error", message };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function formatRate(rate: number | undefined): string {
  return rate === undefined ? "unknown" : `${Math.round(rate * 100)}%`;
}
