// Ultra-compact footer status line for the active layout. Aggregates the run
// board into one row: "N workers • [OK] code • [WARN] test • F files • [ASK] A
// approvals • MM:SS". NO_COLOR-safe via bracketed badges.
import React from "react";
import { Box, Text } from "../ui.js";
import { statusBadge, visualTokenColor } from "../theme.js";
import type { RunBoardSurfaceView, WorkerBoardRole } from "./run-board-types.js";
import { workerBadgeStatus, statusToken, formatElapsed } from "./activity-format.js";

const ROLE_ORDER: WorkerBoardRole[] = ["main", "code", "test", "review", "research", "memory", "custom"];

// Worst-status-wins per role so a stuck/failed worker is never hidden.
function roleBadgeStatus(statuses: string[]): string {
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "pending")) return "pending";
  if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
  return "info";
}

export function CompactStatusLine(props: { view: RunBoardSurfaceView; elapsedMs?: number }): React.ReactElement {
  const { view } = props;
  const muted = visualTokenColor("text.muted");
  const cells: React.ReactElement[] = [];
  let key = 0;
  const sep = () => <Text key={`sep-${key++}`} color={muted}> • </Text>;

  cells.push(
    <Text key={`w-${key++}`} color={visualTokenColor("text.primary")}>{view.workers.length} workers</Text>
  );

  for (const role of ROLE_ORDER) {
    const roleWorkers = view.workers.filter((w) => w.role === role);
    if (roleWorkers.length === 0) continue;
    const status = roleBadgeStatus(roleWorkers.map((w) => workerBadgeStatus(w.status)));
    if (status === "info") continue;
    cells.push(sep());
    cells.push(<Text key={`b-${key++}`} color={visualTokenColor(statusToken(status))} bold>{statusBadge(status)}</Text>);
    cells.push(<Text key={`r-${key++}`} color={muted}> {role}</Text>);
  }

  const fileCount = view.resultPreview.changedFiles.length;
  if (fileCount > 0) {
    cells.push(sep());
    cells.push(<Text key={`f-${key++}`} color={muted}>{fileCount} files</Text>);
  }

  const approvals = view.attention.filter((a) => a.kind === "approval").length;
  if (approvals > 0) {
    cells.push(sep());
    cells.push(<Text key={`a-${key++}`} color={visualTokenColor("status.pending")} bold>[ASK] {approvals} approvals</Text>);
  }

  if (props.elapsedMs && props.elapsedMs > 0) {
    cells.push(sep());
    cells.push(<Text key={`t-${key++}`} color={muted}>{formatElapsed(props.elapsedMs)}</Text>);
  }

  return (
    <Box flexDirection="row" width="100%" paddingX={1}>
      {cells}
    </Box>
  );
}
