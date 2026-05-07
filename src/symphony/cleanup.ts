import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RunAttempt, SwarmSession, WorkItem, WorkspaceLease } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { SessionRow } from "../storage/session-store.js";
import { SYMPHONY_SESSION_SOURCES, workItemKey, workItemLabel } from "./work-item.js";
import { runSymphonyHook } from "./hooks.js";
import { loadWorkflow, normalizeWorkflowConfig, type WorkflowLoadResult } from "./workflow.js";

export type SymphonyCleanupRecord = {
  session_id: string;
  status: "eligible" | "removed" | "skipped" | "failed";
  reason?: string;
  work_item?: WorkItem;
  workspace?: WorkspaceLease;
  attempt?: RunAttempt;
  error?: string;
  age_ms?: number;
  artifact_path?: string;
};

export type SymphonyCleanupResult = {
  workflow: WorkflowLoadResult;
  execute: boolean;
  inspected: number;
  removed: number;
  skipped: number;
  failed: number;
  retention: {
    min_age_ms: number;
    keep_latest: number;
    preserve_artifacts: boolean;
  };
  records: SymphonyCleanupRecord[];
};

const TERMINAL_SESSION_STATUSES: SwarmSession["status"][] = ["completed", "failed", "cancelled"];

export async function cleanupSymphonyWorkspaces(input: {
  runtime: SwarmRuntime;
  workflowPath?: string;
  execute?: boolean;
  limit?: number;
}): Promise<SymphonyCleanupResult> {
  const workflow = loadWorkflow(input.workflowPath);
  const execute = input.execute === true;
  const rows = input.runtime.sessionStore.listBySources([...SYMPHONY_SESSION_SOURCES], Math.min(input.limit ?? 100, 500));
  const records: SymphonyCleanupRecord[] = [];
  if (!workflow.ok) {
    return { workflow, execute, inspected: rows.length, removed: 0, skipped: 0, failed: 0, retention: defaultRetention(), records };
  }
  const config = normalizeWorkflowConfig(workflow.workflow);
  const terminalRows = rows.filter((row) => TERMINAL_SESSION_STATUSES.includes(row.status));
  const protectedByKeepLatest = protectedTerminalSessionIds(terminalRows, config.cleanup.retention.keep_latest);
  for (const row of rows) {
    const workItem = parseWorkItem(row.source_json);
    const workspace = row.workspace_lease_id
      ? input.runtime.workspaceLeaseStore.get(row.workspace_lease_id)
      : input.runtime.workspaceLeaseStore.getBySession(row.session_id);
    const eligibility = cleanupEligibility(row, workspace, config.workspace.root, {
      min_age_ms: config.cleanup.retention.min_age_ms,
      protected_session_ids: protectedByKeepLatest
    });
    if (!eligibility.ok) {
      records.push({
        session_id: row.session_id,
        status: "skipped",
        reason: eligibility.reason,
        work_item: workItem,
        workspace,
        age_ms: eligibility.age_ms
      });
      continue;
    }
    if (!workItem || !workspace) {
      records.push({
        session_id: row.session_id,
        status: "skipped",
        reason: "missing_work_item_or_workspace",
        work_item: workItem,
        workspace,
        age_ms: eligibility.age_ms
      });
      continue;
    }

    if (!execute) {
      records.push({
        session_id: row.session_id,
        status: "eligible",
        reason: "dry_run",
        work_item: workItem,
        workspace,
        age_ms: eligibility.age_ms
      });
      continue;
    }

    try {
      const session = sessionFromRow(row, workItem);
      const artifactPath = config.cleanup.retention.preserve_artifacts
        ? preserveCleanupManifest(input.runtime, row, workItem, workspace, eligibility.age_ms)
        : undefined;
      await runSymphonyHook("before_remove", {
        runtime: input.runtime,
        session,
        work_item: workItem,
        workspace_path: workspace.workspace_path,
        config
      });
      const existed = existsSync(workspace.workspace_path);
      if (existed) {
        rmSync(workspace.workspace_path, { recursive: true, force: true });
      }
      const attempt = input.runtime.runAttemptStore.upsert({
        session_id: row.session_id,
        task_id: "symphony.cleanup",
        runner_id: "symphony.cleanup",
        kind: "swarm_task",
        status: "completed",
        attempt: 0,
        title: `Cleanup ${workItemLabel(workItem)}`,
        terminal_reason: existed ? "Workspace removed." : "Workspace already absent.",
        workspace_path: workspace.workspace_path,
        metadata: {
          work_item_key: workItemKey(workItem),
          workspace_root: workspace.workspace_root,
          removed: existed,
          retention: config.cleanup.retention,
          age_ms: eligibility.age_ms,
          artifact_path: artifactPath
        }
      });
      const entry = input.runtime.blackboardStore.write({
        swarm_id: row.swarm_id,
        session_id: row.session_id,
        task_id: "symphony.cleanup",
        key: "symphony.cleanup.removed",
        type: "decision",
        value: {
          work_item: workItem,
          workspace,
          removed: existed,
          retention: config.cleanup.retention,
          age_ms: eligibility.age_ms,
          artifact_path: artifactPath
        },
        created_by: { agent_id: "symphony", role: "cleanup" },
        tags: ["symphony", "cleanup", "workspace", "work-kernel"]
      });
      input.runtime.events.emitEvent({ type: "blackboard", entry });
      records.push({
        session_id: row.session_id,
        status: "removed",
        reason: existed ? "removed" : "already_absent",
        work_item: workItem,
        workspace,
        attempt,
        age_ms: eligibility.age_ms,
        artifact_path: artifactPath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = input.runtime.runAttemptStore.upsert({
        session_id: row.session_id,
        task_id: "symphony.cleanup",
        runner_id: "symphony.cleanup",
        kind: "swarm_task",
        status: "failed",
        attempt: 0,
        title: `Cleanup ${workItemLabel(workItem)}`,
        terminal_reason: message,
        workspace_path: workspace.workspace_path,
        error_code: "SYMPHONY_CLEANUP_FAILED",
        recovery_suggestion: "ask_human",
        metadata: {
          work_item_key: workItemKey(workItem),
          workspace_root: workspace.workspace_root,
          retention: config.cleanup.retention,
          age_ms: eligibility.age_ms,
          error: message
        }
      });
      records.push({
        session_id: row.session_id,
        status: "failed",
        reason: "cleanup_failed",
        work_item: workItem,
        workspace,
        attempt,
        error: message,
        age_ms: eligibility.age_ms
      });
    }
  }
  return {
    workflow,
    execute,
    inspected: rows.length,
    removed: records.filter((record) => record.status === "removed").length,
    skipped: records.filter((record) => record.status === "skipped" || record.status === "eligible").length,
    failed: records.filter((record) => record.status === "failed").length,
    retention: config.cleanup.retention,
    records
  };
}

function cleanupEligibility(
  row: SessionRow,
  workspace: WorkspaceLease | undefined,
  expectedRoot: string,
  retention: { min_age_ms: number; protected_session_ids: Set<string> }
): ({ ok: true; age_ms: number } | { ok: false; reason: string; age_ms?: number }) {
  if (!TERMINAL_SESSION_STATUSES.includes(row.status)) {
    return { ok: false, reason: "session_not_terminal" };
  }
  const ageMs = terminalAgeMs(row);
  if (retention.protected_session_ids.has(row.session_id)) {
    return { ok: false, reason: "retention_keep_latest", age_ms: ageMs };
  }
  if (ageMs < retention.min_age_ms) {
    return { ok: false, reason: "retention_min_age", age_ms: ageMs };
  }
  if (!workspace) {
    return { ok: false, reason: "missing_workspace_lease", age_ms: ageMs };
  }
  if (workspace.metadata.kind !== "symphony_workspace") {
    return { ok: false, reason: "not_symphony_workspace", age_ms: ageMs };
  }
  if (workspace.write_boundary !== "workspace") {
    return { ok: false, reason: "workspace_not_writable_boundary", age_ms: ageMs };
  }
  const root = resolve(expectedRoot);
  const workspacePath = resolve(workspace.workspace_path);
  const relativePath = relative(root, workspacePath);
  if (!relativePath || relativePath.startsWith("..") || resolve(workspacePath) === root) {
    return { ok: false, reason: "workspace_outside_or_equal_root", age_ms: ageMs };
  }
  return { ok: true, age_ms: ageMs };
}

function defaultRetention(): SymphonyCleanupResult["retention"] {
  return { min_age_ms: 0, keep_latest: 0, preserve_artifacts: false };
}

function terminalAgeMs(row: SessionRow): number {
  const updated = Date.parse(row.updated_at);
  return Number.isFinite(updated) ? Math.max(0, Date.now() - updated) : 0;
}

function protectedTerminalSessionIds(rows: SessionRow[], keepLatest: number): Set<string> {
  if (keepLatest <= 0) {
    return new Set();
  }
  return new Set(
    rows
      .slice()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, keepLatest)
      .map((row) => row.session_id)
  );
}

function preserveCleanupManifest(
  runtime: SwarmRuntime,
  row: SessionRow,
  workItem: WorkItem,
  workspace: WorkspaceLease,
  ageMs: number
): string {
  const artifactRoot = resolve(runtime.workspaceRoot(), runtime.settings.runtime.projectArtifactDir, "symphony-cleanup");
  mkdirSync(artifactRoot, { recursive: true });
  const path = join(artifactRoot, `${sanitizeFileSegment(row.session_id)}.json`);
  const payload = {
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    status: row.status,
    updated_at: row.updated_at,
    age_ms: ageMs,
    work_item: workItem,
    workspace,
    preserved_at: new Date().toISOString()
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  runtime.artifactStore.create({
    session_id: row.session_id,
    path,
    type: "symphony.cleanup.manifest",
    summary: `Cleanup manifest for ${workItemLabel(workItem)}`
  });
  return path;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || "session";
}

function sessionFromRow(row: SessionRow, workItem: WorkItem): SwarmSession {
  return {
    swarm_id: row.swarm_id,
    session_id: row.session_id,
    user_request_id: row.session_id,
    source: workItem,
    parent_session_id: row.parent_session_id ?? undefined,
    workspace_lease_id: row.workspace_lease_id ?? undefined,
    objective: row.objective,
    status: row.status,
    coordinator: { agent_id: "symphony", role: "scheduler" },
    participants: JSON.parse(row.participants_json) as SwarmSession["participants"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    policy: JSON.parse(row.policy_json) as SwarmSession["policy"]
  };
}

function parseWorkItem(value: string | null | undefined): WorkItem | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as WorkItem;
    return typeof parsed === "object" && parsed !== null && typeof parsed.source === "string" && typeof parsed.title === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
