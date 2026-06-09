import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import { RunBoardSurface } from "./RunBoardSurface.js";
import type { RunBoardSurfaceView } from "./run-board-types.js";
import { workerRowSpans } from "./WorkerRow.js";

test("RunBoardSurface renders worker board attention and result preview", () => {
  const view: RunBoardSurfaceView = {
    title: "Swarm Board",
    objective: "Fix failing tests",
    phase: "waiting-attention",
    focus: "Test Runner",
    meta: {
      repo: "Swarm",
      mode: "auto",
      risk: "workspace-write"
    },
    workers: [
      {
        id: "main",
        label: "Main Swarm",
        role: "main",
        status: "waiting",
        currentAction: "waiting for test result",
        lastEvidence: "routine background poll finished",
        elapsedMs: 52_000,
        owns: [],
        risk: "low",
        canStop: false,
        canRetry: false,
        canTakeBack: false
      },
      {
        id: "worker:test",
        label: "Test Runner",
        role: "test",
        status: "blocked",
        currentAction: "no output from focused test",
        lastEvidence: "npm test -- src/tui/run-board.test.ts",
        elapsedMs: 72_000,
        owns: [],
        risk: "medium",
        canStop: true,
        canRetry: true,
        canTakeBack: false
      }
    ],
    attention: [
      {
        id: "att-1",
        kind: "slow",
        severity: "warning",
        title: "Test Runner may be slow",
        summary: "no output for 72s",
        recommendation: "Wait briefly before stopping.",
        evidence: ["npm test -- src/tui/run-board.test.ts"],
        actions: [{ key: "w", label: "wait" }],
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z"
      }
    ],
    resultPreview: {
      status: "blocked",
      summary: "Patch ready, verification blocked.",
      changedFiles: [],
      checks: [],
      artifacts: [],
      blockers: [],
      confidence: "medium",
      contributors: [],
      risks: [],
      nextActions: []
    }
  };

  const frame = renderTuiToFrame(React.createElement(RunBoardSurface, { view }), { columns: 100, rows: 28 });
  const text = frameText(frame);

  assert.match(text, /WORK/);
  assert.match(text, /Fix failing tests/);
  assert.doesNotMatch(text, /Objective\s+Fix failing tests/);
  assert.doesNotMatch(text, /SWARM OBSERVATORY/);
  assert.doesNotMatch(text, /workspace: Swarm/);
  assert.doesNotMatch(text, /mode: auto/);
  assert.doesNotMatch(text, /risk: workspace-write/);
  assert.doesNotMatch(text, /Status\s+Needs you/);
  assert.doesNotMatch(text, /waiting-attention/);
  assert.doesNotMatch(text, /Focus\s+Test Runner/);
  assert.doesNotMatch(text, /routine background poll finished/);
  assert.match(text, /PROGRESS/);
  assert.match(text, /Test Runner/);
  assert.match(text, /NEEDS YOU/);
  assert.match(text, /Next\s+Wait briefly before stopping\./);
  assert.doesNotMatch(text, /recommend:|activity:/);
  assert.match(text, /RESULT/);
  assert.doesNotMatch(text, /RESULT PREVIEW/);
  assert.doesNotMatch(text, /\[Helpers 2\]/);
  assert.match(text, /\[Stuck 1\]/);
  assert.doesNotMatch(text, /\[Checks 0\/0\]/);
  assert.doesNotMatch(text, /\[Files 0\]/);
  assert.doesNotMatch(text, /\[Approvals 0\]/);
  assert.doesNotMatch(text, /\[Details Enter\]/);
  assert.doesNotMatch(text, /Observatory Enter/);
  assert.doesNotMatch(text, /handoff contract id|lease participant|blackboard claim owner|ASP/);
});

test("WorkerRow hides routine evidence but keeps blocked evidence", () => {
  const routine = workerRowSpans({
    id: "worker:active",
    label: "Code Worker",
    role: "code",
    status: "active",
    currentAction: "editing files",
    lastEvidence: "opened src/tui/run-board/WorkerRow.tsx",
    elapsedMs: 1_000,
    owns: [],
    risk: "low",
    canStop: true,
    canRetry: false,
    canTakeBack: false
  }).map((span) => span.text).join("");
  const blocked = workerRowSpans({
    id: "worker:blocked",
    label: "Test Runner",
    role: "test",
    status: "blocked",
    currentAction: "waiting for output",
    lastEvidence: "npm test produced no output",
    elapsedMs: 1_000,
    owns: [],
    risk: "medium",
    canStop: true,
    canRetry: true,
    canTakeBack: false
  }).map((span) => span.text).join("");

  assert.doesNotMatch(routine, /opened src\/tui\/run-board\/WorkerRow\.tsx/);
  assert.match(blocked, /npm test produced no output/);
});

test("RunBoardSurface keeps the idle footer quiet", () => {
  const frame = renderTuiToFrame(React.createElement(RunBoardSurface, { view: idleView() }), { columns: 100, rows: 16 });
  const text = frameText(frame);

  assert.match(text, /Ask Swarm to review or plan this workspace\./);
  assert.doesNotMatch(text, /explain this workspace/i);
  assert.doesNotMatch(text, /Phase\s+idle/);
  assert.doesNotMatch(text, /PROGRESS/);
  assert.doesNotMatch(text, /No workers yet/);
  assert.doesNotMatch(text, /\[Helpers 0\]/);
  assert.doesNotMatch(text, /\[Blocked 0\]/);
  assert.doesNotMatch(text, /\[Files 0\]/);
  assert.doesNotMatch(text, /\[Checks 0\/0\]/);
  assert.doesNotMatch(text, /\[Approvals 0\]/);
  assert.doesNotMatch(text, /\[Details Enter\]/);
});

test("RunBoardSurface stays bounded across rollout viewports", () => {
  for (const columns of [80, 100, 120, 160]) {
    const frame = renderTuiToFrame(React.createElement(RunBoardSurface, { view: fixtureView() }), { columns, rows: 24 });
    const text = frameText(frame);
    const lines = text.split("\n");

    assert(lines.every((line) => line.length <= columns), `${columns}: expected all rows to fit`);
    assert.match(text, /WORK/);
    assert.doesNotMatch(text, /SWARM OBSERVATORY/);
    assert.match(text, /PROGRESS/);
    assert.match(text, /NEEDS YOU/);
    assert.doesNotMatch(text, /Status\s+Needs you/);
    assert.match(text, /RESULT/);
    assert.doesNotMatch(text, /RESULT PREVIEW/);
    assert.doesNotMatch(text, /\[Helpers 1\]/);
    assert.doesNotMatch(text, /\[Files 1\]/);
    assert.doesNotMatch(text, /\[Checks 0\/1\]/);
    assert.doesNotMatch(text, /waiting-attention|mode: auto|risk: workspace-write|handoff contract id|lease participant|blackboard claim owner|ASP|worker_test/u);
  }
});

test("RunBoardSurface uses product-facing overflow labels", () => {
  const view = fixtureView();
  view.workers = [
    ...view.workers,
    {
      ...view.workers[0]!,
      id: "worker:lint",
      label: "Lint Runner"
    }
  ];
  view.attention = [
    ...view.attention,
    {
      ...view.attention[0]!,
      id: "att-2",
      title: "Lint Runner needs a decision"
    }
  ];

  const frame = renderTuiToFrame(React.createElement(RunBoardSurface, {
    view,
    workerLimit: 1,
    attentionLimit: 1
  }), { columns: 100, rows: 28 });
  const text = frameText(frame);

  assert.match(text, /More updates/);
  assert.match(text, /More requests/);
  assert.doesNotMatch(text, /\+\d/);
  assert.doesNotMatch(text, /more workers|more team activity|more attention items/i);
});

test("RunBoardSurface dispatches attention action clicks", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 100,
    rows: 28,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(RunBoardSurface, {
    view: fixtureView(),
    onAttentionAction(item, action) {
      clicked.push(`${item.id}:${action.key}`);
    }
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "[w]");
  assert(target, "expected wait action to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["att-1:w"]);
  root.unmount();
});

test("RunBoardSurface dispatches worker row and result preview action clicks", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 100,
    rows: 28,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(RunBoardSurface, {
    view: {
      ...fixtureView(),
      resultPreview: {
        ...fixtureView().resultPreview,
        artifacts: ["artifacts/session-row.log"],
        blockers: ["verification blocked"],
        nextActions: ["/diff"]
      }
    },
    onWorkerClick(row) {
      clicked.push(`worker:${row.id}`);
    },
    onResultAction(action) {
      clicked.push(`result:${action.command}`);
    }
  }));

  const frame = root.getFrame();
  assert(frame);
  const workerTarget = findCell(frame, "[WARN] Test Runner");
  assert(workerTarget, "expected worker row to render");
  root.dispatchMouse({ x: workerTarget.x, y: workerTarget.y, button: "left", action: "press" });

  const nextTarget = findCell(root.getFrame()!, "Review changes");
  assert(nextTarget, "expected result next action to render");
  root.dispatchMouse({ x: nextTarget.x, y: nextTarget.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["worker:worker:test", "result:/diff"]);
  const text = frameText(root.getFrame()!);
  assert.doesNotMatch(text, /Blockers\s+verification blocked/);
  assert.doesNotMatch(text, /Artifacts/);
  root.unmount();
});

function fixtureView(): RunBoardSurfaceView {
  return {
    title: "Swarm Board",
    objective: "Fix failing tests",
    phase: "waiting-attention",
    focus: "Test Runner",
    meta: {
      repo: "Swarm",
      mode: "auto",
      risk: "workspace-write"
    },
    workers: [
      {
        id: "worker:test",
        label: "Test Runner",
        role: "test",
        status: "blocked",
        currentAction: "no output from focused test",
        lastEvidence: "npm test -- src/tui/run-board.test.ts",
        elapsedMs: 72_000,
        owns: [],
        risk: "medium",
        canStop: true,
        canRetry: true,
        canTakeBack: false
      }
    ],
    attention: [
      {
        id: "att-1",
        kind: "slow",
        severity: "warning",
        title: "Test Runner may be slow",
        summary: "no output for 72s",
        recommendation: "Wait briefly before stopping.",
        evidence: ["npm test -- src/tui/run-board.test.ts"],
        actions: [{ key: "w", label: "wait" }],
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z"
      }
    ],
    resultPreview: {
      status: "blocked",
      summary: "Patch ready, verification blocked.",
      changedFiles: ["src/tui/run-board/WorkerRow.tsx"],
      checks: [{ command: "npm test", status: "running" }],
      artifacts: [],
      blockers: [],
      confidence: "medium",
      contributors: [],
      risks: [],
      nextActions: []
    }
  };
}

function idleView(): RunBoardSurfaceView {
  return {
    title: "Swarm Board",
    phase: "idle",
    workers: [],
    attention: [],
    resultPreview: {
      status: "empty",
      summary: "Ask Swarm to review or plan this workspace.",
      changedFiles: [],
      checks: [],
      artifacts: [],
      blockers: [],
      confidence: "low",
      contributors: [],
      risks: [],
      nextActions: []
    }
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
