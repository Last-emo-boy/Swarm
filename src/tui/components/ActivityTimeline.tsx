import React from "react";
import { Box, Text } from "../ui.js";
import { compactValue, sectionLabel, statusTone, visualTokenColor, type TuiColorRef } from "../theme.js";
import type { TuiDensity } from "../conversation-layout.js";
import { SemanticTextLine, type SemanticTextSpan } from "./SemanticTextLine.js";

export function ActivityTimeline(props: {
  title?: string;
  items: string[];
  emptyLabel?: string;
  limit?: number;
  density?: TuiDensity;
}): React.ReactElement {
  const density = props.density ?? "default";
  const limit = activityTimelineLimit(props.limit, density);
  return (
    <Box flexDirection="column" width="100%">
      {density !== "compact" ? <Text color={visualTokenColor("text.primary")} bold>{sectionLabel(props.title ?? "Progress")}</Text> : null}
      {props.items.length ? props.items.slice(-limit).map((item, index) => (
        <SemanticTextLine
          key={`${index}-${item}`}
          spans={activityTimelineSpans(item, density)}
          wrap="truncate"
        />
      )) : (
        <Text color={visualTokenColor("text.muted")}>{props.emptyLabel ?? "(none)"}</Text>
      )}
    </Box>
  );
}

export function activityTimelineLimit(limit: number | undefined, density: TuiDensity): number {
  const requested = Math.max(1, limit ?? 3);
  if (density === "compact") {
    return Math.min(requested, 2);
  }
  if (density === "comfortable") {
    return requested;
  }
  return Math.min(requested, 4);
}

export function activityTimelineSpans(item: string, density: TuiDensity): SemanticTextSpan[] {
  const compacted = compactValue(item, density === "compact" ? 96 : 140);
  const phase = compacted.match(/^([^:]{1,32}):\s*(.*)$/u);
  const markerColor = activityTimelineTone(phase?.[1] ?? compacted);
  const prefix = density === "comfortable" ? "- " : "";
  if (!phase) {
    return [
      { text: prefix, color: markerColor },
      { text: compacted, color: density === "compact" ? "text.muted" : "text.primary" }
    ];
  }

  const label = phase[1] ?? "";
  const body = phase[2] ?? "";
  return [
    { text: prefix, color: markerColor },
    { text: label, color: markerColor, bold: density === "comfortable" },
    { text: ": ", color: "text.muted" },
    { text: body, color: density === "compact" ? "text.muted" : "text.primary" }
  ];
}

function activityTimelineTone(value: string): TuiColorRef {
  const normalized = value.toLowerCase().replace(/[_-]/g, " ");
  if (/\b(failed|error|denied)\b/u.test(normalized)) return "status.danger";
  if (/\b(stopped|waiting|approval|blocked|warn)\b/u.test(normalized)) return "status.warning";
  if (/\b(completed|done|success|pass|ok)\b/u.test(normalized)) return "status.success";
  if (/\b(tool|running|thinking|turn|started|executing)\b/u.test(normalized)) return "status.running";
  const tone = statusTone(value);
  return tone === "muted" ? "text.muted" : tone;
}
