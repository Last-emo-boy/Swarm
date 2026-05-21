import React, { useEffect, useMemo, useRef } from "react";
import { Box, Text } from "ink";
import type { TuiActionRow, TuiActionStatus } from "../action-log.js";
import { compactValue, sectionLabel, statusBadge, statusTone, toneColor } from "../theme.js";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

type ActionLogLine = {
  key: string;
  text: string;
  color?: string;
  bold?: boolean;
};

export function ActionLog(props: {
  rows: TuiActionRow[];
  height: number;
  columns: number;
  scrollOffset: number;
  onScrollOffsetChange: (offset: number) => void;
  motionFrame?: number;
  selectedIndex?: number;
}): React.ReactElement {
  const { rows, columns, scrollOffset, onScrollOffsetChange, motionFrame, selectedIndex } = props;
  const height = Math.max(4, props.height);
  const bodyHeight = Math.max(1, height - 1);
  const lines = useMemo(() => flattenRows(rows, columns, selectedIndex), [rows, columns, selectedIndex]);
  const previousLineCount = useRef(lines.length);

  useEffect(() => {
    const previous = previousLineCount.current;
    const delta = lines.length - previous;
    previousLineCount.current = lines.length;
    if (delta > 0 && scrollOffset > 0) {
      onScrollOffsetChange(scrollOffset + delta);
    }
  }, [lines.length, onScrollOffsetChange, scrollOffset]);

  const displayLines = lines.length ? lines : [{
    key: "empty",
    text: "No actions yet.",
    color: "gray"
  }];
  const lineCount = displayLines.length;
  const maxOffset = Math.max(0, lineCount - bodyHeight);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const atBottom = clampedOffset === 0;
  const spinner = typeof motionFrame === "number" ? SPINNER_FRAMES[motionFrame % SPINNER_FRAMES.length] : undefined;

  useEffect(() => {
    if (clampedOffset !== scrollOffset) {
      onScrollOffsetChange(clampedOffset);
    }
  }, [clampedOffset, onScrollOffsetChange, scrollOffset]);

  const start = Math.max(0, lineCount - bodyHeight - clampedOffset);
  const visible = windowLines(displayLines, start, bodyHeight);
  const bottomState = atBottom ? "following" : `${clampedOffset} lines from bottom`;

  return (
    <Box flexDirection="column" width="100%" height={height} overflow="hidden">
      <Text wrap="truncate">
        <Text color="cyan" bold>{sectionLabel("Action Log")}</Text>
        <Text color="gray">  {rows.length} actions | {lines.length} lines | {bottomState}</Text>
        {spinner ? <Text color="cyan"> {spinner}</Text> : null}
        <Text color="gray"> | Up/Down select | Enter details | PgUp/PgDn</Text>
      </Text>
      {visible.map((line) => (
        <Text key={line.key} wrap="truncate" color={line.color} bold={line.bold}>
          {line.text || " "}
        </Text>
      ))}
    </Box>
  );
}

function windowLines(lines: ActionLogLine[], start: number, bodyHeight: number): ActionLogLine[] {
  const hasTop = start > 0;
  let dataSlots = Math.max(0, bodyHeight - (hasTop ? 1 : 0));
  let data = lines.slice(start, start + dataSlots);
  let hiddenBelow = Math.max(0, lines.length - (start + data.length));
  const hasBottom = hiddenBelow > 0 && dataSlots > 0;

  if (hasBottom) {
    dataSlots = Math.max(0, dataSlots - 1);
    data = lines.slice(start, start + dataSlots);
    hiddenBelow = Math.max(0, lines.length - (start + data.length));
  }

  return [
    hasTop ? { key: `above:${start}`, text: `... ${start} earlier actions`, color: "gray" } : undefined,
    ...data,
    hasBottom ? { key: `below:${hiddenBelow}`, text: `... ${hiddenBelow} newer actions`, color: "gray" } : undefined
  ].filter((line): line is ActionLogLine => Boolean(line));
}

function flattenRows(rows: TuiActionRow[], columns: number, selectedIndex: number | undefined): ActionLogLine[] {
  const contentWidth = Math.max(32, columns - 4);
  return rows.flatMap((row, rowIndex) => {
    const prefix = statusBadge(row.status);
    const kind = kindLabel(row.kind);
    const selected = rowIndex === selectedIndex;
    const lines: ActionLogLine[] = [{
      key: `${row.id}:head:${rowIndex}`,
      text: trimForWidth(`${selected ? ">" : " "} ${prefix} ${kind} ${row.title}`, contentWidth),
      color: statusColor(row.status),
      bold: selected || row.status === "pending" || row.status === "error"
    }];

    if (row.summary) {
      lines.push({
        key: `${row.id}:summary:${rowIndex}`,
        text: trimForWidth(`     ${compactValue(row.summary, contentWidth - 5)}`, contentWidth),
        color: row.status === "error" ? "red" : undefined
      });
    }

    if (row.meta) {
      lines.push({
        key: `${row.id}:meta:${rowIndex}`,
        text: trimForWidth(`     ${row.meta}`, contentWidth),
        color: "gray"
      });
    }

    const visibleDetails = row.details.slice(0, detailLimit(row.status));
    visibleDetails.forEach((detail, detailIndex) => {
      lines.push({
        key: `${row.id}:detail:${detailIndex}`,
        text: trimForWidth(`       ${detail}`, contentWidth),
        color: detailColor(row.status)
      });
    });
    const hidden = row.details.length - visibleDetails.length;
    if (hidden > 0) {
      lines.push({
        key: `${row.id}:hidden:${rowIndex}`,
        text: trimForWidth(`       ... ${hidden} more details`, contentWidth),
        color: "gray"
      });
    }

    return lines;
  });
}

function statusMarker(status: TuiActionStatus): string {
  switch (status) {
    case "success": return "OK";
    case "running": return "..";
    case "pending": return "??";
    case "warning": return "!!";
    case "error": return "XX";
    case "info": return "--";
  }
}

function statusColor(status: TuiActionStatus): string {
  return toneColor(statusTone(status));
}

function detailColor(status: TuiActionStatus): string | undefined {
  if (status === "error") {
    return "red";
  }
  if (status === "warning" || status === "pending") {
    return "yellow";
  }
  return "gray";
}

function trimForWidth(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}

function detailLimit(status: TuiActionStatus): number {
  if (status === "error") {
    return 5;
  }
  if (status === "warning" || status === "pending") {
    return 3;
  }
  return 1;
}

function kindLabel(kind: string): string {
  const normalized = kind.replace(/^work:/, "").replace(/^message:/, "");
  const short = normalized.length > 10 ? normalized.slice(0, 10) : normalized;
  return `[${short.toUpperCase()}]`;
}
