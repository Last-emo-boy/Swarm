import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import type { AttentionItemView, ResultPreview, WorkerBoardRow } from "./run-board-types.js";

export function formatWorkerRow(row: WorkerBoardRow, columns = 100): string {
  const width = Math.max(40, Math.floor(columns));
  const badge = statusBadge(row.status);
  const elapsed = formatElapsed(row.elapsedMs);
  const suffix = row.lastEvidence ? ` · ${row.lastEvidence}` : row.waitingOn ? ` · waits on ${row.waitingOn}` : "";
  const action = row.waitingOn && !row.lastEvidence ? `${row.currentAction} (waiting on ${row.waitingOn})` : row.currentAction;
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

export function formatAttentionItem(item: AttentionItemView, columns = 100): string[] {
  const width = Math.max(40, Math.floor(columns));
  const first = clipDisplay(`${attentionBadge(item.kind)} ${item.title}: ${item.summary}`, width);
  const recommendation = clipDisplay(`  Next: ${item.recommendation}`, width);
  const evidence = item.evidence[0] ? clipDisplay(`  Why: ${item.evidence[0]}`, width) : undefined;
  return [first, evidence, recommendation].filter((line): line is string => Boolean(line));
}

export function formatResultPreview(preview: ResultPreview, columns = 100): string[] {
  const width = Math.max(40, Math.floor(columns));
  const lines = [
    `Result Preview: ${preview.summary}`,
    preview.changedFiles.length ? `Changed: ${preview.changedFiles.slice(0, 3).join(", ")}` : undefined,
    preview.checks.length ? `Checks: ${preview.checks.map((check) => `${check.command} [${check.status}]`).slice(0, 3).join(", ")}` : undefined,
    preview.blockers.length ? `Blockers: ${preview.blockers.slice(0, 2).join(", ")}` : undefined,
    preview.artifacts.length ? `Artifacts: ${preview.artifacts.slice(0, 2).join(", ")}` : undefined,
    preview.status !== "empty" ? `Confidence: ${preview.confidence}` : undefined
  ];
  return lines.filter((line): line is string => Boolean(line)).map((line) => clipDisplay(line, width));
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
