import { strict as assert } from "node:assert";
import test from "node:test";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ExecutionResult } from "../runtime/orchestrator.js";
import type { ReviewResult, WorkSnapshot } from "../protocol/types.js";
import { briefForExecutionResult, formatExecutionResultDisplay } from "./result-display.js";

test("formatExecutionResultDisplay preserves Review / Verification evidence in preview and detail", () => {
  const { result, runtime } = buildFixture("failed");
  const display = formatExecutionResultDisplay(result, runtime);

  assert(display.preview.startsWith("Result\n"));
  assert(display.preview.includes("Summary: Review / Verification result display preserved."));
  assert(display.preview.includes("Review: warning - needs_revision 82 - Review found a missing edge-case assertion."));
  assert(display.preview.includes("verification check failed: npm run check exited 2 [failed]"));
  assert(display.preview.includes("high: At least one recorded verification check failed."));
  assert(display.preview.includes("worker_id_review_verify"));
  assert(display.preview.includes("Next (1)"));

  assert(display.detail.startsWith(`${display.preview}\n\nFull Output\n`));
  assert(display.detail.endsWith(result.content));
});

test("briefForExecutionResult prefixes failed and stopped output without losing counts", () => {
  const { result, snapshot } = buildFixture("completed");

  for (const status of ["failed", "stopped"] as const) {
    const brief = briefForExecutionResult({ ...result, status }, snapshot);
    const prefix = status === "failed" ? "Failed: " : "Stopped: ";

    assert(brief.startsWith(`${prefix}Review / Verification result display preserved.`));
    assert(brief.includes("Changed files: 2."));
    assert(brief.includes("Checks: 2."));
  }
});

function buildFixture(status: ExecutionResult["status"]) {
  const snapshot = reviewVerificationSnapshot();
  const result: ExecutionResult = {
    session_id: snapshot.session.session_id,
    content: "Review / Verification result display preserved.\nOriginal final output after verification.",
    status
  };
  const runtime = {
    getWorkSnapshot(sessionId: string) {
      assert.equal(sessionId, snapshot.session.session_id);
      return snapshot;
    }
  } as unknown as SwarmRuntime;
  return { result, snapshot, runtime };
}

function reviewVerificationSnapshot(): WorkSnapshot {
  return {
    session: {
      session_id: SESSION_ID,
      swarm_id: "swarm-result-display",
      objective: "Preserve Review / Verification evidence in the TUI result display",
      status: "completed",
      created_at: AT,
      updated_at: AT
    },
    attempts: [],
    workers: [],
    graph: {
      tasks: [],
      edges: []
    },
    blackboard_counts: {},
    changed_files: ["src/tui/result-display.ts", "src/tui/result-display.test.ts"],
    checks: [
      "node --import tsx --test src/tui/result-display.test.ts",
      "verification check failed: npm run check exited 2"
    ],
    review: reviewResult({
      verdict: "needs_revision",
      score: 82,
      summary: "Review found a missing edge-case assertion.",
      issues: [
        {
          severity: "medium",
          message: "Missing boundary case for failed verifier output.",
          evidence: "src/tui/result-display.ts"
        }
      ]
    }),
    verification: {
      status: "failed",
      summary: "verification check failed for TypeScript compile",
      worker_id: "worker_id_review_verify"
    },
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
      active_workers: [],
      resumable_workers: [],
      active_handoffs: []
    },
    final_outcome: {
      changed_files: ["src/tui/result-display.ts", "src/tui/result-display.test.ts"],
      intermediate_artifacts: [],
      tests_run: [
        "node --import tsx --test src/tui/result-display.test.ts",
        "verification check failed: npm run check exited 2"
      ],
      final_summary: "Review / Verification result display preserved."
    }
  };
}

function reviewResult(input: {
  verdict: ReviewResult["verdict"];
  score: number;
  summary: string;
  issues?: ReviewResult["issues"];
}): ReviewResult {
  return {
    target_task_id: "task-result-display",
    reviewer: { agent_id: "reviewer", role: "reviewer" },
    verdict: input.verdict,
    score: input.score,
    issues: input.issues,
    summary: input.summary
  };
}

const SESSION_ID = "session-result-display";
const AT = "2026-05-13T00:00:00.000Z";
