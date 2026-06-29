import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import { withTuiThemeProfile } from "../theme.js";
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

test("ActivityRail is hidden by default and lists workers when toggled", () => {
  const hidden = frameText(renderTuiToFrame(React.createElement(ActivityRail, { view: fixtureView(), visible: false }), { columns: 100, rows: 12 }));
  assert.doesNotMatch(hidden, /WORKERS/);
  const shown = frameText(renderTuiToFrame(React.createElement(ActivityRail, { view: fixtureView(), visible: true, columns: 60 }), { columns: 100, rows: 12 }));
  assert.match(shown, /WORKERS/);
  assert.match(shown, /Main Swarm/);
  assert.match(shown, /Test Runner/);
});

test("ActivityRail flags attention workers with a marker visible under monochrome", () => {
  const text = withTuiThemeProfile("swarm-monochrome", () =>
    frameText(renderTuiToFrame(React.createElement(ActivityRail, { view: fixtureView(), visible: true, columns: 60 }), { columns: 100, rows: 12 }))
  );
  const lines = text.split("\n");
  const flaggedRow = lines.find((line) => line.includes("Test Runner"));
  const normalRow = lines.find((line) => line.includes("Main Swarm"));
  assert.ok(flaggedRow?.includes("!"), `flagged worker row should carry the marker: ${flaggedRow}`);
  assert.ok(normalRow && !normalRow.includes("!"), `non-flagged worker row should not carry the marker: ${normalRow}`);
});
