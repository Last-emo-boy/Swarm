// Single-line activity indicator for the conversation-result-first active layout.
// Replaces the dense Swarm Board header/worker/preview stack with one glanceable
// line: "[RUN] <focus/phase>  [####----]  N/M steps".
import React from "react";
import { Box, Text } from "../ui.js";
import { statusBadge, progressBar, visualTokenColor } from "../theme.js";
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
  const badgeColor = visualTokenColor(statusToken(badgeStatus));
  const action = view.focus ?? PHASE_LABEL[view.phase] ?? "Working";

  const checks = view.resultPreview.checks;
  const total = checks.length || view.workers.length || 1;
  const done = checks.length
    ? checks.filter((c) => c.status === "passed").length
    : view.workers.filter((w) => w.status === "done").length;
  const bar = progressBar(done, total, compact ? 8 : 16);

  return (
    <Box flexDirection="row" width="100%" paddingX={1}>
      <Text color={badgeColor} bold>{badge}</Text>
      <Text color={visualTokenColor("text.primary")}> {action}  </Text>
      <Text color={visualTokenColor("status.running")}>{bar}</Text>
      <Text color={visualTokenColor("text.muted")}> {done}/{total} steps</Text>
    </Box>
  );
}
