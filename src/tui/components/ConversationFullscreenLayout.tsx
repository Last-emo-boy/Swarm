import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";
import { conversationRendererContract } from "../conversation-layout.js";
import ScrollBox, { type RendererScrollBoxHandle as ScrollBoxHandle } from "../renderer/components/ScrollBox.js";

export function ConversationFullscreenLayout(props: {
  columns: number;
  rows: number;
  scrollable: React.ReactNode;
  bottom: React.ReactNode;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  completionOverlay?: React.ReactNode;
  completionOverlayRows?: number;
  bottomRows: number;
  /** A line above the transcript, such as the conversation header; `headerRows` is its height. */
  header?: React.ReactNode;
  headerRows?: number;
}): React.ReactElement {
  const headerRows = props.header ? Math.max(0, props.headerRows ?? 1) : 0;
  const contract = conversationRendererContract({
    rows: props.rows - headerRows,
    columns: props.columns,
    bottomRows: props.bottomRows,
    completionOverlayRows: props.completionOverlay ? props.completionOverlayRows ?? 1 : undefined
  });
  const scrollableRows = contract.zones.scrollRegion.height;
  const bottomRows = contract.zones.bottomChrome.height;
  const completionOverlay = contract.zones.completionOverlay;
  return (
    <Box width={contract.columns} height={contract.rows + headerRows} flexDirection="column" overflow="hidden">
      {headerRows > 0 && (
        <Box flexShrink={0} width="100%" height={headerRows} overflow="hidden" flexDirection="column">
          {props.header}
        </Box>
      )}
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The activity line while a run is busy: what runs now, for how long, and the rest in a few words. */
export function ConversationStatusLine(props: {
  message: string;
  motionFrame?: number;
  /** How long the run has taken, shown after the activity. */
  elapsedMs?: number;
  /** Counts and a key hint, such as "2 workers · Ctrl+C interrupts", shown last. */
  extra?: string;
}): React.ReactElement {
  const spinner = SPINNER_FRAMES[(props.motionFrame ?? 0) % SPINNER_FRAMES.length];
  const parts = [
    props.elapsedMs !== undefined ? formatStatusElapsed(props.elapsedMs) : "",
    props.extra ?? ""
  ].filter(Boolean);
  return (
    <Text color={visualTokenColor("text.muted")} wrap="truncate">
      <Text color={visualTokenColor("status.running")}>{spinner} </Text>
      <Text color={visualTokenColor("text.primary")}>{stripActivityPrefix(props.message)}</Text>
      {parts.length ? ` · ${parts.join(" · ")}` : ""}
    </Text>
  );
}

function formatStatusElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function stripActivityPrefix(value: string): string {
  return value.replace(/^#\d+\s+/, "").trim();
}
