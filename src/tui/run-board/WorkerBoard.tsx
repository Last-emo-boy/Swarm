import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";
import type { WorkerBoardRow as WorkerBoardRowData } from "./run-board-types.js";
import { WorkerRow, WorkerRowEmpty } from "./WorkerRow.js";
import { RunBoardPanel } from "./RunBoardPanel.js";

export function WorkerBoard(props: {
  rows: WorkerBoardRowData[];
  limit?: number;
  selectedRowId?: string;
  onRowClick?: (row: WorkerBoardRowData) => void;
}): React.ReactElement {
  const limit = Math.max(1, props.limit ?? (props.rows.length || 1));
  const visible = props.rows.slice(0, limit);
  const hidden = Math.max(0, props.rows.length - visible.length);
  return (
    <RunBoardPanel title="Worker Board">
      {visible.length
        ? visible.map((row) => (
            <WorkerRow
              key={row.id}
              row={row}
              selected={row.id === props.selectedRowId}
              onClick={props.onRowClick}
            />
          ))
        : <WorkerRowEmpty />}
      {hidden > 0 ? <Text color={visualTokenColor("text.muted")}>+{hidden} more workers</Text> : null}
    </RunBoardPanel>
  );
}
