import React from "react";
import { Text } from "../ui.js";
import { resolveTuiColor } from "../theme.js";

export type ToolUseLoaderStatus = "running" | "pending" | "success" | "error" | "idle";

export function ToolUseLoader(props: {
  status?: ToolUseLoaderStatus | string;
  motionFrame?: number;
  reducedMotion?: boolean;
}): React.ReactElement {
  const status = normalizeLoaderStatus(props.status);
  const running = status === "running";
  const blinkOff = running &&
    !props.reducedMotion &&
    typeof props.motionFrame === "number" &&
    props.motionFrame % 2 === 1;
  return (
    <Text color={resolveTuiColor(loaderColor(status))} dimColor={status === "pending" || status === "idle"}>
      {blinkOff ? "  " : `${loaderGlyph(status)} `}
    </Text>
  );
}

export function loaderGlyph(status: ToolUseLoaderStatus): string {
  switch (status) {
    case "success": return "●";
    case "error": return "●";
    case "pending": return "·";
    case "running": return "●";
    case "idle": return "·";
  }
}

function normalizeLoaderStatus(status: string | undefined): ToolUseLoaderStatus {
  const normalized = (status ?? "idle").toLowerCase();
  if (["success", "completed", "complete", "passed", "ok"].includes(normalized)) return "success";
  if (["error", "failed", "failure", "cancelled", "blocked"].includes(normalized)) return "error";
  if (["pending", "queued", "waiting", "approval"].includes(normalized)) return "pending";
  if (["running", "processing", "working", "active"].includes(normalized)) return "running";
  return "idle";
}

function loaderColor(status: ToolUseLoaderStatus): string {
  switch (status) {
    case "success": return "status.success";
    case "error": return "status.danger";
    case "pending": return "status.pending";
    case "running": return "status.running";
    case "idle": return "text.muted";
  }
}
