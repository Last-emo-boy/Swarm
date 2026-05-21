import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentInvocationRequest, AgentTaskPacket } from "./agent-specs.js";
import type { RuntimeEvent } from "./events.js";
import { buildResultCardFromSnapshot } from "./result-card.js";
import { SwarmRuntime } from "./runtime.js";
import { createEnvelope } from "../protocol/envelope.js";
import { buildSessionSnapshot, buildWorkspaceSnapshot } from "../server/session-view.js";
import type { ReviewResult, SwarmPolicy, WorkItem } from "../protocol/types.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";

test("WorkSession facts project into WorkSnapshot and session view contracts", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const seeded = seedWorkSession(runtime, fixture);

    const snapshot = runtime.getWorkSnapshot(seeded.sessionId);
    assert.equal(snapshot.session.session_id, seeded.sessionId);
    assert.equal(snapshot.session.source?.source, "gateway");
    assert.equal(snapshot.session.source?.source_id, "run-42");
    assert.equal(snapshot.session.workspace_lease_id, seeded.leaseId);
    assert.equal(snapshot.workspace?.workspace_path, fixture.workspace);

    assert.deepEqual(snapshot.changed_files, ["src/runtime/work-session-lifecycle.test.ts"]);
    assert.deepEqual(snapshot.checks, ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"]);
    assert.equal(snapshot.final_outcome?.final_summary, "seeded lifecycle complete");

    assert.equal(snapshot.attempts.length, 2);
    assert.deepEqual(snapshot.attempts.map((attempt) => attempt.kind), ["tool_call", "verification"]);
    assert.equal(snapshot.graph.tasks.length, 1);
    assert.equal(snapshot.task_contracts.summary.total, 1);
    assert.equal(snapshot.task_contracts.summary.completed, 1);
    assert.equal(snapshot.task_contracts.summary.scoped_write, 1);
    assert.deepEqual(snapshot.task_contracts.summary.scoped_targets, ["src/runtime/work-session-lifecycle.test.ts"]);

    assert.equal(snapshot.workers.length, 1);
    assert.equal(snapshot.work_contracts.summary.active_workers, 1);
    assert.equal(snapshot.work_contracts.summary.active_handoffs, 1);
    assert.equal(snapshot.work_contracts.summary.scoped_write, 1);
    assert.deepEqual(snapshot.work_contracts.summary.scoped_targets, [
      "src/runtime/work-session-lifecycle.test.ts",
      "docs/WORK_KERNEL.md"
    ]);

    assert.equal(snapshot.blackboard_counts.evidence, 2);
    assert.equal(snapshot.blackboard_counts.critique, 1);
    assert.equal(snapshot.review?.verdict, "approve");
    assert.equal(snapshot.verification && typeof snapshot.verification === "object" && "status" in snapshot.verification
      ? snapshot.verification.status
      : undefined, "success");
    assert.equal(snapshot.usage_summary["tool_call.count"], 2);
    assert.equal(snapshot.context_summary?.entries, 2);
    assert.equal(snapshot.context_summary?.compactions, 1);

    const sessionView = buildSessionSnapshot(runtime, seeded.sessionId);
    assert.deepEqual(sessionView.work_snapshot, snapshot);
    assert.deepEqual(sessionView.task_contracts, snapshot.task_contracts);
    assert.deepEqual(sessionView.work_contracts, snapshot.work_contracts);

    const workspaceView = buildWorkspaceSnapshot(runtime, { limit: 10 });
    assert.equal((workspaceView.summary as Record<string, unknown>).sessions, 1);
    assert.equal((workspaceView.summary as Record<string, unknown>).active_sessions, 1);
    assert.equal((workspaceView.summary as Record<string, unknown>).total_workers, 1);
    assert.equal((workspaceView.summary as Record<string, unknown>).active_handoffs, 1);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("persisted approvals and trace envelopes project through WorkSession replay and task detail", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const seeded = seedWorkSession(runtime, fixture);
    runtime.approvalStore.upsert(approvalRequest({
      id: "approval_lifecycle_approved",
      sessionId: seeded.sessionId,
      taskId: "task-write-test",
      summary: "Approve lifecycle fixture write",
      detail: "Write deterministic approval projection evidence.",
      riskClass: "r1",
      target: "src/runtime/work-session-lifecycle.test.ts"
    }), "approved");
    runtime.approvalStore.upsert(approvalRequest({
      id: "approval_lifecycle_denied",
      sessionId: seeded.sessionId,
      taskId: "task-write-test",
      summary: "Deny lifecycle shell escalation",
      detail: "Reject an out-of-scope shell escalation fixture.",
      risk: "shell",
      riskClass: "r4",
      target: "shell: rm -rf fixture"
    }), "denied");

    const taskTrace = {
      ...createEnvelope({
        swarm_id: "swarm-session-lifecycle-1",
        session_id: seeded.sessionId,
        task_id: "task-write-test",
        attempt: 1,
        from: { agent_id: "main_swarm" },
        to: { role: "coder" },
        type: "task.assign",
        intent: "lifecycle.trace.task_assign",
        payload: { objective: "Persist trace projection evidence" },
        correlation_id: "corr-lifecycle-trace",
        trace: {
          trace_id: "trace-lifecycle",
          span_id: "span-task-assign"
        }
      }),
      id: "env_lifecycle_task_assign",
      created_at: "2026-05-12T00:00:10.000Z"
    };
    const ackTrace = {
      ...createEnvelope({
        swarm_id: "swarm-session-lifecycle-1",
        session_id: seeded.sessionId,
        from: { agent_id: "coder" },
        to: { agent_id: "main_swarm" },
        type: "ack",
        intent: "lifecycle.trace.ack",
        payload: { delivered: ["coder"] },
        correlation_id: "corr-lifecycle-trace",
        reply_to: taskTrace.id,
        trace: {
          trace_id: "trace-lifecycle",
          span_id: "span-ack",
          parent_span_id: "span-task-assign"
        }
      }),
      id: "env_lifecycle_ack",
      created_at: "2026-05-12T00:00:11.000Z"
    };
    runtime.traceStore.append(taskTrace);
    runtime.traceStore.append(ackTrace);

    const replay = runtime.replaySession(seeded.sessionId);
    assert.match(replay, /Approvals: 2/);
    assert.match(replay, /approval_lifecycle_approved \[approved\/r1\] Approve lifecycle fixture write/);
    assert.match(replay, /approval_lifecycle_denied \[denied\/r4\] Deny lifecycle shell escalation/);
    assert.match(replay, /Trace envelopes: 2/);
    assert.match(replay, /task\.assign task-write-test lifecycle\.trace\.task_assign/);
    assert.match(replay, /ack\s+lifecycle\.trace\.ack/);

    const detail = runtime.getTaskDetail(seeded.sessionId, "task-write-test");
    assert.deepEqual(detail.trace.map((envelope) => envelope.id), ["env_lifecycle_task_assign"]);
    assert.equal(detail.trace[0]?.intent, "lifecycle.trace.task_assign");
    assert.equal(detail.trace[0]?.trace?.trace_id, "trace-lifecycle");

    const snapshot = runtime.getWorkSnapshot(seeded.sessionId);
    const sessionView = buildSessionSnapshot(runtime, seeded.sessionId);
    assert.deepEqual(sessionView.work_snapshot, snapshot);
    assert.deepEqual(sessionView.task_contracts, snapshot.task_contracts);
    assert.deepEqual(sessionView.work_contracts, snapshot.work_contracts);
    assert.equal("approvals" in (snapshot as Record<string, unknown>), false);
    assert.equal("trace" in (snapshot as Record<string, unknown>), false);

    const workspaceView = buildWorkspaceSnapshot(runtime, { limit: 10 });
    const approvals = workspaceView.approvals as {
      approvals: Array<{ approval_id: string; status: string; risk_class: string }>;
      summary: { approved: number; denied: number; persisted_pending: number };
    };
    assert.equal(approvals.summary.approved, 1);
    assert.equal(approvals.summary.denied, 1);
    assert(approvals.approvals.some((approval) =>
      approval.approval_id === "approval_lifecycle_approved" &&
      approval.status === "approved" &&
      approval.risk_class === "r1"
    ));
    assert(approvals.approvals.some((approval) =>
      approval.approval_id === "approval_lifecycle_denied" &&
      approval.status === "denied" &&
      approval.risk_class === "r4"
    ));
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("runtime coding loop creates WorkSession attempts and WorkSnapshot through the entrypoint", async () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.workspace, "README.md"), "runtime-created session fixture\n");
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const calls: Array<{ purpose?: string }> = [];
  const events: RuntimeEvent[] = [];
  const unsubscribe = runtime.events.onEvent((event) => {
    if (event.type === "final") {
      events.push(event);
    }
  });
  const provider = runtimeProvider(runtime);
  provider.generateText = async (request) => {
    calls.push({ purpose: request.usage?.purpose });
    return JSON.stringify({
      status: "completed",
      summary: "runtime-created session complete",
      message: "runtime-created session complete",
      tool_calls: [],
      files_touched: [],
      next_actions: []
    });
  };

  try {
    const result = await runtime.run("Prove runtime-created WorkSession evidence", {
      mode: "coding_loop",
      maxTurns: 1,
      maxToolCalls: 0
    });

    assert.equal(result.status, "completed");
    assert.match(result.session_id, /^loop_/);
    assert.equal(result.content, "runtime-created session complete");
    assert.deepEqual(calls.map((call) => call.purpose), ["main_coding_loop"]);
    const finalEvent = events[events.length - 1];
    assert.equal(finalEvent?.type, "final");
    assert.equal(finalEvent?.checkpoint?.name, "Prove runtime-created WorkSession evidence");
    assert.equal(finalEvent?.checkpoint?.revertAvailable, true);

    const row = runtime.sessionStore.get(result.session_id);
    assert(row, "runtime entrypoint should persist a WorkSession row");
    assert.equal(row.status, "completed");
    assert.equal(row.objective, "Prove runtime-created WorkSession evidence");
    assert.equal(row.final_output, "runtime-created session complete");
    assert(row.workspace_lease_id, "runtime-created WorkSession should own a workspace lease");

    const source = parseJson(row.source_json) as WorkItem;
    assert.equal(source.source, "user");
    assert.equal(source.human_id, result.session_id);
    assert.equal(source.title, "Prove runtime-created WorkSession evidence");
    assert.equal(source.description, "Prove runtime-created WorkSession evidence");
    assert.equal(source.metadata?.mode, "coding_loop");

    const lease = runtime.workspaceLeaseStore.get(row.workspace_lease_id);
    assert(lease, "workspace lease should be persisted for runtime-created session");
    assert.equal(lease.session_id, result.session_id);
    assert.equal(lease.workspace_path, fixture.workspace);
    assert.equal(runtime.workspaceLeaseStore.getBySession(result.session_id)?.lease_id, lease.lease_id);

    const attempts = runtime.runAttemptStore.list(result.session_id);
    const codingTurn = attempts.find((attempt) => attempt.task_id === "coding_turn_1");
    assert(codingTurn, "coding loop should persist a coding_turn_1 RunAttempt");
    assert.equal(codingTurn.kind, "coding_turn");
    assert.equal(codingTurn.status, "completed");
    assert.equal(codingTurn.attempt, 1);
    assert.equal(codingTurn.title, "Coding loop turn");
    assert.equal(codingTurn.workspace_path, fixture.workspace);

    const snapshot = runtime.getWorkSnapshot(result.session_id);
    assert.equal(snapshot.session.session_id, result.session_id);
    assert.equal(snapshot.session.status, "completed");
    assert.equal(snapshot.session.workspace_lease_id, lease.lease_id);
    assert.equal(snapshot.session.source?.source, "user");
    assert.equal(snapshot.session.source?.metadata?.mode, "coding_loop");
    assert.equal(snapshot.workspace?.workspace_path, fixture.workspace);
    assert.deepEqual(snapshot.changed_files, []);
    assert.deepEqual(snapshot.checks, []);
    assert.equal(snapshot.final_outcome?.final_summary, "runtime-created session complete");
    assert.deepEqual(snapshot.final_outcome?.changed_files, []);
    assert(snapshot.attempts.some((attempt) => attempt.task_id === "coding_turn_1" && attempt.status === "completed"));
    assert(snapshot.attempts.some((attempt) => attempt.task_id === "final" && attempt.status === "completed"));
    assert((snapshot.context_summary?.entries ?? 0) > 0);

    const sessionView = buildSessionSnapshot(runtime, result.session_id);
    assert.deepEqual(sessionView.work_snapshot, snapshot);
    assert.deepEqual(sessionView.task_contracts, snapshot.task_contracts);
    assert.deepEqual(sessionView.work_contracts, snapshot.work_contracts);
  } finally {
    unsubscribe();
    runtime.dispose();
    fixture.close();
  }
});

test("runtime post-change review and verification records deterministic execution evidence", async () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.workspace, "src", "runtime", "work-session-lifecycle.test.ts"), "runtime-created change\n");
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const sessionId = "session-post-change-review-verify";
  const objective = "Prove post-change Review / Verification execution evidence";
  seedPostChangeSession(runtime, fixture, sessionId, objective);
  runtime.blackboardStore.write({
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    key: "workspace/src/runtime/work-session-lifecycle.test.ts",
    type: "evidence",
    value: {
      path: "src/runtime/work-session-lifecycle.test.ts",
      operation: "write",
      taskId: "coding_loop"
    },
    created_by: { agent_id: "tool.file", role: "tool" },
    tags: ["workspace-change", "write", "src/runtime/work-session-lifecycle.test.ts"]
  });

  const providerCalls: Array<{ purpose?: string; user?: string }> = [];
  const provider = runtimeProvider(runtime);
  provider.generateText = async (request) => {
    providerCalls.push({ purpose: request.usage?.purpose, user: request.user });
    assert.equal(request.usage?.purpose, "review_normalization");
    assert.equal(request.responseFormat, "json_object");
    return JSON.stringify({
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "needs_revision",
      score: 82,
      issues: [{
        severity: "medium",
        message: "Verifier needs to prove the runtime-created review context is persisted.",
        evidence: "src/runtime/work-session-lifecycle.test.ts",
        suggested_fix: "Assert the verifier context and WorkSnapshot projection."
      }],
      summary: "Post-change review found a deterministic verification gap."
    });
  };

  const invocations: AgentInvocationRequest[] = [];
  let verifierContext = "";
  runtimeAccess(runtime).invokeAgent = async (request) => {
    invocations.push(request);
    if (request.capability === "code.review") {
      assert.equal(request.preferred_agent_spec_id, "reviewer");
      assert.equal(request.preferred_mode, "call_subagent");
      assert(request.context?.includes(objective));
      assert(request.context?.includes("src/runtime/work-session-lifecycle.test.ts"));
      assert(request.context?.includes("node --import tsx --test src/runtime/work-session-lifecycle.test.ts"));
      assert(request.context?.includes("review-notes.md"));
      assert(request.context?.includes("recent_changes"));
      return {
        action: "agent.delegate",
        status: "success",
        summary: "Review Agent completed: deterministic issue found",
        content: "Medium: verifier must receive normalized review JSON.",
        data: { worker_id: "worker_review_runtime" }
      };
    }
    assert.equal(request.capability, "verify");
    assert.equal(invocations[0]?.capability, "code.review");
    assert.equal(request.preferred_agent_spec_id, "verifier");
    assert.equal(request.preferred_mode, "call_subagent");
    verifierContext = request.context ?? "";
    return {
      action: "agent.delegate",
      status: "success",
      summary: "Verification Agent completed: manual verification required",
      content: "Verification gap: reviewer context was inspected; manual verification required for model-backed quality.",
      data: { worker_id: "worker_verify_runtime" }
    };
  };

  try {
    const postCheck = await runtimeAccess(runtime).runPostChangeChecks(sessionId, objective, {
      changed_files: ["src/runtime/work-session-lifecycle.test.ts"],
      tests_run: ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"],
      intermediate_artifacts: ["review-notes.md"],
      final_summary: "post-change done"
    });

    assert(postCheck);
    assert.equal(postCheck.review.verdict, "needs_revision");
    assert.equal(postCheck.review.score, 82);
    assert.equal(postCheck.review.summary, "Review Agent completed: deterministic issue found");
    assert.equal(postCheck.review.issues?.[0]?.message, "Verifier needs to prove the runtime-created review context is persisted.");
    assert.equal(postCheck.verification.status, "partial");
    assert.equal(postCheck.verification.worker_id, "worker_verify_runtime");
    assert.equal(postCheck.verification.summary, "Verification Agent completed: manual verification required");

    assert.deepEqual(invocations.map((request) => request.capability), ["code.review", "verify"]);
    assert.deepEqual(invocations.map((request) => request.preferred_mode), ["call_subagent", "call_subagent"]);
    assert.deepEqual(invocations.map((request) => request.preferred_agent_spec_id), ["reviewer", "verifier"]);
    assert.deepEqual(providerCalls.map((call) => call.purpose), ["review_normalization"]);
    assert(verifierContext.includes("Review result:"));
    assert(verifierContext.includes('"verdict": "needs_revision"'));
    assert(verifierContext.includes('"score": 82'));
    assert(verifierContext.includes('"Verifier needs to prove the runtime-created review context is persisted."'));
    assert(verifierContext.includes('"changed_files"'));
    assert(verifierContext.includes('"tests_run"'));
    assert(verifierContext.includes('"intermediate_artifacts"'));
    assert(verifierContext.includes('"recent_changes"'));

    const attempts = runtime.runAttemptStore.list(sessionId);
    const reviewAttempt = attempts.find((attempt) => attempt.task_id === "review.coding_loop");
    const verificationAttempt = attempts.find((attempt) => attempt.task_id === "verification.coding_loop");
    assert(reviewAttempt);
    assert.equal(reviewAttempt.kind, "review");
    assert.equal(reviewAttempt.runner_id, "reviewer");
    assert.equal(reviewAttempt.status, "completed");
    assert.equal(reviewAttempt.title, "Post-change review");
    assert.equal(reviewAttempt.workspace_path, fixture.workspace);
    assert.equal(reviewAttempt.terminal_reason, "Review Agent completed: deterministic issue found");
    assert.deepEqual((reviewAttempt.metadata.result as ReviewResult).verdict, "needs_revision");
    assert(verificationAttempt);
    assert.equal(verificationAttempt.kind, "verification");
    assert.equal(verificationAttempt.runner_id, "verifier");
    assert.equal(verificationAttempt.status, "completed");
    assert.equal(verificationAttempt.title, "Post-change verification");
    assert.equal(verificationAttempt.workspace_path, fixture.workspace);
    assert.equal(verificationAttempt.terminal_reason, "Verification Agent completed: manual verification required");

    const reviewEntries = runtime.blackboardStore.query(sessionId, { tag: "review" });
    const verificationEntries = runtime.blackboardStore.query(sessionId, { tag: "verify" });
    assert.equal(reviewEntries.length, 1);
    assert.equal(reviewEntries[0]?.type, "critique");
    assert.equal((reviewEntries[0]?.value as ReviewResult).verdict, "needs_revision");
    assert(reviewEntries[0]?.tags?.includes("needs_revision"));
    assert.equal(verificationEntries.length, 1);
    assert.equal(verificationEntries[0]?.type, "evidence");
    assert.equal((verificationEntries[0]?.value as { status?: string }).status, "partial");
    assert(verificationEntries[0]?.tags?.includes("partial"));

    runtime.sessionStore.setFinalOutcome(sessionId, {
      changed_files: ["src/runtime/work-session-lifecycle.test.ts"],
      tests_run: ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"],
      intermediate_artifacts: ["review-notes.md"],
      final_summary: "post-change done"
    });
    const snapshot = runtime.getWorkSnapshot(sessionId);
    assert.equal(snapshot.review?.verdict, "needs_revision");
    assert.equal(snapshot.verification && typeof snapshot.verification === "object" && "worker_id" in snapshot.verification
      ? snapshot.verification.worker_id
      : undefined, "worker_verify_runtime");
    assert.deepEqual(snapshot.changed_files, ["src/runtime/work-session-lifecycle.test.ts"]);
    assert.deepEqual(snapshot.checks, ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"]);

    const card = buildResultCardFromSnapshot(snapshot, "work");
    assert.equal(card.review.status, "warning");
    assert(card.risks.some((risk) => risk.level === "medium" && risk.message.includes("Reviewer reported findings")));
    assert.deepEqual(card.artifacts, ["worker_verify_runtime", "review-notes.md"]);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

function seedWorkSession(runtime: SwarmRuntime, fixture: Fixture): {
  sessionId: string;
  leaseId: string;
} {
  const sessionId = "session-lifecycle-1";
  const swarmId = "swarm-session-lifecycle-1";
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: "lease-session-lifecycle-1",
    session_id: sessionId,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/work-session-lifecycle.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
  });
  const source: WorkItem = {
    source: "gateway",
    source_id: "run-42",
    human_id: "GW-42",
    title: "Gateway lifecycle evidence",
    description: "Seeded WorkSession lifecycle projection",
    labels: ["test", "lifecycle"],
    state: "active",
    metadata: { route: "work" }
  };
  runtime.sessionStore.create({
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: "user-42",
    source,
    workspace_lease_id: lease.lease_id,
    objective: "Prove WorkSession projection",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  });

  runtime.taskGraphStore.upsertSyntheticTool({
    session_id: sessionId,
    swarm_id: swarmId,
    task_id: "task-write-test",
    title: "Write focused lifecycle test",
    action: "file.write",
    status: "completed",
    attempt: 1,
    write_policy: "scoped_write",
    file_scope: ["src/runtime/work-session-lifecycle.test.ts"]
  });
  runtime.runAttemptStore.upsert({
    attempt_id: "attempt-task-write-test",
    session_id: sessionId,
    task_id: "task-write-test",
    kind: "tool_call",
    status: "completed",
    attempt: 1,
    title: "Write focused lifecycle test",
    workspace_path: fixture.workspace,
    metadata: { summary: "file.write src/runtime/work-session-lifecycle.test.ts" }
  });
  runtime.runAttemptStore.upsert({
    attempt_id: "attempt-verify-test",
    session_id: sessionId,
    task_id: "task-write-test",
    kind: "verification",
    status: "completed",
    attempt: 1,
    title: "Verify focused lifecycle test",
    workspace_path: fixture.workspace,
    metadata: { summary: "node --import tsx --test src/runtime/work-session-lifecycle.test.ts" }
  });

  runtime.workerStateStore.create({
    worker_id: "worker-lifecycle",
    display_name: "Lifecycle Worker",
    parent_session_id: sessionId,
    capability: "code.test",
    objective: "Write lifecycle projection test",
    status: "running",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    file_scope: ["src/runtime/work-session-lifecycle.test.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket({
      objective: "Write lifecycle projection test",
      fileScope: ["src/runtime/work-session-lifecycle.test.ts"]
    }),
    requested_by: "main_swarm"
  });
  runtime.handoffStore.create({
    handoff_id: "handoff-lifecycle",
    worker_id: "worker-lifecycle",
    parent_session_id: sessionId,
    source_agent: "main_swarm",
    target_agent_spec_id: "reviewer",
    reason: "Review lifecycle evidence",
    task_packet: taskPacket({
      objective: "Review lifecycle docs boundary",
      writePolicy: "read_only",
      fileScope: ["docs/WORK_KERNEL.md"]
    })
  });

  runtime.blackboardStore.write({
    swarm_id: swarmId,
    session_id: sessionId,
    task_id: "task-write-test",
    key: "workspace/src/runtime/work-session-lifecycle.test.ts",
    type: "evidence",
    value: { path: "src/runtime/work-session-lifecycle.test.ts" },
    created_by: { agent_id: "main_swarm" },
    tags: ["workspace-change"]
  });
  runtime.blackboardStore.write({
    swarm_id: swarmId,
    session_id: sessionId,
    task_id: "task-write-test",
    key: "verification/lifecycle",
    type: "evidence",
    value: {
      status: "success",
      summary: "node --import tsx --test src/runtime/work-session-lifecycle.test.ts"
    },
    created_by: { agent_id: "verifier" },
    tags: ["verify", "code.test"]
  });
  runtime.blackboardStore.write({
    swarm_id: swarmId,
    session_id: sessionId,
    task_id: "task-write-test",
    key: "review/lifecycle",
    type: "critique",
    value: {
      target_task_id: "task-write-test",
      reviewer: { agent_id: "reviewer" },
      verdict: "approve",
      score: 0.94,
      summary: "focused lifecycle projection is covered"
    } satisfies ReviewResult,
    created_by: { agent_id: "reviewer" },
    tags: ["review"]
  });
  runtime.usageStore.append({
    session_id: sessionId,
    task_id: "task-write-test",
    kind: "tool_call",
    amount: 2,
    unit: "count",
    metadata: { source: "test" },
    created_at: AT
  });
  runtime.sessionContextStore.append({
    session_id: sessionId,
    kind: "objective",
    role: "user",
    content: "Prove WorkSession projection",
    created_at: AT
  });
  runtime.sessionContextStore.append({
    session_id: sessionId,
    kind: "final",
    role: "assistant",
    content: "seeded lifecycle complete",
    created_at: AT
  });
  runtime.sessionContextStore.compact(sessionId, { maxTokens: 1, keepRecentEntries: 1, summaryMaxTokens: 64 });
  runtime.sessionStore.setFinalOutcome(sessionId, {
    changed_files: ["src/runtime/work-session-lifecycle.test.ts"],
    intermediate_artifacts: ["artifacts/lifecycle.md"],
    tests_run: ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"],
    final_summary: "seeded lifecycle complete"
  });

  return { sessionId, leaseId: lease.lease_id };
}

function seedPostChangeSession(runtime: SwarmRuntime, fixture: Fixture, sessionId: string, objective: string): void {
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: "lease-post-change-review-verify",
    session_id: sessionId,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/work-session-lifecycle.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
  });
  runtime.sessionStore.create({
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    user_request_id: "user-post-change-review-verify",
    source: {
      source: "user",
      human_id: sessionId,
      title: objective,
      description: objective,
      labels: ["test", "review-verification"],
      state: "active",
      metadata: { mode: "coding_loop" }
    },
    workspace_lease_id: lease.lease_id,
    objective,
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  });
}

function approvalRequest(input: {
  id: string;
  sessionId: string;
  taskId: string;
  summary: string;
  detail: string;
  risk?: ToolApprovalRequest["risk"];
  riskClass: ToolApprovalRequest["risk_class"];
  target: string;
}): ToolApprovalRequest {
  return {
    id: input.id,
    session_id: input.sessionId,
    task_id: input.taskId,
    action: input.risk === "shell" ? "shell.exec" : "file.write",
    summary: input.summary,
    detail: input.detail,
    risk: input.risk ?? "write",
    risk_class: input.riskClass,
    target: input.target,
    why_now: "CAND-PROD-025 deterministic approval projection evidence.",
    predicted_impact: input.detail,
    rollback_plan: "Fixture only; remove the seeded approval record.",
    permission_decision: "ask",
    permission_reason: "Approval required by deterministic test fixture.",
    permission_mode: "ask",
    permission_name: input.risk === "shell" ? "Bash" : "Write",
    permission_rule: input.risk === "shell" ? "Bash(*)" : "Write(**)"
  };
}

function taskPacket(input: {
  objective: string;
  writePolicy?: AgentTaskPacket["write_policy"];
  fileScope: string[];
}): AgentTaskPacket {
  return {
    objective: input.objective,
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    persona_snapshot: "Coder",
    file_scope: input.fileScope,
    allowed_tools: ["file.read", "file.write"],
    write_policy: input.writePolicy ?? "scoped_write",
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: { max_turns: 4, max_tool_calls: 12 },
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
  workspace: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-work-session-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src", "runtime"), { recursive: true });
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function runtimeProvider(runtime: SwarmRuntime): {
  generateText: (request: {
    usage?: { purpose?: string };
    user?: string;
    responseFormat?: string;
  }) => Promise<string>;
} {
  return (runtime as unknown as {
    provider: {
      generateText: (request: {
        usage?: { purpose?: string };
        user?: string;
        responseFormat?: string;
      }) => Promise<string>;
    };
  }).provider;
}

function runtimeAccess(runtime: SwarmRuntime): {
  invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult>;
  runPostChangeChecks: (
    sessionId: string,
    objective: string,
    outcome?: {
      changed_files: string[];
      tests_run: string[];
      intermediate_artifacts: string[];
      final_summary?: string;
    }
  ) => Promise<{
    review: ReviewResult;
    verification: {
      status: "success" | "partial" | "failed";
      summary: string;
      content?: string;
      worker_id?: string;
    };
  } | undefined>;
} {
  return runtime as unknown as {
    invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult>;
    runPostChangeChecks: (
      sessionId: string,
      objective: string,
      outcome?: {
        changed_files: string[];
        tests_run: string[];
        intermediate_artifacts: string[];
        final_summary?: string;
      }
    ) => Promise<{
      review: ReviewResult;
      verification: {
        status: "success" | "partial" | "failed";
        summary: string;
        content?: string;
        worker_id?: string;
      };
    } | undefined>;
  };
}

function parseJson(value: string | null | undefined): unknown {
  assert(value, "Expected JSON text");
  return JSON.parse(value);
}

const AT = "2026-05-12T00:00:00.000Z";
