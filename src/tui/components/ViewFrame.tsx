import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";

/**
 * The frame every full-screen view shares: a title with a short summary, a rule, the body, and the keys that work here.
 * While an approval or a plan waits, its card takes the key row's place, so a decision is never hidden behind a view.
 */
export function ViewFrame(props: {
  title: string;
  summary?: string;
  columns: number;
  height: number;
  keys: string;
  /** A card shown instead of the key row; `bottomRows` is its height. */
  bottom?: React.ReactNode;
  bottomRows?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const bottomRows = props.bottom ? Math.max(1, props.bottomRows ?? 1) : 1;
  return (
    <Box flexDirection="column" width={props.columns} height={props.height} overflow="hidden">
      <Box
        paddingX={1}
        width="100%"
        flexShrink={0}
        borderStyle="single"
        borderColor={visualTokenColor("surface.line")}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text wrap="truncate">
          <Text color={visualTokenColor("brand.focus")} bold>{props.title}</Text>
          {props.summary ? <Text color={visualTokenColor("text.muted")}>{`  ${props.summary}`}</Text> : null}
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} height={viewBodyRows(props.height, bottomRows)} overflow="hidden" paddingX={1} width="100%">
        {props.children}
      </Box>
      <Box flexDirection="column" flexShrink={0} width="100%" height={bottomRows} overflow="hidden">
        {props.bottom ?? (
          <Box paddingX={1} width="100%">
            <Text color={visualTokenColor("text.muted")} wrap="truncate">{props.keys}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** Rows a view's body gets: the frame takes the title, its rule, and the key row or the card in its place. */
export function viewBodyRows(height: number, bottomRows = 1): number {
  return Math.max(1, height - 2 - Math.max(1, bottomRows));
}
