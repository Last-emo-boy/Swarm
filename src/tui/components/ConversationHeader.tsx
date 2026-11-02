import React from "react";
import { Box } from "../ui.js";
import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import { SemanticTextLine, type SemanticTextSpan } from "./SemanticTextLine.js";

/**
 * The conversation's one-line header: Swarm, the model and the workspace on the left, the route, permission and sandbox
 * on the right. The left side gives way first when the terminal is narrow.
 */
export function ConversationHeader(props: {
  columns: number;
  model: string;
  workspace: string;
  right: SemanticTextSpan[];
}): React.ReactElement {
  const width = Math.max(10, props.columns - 2);
  const rightText = props.right.map((span) => span.text).join("");
  const room = Math.max(0, width - displayWidth(rightText) - 2);
  const leftText = `Swarm · ${props.model} · ${props.workspace}`;
  const left = displayWidth(leftText) > room ? `${sliceByDisplayWidth(leftText, Math.max(0, room - 1)).head}…` : leftText;
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(rightText));
  const swarmEnd = Math.min(left.length, "Swarm".length);
  const spans: SemanticTextSpan[] = [
    { text: left.slice(0, swarmEnd), color: "brand.focus", bold: true },
    { text: left.slice(swarmEnd), color: "text.muted" },
    { text: " ".repeat(gap) },
    ...props.right
  ];
  return (
    <Box width="100%" paddingX={1}>
      <SemanticTextLine wrap="truncate" spans={spans} />
    </Box>
  );
}
