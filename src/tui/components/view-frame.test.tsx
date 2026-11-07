import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { Text } from "../ui.js";
import { renderTuiToFrame } from "../renderer/testing.js";
import { assertFrameHasNoOverflow, createFrameSnapshot } from "../renderer/frame-snapshot.js";
import { resolveTuiColor } from "../theme.js";
import { ViewFrame, viewBodyRows } from "./ViewFrame.js";

const lines = (frame: ReturnType<typeof renderTuiToFrame>) => frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd());

test("a view is a title with its summary, a rule, the body, and the keys that work there", () => {
  const body = Array.from({ length: 20 }, (_, index) => `row ${index + 1}`);
  const rows = 10;
  const frame = renderTuiToFrame(React.createElement(ViewFrame, {
    title: "Trace",
    summary: "12 actions",
    columns: 60,
    height: rows,
    keys: "↑↓ select · Enter details · Esc back",
    children: body.slice(0, viewBodyRows(rows)).map((line) => React.createElement(Text, { key: line }, line))
  }), { columns: 60, rows });
  const shown = lines(frame);

  assert.equal(viewBodyRows(rows), 7, "title, rule and key row take three rows");
  assert.equal(shown[0], " Trace  12 actions");
  assert.match(shown[1] ?? "", /^─{60}$/);
  assert.deepEqual(shown.slice(2, 9), body.slice(0, 7).map((line) => ` ${line}`));
  assert.equal(shown[9], " ↑↓ select · Enter details · Esc back");
  assert.equal(frame.screen.cells[0]![1]!.style.color, resolveTuiColor("brand.focus"));
  assert.deepEqual(assertFrameHasNoOverflow(createFrameSnapshot(frame)), []);
});

test("a decision that waits takes the key row's place, so it shows on top of any view", () => {
  const card = React.createElement(Text, {}, "? Run a command  ls src");
  const frame = renderTuiToFrame(React.createElement(ViewFrame, {
    title: "Sessions",
    columns: 50,
    height: 8,
    keys: "Esc back · / command",
    bottom: card,
    bottomRows: 3,
    children: React.createElement(Text, {}, "session-1 [completed]")
  }), { columns: 50, rows: 8 });
  const shown = lines(frame);

  assert.equal(viewBodyRows(8, 3), 3);
  assert.equal(shown[5], "? Run a command  ls src");
  assert(!shown.some((line) => line.includes("Esc back")), "the keys give way to the card");
});
