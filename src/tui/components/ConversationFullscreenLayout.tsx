import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor, type TuiColorRef } from "../theme.js";
import type { ResultCard as RuntimeResultCard } from "../../runtime/result-card.js";
import { conversationRendererContract } from "../conversation-layout.js";
import ScrollBox, { type RendererScrollBoxHandle as ScrollBoxHandle } from "../renderer/components/ScrollBox.js";
import { shortcutPhrase } from "../shortcuts.js";
import { statusBadge } from "../theme.js";

export function ConversationFullscreenLayout(props: {
  columns: number;
  rows: number;
  scrollable: React.ReactNode;
  bottom: React.ReactNode;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  completionOverlay?: React.ReactNode;
  completionOverlayRows?: number;
  bottomRows: number;
}): React.ReactElement {
  const contract = conversationRendererContract({
    rows: props.rows,
    columns: props.columns,
    bottomRows: props.bottomRows,
    completionOverlayRows: props.completionOverlay ? props.completionOverlayRows ?? 1 : undefined
  });
  const scrollableRows = contract.zones.scrollRegion.height;
  const bottomRows = contract.zones.bottomChrome.height;
  const completionOverlay = contract.zones.completionOverlay;
  return (
    <Box width={contract.columns} height={contract.rows} flexDirection="column" overflow="hidden">
      <Box
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        width="100%"
        height={scrollableRows}
        flexDirection="column"
      >
        <ScrollBox
          ref={props.scrollRef}
          width="100%"
          flexGrow={1}
          flexShrink={1}
          flexDirection="column"
          paddingX={1}
          viewportHeight={scrollableRows}
          scrollHeight={scrollableRows}
          stickyScroll
        >
          {props.scrollable}
        </ScrollBox>
        {props.completionOverlay && completionOverlay && (
          <Box
            position="absolute"
            marginTop={completionOverlay.top}
            width="100%"
            height={completionOverlay.height}
            flexDirection="column"
            overflow="hidden"
          >
            {props.completionOverlay}
          </Box>
        )}
      </Box>
      <Box
        flexShrink={0}
        width="100%"
        height={bottomRows}
        minHeight={bottomRows}
        overflow="hidden"
        flexDirection="column"
      >
        {props.bottom}
      </Box>
    </Box>
  );
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export function ConversationBottomChrome(props: {
  input: React.ReactNode;
  busy?: boolean;
  activity?: string;
  motionFrame?: number;
  resultCard?: RuntimeResultCard;
  detailAvailable?: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%">
      {props.busy && (
        <ConversationStatusLine
          message={props.activity ?? "Starting..."}
          motionFrame={props.motionFrame}
        />
      )}
      {!props.busy && props.resultCard && (
        <ConversationResultLine
          card={props.resultCard}
          detailAvailable={Boolean(props.detailAvailable)}
        />
      )}
      {props.input}
    </Box>
  );
}

export function ConversationStatusLine(props: {
  message: string;
  motionFrame?: number;
}): React.ReactElement {
  const spinner = typeof props.motionFrame === "number"
    ? SPINNER_FRAMES[props.motionFrame % SPINNER_FRAMES.length]
    : "*";
  return (
    <Text color={visualTokenColor("text.muted")} wrap="truncate">
      <Text color={visualTokenColor("status.running")}>{spinner} </Text>
      {stripActivityPrefix(props.message)}
    </Text>
  );
}

export function ConversationResultLine(props: {
  card: RuntimeResultCard;
  detailAvailable: boolean;
}): React.ReactElement {
  const changed = props.card.changedFiles.length;
  const checks = props.card.checks.length;
  return (
    <Box flexDirection="column" width="100%">
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        <Text color={resultColor(props.card.status)}>{statusBadge(props.card.status)} </Text>
        {props.card.summary}
      </Text>
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        {changed} changed · {checks} checks
        {props.detailAvailable ? ` · ${shortcutPhrase("detail.open", "details")}` : ""}
      </Text>
    </Box>
  );
}

function stripActivityPrefix(value: string): string {
  return value.replace(/^#\d+\s+/, "").trim();
}

function resultColor(status: RuntimeResultCard["status"]): TuiColorRef {
  if (status === "completed") return "status.success";
  if (status === "failed") return "status.danger";
  return "status.pending";
}
