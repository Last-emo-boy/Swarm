import React from "react";
import { Box, Text } from "../ui.js";
import { displayWidth, fitToDisplayWidth, padToDisplayWidth } from "../display-width.js";
import { statusBadge, visualTokenColor } from "../theme.js";
import type { WorkBoardColumnView, WorkBoardSurfaceView } from "./work-board-types.js";
import { toneRefForWorkBoardItem } from "./work-board-types.js";
import { WorkItemThread } from "./WorkItemThread.js";

const EMPTY_WORK_PROMPT = "Ask Swarm to review or plan this workspace.";

export function WorkBoardSurface({
  view,
  rows,
  columns
}: {
  view: WorkBoardSurfaceView;
  rows: number;
  columns: number;
}): React.ReactElement {
  const safeRows = Math.max(8, Math.floor(rows));
  const safeColumns = Math.max(40, Math.floor(columns));
  if (view.empty) {
    return (
      <Box flexDirection="column" width="100%" height={safeRows} overflow="hidden">
        <BoardHeader view={view} columns={safeColumns} />
      </Box>
    );
  }
  const compact = safeColumns < 92;
  const boardRows = compact ? Math.max(4, Math.floor(safeRows * 0.46)) : Math.max(5, Math.floor(safeRows * 0.5));
  const threadRows = Math.max(4, safeRows - boardRows - 2);
  return (
    <Box flexDirection="column" width="100%" height={safeRows} overflow="hidden">
      <BoardHeader view={view} columns={safeColumns} />
      <Box width="100%" height={boardRows} flexDirection={compact ? "column" : "row"} overflow="hidden">
        {view.columns.map((column) => (
          <BoardColumn key={column.id} column={column} columns={compact ? safeColumns : Math.floor(safeColumns / view.columns.length) - 1} rows={compact ? 3 : boardRows} compact={compact} />
        ))}
      </Box>
      {view.selected ? <WorkItemThread thread={view.selected} columns={safeColumns} rows={threadRows} /> : null}
    </Box>
  );
}

function BoardHeader({ view, columns }: { view: WorkBoardSurfaceView; columns: number }): React.ReactElement {
  const summary = view.empty ? "" : [
    countLabel(view.summary.activeTasks, "active task"),
    countLabel(view.summary.workers, "helper"),
    countLabel(view.summary.approvals, "approval"),
    countLabel(view.summary.blockers, "blocker")
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      <Text wrap="truncate">
        <Text color={visualTokenColor("brand.focus")} bold>{fit("WORK", 16)}</Text>
        <Text color={visualTokenColor("text.muted")}>  {fitToDisplayWidth(summary || (view.empty ? EMPTY_WORK_PROMPT : view.subtitle), Math.max(10, columns - 18))}</Text>
      </Text>
      {view.summary.activity[0] ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          activity: {fitToDisplayWidth(view.summary.activity[0], Math.max(10, columns - 10))}
        </Text>
      ) : null}
    </Box>
  );
}

function BoardColumn({
  column,
  columns,
  rows,
  compact
}: {
  column: WorkBoardColumnView;
  columns: number;
  rows: number;
  compact: boolean;
}): React.ReactElement {
  const width = Math.max(14, columns);
  const itemRows = compact ? 1 : Math.max(1, rows - 2);
  return (
    <Box flexDirection="column" width={compact ? "100%" : width} marginRight={compact ? 0 : 1} overflow="hidden">
      <Text wrap="truncate">
        <Text color={visualTokenColor("role.swarm")} bold>{fit(column.count > 0 ? `${column.title} ${column.count}` : column.title, width)}</Text>
      </Text>
      {column.items.length ? column.items.slice(0, itemRows).map((item) => (
        <Box key={item.id} flexDirection="column" width="100%" overflow="hidden">
          <Text color={toneRefForWorkBoardItem(item.tone)} wrap="truncate">
            {fitToDisplayWidth(`${statusBadge(item.status)} ${item.title}`, width)}
          </Text>
          {!compact && (
            <Text color={visualTokenColor("text.muted")} wrap="truncate">
              {fitToDisplayWidth([item.owner, item.subtitle, ...item.meta].filter(Boolean).join(" · "), width)}
            </Text>
          )}
        </Box>
      )) : null}
    </Box>
  );
}

function countLabel(count: number, label: string): string | undefined {
  const value = Math.max(0, Math.floor(count));
  if (value === 0) return undefined;
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

function fit(value: string, columns: number): string {
  const width = Math.max(1, Math.floor(columns));
  const fitted = fitToDisplayWidth(value, width);
  return displayWidth(fitted) < width ? padToDisplayWidth(fitted, width) : fitted;
}
