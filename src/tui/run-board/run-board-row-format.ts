import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import type { AttentionItemView, ResultPreview, WorkerBoardRow } from "./run-board-types.js";

export function formatWorkerRow(row: WorkerBoardRow, columns = 100): string {
  const width = Math.max(40, Math.floor(columns));
  const badge = statusBadge(row.status);
  const elapsed = formatElapsed(row.elapsedMs);
  const visibleEvidence = visibleWorkerEvidence(row);
  const suffix = visibleEvidence ? ` · ${visibleEvidence}` : "";
  const action = row.waitingOn && !visibleEvidence ? `${row.currentAction} (waiting on ${row.waitingOn})` : row.currentAction;
  if (width < 92) {
    return clipDisplay(`${badge} ${padRight(clipDisplay(row.label, 16), 16)} ${clipDisplay(action, 32)} ${elapsed}`, width);
  }
  const label = padRight(clipDisplay(row.label, 18), 18);
  const fixedWidth = displayWidth(`${badge} ${label} ${elapsed}`);
  const evidenceBudget = width >= 120 ? 28 : 18;
  const actionBudget = Math.max(18, width - fixedWidth - evidenceBudget - 4);
  const evidence = suffix ? clipDisplay(suffix.replace(/^ · /, ""), evidenceBudget) : "";
  return clipDisplay(`${badge} ${label} ${clipDisplay(action, actionBudget)} ${elapsed}${evidence ? `  ${evidence}` : ""}`, width);
}

function visibleWorkerEvidence(row: WorkerBoardRow): string | undefined {
  if (row.status !== "blocked" && row.status !== "stuck" && row.status !== "failed") {
    return undefined;
  }
  const evidence = row.lastEvidence ?? (row.waitingOn ? `waits on ${row.waitingOn}` : undefined);
  if (!evidence) {
    return undefined;
  }
  return normalizedEvidence(evidence) === normalizedEvidence(row.currentAction) ? undefined : evidence;
}

function normalizedEvidence(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function formatAttentionItem(item: AttentionItemView, columns = 100): string[] {
  const width = Math.max(40, Math.floor(columns));
  const first = clipDisplay(`${attentionBadge(item.kind)} ${item.title}: ${item.summary}`, width);
  const recommendation = clipDisplay(`  Next: ${item.recommendation}`, width);
  const visibleEvidence = visibleAttentionEvidence(item);
  const evidence = visibleEvidence ? clipDisplay(`  Why: ${visibleEvidence}`, width) : undefined;
  return [first, evidence, recommendation].filter((line): line is string => Boolean(line));
}

function visibleAttentionEvidence(item: AttentionItemView): string | undefined {
  const evidence = item.evidence[0];
  if (!evidence) {
    return undefined;
  }
  const normalized = normalizedEvidence(evidence);
  return [item.title, item.summary].some((value) => normalizedEvidence(value).includes(normalized))
    ? undefined
    : evidence;
}

export function formatResultPreview(preview: ResultPreview, columns = 100): string[] {
  const width = Math.max(40, Math.floor(columns));
  const blockers = visibleResultBlockers(preview);
  const checks = visibleResultChecks(preview);
  const checkSummary = resultCheckSummary(checks);
  const lines = [
    `Result: ${preview.summary}`,
    checkSummary ? `Verified: ${checkSummary}` : undefined,
    blockers.length ? `Blockers: ${blockers.slice(0, 2).join(", ")}` : undefined
  ];
  return lines.filter((line): line is string => Boolean(line)).map((line) => clipDisplay(line, width));
}

function visibleResultChecks(preview: ResultPreview): ResultPreview["checks"] {
  return preview.checks.filter((check) => check.status !== "running" && check.status !== "unknown");
}

function resultCheckSummary(checks: ResultPreview["checks"]): string | undefined {
  if (!checks.length) {
    return undefined;
  }
  const failed = checks.filter((check) => check.status === "failed");
  if (failed.length) {
    return failed.slice(0, 2).map((check) => `${checkStatusBadge(check.status)} ${check.command}`).join(", ");
  }
  const skipped = checks.filter((check) => check.status === "skipped");
  if (skipped.length === checks.length) {
    return "Skipped";
  }
  return skipped.length ? "Passed; some skipped" : undefined;
}

function visibleResultBlockers(preview: ResultPreview): string[] {
  const summary = preview.summary.toLowerCase();
  return preview.blockers.filter((blocker) => {
    const value = blocker.trim();
    return value && !summary.includes(value.toLowerCase());
  });
}

function checkStatusBadge(status: ResultPreview["checks"][number]["status"]): string {
  switch (status) {
    case "passed": return "[OK]";
    case "failed": return "[ERR]";
    case "running": return "[RUN]";
    case "skipped": return "[SKIP]";
    case "unknown": return "[--]";
  }
}

export function statusBadge(status: WorkerBoardRow["status"]): string {
  switch (status) {
    case "done": return "[OK]";
    case "failed": return "[ERR]";
    case "blocked":
    case "stuck": return "[WARN]";
    case "waiting":
    case "queued": return "[ASK]";
    case "active": return "[RUN]";
  }
}

export function attentionBadge(kind: AttentionItemView["kind"]): string {
  switch (kind) {
    case "failed": return "[ERR]";
    case "approval":
    case "uncertain": return "[ASK]";
    case "slow":
    case "blocked":
    case "conflicted": return "[WARN]";
  }
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function clipDisplay(value: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth));
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return sliceByDisplayWidth(value, width).head;
  return `${sliceByDisplayWidth(value, width - 1).head}…`;
}

function padRight(value: string, width: number): string {
  const current = displayWidth(value);
  if (current >= width) return value;
  return `${value}${" ".repeat(width - current)}`;
}
