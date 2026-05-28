import { strict as assert } from "node:assert";
import React from "react";
import test from "node:test";
import { Box } from "../ui.js";
import type { ResultCard as ResultCardData } from "../../runtime/result-card.js";
import type { ToolApprovalRequest } from "../../tools/types.js";
import type { TuiActionRow } from "../action-log.js";
import { ChatInputArea } from "../ChatInputArea.js";
import { ActionLog } from "../components/ActionLog.js";
import { ApprovalOverlay } from "../components/ApprovalOverlay.js";
import { CollaborationOverlayPanel } from "../components/CollaborationOverlayPanel.js";
import { InspectorPane } from "../components/InspectorPane.js";
import { ResultCard } from "../components/ResultCard.js";
import { StatusRail } from "../components/StatusRail.js";
import { TopologyStrip } from "../components/TopologyStrip.js";
import { buildTopologyStripModel, type CollaborationOverlayView } from "../collaboration-cockpit.js";
import { resolveTuiColor } from "../theme.js";
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
    assert.match(text, /TOPO/);
    assert.match(text, /OWNERSHIP/);
    assert.match(text, /TRAIL/);
    assert.match(text, /APPROVAL|DECISION|Reassign/);
    if (viewport.columns >= 100) {
      assert.match(text, /COMMAND OUTPUT/);
      assert.match(text, /ACTION LOG/);
    }
    assert.match(text, /Ask Swarm/);

    assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "Swarm"), "Swarm")?.color, resolveTuiColor("brand.focus"));
    assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "CHECKS"), "CHECKS")?.color, resolveTuiColor("status.danger"));
    if (text.includes("TARGET")) {
      assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "TARGET"), "TARGET")?.color, resolveTuiColor("role.gateway"));
    }
    if (viewport.columns >= 100) {
      assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "COMMAND OUTPUT"), "COMMAND OUTPUT")?.color, resolveTuiColor("text.primary"));
      assert.equal(cellStyleAtText(snapshotRowWithText(snapshot, "ACTION LOG"), "ACTION LOG")?.color, resolveTuiColor("text.primary"));
    }
  }

  const wideSnapshot = snapshots[3]!.snapshot;
  assert.equal(cellStyleAtText(snapshotRowWithText(wideSnapshot, "[cache:HIT 81%]"), "[cache:HIT 81%]")?.backgroundColor, resolveTuiColor("surface.selection"));
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
  const bodyHeight = Math.max(8, input.rows - 5);
  const resultCard = React.createElement(ResultCard, { card: resultCardFixture(), detailHint: "Ctrl+O details", density: input.density });
  const topology = React.createElement(TopologyStrip, {
    model: buildTopologyStripModel({
      approvalsPending: 1,
      policyMode: "approval",
      sandboxMode: "workspace-write"
    }),
    columns: input.columns
  });
  const overlay = React.createElement(CollaborationOverlayPanel, {
    overlay: collaborationOverlayFixture(),
    selectedIndex: 0,
    reassign: {
      targetId: "worker-test",
      source: "ownership",
      reason: "Test Runner waiting on verification",
      risk: "medium",
      policy: "approval-required",
      summary: "Reassign intent for Test Runner"
    }
  });
  const approval = React.createElement(ApprovalOverlay, { request: approvalFixture() });
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
    columns: compact ? input.columns - 2 : Math.floor(input.columns / 2) - 2,
    scrollOffset: 0,
    onScrollOffsetChange: () => undefined,
    motionFrame: 1,
    selectedIndex: 1
  });
  return React.createElement(Box, { width: input.columns, height: input.rows, flexDirection: "column", overflow: "hidden" },
    React.createElement(StatusRail, {
      appName: "Swarm",
      state: "running",
      route: "coding_loop",
      permissionMode: "yolo",
      sandboxMode: "workspace-write",
      model: "openai/kimi-k2.6",
      sessionId: "session-workbench-visual",
      cacheStatus: "cache_hit",
      checkpoint: "before-tui-polish",
      view: "Workbench",
      density: input.density
    }),
    compact
      ? React.createElement(Box, { flexDirection: "column", width: "100%", height: bodyHeight, overflow: "hidden" },
        React.createElement(Box, { height: 2, overflow: "hidden", flexDirection: "column" }, topology),
        React.createElement(Box, { height: 5, overflow: "hidden", flexDirection: "column" }, overlay),
        React.createElement(Box, { height: 10, overflow: "hidden", flexDirection: "column" }, resultCard),
        React.createElement(Box, { height: 3, overflow: "hidden", flexDirection: "column" }, approval),
        React.createElement(Box, { height: 3, overflow: "hidden", flexDirection: "column" }, inspector),
        actionLog
      )
      : React.createElement(Box, { flexDirection: "row", width: "100%", height: bodyHeight, overflow: "hidden" },
        React.createElement(Box, { flexDirection: "column", width: "50%", flexGrow: 1, overflow: "hidden" },
          topology,
          overlay,
          resultCard,
          approval
        ),
        React.createElement(Box, { flexDirection: "column", width: "50%", flexGrow: 1, overflow: "hidden" },
          inspector,
          actionLog
        )
      ),
    React.createElement(ChatInputArea, {
      onSubmit: () => undefined,
      onCompletionRowsChange: () => undefined,
      inputActive: false,
      footerModeLabel: "WORK",
      footerModeTone: "brand.focus",
      footerPermissionLabel: "YOLO",
      footerPermissionTone: "status.danger",
      footerSandboxLabel: "RW",
      footerSandboxTone: "status.success",
      footerItems: [
        { id: "tasks", label: "tasks", value: "2/5", tone: "running" },
        { id: "cache", label: "cache", value: "HIT 81%", tone: "success" },
        { id: "lsp", label: "lsp", value: "READY", tone: "success" },
        { id: "gateway", label: "gateway", value: "LOCAL", tone: "success" },
        { id: "symphony", label: "symphony", value: "2 run", tone: "running" }
      ],
      selectedFooterItem: "cache",
      footerHint: "Left/Right footer | [/] message | / search",
      columns: input.columns,
      maxRows: 4
    })
  );
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

function collaborationOverlayFixture(): CollaborationOverlayView {
  return {
    target: "ownership",
    title: "Ownership",
    emptyLabel: "No blocked ownership.",
    actions: ["Enter detail", "r reassign intent", "Esc close"],
    rows: [
      {
        id: "worker-test",
        label: "Test Runner",
        status: "blocked",
        tone: "blocked",
        evidence: "waiting verification",
        detail: ["Test Runner blocked by verification"],
        priority: 0
      },
      {
        id: "claim-session-row",
        label: "Claim session-row.ts",
        status: "claimed",
        tone: "ok",
        evidence: "owner Code Worker",
        detail: ["Code Worker owns session-row.ts"],
        priority: 5
      }
    ]
  };
}

function approvalFixture(): ToolApprovalRequest {
  return {
    id: "approval-workbench",
    action: "shell.exec",
    summary: "Run focused TUI renderer tests.",
    detail: "cwd=E:/Playground/Swarm\ncommand=node --import tsx --test src/tui/renderer/workbench-visual-snapshot.test.ts",
    risk: "shell",
    risk_class: "r4",
    target: "node --import tsx --test src/tui/renderer/workbench-visual-snapshot.test.ts",
    why_now: "The new visual fixture must be verified before global install.",
    predicted_impact: "Runs local tests and writes no source files.",
    rollback_plan: "No rollback needed; test command is read-only.",
    permission_decision: "ask",
    permission_reason: "Shell execution requires explicit confirmation.",
    permission_name: "shell.exec",
    permission_rule: "r4 shell",
    summary_diff: "+ workbench snapshot coverage"
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
