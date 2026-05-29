import React from "react";
import { Box, Text } from "../ui.js";
import { fitToDisplayWidth } from "../display-width.js";
import { visualTokenColor } from "../theme.js";
import type { WorkBoardThreadView } from "./work-board-types.js";
import { formatWorkItemThreadRows } from "./work-item-thread-selectors.js";

export function WorkItemThread({
  thread,
  columns,
  rows
}: {
  thread: WorkBoardThreadView;
  columns: number;
  rows: number;
}): React.ReactElement {
  const safeColumns = Math.max(10, Math.floor(columns));
  const visibleRows = Math.max(4, Math.floor(rows));
  const detailRows = formatWorkItemThreadRows(thread, visibleRows - 2);
  return (
    <Box flexDirection="column" width="100%" height={visibleRows} overflow="hidden" marginTop={1}>
      <Text wrap="truncate">
        <Text color={visualTokenColor("brand.focus")} bold>{fitToDisplayWidth(`# ${thread.title}`, safeColumns)}</Text>
      </Text>
      {detailRows.map((line, index) => (
        <Text key={`${thread.id}-${index}`} color={index < 2 ? visualTokenColor("text.primary") : visualTokenColor("text.muted")} wrap="truncate">
          {fitToDisplayWidth(line, safeColumns)}
        </Text>
      ))}
    </Box>
  );
}
