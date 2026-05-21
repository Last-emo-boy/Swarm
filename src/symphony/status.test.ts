import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmSession, WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { RuntimeEvents } from "../runtime/events.js";
import { SwarmDatabase } from "../storage/database.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { SessionStore } from "../storage/session-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { createSymphonyPolicy } from "./kernel.js";
import { runSymphonyPreflight } from "./preflight.js";
import { formatSymphonyCliStatus } from "./status-format.js";
import { getSymphonyStatus } from "./status.js";
import { loadWorkflow, normalizeWorkflowConfig, renderWorkflowPrompt } from "./workflow.js";
import { normalizeRecordToWorkItem } from "./work-source.js";
import { workItemKey } from "./work-item.js";

const AT = "2026-05-11T00:00:00.000Z";

test("status summarizes Symphony sessions, capacity, and retry ordering from kernel stores", () => {
  const fixture = createFixture({ maxConcurrent: 3, runtimeMaxAgents: 6 });
  try {
    const runningA = workItem("WK-501", "Todo");
    const runningB = workItem("WK-502", "In Progress");
    const completed = workItem("WK-503", "Done");
    const failedRetryEarly = workItem("WK-504", "Todo");
    const cancelledRetryLate = workItem("WK-505", "Todo");

    seedSession(fixture, { sessionId: "sym_status_running_a", item: runningA, status: "running" });
    seedAttempt(fixture, "sym_status_running_a", "symphony.dispatch", "completed", { workspacePath: workspaceFor(fixture, runningA) });
    seedSession(fixture, { sessionId: "sym_status_running_b", item: runningB, status: "planning" });
    seedAttempt(fixture, "sym_status_running_b", "symphony.dispatch", "completed", { workspacePath: workspaceFor(fixture, runningB) });
    seedSession(fixture, { sessionId: "sym_status_completed", item: completed, status: "completed" });
    seedAttempt(fixture, "sym_status_completed", "symphony.runner", "completed", { workspacePath: workspaceFor(fixture, completed) });
    seedSession(fixture, { sessionId: "sym_status_retry_early", item: failedRetryEarly, status: "failed" });
    seedAttempt(fixture, "sym_status_retry_early", "symphony.retry", "started", {
      attempt: 1,
      terminalReason: "early retry",
      metadata: { due_at: "2026-05-11T09:00:00.000Z" }
    });
    seedSession(fixture, { sessionId: "sym_status_retry_late", item: cancelledRetryLate, status: "cancelled" });
    seedAttempt(fixture, "sym_status_retry_late", "symphony.retry", "started", {
      attempt: 2,
      terminalReason: "late retry",
      metadata: { due_at: "2026-05-11T10:00:00.000Z" }
    });

    const status = getSymphonyStatus({ runtime: fixture.runtime, workflowPath: fixture.workflowPath });

    assert.equal(status.workflow.ok, true);
    assert.deepEqual(status.totals, {
      sessions: 5,
      running: 2,
      completed: 1,
      failed: 1,
      cancelled: 1,
      retrying: 2
    });
    assert.deepEqual(status.scheduler.capacity, { max_concurrent: 3, running: 2, available: 1 });
    assert.deepEqual(status.scheduler.claimed, [workItemKey(runningA), workItemKey(runningB)].sort());
    assert.deepEqual(status.scheduler.completed, [workItemKey(completed)]);
    assert.deepEqual(status.scheduler.retrying.map((retry) => retry.key), [
      workItemKey(failedRetryEarly),
      workItemKey(cancelledRetryLate)
    ]);
    assert.deepEqual(status.scheduler.retrying.map((retry) => retry.attempt), [1, 2]);
    assert.equal(status.sessions.length, 5);
  } finally {
    fixture.close();
  }
});

test("status falls back without workflow and ignores malformed Symphony source rows", () => {
  const fixture = createFixture({ maxConcurrent: 2, runtimeMaxAgents: 5 });
  try {
    fixture.database.db.prepare(
      `INSERT INTO sessions (
        session_id, swarm_id, objective, status, source_json, policy_json, participants_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "sym_malformed",
      "swarm_sym_malformed",
      "Malformed Symphony source",
      "running",
      JSON.stringify({ source: "symphony", title: 123, labels: [], metadata: {} }),
      JSON.stringify(createSymphonyPolicy(2, 10_000)),
      "[]",
      AT,
      AT
    );

    const status = getSymphonyStatus({
      runtime: fixture.runtime,
      workflowPath: join(fixture.root, "missing-WORKFLOW.md")
    });

    assert.equal(status.workflow.ok, false);
    assert.deepEqual(status.totals, {
      sessions: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retrying: 0
    });
    assert.deepEqual(status.scheduler, {
      claimed: [],
      completed: [],
      running: [],
      retrying: [],
      capacity: {
        max_concurrent: 5,
        running: 0,
        available: 5
      }
    });
  } finally {
    fixture.close();
  }
});

test("workflow loader reports malformed frontmatter and template errors", () => {
  const fixture = createFixture({ maxConcurrent: 2, runtimeMaxAgents: 5 });
  try {
    const cases: Array<{ name: string; body: string; code: string; message: RegExp }> = [
      {
        name: "unclosed",
        body: ["---", "work_source:", "  kind: fake"].join("\n"),
        code: "workflow_parse_error",
        message: /Unclosed YAML front matter/
      },
      {
        name: "non-map",
        body: ["---", "- nope", "---", "Implement {{issue.title}}"].join("\n"),
        code: "workflow_front_matter_not_a_map",
        message: /must be a map/
      },
      {
        name: "unsupported-line",
        body: ["---", "work_source:", "  kind: fake", "not yaml", "---", "Implement {{issue.title}}"].join("\n"),
        code: "workflow_parse_error",
        message: /Unsupported front matter line/
      },
      {
        name: "empty-key",
        body: ["---", ": value", "---", "Implement {{issue.title}}"].join("\n"),
        code: "workflow_parse_error",
        message: /Empty key/
      }
    ];

    for (const item of cases) {
      const path = join(fixture.root, `${item.name}-WORKFLOW.md`);
      writeFileSync(path, item.body, "utf8");
      const result = loadWorkflow(path);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, item.code);
        assert.match(result.error.message, item.message);
      }
    }

    const workflow = loadWorkflow(fixture.workflowPath);
    assert.equal(workflow.ok, true);
    if (workflow.ok) {
      assert.throws(
        () => renderWorkflowPrompt({
          workflow: {
            ...workflow.workflow,
            prompt_template: "Implement {{issue.missing}}"
          },
          issue: { title: "Test" }
        }),
        /Unknown workflow template variable: issue\.missing/
      );
    }
  } finally {
    fixture.close();
  }
});

test("preflight returns structured template render issues", () => {
  const fixture = createFixture({ maxConcurrent: 2, runtimeMaxAgents: 5 });
  try {
    const workflow = loadWorkflow(fixture.workflowPath);
    assert.equal(workflow.ok, true);
    if (!workflow.ok) {
      return;
    }
    const brokenWorkflow = {
      ...workflow.workflow,
      prompt_template: "Implement {{issue.missing}}"
    };
    const item = workItem("WK-600", "Todo");
    const result = runSymphonyPreflight({
      runtime: fixture.runtime,
      workflow: brokenWorkflow,
      config: normalizeWorkflowConfig(brokenWorkflow),
      candidates: [item]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      work_item_key: issue.work_item_key,
      message: issue.message
    })), [{
      code: "TEMPLATE_RENDER_FAILED",
      severity: "error",
      work_item_key: workItemKey(item),
      message: "Unknown workflow template variable: issue.missing"
    }]);
  } finally {
    fixture.close();
  }
});

test("CLI Symphony status formatter covers success and workflow errors without process IO", () => {
  const fixture = createFixture({ maxConcurrent: 3, runtimeMaxAgents: 6 });
  try {
    const running = workItem("WK-701", "Todo");
    const retrying = workItem("WK-702", "Todo");
    seedSession(fixture, { sessionId: "sym_cli_running", item: running, status: "running" });
    seedAttempt(fixture, "sym_cli_running", "symphony.runner", "started", { workspacePath: workspaceFor(fixture, running) });
    seedSession(fixture, { sessionId: "sym_cli_retry", item: retrying, status: "failed" });
    seedAttempt(fixture, "sym_cli_retry", "symphony.retry", "started", {
      attempt: 3,
      terminalReason: "retry later",
      metadata: { due_at: "2026-05-11T11:00:00.000Z" }
    });

    const formatted = formatSymphonyCliStatus(getSymphonyStatus({
      runtime: fixture.runtime,
      workflowPath: fixture.workflowPath
    }));

    assert.equal(formatted.ok, true);
    assert.match(formatted.lines.join("\n"), /Workflow: .*WORKFLOW\.md/);
    assert(formatted.lines.includes("Sessions: 2 running=1 completed=0 failed=1 cancelled=0 retrying=1"));
    assert(formatted.lines.includes("Capacity: 1/3"));
    assert(formatted.lines.includes("Retrying:"));
    assert.match(formatted.lines.join("\n"), /WK-702: attempt=3 due=2026-05-11T11:00:00\.000Z error=retry later/);
    assert(formatted.lines.includes("Sessions:"));
    assert.match(formatted.lines.join("\n"), /sym_cli_running \[running\] WK-701 runner=started/);

    const missing = formatSymphonyCliStatus(getSymphonyStatus({
      runtime: fixture.runtime,
      workflowPath: join(fixture.root, "missing-WORKFLOW.md")
    }));
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.lines[0] ?? "", /missing_workflow_file:/);
  } finally {
    fixture.close();
  }
});

type Fixture = {
  root: string;
  workspaceRoot: string;
  workflowPath: string;
  database: SwarmDatabase;
  runtime: SwarmRuntime;
  close(): void;
};

function createFixture(input: { maxConcurrent: number; runtimeMaxAgents: number }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-symphony-status-"));
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  writeFileSync(workflowPath, workflowText(workspaceRoot, input.maxConcurrent), "utf8");
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const runtime = {
    database,
    events: new RuntimeEvents(),
    sessionStore: new SessionStore(database),
    runAttemptStore: new RunAttemptStore(database),
    workspaceLeaseStore: new WorkspaceLeaseStore(database),
    settings: {
      runtime: {
        maxAgents: input.runtimeMaxAgents,
        taskTimeoutMs: 10_000
      }
    }
  } as unknown as SwarmRuntime;
  return {
    root,
    workspaceRoot,
    workflowPath,
    database,
    runtime,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function workflowText(workspaceRoot: string, maxConcurrent: number): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    `  max_concurrent_agents: ${maxConcurrent}`,
    "  max_retry_backoff_ms: 5000",
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
    created_at: AT,
    updated_at: AT
  }, "fake");
}

function seedSession(
  fixture: Fixture,
  input: {
    sessionId: string;
    item: WorkItem;
    status: SwarmSession["status"];
  }
): void {
  const lease = fixture.runtime.workspaceLeaseStore.create({
    lease_id: `lease_${input.sessionId}`,
    session_id: input.sessionId,
    workspace_root: fixture.workspaceRoot,
    workspace_path: workspaceFor(fixture, input.item),
    scope: [],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
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
    created_at: AT,
    updated_at: AT,
    policy: createSymphonyPolicy(4, 10_000)
  });
}

function seedAttempt(
  fixture: Fixture,
  sessionId: string,
  taskId: string,
  status: "started" | "completed" | "failed" | "cancelled" | "stopped",
  options: {
    attempt?: number;
    terminalReason?: string;
    workspacePath?: string;
    metadata?: Record<string, unknown>;
  } = {}
): void {
  fixture.runtime.runAttemptStore.upsert({
    attempt_id: `attempt_${sessionId}_${taskId}_${options.attempt ?? 0}`,
    session_id: sessionId,
    task_id: taskId,
    runner_id: "symphony.scheduler",
    kind: "swarm_task",
    status,
    attempt: options.attempt ?? 0,
    title: taskId,
    terminal_reason: options.terminalReason,
    workspace_path: options.workspacePath,
    metadata: {
      workflow_path: fixture.workflowPath,
      ...(options.metadata ?? {})
    }
  });
}

function workspaceFor(fixture: Fixture, item: WorkItem): string {
  return join(fixture.workspaceRoot, item.human_id ?? item.source_id ?? "work-item");
}
