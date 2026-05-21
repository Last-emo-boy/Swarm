import React from "react";
import { Box, Text } from "ink";
import { sectionLabel } from "../theme.js";

export function InspectorPane(props: {
  title?: string;
  sessionId?: string;
  route?: string;
  selected?: string;
  content: string;
  tabs?: string[];
}): React.ReactElement {
  const lines = props.content.split(/\r?\n/);
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      <Box borderStyle="single" borderColor="cyan" paddingX={1} width="100%">
        <Text color="cyan" bold>{sectionLabel(props.title ?? "Inspector")}</Text>
        <Text color="gray" wrap="truncate">
          {"  "}
          {props.sessionId ? `session:${props.sessionId}` : "session:-"}
          {props.route ? ` · route:${props.route}` : ""}
          {props.selected ? ` · ${props.selected}` : ""}
        </Text>
      </Box>
      {props.tabs?.length ? (
        <Text color="gray" wrap="truncate">
          tabs: {props.tabs.join(" · ")}
        </Text>
      ) : null}
      <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1} width="100%">
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`} wrap="truncate">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
