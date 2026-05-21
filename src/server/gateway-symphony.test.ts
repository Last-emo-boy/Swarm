import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { BlackboardEntry, WorkItem } from "../protocol/types.js";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";
import { sanitizeWorkspaceKey } from "../symphony/workspace.js";

test("Gateway exposes Symphony status through a real HTTP route", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const health = await readJson<GatewayHealthPayload>(`${started.url}/health`);
    assert.equal(health.ok, true);
    assert(Array.isArray(health.routes));
    assert(health.routes.includes("/v1/symphony/status"));

    const status = await readJson<SymphonyStatusPayload>(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(status.workflow.ok, true);
    assert.equal(status.workflow.workflow.path, fixture.workflowPath);
    assert.equal(status.scheduler.capacity.max_concurrent, 2);
    assert.deepEqual(status.totals, {
      sessions: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retrying: 0
    });
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony status returns a JSON error for missing workflow", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const response = await fetch(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(join(fixture.root, "missing-WORKFLOW.md"))}`);
    const body = await response.json() as { error?: { status?: number; message?: string } };

    assert.equal(response.status, 400);
    assert.equal(body.error?.status, 400);
    assert.match(body.error?.message ?? "", /missing_workflow_file/);
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony cleanup dry-run is available through local-control auth", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const response = await fetch(`${started.url}/v1/symphony/cleanup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        workflow_path: fixture.workflowPath,
        execute: false
      })
    });
    const body = await response.json() as {
      execute?: boolean;
      inspected?: number;
      removed?: number;
      workflow?: { ok?: boolean };
    };

    assert.equal(response.status, 200);
    assert.equal(body.workflow?.ok, true);
    assert.equal(body.execute, false);
    assert.equal(body.inspected, 0);
    assert.equal(body.removed, 0);
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony preview exposes normalized product-surface evidence through the real HTTP route", async () => {
  const fixture = createPreviewFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const response = await fetch(`${started.url}/v1/symphony/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        workflow_path: fixture.workflowPath,
        create_workspace: false
      })
    });
    const body = await response.json() as PreviewResponse;

    assert.equal(response.status, 201);
    assert.equal(body.workflow.path, fixture.workflowPath);
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items.map((item) => item.human_id).sort(), ["WK-101", "WK-102"]);
    assert.equal(body.items.some((item) => item.human_id === "WK-103"), false);
    for (const item of body.items) {
      assert.equal(item.source, "symphony");
      assert.equal(item.state, "Todo");
      assert.deepEqual(item.labels, ["local"]);
      assert.equal(item.metadata.work_source_kind, "local");
      assert.equal(item.metadata.local_path, fixture.workItemsPath);
    }

    assert.equal(body.sessions.length, 2);
    const itemByObjective = new Map(body.items.map((item) => [previewObjective(item), item] as const));
    for (const preview of body.sessions) {
      const sessionSnapshot = recordValue(preview.session);
      const objective = stringValue(sessionSnapshot.objective, "session objective");
      const workItem = itemByObjective.get(objective);
      assert(workItem, `Missing preview work item for objective: ${objective}`);
      const sessionId = stringValue(sessionSnapshot.session_id, "session_id");
      const workspaceLeaseId = stringValue(sessionSnapshot.workspace_lease_id, "workspace_lease_id");
      const sourceJson = stringValue(sessionSnapshot.source_json, "session source_json");
      assert.equal(sessionSnapshot.status, "created");
      assert.equal(preview.prompt, previewPrompt(workItem));
      assert.equal(preview.workspace_path, resolve(fixture.workspaceRoot, sanitizeWorkspaceKey(workItem.human_id ?? workItem.source_id ?? workItem.title)));

      const source = parseJson<WorkItem>(sourceJson, "session source_json");
      assert.deepEqual(source, workItem);

      const workSnapshot = recordValue(sessionSnapshot.work_snapshot);
      const workSnapshotSession = recordValue(workSnapshot.session);
      assert.deepEqual(workSnapshotSession.source, workItem);

      const lease = server.runtime.workspaceLeaseStore.get(workspaceLeaseId);
      assert(lease, "missing WorkspaceLease row");
      assert.equal(lease.session_id, sessionId);
      assert.equal(lease.workspace_root, resolve(fixture.workspaceRoot));
      assert.equal(lease.workspace_path, preview.workspace_path);
      assert.equal(lease.write_boundary, "workspace");
      assert.equal(lease.metadata.kind, "symphony_workspace");
      assert.equal(lease.metadata.workspace_key, sanitizeWorkspaceKey(workItem.human_id ?? workItem.source_id ?? workItem.title));
      assert.deepEqual(lease.metadata.work_item, workItem);
      assert.equal(existsSync(preview.workspace_path), false, "create_workspace=false should not create the per-item workspace path");

      const entries = server.runtime.blackboardStore.list(sessionId).filter((entry) => entry.key === "symphony.preview");
      assert.equal(entries.length, 1);
      assertPreviewEntry(entries[0], {
        workflowPath: fixture.workflowPath,
        workItem,
        workspacePath: preview.workspace_path
      });
    }

    const sessionRows = server.runtime.sessionStore.listBySource("symphony");
    assert.equal(sessionRows.length, 2);
    assert.deepEqual(sessionRows.map((row) => row.status).sort(), ["created", "created"]);
    assert.deepEqual(
      sessionRows.map((row) => parseJson<WorkItem>(row.source_json, "stored session source").human_id).sort(),
      ["WK-101", "WK-102"]
    );
    assert.equal(
      sessionRows.some((row) => parseJson<WorkItem>(row.source_json, "stored session source").human_id === "WK-103"),
      false
    );
  } finally {
    await server.stop();
    fixture.close();
  }
});

type JsonRecord = Record<string, unknown>;

type GatewayHealthPayload = {
  ok: boolean;
  routes: string[];
};

type SymphonyStatusPayload = {
  workflow: {
    ok: boolean;
    workflow: {
      path: string;
    };
  };
  scheduler: {
    capacity: {
      max_concurrent: number;
    };
  };
  totals: {
    sessions: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    retrying: number;
  };
};

type PreviewResponse = {
  workflow: {
    path: string;
  };
  items: WorkItem[];
  sessions: Array<{
    session: Record<string, unknown>;
    workspace_path: string;
    prompt: string;
  }>;
};

function createFixture(): { root: string; workflowPath: string; databasePath: string; close(): void } {
  const root = join(tmpdir(), `swarm-gateway-symphony-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(workflowPath, workflowText(workspaceRoot), "utf8");
  return {
    root,
    workflowPath,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createPreviewFixture(): {
  root: string;
  workspaceRoot: string;
  workItemsPath: string;
  workflowPath: string;
  databasePath: string;
  close(): void;
} {
  const root = join(tmpdir(), `swarm-gateway-symphony-preview-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceRoot = join(root, "workspaces");
  const workItemsPath = join(root, "WORK_ITEMS.md");
  const workflowPath = join(root, "WORKFLOW.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(workItemsPath, previewWorkItemsText(), "utf8");
  writeFileSync(workflowPath, previewWorkflowText(workItemsPath, workspaceRoot), "utf8");
  return {
    root,
    workspaceRoot,
    workItemsPath,
    workflowPath,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function readJson<T = JsonRecord>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as JsonRecord;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body as T;
}

function assertPreviewEntry(
  entry: BlackboardEntry,
  expected: { workflowPath: string; workItem: WorkItem; workspacePath: string }
): void {
  assert.equal(entry.type, "plan");
  assert.equal(entry.key, "symphony.preview");
  assert.equal(entry.created_by.agent_id, "symphony");
  assert.deepEqual(entry.tags, ["symphony", "preview", "workflow"]);

  const value = recordValue(entry.value);
  assert.equal(stringValue(value.workflow_path, "blackboard.workflow_path"), expected.workflowPath);
  assert.deepEqual(value.work_item, expected.workItem);
  assert.equal(stringValue(value.workspace_path, "blackboard.workspace_path"), expected.workspacePath);
  assert.equal(stringValue(value.prompt, "blackboard.prompt"), previewPrompt(expected.workItem));
}

function previewObjective(item: WorkItem): string {
  return `${item.human_id}: ${item.title}`;
}

function previewPrompt(item: WorkItem): string {
  return `Preview ${item.human_id} | ${item.title} | state=${item.state} | source=${item.source_id}`;
}

function workflowText(workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 2",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}

function previewWorkItemsText(): string {
  return [
    "# Local work",
    "- [ ] WK-101: Normalize active preview item",
    "- [ ] WK-102: Persist preview metadata",
    "- [x] WK-103: Terminal item must not preview"
  ].join("\n");
}

function previewWorkflowText(workItemsPath: string, workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: local",
    `  path: \"${workItemsPath.replace(/\\/g, "/")}\"`,
    "  active_states: [Todo]",
    "  terminal_states: [Done]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 2",
    "---",
    "Preview {{ issue.identifier }} | {{ issue.title }} | state={{ issue.state }} | source={{ issue.source_id }}"
  ].join("\n");
}

function recordValue(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected record value");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${description}`);
  }
  return value;
}

function parseJson<T>(value: string | null | undefined, description: string): T {
  assert(value, `missing ${description}`);
  return JSON.parse(value) as T;
}
