// Ultra-compact footer status line for the active layout. Aggregates the run
// board into ONE line (truncated, never wrapped): at wide widths it spells roles
// out ("4 workers • [OK] code • …"); at narrow widths it abbreviates
// ("4w • [OK]C • [WARN]T • 2f • [ASK]1"). NO_COLOR-safe via bracketed badges.
import React from "react";
import { statusBadge } from "../theme.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";
import type { RunBoardSurfaceView, WorkerBoardRole } from "./run-board-types.js";
import { workerBadgeStatus, statusToken, formatElapsed } from "./activity-format.js";

const ROLE_ORDER: WorkerBoardRole[] = ["main", "code", "test", "review", "research", "memory", "custom"];
const ROLE_ABBREV: Record<WorkerBoardRole, string> = {
  main: "M",
  code: "C",
  test: "T",
  review: "R",
  research: "Re",
  memory: "Me",
  custom: "?"
};

type StatusLayout = "full" | "narrow" | "tight";

function resolveLayout(columns: number | undefined, compact: boolean | undefined): StatusLayout {
  const cols = columns ?? 120;
  if (compact || cols < 100) return "tight";
  if (cols < 120) return "narrow";
  return "full";
}

// Worst-status-wins per role so a stuck/failed worker is never hidden.
function roleBadgeStatus(statuses: string[]): string {
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "pending")) return "pending";
  if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
  return "info";
}

export function CompactStatusLine(props: {
  view: RunBoardSurfaceView;
  elapsedMs?: number;
  compact?: boolean;
  columns?: number;
}): React.ReactElement {
  const { view } = props;
  const layout = resolveLayout(props.columns, props.compact);
  const abbrev = layout !== "full";
  const spans: SemanticTextSpan[] = [];
  const sep = () => spans.push({ text: " • ", color: "text.muted" });

  spans.push({ text: abbrev ? `${view.workers.length}w` : `${view.workers.length} workers`, color: "text.primary" });

  for (const role of ROLE_ORDER) {
    const roleWorkers = view.workers.filter((w) => w.role === role);
    if (roleWorkers.length === 0) continue;
    const status = roleBadgeStatus(roleWorkers.map((w) => workerBadgeStatus(w.status)));
    if (status === "info") continue;
    sep();
    spans.push({ text: statusBadge(status), color: statusToken(status), bold: true });
    spans.push({ text: abbrev ? ROLE_ABBREV[role] : ` ${role}`, color: "text.muted" });
  }

  const fileCount = view.resultPreview.changedFiles.length;
  if (fileCount > 0) {
    sep();
    spans.push({ text: abbrev ? `${fileCount}f` : `${fileCount} files`, color: "text.muted" });
  }

  const approvals = view.attention.filter((a) => a.kind === "approval").length;
  if (approvals > 0) {
    sep();
    spans.push({ text: abbrev ? `[ASK]${approvals}` : `[ASK] ${approvals} approvals`, color: "status.pending", bold: true });
  }

  // Elapsed time is dropped on the tightest terminals to keep one line.
  if (props.elapsedMs && props.elapsedMs > 0 && layout !== "tight") {
    sep();
    spans.push({ text: formatElapsed(props.elapsedMs), color: "text.muted" });
  }

  return <SemanticTextLine wrap="truncate" spans={spans} />;
}
