import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import {
  SwarmWorkbenchLayout,
  swarmWorkbenchMetrics,
  type SwarmWorkbenchNavigationItem
} from "./SwarmWorkbenchLayout.js";
import { Text } from "../ui.js";

test("swarm workbench metrics choose three columns only for wide non-compact terminals", () => {
  const wide = swarmWorkbenchMetrics({ columns: 160, rows: 32, centerBottomRows: 4 });
  assert.equal(wide.enabled, true);
  assert.equal(wide.leftColumns, 35);
  assert.equal(wide.centerColumns, 87);
  assert.equal(wide.rightColumns, 36);
  assert.equal(swarmWorkbenchMetrics({ columns: 100, rows: 32 }).enabled, false);
  assert.equal(swarmWorkbenchMetrics({ columns: 160, rows: 18 }).enabled, false);
});

test("SwarmWorkbenchLayout renders sidebar, conversation, inspector, and bottom composer", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    subtitle: "Run: Executing  Workers: 1  Files: 2  Approvals: 0",
    headerDetail: "Reading project files...",
    workspace: { path: "E:/Playground/Swarm", git: "main clean", status: "ok" },
    navigation: navigationFixture(),
    sessions: sessionFixture(),
    mode: { title: "Plan & Execute", subtitle: "Plans first, then edits safely", badge: "ACTIVE", tone: "role.gateway" },
    permission: { title: "Ask Before Edit", subtitle: "Swarm asks before risky changes", badge: "SAFE", tone: "status.success" },
    sandbox: { title: "Workspace Write", subtitle: "Can modify this workspace", badge: "RW", tone: "status.success" },
    model: { title: "model", subtitle: "Provider: local-test", badge: "READY", tone: "role.gateway" },
    memory: { title: "Session not started", subtitle: "No saved context yet", tone: "text.muted" },
    tools: toolFixture(),
    workers: workerFixture(),
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Transcript center"),
    renderCenterBottom: () => React.createElement(Text, null, "Ask Swarm prompt")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.match(text, /Swarm >_/);
  assert.match(text, /Workspace/);
  assert.match(text, /Recent Sessions/);
  assert.match(text, /Navigation/);
  assert.match(text, /> Chat \[1\]/);
  assert.match(text, /# Chat/);
  assert.match(text, /Transcript center/);
  assert.match(text, /Mode/);
  assert.match(text, /\[ACTIVE\s+\]/);
  assert.match(text, /\[RW\s+\]/);
  assert.match(text, /Capabilities/);
  assert.match(text, /Ask Swarm prompt/);
  assert.match(text, /\/help/);
  assert.match(text, /PgUp\/PgDn scroll/);
  assert.doesNotMatch(text, /tasks:0\/0|approvals:1|cache:WARM/);
});

test("SwarmWorkbenchLayout disables side rails on narrow terminals", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 90,
    rows: 24,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "No active tasks" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Only primary surface"),
    renderCenterBottom: () => React.createElement(Text, null, "Composer")
  }), { columns: 90, rows: 24 });
  const text = frameText(frame);

  assert.match(text, /Only primary surface/);
  assert.match(text, /Composer/);
  assert.doesNotMatch(text, /Recent Sessions/);
});

test("SwarmWorkbenchLayout passes actual center dimensions to render props", () => {
  const contentInputs: Array<{ rows: number; columns: number }> = [];
  const bottomInputs: Array<{ rows: number; columns: number }> = [];
  renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: sessionFixture(),
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "No active tasks" },
    tools: toolFixture(),
    workers: workerFixture(),
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: (input) => {
      contentInputs.push(input);
      return React.createElement(Text, null, `${input.rows}x${input.columns}`);
    },
    renderCenterBottom: (input) => {
      bottomInputs.push(input);
      return React.createElement(Text, null, `${input.rows}x${input.columns}`);
    }
  }), { columns: 160, rows: 32 });

  assert.deepEqual(contentInputs, [{ rows: 21, columns: 83 }]);
  assert.deepEqual(bottomInputs, [{ rows: 4, columns: 83 }]);
});

test("SwarmWorkbenchLayout navigation rows are clickable", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 160,
    rows: 32,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: sessionFixture(),
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "No active tasks" },
    tools: toolFixture(),
    workers: workerFixture(),
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Transcript center"),
    renderCenterBottom: () => React.createElement(Text, null, "Composer"),
    onNavigate: (id: string) => clicked.push(id)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "Trace");
  assert(target);
  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["trace"]);
  root.unmount();
});

function navigationFixture(): SwarmWorkbenchNavigationItem[] {
  return [
    { id: "chat", label: "Chat", shortcut: "1", active: true },
    { id: "plan", label: "Plan", shortcut: "2" },
    { id: "activity", label: "Activity", shortcut: "3" },
    { id: "output", label: "Output", shortcut: "4" },
    { id: "sessions", label: "Sessions", shortcut: "5" },
    { id: "workers", label: "Workers", shortcut: "6" },
    { id: "trace", label: "Trace", shortcut: "7" },
    { id: "board", label: "Board", shortcut: "8" }
  ];
}

function sessionFixture(): React.ComponentProps<typeof SwarmWorkbenchLayout>["sessions"] {
  return [
    { id: "session-1", title: "Build workbench", age: "2m", active: true },
    { id: "session-2", title: "Review tests", age: "8m" }
  ];
}

function toolFixture(): React.ComponentProps<typeof SwarmWorkbenchLayout>["tools"] {
  return [
    { name: "Approvals", status: "1 pending", tone: "status.pending", active: true },
    { name: "LSP", status: "Ready", tone: "status.success", active: true }
  ];
}

function workerFixture(): React.ComponentProps<typeof SwarmWorkbenchLayout>["workers"] {
  return [
    { id: "worker-1", label: "Planner", status: "running", tone: "status.running" }
  ];
}

function footerFixture(): React.ComponentProps<typeof SwarmWorkbenchLayout>["footer"] {
  return [
    { key: "help", label: "/help", tone: "brand.focus" },
    { key: "continue", label: "/continue", tone: "brand.focus" },
    { key: "memory", label: "/memory", tone: "brand.focus" },
    { key: "scroll", label: "PgUp/PgDn scroll", tone: "text.muted" },
    { key: "search", label: "/ search", tone: "text.muted" },
    { key: "details", label: "Ctrl+O details", tone: "text.muted" }
  ];
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
