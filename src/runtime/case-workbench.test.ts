import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmPolicy, SwarmSession, WorkItem } from "../protocol/types.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { SwarmRuntime } from "./runtime.js";

test("case workbench projection groups session families and surfaces no-workspace cases", () => {
  const fixture = createFixture();
  const runtime = createRuntime(fixture, fixture.workspaceA);
  try {
    seedSession(runtime, {
      sessionId: "case-alpha",
      workspace: fixture.workspaceA,
      objective: "Ship case-driven TUI",
      source: workItem("user", "Case-driven TUI"),
      status: "running"
    });
    seedSession(runtime, {
      sessionId: "case-alpha-worker",
      parentSessionId: "case-alpha",
      workspace: fixture.workspaceA,
      objective: "Implement left rail",
      status: "running"
    });
    runtime.workerStateStore.create({
      worker_id: "worker-alpha",
      display_name: "Ada",
      role_title: "Coder",
      parent_session_id: "case-alpha",
      capability: "code.implement",
      objective: "Implement left rail",
      status: "running",
      file_scope: ["src/tui/SwarmChatApp.tsx"],
      tool_budget: { max_turns: 2, max_tool_calls: 6 }
    });
    runtime.runAttemptStore.upsert({
      session_id: "case-alpha",
      kind: "verification",
      status: "completed",
      title: "npm run check",
      workspace_path: fixture.workspaceA
    });

    seedSession(runtime, {
      sessionId: "case-beta",
      workspace: fixture.workspaceB,
      objective: "Fix sibling workspace issue",
      source: workItem("symphony", "Sibling automation"),
      status: "completed"
    });

    seedSession(runtime, {
      sessionId: "case-noworkspace",
      objective: "Plan without attached repository",
      source: workItem("gateway", "No workspace plan"),
      status: "planning",
      createLease: false
    });

    const projection = runtime.buildGlobalCaseWorkbench(10);

    assert.equal(projection.schema_version, "swarm.case_workbench.v1");
    assert.equal(projection.summary.cases, 3);
    assert(projection.cases.some((item) => item.case_id === "case-alpha" && item.session_count === 2));
    assert(projection.cases.some((item) => item.case_id === "case-beta" && item.workspace_path === fixture.workspaceB));
    const noWorkspace = projection.cases.find((item) => item.case_id === "case-noworkspace");
    assert(noWorkspace, "expected no-workspace case");
    assert.equal(noWorkspace.workspace_label, "no workspace");
    assert.equal(noWorkspace.workspace_path, undefined);
    assert.equal(noWorkspace.write_boundary, undefined);
    assert(noWorkspace.badges.includes("no-workspace"));
    assert.equal(noWorkspace.next_action, "Attach a workspace lease before running workspace-write actions.");
    const noWorkspaceInbox = projection.inbox.find((item) => item.case_id === "case-noworkspace" && item.kind === "no_workspace");
    assert(noWorkspaceInbox, "expected no-workspace inbox item");
    assert.equal(noWorkspaceInbox.recommended_action, "Attach or choose a workspace before running workspace-write actions.");
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("case workbench detail aggregates workers approvals attempts artifacts and session family", () => {
  const fixture = createFixture();
  const runtime = createRuntime(fixture, fixture.workspaceA);
  try {
    seedSession(runtime, {
      sessionId: "case-detail",
      workspace: fixture.workspaceA,
      objective: "Investigate case detail",
      source: workItem("user", "Investigate case detail"),
      status: "running"
    });
    seedSession(runtime, {
      sessionId: "case-detail-child",
      parentSessionId: "case-detail",
      workspace: fixture.workspaceA,
      objective: "Child work",
      status: "running"
    });
    runtime.workerStateStore.create({
      worker_id: "worker-blocked",
      display_name: "Noether",
      parent_session_id: "case-detail",
      capability: "analysis",
      objective: "Analyze blocker",
      status: "running",
      blocked_reason: "Needs approval to inspect logs.",
      file_scope: [],
      tool_budget: { max_turns: 1, max_tool_calls: 3 }
    });
    runtime.approvalStore.upsert(approvalRequest("approval-detail", "case-detail", "Allow log read"), "pending");
    runtime.runAttemptStore.upsert({
      attempt_id: "attempt-detail-check",
      session_id: "case-detail",
      kind: "verification",
      status: "failed",
      title: "npm test",
      recovery_suggestion: "Fix the failing test and rerun.",
      workspace_path: fixture.workspaceA
    });
    runtime.artifactStore.create({
      artifact_id: "artifact-detail",
      session_id: "case-detail",
      path: "reports/detail.md",
      type: "report",
      summary: "Case detail report"
    });

    const detail = runtime.getCaseWorkbenchDetail("case-detail-child");

    assert(detail, "expected case detail for child session selector");
    assert.equal(detail.case_id, "case-detail");
    assert.equal(detail.status, "blocked");
    assert.equal(detail.sessions.length, 2);
    assert.equal(detail.workers.length, 1);
    assert.equal(detail.approvals.length, 1);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.artifacts.length, 1);
    assert(detail.timeline.some((line) => /approval approval-detail pending/.test(line)));
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

function createRuntime(fixture: Fixture, workspace: string): SwarmRuntime {
  return new SwarmRuntime({
    workspace,
    databasePath: fixture.databasePath
  });
}

function seedSession(
  runtime: SwarmRuntime,
  input: {
    sessionId: string;
    objective: string;
    status: SwarmSession["status"];
    workspace?: string;
    parentSessionId?: string;
    source?: WorkItem;
    createLease?: boolean;
  }
): void {
  const now = new Date().toISOString();
  const lease = input.createLease === false || !input.workspace
    ? undefined
    : runtime.workspaceLeaseStore.create({
        lease_id: `lease-${input.sessionId}`,
        session_id: input.sessionId,
        workspace_root: input.workspace,
        workspace_path: input.workspace,
        scope: [],
        write_boundary: "workspace",
        metadata: { kind: "case-workbench-test" },
        created_at: now
      });
  runtime.sessionStore.create({
    swarm_id: `swarm-${input.sessionId}`,
    session_id: input.sessionId,
    user_request_id: `request-${input.sessionId}`,
    source: input.source,
    parent_session_id: input.parentSessionId,
    workspace_lease_id: lease?.lease_id,
    objective: input.objective,
    status: input.status,
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
  });
}

function workItem(source: string, title: string): WorkItem {
  return {
    source,
    source_id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    human_id: title,
    title,
    labels: [],
    metadata: {}
  };
}

function approvalRequest(id: string, sessionId: string, summary: string): ToolApprovalRequest {
  return {
    id,
    session_id: sessionId,
    action: "shell",
    summary,
    detail: "Read logs for diagnosis.",
    risk: "shell",
    risk_class: "r2",
    target: "Get-Content logs/debug.log",
    why_now: "The case is blocked on log evidence.",
    predicted_impact: "Reads local debug logs.",
    rollback_plan: "No persistent change.",
    attention_note: "Approve log read to unblock the case."
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 60_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: false,
    consensus: "coordinator_decision",
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: [],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    }
  };
}

type Fixture = {
  root: string;
  workspaceA: string;
  workspaceB: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-case-workbench-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  return {
    root,
    workspaceA,
    workspaceB,
    databasePath: join(root, "swarm.db"),
    close: () => rmSync(root, { recursive: true, force: true })
  };
}
