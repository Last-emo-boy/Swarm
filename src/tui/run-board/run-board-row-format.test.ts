import { strict as assert } from "node:assert";
import test from "node:test";
import { displayWidth } from "../display-width.js";
import { formatAttentionItem, formatResultPreview, formatWorkerRow } from "./run-board-row-format.js";
import type { AttentionItemView, ResultPreview, WorkerBoardRow } from "./run-board-types.js";

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
    checks: [{ command: "npm test", status: "running" }],
    artifacts: [],
    blockers: [],
    confidence: "medium",
    contributors: [],
    risks: [],
    nextActions: []
  };

  assert(formatAttentionItem(attention, 80).some((line) => /Next:/.test(line)));
  assert(formatAttentionItem(attention, 80).some((line) => /Why:/.test(line)));
  assert(formatAttentionItem(attention, 80).every((line) => !/recommend:|evidence:/.test(line)));
  assert(formatResultPreview(preview, 80).every((line) => displayWidth(line) <= 80));
  assert(formatResultPreview(preview, 80).every((line) => !/Confidence/.test(line)));
});

test("result preview formatter keeps empty state quiet", () => {
  const preview: ResultPreview = {
    status: "empty",
    summary: "Waiting for your first task.",
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
  assert.deepEqual(lines, ["Result: Waiting for your first task."]);
  assert(lines.every((line) => displayWidth(line) <= 80));
});
