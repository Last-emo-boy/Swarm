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
    title: "Board",
    subtitle: "1 active tasks · 1 workers · 0 approvals",
    headerDetail: "Open work stays here. Reply below to steer the selected task.",
    workspace: { path: "Swarm", git: "lease: workspace; E:/Playground/Swarm", status: "active" },
    navigation: navigationFixture(),
    sessions: sessionFixture(),
    mode: { title: "Plan & Execute", subtitle: "Plans first, then edits safely", badge: "ACTIVE", tone: "role.gateway" },
    permission: { title: "Ask Before Edit", subtitle: "Swarm asks before risky changes", badge: "SAFE", tone: "status.success" },
    sandbox: { title: "Workspace Write", subtitle: "Can modify this workspace", badge: "RW", tone: "status.success" },
    model: { title: "model", subtitle: "Provider: local-test", badge: "READY", tone: "role.gateway" },
    memory: { title: "Session not started", subtitle: "No saved context yet", tone: "text.muted" },
    activity: { title: "1 active · 0 blocked", subtitle: "No activity yet", badge: "READY", tone: "status.success" },
    tools: toolFixture(),
    workers: workerFixture(),
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Transcript center"),
    renderCenterBottom: () => React.createElement(Text, null, "Ask Swarm prompt")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.doesNotMatch(text, /Swarm >_/);
  assert.doesNotMatch(text, /Local Agent Workspace/);
  assert.doesNotMatch(text, /●/);
  assert.doesNotMatch(text, /Inbox/);
  assert.doesNotMatch(text, /Cases/);
  assert.doesNotMatch(text, /Cases -/);
  assert.doesNotMatch(text, /Workspace -/);
  assert.doesNotMatch(text, /Navigation/);
  assert.doesNotMatch(text, /View all cases/);
  assert.match(text, /> Chat/);
  assert.equal(occurrences(text, "Chat"), 1);
  assert.doesNotMatch(text, /Result/);
  assert.doesNotMatch(text, /Details/);
  assert.doesNotMatch(text, /Logs/);
  assert.doesNotMatch(text, /Chat \[1\]|Result \[2\]|Details \[3\]|Logs \[4\]/);
  assert.match(text, /Build workbench needs you/);
  assert.doesNotMatch(text, /Build workbench 2m/);
  assert.doesNotMatch(text, /needs 1/);
  assert.doesNotMatch(text, /!1/);
  assert.doesNotMatch(text, /active Swarm/);
  assert.doesNotMatch(text, /review no workspace/);
  assert.match(text, /Board/);
  assert.doesNotMatch(text, /# Board/);
  assert.match(text, /Working/);
  assert.doesNotMatch(text, /1 active tasks|1 active task|1 workers|1 worker/);
  assert.doesNotMatch(text, /0 approvals/);
  assert.match(text, /Transcript center/);
  assert.doesNotMatch(text, /Open work stays here|Reply below/);
  assert.doesNotMatch(text, /Status/);
  assert.doesNotMatch(text, /Mode/);
  assert.doesNotMatch(text, /Plan & Execute/);
  assert.doesNotMatch(text, /Active helpers/);
  assert.doesNotMatch(text, /Planner/);
  assert.doesNotMatch(text, /Planner\s+Running/);
  assert.doesNotMatch(text, /# Planner/);
  assert.doesNotMatch(text, /Tools/);
  assert.match(text, /Needs approval/);
  assert.doesNotMatch(text, /Approval pending/);
  assert.doesNotMatch(text, /Approvals 1 pending/);
  assert.doesNotMatch(text, /Access/);
  assert.doesNotMatch(text, /Agent -/);
  assert.doesNotMatch(text, /\[RW\s+\]/);
  assert.doesNotMatch(text, /Workspace Write/);
  assert.doesNotMatch(text, /model\s+Provider: local-test/);
  assert.doesNotMatch(text, /lease: workspace/);
  assert.doesNotMatch(text, /Runtime/);
  assert.doesNotMatch(text, /Selected Lease/);
  assert.doesNotMatch(text, /Tasks \[|Workers \[|Activity \[|Output \[|Skills \[|Automations \[/);
  assert.doesNotMatch(text, /Skills 3 ready|Automations|LSP/);
  assert.doesNotMatch(text, /Skills & Automations/);
  assert.doesNotMatch(text, /Activity Summary/);
  assert.match(text, /Ask Swarm prompt/);
  assert.doesNotMatch(text, /Type a request/);
  assert.doesNotMatch(text, /\/help|\/continue|\/memory|PgUp\/PgDn scroll|\/ search/);
  assert.doesNotMatch(text, /tasks:0\/0|approvals:1|cache:WARM/);
});

test("SwarmWorkbenchLayout keeps attention-worthy status visible", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    activity: { title: "2 active · 1 blocked", subtitle: "Reviewer is running", badge: "RISK", tone: "status.warning" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Composer")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.doesNotMatch(text, /Status/);
  assert.match(text, /Blocked/);
  assert.doesNotMatch(text, /2 active · 1 blocked/);
  assert.doesNotMatch(text, /\[RISK\s+\]/);
  assert.doesNotMatch(text, /Reviewer is running/);
});

test("SwarmWorkbenchLayout hides routine tool activity but keeps pending work visible", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    activity: { title: "Ready", badge: "READY" },
    tools: [
      { name: "Automations", status: "Running", tone: "status.running", active: true },
      { name: "Approvals", status: "1 pending", tone: "status.pending", active: true }
    ],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Composer")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.doesNotMatch(text, /Tools/);
  assert.match(text, /Needs approval/);
  assert.doesNotMatch(text, /Approval pending/);
  assert.doesNotMatch(text, /Approvals 1 pending/);
  assert.doesNotMatch(text, /Automations/);
});

test("SwarmWorkbenchLayout disables side rails on narrow terminals", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 90,
    rows: 24,
    version: "0.1.0",
    title: "Board",
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
  assert.doesNotMatch(text, /Cases/);
});

test("SwarmWorkbenchLayout keeps empty sidebar sections quiet", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    subtitle: "Run: Waiting",
    headerDetail: "Waiting for reviewer confirmation",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    activity: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.doesNotMatch(text, /Inbox/);
  assert.match(text, /> Chat/);
  assert.doesNotMatch(text, /Result/);
  assert.doesNotMatch(text, /Details/);
  assert.doesNotMatch(text, /Logs/);
  assert.doesNotMatch(text, /Chat \[1\]|Result \[2\]|Details \[3\]|Logs \[4\]/);
  assert.doesNotMatch(text, /Navigation|Workspace -|Cases|\(none\)|View all cases|No checkpoint yet|Ready|Run: Waiting|Waiting for reviewer confirmation/);
});

test("SwarmWorkbenchLayout hides internal workspace meta but keeps product-facing notes", () => {
  const internal = frameText(renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm", git: "checkpoint before-polish", status: "active" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 }));
  assert.doesNotMatch(internal, /checkpoint before-polish/);
  assert.doesNotMatch(internal, /Workspace -/);

  const visible = frameText(renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm", git: "branch main clean", status: "active" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 }));
  assert.match(visible, /Workspace/);
  assert.match(visible, /branch main clean/);

  const missing = frameText(renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "no workspace" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 }));
  assert.match(missing, /Workspace/);
  assert.match(missing, /no workspace/);
});

test("SwarmWorkbenchLayout keeps only attention-worthy case metadata", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [
      { id: "case-active", title: "Routine active case", age: "1m", badge: "active", subtitle: "Swarm", attention: 1, active: true },
      { id: "case-failed", title: "Broken release", age: "4m", badge: "failed", subtitle: "release workspace", tone: "status.danger" }
    ],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.match(text, /Routine active case needs you/);
  assert.doesNotMatch(text, /Routine active case 1m/);
  assert.doesNotMatch(text, /needs 1/);
  assert.doesNotMatch(text, /!1/);
  assert.doesNotMatch(text, /active Swarm/);
  assert.match(text, /Broken release 4m/);
  assert.match(text, /failed release workspace/);
});

test("SwarmWorkbenchLayout keeps case overflow hint compact", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [
      ...sessionFixture(),
      { id: "case-3", title: "Polish result", age: "7m" },
      { id: "case-4", title: "Review shell", age: "6m" },
      { id: "case-5", title: "Update docs", age: "5m" },
      { id: "case-6", title: "Check metrics", age: "4m" },
      { id: "case-7", title: "Hidden overflow", age: "3m" }
    ],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.match(text, /1 more/);
  assert.doesNotMatch(text, /View all cases/);
  assert.doesNotMatch(text, /Hidden overflow/);
});

test("SwarmWorkbenchLayout hides routine footer hints but keeps real footer status", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: [
      ...footerFixture(),
      { key: "sync", label: "Sync pending", tone: "status.warning" }
    ],
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Composer")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.doesNotMatch(text, /Type a request/);
  assert.doesNotMatch(text, /Ctrl\+O details/);
  assert.match(text, /Sync pending/);
});

test("SwarmWorkbenchLayout keeps non-default mode visible", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Chat", subtitle: "Answers without starting a run", badge: "ACTIVE", tone: "brand.focus" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Composer")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.match(text, /Mode/);
  assert.match(text, /Chat\s+\[ACTIVE\s+\]/);
});

test("SwarmWorkbenchLayout keeps attention-worthy access setup details visible", () => {
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Chat",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "YOLO", subtitle: "Edits can run without asking", badge: "RISK", tone: "status.warning" },
    sandbox: { title: "Read Only", subtitle: "Can inspect files only", badge: "RO", tone: "status.pending" },
    model: { title: "Model setup needed", subtitle: "Choose provider and model", badge: "SETUP", tone: "status.pending" },
    memory: { title: "Ready" },
    tools: [],
    workers: [],
    footer: footerFixture(),
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Text, null, "Ask Swarm"),
    renderCenterBottom: () => React.createElement(Text, null, "Type a request")
  }), { columns: 160, rows: 32 });
  const text = frameText(frame);

  assert.match(text, /Access/);
  assert.match(text, /YOLO/);
  assert.match(text, /\[RISK\s+\]/);
  assert.match(text, /Workspace/);
  assert.match(text, /Read Only/);
  assert.match(text, /Agent/);
  assert.doesNotMatch(text, /Agent -/);
  assert.match(text, /Model setup needed/);
});

test("SwarmWorkbenchLayout passes actual center dimensions to render props", () => {
  const contentInputs: Array<{ rows: number; columns: number }> = [];
  const bottomInputs: Array<{ rows: number; columns: number }> = [];
  renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Board",
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

  assert.deepEqual(contentInputs, [{ rows: 24, columns: 83 }]);
  assert.deepEqual(bottomInputs, [{ rows: 4, columns: 83 }]);
});

test("SwarmWorkbenchLayout gives empty right rail space back to the center", () => {
  const contentInputs: Array<{ rows: number; columns: number }> = [];
  const bottomInputs: Array<{ rows: number; columns: number }> = [];
  const frame = renderTuiToFrame(React.createElement(SwarmWorkbenchLayout, {
    columns: 160,
    rows: 32,
    version: "0.1.0",
    title: "Board",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: navigationFixture(),
    sessions: [],
    mode: { title: "Plan & Execute" },
    permission: { title: "Ask" },
    sandbox: { title: "Workspace Write" },
    model: { title: "local-test/model" },
    memory: { title: "Ready" },
    activity: { title: "Ready", badge: "READY" },
    tools: [],
    workers: [],
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
  const text = frameText(frame);

  assert.deepEqual(contentInputs, [{ rows: 24, columns: 120 }]);
  assert.deepEqual(bottomInputs, [{ rows: 4, columns: 120 }]);
  assert.doesNotMatch(text, /Status|Access|Workspace Write|Agent/);
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
    title: "Board",
    workspace: { path: "E:/Playground/Swarm" },
    navigation: advancedNavigationFixture(),
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

test("SwarmWorkbenchLayout case rows are clickable", () => {
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
    title: "Board",
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
    onSelectSession: (id: string) => clicked.push(id)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "Review tests");
  assert(target);
  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["case-2"]);
  root.unmount();
});

function navigationFixture(): SwarmWorkbenchNavigationItem[] {
  return [
    { id: "chat", label: "Chat", shortcut: "1", active: true },
    { id: "result", label: "Result", shortcut: "2" },
    { id: "observatory", label: "Details", shortcut: "3" },
    { id: "debug", label: "Logs", shortcut: "4" }
  ];
}

function advancedNavigationFixture(): SwarmWorkbenchNavigationItem[] {
  return [
    ...navigationFixture(),
    { id: "trace", label: "Trace", shortcut: "8", active: true }
  ];
}

function sessionFixture(): React.ComponentProps<typeof SwarmWorkbenchLayout>["sessions"] {
  return [
    { id: "case-1", title: "Build workbench", age: "2m", badge: "active", subtitle: "Swarm", tone: "status.running", attention: 1, active: true },
    { id: "case-2", title: "Review tests", age: "8m", badge: "review", subtitle: "no workspace", tone: "status.warning" }
  ];
}

function toolFixture(): React.ComponentProps<typeof SwarmWorkbenchLayout>["tools"] {
  return [
    { name: "Skills", status: "3 ready", tone: "status.success", active: true },
    { name: "Automations", status: "Idle", tone: "text.muted", active: false },
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
    { key: "prompt", label: "Type a request", tone: "text.muted" },
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

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
