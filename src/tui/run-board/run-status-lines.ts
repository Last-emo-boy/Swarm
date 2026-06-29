// Single projection point for the minimal active-layout status. Collapses the
// former ActivityLine + ProgressIndicator + InlineResultBlock + CompactStatusLine
// stack into at most two never-wrapping lines so each fact appears exactly once:
//   headline — focus + one progress bar + worker/file counts + the ⌃R hint
//   signal   — only when something needs the user (approval / failure / blocked)
// Pure & deterministic so it can be unit-tested without rendering.
import { statusBadge, progressBar } from "../theme.js";
import type { SemanticTextSpan } from "../components/SemanticTextLine.js";
import { phaseBadgeStatus, workerBadgeStatus, statusToken, formatElapsed } from "./activity-format.js";
import { attentionBadge } from "./run-board-row-format.js";
import type { RunBoardSurfaceView, AttentionItemView, WorkerBoardStatus } from "./run-board-types.js";

const PHASE_LABEL: Record<string, string> = {
  idle: "Idle",
  planning: "Planning",
  working: "Working",
  reviewing: "Reviewing",
  verifying: "Verifying",
  "waiting-attention": "Needs attention",
  done: "Done",
  failed: "Failed"
};

// Lower rank = more urgent; used to colour the `Nw` worker count by its worst
// member so a failed/blocked worker stays visible without a separate row.
const WORKER_RANK: Record<WorkerBoardStatus, number> = {
  failed: 0,
  stuck: 1,
  blocked: 1,
  queued: 2,
  waiting: 2,
  active: 3,
  done: 4
};

function attentionTone(item: AttentionItemView): SemanticTextSpan["color"] {
  if (item.severity === "failed" || item.severity === "blocking" || item.kind === "failed" || item.kind === "blocked") {
    return "status.danger";
  }
  if (item.severity === "warning") return "status.warning";
  if (item.kind === "approval") return "status.pending";
  return "text.muted";
}

export type RunStatusLines = { headline: SemanticTextSpan[]; signal?: SemanticTextSpan[] };

export function selectRunStatusLines(
  view: RunBoardSurfaceView,
  options: { columns?: number; elapsedMs?: number; compact?: boolean } = {}
): RunStatusLines {
  const columns = options.columns ?? 120;
  const compact = options.compact ?? false;
  const wide = !compact && columns >= 100;

  const badgeStatus = phaseBadgeStatus(view.phase);
  const rawFocus = view.focus ?? PHASE_LABEL[view.phase] ?? "Working";
  const clip = compact ? 24 : 40;
  const focus = rawFocus.length > clip ? `${rawFocus.slice(0, clip - 1)}…` : rawFocus;

  const headline: SemanticTextSpan[] = [
    { text: statusBadge(badgeStatus), color: statusToken(badgeStatus), bold: true },
    { text: ` ${focus}`, color: "text.primary" }
  ];

  // One progress bar only: checks if present, otherwise workers.
  const checks = view.resultPreview.checks;
  const total = checks.length || view.workers.length;
  if (total > 0) {
    const done = checks.length
      ? checks.filter((check) => check.status === "passed").length
      : view.workers.filter((worker) => worker.status === "done").length;
    const barColor = checks.some((check) => check.status === "failed")
      ? "status.danger"
      : done === total
        ? "status.success"
        : "status.running";
    headline.push({ text: "  ", color: "text.muted" });
    headline.push({ text: progressBar(done, total, compact ? 8 : 12), color: barColor });
    headline.push({ text: ` ${done}/${total}`, color: "text.muted" });
  }

  if (view.workers.length > 0) {
    const worst = [...view.workers].sort(
      (a, b) => (WORKER_RANK[a.status] ?? 5) - (WORKER_RANK[b.status] ?? 5)
    )[0].status;
    headline.push({ text: ` ·${view.workers.length}w`, color: statusToken(workerBadgeStatus(worst)), bold: true });
  }
  if (view.resultPreview.changedFiles.length > 0) {
    headline.push({ text: ` ${view.resultPreview.changedFiles.length}f`, color: "text.muted" });
  }
  if (wide && (options.elapsedMs ?? 0) > 0) {
    headline.push({ text: `  ${formatElapsed(options.elapsedMs ?? 0)}`, color: "text.muted" });
  }
  headline.push({ text: "   ⌃R", color: "text.muted" });

  // The single loud line — only when the user is actually needed.
  const urgent = view.attention[0];
  if (!urgent) {
    return { headline };
  }
  const tone = attentionTone(urgent);
  const signal: SemanticTextSpan[] = [
    { text: attentionBadge(urgent.kind), color: tone, bold: true }
  ];
  // Action keys go before the title so truncation eats the title, never the keys.
  for (const action of urgent.actions.slice(0, 2)) {
    signal.push({ text: ` [${action.key}] ${action.label}`, color: "status.pending", bold: true });
  }
  signal.push({ text: `  ${urgent.recommendation || urgent.title}`, color: "text.muted" });
  return { headline, signal };
}
