import type { TuiColorRef } from "../theme.js";

export type WorkBoardColumnId = "backlog" | "running" | "review" | "done" | "blocked";

export type WorkBoardItemTone = "muted" | "running" | "success" | "warning" | "danger" | "pending";

export type WorkBoardItemView = {
  id: string;
  title: string;
  status: string;
  subtitle?: string;
  owner?: string;
  meta: string[];
  tone: WorkBoardItemTone;
};

export type WorkBoardColumnView = {
  id: WorkBoardColumnId;
  title: string;
  count: number;
  items: WorkBoardItemView[];
};

export type WorkBoardThreadView = {
  id: string;
  title: string;
  status: string;
  objective: string;
  assignee?: string;
  risk?: string;
  source?: string;
  plan: string[];
  timeline: string[];
  changedFiles: string[];
  checks: string[];
  comments: string[];
  actions: string[];
};

export type WorkBoardSummaryView = {
  activeTasks: number;
  approvals: number;
  blockers: number;
  skills: number;
  activity: string[];
};

export type WorkBoardSurfaceView = {
  title: string;
  subtitle: string;
  columns: WorkBoardColumnView[];
  selected?: WorkBoardThreadView;
  summary: WorkBoardSummaryView;
  empty: boolean;
};

export function toneRefForWorkBoardItem(tone: WorkBoardItemTone): TuiColorRef {
  if (tone === "running") return "status.running";
  if (tone === "success") return "status.success";
  if (tone === "warning") return "status.warning";
  if (tone === "danger") return "status.danger";
  if (tone === "pending") return "status.pending";
  return "text.muted";
}
