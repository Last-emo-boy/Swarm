import React from "react";
import { Box, Text } from "../ui.js";
import {
  compactValue,
  sectionLabel,
  visualTokenColor,
  type TuiVisualToken
} from "../theme.js";
import type { CollaborationOverlayRow, CollaborationOverlayView, ReassignIntentView } from "../collaboration-cockpit.js";
import { SemanticTextLine } from "./SemanticTextLine.js";

export function CollaborationOverlayPanel(props: {
  overlay: CollaborationOverlayView;
  selectedIndex?: number;
  reassign?: ReassignIntentView;
  filter?: string;
  filtering?: boolean;
  onRowClick?: (row: CollaborationOverlayRow, index: number) => void;
}): React.ReactElement {
  const selectedIndex = Math.max(0, Math.min(props.selectedIndex ?? 0, Math.max(0, props.overlay.rows.length - 1)));
  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={visualTokenColor("brand.focus")}
      paddingX={1}
    >
      <Text color={visualTokenColor("text.primary")} bold>{sectionLabel(props.overlay.title)}</Text>
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        {props.overlay.actions.join(" | ")}
      </Text>
      {(props.filtering || props.filter) ? (
        <Text color={visualTokenColor(props.filtering ? "brand.focus" : "text.muted")} wrap="truncate">
          Filter: /{props.filter}
        </Text>
      ) : null}
      {props.overlay.rows.length ? props.overlay.rows.map((row, index) => (
        <OverlayRow
          key={`${row.id}:${index}`}
          row={row}
          selected={index === selectedIndex}
          onClick={props.onRowClick ? () => props.onRowClick?.(row, index) : undefined}
        />
      )) : (
        <Text color={visualTokenColor("text.muted")}>{props.overlay.emptyLabel}</Text>
      )}
      {props.reassign ? (
        <Text color={visualTokenColor(reassignTone(props.reassign.policy))} wrap="truncate">
          Reassign: {props.reassign.summary} [{props.reassign.policy}] risk={props.reassign.risk}
        </Text>
      ) : null}
    </Box>
  );
}

function OverlayRow(props: {
  row: CollaborationOverlayRow;
  selected: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <SemanticTextLine
      wrap="truncate"
      onClick={props.onClick}
      spans={[
        { text: props.selected ? ">" : " ", color: props.selected ? "brand.focus" : "text.muted", bold: props.selected },
        { text: " ", color: "text.muted" },
        { text: `[${props.row.status}]`, color: toneForRow(props.row.tone), bold: true },
        { text: " ", color: "text.muted" },
        { text: compactValue(props.row.label, 46), color: props.selected ? "brand.focus" : "text.primary", bold: props.selected },
        ...(props.row.evidence ? [
          { text: "  ", color: "text.muted" as const },
          { text: compactValue(props.row.evidence, 64), color: "text.muted" as const }
        ] : [])
      ]}
    />
  );
}

function toneForRow(tone: CollaborationOverlayRow["tone"]): TuiVisualToken {
  if (tone === "blocked") return "status.danger";
  if (tone === "attention") return "status.warning";
  if (tone === "ok") return "status.success";
  return "text.muted";
}

function reassignTone(policy: ReassignIntentView["policy"]): TuiVisualToken {
  if (policy === "denied") return "status.danger";
  if (policy === "approval-required") return "status.warning";
  if (policy === "queued") return "status.success";
  return "text.muted";
}
