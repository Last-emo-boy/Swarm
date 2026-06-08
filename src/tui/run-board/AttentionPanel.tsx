import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";
import type { AttentionAction, AttentionItemView } from "./run-board-types.js";
import { attentionBadge } from "./run-board-row-format.js";
import { RunBoardPanel } from "./RunBoardSurface.js";

export function AttentionPanel(props: {
  items: AttentionItemView[];
  limit?: number;
  onAction?: (item: AttentionItemView, action: AttentionAction) => void;
}): React.ReactElement | null {
  if (!props.items.length) {
    return null;
  }
  const limit = Math.max(1, props.limit ?? props.items.length);
  const visible = props.items.slice(0, limit);
  return (
    <RunBoardPanel title="Needs You">
      {visible.map((item) => (
        <Box key={item.id} flexDirection="column" width="100%">
          <SemanticTextLine wrap="truncate" spans={attentionTitleSpans(item)} />
          {item.evidence[0] ? (
            <SemanticTextLine wrap="truncate" spans={[
              { text: "  Why  ", color: "text.muted" },
              { text: item.evidence[0], color: "text.primary" }
            ]} />
          ) : null}
          <SemanticTextLine wrap="truncate" spans={[
            { text: "  Next ", color: "status.warning", bold: true },
            { text: item.recommendation, color: "text.primary" }
          ]} />
          {item.actions.length ? <AttentionActions item={item} onAction={props.onAction} /> : null}
        </Box>
      ))}
      {props.items.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.items.length - visible.length} more requests</Text>
      ) : null}
    </RunBoardPanel>
  );
}

function attentionTitleSpans(item: AttentionItemView): SemanticTextSpan[] {
  return [
    { text: attentionBadge(item.kind), color: attentionTone(item), bold: true },
    { text: " ", color: "text.muted" },
    { text: item.title, color: attentionTone(item), bold: true },
    { text: ": ", color: "text.muted" },
    { text: item.summary, color: "text.primary" }
  ];
}

function AttentionActions(props: {
  item: AttentionItemView;
  onAction?: (item: AttentionItemView, action: AttentionAction) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%">
      <Text color={visualTokenColor("text.muted")}>  </Text>
      {props.item.actions.map((action, index) => (
        <Box
          key={`${props.item.id}:${action.key}:${action.label}`}
          flexDirection="row"
          marginLeft={index > 0 ? 2 : 0}
          focusable={action.enabled !== false}
          onClick={action.enabled === false || !props.onAction
            ? undefined
            : (() => props.onAction?.(props.item, action)) as never}
        >
          <Text color={visualTokenColor(action.enabled === false ? "text.muted" : "brand.focus")} bold={action.enabled !== false}>
            [{action.key}]
          </Text>
          <Text color={visualTokenColor(action.enabled === false ? "text.muted" : "text.primary")}>
            {" "}{action.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function attentionTone(item: AttentionItemView): SemanticTextSpan["color"] {
  if (item.severity === "failed") return "status.danger";
  if (item.kind === "approval" || item.kind === "uncertain") return "status.pending";
  return "status.warning";
}
