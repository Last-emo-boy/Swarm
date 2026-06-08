import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import { ResultPreview } from "./ResultPreview.js";
import type { ResultPreview as ResultPreviewData } from "./run-board-types.js";

test("ResultPreview shows user-facing next actions while preserving commands", () => {
  const preview = previewFixture();
  const frame = renderTuiToFrame(React.createElement(ResultPreview, { preview }), { columns: 100, rows: 12 });
  const text = frameText(frame);

  assert.match(text, /Next\s+Review changes\s+Commit when ready/);
  assert.doesNotMatch(text, /Next\s+\/diff\s+\/commit/);
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
  const target = findLastCell(frame, "Commit when ready");
  assert(target, "expected preview next action to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["preview:/commit"]);
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
    nextActions: ["/diff", "/commit"]
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
