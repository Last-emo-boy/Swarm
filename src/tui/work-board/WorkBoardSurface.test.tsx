import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import { WorkBoardSurface } from "./WorkBoardSurface.js";
import type { WorkBoardSurfaceView } from "./work-board-types.js";

test("WorkBoardSurface renders board columns and selected task thread", () => {
  const frame = renderTuiToFrame(React.createElement(WorkBoardSurface, {
    view: fixtureView(),
    rows: 24,
    columns: 120
  }), { rows: 24, columns: 120 });
  const text = frameText(frame);

  assert.match(text, /WORK/);
  assert.doesNotMatch(text, /OBSERVATORY/);
  assert.match(text, /Running 1/);
  assert.match(text, /Blocked 1/);
  assert.doesNotMatch(text, /\bBacklog\b|\bReview\b|\bDone\b/);
  assert.match(text, /T-101/);
  assert.match(text, /Objective: Build Board-first workspace/);
  assert.match(text, /1 active task/);
  assert.doesNotMatch(text, /1 helper/);
  assert.doesNotMatch(text, /Assignee:|Risk:/);
  assert.doesNotMatch(text, /activity:|task:T-102/);
  assert.doesNotMatch(text, /0 approvals|Backlog 0|Review 0|Done 0|\(empty\)|No active detail|1 automation/i);
  assert.doesNotMatch(text, /claim owner|protocol|ASP|heartbeat/u);
});

test("WorkBoardSurface stays bounded in compact viewports", () => {
  for (const columns of [80, 100, 160]) {
    const frame = renderTuiToFrame(React.createElement(WorkBoardSurface, {
      view: fixtureView(),
      rows: 20,
      columns
    }), { rows: 20, columns });
    const lines = frameText(frame).split("\n");

    assert(lines.every((line) => line.length <= columns), `${columns}: expected rows to fit`);
    assert.match(lines.join("\n"), /WORK/);
    assert.doesNotMatch(lines.join("\n"), /OBSERVATORY/);
  }
});

test("WorkBoardSurface keeps the empty work view quiet", () => {
  const frame = renderTuiToFrame(React.createElement(WorkBoardSurface, {
    view: emptyFixtureView(),
    rows: 12,
    columns: 100
  }), { rows: 12, columns: 100 });
  const text = frameText(frame);

  assert.match(text, /WORK/);
  assert.doesNotMatch(text, /OBSERVATORY/);
  assert.match(text, /Ask Swarm to review or plan this workspace\./);
  assert.doesNotMatch(text, /explain this workspace/i);
  assert.doesNotMatch(text, /Nothing to review yet|Type an objective below|details appear here/i);
  assert.doesNotMatch(text, /0 active tasks|0 workers|0 approvals|team activity|blockers|checks|delivery evidence|activity:/i);
});

function fixtureView(): WorkBoardSurfaceView {
  return {
    title: "Board",
    subtitle: "1 active tasks · 1 workers · 0 approvals",
    empty: false,
    summary: {
      activeTasks: 1,
      workers: 1,
      approvals: 0,
      blockers: 1,
      changedFiles: 2,
      checks: 1,
      automations: 1,
      skills: 3,
      activity: ["task:T-102 Resolve layout decision"]
    },
    columns: [
      { id: "backlog", title: "Backlog", count: 0, items: [] },
      {
        id: "running",
        title: "Running",
        count: 1,
        items: [{ id: "T-101", title: "T-101", status: "running", subtitle: "Board-first workspace", owner: "Ada", meta: ["session-101"], tone: "running" }]
      },
      { id: "review", title: "Review", count: 0, items: [] },
      { id: "done", title: "Done", count: 0, items: [] },
      {
        id: "blocked",
        title: "Blocked",
        count: 1,
        items: [{ id: "T-102", title: "T-102", status: "blocked", subtitle: "Need approval", owner: "Reviewer", meta: ["layout"], tone: "warning" }]
      }
    ],
    selected: {
      id: "T-101",
      title: "T-101",
      status: "running",
      objective: "Build Board-first workspace",
      assignee: "Ada",
      risk: "Med",
      source: "user",
      plan: ["Split board projection", "Render columns"],
      timeline: ["Ada: running"],
      changedFiles: ["src/tui/SwarmChatApp.tsx"],
      checks: ["npm run check [recorded]"],
      comments: ["user: keep chat as entry"],
      actions: ["/continue"]
    }
  };
}

function emptyFixtureView(): WorkBoardSurfaceView {
  return {
    title: "Board",
    subtitle: "0 active tasks · 0 workers · 0 approvals",
    empty: true,
    summary: {
      activeTasks: 0,
      workers: 0,
      approvals: 0,
      blockers: 0,
      changedFiles: 0,
      checks: 0,
      automations: 0,
      skills: 0,
      activity: []
    },
    columns: [],
    selected: undefined
  };
}
