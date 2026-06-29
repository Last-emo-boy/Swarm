import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import type { TuiFrame } from "../renderer/frame.js";
import { resolveTuiColor, withTuiThemeProfile } from "../theme.js";
import { InlineResultBlock } from "./InlineResultBlock.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";

function colorAtText(frame: TuiFrame, needle: string): string | undefined {
  for (const row of frame.screen.cells) {
    const line = row.map((cell) => cell.char).join("");
    const index = line.indexOf(needle);
    if (index >= 0) {
      const offset = [...needle].findIndex((char) => char.trim().length > 0);
      return row[index + Math.max(0, offset)]?.style.color;
    }
  }
  return undefined;
}

function viewWith(resultPreview: Partial<RunBoardSurfaceView["resultPreview"]>): RunBoardSurfaceView {
  return {
    title: "Swarm Board",
    phase: "working",
    workers: [],
    attention: [],
    resultPreview: {
      status: "ready",
      summary: "",
      changedFiles: [],
      checks: [],
      artifacts: [],
      blockers: [],
      confidence: "medium",
      contributors: [],
      risks: [],
      nextActions: [],
      ...resultPreview
    }
  };
}

test("InlineResultBlock renders changed file paths and check command+status inline", () => {
  const view = viewWith({
    changedFiles: ["src/runtime/session-row.ts", "src/runtime/session-row.test.ts"],
    checks: [
      { command: "npm test", status: "passed" },
      { command: "npm run check", status: "running" }
    ]
  });
  const text = frameText(renderTuiToFrame(React.createElement(InlineResultBlock, { view }), { columns: 120, rows: 4 }));
  assert.match(text, /2 files/);
  assert.match(text, /src\/runtime\/session-row\.ts/);
  assert.match(text, /npm test/);
  assert.match(text, /\[OK\]/);
  assert.match(text, /\[RUN\]/);
});

test("InlineResultBlock surfaces failing checks first", () => {
  const view = viewWith({
    changedFiles: ["src/a.ts"],
    checks: [
      { command: "npm run check", status: "running" },
      { command: "npm test", status: "failed" }
    ]
  });
  const lines = frameText(renderTuiToFrame(React.createElement(InlineResultBlock, { view }), { columns: 120, rows: 4 }))
    .split("\n").filter((line) => line.trim().length > 0);
  const checksRow = lines.findIndex((line) => line.includes("[ERR]"));
  const filesRow = lines.findIndex((line) => line.includes("1 files"));
  assert(checksRow >= 0 && filesRow >= 0 && checksRow < filesRow, `checks(${checksRow}) should sit above files(${filesRow})`);
  const errIdx = lines[checksRow].indexOf("[ERR]");
  const runIdx = lines[checksRow].indexOf("[RUN]");
  assert(errIdx >= 0 && (runIdx === -1 || errIdx < runIdx), "failed check should come first in the checks row");
});

test("InlineResultBlock keeps each row to one line at 80 cols", () => {
  const view = viewWith({
    changedFiles: ["src/very/long/path/one.ts", "src/very/long/path/two.ts", "src/very/long/path/three.ts", "src/four.ts"],
    checks: [
      { command: "npm test", status: "failed" },
      { command: "npm run check", status: "running" },
      { command: "npm run lint", status: "passed" },
      { command: "cargo clippy", status: "passed" }
    ]
  });
  const text = frameText(renderTuiToFrame(React.createElement(InlineResultBlock, { view, columns: 80 }), { columns: 80, rows: 6 }));
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  assert(lines.length <= 2, `expected <=2 rows, got ${lines.length}: ${JSON.stringify(lines)}`);
  for (const line of lines) assert(line.length <= 80, `row exceeds 80 cols: ${line.length}`);
});

test("InlineResultBlock check badge color follows status token", () => {
  const view = viewWith({
    checks: [
      { command: "npm test", status: "failed" },
      { command: "npm run lint", status: "passed" }
    ]
  });
  const frame = renderTuiToFrame(React.createElement(InlineResultBlock, { view }), { columns: 120, rows: 4 });
  assert.equal(colorAtText(frame, "[ERR]"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "[OK]"), resolveTuiColor("status.success"));
});

test("InlineResultBlock renders nothing without files or checks", () => {
  const text = frameText(renderTuiToFrame(React.createElement(InlineResultBlock, { view: viewWith({}) }), { columns: 120, rows: 4 }));
  assert.doesNotMatch(text, /files/);
  assert.doesNotMatch(text, /\[OK\]|\[ERR\]|\[RUN\]/);
});

test("InlineResultBlock stays NO_COLOR-safe under monochrome", () => {
  const view = viewWith({
    checks: [
      { command: "npm test", status: "failed" },
      { command: "npm run lint", status: "passed" }
    ]
  });
  const text = withTuiThemeProfile("swarm-monochrome", () =>
    frameText(renderTuiToFrame(React.createElement(InlineResultBlock, { view }), { columns: 120, rows: 4 }))
  );
  assert.match(text, /\[ERR\]/);
  assert.match(text, /\[OK\]/);
});
