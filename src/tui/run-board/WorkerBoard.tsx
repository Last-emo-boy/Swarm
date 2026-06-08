import React from "react";
import { Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";
import type { WorkerBoardRow as WorkerBoardRowData } from "./run-board-types.js";
import { WorkerRow } from "./WorkerRow.js";
import { RunBoardPanel } from "./RunBoardSurface.js";

export function WorkerBoard(props: {
  rows: WorkerBoardRowData[];
  limit?: number;
  selectedRowId?: string;
  onRowClick?: (row: WorkerBoardRowData) => void;
}): React.ReactElement | null {
  const limit = Math.max(1, props.limit ?? (props.rows.length || 1));
  const visible = props.rows.slice(0, limit);
  const hidden = Math.max(0, props.rows.length - visible.length);
  if (!visible.length && hidden === 0) {
    return null;
  }
  return (
    <RunBoardPanel title="Progress">
      {visible.length
        ? visible.map((row) => (
            <WorkerRow
              key={row.id}
              row={row}
              selected={row.id === props.selectedRowId}
              onClick={props.onRowClick}
            />
          ))
        : null}
      {hidden > 0 ? <Text color={visualTokenColor("text.muted")}>More updates</Text> : null}
    </RunBoardPanel>
  );
}
