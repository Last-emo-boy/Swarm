import React from "react";
import { Box, Text } from "../ui.js";
import { displayWidth } from "../display-width.js";
import { visualTokenColor, type TuiVisualToken } from "../theme.js";
import type { StatusItem, StatusItemId, StatusItemTone } from "../status-line.js";

const TONES: Record<StatusItemTone, TuiVisualToken> = {
  accent: "brand.focus",
  danger: "status.danger",
  warning: "status.warning",
  muted: "text.muted"
};

/**
 * One row under the prompt: the status items, as many as fit, and the hint at the right. An item opens its view when
 * clicked.
 */
export function StatusLine(props: {
  items: readonly StatusItem[];
  hint: string;
  columns: number;
  onItemClick?: (id: StatusItemId) => void;
}): React.ReactElement {
  const width = Math.max(10, props.columns - 4);
  const hintWidth = props.hint ? displayWidth(props.hint) + 2 : 0;
  const shown: StatusItem[] = [];
  let used = 0;
  for (const item of props.items) {
    const cost = displayWidth(item.text) + (shown.length ? 3 : 0);
    if (used + cost > width - hintWidth) {
      break;
    }
    shown.push(item);
    used += cost;
  }
  const gap = Math.max(1, width - used - (props.hint ? displayWidth(props.hint) : 0));
  // Sibling texts in a row, not spans of one text: a click lands on the element under the mouse, and spans have none.
  return (
    <Box width="100%" paddingX={1} flexShrink={0} flexDirection="row">
      <Text>{"  "}</Text>
      {shown.map((item, index) => (
        <React.Fragment key={`${item.id}:${index}`}>
          {index > 0 ? <Text color={visualTokenColor("text.muted")}>{" · "}</Text> : null}
          <Text
            color={visualTokenColor(TONES[item.tone])}
            onClick={props.onItemClick ? (() => props.onItemClick?.(item.id)) as never : undefined}
          >
            {item.text}
          </Text>
        </React.Fragment>
      ))}
      {props.hint ? <Text color={visualTokenColor("text.muted")}>{" ".repeat(gap)}{props.hint}</Text> : null}
    </Box>
  );
}
