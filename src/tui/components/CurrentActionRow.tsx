import React from "react";
import { Box, Text } from "../ui.js";
import { defaultToneColor, resolveTuiColor, statusTone, visualTokenColor, type TuiColor, type TuiColorRef } from "../theme.js";
import type { TuiDensity } from "../conversation-layout.js";
import { StatusIcon } from "./StatusIcon.js";
import { ToolUseLoader } from "./ToolUseLoader.js";

export function CurrentActionRow(props: {
  message: string;
  phase?: string;
  status?: string;
  tone?: TuiColorRef;
  color?: TuiColor;
  progress?: string;
  needYou?: string;
  motionFrame?: number;
  density?: TuiDensity;
}): React.ReactElement {
  const secondary = [props.phase, props.progress].filter(Boolean).join(" · ");
  const density = props.density ?? "default";
  const status = props.status ?? statusFromColor(props.color);
  const tone = props.tone ?? statusTone(status);
  return (
    <Box flexDirection="column" width="100%">
      <Text wrap="truncate">
        <StatusIcon status={status} label="badge" withSpace />
        <Text color={visualTokenColor("text.muted")}>now </Text>
        <ToolUseLoader status={status} motionFrame={props.motionFrame} reducedMotion={props.motionFrame === undefined} />
        <Text color={visualTokenColor("text.primary")}>{props.message}</Text>
        {secondary && density !== "compact" ? <Text color={visualTokenColor("text.muted")}> · {secondary}</Text> : null}
      </Text>
      {props.needYou && density !== "compact" ? (
        <Text wrap="truncate">
          <StatusIcon status="pending" label="badge" withSpace />
          <Text color={visualTokenColor("text.muted")}>you </Text>
          <Text color={visualTokenColor("status.pending")}>{props.needYou}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

function statusFromColor(color: TuiColor | undefined): string {
  if (color === defaultToneColor("success")) return "completed";
  if (color === defaultToneColor("pending")) return "pending";
  if (color === defaultToneColor("danger")) return "failed";
  if (color === defaultToneColor("running")) return "running";
  return "info";
}
