import React from "react";
import { Box, Text } from "../ui.js";
import { displayWidth, fitToDisplayWidth, padToDisplayWidth } from "../display-width.js";
import { statusBadge, visualTokenColor } from "../theme.js";
import type { WorkBoardColumnView, WorkBoardItemView, WorkBoardSurfaceView } from "./work-board-types.js";
import { toneRefForWorkBoardItem } from "./work-board-types.js";
import { WorkItemThread } from "./WorkItemThread.js";

const EMPTY_WORK_PROMPT = "Ask Swarm to review or plan this workspace.";
const DEFAULT_EMPTY_STARTERS = ["Review this workspace", "Plan a change", "Continue previous work"];

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
        <EmptyWorkStarters actions={view.selected?.actions ?? DEFAULT_EMPTY_STARTERS} columns={safeColumns} />
      </Box>
    );
  }
  const compact = safeColumns < 92;
  const visibleColumns = view.columns.filter((column) => column.items.length > 0);
  const boardRows = compact ? Math.max(4, Math.floor(safeRows * 0.46)) : Math.max(5, Math.floor(safeRows * 0.5));
  const threadRows = Math.max(4, safeRows - boardRows - 2);
  return (
    <Box flexDirection="column" width="100%" height={safeRows} overflow="hidden">
      <BoardHeader view={view} columns={safeColumns} />
      <Box width="100%" height={boardRows} flexDirection={compact ? "column" : "row"} overflow="hidden">
        {visibleColumns.map((column) => (
          <BoardColumn key={column.id} column={column} columns={compact ? safeColumns : Math.floor(safeColumns / visibleColumns.length) - 1} rows={compact ? 3 : boardRows} compact={compact} />
        ))}
      </Box>
      {view.selected ? <WorkItemThread thread={view.selected} columns={safeColumns} rows={threadRows} /> : null}
    </Box>
  );
}

function BoardHeader({ view, columns }: { view: WorkBoardSurfaceView; columns: number }): React.ReactElement {
  const summary = view.empty ? EMPTY_WORK_PROMPT : [
    countLabel(view.summary.approvals, "approval"),
    countLabel(view.summary.blockers, "need")
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      <Text wrap="truncate">
        <Text color={visualTokenColor("brand.focus")} bold>{fit("WORK", 16)}</Text>
        <Text color={visualTokenColor("text.muted")}>  {fitToDisplayWidth(summary, Math.max(10, columns - 18))}</Text>
      </Text>
    </Box>
  );
}

function EmptyWorkStarters({ actions, columns }: { actions: string[]; columns: number }): React.ReactElement | null {
  const visible = actions.map((action) => action.trim()).filter(Boolean).slice(0, 3);
  if (!visible.length) {
    return null;
  }
  return (
    <Text color={visualTokenColor("text.muted")} wrap="truncate">
      {fitToDisplayWidth(`Start  ${visible.join("  ·  ")}`, Math.max(10, columns))}
    </Text>
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
          {!compact && boardItemDetail(item) ? (
            <Text color={visualTokenColor("text.muted")} wrap="truncate">
              {fitToDisplayWidth(boardItemDetail(item) ?? "", width)}
            </Text>
          ) : null}
        </Box>
      )) : null}
    </Box>
  );
}

function boardItemDetail(item: WorkBoardItemView): string | undefined {
  return item.tone === "warning" || item.tone === "danger" ? item.subtitle : undefined;
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
