import React from "react";
import { Box } from "../ui.js";
import { SemanticTextLine, truncateSpans, truncateText } from "./SemanticTextLine.js";
import { displayWidth } from "../display-width.js";
import type { NeedsYouItem } from "../tickets/view-model.js";

/**
 * What waits for a person, above the prompt: a heading, then one line per ticket with its marker, handle, title, what it
 * needs and the command that answers it. It takes no space while nothing waits.
 */
export function NeedsYouStrip(props: { items: readonly NeedsYouItem[]; columns: number; limit?: number }): React.ReactElement | null {
  const limit = props.limit ?? 3;
  if (!props.items.length) return null;
  const rule = "─".repeat(Math.max(0, props.columns - 26));
  const shown = props.items.slice(0, limit);
  const more = props.items.length - shown.length;
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <SemanticTextLine wrap="truncate" spans={truncateSpans([
        { text: "── needs you ", color: "status.pending", bold: true },
        { text: rule, color: "surface.line" },
        { text: " /tickets", color: "text.muted" }
      ], Math.max(20, props.columns - 2))} />
      {shown.map((item) => {
        // The command that answers an item stays visible: the title gets at most about half of what is left, the need the rest.
        const width = Math.max(20, props.columns - 2);
        const action = `  ${item.action}`;
        const fixed = 2 + displayWidth(item.short) + 1 + displayWidth(action);
        const remaining = Math.max(10, width - fixed);
        const title = truncateText(item.title, Math.max(8, Math.min(displayWidth(item.title), Math.floor(remaining * 0.5))));
        const need = truncateText(`  ${item.need}`, Math.max(0, remaining - displayWidth(title)));
        return (
          <SemanticTextLine key={item.id} wrap="truncate" spans={truncateSpans([
            { text: `${item.marker} `, color: item.tone, bold: true },
            { text: `${item.short} `, color: "text.muted" },
            { text: title, color: "text.primary" },
            { text: need, color: item.tone },
            { text: action, color: "text.muted", dim: true }
          ], width)} />
        );
      })}
      {more > 0 && <SemanticTextLine wrap="truncate" spans={[{ text: `+${more} more · /tickets`, color: "text.muted" }]} />}
    </Box>
  );
}
