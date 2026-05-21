import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BlackboardEntry, ReviewResult, SwarmPolicy, WorkItem } from "../protocol/types.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import type { AgentTaskPacket } from "./agent-specs.js";
import { SwarmRuntime } from "./runtime.js";

test("Blackboard live-message/review-fact semantics project through replaySession and WorkSnapshot.review", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const { sessionId, swarmId, taskId } = seedWorkSession(runtime, fixture);
    const liveEntries = Array.from({ length: 10 }, (_, index) => {
      const n = index + 1;
      return writeBlackboardEntry(runtime, `2026-05-12T00:00:${String(n).padStart(2, "0")}.000Z`, {
        swarm_id: swarmId,
        session_id: sessionId,
        task_id: taskId,
        key: `user.live_message.live-${String(n).padStart(2, "0")}`,
        type: "decision",
        value: {
          content: `content ${n}`,
          decision: {
            action: n === 10 ? "reroute" : "live_message",
            reason: `reason ${n}`,
            instruction: `instruction ${n}`
          },
          created_at: `2026-05-12T00:00:${String(n).padStart(2, "0")}.000Z`
        },
        created_by: { agent_id: "user", role: "user" },
        tags: ["user", "live-message"]
      });
    });
    const tagOnlyLiveMessage = writeBlackboardEntry(runtime, "2026-05-12T00:00:11.000Z", {
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key: "operator/live-message/tag-only",
      type: "decision",
      value: {
        content: "tag-only content",
        decision: {
          action: "pause",
          reason: "tag-only reason",
          instruction: "tag-only instruction"
        },
        created_at: "2026-05-12T00:00:11.000Z"
      },
      created_by: { agent_id: "user", role: "user" },
      tags: ["live-message"]
    });

    writeBlackboardEntry(runtime, "2026-05-12T00:00:20.000Z", {
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key: "critique/generic-noise",
      type: "critique",
      value: reviewResult("generic critique must not become a review fact", "reject", 0.1),
      created_by: { agent_id: "critic", role: "critic" },
      tags: ["critique"]
    });
    writeBlackboardEntry(runtime, "2026-05-12T00:00:21.000Z", {
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key: "review/older",
      type: "critique",
      value: reviewResult("older tagged review fact loses", "approve", 0.91),
      created_by: { agent_id: "reviewer", role: "reviewer" },
      tags: ["review"]
    });
    const latestReview = reviewResult("latest tagged review fact wins", "needs_revision", 0.72);
    writeBlackboardEntry(runtime, "2026-05-12T00:00:22.000Z", {
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key: "review/latest",
      type: "critique",
      value: latestReview,
      created_by: { agent_id: "reviewer", role: "reviewer" },
      tags: ["review"]
    });

    const replay = runtime.replaySession(sessionId);
    assert.match(replay, /Live Control Directives/);
    assert.match(replay, /message_id=live-10/);
    assert.match(replay, /action=reroute/);
    assert.match(replay, /reason=reason 10/);
    assert.match(replay, /instruction=instruction 10/);
    assert.match(replay, /content=content 10/);
    assert.match(replay, new RegExp(`message_id=${escapeRegExp(tagOnlyLiveMessage.entry_id)}`));
    assert.match(replay, /action=pause/);
    assert.match(replay, /instruction=tag-only instruction/);
    assert.doesNotMatch(replay, /message_id=live-01/);
    assert.doesNotMatch(replay, /message_id=live-02/);
    assert.doesNotMatch(replay, /message_id=live-03/);
    assert.equal(liveEntries.length, 10);

    const snapshot = runtime.getWorkSnapshot(sessionId);
    assert.deepEqual(snapshot.review, latestReview);
    assert.equal(snapshot.blackboard_counts.decision, 11);
    assert.equal(snapshot.blackboard_counts.critique, 3);
    assert.match(replay, /Review: needs_revision 0\.72 - latest tagged review fact wins/);
    assert.doesNotMatch(replay, /generic critique must not become a review fact/);
    assert.doesNotMatch(replay, /older tagged review fact loses/);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("Blackboard worker-state facts project through WorkSnapshot, task detail, and replaySession", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const { sessionId, swarmId, taskId } = seedWorkSession(runtime, fixture, {
      candidate: "CAND-PROD-021",
      sourceTitle: "Blackboard worker-state evidence",
      objective: "Prove Blackboard worker-state projection",
      taskTitle: "Seed Blackboard worker-state projection"
    });
    const workerId = "worker-blackboard-state";
    const scopedFile = "src/runtime/blackboard-semantics.test.ts";
    const outcome = {
      changed_files: [scopedFile],
      intermediate_artifacts: ["blackboard-worker-state-projection"],
      tests_run: ["node --import tsx --test src/runtime/blackboard-semantics.test.ts"],
      final_summary: "worker-state Blackboard projection evidence complete"
    };
    runtime.workerStateStore.create({
      worker_id: workerId,
      display_name: "Blackboard Worker State",
      role_title: "Coder",
      parent_session_id: sessionId,
      capability: "code.implement",
      objective: "Implement deterministic worker-state Blackboard projection evidence",
      status: "running",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      file_scope: [scopedFile],
      tool_budget: { max_turns: 4, max_tool_calls: 12 },
      task_packet: workerTaskPacket({
        objective: "Implement deterministic worker-state Blackboard projection evidence",
        fileScope: [scopedFile]
      }),
      requested_by: "main_swarm",
      spawn_reason: "CAND-PROD-021 deterministic worker-state evidence"
    });
    runtime.workerStateStore.setResult({
      worker_id: workerId,
      status: "completed",
      worker_session_id: "session-worker-blackboard-state",
      last_result: "Worker completed deterministic Blackboard projection evidence.",
      outcome,
      last_review: { verdict: "approve", summary: "worker-state evidence is deterministic" },
      last_verification: { status: "success", summary: "focused blackboard semantics test passed" },
      change_refs: [scopedFile]
    });

    writeBlackboardEntry(runtime, "2026-05-12T00:00:30.000Z", {
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key: "worker.state.started.worker-blackboard-state",
      type: "observation",
      value: {
        worker_id: workerId,
        status: "running",
        task_id: taskId,
        file_scope: [scopedFile]
      },
      created_by: { agent_id: workerId, role: "worker", capability: "code.implement" },
      tags: ["worker-state", workerId, "work-kernel"]
    });
    writeBlackboardEntry(runtime, "2026-05-12T00:00:31.000Z", {
      swarm_id: swarmId,
      session_id: sessionId,
      task_id: taskId,
      key: "worker.state.completed.worker-blackboard-state",
      type: "result",
      value: {
        worker_id: workerId,
        status: "completed",
        worker_session_id: "session-worker-blackboard-state",
        last_result: "Worker completed deterministic Blackboard projection evidence.",
        outcome
      },
      created_by: { agent_id: workerId, role: "worker", capability: "code.implement" },
      tags: ["worker-state", workerId, "work-kernel"]
    });

    const snapshot = runtime.getWorkSnapshot(sessionId);
    const worker = snapshot.workers.find((item): item is WorkerRecord => isWorkerRecord(item) && item.worker_id === workerId);
    assert(worker, "expected worker-state row to project into WorkSnapshot.workers");
    assert.equal(worker.status, "completed");
    assert.equal(worker.agent_spec_id, "coder");
    assert.equal(worker.invocation_mode, "call_subagent");
    assert.equal(worker.worker_session_id, "session-worker-blackboard-state");
    assert.equal(worker.last_result, "Worker completed deterministic Blackboard projection evidence.");
    assert.deepEqual(worker.change_refs, [scopedFile]);
    assert.deepEqual(worker.outcome, outcome);
    assert.equal(snapshot.work_contracts.summary.active_workers, 0);
    assert.equal(snapshot.work_contracts.summary.resumable_workers, 1);
    assert.equal(snapshot.work_contracts.summary.scoped_write, 1);
    assert.deepEqual(snapshot.work_contracts.summary.scoped_targets, [scopedFile]);
    const resumableWorker = snapshot.work_contracts.resumable_workers.find((item) => item.worker_id === workerId);
    assert(resumableWorker, "expected completed worker to be resumable");
    assert.equal(resumableWorker.write_policy, "scoped_write");
    assert.deepEqual(resumableWorker.file_scope, [scopedFile]);
    assert.equal(snapshot.blackboard_counts.observation, 1);
    assert.equal(snapshot.blackboard_counts.result, 1);

    const detail = runtime.getTaskDetail(sessionId, taskId);
    const workerStateFacts = detail.blackboard.filter((entry) => (entry.tags ?? []).includes("worker-state"));
    assert.deepEqual(workerStateFacts.map((entry) => entry.key), [
      "worker.state.started.worker-blackboard-state",
      "worker.state.completed.worker-blackboard-state"
    ]);
    assert.deepEqual(workerStateFacts.map((entry) => entry.type), ["observation", "result"]);
    for (const entry of workerStateFacts) {
      assert.equal(entry.task_id, taskId);
      assert.equal(entry.created_by.agent_id, workerId);
      assert((entry.tags ?? []).includes(workerId), `expected ${entry.key} to be tagged with the worker id`);
      assert((entry.tags ?? []).includes("work-kernel"), `expected ${entry.key} to be tagged with work-kernel`);
      assert.equal(workerStateValue(entry).worker_id, workerId);
    }

    const replay = runtime.replaySession(sessionId);
    assert.match(replay, /Workers: 1/);
    assert.match(replay, /worker-blackboard-state \[completed\]/);
    assert.match(replay, /coder\/call_subagent/);
    assert.match(replay, /policy=scoped_write/);
    assert.match(replay, /scope=src\/runtime\/blackboard-semantics\.test\.ts/);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

function seedWorkSession(runtime: SwarmRuntime, fixture: Fixture, input: {
  candidate?: string;
  sourceTitle?: string;
  objective?: string;
  taskTitle?: string;
} = {}): {
  sessionId: string;
  swarmId: string;
  taskId: string;
} {
  const sessionId = "session-blackboard-semantics-1";
  const swarmId = "swarm-blackboard-semantics-1";
  const taskId = "task-blackboard-semantics";
  const candidate = input.candidate ?? "CAND-PROD-015";
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: "lease-blackboard-semantics-1",
    session_id: sessionId,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/blackboard-semantics.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "blackboard-semantics-test" },
    created_at: AT
  });
  const source: WorkItem = {
    source: "user",
    source_id: "blackboard-semantics",
    human_id: candidate,
    title: input.sourceTitle ?? "Blackboard semantics evidence",
    description: input.objective ?? "Seed deterministic live-message and review fact entries.",
    labels: input.candidate === "CAND-PROD-021"
      ? ["blackboard", "worker-state", "work-kernel"]
      : ["blackboard", "live-message", "review"],
    state: "active",
    metadata: { candidate }
  };
  runtime.sessionStore.create({
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: "user-blackboard-semantics",
    source,
    workspace_lease_id: lease.lease_id,
    objective: input.objective ?? "Prove Blackboard live-message and review-fact projection",
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
    task_id: taskId,
    title: input.taskTitle ?? "Seed Blackboard semantics",
    action: "blackboard.write",
    status: "completed",
    attempt: 1,
    write_policy: "scoped_write",
    file_scope: ["src/runtime/blackboard-semantics.test.ts"]
  });
  return { sessionId, swarmId, taskId };
}

function writeBlackboardEntry(
  runtime: SwarmRuntime,
  createdAt: string,
  input: Parameters<SwarmRuntime["blackboardStore"]["write"]>[0]
): BlackboardEntry {
  const entry = runtime.blackboardStore.write(input);
  runtime.database.db
    .prepare("UPDATE blackboard_entries SET created_at = ? WHERE entry_id = ?")
    .run(createdAt, entry.entry_id);
  return {
    ...entry,
    created_at: createdAt
  };
}

function workerTaskPacket(input: {
  objective: string;
  fileScope: string[];
}): AgentTaskPacket {
  return {
    objective: input.objective,
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    persona_snapshot: "Coder",
    file_scope: input.fileScope,
    allowed_tools: ["file.read", "file.write"],
    write_policy: "scoped_write",
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

function workerStateValue(entry: BlackboardEntry): { worker_id?: string } {
  assert(entry.value && typeof entry.value === "object", `expected ${entry.key} value to be an object`);
  return entry.value as { worker_id?: string };
}

function isWorkerRecord(value: unknown): value is WorkerRecord {
  return Boolean(value && typeof value === "object" && "worker_id" in value);
}

function reviewResult(summary: string, verdict: ReviewResult["verdict"], score: number): ReviewResult {
  return {
    target_task_id: "task-blackboard-semantics",
    reviewer: { agent_id: "reviewer", role: "reviewer" },
    verdict,
    score,
    summary
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 2,
    max_parallel_tasks: 1,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Fixture = {
  root: string;
  workspace: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-blackboard-semantics-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const AT = "2026-05-12T00:00:00.000Z";
