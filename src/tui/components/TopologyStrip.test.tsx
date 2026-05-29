import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import { stripAnsi } from "../renderer/ansi.js";
import { TopologyStrip } from "./TopologyStrip.js";
import { buildTopologyStripModel } from "../collaboration-cockpit.js";
import { withTuiThemeProfile } from "../theme.js";

test("TopologyStrip renders full, abbreviated, and token layouts", () => {
  const model = buildTopologyStripModel({
    approvalsPending: 2,
    policyMode: "approval",
    sandboxMode: "workspace-write"
  });
  const full = plain(React.createElement(TopologyStrip, { model, columns: 140 }));
  assert.match(full, /BOARD/);
  assert.match(full, /SQ:0\(active\)/);
  assert.match(full, /OW:0\(blocked\)/);
  assert.match(full, /AP:2\(wait\)/);
  assert.match(full, /POLICY:ASK/);

  const abbr = plain(React.createElement(TopologyStrip, { model, columns: 108 }));
  assert.match(abbr, /POL:ASK/);
  assert.doesNotMatch(abbr, /POLICY/);

  const token = plain(React.createElement(TopologyStrip, { model, columns: 80 }));
  assert.match(token, /BD/);
  assert.match(token, /SQ0/);
  assert.match(token, /OW0/);
  assert.match(token, /AP2/);
});

test("TopologyStrip keeps monochrome status readable", () => {
  const model = buildTopologyStripModel({
    approvalsPending: 1,
    policyMode: "auto"
  });
  const output = withTuiThemeProfile("swarm-monochrome", () => plain(React.createElement(TopologyStrip, { model, columns: 80 })));
  assert.match(output, /BD/);
  assert.match(output, /AP1/);
  assert.match(output, /POL:AUTO/);
});

test("TopologyStrip omits empty chrome without a model", () => {
  const output = plain(React.createElement(TopologyStrip, { columns: 120 }));
  assert.equal(output.trim(), "");
});

test("TopologyStrip dispatches mouse clicks to the shared open handler", () => {
  const opened: string[] = [];
  const model = buildTopologyStripModel({
    approvalsPending: 1,
    policyMode: "approval"
  });
  const root = createTuiRoot({
    columns: 120,
    rows: 4,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(TopologyStrip, {
    model,
    columns: 120,
    onOpen: (target) => opened.push(target)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "OW:0");
  assert(target, "expected ownership token to render");
  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(opened, ["ownership"]);
  root.unmount();
});

test("TopologyStrip mouse handlers are inert when terminal mouse is disabled", () => {
  const opened: string[] = [];
  const model = buildTopologyStripModel({
    approvalsPending: 1,
    policyMode: "approval"
  });
  const root = createTuiRoot({
    columns: 120,
    rows: 4,
    terminalCapabilities: { mouse: false }
  });
  root.render(React.createElement(TopologyStrip, {
    model,
    columns: 120,
    onOpen: (target) => opened.push(target)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "OW:0");
  assert(target, "expected ownership token to render");
  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(opened, []);
  root.unmount();
});

function plain(element: React.ReactElement): string {
  return stripAnsi(frameText(renderTuiToFrame(element, { columns: 160, rows: 4 })));
}

function findCell(frame: NonNullable<ReturnType<ReturnType<typeof createTuiRoot>["getFrame"]>>, needle: string): { x: number; y: number } | undefined {
  for (let y = 0; y < frame.screen.height; y += 1) {
    const line = frame.screen.cells[y]?.map((cell) => cell.char).join("") ?? "";
    const x = line.indexOf(needle);
    if (x >= 0) {
      return { x, y };
    }
  }
  return undefined;
}
