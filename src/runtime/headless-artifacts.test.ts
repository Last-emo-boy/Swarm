import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildHeadlessRunArtifacts,
  buildHeadlessStreamRecord,
  headlessStreamJson,
  type HeadlessStreamRecord,
  type HeadlessToolPolicy
} from "./headless-artifacts.js";
import type { ResultCard } from "./result-card.js";
import type { WorkProtocolRecord } from "./work-protocol.js";

const STARTED_AT = "2026-05-13T00:00:00.000Z";
const ENDED_AT = "2026-05-13T00:00:02.000Z";
const OBJECTIVE = "Project policy metadata";
const WORKSPACE = "E:/Playground/Swarm";
const TOOL_POLICY: HeadlessToolPolicy = {
  allowed_tools: ["Read", "Grep"],
  disallowed_tools: ["Bash"]
};
const ADDITIONAL_READ_DIRECTORIES = ["E:/Shared/ReadOnly", "D:/Reference"];

test("buildHeadlessRunArtifacts preserves policy sandbox metadata across report telemetry and trajectory", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "ask",
    sandboxMode: "read-only",
    toolPolicy: TOOL_POLICY,
    additionalReadDirectories: ADDITIONAL_READ_DIRECTORIES,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: "session-1",
      content: "Done",
      status: "completed",
      outcome: {
        changed_files: [],
        tests_run: [],
        intermediate_artifacts: [],
        final_summary: "Done"
      }
    }
  });

  assert.equal(artifacts.report.sandbox_mode, "read-only");
  assert.deepEqual(artifacts.report.tool_policy, TOOL_POLICY);
  assert.deepEqual(artifacts.report.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);

  assert.equal(artifacts.telemetry.sandbox_mode, "read-only");
  assert.deepEqual(artifacts.telemetry.tool_policy, TOOL_POLICY);
  assert.deepEqual(artifacts.telemetry.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);

  assertPolicyMetadata(artifacts.trajectory.agent.extra);
  assertPolicyMetadata(artifacts.trajectory.extra);
});

test("buildHeadlessStreamRecord preserves run_start metadata at top level and nested WorkProtocol record", () => {
  const record = buildHeadlessStreamRecord({
    type: "run_start",
    at: STARTED_AT,
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    mode: "coding_loop",
    permission_mode: "ask",
    sandbox_mode: "read-only",
    tool_policy: TOOL_POLICY,
    additional_read_directories: ADDITIONAL_READ_DIRECTORIES
  });

  assert.equal(record.type, "run_start");
  assert.equal(record.sandbox_mode, "read-only");
  assert.deepEqual(record.tool_policy, TOOL_POLICY);
  assert.deepEqual(record.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(record.work, "start");

  const parsed = JSON.parse(headlessStreamJson(record)) as Extract<HeadlessStreamRecord, { type: "run_start" }>;
  assert.equal(parsed.sandbox_mode, "read-only");
  assert.deepEqual(parsed.tool_policy, TOOL_POLICY);
  assert.deepEqual(parsed.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(parsed.work, "start");
});

test("buildHeadlessStreamRecord preserves run_end report metadata in nested WorkProtocol record", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    toolPolicy: TOOL_POLICY,
    additionalReadDirectories: ADDITIONAL_READ_DIRECTORIES,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: "session-1",
      content: "Done",
      status: "completed"
    }
  });
  const record = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: "completed",
    session_id: "session-1",
    duration_ms: 2_000,
    report: artifacts.report
  });

  assert.equal(record.type, "run_end");
  assert.equal(record.report.sandbox_mode, "workspace-write");
  assert.deepEqual(record.report.tool_policy, TOOL_POLICY);
  assert.deepEqual(record.report.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(record.work, "end", "workspace-write");

  const parsed = JSON.parse(headlessStreamJson(record)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;
  assert.equal(parsed.report.sandbox_mode, "workspace-write");
  assert.deepEqual(parsed.report.tool_policy, TOOL_POLICY);
  assert.deepEqual(parsed.report.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(parsed.work, "end", "workspace-write");
});

test("headless report and run_end stream preserve Review / Verification result-card evidence", () => {
  const warningArtifacts = buildReviewProjectionArtifacts(REVIEW_WARNING_RESULT_CARD);

  assertReviewWarningVerificationCard(warningArtifacts.report.result?.result_card);

  const warningRunEnd = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: warningArtifacts.report.status,
    session_id: REVIEW_WARNING_RESULT_CARD.sessionId,
    duration_ms: 2_000,
    report: warningArtifacts.report
  });
  const warningParsed = JSON.parse(headlessStreamJson(warningRunEnd)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assertReviewWarningVerificationCard(warningParsed.report.result?.result_card);

  const failedArtifacts = buildReviewProjectionArtifacts(FAILED_REVIEW_RESULT_CARD, "failed");

  assertFailedReviewCard(failedArtifacts.report.result?.result_card);

  const failedRunEnd = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: failedArtifacts.report.status,
    session_id: FAILED_REVIEW_RESULT_CARD.sessionId,
    duration_ms: 2_000,
    report: failedArtifacts.report
  });
  const failedParsed = JSON.parse(headlessStreamJson(failedRunEnd)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assertFailedReviewCard(failedParsed.report.result?.result_card);
});

function assertPolicyMetadata(value: Record<string, unknown> | undefined): void {
  assert(value);
  assert.equal(value.sandbox_mode, "read-only");
  assert.deepEqual(value.tool_policy, TOOL_POLICY);
  assert.deepEqual(value.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
}

function assertRunWorkMetadata(
  record: WorkProtocolRecord,
  phase: "start" | "end",
  sandboxMode: "read-only" | "workspace-write" = "read-only"
): void {
  assert.equal(record.kind, "run");
  assert.equal(record.phase, phase);
  assert.equal(record.sandbox_mode, sandboxMode);
  assert.deepEqual(record.tool_policy, TOOL_POLICY);
  assert.deepEqual(record.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
}

function buildReviewProjectionArtifacts(
  resultCard: ResultCard,
  status: "completed" | "failed" = "completed"
) {
  return buildHeadlessRunArtifacts({
    objective: "Project Review / Verification result-card evidence",
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: resultCard.sessionId,
      content: resultCard.summary,
      status,
      result_card: resultCard
    }
  });
}

function assertReviewWarningVerificationCard(card: ResultCard | undefined): void {
  assert(card, "missing result_card");
  assert.equal(card.review.status, "warning");
  assert(card.review.summary.includes("missing edge-case assertion"));
  assert(card.checks.some((check) =>
    check.command === "verification check failed: npm run check exited 2" && check.status === "failed"
  ));
  assert(card.artifacts.includes("worker_id_review_verify"));
  assert(card.risks.some((risk) =>
    risk.level === "medium" &&
    risk.message === "Reviewer reported findings or reduced confidence; inspect review details before trusting the result."
  ));
  assert(card.risks.some((risk) =>
    risk.level === "high" &&
    risk.message === "At least one recorded verification check failed."
  ));
  assert(card.next.includes("open the inspector and verify the diff"));
}

function assertFailedReviewCard(card: ResultCard | undefined): void {
  assert(card, "missing result_card");
  assert.equal(card.review.status, "failed");
  assert(card.review.summary.includes("reject 45"));
  assert(card.review.summary.includes("Reject until verification artifacts are attached."));
}

const REVIEW_WARNING_RESULT_CARD: ResultCard = {
  sessionId: "session-review-warning-result-card",
  status: "completed",
  route: "work",
  summary: "Review found a missing edge-case assertion.",
  changedFiles: ["src/runtime/headless-artifacts.test.ts"],
  checks: [
    {
      command: "node --import tsx --test src/runtime/headless-artifacts.test.ts",
      status: "passed"
    },
    {
      command: "verification check failed: npm run check exited 2",
      status: "failed"
    }
  ],
  review: {
    status: "warning",
    summary: "needs_revision 82 - Review found a missing edge-case assertion."
  },
  risks: [
    {
      level: "medium",
      message: "Reviewer reported findings or reduced confidence; inspect review details before trusting the result."
    },
    {
      level: "high",
      message: "At least one recorded verification check failed."
    }
  ],
  artifacts: ["worker_id_review_verify"],
  next: ["open the inspector and verify the diff"]
};

const FAILED_REVIEW_RESULT_CARD: ResultCard = {
  sessionId: "session-review-failed-result-card",
  status: "failed",
  route: "work",
  summary: "Reject until verification artifacts are attached.",
  changedFiles: ["src/runtime/headless-artifacts.test.ts"],
  checks: [],
  review: {
    status: "failed",
    summary: "reject 45 - Reject until verification artifacts are attached."
  },
  risks: [
    {
      level: "high",
      message: "Run ended in failure."
    }
  ],
  artifacts: [],
  next: ["inspect the error and rerun the narrowest failing step"]
};
