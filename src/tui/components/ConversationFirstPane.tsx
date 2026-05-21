import React from "react";
import { Box } from "ink";
import type { ConversationMessage } from "../conversation-layout.js";
import { ConversationLogo } from "./ConversationLogo.js";
import { VirtualConversationList } from "./VirtualConversationList.js";

export function ConversationFirstPane(input: {
  messages: ConversationMessage[];
  rows: number;
  columns?: number;
  scrollOffset?: number;
  newMessageCount?: number;
  unseenStartIndex?: number;
  expandedMessageKeys?: ReadonlySet<string>;
  selectedMessageIndex?: number;
  searchMatchMessageIndex?: number;
  tail?: React.ReactNode;
  tailRows?: number;
}): React.ReactElement {
  const showLogo = input.messages.length <= 1 && input.messages[0]?.kind === "logo";
  return (
    <Box flexDirection="column" width="100%" height={input.rows} overflow="hidden">
      {showLogo && (
        <ConversationLogo
          columns={input.columns}
          model={input.messages[0]?.detail}
          cwd={input.messages[0]?.preview}
          version={input.messages[0]?.title}
        />
      )}
      {!showLogo && (
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
          tailRows={input.tailRows}
          tail={input.tail}
        />
      )}
    </Box>
  );
}
