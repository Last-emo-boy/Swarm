import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import { ActivityLine } from "./ActivityLine.js";
import { ProgressIndicator } from "./ProgressIndicator.js";
import { CompactStatusLine } from "./CompactStatusLine.js";
import { ActivityRail } from "./ActivityRail.js";
import type { RunBoardSurfaceView, WorkerBoardRow } from "./run-board-types.js";

function worker(partial: Partial<WorkerBoardRow> & Pick<WorkerBoardRow, "id" | "role" | "status">): WorkerBoardRow {
  return {
    label: partial.label ?? partial.id,
    currentAction: "doing work",
    elapsedMs: 10_000,
    owns: [],
    risk: "low",
    canStop: false,
    canRetry: false,
    canTakeBack: false,
    ...partial
  } as WorkerBoardRow;
}

function fixtureView(): RunBoardSurfaceView {
  return {
    title: "Swarm Board",
    objective: "Fix failing tests with the smallest safe change",
    phase: "verifying",
    focus: "Running verification",
    workers: [
      worker({ id: "main", role: "main", status: "active", label: "Main Swarm" }),
      worker({ id: "code", role: "code", status: "done", label: "Code Worker" }),
      worker({ id: "test", role: "test", status: "active", label: "Test Runner" }),
      worker({ id: "review", role: "review", status: "waiting", label: "Reviewer" })
    ],
    attention: [
      {
        id: "att-approval",
        kind: "approval",
        severity: "warning",
        title: "Approve shell command",
        summary: "needs approval",
        recommendation: "Review before allowing.",
        evidence: [],
        actions: [],
        subjectWorkerId: "test",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z"
      }
    ],
    resultPreview: {
      status: "ready",
      summary: "Patch ready, verifying.",
      changedFiles: ["src/runtime/session-row.ts", "src/runtime/session-row.test.ts"],
      checks: [
        { command: "npm test", status: "passed" },
        { command: "npm run check", status: "running" }
      ],
      artifacts: [],
      blockers: [],
      confidence: "medium",
      contributors: [],
      risks: [],
      nextActions: []
    }
  };
}

test("ActivityLine renders a glanceable badge + progress", () => {
  const text = frameText(renderTuiToFrame(React.createElement(ActivityLine, { view: fixtureView() }), { columns: 100, rows: 4 }));
  assert.match(text, /\[RUN\]/);
  assert.match(text, /Running verification/);
  assert.match(text, /steps/);
  // No dense board chrome leaks into the activity line.
  assert.doesNotMatch(text, /WORKER BOARD|SWARM BOARD/);
});

test("ProgressIndicator renders checks and workers progress", () => {
  const text = frameText(renderTuiToFrame(React.createElement(ProgressIndicator, { view: fixtureView() }), { columns: 100, rows: 4 }));
  assert.match(text, /1\/2 checks/);
  assert.match(text, /1\/4 workers/);
});

test("CompactStatusLine aggregates workers, files, and approvals", () => {
  // Rendered wide enough that the full footer fits one line; narrow-terminal
  // abbreviation of this footer is a Phase-3 refinement.
  const text = frameText(renderTuiToFrame(React.createElement(CompactStatusLine, { view: fixtureView(), elapsedMs: 108_000 }), { columns: 130, rows: 3 }));
  assert.match(text, /4 workers/);
  assert.match(text, /2 files/);
  assert.match(text, /\[ASK\] 1 approvals/);
  assert.match(text, /01:48/);
});

test("ActivityRail is hidden by default and lists workers when toggled", () => {
  const hidden = frameText(renderTuiToFrame(React.createElement(ActivityRail, { view: fixtureView(), visible: false }), { columns: 100, rows: 12 }));
  assert.doesNotMatch(hidden, /WORKERS/);
  const shown = frameText(renderTuiToFrame(React.createElement(ActivityRail, { view: fixtureView(), visible: true, columns: 60 }), { columns: 100, rows: 12 }));
  assert.match(shown, /WORKERS/);
  assert.match(shown, /Main Swarm/);
  assert.match(shown, /Test Runner/);
});

test("CompactStatusLine fits one line at 80 cols with abbreviations", () => {
  const text = frameText(renderTuiToFrame(React.createElement(CompactStatusLine, { view: fixtureView(), elapsedMs: 108_000, columns: 80 }), { columns: 80, rows: 3 }));
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, `expected one line, got ${lines.length}: ${JSON.stringify(lines)}`);
  assert(lines[0].length <= 80, `expected <=80 cols, got ${lines[0].length}`);
  assert.match(text, /4w/);
  assert.match(text, /\[ASK\]1/);
});

test("ActivityLine fits one line at 80 cols", () => {
  const longFocus = { ...fixtureView(), focus: "Running a very long verification step description that should be clipped" };
  const text = frameText(renderTuiToFrame(React.createElement(ActivityLine, { view: longFocus, compact: true }), { columns: 80, rows: 2 }));
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, `expected one line, got ${lines.length}`);
  assert.match(text, /\[RUN\]/);
  assert.match(text, /steps/);
});
