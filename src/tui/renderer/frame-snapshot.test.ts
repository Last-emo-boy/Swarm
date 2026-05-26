import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box } from "./components/Box.js";
import { Text } from "./components/Text.js";
import { assertFrameHasNoOverflow, createFrameSnapshot, diffFrameSnapshotCells } from "./frame-snapshot.js";
import { renderTuiToFrame } from "./testing.js";

test("frame snapshots include dimensions cursor metadata and overflow checks", () => {
  const frame = renderTuiToFrame(
    React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, null, "snapshot"),
      React.createElement(Text, null, "gate")
    ),
    { columns: 16, rows: 4 }
  );
  const snapshot = createFrameSnapshot(frame);
  assert.equal(snapshot.width, 16);
  assert.equal(snapshot.height, 4);
  assert.equal(snapshot.metadata.renderer, "dom-renderer");
  assert.deepEqual(assertFrameHasNoOverflow(snapshot), []);
  assert.deepEqual(snapshot.lines.slice(0, 2), ["snapshot", "gate"]);
  assert.equal(snapshot.cells[0]?.[0]?.char, "s");
});

test("frame snapshots compare cell-level changes", () => {
  const previous = createFrameSnapshot(renderTuiToFrame(
    React.createElement(Box, null, React.createElement(Text, { color: "green" }, "alpha")),
    { columns: 8, rows: 2 }
  ));
  const next = createFrameSnapshot(renderTuiToFrame(
    React.createElement(Box, null, React.createElement(Text, { color: "green" }, "alps")),
    { columns: 8, rows: 2 }
  ));

  const changes = diffFrameSnapshotCells(previous, next);
  assert.deepEqual(changes.map((change) => [change.row, change.column, change.previous?.char, change.next?.char]), [
    [0, 3, "h", "s"],
    [0, 4, "a", " "]
  ]);
});
