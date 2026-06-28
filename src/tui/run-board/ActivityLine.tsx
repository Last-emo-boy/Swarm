// Single-line activity indicator for the conversation-result-first active layout.
// Replaces the dense Swarm Board header/worker/preview stack with one glanceable,
// never-wrapped line: "[RUN] <focus/phase>  [####----]  N/M steps".
import React from "react";
import { statusBadge, progressBar } from "../theme.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";
import { phaseBadgeStatus, statusToken } from "./activity-format.js";

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

export function ActivityLine(props: { view: RunBoardSurfaceView; compact?: boolean }): React.ReactElement {
  const { view, compact } = props;
  const badgeStatus = phaseBadgeStatus(view.phase);
  const badge = statusBadge(badgeStatus);
  // Keep the action short so the progress + step counter stay visible on narrow terminals.
  const rawAction = view.focus ?? PHASE_LABEL[view.phase] ?? "Working";
  const action = rawAction.length > (compact ? 24 : 44) ? `${rawAction.slice(0, compact ? 23 : 43)}…` : rawAction;

  const checks = view.resultPreview.checks;
  const total = checks.length || view.workers.length || 1;
  const done = checks.length
    ? checks.filter((c) => c.status === "passed").length
    : view.workers.filter((w) => w.status === "done").length;
  const bar = progressBar(done, total, compact ? 8 : 16);

  const spans: SemanticTextSpan[] = [
    { text: badge, color: statusToken(badgeStatus), bold: true },
    { text: ` ${action}  `, color: "text.primary" },
    { text: bar, color: statusToken(badgeStatus) },
    { text: ` ${done}/${total} steps`, color: "text.muted" }
  ];
  return <SemanticTextLine wrap="truncate" spans={spans} />;
}
