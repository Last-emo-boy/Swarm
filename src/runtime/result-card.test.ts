import { strict as assert } from "node:assert";
import test from "node:test";
import type { ReviewResult, WorkSnapshot } from "../protocol/types.js";
import { buildResultCard, buildResultCardFromSnapshot, formatResultCardText } from "./result-card.js";

test("Review / Verification evidence surfaces review warnings in result cards", () => {
  const snapshot = workSnapshot({
    review: reviewResult({
      verdict: "needs_revision",
      score: 82,
      summary: "Review found a missing edge-case assertion.",
      issues: [{
        severity: "medium",
        message: "Missing boundary case for failed verifier output.",
        evidence: "src/runtime/result-card.ts"
      }]
    })
  });

  const card = buildResultCardFromSnapshot(snapshot, "work");
  const text = formatResultCardText(card);

  assert.equal(card.review.status, "warning");
  assert(card.review.summary.includes("needs_revision 82"));
  assert(card.review.summary.includes("missing edge-case assertion"));
  assert(card.risks.some((risk) => risk.level === "medium" && risk.message.includes("Reviewer reported findings")));
  assert(text.includes("Review: warning - needs_revision 82"));
  assert(text.includes("medium: Reviewer reported findings"));
});

test("Review / Verification evidence surfaces rejected reviews as failed review status", () => {
  const snapshot = workSnapshot({
    review: reviewResult({
      verdict: "reject",
      score: 45,
      summary: "Reject until verification artifacts are attached."
    })
  });

  const card = buildResultCardFromSnapshot(snapshot, "work");

  assert.equal(card.review.status, "failed");
  assert(card.review.summary.includes("reject 45"));
  assert(formatResultCardText(card).includes("Review: failed - reject 45"));
});

test("Review / Verification evidence surfaces failed verification checks and worker artifacts", () => {
  const snapshot = workSnapshot({
    checks: [
      "node --import tsx --test src/runtime/result-card.test.ts",
      "verification check failed: npm run check exited 2"
    ],
    verification: {
      status: "failed",
      summary: "verification check failed for TypeScript compile",
      worker_id: "worker_id_review_verify"
    }
  });

  const card = buildResultCardFromSnapshot(snapshot, "work");
  const text = formatResultCardText(card);

  assert.deepEqual(card.checks.map((check) => check.command), [
    "node --import tsx --test src/runtime/result-card.test.ts",
    "verification check failed: npm run check exited 2"
  ]);
  assert.equal(card.checks[0].status, "passed");
  assert.equal(card.checks[1].status, "failed");
  assert(card.risks.some((risk) => risk.level === "high" && risk.message.includes("verification check failed")));
  assert.deepEqual(card.artifacts, ["worker_id_review_verify"]);
  assert(text.includes("verification check failed: npm run check exited 2 [failed]"));
  assert(text.includes("high: At least one recorded verification check failed."));
  assert(text.includes("worker_id_review_verify"));
});

test("Result cards render checkpoint rollback visibility in the summary text", () => {
  const snapshot = workSnapshot();
  const completed = buildResultCard({
    result: {
      session_id: "session-result-card",
      content: "Checkpoint projection complete.",
      outcome: snapshot.final_outcome,
      status: "completed"
    },
    route: "work",
    snapshot,
    checkpoint: {
      id: "cp_result_card_available",
      name: "Workspace checkpoint",
      mode: "git",
      revertAvailable: true
    }
  });
  const unavailable = buildResultCard({
    result: {
      session_id: "session-result-card",
      content: "Checkpoint projection complete.",
      outcome: snapshot.final_outcome,
      status: "completed"
    },
    route: "work",
    snapshot,
    checkpoint: {
      id: "cp_result_card_unavailable",
      name: "Retired checkpoint",
      mode: "snapshot",
      revertAvailable: false
    }
  });

  assert(formatResultCardText(completed).includes("Checkpoint: Workspace checkpoint [git] revert available"));
  assert(formatResultCardText(unavailable).includes("Checkpoint: Retired checkpoint [snapshot] revert unavailable"));
});

test("Result cards render prompt cache status with shared cache formatting", () => {
  const snapshot = workSnapshot();
  const card = buildResultCard({
    result: {
      session_id: "session-result-card",
      content: "Cache status projection complete.",
      outcome: snapshot.final_outcome,
      status: "completed"
    },
    route: "work",
    snapshot,
    cache: {
      status: "changed",
      hitRate: 0.64,
      writeRate: 0.12,
      diagnostics: "requestPrefixHash4096"
    }
  });

  assert.equal(card.cache?.status, "changed");
  assert(formatResultCardText(card).includes("Cache: changed hit 64%, write 12% requestPrefixHash4096"));
});

function reviewResult(input: {
  verdict: ReviewResult["verdict"];
  score: number;
  summary: string;
  issues?: ReviewResult["issues"];
}): ReviewResult {
  return {
    target_task_id: "task-result-card",
    reviewer: { agent_id: "reviewer", role: "reviewer" },
    verdict: input.verdict,
    score: input.score,
    issues: input.issues,
    summary: input.summary
  };
}

function workSnapshot(input: {
  checks?: string[];
  review?: ReviewResult;
  verification?: unknown;
} = {}): WorkSnapshot {
  return {
    session: {
      session_id: "session-result-card",
      swarm_id: "swarm-result-card",
      objective: "Surface review and verification evidence",
      status: "completed",
      created_at: AT,
      updated_at: AT
    },
    attempts: [],
    workers: [],
    graph: { tasks: [], edges: [] },
    blackboard_counts: {},
    changed_files: ["src/runtime/result-card.ts"],
    checks: input.checks ?? ["node --import tsx --test src/runtime/result-card.test.ts"],
    review: input.review,
    verification: input.verification,
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
      changed_files: ["src/runtime/result-card.ts"],
      intermediate_artifacts: [],
      tests_run: input.checks ?? ["node --import tsx --test src/runtime/result-card.test.ts"],
      final_summary: "Result-card Review / Verification evidence recorded."
    }
  };
}

const AT = "2026-05-12T00:00:00.000Z";
