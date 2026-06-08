import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import { ResultPreview } from "./ResultPreview.js";
import type { ResultPreview as ResultPreviewData } from "./run-board-types.js";

test("ResultPreview keeps the empty state to one quiet line", () => {
  const frame = renderTuiToFrame(React.createElement(ResultPreview, { preview: emptyPreview() }), { columns: 80, rows: 8 });
  const text = frameText(frame);

  assert.match(text, /RESULT/);
  assert.doesNotMatch(text, /RESULT PREVIEW/);
  assert.match(text, /Waiting for your first task\./);
  assert.doesNotMatch(text, /Confidence\s+low/);
  assert.doesNotMatch(text, /No activity yet\./);
  assert.doesNotMatch(text, /Activity\s+No activity/);
});

test("ResultPreview shows user-facing next actions while preserving commands", () => {
  const preview = previewFixture();
  const frame = renderTuiToFrame(React.createElement(ResultPreview, { preview }), { columns: 100, rows: 12 });
  const text = frameText(frame);

  assert.match(text, /RESULT/);
  assert.doesNotMatch(text, /RESULT PREVIEW/);
  assert.match(text, /Next\s+Review changes\s+Commit when ready\s+Review this workspace/);
  assert.match(text, /Confidence\s+high/);
  assert.doesNotMatch(text, /Next\s+\/diff\s+\/commit\s+\/review auth and permissions/);
});

test("ResultPreview next action clicks keep the original command", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 100,
    rows: 12,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ResultPreview, {
    preview: previewFixture(),
    onAction: (action) => clicked.push(`${action.source}:${action.command}`)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findLastCell(frame, "Review this workspace");
  assert(target, "expected preview next action to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["preview:/review auth and permissions"]);
  root.unmount();
});

function previewFixture(): ResultPreviewData {
  return {
    status: "ready",
    summary: "Patch ready for review.",
    changedFiles: ["src/tui/run-board/ResultPreview.tsx"],
    checks: [{ command: "npm test -- result-preview", status: "passed" }],
    artifacts: [],
    blockers: [],
    confidence: "high",
    contributors: [],
    risks: [],
    nextActions: ["/diff", "/commit", "/review auth and permissions"]
  };
}

function emptyPreview(): ResultPreviewData {
  return {
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
}

function findLastCell(frame: NonNullable<ReturnType<ReturnType<typeof createTuiRoot>["getFrame"]>>, needle: string): { x: number; y: number } | undefined {
  let target: { x: number; y: number } | undefined;
  for (let y = 0; y < frame.screen.height; y += 1) {
    const line = frame.screen.cells[y]?.map((cell) => cell.char).join("") ?? "";
    const x = line.lastIndexOf(needle);
    if (x >= 0) {
      target = { x, y };
    }
  }
  return target;
}
