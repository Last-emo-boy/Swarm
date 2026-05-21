import React from "react";
import { Box, Text } from "ink";

export function ConversationLogo(props: {
  version?: string;
  cwd?: string;
  model?: string;
  columns?: number;
}): React.ReactElement {
  const compact = Math.max(0, props.columns ?? 80) < 64;
  const cwd = compactPath(props.cwd ?? process.cwd(), compact ? 42 : 72);
  const model = props.model?.trim() || "model not configured";
  return (
    <Box flexDirection="column" alignItems="center" width="100%" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} paddingY={compact ? 0 : 1} alignItems="center" flexDirection="column">
        <Text color="cyan" bold>
          {compact ? "Symphony Swarm" : "Symphony Swarm"}
        </Text>
        {!compact && <Text color="cyan">Local Agent OS</Text>}
        <Text dimColor>
          {props.version ? `v${props.version} · ` : ""}{model}
        </Text>
        <Text dimColor wrap="truncate">
          {cwd}
        </Text>
      </Box>
    </Box>
  );
}

function compactPath(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `...${value.slice(Math.max(0, value.length - maxLength + 3))}`;
}
