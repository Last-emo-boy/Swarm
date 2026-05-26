import React from "react";
import { Text } from "../ui.js";
import {
  type ConversationLine,
  type ConversationLineSpan,
  type ConversationMessage
} from "../conversation-layout.js";
import { resolveTuiColor, toneColor, visualTokenColor, type TuiResolvedColor } from "../theme.js";

export function TranscriptRow({ line }: { line: ConversationLine }): React.ReactElement {
  const spans = line.spans?.length ? line.spans : undefined;
  if (!spans) {
    return (
      <Text
        wrap="wrap"
        color={lineColor(line)}
        backgroundColor={resolveTuiColor(line.backgroundColor)}
        bold={line.bold}
        dimColor={line.dim}
        inverse={line.selected && !line.backgroundColor}
      >
        {line.text}
      </Text>
    );
  }
  return (
    <Text
      wrap="wrap"
      backgroundColor={resolveTuiColor(line.backgroundColor)}
      inverse={line.selected && !line.backgroundColor}
    >
      {spans.map((span, index) => (
        <Text
          key={`${index}:${span.text}`}
          color={spanColor(span, line)}
          backgroundColor={spanBackgroundColor(span, line)}
          bold={span.bold ?? line.bold}
          dimColor={span.dim ?? line.dim}
          underline={span.underline}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

function spanColor(span: ConversationLineSpan, line: ConversationLine): TuiResolvedColor {
  if (span.color) {
    return resolveTuiColor(span.color);
  }
  return span.tone ? toneColor(span.tone) : lineColor(line);
}

function spanBackgroundColor(span: ConversationLineSpan, line: ConversationLine): TuiResolvedColor {
  if (span.backgroundColor === "surface.searchMatch") {
    return resolveTuiColor(span.backgroundColor);
  }
  if (line.selected && line.backgroundColor) {
    return resolveTuiColor(line.backgroundColor);
  }
  return resolveTuiColor(span.backgroundColor ?? line.backgroundColor);
}

function roleColor(role: ConversationMessage["role"]): TuiResolvedColor {
  if (role === "assistant") {
    return visualTokenColor("role.assistant");
  }
  if (role === "system") {
    return visualTokenColor("text.muted");
  }
  return visualTokenColor("role.user");
}

function lineColor(line: ConversationLine): TuiResolvedColor {
  if (line.tone) {
    return toneColor(line.tone);
  }
  if (line.kind === "heading") {
    return visualTokenColor("brand.focus");
  }
  if (line.kind === "code" || line.kind === "quote" || line.kind === "divider") {
    return visualTokenColor("text.muted");
  }
  if (line.kind === "table") {
    return line.dim ? visualTokenColor("text.muted") : visualTokenColor("text.primary");
  }
  if (line.kind === "list") {
    return line.role === "assistant" ? visualTokenColor("text.primary") : roleColor(line.role);
  }
  return roleColor(line.role);
}
