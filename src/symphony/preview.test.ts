import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { BlackboardEntry, WorkItem } from "../protocol/types.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import { sanitizeWorkspaceKey } from "./workspace.js";

test("symphony preview CLI persists local WorkItem preview sessions, leases, and Blackboard entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-symphony-preview-cli-"));
  const swarmHome = join(root, "swarm-home");
  const runtimeWorkspace = join(root, "runtime-workspace");
  const workflowWorkspaceRoot = join(root, "symphony-workspaces");
  const workItemsPath = join(root, "WORK_ITEMS.md");
  const workflowPath = join(root, "WORKFLOW.md");

  try {
    await mkdir(runtimeWorkspace, { recursive: true });
    await writeFile(workItemsPath, [
      "# Local work",
      "- [ ] WK-101: Normalize active preview item",
      "- [ ] WK-102: Persist preview metadata",
      "- [x] WK-103: Terminal item must not preview"
    ].join("\n"), "utf8");
    await writeFile(workflowPath, workflowText(workItemsPath, workflowWorkspaceRoot), "utf8");

    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "symphony",
      "preview",
      "--workflow",
      workflowPath,
      "--workspace",
      runtimeWorkspace,
      "--no-create"
    ], { SWARM_HOME: swarmHome });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`Workflow: ${escapeRegExp(resolve(workflowPath))}`));
    assert.match(result.stdout, /Items: 2/);
    assert.match(result.stdout, /sym_[^\s]+ WK-101: Normalize active preview item/);
    assert.match(result.stdout, /sym_[^\s]+ WK-102: Persist preview metadata/);
    assert.doesNotMatch(result.stdout, /WK-103/);
    assert.match(result.stdout, /source: WK-101/);
    assert.match(result.stdout, /source: WK-102/);
    assert.match(result.stdout, /prompt: Preview WK-101: Normalize active preview item/);
    assert.match(result.stdout, /prompt: Preview WK-102: Persist preview metadata/);
    assert.match(result.stdout, new RegExp(`workspace: ${escapeRegExp(resolve(workflowWorkspaceRoot, "WK-101"))}`));
    assert.match(result.stdout, new RegExp(`workspace: ${escapeRegExp(resolve(workflowWorkspaceRoot, "WK-102"))}`));

    const previousHome = process.env.SWARM_HOME;
    process.env.SWARM_HOME = swarmHome;
    const runtime = new SwarmRuntime({ workspace: runtimeWorkspace });
    try {
      const sessions = runtime.sessionStore
        .listBySource("symphony")
        .filter((session) => session.objective.includes("WK-10"));
      assert.deepEqual(sessions.map((session) => session.objective).sort(), [
        "WK-101: Normalize active preview item",
        "WK-102: Persist preview metadata"
      ]);

      for (const session of sessions) {
        assert.equal(session.status, "created");
        assert.ok(session.workspace_lease_id, "preview session should store workspace_lease_id");
        const workItem = parseJson<WorkItem>(session.source_json, "session source_json");
        assert.equal(workItem.source, "symphony");
        assert.equal(workItem.source_id, `${resolve(workItemsPath)}:${workItem.human_id}`);
        assert.match(workItem.human_id ?? "", /^WK-10[12]$/);
        assert.deepEqual(workItem.labels, ["local"]);
        assert.equal(workItem.state, "Todo");
        assert.equal(workItem.metadata.work_source_kind, "local");
        assert.equal(workItem.metadata.local_path, resolve(workItemsPath));
        assert.equal(typeof workItem.metadata.line_index, "number");

        const expectedWorkspaceKey = sanitizeWorkspaceKey(workItem.human_id ?? workItem.source_id ?? workItem.title);
        const expectedWorkspacePath = resolve(workflowWorkspaceRoot, expectedWorkspaceKey);
        assert.equal(session.objective, `${workItem.human_id}: ${workItem.title}`);

        const lease = runtime.workspaceLeaseStore.get(session.workspace_lease_id);
        assert(lease, `missing WorkspaceLease ${session.workspace_lease_id}`);
        assert.equal(lease.session_id, session.session_id);
        assert.equal(lease.workspace_root, resolve(workflowWorkspaceRoot));
        assert.equal(lease.workspace_path, expectedWorkspacePath);
        assert.equal(lease.write_boundary, "workspace");
        assert.equal(lease.metadata.kind, "symphony_workspace");
        assert.equal(lease.metadata.workspace_key, expectedWorkspaceKey);
        assert.deepEqual(lease.metadata.work_item, workItem);
        assert.equal(existsSync(expectedWorkspacePath), false, "--no-create should not create per-item workspace dirs");

        const previewEntries = runtime.blackboardStore
          .list(session.session_id)
          .filter((entry) => entry.key === "symphony.preview");
        assert.equal(previewEntries.length, 1);
        assertPreviewEntry(previewEntries[0], {
          workflowPath: resolve(workflowPath),
          workItem,
          workspacePath: expectedWorkspacePath
        });
      }
    } finally {
      runtime.dispose();
      if (previousHome === undefined) {
        delete process.env.SWARM_HOME;
      } else {
        process.env.SWARM_HOME = previousHome;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function assertPreviewEntry(
  entry: BlackboardEntry,
  expected: { workflowPath: string; workItem: WorkItem; workspacePath: string }
): void {
  assert.equal(entry.type, "plan");
  assert.equal(entry.created_by.agent_id, "symphony");
  assert.deepEqual(entry.tags, ["symphony", "preview", "workflow"]);
  const value = recordValue(entry.value);
  assert.equal(value.workflow_path, expected.workflowPath);
  assert.deepEqual(value.work_item, expected.workItem);
  assert.equal(value.workspace_path, expected.workspacePath);
  assert.match(String(value.prompt), new RegExp(`Preview ${escapeRegExp(expected.workItem.human_id ?? "")}: ${escapeRegExp(expected.workItem.title)}`));
}

function workflowText(workItemsPath: string, workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: local",
    `  path: ${workItemsPath}`,
    "  active_states: [Todo]",
    "  terminal_states: [Done]",
    "workspace:",
    `  root: ${workspaceRoot}`,
    "agent:",
    "  max_concurrent_agents: 2",
    "---",
    "Preview {{ issue.identifier }}: {{ issue.title }}",
    "State {{ issue.state }} from {{ issue.source_id }}"
  ].join("\n");
}

function runCli(
  args: string[],
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve(process.cwd()),
      env: { ...process.env, ...env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function parseJson<T>(value: string | null | undefined, description: string): T {
  assert(value, `missing ${description}`);
  return JSON.parse(value) as T;
}

function recordValue(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected record value");
  return value as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
