import React, { useEffect, useMemo, useRef } from "react";
import { Box, Text } from "../ui.js";
import type { TuiActionRow, TuiActionStatus } from "../action-log.js";
import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import { shortcutHint } from "../shortcuts.js";
import { sectionLabel, visualTokenColor, type TuiColorRef } from "../theme.js";
import { SemanticTextLine, type SemanticTextSpan } from "./SemanticTextLine.js";
import { statusIconText } from "./StatusIcon.js";
import { toolResponseLineSpans } from "./ToolResponseSurface.js";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

type ActionLogLine = {
  key: string;
  text?: string;
  spans?: SemanticTextSpan[];
  color?: TuiColorRef;
  bold?: boolean;
  inverse?: boolean;
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
    color: "text.muted"
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
  const positionLabel = atBottom ? "" : "Paused";

  return (
    <Box flexDirection="column" width="100%" height={height} overflow="hidden">
      <Text wrap="truncate">
        <Text color={visualTokenColor("text.primary")} bold>{sectionLabel("Activity")}</Text>
        {positionLabel ? <Text color={visualTokenColor("text.muted")}>  {positionLabel}</Text> : null}
        {spinner ? <Text color={visualTokenColor("status.running")}> {spinner}</Text> : null}
        <Text color={visualTokenColor("text.muted")}> | {shortcutHint(["action.select", "action.details", "action.page"])}</Text>
      </Text>
      {visible.map((line) => (
        <SemanticTextLine
          key={line.key}
          wrap="truncate"
          text={line.text || " "}
          spans={line.spans}
          color={line.color}
          bold={line.bold}
          inverse={line.inverse}
        />
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
    hasTop ? { key: `above:${start}`, text: `... ${start} earlier actions`, color: visualTokenColor("text.muted") } : undefined,
    ...data,
    hasBottom ? { key: `below:${hiddenBelow}`, text: `... ${hiddenBelow} newer actions`, color: visualTokenColor("text.muted") } : undefined
  ].filter((line): line is ActionLogLine => Boolean(line));
}

function flattenRows(rows: TuiActionRow[], columns: number, selectedIndex: number | undefined): ActionLogLine[] {
  const contentWidth = Math.max(32, columns - 4);
  return rows.flatMap((row, rowIndex) => {
    const prefix = statusIconText(row.status, "badge");
    const kind = kindLabel(row.kind);
    const selected = rowIndex === selectedIndex;
    const meta = visibleActionMeta(row.meta);
    const details = visibleActionDetails(row.details);
    const lines: ActionLogLine[] = [{
      key: `${row.id}:head:${rowIndex}`,
      spans: trimSpans([
        { text: selected ? "> " : "  ", color: selected ? "brand.focus" : "text.muted", bold: selected },
        { text: `${prefix} `, color: statusColor(row.status), bold: row.status !== "info" },
        { text: `${kind} `, color: kindColor(row.kind), bold: true },
        { text: row.title, color: "text.primary", bold: selected }
      ], contentWidth)
    }];

    if (row.summary) {
      lines.push({
          key: `${row.id}:summary:${rowIndex}`,
          spans: trimSpans([
            { text: "     ", color: "text.muted" },
          ...toolResponseLineSpans(row.summary, { defaultColor: "text.primary" })
        ], contentWidth)
      });
    }

    if (meta) {
      lines.push({
          key: `${row.id}:meta:${rowIndex}`,
          spans: trimSpans([
            { text: "     ", color: "text.muted" },
          ...toolResponseLineSpans(meta, { defaultColor: "text.muted", valueColor: "text.muted", fallbackLabel: "meta" })
        ], contentWidth)
      });
    }

    const visibleDetails = details.slice(0, detailLimit(row.status));
    visibleDetails.forEach((detail, detailIndex) => {
      lines.push({
          key: `${row.id}:detail:${detailIndex}`,
          spans: trimSpans([
            { text: "       ", color: "text.muted" },
          ...toolResponseLineSpans(detail, { defaultColor: "text.primary" })
        ], contentWidth)
      });
    });
    const hidden = details.length - visibleDetails.length;
    if (hidden > 0) {
      lines.push({
        key: `${row.id}:hidden:${rowIndex}`,
        text: trimForWidth(`       ... ${hidden} more details`, contentWidth),
        color: visualTokenColor("text.muted")
      });
    }

    return lines;
  });
}

const ROUTINE_DETAIL_KEYS = new Set([
  "actor",
  "agent",
  "agent_spec",
  "approval",
  "capability",
  "correlation",
  "envelope",
  "governance",
  "id",
  "mode",
  "parent",
  "requested_by",
  "runtime",
  "session",
  "session_id",
  "source",
  "task",
  "tool",
  "turn",
  "worker",
  "worker_session"
]);

function visibleActionMeta(meta: string | undefined): string | undefined {
  if (!meta) {
    return undefined;
  }
  const normalized = meta.trim().toLowerCase();
  if (!normalized || normalized === "swarm.work.v1" || /^[a-z]+(?:_[a-z]+)*$/u.test(normalized)) {
    return undefined;
  }
  return meta;
}

function visibleActionDetails(details: string[]): string[] {
  return details
    .map((detail) => visibleActionDetail(detail))
    .filter((detail): detail is string => Boolean(detail));
}

function visibleActionDetail(detail: string): string | undefined {
  const parsed = actionDetailKeyValue(detail);
  if (!parsed) {
    return detail;
  }
  const [key, value] = parsed;
  if (ROUTINE_DETAIL_KEYS.has(key) || key === "recovery_detail") {
    return undefined;
  }
  if (key === "diagnosis" && value === "/debug latest") {
    return "Open latest diagnosis";
  }
  if (key === "recovery") {
    return `Next: ${value}`;
  }
  if (key === "error") {
    return `Error: ${value}`;
  }
  return detail;
}

function actionDetailKeyValue(detail: string): [string, string] | undefined {
  const match = detail.match(/^([a-zA-Z0-9_.-]+)=(.*)$/u);
  if (!match?.[1]) {
    return undefined;
  }
  return [match[1].toLowerCase(), match[2]?.trim() ?? ""];
}

function statusColor(status: TuiActionStatus): TuiColorRef {
  switch (status) {
    case "success": return "status.success";
    case "running": return "status.running";
    case "pending": return "status.pending";
    case "warning": return "status.warning";
    case "error": return "status.danger";
    case "info": return "text.muted";
  }
}

function kindColor(kind: string): TuiColorRef {
  const normalized = kind.toLowerCase();
  if (normalized.includes("tool") || normalized.includes("shell") || normalized.includes("usage")) {
    return "role.tool";
  }
  if (normalized.includes("gateway") || normalized.includes("lsp") || normalized.includes("provider") || normalized.includes("control")) {
    return "role.gateway";
  }
  if (normalized.includes("agent") || normalized.includes("worker") || normalized.includes("handoff") || normalized.includes("swarm") || normalized.includes("task")) {
    return "role.swarm";
  }
  if (normalized.includes("permission") || normalized.includes("approval")) {
    return "status.pending";
  }
  if (normalized.includes("user")) {
    return "role.user";
  }
  if (normalized.includes("message") || normalized.includes("assistant")) {
    return "text.muted";
  }
  return "text.primary";
}

function trimSpans(spans: SemanticTextSpan[], width: number): SemanticTextSpan[] {
  const totalWidth = spans.reduce((sum, span) => sum + displayWidth(span.text), 0);
  if (totalWidth <= width) {
    return spans.length ? spans : [{ text: " ", color: "text.muted" }];
  }

  const useEllipsis = width > 3;
  const contentLimit = Math.max(0, useEllipsis ? width - 3 : width);
  const result: SemanticTextSpan[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= contentLimit) {
      break;
    }
    const remaining = contentLimit - used;
    const spanWidth = displayWidth(span.text);
    if (spanWidth <= remaining) {
      result.push(span);
      used += spanWidth;
      continue;
    }
    const sliced = sliceByDisplayWidth(span.text, remaining).head;
    if (sliced) {
      result.push({ ...span, text: sliced });
    }
    used = contentLimit;
    break;
  }
  if (useEllipsis) {
    result.push({ text: "...", color: "text.muted" });
  }
  return result.length ? result : [{ text: " ", color: "text.muted" }];
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
