import React from "react";
import { Box, Text } from "ink";
import { sectionLabel } from "../theme.js";

export function ActivityTimeline(props: {
  title?: string;
  items: string[];
  emptyLabel?: string;
  limit?: number;
}): React.ReactElement {
  const limit = Math.max(1, props.limit ?? 3);
  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" bold>{sectionLabel(props.title ?? "Progress")}</Text>
      {props.items.length ? props.items.slice(-limit).map((item, index) => (
        <Text key={`${index}-${item}`} color="gray" wrap="truncate">
          - {item}
        </Text>
      )) : (
        <Text color="gray">{props.emptyLabel ?? "(none)"}</Text>
      )}
    </Box>
  );
}
