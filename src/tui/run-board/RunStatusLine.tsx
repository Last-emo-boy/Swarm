// Minimal active-layout status: one glanceable headline, plus a single loud
// signal line only when the user is needed. Replaces the five-component status
// stack so the conversation/result owns the screen. Each line is a
// SemanticTextLine wrap="truncate" — physically one row, never wraps.
import React from "react";
import { Box } from "../ui.js";
import { SemanticTextLine } from "../components/SemanticTextLine.js";
import { selectRunStatusLines } from "./run-status-lines.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";

export function RunStatusLine(props: {
  view: RunBoardSurfaceView;
  columns?: number;
  compact?: boolean;
  elapsedMs?: number;
}): React.ReactElement {
  const { headline, signal } = selectRunStatusLines(props.view, {
    columns: props.columns,
    compact: props.compact,
    elapsedMs: props.elapsedMs
  });
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <SemanticTextLine wrap="truncate" spans={headline} />
      {signal ? <SemanticTextLine wrap="truncate" spans={signal} /> : null}
    </Box>
  );
}
