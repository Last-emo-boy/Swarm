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
  }
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

test("attention and result preview formatters keep next step visible", () => {
  const attention: AttentionItemView = {
    id: "att-1",
    kind: "blocked",
    severity: "blocking",
    title: "Reviewer blocked",
    summary: "waiting for Test Runner",
    recommendation: "Wait for verification before reviewing.",
    evidence: ["Test Runner is still active"],
    actions: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z"
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

  assert(formatAttentionItem(attention, 80).some((line) => /Next:/.test(line)));
  assert(formatAttentionItem(attention, 80).some((line) => /Why:/.test(line)));
  assert(formatAttentionItem(attention, 80).every((line) => !/recommend:|evidence:/.test(line)));
  assert(formatAttentionItem({
    ...attention,
    summary: "Reviewer is waiting for Test Runner.",
    evidence: ["Reviewer is waiting for Test Runner."]
  }, 80).every((line) => !/Why: Reviewer is waiting for Test Runner\./.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => displayWidth(line) <= 80));
  assert(formatResultPreview(preview, 80).every((line) => !/Confidence/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Changed:|src\/tui\/run-board\/WorkerRow\.tsx/.test(line)));
  assert(formatResultPreview(preview, 80).some((line) => /Verified: Passed/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/\[RUN\] npm test|npm test|\[OK\] npm run lint|npm run lint/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Checks:|npm test \[running\]/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Artifacts/.test(line)));
  assert(formatResultPreview(preview, 80).some((line) => /Blockers: review needed/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => !/Blockers: checks pending/.test(line)));
});

test("result preview formatter keeps empty state quiet", () => {
  const preview: ResultPreview = {
    status: "empty",
    summary: "Ask Swarm to review, plan, or explain this workspace.",
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
  assert.deepEqual(lines, ["Result: Ask Swarm to review, plan, or explain this workspace."]);
  assert(lines.every((line) => displayWidth(line) <= 80));
});
