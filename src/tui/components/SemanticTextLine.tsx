import React from "react";
import { Text } from "../ui.js";
import {
  resolveTuiColor,
  type TuiColorRef
} from "../theme.js";

export type SemanticTextSpan = {
  text: string;
  color?: TuiColorRef;
  bold?: boolean;
  dim?: boolean;
};

export type SemanticTextLineProps = {
  text?: string;
  spans?: SemanticTextSpan[];
  wrap?: "wrap" | "truncate";
  color?: TuiColorRef;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  onClick?: () => void;
};

export function SemanticTextLine({
  text,
  spans,
  wrap = "truncate",
  color,
  bold,
  dim,
  inverse,
  onClick
}: SemanticTextLineProps): React.ReactElement {
  const resolvedSpans = spans?.length ? spans : [{ text: text ?? " ", color, bold, dim }];
  return (
    <Text wrap={wrap} color={resolveTuiColor(color)} bold={bold} dimColor={dim} inverse={inverse} onClick={onClick as never} focusable={Boolean(onClick)}>
      {resolvedSpans.map((span, index) => (
        <Text
          key={`${index}:${span.text}`}
          color={resolveTuiColor(span.color ?? color)}
          bold={span.bold ?? bold}
          dimColor={span.dim ?? dim}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

export function semanticToolLineSpans(value: string, options: {
  defaultColor?: TuiColorRef;
  labelColor?: TuiColorRef;
  valueColor?: TuiColorRef;
} = {}): SemanticTextSpan[] {
  if (!value) {
    return [{ text: " ", color: options.defaultColor ?? "text.primary" }];
  }
  if (/^\+\+\+|^---/u.test(value)) {
    return [{ text: value, color: "text.muted" }];
  }
  if (/^\+[^+]/u.test(value)) {
    return [
      { text: "+", color: "status.success", bold: true },
      { text: value.slice(1), color: "text.primary" }
    ];
  }
  if (/^-[^-]/u.test(value)) {
    return [
      { text: "-", color: "status.danger", bold: true },
      { text: value.slice(1), color: "text.primary" }
    ];
  }
  if (/^@@/u.test(value)) {
    return [{ text: value, color: "role.gateway", bold: true }];
  }

  const colon = value.match(/^(\s*)([A-Za-z][A-Za-z0-9_. -]{0,24}):(\s*)(.*)$/u);
  if (colon) {
    const label = colon[2] ?? "";
    return [
      { text: colon[1] ?? "", color: "text.muted" },
      { text: label, color: labelTone(label, options.labelColor), bold: true },
      { text: ":", color: "text.muted" },
      { text: colon[3] ?? "", color: "text.muted" },
      { text: colon[4] ?? "", color: valueTone(label, options.valueColor) }
    ];
  }

  const keyValue = value.match(/^(\s*)([A-Za-z][A-Za-z0-9_.-]{0,32})=(.*)$/u);
  if (keyValue) {
    const key = keyValue[2] ?? "";
    return [
      { text: keyValue[1] ?? "", color: "text.muted" },
      { text: key, color: labelTone(key, options.labelColor), bold: importantKey(key) },
      { text: "=", color: "text.muted" },
      { text: keyValue[3] ?? "", color: valueTone(key, options.valueColor) }
    ];
  }

  const shell = value.match(/^(\s*)([$>])\s+(.*)$/u);
  if (shell) {
    return [
      { text: shell[1] ?? "", color: "text.muted" },
      { text: `${shell[2]} `, color: "role.tool", bold: true },
      { text: shell[3] ?? "", color: "text.primary" }
    ];
  }

  return [{ text: value, color: options.defaultColor ?? "text.primary" }];
}

function labelTone(label: string, fallback?: TuiColorRef): TuiColorRef {
  const normalized = label.toLowerCase();
  if (/^(error|failed|failure|stderr|denied)$/u.test(normalized)) return "status.danger";
  if (/^(recovery|recovery_detail|warning|warn|blocked|next)$/u.test(normalized)) return "status.warning";
  if (/^(command|tool|action|stdout|shell)$/u.test(normalized)) return "role.tool";
  if (/^(gateway|lsp|provider|capability)$/u.test(normalized)) return "role.gateway";
  if (/^(cache|prompt_cache)$/u.test(normalized)) return "status.success";
  if (/^(artifact|output|output_ref|full|report|trajectory|log)$/u.test(normalized)) return "text.muted";
  return fallback ?? "text.muted";
}

function valueTone(label: string, fallback?: TuiColorRef): TuiColorRef {
  const normalized = label.toLowerCase();
  if (/^(error|failed|failure|stderr|denied)$/u.test(normalized)) return "status.danger";
  if (/^(recovery|recovery_detail|warning|warn|blocked|next)$/u.test(normalized)) return "status.warning";
  if (/^(artifact|output|output_ref|full|report|trajectory|log|session|task|worker)$/u.test(normalized)) return "text.muted";
  return fallback ?? "text.primary";
}

function importantKey(key: string): boolean {
  return /^(error|recovery|recovery_detail|command|tool|action|gateway|lsp|provider|cache)$/iu.test(key);
}
