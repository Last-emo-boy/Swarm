// Inline result preview for the active (busy) layout. Surfaces the two detail
// fields the aggregate footer only counts — the changed file paths and each
// check's command+status — as at most two never-wrapping lines. Failing checks
// are sorted first and float the block to the top so a failure can't hide behind
// a green count. Completion-time fields (summary/confidence/risks/next actions)
// stay with ProductResultCard; this block is the in-progress preview only.
import React from "react";
import { Box } from "../ui.js";
import { statusBadge } from "../theme.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";
import { statusToken } from "./activity-format.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";

const CHECK_RANK: Record<string, number> = { failed: 0, running: 1, unknown: 2, skipped: 3, passed: 4 };

export function InlineResultBlock(props: { view: RunBoardSurfaceView; columns?: number }): React.ReactElement | null {
  const cf = props.view.resultPreview.changedFiles;
  const checks = props.view.resultPreview.checks;
  if (cf.length === 0 && checks.length === 0) {
    return null;
  }
  const cols = props.columns ?? 120;
  const fileLimit = cols < 100 ? 1 : 3;
  const checkLimit = cols < 100 ? 2 : 3;

  let filesLine: React.ReactElement | null = null;
  if (cf.length > 0) {
    const spans: SemanticTextSpan[] = [
      { text: `${cf.length} files`, color: "text.muted", bold: true },
      { text: "  ", color: "text.muted" }
    ];
    cf.slice(0, fileLimit).forEach((path, index) => {
      if (index > 0) spans.push({ text: ", ", color: "text.muted" });
      spans.push({ text: path, color: "text.primary" });
    });
    if (cf.length > fileLimit) spans.push({ text: ` +${cf.length - fileLimit}`, color: "text.muted" });
    filesLine = <SemanticTextLine key="files" wrap="truncate" spans={spans} />;
  }

  let checksLine: React.ReactElement | null = null;
  if (checks.length > 0) {
    const sorted = [...checks].sort((a, b) => (CHECK_RANK[a.status] ?? 5) - (CHECK_RANK[b.status] ?? 5));
    const spans: SemanticTextSpan[] = [];
    sorted.slice(0, checkLimit).forEach((check, index) => {
      if (index > 0) spans.push({ text: "   ", color: "text.muted" });
      spans.push({ text: statusBadge(check.status), color: statusToken(check.status), bold: true });
      spans.push({ text: ` ${check.command}`, color: "text.primary" });
    });
    if (checks.length > checkLimit) spans.push({ text: ` +${checks.length - checkLimit}`, color: "text.muted" });
    checksLine = <SemanticTextLine key="checks" wrap="truncate" spans={spans} />;
  }

  const hasFailure = checks.some((check) => check.status === "failed");
  const rows = (hasFailure ? [checksLine, filesLine] : [filesLine, checksLine]).filter(Boolean);
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {rows}
    </Box>
  );
}
