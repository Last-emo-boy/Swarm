import type { ReviewResult } from "../protocol/types.js";
import type { ToolResult } from "../tools/types.js";
import { isRecord } from "./common-utilities.js";
import { hydrateToolResultForReport, verificationTextSuggestsGap, summarizeToolResultForReport, reviewTextSuggestsFinding, firstMeaningfulToolLine } from "./tool-result-report.js";

export function postChangeExecutionStatus(input: {
  review: ReviewResult;
  verification: { status: "success" | "partial" | "failed"; summary: string; content?: string };
}): "completed" | "failed" {
  if (input.review.verdict === "reject" && !reviewFailureCanDeferToVerification(input.review, input.verification)) {
    return "failed";
  }
  if (input.verification.status === "failed") {
    return "failed";
  }
  return "completed";
}

export function reviewFailureCanDeferToVerification(
  review: ReviewResult,
  verification: { status: "success" | "partial" | "failed"; summary: string; content?: string }
): boolean {
  if (verification.status !== "success") {
    return false;
  }
  const text = [
    review.summary,
    ...(review.issues ?? []).flatMap((issue) => [issue.message, issue.evidence, issue.suggested_fix])
  ].filter(Boolean).join("\n").toLowerCase();
  if (!text) {
    return false;
  }
  return reviewFailureLooksOperational(review);
}

export function normalizeReviewJson(parsed: Record<string, unknown>, sessionId: string): ReviewResult {
  const verdict = parsed.verdict === "approve" || parsed.verdict === "reject" || parsed.verdict === "needs_revision"
    ? parsed.verdict
    : "needs_revision";
  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score)
    ? Math.max(0, Math.min(100, parsed.score))
    : verdict === "approve" ? 85 : verdict === "reject" ? 20 : 60;
  const reviewer = isRecord(parsed.reviewer) ? parsed.reviewer : {};
  return {
    target_task_id: typeof parsed.target_task_id === "string" ? parsed.target_task_id : "coding_loop",
    reviewer: {
      agent_id: typeof reviewer.agent_id === "string" ? reviewer.agent_id : "reviewer",
      role: typeof reviewer.role === "string" ? reviewer.role : "reviewer"
    },
    verdict,
    score,
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.filter(isRecord).map((issue) => ({
          severity: issue.severity === "high" || issue.severity === "medium" || issue.severity === "low" ? issue.severity : "medium",
          task_id: typeof issue.task_id === "string" ? issue.task_id : undefined,
          message: typeof issue.message === "string" ? issue.message : JSON.stringify(issue),
          evidence: typeof issue.evidence === "string" ? issue.evidence : undefined,
          suggested_fix: typeof issue.suggested_fix === "string" ? issue.suggested_fix : undefined
        }))
      : undefined,
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : `Review completed for ${sessionId}.`
  };
}

export async function normalizeVerificationToolResult(tool: ToolResult): Promise<{ status: "success" | "partial" | "failed"; summary: string; content?: string; worker_id?: string }> {
  const hydratedTool = await hydrateToolResultForReport(tool);
  const rawText = [hydratedTool.summary, hydratedTool.content, ...(hydratedTool.errors ?? [])].filter(Boolean).join("\n");
  const baseStatus = hydratedTool.status ?? "success";
  const status = baseStatus === "failed"
    ? "failed"
    : verificationTextSuggestsGap(rawText)
      ? "partial"
      : baseStatus;
  return {
    status,
    summary: summarizeToolResultForReport(hydratedTool, status === "failed" ? "Verification failed." : "Verification completed."),
    content: hydratedTool.content,
    worker_id: isRecord(hydratedTool.data) && typeof hydratedTool.data.worker_id === "string" ? hydratedTool.data.worker_id : undefined
  };
}

export function guardReviewResult(review: ReviewResult, tool: ToolResult, sessionId: string): ReviewResult {
  const rawText = [tool.summary, tool.content, ...(tool.errors ?? [])].filter(Boolean).join("\n");
  const reportedFinding = reviewTextSuggestsFinding(rawText);
  const issues = [...(review.issues ?? [])];
  if (reportedFinding && issues.length === 0) {
    const evidence = firstMeaningfulToolLine(rawText);
    issues.push({
      severity: "medium",
      message: evidence || "Review reported findings but did not provide structured issues.",
      evidence: evidence || undefined,
      suggested_fix: "Inspect the reviewer output and either fix the issue or explicitly justify why it is non-blocking."
    });
  }
  const guardedScore = issues.length > 0 || reportedFinding
    ? Math.min(review.score, 85)
    : review.score;
  const guardedVerdict = guardedReviewVerdict(review, rawText, issues, reportedFinding);
  const guardedSummary = summarizeToolResultForReport(tool, review.summary || `Review completed for ${sessionId}.`);
  return {
    ...review,
    verdict: guardedVerdict,
    score: guardedScore,
    issues: issues.length ? issues : review.issues,
    summary: guardedSummary
  };
}

export function guardedReviewVerdict(
  review: ReviewResult,
  rawText: string,
  issues: NonNullable<ReviewResult["issues"]>,
  reportedFinding: boolean
): ReviewResult["verdict"] {
  if (review.verdict === "reject" && reviewFailureLooksOperational(review, rawText)) {
    return "needs_revision";
  }
  if ((issues.length > 0 || reportedFinding) && review.verdict === "approve") {
    return "needs_revision";
  }
  return review.verdict;
}

export function reviewFailureLooksOperational(review: ReviewResult, rawText = ""): boolean {
  const text = [
    rawText,
    review.summary,
    ...(review.issues ?? []).flatMap((issue) => [issue.message, issue.evidence, issue.suggested_fix])
  ].filter(Boolean).join("\n").toLowerCase();
  if (!text) {
    return false;
  }
  const toolFailure = /\b(review agent failed|budget exhausted|spawn .*enoent|expected verification command evidence|unverified verification claim|file\.read target not found|git diff failed|git status failed|no check was recorded|tool calls failed|path resolution issues)\b/.test(text);
  const substantiveFinding = /\b(regression|bug|incorrect|wrong result|data loss|security|crash|exception|fails? tests?|broken behavior|required fix)\b/.test(text);
  return toolFailure && !substantiveFinding;
}
