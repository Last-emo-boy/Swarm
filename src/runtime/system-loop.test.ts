import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmRuntime } from "./runtime.js";
import { RuntimeSystemLoop } from "./system-loop.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";
import { SwarmDatabase } from "../storage/database.js";
import { SessionStore } from "../storage/session-store.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { SymphonyClaimStore } from "../storage/symphony-claim-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";

test("runtime system loop dispatches Symphony work through kernel records without slash command entrypoints", async () => {
  const fixture = createFixture({ systemLoop: ["system_loop:", "  enabled: true", "  execute: false"] });
  try {
    const loop = new RuntimeSystemLoop(fixture.runtime, { workflowPath: fixture.workflowPath, debounceMs: 0, startupTick: false });
    loop.start();

    const result = await loop.runOnce("test");

    assert.equal(result.status, "ticked");
    assert.equal(result.status === "ticked" ? result.result.dispatched.length : 0, 1);
    const sessions = fixture.runtime.sessionStore.listBySource("symphony");
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0].session_id;
    assert.equal(fixture.runtime.traceStore.list(sessionId).some((envelope) => envelope.type === "task.assign"), true);
    assert.equal(fixture.runtime.blackboardStore.query(sessionId, { keyPrefix: "symphony.dispatch" }).length, 1);
    assert.equal(fixture.events.some((event) => event.type === "envelope" && event.envelope.intent === "symphony.dispatch"), true);
  } finally {
    fixture.close();
  }
});

test("runtime system loop honors WORKFLOW system_loop.enabled=false", async () => {
  const fixture = createFixture({ systemLoop: ["system_loop:", "  enabled: false"] });
  try {
    const loop = new RuntimeSystemLoop(fixture.runtime, { workflowPath: fixture.workflowPath, debounceMs: 0, startupTick: false });
    loop.start();

    const result = await loop.runOnce("test");

    assert.deepEqual(result, { status: "skipped", reason: "disabled", workflowPath: fixture.workflowPath });
    assert.equal(fixture.runtime.sessionStore.listBySource("symphony").length, 0);
  } finally {
    fixture.close();
  }
});

function createFixture(input: { systemLoop: string[] }): {
  root: string;
  workflowPath: string;
  runtime: SwarmRuntime & {
    sessionStore: SessionStore;
    traceStore: TraceStore;
    blackboardStore: BlackboardStore;
  };
  events: RuntimeEvent[];
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-runtime-system-loop-"));
  const workItemsPath = join(root, "WORK_ITEMS.md");
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  writeFileSync(workItemsPath, "- [ ] SYS-1: Run background work\n", "utf8");
  writeFileSync(workflowPath, workflowText(workItemsPath, workspaceRoot, input.systemLoop), "utf8");

  const database = new SwarmDatabase(join(root, "swarm.db"));
  const events = new RuntimeEvents();
  const capturedEvents: RuntimeEvent[] = [];
  events.onEvent((event) => capturedEvents.push(event));

  const runtime = {
    database,
    events,
    sessionStore: new SessionStore(database),
    runAttemptStore: new RunAttemptStore(database),
    workspaceLeaseStore: new WorkspaceLeaseStore(database),
    symphonyClaimStore: new SymphonyClaimStore(database),
    taskStateStore: new TaskStateStore(database),
    traceStore: new TraceStore(database),
    blackboardStore: new BlackboardStore(database),
    settings: {
      runtime: {
        maxAgents: 4,
        maxParallelTasks: 4,
        taskTimeoutMs: 10_000,
        projectArtifactDir: ".swarm/artifacts"
      }
    },
    workspaceRoot: () => root,
    getWorkSnapshot: (sessionId: string) => ({
      session: {
        session_id: sessionId,
        swarm_id: `swarm_${sessionId}`,
        objective: "Runtime system loop test",
        status: "running",
        created_at: "2026-05-14T00:00:00.000Z",
        updated_at: "2026-05-14T00:00:00.000Z"
      },
      attempts: [],
      workers: [],
      graph: { tasks: [], edges: [] },
      blackboard_counts: {},
      changed_files: [],
      checks: [],
      usage_summary: {},
      task_contracts: {
        summary: {
          total: 0,
          pending: 0,
          running: 0,
          blocked: 0,
          completed: 0,
          failed: 0,
          read_only: 0,
          scoped_write: 0,
          workspace_write: 0,
          scoped_targets: []
        },
        tasks: []
      },
      work_contracts: {
        summary: {
          active_workers: 0,
          running_workers: 0,
          pending_workers: 0,
          resumable_workers: 0,
          active_handoffs: 0,
          read_only: 0,
          scoped_write: 0,
          workspace_write: 0,
          scoped_targets: []
        },
        workers: [],
        handoffs: []
      }
    }),
    interruptWorkSession: () => false
  } as unknown as SwarmRuntime & {
    sessionStore: SessionStore;
    traceStore: TraceStore;
    blackboardStore: BlackboardStore;
  };

  return {
    root,
    workflowPath,
    runtime,
    events: capturedEvents,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function workflowText(workItemsPath: string, workspaceRoot: string, systemLoop: string[]): string {
  return [
    "---",
    "work_source:",
    "  kind: local",
    `  path: ${JSON.stringify(workItemsPath)}`,
    "workspace:",
    `  root: ${JSON.stringify(workspaceRoot)}`,
    "agent:",
    "  max_concurrent_agents: 2",
    ...systemLoop,
    "---",
    "Implement {{issue.title}}"
  ].join("\n");
}
