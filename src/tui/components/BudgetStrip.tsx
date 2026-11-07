import React from "react";
import { Box } from "../ui.js";
import { SemanticTextLine, truncateSpans } from "./SemanticTextLine.js";

/** At most this many reached budgets are shown above the prompt. */
export const BUDGET_NOTICE_LIMIT = 2;

/** The rows the budget notice takes: one per reached cap shown, none while no cap is reached. */
export const budgetNoticeRows = (notices: readonly string[]): number => Math.min(notices.length, BUDGET_NOTICE_LIMIT);

/** A reached budget, above the prompt: which cap, what went, and the setting that raises it. It takes no space otherwise. */
export function BudgetStrip(props: { notices: readonly string[]; columns: number }): React.ReactElement | null {
  if (!props.notices.length) return null;
  const width = Math.max(20, props.columns - 2);
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {props.notices.slice(0, BUDGET_NOTICE_LIMIT).map((notice) => (
        <SemanticTextLine key={notice} wrap="truncate" spans={truncateSpans([
          { text: "! ", color: "status.danger", bold: true },
          { text: notice, color: "status.warning" }
        ], width)} />
      ))}
    </Box>
  );
}
