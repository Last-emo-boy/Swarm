import React from "react";
import { Box } from "../ui.js";
import { displayWidth, sliceByDisplayWidth } from "../display-width.js";
import { SemanticTextLine, type SemanticTextSpan } from "./SemanticTextLine.js";

/**
 * The conversation's one-line header: swarm, the model and the workspace on the left; on the right only what is not
 * the default, such as a permission mode that skips approvals or a read-only sandbox. The workspace gives way first
 * when the terminal is narrow.
 */
export function ConversationHeader(props: {
  columns: number;
  model: string;
  workspace: string;
  right?: SemanticTextSpan[];
}): React.ReactElement {
  const width = Math.max(10, props.columns - 2);
  const right = props.right ?? [];
  const rightText = right.map((span) => span.text).join("");
  const lead = `swarm  ${props.model}  `;
  const room = Math.max(0, width - displayWidth(lead) - displayWidth(rightText) - 2);
  const workspace = displayWidth(props.workspace) > room
    ? room > 1 ? `…${sliceByDisplayWidth(props.workspace, Math.max(0, displayWidth(props.workspace) - room + 1)).tail}` : ""
    : props.workspace;
  const gap = Math.max(1, width - displayWidth(lead) - displayWidth(workspace) - displayWidth(rightText));
  const spans: SemanticTextSpan[] = [
    { text: "swarm", color: "brand.focus", bold: true },
    { text: `  ${props.model}  `, color: "text.primary" },
    { text: workspace, color: "text.muted" },
    { text: " ".repeat(gap) },
    ...right
  ];
  return (
    <Box width="100%" paddingX={1}>
      <SemanticTextLine wrap="truncate" spans={spans} />
    </Box>
  );
}
