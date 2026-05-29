import type { TuiVisualToken } from "./theme.js";
import type { WorkerBoardRow } from "./run-board/run-board-types.js";

export type CollaborationRole = "planner" | "worker" | "reviewer" | "aggregator";

export type CollaborationRoleDescriptor = {
  role: CollaborationRole;
  label: "Planner" | "Worker" | "Reviewer" | "Aggregator";
  badge: "[PLAN]" | "[WORK]" | "[REV]" | "[AGG]";
  color: TuiVisualToken;
};

const ROLE_DESCRIPTORS: Record<CollaborationRole, CollaborationRoleDescriptor> = {
  planner: {
    role: "planner",
    label: "Planner",
    badge: "[PLAN]",
    color: "role.planner"
  },
  worker: {
    role: "worker",
    label: "Worker",
    badge: "[WORK]",
    color: "role.worker"
  },
  reviewer: {
    role: "reviewer",
    label: "Reviewer",
    badge: "[REV]",
    color: "role.reviewer"
  },
  aggregator: {
    role: "aggregator",
    label: "Aggregator",
    badge: "[AGG]",
    color: "role.aggregator"
  }
};

export function collaborationRoleDescriptor(role: CollaborationRole): CollaborationRoleDescriptor {
  return ROLE_DESCRIPTORS[role];
}

export function collaborationRoleForWorker(row: Pick<WorkerBoardRow, "role" | "label">): CollaborationRole {
  if (row.role === "main" || /main|planner|coordinat/iu.test(row.label)) {
    return "planner";
  }
  if (row.role === "review" || /review/iu.test(row.label)) {
    return "reviewer";
  }
  if (/aggregat|summary|result/iu.test(row.label)) {
    return "aggregator";
  }
  return "worker";
}
