// Optional read-only worker transparency rail for the active layout. Hidden by
// default; toggled with Ctrl+R. Stacks below the conversation; shows a compact
// worker list. Never claims focus.
import React from "react";
import { Box, Text } from "../ui.js";
import { statusBadge, visualTokenColor } from "../theme.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";
import { workerBadgeStatus, statusToken } from "./activity-format.js";

const MAX_ROWS = 8;

export function ActivityRail(props: { view: RunBoardSurfaceView; visible: boolean; columns?: number }): React.ReactElement | null {
  if (!props.visible) return null;
  const { view } = props;
  const width = Math.max(32, props.columns ?? 48);
  const attentionWorkerIds = new Set(
    view.attention.map((a) => a.subjectWorkerId).filter((id): id is string => Boolean(id))
  );
  const workers = view.workers.slice(0, MAX_ROWS);
  const hidden = view.workers.length - workers.length;
  return (
    <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor={visualTokenColor("surface.line")}>
      <Text color={visualTokenColor("text.muted")} bold>WORKERS (Ctrl+R)</Text>
      {workers.map((worker) => {
        const status = workerBadgeStatus(worker.status);
        const flagged = attentionWorkerIds.has(worker.id);
        const label = (worker.label || worker.role).slice(0, 14).padEnd(14);
        const action = (worker.currentAction || "").slice(0, Math.max(0, width - 24));
        return (
          <Box key={worker.id} flexDirection="row" width="100%">
            <Text color={visualTokenColor(statusToken(status))} bold>{statusBadge(status)}</Text>
            <Text color={visualTokenColor(flagged ? "status.warning" : "text.primary")}> {label}</Text>
            <Text color={visualTokenColor("text.muted")}> {action}</Text>
          </Box>
        );
      })}
      {hidden > 0 ? <Text color={visualTokenColor("text.muted")}>+{hidden} more</Text> : null}
    </Box>
  );
}
