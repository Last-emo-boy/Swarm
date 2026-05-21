import React from "react";
import { Box, Text } from "ink";
import type { ResultCard as RuntimeResultCard } from "../../runtime/result-card.js";
import ScrollBox, { type ScrollBoxHandle } from "../ink/ScrollBox.js";
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
  const bottomRows = Math.max(1, Math.min(props.bottomRows, props.rows - 1));
  const scrollableRows = Math.max(1, props.rows - bottomRows);
  const completionOverlayRows = Math.max(1, Math.min(props.completionOverlayRows ?? 1, scrollableRows));
  return (
    <Box width={props.columns} height={props.rows} flexDirection="column" overflow="hidden">
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
        {props.completionOverlay && (
          <Box
            position="absolute"
            marginTop={Math.max(0, scrollableRows - completionOverlayRows)}
            width="100%"
            height={completionOverlayRows}
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
    <Text color="gray" wrap="truncate">
      <Text color="cyan">{spinner} </Text>
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
      <Text color="gray" wrap="truncate">
        <Text color={resultColor(props.card.status)}>{statusBadge(props.card.status)} </Text>
        {props.card.summary}
      </Text>
      <Text color="gray" wrap="truncate">
        {changed} changed · {checks} checks
        {props.detailAvailable ? " · Ctrl+O for details" : ""}
      </Text>
    </Box>
  );
}

function stripActivityPrefix(value: string): string {
  return value.replace(/^#\d+\s+/, "").trim();
}

function resultColor(status: RuntimeResultCard["status"]): "green" | "yellow" | "red" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  return "yellow";
}
