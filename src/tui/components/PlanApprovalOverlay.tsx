import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";

/** The plan approval card in place of the prompt, in the approval card's shape: the plan, then the keys. */
export function PlanApprovalOverlay(props: {
  summary?: string;
  taskCount?: number;
}): React.ReactElement {
  const summary = firstLine(props.summary ?? "") || "Review the generated plan before it runs.";
  const tasks = typeof props.taskCount === "number" && props.taskCount > 0
    ? ` · ${props.taskCount} task${props.taskCount === 1 ? "" : "s"}`
    : "";
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Box
        flexDirection="column"
        paddingX={1}
        width="100%"
        borderStyle="single"
        borderColor={visualTokenColor("status.pending")}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text wrap="truncate">
          <Text color={visualTokenColor("status.pending")} bold>? </Text>
          <Text color={visualTokenColor("text.primary")} bold>Run this plan</Text>
          <Text color={visualTokenColor("text.primary")}>{`  ${summary}`}</Text>
          <Text color={visualTokenColor("text.muted")}>{tasks}</Text>
        </Text>
        <Text color={visualTokenColor("text.muted")} wrap="truncate">  y yes · n no · Ctrl+O plan</Text>
      </Box>
    </Box>
  );
}

/** Rows the plan card takes: the rule, the plan, the keys. */
export const PLAN_CARD_ROWS = 3;

function firstLine(value: string): string {
  return value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
}
