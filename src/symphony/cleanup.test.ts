import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmSession, WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { RuntimeEvents, type RuntimeEvent } from "../runtime/events.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { AuditStore } from "../storage/audit-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionStore } from "../storage/session-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { createSymphonyPolicy } from "./kernel.js";
import { cleanupSymphonyWorkspaces } from "./cleanup.js";
import { normalizeRecordToWorkItem } from "./work-source.js";

const OLD_AT = "2026-05-10T00:00:00.000Z";

test("cleanup dry-run marks eligible terminal workspaces without removing them", async () => {
  const fixture = createFixture();
  try {
    const item = workItem("CLN-101", "Done");
    const workspacePath = seedSession(fixture, {
      sessionId: "sym_cleanup_dry_run",
      item,
      status: "completed"
    });

    const result = await cleanupSymphonyWorkspaces({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath
    });

    assert.equal(result.workflow.ok, true);
    assert.equal(result.execute, false);
    assert.equal(result.inspected, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.records[0].status, "eligible");
    assert.equal(result.records[0].reason, "dry_run");
    assert.equal(existsSync(workspacePath), true);
  } finally {
    fixture.close();
  }
});

test("cleanup applies terminal, keep-latest, min-age, and workspace safety gates", async () => {
  const fixture = createFixture({ minAgeMs: 60_000, keepLatest: 1 });
  try {
    seedSession(fixture, {
      sessionId: "sym_cleanup_old",
      item: workItem("CLN-201", "Done"),
      status: "completed",
      updatedAt: OLD_AT
    });
    seedSession(fixture, {
      sessionId: "sym_cleanup_latest",
      item: workItem("CLN-202", "Done"),
      status: "completed",
      updatedAt: new Date().toISOString()
    });
    seedSession(fixture, {
      sessionId: "sym_cleanup_running",
      item: workItem("CLN-203", "Todo"),
      status: "running",
      updatedAt: OLD_AT
    });
    seedSession(fixture, {
      sessionId: "sym_cleanup_equal_root",
      item: workItem("CLN-204", "Done"),
      status: "completed",
      updatedAt: OLD_AT,
      workspacePath: fixture.workspaceRoot
    });

    const result = await cleanupSymphonyWorkspaces({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath
    });
    const reasons = Object.fromEntries(result.records.map((record) => [record.session_id, record.reason]));

    assert.equal(reasons.sym_cleanup_old, "dry_run");
    assert.equal(reasons.sym_cleanup_latest, "retention_keep_latest");
    assert.equal(reasons.sym_cleanup_running, "session_not_terminal");
    assert.equal(reasons.sym_cleanup_equal_root, "workspace_outside_or_equal_root");
  } finally {
    fixture.close();
  }
});

test("cleanup execute requires approval and records the blocked decision", async () => {
  const fixture = createFixture();
  const oldApprove = process.env.SWARM_SYMPHONY_CLEANUP_APPROVE;
  try {
    delete process.env.SWARM_SYMPHONY_CLEANUP_APPROVE;
    const workspacePath = seedSession(fixture, {
      sessionId: "sym_cleanup_needs_approval",
      item: workItem("CLN-301", "Done"),
      status: "completed",
      updatedAt: OLD_AT
    });

    const result = await cleanupSymphonyWorkspaces({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      execute: true
    });

    assert.equal(result.removed, 0);
    assert.equal(result.records[0].status, "skipped");
    assert.equal(result.records[0].reason, "approval_required");
    assert.equal(existsSync(workspacePath), true);
    assert.equal(fixture.runtime.runAttemptStore.list("sym_cleanup_needs_approval")[0]?.status, "cancelled");
    assert.equal(fixture.runtime.auditStore.list("sym_cleanup_needs_approval")[0]?.decision, "blocked");
    assert.equal(
      fixture.runtime.blackboardStore.query("sym_cleanup_needs_approval", { keyPrefix: "symphony.cleanup.approval_required" }).length,
      1
    );
  } finally {
    restoreEnv("SWARM_SYMPHONY_CLEANUP_APPROVE", oldApprove);
    fixture.close();
  }
});

test("cleanup execute removes approved terminal workspaces inside the root", async () => {
  const fixture = createFixture();
  const oldApprove = process.env.SWARM_SYMPHONY_CLEANUP_APPROVE;
  try {
    process.env.SWARM_SYMPHONY_CLEANUP_APPROVE = "1";
    const workspacePath = seedSession(fixture, {
      sessionId: "sym_cleanup_remove",
      item: workItem("CLN-401", "Done"),
      status: "completed",
      updatedAt: OLD_AT
    });
    writeFileSync(join(workspacePath, "artifact.txt"), "remove me\n", "utf8");

    const result = await cleanupSymphonyWorkspaces({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath,
      execute: true
    });

    assert.equal(result.removed, 1);
    assert.equal(result.records[0].status, "removed");
    assert.equal(result.records[0].reason, "removed");
    assert.equal(existsSync(workspacePath), false);
    assert.equal(fixture.runtime.runAttemptStore.list("sym_cleanup_remove")[0]?.status, "completed");
    assert.equal(
      fixture.runtime.blackboardStore.query("sym_cleanup_remove", { keyPrefix: "symphony.cleanup.removed" }).length,
      1
    );
  } finally {
    restoreEnv("SWARM_SYMPHONY_CLEANUP_APPROVE", oldApprove);
    fixture.close();
  }
});

type Fixture = {
  root: string;
  workspaceRoot: string;
  workflowPath: string;
  database: SwarmDatabase;
  runtime: SwarmRuntime & {
    sessionStore: SessionStore;
    workspaceLeaseStore: WorkspaceLeaseStore;
    runAttemptStore: RunAttemptStore;
    blackboardStore: BlackboardStore;
    auditStore: AuditStore;
  };
  events: RuntimeEvent[];
  close(): void;
};

function createFixture(input: { minAgeMs?: number; keepLatest?: number } = {}): Fixture {
  const root = join(tmpdir(), `swarm-symphony-cleanup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(workflowPath, workflowText(workspaceRoot, input), "utf8");
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const events = new RuntimeEvents();
  const capturedEvents: RuntimeEvent[] = [];
  events.onEvent((event) => {
    capturedEvents.push(event);
  });
  const runtime = {
    database,
    events,
    sessionStore: new SessionStore(database),
    workspaceLeaseStore: new WorkspaceLeaseStore(database),
    runAttemptStore: new RunAttemptStore(database),
    blackboardStore: new BlackboardStore(database),
    auditStore: new AuditStore(database),
    artifactStore: new ArtifactStore(database),
    settings: {
      runtime: {
        projectArtifactDir: ".swarm/artifacts"
      }
    },
    workspaceRoot: () => root
  } as unknown as Fixture["runtime"];
  return {
    root,
    workspaceRoot,
    workflowPath,
    database,
    runtime,
    events: capturedEvents,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function seedSession(
  fixture: Fixture,
  input: {
    sessionId: string;
    item: WorkItem;
    status: SwarmSession["status"];
    updatedAt?: string;
    workspacePath?: string;
  }
): string {
  const workspacePath = input.workspacePath ?? join(fixture.workspaceRoot, input.item.human_id ?? input.item.source_id ?? input.sessionId);
  mkdirSync(workspacePath, { recursive: true });
  const lease = fixture.runtime.workspaceLeaseStore.create({
    lease_id: `lease_${input.sessionId}`,
    session_id: input.sessionId,
    workspace_root: fixture.workspaceRoot,
    workspace_path: workspacePath,
    scope: [],
    write_boundary: "workspace",
    metadata: { kind: "symphony_workspace" },
    created_at: input.updatedAt ?? OLD_AT
  });
  fixture.runtime.sessionStore.create({
    swarm_id: `swarm_${input.sessionId}`,
    session_id: input.sessionId,
    user_request_id: input.item.source_id ?? input.sessionId,
    source: input.item,
    workspace_lease_id: lease.lease_id,
    objective: input.item.title,
    status: input.status,
    coordinator: { agent_id: "symphony", role: "scheduler" },
    participants: [],
    created_at: input.updatedAt ?? OLD_AT,
    updated_at: input.updatedAt ?? OLD_AT,
    policy: createSymphonyPolicy(4, 10_000)
  });
  return workspacePath;
}

function workflowText(
  workspaceRoot: string,
  input: { minAgeMs?: number; keepLatest?: number }
): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "cleanup:",
    "  retention:",
    `    min_age_ms: ${input.minAgeMs ?? 0}`,
    `    keep_latest: ${input.keepLatest ?? 0}`,
    "    preserve_artifacts: false",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}

function workItem(identifier: string, state: string): WorkItem {
  return normalizeRecordToWorkItem({
    id: identifier.toLowerCase(),
    identifier,
    title: `Work item ${identifier}`,
    priority: 1,
    state,
    labels: ["test"],
    created_at: OLD_AT,
    updated_at: OLD_AT
  }, "fake");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
