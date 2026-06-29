// Discoverability hint for the worker rail toggle in the active layout.
// Only shown while busy and the rail is hidden — once the rail is open its own
// header already surfaces the Ctrl+R shortcut, so the hint would be redundant.
import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";
import { shortcutHint } from "../shortcuts.js";

export function RailHint(props: { visible: boolean }): React.ReactElement | null {
  if (!props.visible) {
    return null;
  }
  return (
    <Box width="100%" paddingX={1}>
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        {shortcutHint(["run-board.toggle_rail"])}
      </Text>
    </Box>
  );
}
