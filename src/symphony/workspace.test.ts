import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkItem } from "../protocol/types.js";
import { prepareWorkItemWorkspace, sanitizeWorkspaceKey } from "./workspace.js";

test("sanitizeWorkspaceKey keeps Symphony workspaces inside a filesystem-safe segment", () => {
  assert.equal(sanitizeWorkspaceKey("../escape/../../repo"), ".._escape_.._.._repo");
  assert.equal(sanitizeWorkspaceKey(""), "work_item");
  assert.equal(sanitizeWorkspaceKey("  ///  "), "work_item");
  assert.equal(sanitizeWorkspaceKey("Fix: Windows\\paths / and spaces"), "Fix_Windows_paths_and_spaces");
});

test("prepareWorkItemWorkspace respects create=false and records lease metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-symphony-workspace-"));
  try {
    const item = workItem({
      title: "../Escape Me",
      source_id: "source-1",
      human_id: "TASK-1"
    });

    const prepared = prepareWorkItemWorkspace({
      item,
      session_id: "session-1",
      workspace_root: root,
      create: false
    });

    assert.equal(prepared.workspace_key, "TASK-1");
    assert(prepared.workspace_path.startsWith(root));
    assert.equal(prepared.created_now, false);
    assert.equal(existsSync(prepared.workspace_path), false);
    assert.equal(prepared.lease.workspace_root, root);
    assert.equal(prepared.lease.workspace_path, prepared.workspace_path);
    assert.deepEqual(prepared.lease.metadata.work_item, item);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareWorkItemWorkspace creates a deterministic directory for long labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-symphony-workspace-long-"));
  try {
    const item = workItem({ title: `Implement ${"very_".repeat(20)}long task` });
    const prepared = prepareWorkItemWorkspace({
      item,
      session_id: "session-long",
      workspace_root: root
    });

    assert(prepared.workspace_key.startsWith("Implement_very_very"));
    assert.equal(prepared.created_now, true);
    assert.equal(existsSync(prepared.workspace_path), true);
    assert(prepared.workspace_path.startsWith(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function workItem(input: { title: string; source_id?: string; human_id?: string }): WorkItem {
  return {
    source: "symphony",
    source_id: input.source_id,
    human_id: input.human_id,
    title: input.title,
    state: "active",
    labels: [],
    metadata: {}
  };
}
