import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor, type TuiColorRef } from "../theme.js";
import type { CollaborationOverlayTarget, TopologyStripModel } from "../collaboration-cockpit.js";

export function TopologyStrip(props: {
  model?: TopologyStripModel;
  columns: number;
  onOpen?: (target: CollaborationOverlayTarget) => void;
}): React.ReactElement | null {
  if (!props.model) {
    return null;
  }
  const mode = props.columns < 100 ? "token" : props.columns < 120 ? "abbr" : "full";
  const items = props.model.targets;
  return (
    <Box
      width="100%"
      flexDirection="row"
      borderStyle="single"
      borderColor={visualTokenColor("surface.line")}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={visualTokenColor("role.swarm")} bold>{mode === "token" ? "BD " : "BOARD "}</Text>
      {items.map((item, index) => (
        <Box
          key={item.id}
          flexDirection="row"
          marginLeft={index === 0 ? 0 : 1}
          focusable={Boolean(props.onOpen)}
          onClick={props.onOpen ? (() => props.onOpen?.(item.id)) as never : undefined}
        >
          <Text color={targetColor(item.status)} bold={item.status === "blocked" || item.status === "attention"} wrap="truncate">
            {formatTarget(item.label, item.value, mode)}
          </Text>
        </Box>
      ))}
      {mode !== "token" ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">  Enter: detail</Text>
      ) : null}
    </Box>
  );
}

function formatTarget(label: string, value: number | string, mode: "full" | "abbr" | "token"): string {
  if (label === "POL") {
    return mode === "full" ? `POLICY:${value}` : `POL:${value}`;
  }
  if (mode === "full") {
    const suffix = label === "SQ" ? "(active)" : label === "OW" ? "(blocked)" : label === "AP" ? "(wait)" : "";
    return `${label}:${value}${suffix}`;
  }
  if (mode === "abbr") {
    return `${label}:${value}`;
  }
  return `${label}${value}`;
}

function targetColor(status: TopologyStripModel["targets"][number]["status"]): TuiColorRef {
  if (status === "blocked") return "status.danger";
  if (status === "attention") return "status.warning";
  if (status === "ok") return "status.success";
  return "text.muted";
}
