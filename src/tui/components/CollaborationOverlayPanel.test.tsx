import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import { CollaborationOverlayPanel } from "./CollaborationOverlayPanel.js";
import type { CollaborationOverlayView } from "../collaboration-cockpit.js";

test("CollaborationOverlayPanel renders blocked rows first with product labels", () => {
  const frame = renderTuiToFrame(React.createElement(CollaborationOverlayPanel, {
    overlay: overlayFixture(),
    selectedIndex: 0,
    reassign: {
      targetId: "worker-test",
      source: "ownership",
      reason: "Test Runner waiting on npm test",
      risk: "medium",
      policy: "approval-required",
      summary: "Reassign intent for Test Runner"
    }
  }), { columns: 120, rows: 10 });
  const text = frameText(frame);

  assert.match(text, /WORKSPACE CLAIMS/);
  assert.match(text, /> \[blocked\] Test Runner/);
  assert.match(text, /Reassign: Reassign intent for Test Runner \[approval-required\] risk=medium/);
  assert.doesNotMatch(text, /handoff contract id|lease participant|ASP/);
});

test("CollaborationOverlayPanel row click selects through shared handler", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 120,
    rows: 10,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(CollaborationOverlayPanel, {
    overlay: overlayFixture(),
    selectedIndex: 0,
    onRowClick: (row, index) => clicked.push(`${index}:${row.id}`)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "Claim task-1");
  assert(target);
  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["1:claim:task-1"]);
  root.unmount();
});

test("CollaborationOverlayPanel renders active filter without hiding prompt-compatible actions", () => {
  const frame = renderTuiToFrame(React.createElement(CollaborationOverlayPanel, {
    overlay: {
      ...overlayFixture(),
      rows: [],
      emptyLabel: "No workspace claims matched \"reviewer\"."
    },
    filter: "reviewer",
    filtering: true
  }), { columns: 100, rows: 8 });
  const text = frameText(frame);

  assert.match(text, /Enter detail \| r reassign intent \| Esc close/);
  assert.match(text, /Filter: \/reviewer/);
  assert.match(text, /No workspace claims matched "reviewer"\./);
});

function overlayFixture(): CollaborationOverlayView {
  return {
    target: "ownership",
    title: "Workspace Claims",
    emptyLabel: "No blocked workspace claims.",
    actions: ["Enter detail", "r reassign intent", "Esc close"],
    rows: [
      {
        id: "worker-test",
        label: "Test Runner",
        status: "blocked",
        tone: "blocked",
        evidence: "waiting npm test",
        detail: ["Test Runner blocked"],
        actionHint: "r reassign",
        priority: 0
      },
      {
        id: "claim:task-1",
        label: "Claim task-1",
        status: "claimed",
        tone: "ok",
        evidence: "owner Code Worker",
        detail: ["Claim task-1"],
        priority: 5
      }
    ]
  };
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
