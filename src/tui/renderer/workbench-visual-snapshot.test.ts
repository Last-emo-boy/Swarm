import { strict as assert } from "node:assert";
import React from "react";
import test from "node:test";
import { Box, Text } from "../ui.js";
import type { ResultCard as ResultCardData } from "../../runtime/result-card.js";
import type { TuiActionRow } from "../action-log.js";
import { ChatInputArea } from "../ChatInputArea.js";
import { ActionLog } from "../components/ActionLog.js";
import { InspectorPane } from "../components/InspectorPane.js";
import { ResultCard } from "../components/ResultCard.js";
import { SwarmWorkbenchLayout, swarmWorkbenchMetrics } from "../components/SwarmWorkbenchLayout.js";
import { resolveTuiColor } from "../theme.js";
import type { TuiColorRef } from "../theme.js";
import { createFrameSnapshot, assertFrameHasNoOverflow, type TuiFrameSnapshot } from "./frame-snapshot.js";
import { renderTuiToFrame } from "./testing.js";

const WORKBENCH_VIEWPORTS = [
  { columns: 80, rows: 24, density: "compact" },
  { columns: 100, rows: 30, density: "default" },
  { columns: 120, rows: 36, density: "comfortable" },
  { columns: 160, rows: 44, density: "comfortable" }
] as const;

test("workbench visual snapshot covers result approval inspector action log and prompt across viewports", () => {
  const snapshots = WORKBENCH_VIEWPORTS.map((viewport) => ({
    viewport,
    snapshot: renderWorkbenchSnapshot(viewport)
  }));

  for (const { viewport, snapshot } of snapshots) {
    assert.deepEqual(assertFrameHasNoOverflow(snapshot), [], `${viewport.columns}x${viewport.rows} overflow`);
    const text = snapshotText(snapshot);
    assert.match(text, /Swarm/);
    assert.match(text, /RESULT/);
    assert.doesNotMatch(text, /TRAIL/);
    if (viewport.columns >= 120) {
      assert.match(text, /approval|Approval|DECISION|Reassign/);
    }
    if (viewport.columns >= 132) {
      assert.match(text, /Blocked/);
      assert.doesNotMatch(text, /2 active · 1 blocked/);
      assert.doesNotMatch(text, /Status/);
      assert.doesNotMatch(text, /Reviewer is running/);
      assert.doesNotMatch(text, /Active helpers/);
      assert.doesNotMatch(text, /Tools/);
      assert.match(text, /ACTION LOG/);
      assert.doesNotMatch(text, /Mode|Plan & Execute|Workspace Write|Provider: openai|kimi-k2\.6/);
    }
    assert.match(text, /Ask Swarm/);
    assert.doesNotMatch(text, /checkpoint before-tui-polish/);
    assert.doesNotMatch(text, /Run: Executing|Helpers: 2|Files: 2|Approvals: 1/);
    assert.doesNotMatch(text, /Overview|Blackboard|Attempts|Active Tools|Model \/ Provider|TOPOLOGY|OWNERSHIP|Skills & Automations|Workers:|Automations/);

    assert.doesNotMatch(text, /Swarm >_/);
    assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "Result"), "Result")?.color, resolveTuiColor("brand.focus"));
    if (text.includes("CHECKS")) {
      assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "CHECKS"), "CHECKS")?.color, resolveTuiColor("status.danger"));
    }
    if (text.includes("TARGET")) {
      assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "TARGET"), "TARGET")?.color, resolveTuiColor("role.gateway"));
    }
    if (viewport.columns >= 132) {
      assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "ACTION LOG"), "ACTION LOG")?.color, resolveTuiColor("text.primary"));
    }
  }

  const wideSnapshot = snapshots[3]!.snapshot;
  assert.match(wideSnapshot.lines.join("\n"), /Ctrl\+O details/);
  assert.doesNotMatch(wideSnapshot.lines.join("\n"), /\/help|\/continue|\/memory|PgUp\/PgDn scroll|\/ search/);
  assert.doesNotMatch(wideSnapshot.lines.join("\n"), /\[cache:HIT 81%\]/);
  assert(colorCount(wideSnapshot) >= 6, "wide workbench should keep multiple semantic accents visible");
});

function renderWorkbenchSnapshot(input: typeof WORKBENCH_VIEWPORTS[number]): TuiFrameSnapshot {
  return createFrameSnapshot(renderTuiToFrame(workbenchFixture(input), {
    columns: input.columns,
    rows: input.rows
  }));
}

function workbenchFixture(input: typeof WORKBENCH_VIEWPORTS[number]): React.ReactElement {
  const compact = input.density === "compact";
  const metrics = swarmWorkbenchMetrics({ columns: input.columns, rows: input.rows, centerBottomRows: 4 });
  const primaryColumns = metrics.centerInnerColumns;
  const resultCard = React.createElement(ResultCard, { card: resultCardFixture(), detailHint: "Ctrl+O details", density: input.density });
  const currentAction = React.createElement(Box, { flexDirection: "column", width: "100%" },
    React.createElement(Text, { color: resolveTuiColor("status.pending"), wrap: "truncate" }, "[ASK] approval needed: run focused TUI renderer tests"),
    React.createElement(Text, { color: resolveTuiColor("text.muted"), wrap: "truncate" }, "Waiting for reviewer confirmation")
  );
  const inspector = React.createElement(InspectorPane, {
    title: "Command Output",
    sessionId: "session-workbench-visual",
    route: "coding",
    selected: "lines 1-5 / 5",
    tabs: ["output", "diff", "debug"],
    density: input.density,
    content: [
      "Command: npm run check",
      "stdout: 93 tests passed",
      "stderr: none",
      "Artifact: E:/Playground/Swarm/.swarm/reports/tui-workbench.report.json",
      "+added semantic snapshot coverage",
      "-removed single-color fallback"
    ].join("\n")
  });
  const actionLog = React.createElement(ActionLog, {
    rows: actionRowsFixture(),
    height: compact ? 4 : 8,
    columns: compact ? input.columns - 2 : primaryColumns - 2,
    scrollOffset: 0,
    onScrollOffsetChange: () => undefined,
    motionFrame: 1,
    selectedIndex: 1
  });
  const primary = React.createElement(Box, { flexDirection: "column", width: "100%", flexGrow: 1, flexShrink: 1, overflow: "hidden" },
    resultCard,
    compact ? inspector : actionLog
  );
  const commandFooterItems = [
    { key: "prompt", label: "Type a request", tone: "text.muted" as TuiColorRef },
    { key: "details", label: "Ctrl+O details", tone: "text.muted" as TuiColorRef }
  ];
  return React.createElement(SwarmWorkbenchLayout, {
    columns: input.columns,
    rows: input.rows,
    version: "0.1.0",
    title: "Result",
    subtitle: "Run: Executing  Helpers: 2  Files: 2  Approvals: 1",
    headerDetail: "Waiting for reviewer confirmation",
    workspace: { path: "E:/Playground/Swarm", git: "checkpoint before-tui-polish", status: "running" },
    navigation: [
      { id: "chat", label: "Chat", shortcut: "1", active: false },
      { id: "plan", label: "Result", shortcut: "2", active: true },
      { id: "board", label: "Details", shortcut: "3", active: false },
      { id: "trace", label: "Logs", shortcut: "4", active: false }
    ],
    sessions: [
      { id: "session-workbench-visual", title: "TUI workbench polish", age: "now", status: "running", active: true },
      { id: "session-review", title: "Review visual gates", age: "8m", status: "completed" }
    ],
    mode: { title: "Plan & Execute", subtitle: "Plans first, then edits safely", badge: "ACTIVE", tone: "role.gateway" },
    permission: { title: "YOLO", subtitle: "Edits can run without asking", badge: "RISK", tone: "status.danger" },
    sandbox: { title: "Workspace Write", subtitle: "Can modify this workspace", badge: "RW", tone: "status.success" },
    model: { title: "kimi-k2.6", subtitle: "Provider: openai", badge: "READY", tone: "role.gateway" },
    memory: { title: "2/5 tasks", subtitle: "Session session-workbench-visual", badge: "Planning", tone: "status.running" },
    activity: { title: "2 active · 1 blocked", subtitle: "Reviewer is running", badge: "RISK", tone: "status.warning" },
    tools: [
      { name: "Skills", status: "On", tone: "status.success", active: true },
      { name: "Automations", status: "Running", tone: "status.running", active: true },
      { name: "Approvals", status: "1 pending", tone: "status.pending", active: true },
      { name: "MCP", status: "Off", tone: "text.muted", active: false },
      { name: "LSP", status: "Ready", tone: "status.success", active: true }
    ],
    workers: [
      { id: "worker-test", label: "Test Runner", status: "blocked", tone: "status.danger" },
      { id: "worker-review", label: "Reviewer", status: "running", tone: "status.running" }
    ],
    footer: commandFooterItems,
    centerBottomRows: 4,
    renderCenterContent: () => React.createElement(Box, { flexDirection: "column", width: "100%", height: "100%", overflow: "hidden" },
      currentAction,
      primary,
      compact ? undefined : React.createElement(Box, { flexDirection: "column", width: "100%", overflow: "hidden" }, inspector, actionLog)
    ),
    renderCenterBottom: () => React.createElement(ChatInputArea, {
      onSubmit: () => undefined,
      onCompletionRowsChange: () => undefined,
      inputActive: false,
      footerModeLabel: "WORK",
      footerModeTone: "brand.focus",
      footerPermissionLabel: "YOLO",
      footerPermissionTone: "status.danger",
      footerSandboxLabel: "RW",
      footerSandboxTone: "status.success",
      footerItems: [],
      footerHint: "Type a request  Ctrl+O details",
      columns: input.columns,
      maxRows: 4
    })
  });
}

function resultCardFixture(): ResultCardData {
  return {
    sessionId: "session-workbench-visual",
    status: "failed",
    route: "work",
    summary: "TUI workbench polish needs one focused check rerun.",
    changedFiles: ["src/tui/renderer/workbench-visual-snapshot.test.ts", "src/tui/components/ResultCard.tsx"],
    checks: [
      { command: "npm run check", status: "failed" },
      { command: "node --import tsx --test src/tui/renderer/workbench-visual-snapshot.test.ts", status: "passed" }
    ],
    review: { status: "warning", summary: "Review high-risk approval row before shipping." },
    risks: [],
    recovery: [],
    artifacts: [],
    next: ["rerun focused tests", "inspect real terminal"],
    decisionTrail: {
      split: ["Objective adopted"],
      assign: ["Worker owns renderer snapshot"],
      verify: ["visual snapshot passes"],
      decide: ["Reviewer checks no prompt overlap"],
      risk: ["medium: narrow viewport pressure"]
    },
    cache: {
      status: "cache_hit",
      cacheMode: "prefix-structured",
      hitRate: 0.81,
      writeRate: 0.08,
      changed: ["requestPrefixHash4096"]
    }
  };
}

function actionRowsFixture(): TuiActionRow[] {
  return [
    {
      id: "action-cache",
      kind: "cache",
      status: "success",
      title: "Prompt cache hit",
      summary: "cache:cache_hit hit 81%, write 8%",
      meta: "provider=openai model=kimi-k2.6",
      details: ["cache_hit saved prompt setup tokens"],
      facets: ["cache"],
      deepLinks: []
    },
    {
      id: "action-tool",
      kind: "tool",
      status: "running",
      title: "Run renderer test",
      summary: "Command: node --import tsx --test src/tui/renderer/workbench-visual-snapshot.test.ts",
      meta: "session=session-workbench-visual",
      details: ["stdout: running visual snapshot", "Artifact: E:/Playground/Swarm/.swarm/reports/tui-workbench.report.json"],
      facets: ["tool"],
      deepLinks: []
    },
    {
      id: "action-approval",
      kind: "approval",
      status: "pending",
      title: "Approval required",
      summary: "shell.exec r4/shell",
      meta: "target=workbench visual snapshot",
      details: ["review target and rollback"],
      facets: ["approval"],
      deepLinks: []
    }
  ];
}

function snapshotText(snapshot: TuiFrameSnapshot): string {
  return snapshot.lines.join("\n");
}

type SnapshotRow = TuiFrameSnapshot["cells"][number];

function snapshotRowWithText(snapshot: TuiFrameSnapshot, text: string): SnapshotRow {
  const row = snapshot.cells.find((candidate) => rowText(candidate).includes(text));
  assert(row, `Expected snapshot row containing ${text}`);
  return row;
}

function cellStyleAtText(row: SnapshotRow, text: string): Record<string, unknown> | undefined {
  const index = rowText(row).indexOf(text);
  assert(index >= 0, `Expected row to contain ${text}`);
  return row[index]?.style;
}

function rowText(row: SnapshotRow): string {
  return row.map((cell) => cell.char).join("");
}

function colorCount(snapshot: TuiFrameSnapshot): number {
  return new Set(snapshot.cells.flatMap((row) =>
    row.map((cell) => cell.style.color).filter((color): color is string => typeof color === "string")
  )).size;
}
