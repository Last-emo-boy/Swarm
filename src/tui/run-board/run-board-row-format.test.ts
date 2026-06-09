import { strict as assert } from "node:assert";
import test from "node:test";
import { displayWidth } from "../display-width.js";
import { formatAttentionItem, formatResultPreview, formatWorkerRow } from "./run-board-row-format.js";
import type { AttentionItemView, ResultPreview, WorkerBoardRow } from "./run-board-types.js";
import { workerRowSpans } from "./WorkerRow.js";

test("worker row formatter respects terminal width budgets", () => {
  const row: WorkerBoardRow = {
    id: "worker:test",
    label: "Test Runner With Very Long Label",
    role: "test",
    status: "active",
    currentAction: "running a focused verification command with a very long path",
    lastEvidence: "npm test -- src/tui/run-board/some/extremely/long/file.test.ts",
    elapsedMs: 72_000,
    owns: [],
    risk: "low",
    canStop: true,
    canRetry: false,
    canTakeBack: false
  };

  for (const columns of [80, 100, 120, 160]) {
    const line = formatWorkerRow(row, columns);
    assert(displayWidth(line) <= columns, `${columns}: ${line}`);
    assert.match(line, /Test Runner/);
    assert.match(line, /01:12/);
    assert(line.indexOf("running") < line.indexOf("01:12"), `${columns}: expected action before elapsed age`);
    assert.doesNotMatch(line, /\bactive\b/);
    assert.doesNotMatch(line, /npm test --/);
  }
});

test("worker row formatter only shows evidence for blocked decision states", () => {
  const active: WorkerBoardRow = {
    id: "worker:active",
    label: "Code Worker",
    role: "code",
    status: "active",
    currentAction: "editing files",
    lastEvidence: "opened src/tui/run-board/WorkerRow.tsx",
    elapsedMs: 1_000,
    owns: [],
    risk: "low",
    canStop: true,
    canRetry: false,
    canTakeBack: false
  };
  const blocked: WorkerBoardRow = {
    ...active,
    id: "worker:blocked",
    label: "Test Runner",
    role: "test",
    status: "blocked",
    currentAction: "waiting for output",
    lastEvidence: "npm test produced no output",
    risk: "medium",
    canRetry: true
  };

  assert.doesNotMatch(formatWorkerRow(active, 120), /opened src\/tui\/run-board\/WorkerRow\.tsx/);
  assert.match(formatWorkerRow(blocked, 120), /npm test produced no output/);
});

test("worker row hides evidence that repeats the current action", () => {
  const row: WorkerBoardRow = {
    id: "worker:test",
    label: "Test Runner",
    role: "test",
    status: "active",
    currentAction: "running focused test",
    lastEvidence: " running   focused test ",
    elapsedMs: 12_000,
    owns: [],
    risk: "low",
    canStop: true,
    canRetry: false,
    canTakeBack: false
  };

  const line = formatWorkerRow(row, 120);
  const spanText = workerRowSpans(row).map((span) => span.text).join("");

  assert.equal((line.match(/running focused test/g) ?? []).length, 1);
  assert.equal((spanText.match(/running focused test/g) ?? []).length, 1);
});

test("worker row hides raw waiting target ids in default output", () => {
  const active: WorkerBoardRow = {
    id: "worker:active",
    label: "Code Worker",
    role: "code",
    status: "active",
    currentAction: "editing files",
    waitingOn: "worker_internal_123",
    elapsedMs: 1_000,
    owns: [],
    risk: "low",
    canStop: true,
    canRetry: false,
    canTakeBack: false
  };
  const blocked: WorkerBoardRow = {
    ...active,
    id: "worker:blocked",
    label: "Test Runner",
    role: "test",
    status: "blocked",
    currentAction: "waiting for dependency",
    risk: "medium",
    canRetry: true
  };

  const activeText = formatWorkerRow(active, 120);
  const blockedText = formatWorkerRow(blocked, 120);
  const blockedSpanText = workerRowSpans(blocked).map((span) => span.text).join("");

  assert.doesNotMatch(activeText, /worker_internal_123|waiting on another task/u);
  assert.match(blockedText, /waiting on another task/);
  assert.match(blockedSpanText, /waiting on another task/);
  assert.doesNotMatch(`${blockedText}\n${blockedSpanText}`, /worker_internal_123/u);
});

test("attention and result preview formatters keep next step visible", () => {
  const warningAttention: AttentionItemView = {
    id: "att-1",
    kind: "blocked",
    severity: "warning",
    title: "Reviewer blocked",
    summary: "waiting for Test Runner",
    recommendation: "Wait for verification before reviewing.",
    evidence: ["Test Runner is still active"],
    actions: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z"
  };
  const blockingAttention: AttentionItemView = {
    ...warningAttention,
    id: "att-approval",
    kind: "approval",
    severity: "blocking",
    title: "Approval needed"
  };
  const failedAttention: AttentionItemView = {
    ...warningAttention,
    id: "att-failed",
    kind: "failed",
    severity: "failed",
    title: "Command failed"
  };
  const preview: ResultPreview = {
    status: "pending",
    summary: "Patch ready, checks pending",
    changedFiles: ["src/tui/run-board/WorkerRow.tsx"],
    checks: [
      { command: "npm test", status: "running" },
      { command: "npm run lint", status: "passed" }
    ],
    artifacts: ["artifacts/result-preview.log"],
    blockers: ["checks pending", "review needed"],
    confidence: "medium",
    contributors: [],
    risks: [],
    nextActions: []
  };

  assert(formatAttentionItem(warningAttention, 80).some((line) => /Next:/.test(line)));
  assert(formatAttentionItem(warningAttention, 80).every((line) => !/Seen:|Why:/.test(line)));
  assert(formatAttentionItem(blockingAttention, 80).some((line) => /Seen: Test Runner is still active/.test(line)));
  assert(formatAttentionItem(failedAttention, 80).some((line) => /Seen: Test Runner is still active/.test(line)));
  assert(formatAttentionItem(warningAttention, 80).every((line) => !/recommend:|evidence:/.test(line)));
  assert(formatAttentionItem({
    ...blockingAttention,
    summary: "Reviewer is waiting for Test Runner.",
    evidence: ["Reviewer is waiting for Test Runner."]
  }, 80).every((line) => !/Seen: Reviewer is waiting for Test Runner\.|Why: Reviewer is waiting for Test Runner\./.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => displayWidth(line) <= 80));
  assert(formatResultPreview(preview, 80).every((line) => !/Confidence/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Changed:|src\/tui\/run-board\/WorkerRow\.tsx/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Verified: Passed|\[RUN\] npm test|npm test|\[OK\] npm run lint|npm run lint/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Checks:|npm test \[running\]/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Artifacts/.test(line)));
  assert(formatResultPreview(preview, 80).some((line) => /Needs: review needed/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Blockers:|Needs: checks pending/.test(line)));
});

test("result preview formatter keeps empty state quiet", () => {
  const preview: ResultPreview = {
    status: "empty",
    summary: "Ask Swarm to review or plan this workspace.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    blockers: [],
    confidence: "low",
    contributors: [],
    risks: [],
    nextActions: []
  };

  const lines = formatResultPreview(preview, 80);
  assert.deepEqual(lines, ["Ask Swarm to review or plan this workspace."]);
  assert(lines.every((line) => displayWidth(line) <= 80));
});
