import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { AgentTaskPacket } from "../runtime/agent-specs.js";
import type { ReviewResult, SwarmPolicy, WorkItem } from "../protocol/types.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import type { ToolApprovalRequest } from "../tools/types.js";

const SESSION_ID = "session-cand-prod-041-cli";
const SWARM_ID = "swarm-cand-prod-041-cli";
const TASK_ID = "task-sessions-cli-work-snapshot";
const LEASE_ID = "lease-cand-prod-041-cli";
const WORKER_ID = "worker-cand-prod-041-cli";
const HANDOFF_ID = "handoff-cand-prod-041-cli";
const APPROVAL_ID = "approval-cand-prod-041-cli";
const FINAL_SUMMARY = "sessions CLI WorkSnapshot projection complete";
const AT = "2026-05-13T00:00:00.000Z";

test("sessions CLI reads persisted WorkSnapshot projection from local stores", async () => {
  const fixture = await createFixture();

  try {
    await seedPersistedSession(fixture);

    const list = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "sessions",
      "--workspace",
      fixture.workspace,
      "--limit",
      "1"
    ], fixture);

    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.stderr, "");
    assert.match(list.stdout, /Swarm Sessions/);
    assert.match(list.stdout, new RegExp(SESSION_ID));
    assert.match(list.stdout, /source=symphony:CLI-WS-41/);
    assert.match(list.stdout, /changed=2/);
    assert.match(list.stdout, /checks=2/);
    assert.match(list.stdout, /tasks=1/);
    assert.match(list.stdout, /workers=1/);
    assert.match(list.stdout, /approvals=1/);
    assert.match(list.stdout, /stored_plan=yes/);
    assert.match(list.stdout, new RegExp(`final=${escapeRegExp(FINAL_SUMMARY)}`));

    const show = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "sessions",
      "show",
      "latest",
      "--workspace",
      fixture.workspace
    ], fixture);

    assert.equal(show.code, 0, show.stderr);
    assert.equal(show.stderr, "");
    assert.match(show.stdout, /Swarm Session/);
    assert.match(show.stdout, /stored_plan=yes/);
    assert.match(show.stdout, /approval_summary total=1 pending=0 approved=1 denied=0/);
    assert.match(show.stdout, new RegExp(`${SESSION_ID} \\[completed\\]`));
    assert.match(show.stdout, /Source: symphony CLI-WS-41/);
    assert.match(show.stdout, /Workers: 1/);
    assert.match(show.stdout, /Handoffs: 1/);
    assert.match(show.stdout, /Changes: 2/);
    assert.match(show.stdout, /src\/sessions\/report\.test\.ts/);
    assert.match(show.stdout, /\.workflow\/specs\/work-kernel-docs-coverage-matrix\.md/);
    assert.match(show.stdout, /Verification: 2/);
    assert.match(show.stdout, /node --import tsx --test src\/sessions\/report\.test\.ts/);
    assert.match(show.stdout, /npm run check/);
    assert.match(show.stdout, /Review: approve 96 - sessions CLI projection evidence is covered/);
    assert.match(show.stdout, /Approvals: 1/);
    assert.match(show.stdout, new RegExp(`${APPROVAL_ID} \\[approved\\/r1\\] Approve sessions CLI fixture write`));
    assert.match(show.stdout, new RegExp(`Final: ${escapeRegExp(FINAL_SUMMARY)}`));

    const json = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "sessions",
      "show",
      "latest",
      "--workspace",
      fixture.workspace,
      "--json"
    ], fixture);

    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, "");
    const data = parseJsonRecord(json.stdout);
    assert.equal(data.session_id, SESSION_ID);
    const workSnapshot = recordValue(data.work_snapshot, "work_snapshot");
    const blackboardCounts = recordValue(workSnapshot.blackboard_counts, "work_snapshot.blackboard_counts");
    assert.equal(blackboardCounts.evidence, 2);
    assert.equal(blackboardCounts.critique, 1);
    const session = recordValue(workSnapshot.session, "work_snapshot.session");
    const source = recordValue(session.source, "work_snapshot.session.source");
    assert.equal(session.session_id, SESSION_ID);
    assert.equal(source.source, "symphony");
    assert.equal(source.human_id, "CLI-WS-41");
    assert.equal(session.workspace_lease_id, LEASE_ID);

    const workspace = recordValue(workSnapshot.workspace, "work_snapshot.workspace");
    assert.equal(workspace.lease_id, LEASE_ID);
    assert.equal(workspace.workspace_path, fixture.workspace);

    assert.deepEqual(workSnapshot.changed_files, [
      "src/sessions/report.test.ts",
      ".workflow/specs/work-kernel-docs-coverage-matrix.md"
    ]);
    assert.deepEqual(workSnapshot.checks, [
      "node --import tsx --test src/sessions/report.test.ts",
      "npm run check"
    ]);
    assert.equal(recordValue(workSnapshot.final_outcome, "work_snapshot.final_outcome").final_summary, FINAL_SUMMARY);

    const taskContracts = recordValue(data.task_contracts, "task_contracts");
    assert.equal(recordValue(taskContracts.summary, "task_contracts.summary").total, 1);
    assert.equal(recordValue(taskContracts.summary, "task_contracts.summary").completed, 1);
    const workContracts = recordValue(data.work_contracts, "work_contracts");
    assert.equal(recordValue(workContracts.summary, "work_contracts.summary").active_workers, 1);
    assert.equal(recordValue(workContracts.summary, "work_contracts.summary").active_handoffs, 1);
    assert.equal(recordValue(arrayValue(workContracts.active_workers, "work_contracts.active_workers")[0], "work_contracts.active_workers[0]").worker_id, WORKER_ID);
    assert.equal(recordValue(arrayValue(workContracts.active_handoffs, "work_contracts.active_handoffs")[0], "work_contracts.active_handoffs[0]").handoff_id, HANDOFF_ID);

    const graph = recordValue(data.graph, "graph");
    const graphTasks = arrayValue(graph.tasks, "graph.tasks");
    assert.equal(recordValue(graphTasks[0], "graph.tasks[0]").task_id, TASK_ID);
    const approvals = arrayValue(data.approvals, "approvals");
    assert.equal(recordValue(approvals[0], "approvals[0]").approval_id, APPROVAL_ID);

    const ps = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "ps",
      "--workspace",
      fixture.workspace,
      "--limit",
      "1"
    ], fixture);
    assert.equal(ps.code, 0, ps.stderr);
    assert.equal(ps.stderr, "");
    assert.match(ps.stdout, /Swarm Sessions/);
    assert.match(ps.stdout, new RegExp(SESSION_ID));
  } finally {
    await fixture.close();
  }
});

async function seedPersistedSession(fixture: Fixture): Promise<void> {
  const previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = fixture.swarmHome;
  const runtime = new SwarmRuntime({ workspace: fixture.workspace });

  try {
    const source: WorkItem = {
      source: "symphony",
      source_id: "workflow://CAND-PROD-041",
      human_id: "CLI-WS-41",
      title: "Sessions CLI WorkSnapshot projection",
      description: "Persisted local store facts for sessions CLI projection.",
      labels: ["test", "sessions-cli"],
      state: "Ready",
      metadata: {
        candidate: "CAND-PROD-041",
        work_source_kind: "fixture"
      }
    };

    const lease = runtime.workspaceLeaseStore.create({
      lease_id: LEASE_ID,
      session_id: SESSION_ID,
      workspace_root: fixture.workspace,
      workspace_path: fixture.workspace,
      scope: [
        "src/sessions/report.test.ts",
        ".workflow/specs/work-kernel-docs-coverage-matrix.md"
      ],
      write_boundary: "workspace",
      metadata: { kind: "sessions_cli_fixture", candidate: "CAND-PROD-041" },
      created_at: AT
    });

    runtime.sessionStore.create({
      swarm_id: SWARM_ID,
      session_id: SESSION_ID,
      user_request_id: "user-cand-prod-041",
      source,
      workspace_lease_id: lease.lease_id,
      objective: "Prove sessions CLI WorkSnapshot projection",
      status: "completed",
      coordinator: { agent_id: "main_swarm", role: "controller" },
      participants: [],
      created_at: AT,
      updated_at: AT,
      policy: policy()
    });

    runtime.sessionStore.setPlan(SESSION_ID, {
      objective: "Prove sessions CLI WorkSnapshot projection",
      summary: "Seed one persisted WorkSession and inspect it through sessions CLI list/show.",
      intent: "modify_workspace",
      tasks: [{
        task_id: TASK_ID,
        title: "Add sessions CLI WorkSnapshot projection evidence",
        description: "Assert sessions CLI list/show project persisted WorkSnapshot facts.",
        objective: "Assert sessions CLI list/show project persisted WorkSnapshot facts.",
        type: "coding",
        status: "completed",
        required_capabilities: ["code.test"],
        inputs: { candidate: "CAND-PROD-041" },
        expected_output: { format: "text" },
        dependencies: []
      }]
    });

    runtime.taskGraphStore.upsertSyntheticTool({
      session_id: SESSION_ID,
      swarm_id: SWARM_ID,
      task_id: TASK_ID,
      title: "Add sessions CLI WorkSnapshot projection evidence",
      action: "file.write",
      status: "completed",
      attempt: 1,
      write_policy: "scoped_write",
      file_scope: [
        "src/sessions/report.test.ts",
        ".workflow/specs/work-kernel-docs-coverage-matrix.md"
      ]
    });

    runtime.runAttemptStore.upsert({
      attempt_id: "attempt-cand-prod-041-write",
      session_id: SESSION_ID,
      task_id: TASK_ID,
      kind: "tool_call",
      status: "completed",
      attempt: 1,
      title: "Seed sessions CLI projection fixture",
      workspace_path: fixture.workspace,
      metadata: { summary: "file.write src/sessions/report.test.ts" }
    });
    runtime.runAttemptStore.upsert({
      attempt_id: "attempt-cand-prod-041-verify",
      session_id: SESSION_ID,
      task_id: TASK_ID,
      kind: "verification",
      status: "completed",
      attempt: 1,
      title: "Verify sessions CLI projection fixture",
      workspace_path: fixture.workspace,
      metadata: { summary: "node --import tsx --test src/sessions/report.test.ts" }
    });

    const workerPacket = taskPacket({
      objective: "Verify sessions CLI WorkSnapshot projection",
      writePolicy: "scoped_write",
      fileScope: ["src/sessions/report.test.ts"]
    });
    runtime.workerStateStore.create({
      worker_id: WORKER_ID,
      display_name: "CLI Projection Worker",
      role_title: "Verifier",
      parent_session_id: SESSION_ID,
      capability: "code.test",
      objective: "Verify sessions CLI WorkSnapshot projection",
      status: "running",
      agent_spec_id: "verifier",
      invocation_mode: "call_subagent",
      file_scope: ["src/sessions/report.test.ts"],
      tool_budget: { max_turns: 2, max_tool_calls: 4 },
      task_packet: workerPacket,
      requested_by: "main_swarm"
    });
    runtime.handoffStore.create({
      handoff_id: HANDOFF_ID,
      worker_id: WORKER_ID,
      parent_session_id: SESSION_ID,
      source_agent: "main_swarm",
      target_agent_spec_id: "reviewer",
      reason: "Review sessions CLI projection evidence",
      task_packet: taskPacket({
        objective: "Review sessions CLI projection evidence",
        writePolicy: "read_only",
        fileScope: ["docs/WORK_KERNEL.md"]
      })
    });

    runtime.blackboardStore.write({
      swarm_id: SWARM_ID,
      session_id: SESSION_ID,
      task_id: TASK_ID,
      key: "workspace/src/sessions/report.test.ts",
      type: "evidence",
      value: { path: "src/sessions/report.test.ts", operation: "write" },
      created_by: { agent_id: "main_swarm", role: "controller" },
      tags: ["workspace-change", "sessions-cli"]
    });
    runtime.blackboardStore.write({
      swarm_id: SWARM_ID,
      session_id: SESSION_ID,
      task_id: TASK_ID,
      key: "verification/sessions-cli",
      type: "evidence",
      value: {
        status: "success",
        summary: "node --import tsx --test src/sessions/report.test.ts"
      },
      created_by: { agent_id: "verifier", role: "verifier" },
      tags: ["verify", "code.test", "sessions-cli"]
    });
    runtime.blackboardStore.write({
      swarm_id: SWARM_ID,
      session_id: SESSION_ID,
      task_id: TASK_ID,
      key: "review/sessions-cli",
      type: "critique",
      value: {
        target_task_id: TASK_ID,
        reviewer: { agent_id: "reviewer", role: "reviewer" },
        verdict: "approve",
        score: 96,
        summary: "sessions CLI projection evidence is covered"
      } satisfies ReviewResult,
      created_by: { agent_id: "reviewer", role: "reviewer" },
      tags: ["review", "sessions-cli"]
    });

    runtime.approvalStore.upsert(approvalRequest(), "approved");
    runtime.usageStore.append({
      session_id: SESSION_ID,
      task_id: TASK_ID,
      kind: "tool_call",
      amount: 2,
      unit: "count",
      metadata: { source: "CAND-PROD-041" },
      created_at: AT
    });
    runtime.sessionContextStore.append({
      session_id: SESSION_ID,
      kind: "objective",
      role: "user",
      content: "Prove sessions CLI WorkSnapshot projection",
      created_at: AT
    });
    runtime.sessionContextStore.append({
      session_id: SESSION_ID,
      kind: "final",
      role: "assistant",
      content: FINAL_SUMMARY,
      created_at: AT
    });

    runtime.sessionStore.setFinalOutput(SESSION_ID, FINAL_SUMMARY, "completed");
    runtime.sessionStore.setFinalOutcome(SESSION_ID, {
      changed_files: [
        "src/sessions/report.test.ts",
        ".workflow/specs/work-kernel-docs-coverage-matrix.md"
      ],
      intermediate_artifacts: [
        ".workflow/.csv-wave/20260513-execute-cand-prod-041-sessions-cli-work-snapshot/context.md"
      ],
      tests_run: [
        "node --import tsx --test src/sessions/report.test.ts",
        "npm run check"
      ],
      final_summary: FINAL_SUMMARY
    });
  } finally {
    runtime.dispose();
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
  }
}

function approvalRequest(): ToolApprovalRequest {
  return {
    id: APPROVAL_ID,
    session_id: SESSION_ID,
    task_id: TASK_ID,
    action: "file.write",
    summary: "Approve sessions CLI fixture write",
    detail: "Write focused real child-process sessions CLI WorkSnapshot projection evidence.",
    risk: "write",
    risk_class: "r1",
    target: "src/sessions/report.test.ts",
    why_now: "CAND-PROD-041 deterministic sessions CLI projection evidence.",
    predicted_impact: "Adds focused product-surface test evidence.",
    rollback_plan: "Remove the fixture test and traceability notes.",
    permission_decision: "ask",
    permission_reason: "Approval required by deterministic test fixture.",
    permission_mode: "ask",
    permission_name: "Write",
    permission_rule: "Write(**)"
  };
}

function taskPacket(input: {
  objective: string;
  writePolicy: AgentTaskPacket["write_policy"];
  fileScope: string[];
}): AgentTaskPacket {
  return {
    objective: input.objective,
    agent_spec_id: "verifier",
    invocation_mode: "call_subagent",
    persona_snapshot: "Verifier",
    file_scope: input.fileScope,
    allowed_tools: ["file.read", "file.write"],
    write_policy: input.writePolicy,
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: { max_turns: 2, max_tool_calls: 4 },
    expected_output: "Summary",
    return_conditions: ["done"]
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: "on-request",
    network_access: "deny",
    allow_domains: [],
    human_approval_for: [],
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
  swarmHome: string;
  workspace: string;
  close(): Promise<void>;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "swarm-sessions-report-cli-"));
  const swarmHome = join(root, "swarm-home");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    swarmHome,
    workspace,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

function runCli(
  args: string[],
  fixture: Fixture
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve(process.cwd()),
      env: { ...process.env, SWARM_HOME: fixture.swarmHome },
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

function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  return recordValue(parsed, "JSON output");
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} should be an array`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
