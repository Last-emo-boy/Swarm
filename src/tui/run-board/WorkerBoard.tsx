import React from "react";
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
  if (!visible.length) {
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
    </RunBoardPanel>
  );
}
