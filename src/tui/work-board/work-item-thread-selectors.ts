import type { WorkBoardThreadView } from "./work-board-types.js";
import { selectWorkBoardSurface, type SelectWorkBoardSurfaceInput } from "./work-board-selectors.js";

export function selectWorkItemThread(input: SelectWorkBoardSurfaceInput): WorkBoardThreadView | undefined {
  return selectWorkBoardSurface(input).selected;
}

export function formatWorkItemThreadRows(thread: WorkBoardThreadView, maxRows: number): string[] {
  const visibleRows = Math.max(2, Math.floor(maxRows));
  return [
    `Status: ${thread.status}${thread.assignee ? ` · Assignee: ${thread.assignee}` : ""}${thread.risk ? ` · Risk: ${thread.risk}` : ""}`,
    `Objective: ${thread.objective}`,
    ...prefixed("Plan", thread.plan),
    ...prefixed("Timeline", thread.timeline),
    ...prefixed("Changed", thread.changedFiles),
    ...prefixed("Checks", thread.checks),
    ...prefixed("Comments", thread.comments),
    ...prefixed("Actions", thread.actions)
  ].slice(0, visibleRows);
}

function prefixed(label: string, values: string[]): string[] {
  if (!values.length) {
    return [];
  }
  return values.slice(0, 3).map((value, index) => `${index === 0 ? `${label}: ` : "  "}${value}`);
}
