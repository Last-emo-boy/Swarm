import React from "react";
import { Box, Text } from "../ui.js";
import { sectionLabel, visualTokenColor, type TuiResolvedColor } from "../theme.js";
import type { TuiDensity } from "../conversation-layout.js";
import { ToolResponseSurface } from "./ToolResponseSurface.js";

export function InspectorPane(props: {
  title?: string;
  sessionId?: string;
  route?: string;
  selected?: string;
  content: string;
  tabs?: string[];
  density?: TuiDensity;
}): React.ReactElement {
  const lines = props.content.split(/\r?\n/);
  const density = props.density ?? "default";
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Box borderStyle="single" borderColor={inspectorBorderColor(props.title)} paddingX={1} width="100%">
        <Text color={visualTokenColor("text.primary")} bold>{sectionLabel(props.title ?? "Inspector")}</Text>
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {"  "}
          {props.sessionId ? `session:${props.sessionId}` : "session:-"}
          {props.route && density !== "compact" ? ` · route:${props.route}` : ""}
          {props.selected && density !== "compact" ? ` · ${props.selected}` : ""}
        </Text>
      </Box>
      {props.tabs?.length && density !== "compact" ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          tabs: {props.tabs.join(" · ")}
        </Text>
      ) : null}
      <Box borderStyle="single" borderColor={visualTokenColor("surface.line")} flexDirection="column" paddingX={1} width="100%">
        <ToolResponseSurface lines={lines} wrap="wrap" defaultColor="text.primary" />
      </Box>
    </Box>
  );
}

function inspectorBorderColor(title: string | undefined): TuiResolvedColor {
  const normalized = (title ?? "").toLowerCase();
  if (normalized.includes("command") || normalized.includes("output")) {
    return visualTokenColor("role.tool");
  }
  if (normalized.includes("gateway") || normalized.includes("lsp") || normalized.includes("provider")) {
    return visualTokenColor("role.gateway");
  }
  if (normalized.includes("approval") || normalized.includes("risk")) {
    return visualTokenColor("status.warning");
  }
  return visualTokenColor("brand.focus");
}
