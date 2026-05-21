import React from "react";
import { Box, Text } from "ink";
import { statusBadge, toneColor } from "../theme.js";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export function CurrentActionRow(props: {
  message: string;
  phase?: string;
  color?: "cyan" | "green" | "yellow" | "red" | "gray";
  progress?: string;
  needYou?: string;
  motionFrame?: number;
}): React.ReactElement {
  const secondary = [props.phase, props.progress].filter(Boolean).join(" · ");
  const tone = colorTone(props.color);
  const spinner = typeof props.motionFrame === "number" && props.color !== "gray"
    ? SPINNER_FRAMES[props.motionFrame % SPINNER_FRAMES.length]
    : undefined;
  return (
    <Box flexDirection="column" width="100%">
      <Text wrap="truncate">
        <Text color={toneColor(tone)}>{statusBadge(statusFromColor(props.color))} </Text>
        <Text color="gray">now </Text>
        {spinner ? <Text color={props.color ?? "cyan"}>{spinner} </Text> : null}
        <Text color={props.color ?? "cyan"}>{props.message}</Text>
        {secondary ? <Text color="gray"> · {secondary}</Text> : null}
      </Text>
      {props.needYou ? (
        <Text wrap="truncate">
          <Text color="yellow">{statusBadge("pending")} </Text>
          <Text color="gray">you </Text>
          <Text color="yellow">{props.needYou}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

function statusFromColor(color: "cyan" | "green" | "yellow" | "red" | "gray" | undefined): string {
  if (color === "green") return "completed";
  if (color === "yellow") return "pending";
  if (color === "red") return "failed";
  if (color === "cyan") return "running";
  return "info";
}

function colorTone(color: "cyan" | "green" | "yellow" | "red" | "gray" | undefined): "muted" | "success" | "running" | "pending" | "danger" {
  if (color === "green") return "success";
  if (color === "yellow") return "pending";
  if (color === "red") return "danger";
  if (color === "cyan") return "running";
  return "muted";
}
