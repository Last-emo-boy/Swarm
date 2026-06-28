import { readFile } from "node:fs/promises";
import type { ToolResult } from "../tools/types.js";
import { isRecord } from "./common-utilities.js";

export async function hydrateToolResultForReport(tool: ToolResult): Promise<ToolResult> {
  const ref = toolOutputRefPath(tool);
  if (!ref) {
    return tool;
  }
  let fullOutput = "";
  try {
    fullOutput = await readFile(ref, "utf8");
  } catch {
    return tool;
  }
  if (!fullOutput.trim()) {
    return tool;
  }
  const reportOutput = truncateReportOutput(fullOutput);
  const existingContent = tool.content ?? "";
  const hydratedContent = existingContent.includes(reportOutput)
    ? existingContent
    : [
        existingContent,
        `Full worker result (${ref}):`,
        reportOutput
      ].filter(Boolean).join("\n\n");
  return {
    ...tool,
    content: hydratedContent
  };
}

export function toolOutputRefPath(tool: ToolResult): string | undefined {
  if (typeof tool.outputRef === "string" && tool.outputRef.trim()) {
    return tool.outputRef;
  }
  return outputRefPathFromRecord(tool.data)
    ?? outputRefPathFromRecord(tool.metadata);
}

export function outputRefPathFromRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["result_ref", "outputRef", "output_ref"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (isRecord(candidate) && typeof candidate.path === "string" && candidate.path.trim()) {
      return candidate.path;
    }
  }
  return undefined;
}

export function truncateReportOutput(text: string): string {
  const maxChars = 80_000;
  if (text.length <= maxChars) {
    return text;
  }
  const slice = Math.floor((maxChars - 80) / 2);
  return [
    text.slice(0, slice),
    "[... full worker result truncated for report normalization ...]",
    text.slice(-slice)
  ].join("\n\n");
}

export function summarizeToolResultForReport(tool: Pick<ToolResult, "summary" | "content" | "errors">, fallback: string): string {
  const summary = typeof tool.summary === "string" ? tool.summary.trim() : "";
  if (summary && !isGenericReportHeading(summary)) {
    return clipFirstLine(summary, 500);
  }
  const fromContent = firstMeaningfulToolLine(tool.content ?? "");
  if (fromContent) {
    return clipFirstLine(fromContent, 500);
  }
  const fromError = firstMeaningfulToolLine((tool.errors ?? []).join("\n"));
  return clipFirstLine(fromError || summary || fallback, 500);
}

export function firstMeaningfulToolLine(text: string): string {
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isGenericReportHeading(line))
    .filter((line) => !/^[-*]\s*$/.test(line));
  return lines[0] ?? "";
}

export function isGenericReportHeading(text: string): boolean {
  const trimmed = text.trim();
  if (/^(full worker result|full output|original output|worker session|changed files|tests run|artifacts)\b\s*[:(]/i.test(trimmed)) {
    return true;
  }
  const withoutCompletionPrefix = trimmed.replace(/^.*?\bcompleted:\s*/i, "");
  const normalized = withoutCompletionPrefix.replace(/^#+\s*/, "").replace(/:$/, "").toLowerCase();
  return [
    "verdict",
    "findings",
    "high severity",
    "medium severity",
    "low severity",
    "critical severity",
    "test gaps",
    "gaps",
    "verification results",
    "review results",
    "review complete",
    "verification complete",
    "results"
  ].includes(normalized);
}

export function reviewTextSuggestsFinding(text: string): boolean {
  const lowered = text.toLowerCase();
  if (!lowered.trim()) {
    return false;
  }
  if (/\b(no findings|no issues|no problems|no further action|nothing to fix|no blocking issues)\b/.test(lowered)
    && !/\b(minor issue|potential issue|bug|regression|missing|risk|gap|required fix|problem)\b/.test(lowered)) {
    return false;
  }
  return /\b(minor issue|potential issue|bug|bugs detected|edge-case|regression|missing test|test gaps?|verification gap|not covered|risk|required fix|should be fixed|high severity|medium severity|corrupted|silently|misidentifies|accepts trailing|drag-and-drop does not|does not update|unexpected ordering)\b/.test(lowered);
}

export function verificationTextSuggestsGap(text: string): boolean {
  const lowered = text.toLowerCase();
  if (!lowered.trim()) {
    return false;
  }
  if (/\b(no findings|no issues|no problems|no bugs detected|no gaps|nothing to fix)\b/.test(lowered)
    && !/\b(but|however|except|missing|not covered|should be fixed|detected but|gap|risk)\b/.test(lowered)) {
    return false;
  }
  return /\b(edge-case bugs?|bugs? detected|high severity|medium severity|test gaps?|verification gaps?|not covered|should be fixed|missing tests?|failed to verify|unable to verify|verification gap|manual verification required)\b/.test(lowered);
}

export function clipFirstLine(value: string, maxLength: number): string {
  const line = value.split(/\r?\n/).find((item) => item.trim())?.trim() ?? "";
  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 1))}…` : line;
}
