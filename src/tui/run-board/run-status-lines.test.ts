import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import type { TuiFrame } from "../renderer/frame.js";
import { resolveTuiColor, withTuiThemeProfile } from "../theme.js";
import { selectRunStatusLines } from "./run-status-lines.js";
import { RunStatusLine } from "./RunStatusLine.js";
import type { RunBoardSurfaceView, WorkerBoardRow, WorkerBoardStatus } from "./run-board-types.js";

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

function worker(id: string, status: WorkerBoardStatus): WorkerBoardRow {
  return { id, role: "code", status, label: id, currentAction: "", elapsedMs: 0, owns: [], risk: "low", canStop: false, canRetry: false, canTakeBack: false } as WorkerBoardRow;
}

function view(partial: Partial<RunBoardSurfaceView> = {}): RunBoardSurfaceView {
  return {
    title: "Swarm Board",
    phase: "verifying",
    focus: "Verifying session-row store",
    workers: [],
    attention: [],
    resultPreview: {
      status: "ready", summary: "", changedFiles: [], checks: [],
      artifacts: [], blockers: [], confidence: "medium", contributors: [], risks: [], nextActions: []
    },
    ...partial
  };
}

const barOf = (spans: { text: string; color?: unknown }[]) => spans.find((s) => /^\[#*-*\]$/.test(s.text));
const textOf = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

test("headline shows focus, a single checks-priority ratio, worker and file counts", () => {
  const { headline } = selectRunStatusLines(view({
    workers: [worker("a", "active"), worker("b", "done")],
    resultPreview: { ...view().resultPreview, checks: [{ command: "npm test", status: "passed" }, { command: "npm run check", status: "running" }], changedFiles: ["x.ts"] }
  }), { columns: 120 });
  const text = textOf(headline);
  assert.match(text, /Verifying session-row store/);
  assert.match(text, /1\/2/);     // checks-priority denominator (not workers 1/2 coincidentally — checks win)
  assert.match(text, /·2w/);
  assert.match(text, /1f/);
  assert.match(text, /⌃R/);
});

test("the single progress bar is colored by check outcome", () => {
  const danger = barOf(selectRunStatusLines(view({ resultPreview: { ...view().resultPreview, checks: [{ command: "t", status: "failed" }, { command: "u", status: "passed" }] } })).headline);
  assert.equal(danger?.color, "status.danger");
  const success = barOf(selectRunStatusLines(view({ resultPreview: { ...view().resultPreview, checks: [{ command: "t", status: "passed" }] } })).headline);
  assert.equal(success?.color, "status.success");
  const running = barOf(selectRunStatusLines(view({ resultPreview: { ...view().resultPreview, checks: [{ command: "t", status: "running" }] } })).headline);
  assert.equal(running?.color, "status.running");
});

test("worker count is colored by its worst member so a failure stays visible", () => {
  const { headline } = selectRunStatusLines(view({ workers: [worker("a", "active"), worker("b", "failed"), worker("c", "done")] }));
  const countSpan = headline.find((s) => s.text.includes("3w"));
  assert.equal(countSpan?.color, "status.danger");
});

test("signal line appears only when the user is needed, with action keys before the title", () => {
  assert.equal(selectRunStatusLines(view()).signal, undefined);
  const { signal } = selectRunStatusLines(view({
    attention: [{ id: "a1", kind: "approval", severity: "warning", title: "Approve rename", summary: "", recommendation: "push the session-row rename", evidence: [], actions: [{ key: "a", label: "approve" }, { key: "n", label: "hold" }], createdAt: "x", updatedAt: "x" }]
  }));
  assert.ok(signal, "signal should exist when attention is present");
  const text = textOf(signal!);
  assert.match(text, /\[a\] approve/);
  assert.match(text, /\[n\] hold/);
  assert(text.indexOf("[a] approve") < text.indexOf("push the session-row rename"), "action keys must precede the recommendation");
});

test("RunStatusLine renders one line on the happy path and two when attention is present", () => {
  const happy = frameText(renderTuiToFrame(React.createElement(RunStatusLine, { view: view({ workers: [worker("a", "active")] }) }), { columns: 120, rows: 4 }))
    .split("\n").filter((l) => l.trim().length > 0);
  assert.equal(happy.length, 1, `happy-path should be one line, got ${happy.length}`);
  const withSignal = frameText(renderTuiToFrame(React.createElement(RunStatusLine, { view: view({ attention: [{ id: "a1", kind: "approval", severity: "warning", title: "Approve", summary: "", recommendation: "do it", evidence: [], actions: [{ key: "a", label: "approve" }], createdAt: "x", updatedAt: "x" }] }) }), { columns: 120, rows: 4 }))
    .split("\n").filter((l) => l.trim().length > 0);
  assert.equal(withSignal.length, 2, `attention should add one line, got ${withSignal.length}`);
  assert.match(withSignal.join("\n"), /\[a\] approve/);
});

test("RunStatusLine keeps each line to one row at 80 cols", () => {
  const view80 = view({
    focus: "Verifying a very long session-row store refactor across several modules",
    workers: [worker("a", "active"), worker("b", "active"), worker("c", "failed")],
    resultPreview: { ...view().resultPreview, checks: [{ command: "npm test", status: "failed" }], changedFiles: ["a.ts", "b.ts", "c.ts"] },
    attention: [{ id: "a1", kind: "approval", severity: "warning", title: "Approve push", summary: "", recommendation: "push the rename now please", evidence: [], actions: [{ key: "a", label: "approve" }, { key: "n", label: "hold" }], createdAt: "x", updatedAt: "x" }]
  });
  const lines = frameText(renderTuiToFrame(React.createElement(RunStatusLine, { view: view80, columns: 80, compact: true }), { columns: 80, rows: 4 }))
    .split("\n").filter((l) => l.trim().length > 0);
  assert(lines.length <= 2, `expected <=2 lines, got ${lines.length}`);
  for (const l of lines) assert(l.length <= 80, `line exceeds 80 cols: ${l.length}`);
  assert.match(lines.join("\n"), /\[a\] approve/);
});

test("RunStatusLine badge color follows phase and stays NO_COLOR-safe", () => {
  const frame = renderTuiToFrame(React.createElement(RunStatusLine, { view: view({ phase: "failed" }) }), { columns: 120, rows: 4 });
  assert.equal(colorAtText(frame, "[ERR]"), resolveTuiColor("status.danger"));
  const mono = withTuiThemeProfile("swarm-monochrome", () =>
    frameText(renderTuiToFrame(React.createElement(RunStatusLine, { view: view({ phase: "verifying" }) }), { columns: 120, rows: 4 }))
  );
  assert.match(mono, /\[RUN\]/);
});
