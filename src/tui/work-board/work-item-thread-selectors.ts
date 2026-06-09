import type { WorkBoardThreadView } from "./work-board-types.js";
import { selectWorkBoardSurface, type SelectWorkBoardSurfaceInput } from "./work-board-selectors.js";

export function selectWorkItemThread(input: SelectWorkBoardSurfaceInput): WorkBoardThreadView | undefined {
  return selectWorkBoardSurface(input).selected;
}

export function formatWorkItemThreadRows(thread: WorkBoardThreadView, maxRows: number): string[] {
  const visibleRows = Math.max(2, Math.floor(maxRows));
  const evidenceRows = shouldShowDecisionRows(thread.status)
    ? [
      ...prefixed("Changed", thread.changedFiles),
      ...prefixed("Checks", thread.checks)
    ]
    : [];
  return [
    ...statusRows(thread.status),
    `Objective: ${thread.objective}`,
    ...prefixed("Plan", thread.plan),
    ...evidenceRows,
    ...prefixed("Actions", thread.actions)
  ].slice(0, visibleRows);
}

function statusRows(status: string): string[] {
  return shouldShowDecisionRows(status) ? [`Status: ${status}`] : [];
}

function shouldShowDecisionRows(status: string): boolean {
  return ["blocked", "failed", "stopped", "stale", "timeout", "conflict", "review", "reviewing", "verifying"].includes(status.toLowerCase());
}

function prefixed(label: string, values: string[]): string[] {
  if (!values.length) {
    return [];
  }
  return values.slice(0, 3).map((value, index) => `${index === 0 ? `${label}: ` : "  "}${value}`);
}
