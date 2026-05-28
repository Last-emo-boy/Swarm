import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import { ProductResultCard } from "./ProductResultCard.js";
import type { AttentionItemView, ResultPreview } from "./run-board-types.js";

test("ProductResultCard adds worker summary and attention history to final result", () => {
  const preview: ResultPreview = {
    ...emptyPreview(),
    contributors: [
      { workerId: "worker_code", label: "Code Worker", contribution: "implemented patch" },
      { workerId: "worker_test", label: "Test Runner", contribution: "verified focused test" }
    ]
  };
  const attentionHistory: AttentionItemView[] = [{
    id: "slow-test",
    kind: "slow",
    severity: "warning",
    title: "Test Runner may be slow",
    summary: "Test Runner had no output for 72s",
    evidence: ["npm test -- session-row"],
    recommendation: "Wait briefly before stopping.",
    actions: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:01:12.000Z",
    resolvedAt: "2026-05-28T00:01:20.000Z",
    resolution: "waited; command completed successfully"
  }];

  const frame = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "work",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff", "/commit"]
    },
    preview,
    attentionHistory
  }), { columns: 120, rows: 20 });
  const text = frameText(frame);

  assert.match(text, /RESULT/);
  assert.match(text, /Status\s+\[OK\] completed/);
  assert.match(text, /Verified\s+\[OK\] npm test -- session-row/);
  assert.match(text, /WORKER SUMMARY/);
  assert.match(text, /Code Worker implemented patch/);
  assert.match(text, /Test Runner verified focused test/);
  assert.match(text, /ATTENTION HISTORY/);
  assert.match(text, /waited; command completed successfully/);
});

test("ProductResultCard dispatches final next action clicks", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 120,
    rows: 20,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "work",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff", "/commit"]
    },
    preview: emptyPreview(),
    attentionHistory: [],
    onNextAction: (action) => clicked.push(`${action.source}:${action.command}`)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findLastCell(frame, "/commit");
  assert(target, "expected final next action to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["final:/commit"]);
  root.unmount();
});

function emptyPreview(): ResultPreview {
  return {
    status: "ready",
    summary: "Fixed session restore.",
    changedFiles: ["src/runtime/session-row.ts"],
    checks: [{ command: "npm test -- session-row", status: "passed" }],
    artifacts: [],
    blockers: [],
    confidence: "high",
    contributors: [],
    risks: [],
    nextActions: ["/diff", "/commit"]
  };
}

function findLastCell(frame: NonNullable<ReturnType<ReturnType<typeof createTuiRoot>["getFrame"]>>, needle: string): { x: number; y: number } | undefined {
  let target: { x: number; y: number } | undefined;
  for (let y = 0; y < frame.screen.height; y += 1) {
    const line = frame.screen.cells[y]?.map((cell) => cell.char).join("") ?? "";
    const x = line.indexOf(needle);
    if (x >= 0) {
      target = { x, y };
    }
  }
  return target;
}
