import { strict as assert } from "node:assert";
import test from "node:test";
import type { RunAttempt, WorkContractSnapshot, WorkContractWorker, WorkSnapshot } from "../protocol/types.js";
import {
  buildResumeHealth,
  formatResumeHealth,
  formatResumeWorkContracts,
  formatResumeWorkerContract,
  renderResumePreflight
} from "./resume-report.js";
import {
  delegatedToolStatus,
  finalAttemptStatus,
  sessionStatusFromExecutionStatus,
  workerStatusFromExecutionStatus
} from "./execution-status.js";
import { buildResultCard } from "./result-card.js";

test("buildResumeHealth reports open attempts and latest unresolved failures", () => {
  const attempts = [
    attempt({ id: "started", taskId: "task-a", status: "started", last: "2026-05-11T00:00:00.000Z" }),
    attempt({ id: "old-failure", taskId: "task-b", status: "failed", last: "2026-05-11T00:01:00.000Z" }),
    attempt({ id: "new-success", taskId: "task-b", status: "completed", last: "2026-05-11T00:02:00.000Z" }),
    attempt({ id: "latest-failure", taskId: "task-c", status: "failed", last: "2026-05-11T00:03:00.000Z" })
  ];

  const health = buildResumeHealth(attempts);

  assert.deepEqual(health.openAttempts.map((item) => item.attempt_id), ["started"]);
  assert.deepEqual(health.unresolvedFailures.map((item) => item.attempt_id), ["latest-failure"]);
});

test("formatResumeHealth keeps resume diagnostics concise and actionable", () => {
  const health = buildResumeHealth([
    attempt({ id: "started", taskId: "task-a", status: "started", last: "2026-05-11T00:00:00.000Z", title: "Active task" }),
    attempt({
      id: "failed",
      taskId: "task-b",
      status: "failed",
      last: "2026-05-11T00:01:00.000Z",
      errorCode: "RUNNER_FAILED",
      reason: "boom",
      recovery: "retry_same_agent"
    })
  ]);

  const lines = formatResumeHealth(health);

  assert(lines.some((line) => line.includes("Open attempts: 1")));
  assert(lines.some((line) => line.includes("Unresolved failures: 1")));
  assert(lines.some((line) => line.includes("retry_same_agent")));
  assert(lines.some((line) => line.startsWith("Resume instruction:")));
});

test("formatResumeWorkContracts includes active, resumable, and handoff counts", () => {
  const activeWorker = worker({ id: "worker-running", status: "running", fileScope: ["src/runtime/runtime.ts"] });
  const stoppedWorker = worker({ id: "worker-stopped", status: "stopped", fileScope: [] });
  const contracts: WorkContractSnapshot = {
    summary: {
      active_workers: 1,
      running_workers: 1,
      pending_workers: 0,
      resumable_workers: 1,
      active_handoffs: 1,
      read_only: 0,
      scoped_write: 1,
      workspace_write: 0,
      scoped_targets: ["src/runtime/runtime.ts"]
    },
    active_workers: [activeWorker],
    resumable_workers: [stoppedWorker],
    active_handoffs: [{
      handoff_id: "handoff-1",
      worker_id: "worker-running",
      source_agent: "main_swarm",
      target_agent_spec_id: "reviewer",
      reason: "review needed",
      status: "active",
      write_policy: "scoped_write",
      file_scope: ["src/runtime/runtime.ts"],
      scope: ["src/runtime/runtime.ts"],
      updated_at: "2026-05-11T00:00:00.000Z"
    }]
  };

  const lines = formatResumeWorkContracts(contracts);

  assert(lines.some((line) => line.includes("Active workers: 1")));
  assert(lines.some((line) => line.includes("Resumable workers: 1")));
  assert(lines.some((line) => line.includes("Active handoffs: 1")));
  assert(formatResumeWorkerContract(activeWorker).includes("scope=src/runtime/runtime.ts"));
});

test("renderResumePreflight uses product-facing section titles", () => {
  const report = renderResumePreflight({
    sessionId: "session-1",
    snapshot: {
      session: {
        session_id: "session-1",
        swarm_id: "swarm-1",
        objective: "Continue the cleanup",
        status: "running",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
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
      work_contracts: emptyWorkContracts(),
      context_summary: {
        entries: 2,
        compactions: 1,
        health: "compacted",
        latest_compaction: {
          compaction_id: "compact-1",
          pre_tokens: 1000,
          post_tokens: 300,
          strategy: "rolling",
          created_at: "2026-05-11T00:00:00.000Z"
        }
      }
    } satisfies WorkSnapshot,
    hasStoredPlan: false,
    freshness: "fresh",
    liveControlDirectives: ["No pending live direction."]
  });

  assert.match(report, /\nResume Team\n/);
  assert.match(report, /\nMemory\n/);
  assert.doesNotMatch(report, /Resume Work Contracts|Context Memory/);
});

test("execution status helpers map local outcomes to Kernel records", () => {
  assert.equal(finalAttemptStatus("failed"), "failed");
  assert.equal(finalAttemptStatus("stopped"), "stopped");
  assert.equal(finalAttemptStatus(undefined), "completed");
  assert.equal(sessionStatusFromExecutionStatus("stopped"), "cancelled");
  assert.equal(workerStatusFromExecutionStatus("completed", true), "stopped");
  assert.equal(delegatedToolStatus("stopped"), "partial");
});

test("result card treats build commands as verification checks", () => {
  const card = buildResultCard({
    result: {
      session_id: "session-1",
      status: "completed",
      content: "done",
      outcome: {
        changed_files: ["src/runtime/coding-agent-loop.ts"],
        intermediate_artifacts: [],
        tests_run: ["code.build npm run build"],
        final_summary: "done"
      }
    },
    route: "work"
  });

  assert.deepEqual(card.checks.map((check) => check.command), ["code.build npm run build"]);
  assert.equal(card.checks[0].status, "passed");
  assert(!card.risks.some((risk) => risk.message === "No verification command was recorded."));
});

function attempt(input: {
  id: string;
  taskId: string;
  status: RunAttempt["status"];
  last: string;
  title?: string;
  errorCode?: string;
  reason?: string;
  recovery?: string;
}): RunAttempt {
  return {
    attempt_id: input.id,
    session_id: "session-1",
    task_id: input.taskId,
    kind: "swarm_task",
    status: input.status,
    attempt: 0,
    title: input.title,
    terminal_reason: input.reason,
    started_at: "2026-05-11T00:00:00.000Z",
    last_event_at: input.last,
    error_code: input.errorCode,
    recovery_suggestion: input.recovery,
    metadata: {}
  };
}

function worker(input: {
  id: string;
  status: WorkContractWorker["status"];
  fileScope: string[];
}): WorkContractWorker {
  return {
    worker_id: input.id,
    display_name: input.id,
    status: input.status,
    capability: "code.review",
    objective: "Review runtime changes",
    write_policy: input.fileScope.length ? "scoped_write" : undefined,
    file_scope: input.fileScope,
    updated_at: "2026-05-11T00:00:00.000Z"
  };
}

function emptyWorkContracts(): WorkContractSnapshot {
  return {
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
    active_workers: [],
    resumable_workers: [],
    active_handoffs: []
  };
}
