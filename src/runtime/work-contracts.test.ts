import { strict as assert } from "node:assert";
import test from "node:test";
import type { AgentTaskPacket } from "./agent-specs.js";
import type { TaskStateSnapshot } from "../protocol/types.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";
import {
  buildTaskContractRecord,
  buildTaskContractSnapshot,
  buildWorkContractHandoff,
  buildWorkContractSnapshot,
  buildWorkContractWorker,
  summarizeTaskContracts,
  summarizeWorkContracts
} from "./work-contracts.js";

const NOW = "2026-05-11T00:00:00.000Z";

test("buildTaskContractRecord preserves task contract fields and derives capability fallback", () => {
  const record = buildTaskContractRecord(task({
    taskId: "task-1",
    title: "Implement runtime tests",
    status: "running",
    requiredCapabilities: ["", "code.test"],
    writePolicy: "scoped_write",
    fileScope: ["src/runtime/work-contracts.ts"],
    dependencies: ["task-0"],
    lastError: "previous failure"
  }));

  assert.equal(record.task_id, "task-1");
  assert.equal(record.status, "running");
  assert.equal(record.capability, "code.test");
  assert.equal(record.write_policy, "scoped_write");
  assert.deepEqual(record.file_scope, ["src/runtime/work-contracts.ts"]);
  assert.deepEqual(record.dependencies, ["task-0"]);
  assert.equal(record.last_error, "previous failure");
});

test("summarizeTaskContracts counts statuses, write policies, and unique scoped targets", () => {
  const snapshot = buildTaskContractSnapshot([
    task({ taskId: "created", status: "created", writePolicy: "read_only" }),
    task({ taskId: "assigned", status: "assigned", writePolicy: "scoped_write", fileScope: ["src/a.ts"] }),
    task({ taskId: "running", status: "running", writePolicy: "scoped_write", fileScope: ["src/a.ts", " src/b.ts "] }),
    task({ taskId: "blocked", status: "blocked" }),
    task({ taskId: "completed", status: "completed", writePolicy: "workspace_write" }),
    task({ taskId: "cancelled", status: "cancelled" })
  ]);

  assert.equal(snapshot.summary.total, 6);
  assert.equal(snapshot.summary.pending, 2);
  assert.equal(snapshot.summary.running, 1);
  assert.equal(snapshot.summary.blocked, 1);
  assert.equal(snapshot.summary.completed, 1);
  assert.equal(snapshot.summary.failed, 1);
  assert.equal(snapshot.summary.read_only, 1);
  assert.equal(snapshot.summary.scoped_write, 2);
  assert.equal(snapshot.summary.workspace_write, 1);
  assert.deepEqual(snapshot.summary.scoped_targets, ["src/a.ts", "src/b.ts"]);
  assert.equal(snapshot.tasks.length, 6);
});

test("buildWorkContractSnapshot separates active workers, resumable workers, and active handoffs", () => {
  const running = worker({ workerId: "worker-running", status: "running", fileScope: ["src/runtime/runtime.ts"] });
  const pending = worker({ workerId: "worker-pending", status: "pending" });
  const stopped = worker({ workerId: "worker-stopped", status: "stopped" });
  const activeHandoff = handoff({ handoffId: "handoff-active", status: "active", fileScope: ["docs/WORK_KERNEL.md"] });
  const returnedHandoff = handoff({ handoffId: "handoff-returned", status: "returned" });

  const snapshot = buildWorkContractSnapshot({
    workers: [stopped, running, pending],
    handoffs: [activeHandoff, returnedHandoff]
  });

  assert.deepEqual(snapshot.active_workers.map((item) => item.worker_id), ["worker-running", "worker-pending"]);
  assert.deepEqual(snapshot.resumable_workers.map((item) => item.worker_id), ["worker-stopped"]);
  assert.deepEqual(snapshot.active_handoffs.map((item) => item.handoff_id), ["handoff-active"]);
  assert.equal(snapshot.summary.active_workers, 2);
  assert.equal(snapshot.summary.running_workers, 1);
  assert.equal(snapshot.summary.pending_workers, 1);
  assert.equal(snapshot.summary.resumable_workers, 1);
  assert.equal(snapshot.summary.active_handoffs, 1);
  assert.deepEqual(snapshot.summary.scoped_targets, ["src/runtime/runtime.ts", "docs/WORK_KERNEL.md"]);
});

test("buildWorkContractWorker derives scoped-write policy from file scope when task packet omits it", () => {
  const contract = buildWorkContractWorker(worker({
    workerId: "worker-1",
    status: "completed",
    fileScope: ["src/agents/worker-loop-contract.ts"]
  }), { generatedAt: NOW });

  assert.equal(contract.worker_id, "worker-1");
  assert.equal(contract.write_policy, "scoped_write");
  assert.deepEqual(contract.file_scope, ["src/agents/worker-loop-contract.ts"]);
  assert.equal(contract.claim_owner, "session-1");
  assert.equal(contract.heartbeat_state, "complete");
  assert.equal(contract.resume_command, "/continue-agent worker-1 inspect the completed result");
  assert.equal(contract.last_artifact, undefined);
});

test("buildWorkContractWorker prefers explicit task packet write policy", () => {
  const contract = buildWorkContractWorker(worker({
    workerId: "worker-1",
    status: "running",
    fileScope: ["src/runtime/runtime.ts"],
    taskPacket: taskPacket({ writePolicy: "read_only", fileScope: ["src/runtime/runtime.ts"] })
  }), { generatedAt: NOW });

  assert.equal(contract.write_policy, "read_only");
  assert.equal(contract.heartbeat_state, "fresh");
  assert.equal(contract.resume_command, "/continue-agent worker-1 continue from the last known state");
});

test("buildWorkContractHandoff maps task packet policy and scope", () => {
  const contract = buildWorkContractHandoff(handoff({
    handoffId: "handoff-1",
    status: "active",
    fileScope: ["src/symphony/scheduler.ts"],
    writePolicy: "scoped_write"
  }), { generatedAt: NOW });

  assert.equal(contract.handoff_id, "handoff-1");
  assert.equal(contract.write_policy, "scoped_write");
  assert.deepEqual(contract.file_scope, ["src/symphony/scheduler.ts"]);
});

test("summarizeWorkContracts includes active handoff scope in scoped targets", () => {
  const summary = summarizeWorkContracts({
    workers: [
      buildWorkContractWorker(worker({ workerId: "running", status: "running", fileScope: ["src/runtime/runtime.ts"] }), { generatedAt: NOW }),
      buildWorkContractWorker(worker({ workerId: "failed", status: "failed", fileScope: [] }), { generatedAt: NOW })
    ],
    handoffs: [
      buildWorkContractHandoff(handoff({ handoffId: "active", status: "active", fileScope: ["docs/WORK_KERNEL.md"] }), { generatedAt: NOW }),
      buildWorkContractHandoff(handoff({ handoffId: "failed", status: "failed", fileScope: ["ignored.md"] }), { generatedAt: NOW })
    ]
  });

  assert.equal(summary.active_workers, 1);
  assert.equal(summary.resumable_workers, 1);
  assert.equal(summary.active_handoffs, 1);
  assert.deepEqual(summary.scoped_targets, ["src/runtime/runtime.ts", "docs/WORK_KERNEL.md"]);
});

test("summarizeTaskContracts can summarize prebuilt records", () => {
  const summary = summarizeTaskContracts([
    buildTaskContractRecord(task({ taskId: "a", status: "pending" })),
    buildTaskContractRecord(task({ taskId: "b", status: "failed", writePolicy: "workspace_write" }))
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.workspace_write, 1);
});

function task(input: {
  taskId: string;
  title?: string;
  status: TaskStateSnapshot["status"];
  requiredCapabilities?: string[];
  capability?: string;
  writePolicy?: TaskStateSnapshot["write_policy"];
  fileScope?: string[];
  dependencies?: string[];
  lastError?: string;
}): TaskStateSnapshot {
  return {
    session_id: "session-1",
    swarm_id: "swarm-1",
    task_id: input.taskId,
    title: input.title ?? input.taskId,
    status: input.status,
    attempt: 0,
    required_capabilities: input.requiredCapabilities ?? [],
    dependencies: input.dependencies ?? [],
    capability: input.capability,
    write_policy: input.writePolicy,
    file_scope: input.fileScope,
    last_error: input.lastError,
    updated_at: NOW
  };
}

function worker(input: {
  workerId: string;
  status: WorkerRecord["status"];
  fileScope?: string[];
  taskPacket?: AgentTaskPacket;
}): WorkerRecord {
  return {
    worker_id: input.workerId,
    display_name: input.workerId,
    parent_session_id: "session-1",
    capability: "code.test",
    objective: "Test Work Kernel contracts",
    status: input.status,
    file_scope: input.fileScope ?? [],
    tool_budget: { max_turns: 4, max_tool_calls: 10 },
    task_packet: input.taskPacket,
    created_at: NOW,
    updated_at: NOW
  };
}

function handoff(input: {
  handoffId: string;
  status: HandoffSessionRecord["status"];
  fileScope?: string[];
  writePolicy?: AgentTaskPacket["write_policy"];
}): HandoffSessionRecord {
  return {
    handoff_id: input.handoffId,
    worker_id: "worker-1",
    parent_session_id: "session-1",
    source_agent: "main",
    target_agent_spec_id: "reviewer",
    reason: "Needs review",
    status: input.status,
    task_packet: taskPacket({ writePolicy: input.writePolicy ?? "read_only", fileScope: input.fileScope ?? [] }),
    created_at: NOW,
    updated_at: NOW
  };
}

function taskPacket(input: {
  writePolicy: AgentTaskPacket["write_policy"];
  fileScope?: string[];
}): AgentTaskPacket {
  return {
    objective: "Do focused work",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    persona_snapshot: "Coder",
    file_scope: input.fileScope ?? [],
    allowed_tools: ["file.read"],
    write_policy: input.writePolicy,
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: { max_turns: 4, max_tool_calls: 10 },
    expected_output: "Summary",
    return_conditions: ["done"]
  };
}
