import React from "react";
import { Box, Text } from "../ui.js";
import { shortcutHint } from "../shortcuts.js";
import { resolveTuiColor, sectionLabel, visualTokenColor } from "../theme.js";

const OVERLAY_DIVIDER_WIDTH = 72;

export function PlanApprovalOverlay(props: {
  summary?: string;
  taskCount?: number;
}): React.ReactElement {
  const summary = firstLine(props.summary ?? "");
  const taskSuffix = typeof props.taskCount === "number" && props.taskCount > 0
    ? ` · ${props.taskCount} task${props.taskCount === 1 ? "" : "s"}`
    : "";
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Text color={visualTokenColor("status.pending")} wrap="truncate">
        {"─".repeat(OVERLAY_DIVIDER_WIDTH)}
      </Text>
      <Text color={visualTokenColor("status.pending")} bold wrap="truncate">
        [?] {sectionLabel("Plan Approval")} <Text color={visualTokenColor("text.muted")}>{shortcutHint(["approval.approve_once", "approval.deny"])}</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={visualTokenColor("role.gateway")}>{sectionLabel("Review")} </Text>
        <Text color={visualTokenColor("text.primary")}>{summary || "Review the generated plan before execution."}</Text>
        <Text color={visualTokenColor("text.muted")}>{taskSuffix}</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={visualTokenColor("status.pending")}>[ASK]</Text>
        <Text color={resolveTuiColor("text.muted")}> y approve · n cancel · Ctrl+O details</Text>
      </Text>
    </Box>
  );
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
}
