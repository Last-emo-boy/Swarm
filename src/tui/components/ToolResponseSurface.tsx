import React from "react";
import { Box } from "../ui.js";
import { type TuiColorRef } from "../theme.js";
import { SemanticTextLine, type SemanticTextSpan } from "./SemanticTextLine.js";

export type ToolResponseKind =
  | "command"
  | "result"
  | "error"
  | "warning"
  | "stderr"
  | "muted"
  | "diff.added"
  | "diff.removed"
  | "diff.hunk"
  | "diff.meta";

export type ToolResponseLineOptions = {
  defaultColor?: TuiColorRef;
  labelColor?: TuiColorRef;
  valueColor?: TuiColorRef;
  fallbackLabel?: string;
};

export function ToolResponseSurface(props: {
  lines: string[];
  wrap?: "wrap" | "truncate";
  defaultColor?: TuiColorRef;
  fallbackLabel?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%">
      {props.lines.map((line, index) => (
        <ToolResponseLine
          key={`${index}:${line}`}
          line={line}
          wrap={props.wrap}
          defaultColor={props.defaultColor}
          fallbackLabel={props.fallbackLabel}
        />
      ))}
    </Box>
  );
}

export function ToolResponseLine(props: {
  line: string;
  wrap?: "wrap" | "truncate";
  defaultColor?: TuiColorRef;
  labelColor?: TuiColorRef;
  valueColor?: TuiColorRef;
  fallbackLabel?: string;
}): React.ReactElement {
  return (
    <SemanticTextLine
      wrap={props.wrap ?? "truncate"}
      spans={toolResponseLineSpans(props.line, {
        defaultColor: props.defaultColor,
        labelColor: props.labelColor,
        valueColor: props.valueColor,
        fallbackLabel: props.fallbackLabel
      })}
    />
  );
}

export function toolResponseLineSpans(value: string, options: ToolResponseLineOptions = {}): SemanticTextSpan[] {
  if (!value) {
    return responseSpans("output", " ", "result", options);
  }

  const command = value.match(/^(\s*)(?:Command:|[$>])\s*(.*)$/iu);
  if (command) {
    return responseSpans("shell", command[2] ?? "", "command", options, command[1]);
  }

  if (/^\+\+\+|^---/u.test(value)) {
    return responseSpans("diff", value, "diff.meta", options);
  }
  if (/^\+[^+]/u.test(value)) {
    return responseSpans("diff", value, "diff.added", options);
  }
  if (/^-[^-]/u.test(value)) {
    return responseSpans("diff", value, "diff.removed", options);
  }
  if (/^@@/u.test(value)) {
    return responseSpans("diff", value, "diff.hunk", options);
  }

  const colon = value.match(/^(\s*)([A-Za-z][A-Za-z0-9_. -]{0,24}):(\s*)(.*)$/u);
  if (colon) {
    const label = responseLabel(colon[2] ?? "", options.fallbackLabel);
    return responseSpans(label, colon[4] ?? "", responseKindForLabel(label), options, colon[1], colon[3]);
  }

  const keyValue = value.match(/^(\s*)([A-Za-z][A-Za-z0-9_.-]{0,32})=(.*)$/u);
  if (keyValue) {
    const label = responseLabel(keyValue[2] ?? "", options.fallbackLabel);
    return responseSpans(label, keyValue[3] ?? "", responseKindForLabel(label), options, keyValue[1]);
  }

  return responseSpans(options.fallbackLabel ?? "output", value, "result", options);
}

function responseSpans(
  label: string,
  body: string,
  kind: ToolResponseKind,
  options: {
    defaultColor?: TuiColorRef;
    labelColor?: TuiColorRef;
    valueColor?: TuiColorRef;
  },
  leading = "",
  separator = " "
): SemanticTextSpan[] {
  const normalizedLabel = compactResponseLabel(label);
  const labelWidth = 10;
  const labelPadding = " ".repeat(Math.max(1, labelWidth - normalizedLabel.length));
  const bodySpans = responseBodySpans(body, kind, options);
  return [
    ...(leading ? [{ text: leading, color: "text.muted" } satisfies SemanticTextSpan] : []),
    {
      text: kind === "command" ? "⏵ " : "⎿ ",
      color: responseMarkerColor(kind),
      bold: kind === "command",
      dim: kind !== "command" && kind !== "error" && kind !== "stderr"
    },
    { text: normalizedLabel, color: responseLabelColor(normalizedLabel, kind, options.labelColor), bold: true },
    { text: labelPadding, color: "text.muted" },
    ...(separator.trim() ? [] : [{ text: separator, color: "text.muted" } satisfies SemanticTextSpan]),
    ...bodySpans
  ];
}

function responseBodySpans(
  body: string,
  kind: ToolResponseKind,
  options: {
    defaultColor?: TuiColorRef;
    valueColor?: TuiColorRef;
  }
): SemanticTextSpan[] {
  if (!body) {
    return [{ text: " ", color: options.defaultColor ?? "text.primary" }];
  }
  if (kind === "diff.added") {
    return [
      { text: body.slice(0, 1), color: "diff.added", bold: true },
      { text: body.slice(1), color: "text.primary" }
    ];
  }
  if (kind === "diff.removed") {
    return [
      { text: body.slice(0, 1), color: "diff.removed", bold: true },
      { text: body.slice(1), color: "text.primary" }
    ];
  }
  if (kind === "diff.hunk") {
    return [{ text: body, color: "role.gateway", bold: true }];
  }
  if (kind === "diff.meta") {
    return [{ text: body, color: "text.muted" }];
  }
  if (kind === "warning") {
    return [{ text: body, color: options.valueColor ?? "text.primary" }];
  }
  if (kind === "muted") {
    return [{ text: body, color: options.valueColor ?? "text.muted" }];
  }
  return [{ text: body, color: options.valueColor ?? options.defaultColor ?? "text.primary" }];
}

function responseLabel(label: string, fallback: string | undefined): string {
  const normalized = label.trim().toLowerCase().replace(/\s+/gu, "_");
  if (normalized === "command" || normalized === "cmd") return "shell";
  if (normalized === "artifact" || normalized === "output_ref" || normalized === "report" || normalized === "log") return "artifact";
  if (normalized === "recovery_detail") return "recovery";
  if (normalized === "failed" || normalized === "failure") return "error";
  return normalized || fallback || "output";
}

function compactResponseLabel(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/\s+/gu, "_");
  if (!normalized) {
    return "output";
  }
  return normalized.length > 10 ? normalized.slice(0, 10) : normalized;
}

function responseKindForLabel(label: string): Exclude<ToolResponseKind, "command" | "diff.added" | "diff.removed" | "diff.hunk" | "diff.meta"> {
  const normalized = label.toLowerCase();
  if (/^(error|denied|failed|failure)$/u.test(normalized)) return "error";
  if (/^stderr$/u.test(normalized)) return "stderr";
  if (/^(warning|warn|recovery|blocked|next|rollback|impact|why)$/u.test(normalized)) return "warning";
  if (/^(artifact|output_ref|full|report|trajectory|log|session|task|worker|meta)$/u.test(normalized)) return "muted";
  return "result";
}

function responseMarkerColor(kind: ToolResponseKind): TuiColorRef {
  if (kind === "command") return "role.tool";
  if (kind === "error" || kind === "stderr") return "status.danger";
  if (kind === "warning") return "status.warning";
  return "text.muted";
}

function responseLabelColor(
  label: string,
  kind: ToolResponseKind,
  fallback?: TuiColorRef
): TuiColorRef {
  if (kind === "command") return "role.tool";
  if (kind === "error") return "status.danger";
  if (kind === "stderr") return "status.danger";
  if (kind === "warning") return "status.warning";
  if (kind === "muted") return "text.muted";
  if (kind === "diff.added" || kind === "diff.removed" || kind === "diff.hunk" || kind === "diff.meta") return "role.gateway";
  return labelTone(label, fallback);
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
