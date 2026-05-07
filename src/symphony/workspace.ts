import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkItem, WorkspaceLease } from "../protocol/types.js";
import { workItemLabel, workItemSourceId } from "./work-item.js";

export type PreparedWorkspace = {
  workspace_key: string;
  workspace_path: string;
  created_now: boolean;
  lease: Omit<WorkspaceLease, "lease_id" | "created_at">;
};

export function prepareWorkItemWorkspace(input: {
  item: WorkItem;
  session_id: string;
  workspace_root: string;
  create?: boolean;
}): PreparedWorkspace {
  const root = resolve(input.workspace_root);
  const workspaceKey = sanitizeWorkspaceKey(workItemLabel(input.item));
  const workspacePath = resolve(root, workspaceKey);
  assertInsideRoot(root, workspacePath);
  let createdNow = false;
  if (input.create !== false) {
    createdNow = ensureDirectory(workspacePath);
  }
  return {
    workspace_key: workspaceKey,
    workspace_path: workspacePath,
    created_now: createdNow,
    lease: {
      session_id: input.session_id,
      workspace_root: root,
      workspace_path: workspacePath,
      scope: [],
      write_boundary: "workspace",
      metadata: {
        kind: "symphony_workspace",
        workspace_key: workspaceKey,
        work_item: {
          source: input.item.source,
          source_id: workItemSourceId(input.item),
          human_id: input.item.human_id,
          title: input.item.title
        }
      }
    }
  };
}

export function sanitizeWorkspaceKey(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "work_item";
}

function ensureDirectory(path: string): boolean {
  const existed = existsSync(path);
  try {
    mkdirSync(path, { recursive: true });
    return !existed;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function assertInsideRoot(root: string, path: string): void {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Workspace path escapes root: ${path}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
