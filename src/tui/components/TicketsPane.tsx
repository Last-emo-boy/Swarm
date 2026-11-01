import React from "react";
import { Box } from "../ui.js";
import { SemanticTextLine, truncateSpans, type SemanticTextSpan } from "./SemanticTextLine.js";
import { ticketsPaneLines, type TicketsPaneLine } from "../tickets/view-model.js";
import type { TicketGroup, TicketRow } from "../../superagent/views.js";
import type { TuiColorRef } from "../theme.js";

const GROUP_COLORS: Record<TicketGroup, TuiColorRef> = {
  person: "status.pending",
  working: "status.running",
  queued: "text.muted",
  idle: "text.muted",
  ended: "text.muted"
};
const marker = (row: TicketRow): { text: string; color: TuiColorRef } => {
  if (row.group === "person") {
    if (row.label === "Awaiting answer") return { text: "?", color: "status.pending" };
    if (row.label === "Blocked" || row.label === "Failed") return { text: "×", color: "status.danger" };
    return { text: "!", color: "status.warning" };
  }
  if (row.group === "working") return { text: "●", color: "status.running" };
  if (row.group === "ended") return { text: row.label === "Completed" || row.label === "Pull request merged" ? "✓" : "·", color: row.label === "Completed" || row.label === "Pull request merged" ? "status.success" : "text.muted" };
  return { text: "·", color: "text.muted" };
};

function lineSpans(line: TicketsPaneLine): SemanticTextSpan[] {
  if (line.kind === "empty") return [{ text: line.text, color: "text.muted" }];
  if (line.kind === "group") return [{ text: line.text, color: GROUP_COLORS[line.group], bold: true }];
  const { row } = line;
  const sign = marker(row);
  return [
    { text: line.selected ? "▸ " : "  ", color: "brand.focus", bold: true },
    { text: `${sign.text} `, color: sign.color, bold: true },
    { text: `${row.short}  `, color: "text.muted" },
    { text: row.title, color: line.selected ? "brand.focus" : "text.primary", bold: line.selected },
    { text: `  ${row.label}${row.pr ? ` · PR #${row.pr}` : ""} · ${row.source}`, color: "text.muted" },
    ...(row.question && row.group === "person" ? [{ text: `  asks: ${row.question}`, color: "status.pending" as const }] : [])
  ];
}

/**
 * The tickets pane: tickets grouped by what each waits for, what needs a person first, with the selected one marked and
 * kept in view. Keys: ↑↓ select, Enter open, s stop, r retry, Esc back to the conversation.
 */
export function TicketsPane(props: { rows: readonly TicketRow[]; selected: number; columns: number; height: number; summary: string; hosting: boolean }): React.ReactElement {
  const lines = ticketsPaneLines(props.rows, props.selected);
  const body = Math.max(1, props.height - 3);
  const at = Math.max(0, lines.findIndex((line) => line.kind === "ticket" && line.selected));
  const start = Math.max(0, Math.min(at - Math.floor(body / 2), lines.length - body));
  const visible = lines.slice(start, start + body);
  return (
    <Box flexDirection="column" width={props.columns} height={props.height} paddingX={1} overflow="hidden">
      <SemanticTextLine wrap="truncate" spans={[
        { text: "Tickets", color: "brand.focus", bold: true },
        { text: ` · ${props.summary}${props.hosting ? " · host in this TUI" : ""}`, color: "text.muted" }
      ]} />
      <SemanticTextLine wrap="truncate" spans={[{ text: "─".repeat(Math.max(0, props.columns - 2)), color: "surface.line" }]} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((line, index) => <SemanticTextLine key={`${start + index}`} wrap="truncate" spans={truncateSpans(lineSpans(line), props.columns - 2)} />)}
      </Box>
      <SemanticTextLine wrap="truncate" spans={[{ text: "↑↓ select · ⏎ open · s stop · r retry · Esc back · /ticket <request> files one", color: "text.muted" }]} />
    </Box>
  );
}
