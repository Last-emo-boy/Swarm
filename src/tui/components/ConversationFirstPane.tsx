import React from "react";
import { Box, Text } from "../ui.js";
import type { ConversationMessage } from "../conversation-layout.js";
import { visualTokenColor } from "../theme.js";
import { VirtualConversationList } from "./VirtualConversationList.js";

/** The conversation: its transcript, or two quiet lines saying how to start while it is empty. */
export function ConversationFirstPane(input: {
  messages: ConversationMessage[];
  rows: number;
  columns?: number;
  /** The workspace, named in the empty conversation's first line. */
  workspace?: string;
  scrollOffset?: number;
  newMessageCount?: number;
  unseenStartIndex?: number;
  expandedMessageKeys?: ReadonlySet<string>;
  selectedMessageIndex?: number;
  searchMatchMessageIndex?: number;
  searchMatchQuery?: string;
  tail?: React.ReactNode;
  tailRows?: number;
}): React.ReactElement {
  if (input.messages.length === 0) {
    return (
      <Box flexDirection="column" width="100%" height={input.rows} overflow="hidden" paddingTop={1}>
        <Text color={visualTokenColor("text.primary")} wrap="truncate">
          Ask anything{input.workspace ? ` about ${input.workspace}` : ""}.
        </Text>
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          / commands · ? keys
        </Text>
        <Box flexGrow={1} />
        {input.tail}
      </Box>
    );
  }
  return (
    <VirtualConversationList
      messages={input.messages}
      rows={input.rows}
      columns={input.columns}
      scrollOffset={input.scrollOffset}
      newMessageCount={input.newMessageCount}
      unseenStartIndex={input.unseenStartIndex}
      expandedMessageKeys={input.expandedMessageKeys}
      selectedMessageIndex={input.selectedMessageIndex}
      searchMatchMessageIndex={input.searchMatchMessageIndex}
      searchMatchQuery={input.searchMatchQuery}
      tailRows={input.tailRows}
      tail={input.tail}
    />
  );
}
