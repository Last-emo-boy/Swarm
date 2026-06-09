import React from "react";
import { Box } from "../ui.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";
import { collaborationRoleDescriptor, collaborationRoleForWorker } from "../collaboration-role.js";
import type { WorkerBoardRow as WorkerBoardRowData } from "./run-board-types.js";
import { statusBadge, workerElapsedLabel } from "./run-board-row-format.js";

export function WorkerRow(props: {
  row: WorkerBoardRowData;
  selected?: boolean;
  onClick?: (row: WorkerBoardRowData) => void;
}): React.ReactElement {
  const row = props.row;
  const handleClick = props.onClick ? (() => props.onClick?.(row)) as never : undefined;
  return (
    <Box
      flexDirection="row"
      width="100%"
      focusable={props.selected}
      onClick={handleClick}
    >
      <SemanticTextLine
        wrap="truncate"
        spans={workerRowSpans(row, Boolean(props.selected))}
      />
    </Box>
  );
}

export function workerRowSpans(row: WorkerBoardRowData, selected = false): SemanticTextSpan[] {
  const tone = statusToneForRow(row.status);
  const evidence = visibleWorkerEvidence(row);
  const role = collaborationRoleDescriptor(collaborationRoleForWorker(row));
  const elapsed = workerElapsedLabel(row);
  return [
    { text: role.badge, color: role.color, bold: true },
    { text: " ", color: "text.muted" },
    { text: statusBadge(row.status), color: tone, bold: true },
    { text: " ", color: "text.muted" },
    { text: `${row.label.padEnd(15, " ")} `, color: selected ? "brand.focus" : "text.primary", bold: selected },
    { text: row.currentAction, color: "text.primary" },
    ...(elapsed
      ? [
        { text: "  ", color: "text.muted" as const },
        { text: elapsed, color: "text.muted" as const }
      ]
      : []),
    ...(evidence
      ? [
        { text: "  ", color: "text.muted" as const },
        { text: evidence, color: "text.muted" as const }
      ]
      : [])
  ];
}

function visibleWorkerEvidence(row: WorkerBoardRowData): string | undefined {
  if (row.status !== "blocked" && row.status !== "stuck" && row.status !== "failed") {
    return undefined;
  }
  const evidence = row.lastEvidence ?? (row.waitingOn ? "waiting on another task" : undefined);
  if (!evidence) {
    return undefined;
  }
  return normalizedEvidence(evidence) === normalizedEvidence(row.currentAction) ? undefined : evidence;
}

function normalizedEvidence(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function statusToneForRow(status: WorkerBoardRowData["status"]): SemanticTextSpan["color"] {
  switch (status) {
    case "done": return "status.success";
    case "failed": return "status.danger";
    case "blocked":
    case "stuck": return "status.warning";
    case "queued":
    case "waiting": return "status.pending";
    case "active": return "status.running";
  }
}
