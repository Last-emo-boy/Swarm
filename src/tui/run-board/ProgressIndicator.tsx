// Thin two-row progress indicator (checks + workers) for the active layout.
// Only rendered on non-compact terminals; complements ActivityLine.
import React from "react";
import { Box, Text } from "../ui.js";
import { progressBar, visualTokenColor } from "../theme.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";

export function ProgressIndicator(props: { view: RunBoardSurfaceView }): React.ReactElement | null {
  const { view } = props;
  const checks = view.resultPreview.checks;
  const totalWorkers = view.workers.length;
  if (checks.length === 0 && totalWorkers === 0) {
    return null;
  }
  const passedChecks = checks.filter((c) => c.status === "passed").length;
  const doneWorkers = view.workers.filter((w) => w.status === "done").length;
  const checksBar = progressBar(passedChecks, checks.length || 1, 12);
  const workersBar = progressBar(doneWorkers, totalWorkers || 1, 12);
  const muted = visualTokenColor("text.muted");
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {checks.length > 0 ? (
        <Box flexDirection="row" width="100%">
          <Text color={visualTokenColor("status.success")}>{checksBar}</Text>
          <Text color={muted}> {passedChecks}/{checks.length} checks</Text>
        </Box>
      ) : null}
      {totalWorkers > 0 ? (
        <Box flexDirection="row" width="100%">
          <Text color={visualTokenColor("status.running")}>{workersBar}</Text>
          <Text color={muted}> {doneWorkers}/{totalWorkers} workers</Text>
        </Box>
      ) : null}
    </Box>
  );
}
