import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";

export function ConversationLogo(props: {
  version?: string;
  cwd?: string;
  model?: string;
  columns?: number;
}): React.ReactElement {
  const compact = Math.max(0, props.columns ?? 80) < 64;
  const cwd = compactPath(props.cwd ?? process.cwd(), compact ? 42 : 72);
  const model = props.model?.trim();
  const metadata = [props.version ? `v${props.version}` : undefined, model].filter((value): value is string => Boolean(value)).join(" · ");
  return (
    <Box flexDirection="column" alignItems="center" width="100%" marginBottom={1}>
      <Box borderStyle="round" borderColor={visualTokenColor("brand.focus")} paddingX={1} paddingY={compact ? 0 : 1} alignItems="center" flexDirection="column">
        <Text color={visualTokenColor("brand.focus")} bold>
          Swarm
        </Text>
        {!compact && <Text color={visualTokenColor("role.swarm")}>Local workspace</Text>}
        {metadata ? <Text dimColor>{metadata}</Text> : null}
        <Text dimColor wrap="truncate">
          {cwd}
        </Text>
      </Box>
      <Box flexDirection="column" width="100%" marginTop={compact ? 0 : 1}>
        <Text wrap="truncate">
          {!compact && <Text color={visualTokenColor("text.muted")}>Start with </Text>}
          <Text color={visualTokenColor("brand.focus")}>Review auth and permissions</Text>
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
