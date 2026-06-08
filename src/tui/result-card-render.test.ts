import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { Box, render } from "./ui.js";
import type { ResultCard } from "../runtime/result-card.js";
import { ActivityTimeline, activityTimelineLimit } from "./components/ActivityTimeline.js";
import { CurrentActionRow } from "./components/CurrentActionRow.js";
import { InspectorPane } from "./components/InspectorPane.js";
import { ResultCard as ResultCardPanel } from "./components/ResultCard.js";
import { StatusRail } from "./components/StatusRail.js";
import type { TuiFrame } from "./renderer/frame.js";
import { createTuiRoot } from "./renderer/root.js";
import { frameText, renderTuiToFrame } from "./renderer/testing.js";
import { resolveTuiColor } from "./theme.js";

test("ResultCard renders sectioned outcome hierarchy with cache and checkpoint detail", async () => {
  const plain = stripAnsi(await renderElement(React.createElement(ResultCardPanel, {
    card: {
      sessionId: "session-result-card-123456",
      status: "failed",
      route: "work",
      summary: "Verification failed after TUI polish.",
      changedFiles: ["src/tui/components/ResultCard.tsx", "src/tui/components/ApprovalOverlay.tsx", "src/tui/theme.ts", "src/tui/conversation-layout.ts"],
      checks: [
        { command: "npm run check failed", status: "failed" },
        { command: "node --import tsx --test src/tui/result-card-render.test.tsx", status: "passed" },
        { command: "npm run lint", status: "passed" },
        { command: "npm run typecheck", status: "passed" }
      ],
      review: { status: "warning", summary: "Review found a narrow viewport risk." },
      risks: [
        { level: "high", message: "One verification check failed." },
        { level: "medium", message: "One viewport needs a follow-up pass." },
        { level: "low", message: "Copy can be tightened later." }
      ],
      recovery: [{
        category: "provider_rate_limit",
        severity: "warning",
        retryable: true,
        summary: "Model provider rate limit or quota was hit.",
        nextAction: "Wait and retry, reduce concurrency, or switch to a less constrained model/provider.",
        commandHint: "swarm run --max-agents 1"
      }, {
        category: "provider_timeout",
        severity: "warning",
        retryable: true,
        summary: "Network request failed.",
        nextAction: "Retry the command.",
        commandHint: "swarm run"
      }, {
        category: "unknown",
        severity: "info",
        retryable: false,
        summary: "No action needed.",
        nextAction: "Continue.",
        commandHint: "swarm status"
      }],
      artifacts: [
        "E:/Playground/Swarm/.swarm/reports/check.report.json",
        "E:/Playground/Swarm/.swarm/logs/trajectory.jsonl",
        "E:/Playground/Swarm/.swarm/reports/extra.report.json"
      ],
      next: ["rerun focused tests", "inspect the failed check"],
      checkpoint: {
        id: "cp-1",
        name: "Before TUI polish",
        mode: "snapshot",
        revertAvailable: true
      },
      cache: {
        status: "cache_hit",
        cacheMode: "prefix-structured",
        hitRate: 0.64,
        writeRate: 0.12,
        changed: ["requestPrefixHash4096"]
      }
    } satisfies ResultCard
  })));

  assert.match(plain, /SUMMARY Verification failed after TUI polish\./);
  assert.doesNotMatch(plain, /session-result-card|WORK/);
  assert.match(plain, /CHANGED src\/tui\/components\/ResultCard\.tsx/);
  assert.match(plain, /CHECKS npm run check failed \[ERR\]/);
  assert.doesNotMatch(plain, /result-card-render\.test\.tsx \[OK\]|npm run lint|npm run typecheck/);
  assert.match(plain, /REVIEW \[WARN\] Review found a narrow viewport risk\./);
  assert.match(plain, /RISKS high: One verification check failed\./);
  assert.match(plain, /RECOVERY Model provider rate limit or quota was hit\./);
  assert.match(plain, /Next: Wait and retry/);
  assert.doesNotMatch(plain, /provider_rate_limit\/warning\/retry|Hint:/);
  assert.match(plain, /ARTIFACTS saved/);
  assert.doesNotMatch(plain, /⎿ artifact|\.swarm\/reports\/check\.report\.json/);
  assert.doesNotMatch(plain, /\+\d/);
  assert.match(plain, /NEXT rerun focused tests/);
  assert.doesNotMatch(plain, /CHECKPOINT|Before TUI polish|snapshot|rollback \/revert last/);
  assert.doesNotMatch(plain, /CACHE|cache:cache_hit|hit 64%/);
});

test("ResultCard renders collapsed and expanded decision trail", () => {
  const card = {
    sessionId: "session-result-card-trail",
    status: "completed",
    route: "team",
    summary: "Swarm completed the run.",
    changedFiles: ["src/tui/components/ResultCard.tsx"],
    checks: [{ command: "npm run check", status: "passed" }],
    review: { status: "passed", summary: "review passed" },
    risks: [],
    recovery: [],
    artifacts: [],
    next: ["/diff"],
    decisionTrail: {
      split: ["Objective adopted"],
      assign: ["Code Worker owns patch"],
      verify: ["npm run check"],
      decide: ["Reviewer approved"],
      risk: ["low: narrow change"]
    }
  } satisfies ResultCard;

  const collapsed = frameText(renderTuiToFrame(React.createElement(ResultCardPanel, {
    card,
    decisionTrailExpanded: false
  }), { columns: 100, rows: 12 }));
  const expanded = frameText(renderTuiToFrame(React.createElement(ResultCardPanel, {
    card,
    decisionTrailExpanded: true
  }), { columns: 100, rows: 16 }));

  assert.match(collapsed, /WHY Decisions/);
  assert.match(collapsed, /CHECKS Passed/);
  assert.doesNotMatch(collapsed, /CHECKS npm run check|\[OK\] npm run check/);
  assert.doesNotMatch(collapsed, /REVIEW\s+\[OK\] review passed/);
  assert.doesNotMatch(collapsed, /Objective adopted|Code Worker owns patch/);
  assert.doesNotMatch(collapsed, /TRAIL 5 sections|Ctrl\+O details|split: Objective adopted/);
  assert.doesNotMatch(collapsed, /risk: low: narrow change/);
  assert.match(expanded, /WHY Decisions/);
  assert.match(expanded, /PLAN Objective adopted/);
  assert.match(expanded, /OWNER Code Worker owns patch/);
  assert.match(expanded, /CHECK npm run check/);
  assert.match(expanded, /RISK low: narrow change/);
  assert.doesNotMatch(expanded, /split: Objective adopted|assign: Code Worker owns patch|verify: npm run check/);
});

test("ResultCard decision trail hint dispatches mouse toggle", () => {
  const toggled: string[] = [];
  const root = createTuiRoot({
    columns: 100,
    rows: 12,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ResultCardPanel, {
    card: {
      sessionId: "session-result-card-trail-click",
      status: "completed",
      route: "team",
      summary: "Swarm completed the run.",
      changedFiles: [],
      checks: [],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      recovery: [],
      artifacts: [],
      next: [],
      decisionTrail: {
        split: ["Objective adopted"]
      }
    },
    onDecisionTrailToggle: () => toggled.push("trail")
  } satisfies React.ComponentProps<typeof ResultCardPanel>));

  const frame = root.getFrame();
  assert(frame);
  assert.doesNotMatch(frameText(frame), /CHANGED\s+none/);
  assert.doesNotMatch(frameText(frame), /CHECKS\s+none/);
  const target = findCell(frame, "WHY");
  assert(target);
  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(toggled, ["trail"]);
  root.unmount();
});

test("ResultCard colors section labels and status badges without tinting values", () => {
  const frame = renderTuiToFrame(React.createElement(ResultCardPanel, {
    card: {
      sessionId: "session-result-card-colors",
      status: "failed",
      route: "work",
      summary: "Verification failed after TUI polish.",
      changedFiles: ["src/tui/components/ResultCard.tsx"],
      checks: [
        { command: "npm run check failed", status: "failed" },
        { command: "node --import tsx --test src/tui/result-card-render.test.ts", status: "passed" }
      ],
      review: { status: "warning", summary: "Review found a narrow viewport risk." },
      risks: [],
      recovery: [],
      artifacts: ["E:/Playground/Swarm/.swarm/reports/check.report.json"],
      next: [],
      cache: {
        status: "cache_hit",
        cacheMode: "prefix-structured",
        hitRate: 0.64,
        writeRate: 0.12,
        changed: ["requestPrefixHash4096"]
      }
    } satisfies ResultCard
  }), { columns: 96, rows: 12 });

  assert.equal(colorAtText(frame, "CHECKS"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "npm run check failed"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "[ERR]"), resolveTuiColor("status.danger"));
  assert.doesNotMatch(frameText(frame), /\[OK\] node --import tsx --test/);
  assert.equal(colorAtText(frame, "REVIEW"), resolveTuiColor("status.warning"));
  assert.equal(colorAtText(frame, "[WARN]"), resolveTuiColor("status.warning"));
  assert.doesNotMatch(frameText(frame), /CACHE|cache:cache_hit|hit 64%/);
  assert.equal(colorAtText(frame, "ARTIFACTS"), resolveTuiColor("text.primary"));
  assert.doesNotMatch(frameText(frame), /artifact\s+E:\/Playground\/Swarm\/\.swarm\/reports\/check\.report\.json/);
});

test("InspectorPane wraps long recovery commands and artifact paths in narrow terminals", async () => {
  const plain = stripAnsi(await renderElement(React.createElement(Box, { width: 36 }, React.createElement(InspectorPane, {
    title: "Latest Diagnosis",
    sessionId: "session-narrow",
    route: "coding",
    selected: "lines 1-4 / 4",
    content: [
      "Command: node --import tsx --test src/tui/action-log.test.ts src/tui/result-card-render.test.ts",
      "Artifact: E:/Playground/Swarm/.swarm/local-tests/real-task-deepseek-001/reports/swarm-run-fixed.report.json"
    ].join("\n")
  }))));

  assert.match(plain, /node --import/);
  assert.match(plain, /tsx --test/);
  assert.match(plain, /--test/);
  assert.match(plain, /action-log\.test\.ts/);
  assert.match(plain, /swarm-run-/);
  assert.match(plain, /fixed\.report\.json/);
  assert.doesNotMatch(plain, /Artifact: E:\/Playground\/Swarm\/\.\.\./);
});

test("InspectorPane density hides secondary chrome in compact mode", async () => {
  const compact = stripAnsi(await renderElement(React.createElement(Box, { width: 64 }, React.createElement(InspectorPane, {
    title: "Command Output",
    sessionId: "session-density",
    route: "coding",
    selected: "lines 1-2 / 2",
    tabs: ["output", "files", "debug"],
    content: "line one\nline two",
    density: "compact"
  }))));
  assert.match(compact, /COMMAND OUTPUT/);
  assert.match(compact, /session:session-density/);
  assert.doesNotMatch(compact, /route:coding/);
  assert.doesNotMatch(compact, /tabs:/);

  const comfortable = stripAnsi(await renderElement(React.createElement(Box, { width: 96 }, React.createElement(InspectorPane, {
    title: "Command Output",
    sessionId: "session-density",
    route: "coding",
    selected: "lines 1-2 / 2",
    tabs: ["output", "files", "debug"],
    content: "line one\nline two",
    density: "comfortable"
  }))));
  assert.match(comfortable, /route:coding/);
  assert.match(comfortable, /tabs: output/);
});

test("InspectorPane applies semantic tool shell diff and artifact colors", () => {
  const frame = renderTuiToFrame(React.createElement(Box, { width: 96 }, React.createElement(InspectorPane, {
    title: "Command Output",
    sessionId: "session-colors",
    route: "coding",
    content: [
      "Command: node --import tsx --test src/tui/action-log.test.ts",
      "stdout: 53 tests passed",
      "stderr: none",
      "Artifact: E:/Playground/Swarm/.swarm/reports/check.report.json",
      "+added line",
      "-removed line",
      "@@ src/tui/components/InspectorPane.tsx"
    ].join("\n")
  })), { columns: 96, rows: 12 });

  assert.equal(colorAtText(frame, "⏵"), resolveTuiColor("role.tool"));
  assert.equal(colorAtTextAfter(frame, "⏵", "shell"), resolveTuiColor("role.tool"));
  assert.equal(colorAtText(frame, "node --import tsx"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "⎿"), resolveTuiColor("text.muted"));
  assert.equal(colorAtText(frame, "stdout"), resolveTuiColor("role.tool"));
  assert.equal(colorAtText(frame, "53 tests passed"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "stderr"), resolveTuiColor("status.danger"));
  assert.equal(colorAtTextAfter(frame, "stderr", "none"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "artifact"), resolveTuiColor("text.muted"));
  assert.equal(colorAtText(frame, "check.report.json"), resolveTuiColor("text.muted"));
  assert.equal(colorAtText(frame, "diff"), resolveTuiColor("role.gateway"));
  assert.equal(colorAtText(frame, "+added"), resolveTuiColor("diff.added"));
  assert.equal(colorAtText(frame, "-removed"), resolveTuiColor("diff.removed"));
  assert.equal(colorAtText(frame, "@@"), resolveTuiColor("role.gateway"));
});

test("ActivityTimeline density controls scan depth and title chrome", async () => {
  assert.equal(activityTimelineLimit(5, "compact"), 2);
  assert.equal(activityTimelineLimit(5, "default"), 4);
  assert.equal(activityTimelineLimit(5, "comfortable"), 5);

  const empty = stripAnsi(await renderElement(React.createElement(ActivityTimeline, {
    items: []
  })));
  assert.equal(empty.trim(), "");
  assert.doesNotMatch(empty, /\(none\)|PROGRESS/);

  const explicitEmpty = stripAnsi(await renderElement(React.createElement(ActivityTimeline, {
    items: [],
    emptyLabel: "No recent progress."
  })));
  assert.match(explicitEmpty, /PROGRESS/);
  assert.match(explicitEmpty, /No recent progress\./);

  const compact = stripAnsi(await renderElement(React.createElement(ActivityTimeline, {
    title: "Progress",
    items: ["route", "thinking", "read files", "edit files", "run tests"],
    limit: 5,
    density: "compact"
  })));
  assert.doesNotMatch(compact, /PROGRESS/);
  assert.doesNotMatch(compact, /route|thinking|read files/);
  assert.match(compact, /edit files/);
  assert.match(compact, /run tests/);

  const comfortable = stripAnsi(await renderElement(React.createElement(ActivityTimeline, {
    title: "Progress",
    items: ["route", "thinking", "read files", "edit files", "run tests"],
    limit: 5,
    density: "comfortable"
  })));
  assert.match(comfortable, /PROGRESS/);
  assert.match(comfortable, /- route/);
  assert.match(comfortable, /- run tests/);
});

test("CurrentActionRow colors status and loader without tinting body text", () => {
  const frame = renderTuiToFrame(React.createElement(CurrentActionRow, {
    message: "Run local coding loop",
    phase: "running tools",
    status: "running",
    tone: "running",
    progress: "[##--------] tasks 1/5",
    motionFrame: 0,
    density: "comfortable"
  }), { columns: 96, rows: 4 });

  assert.equal(colorAtText(frame, "[RUN]"), resolveTuiColor("status.running"));
  assert.equal(colorAtText(frame, "●"), resolveTuiColor("status.running"));
  assert.equal(colorAtText(frame, "Run local coding loop"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "running tools"), resolveTuiColor("text.muted"));
});

test("ActivityTimeline colors markers and phase labels without tinting item bodies", () => {
  const frame = renderTuiToFrame(React.createElement(ActivityTimeline, {
    title: "Progress",
    items: [
      "thinking: reading project files",
      "running_tool: npm run check",
      "completed: all checks passed"
    ],
    limit: 3,
    density: "comfortable"
  }), { columns: 96, rows: 6 });

  assert.equal(colorAtText(frame, "thinking"), resolveTuiColor("status.running"));
  assert.equal(colorAtText(frame, "reading project files"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "running_tool"), resolveTuiColor("status.running"));
  assert.equal(colorAtText(frame, "npm run check"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "completed"), resolveTuiColor("status.success"));
  assert.equal(colorAtText(frame, "all checks passed"), resolveTuiColor("text.primary"));
});

test("StatusRail uses focused brand color and semantic metadata pills", () => {
  const frame = renderTuiToFrame(React.createElement(StatusRail, {
    appName: "Swarm",
    state: "running",
    route: "coding_loop",
    permissionMode: "yolo",
    sandboxMode: "workspace-write",
    model: "openai/deepseek-v4-flash",
    sessionId: "session-status-123456",
    cacheStatus: "cache_miss",
    checkpoint: "before-polish",
    view: "Trace",
    density: "comfortable"
  }), { columns: 120, rows: 3 });

  assert.equal(colorAtText(frame, "Swarm"), resolveTuiColor("brand.focus"));
  assert.equal(colorAtText(frame, "[RUN]"), resolveTuiColor("status.running"));
  assert.equal(colorAtText(frame, "route:WORK"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "perm:YOLO"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "sandbox:RW"), resolveTuiColor("status.success"));
  assert.equal(colorAtText(frame, "model:deepseek-v4-flash"), resolveTuiColor("text.muted"));
  assert.equal(colorAtText(frame, "cache:MISS"), resolveTuiColor("status.pending"));
  assert.equal(colorAtText(frame, "session session"), resolveTuiColor("text.muted"));
});

function renderElement(element: React.ReactElement): Promise<string> {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  const app = render(element, {
    stdout: stream as unknown as NodeJS.WriteStream,
    stderr: stream as unknown as NodeJS.WriteStream,
    patchConsole: false
  });
  return new Promise((resolve) => {
    setTimeout(() => {
      app.unmount();
      resolve(output);
    }, 20);
  });
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

function colorAtText(frame: TuiFrame, needle: string): string | undefined {
  for (const row of frame.screen.cells) {
    const line = row.map((cell) => cell.char).join("");
    const index = line.indexOf(needle);
    if (index >= 0) {
      const offset = [...needle].findIndex((char) => char.trim().length > 0);
      return row[index + Math.max(0, offset)]?.style.color;
    }
  }
  return undefined;
}

function colorAtTextAfter(frame: TuiFrame, anchor: string, needle: string): string | undefined {
  for (const row of frame.screen.cells) {
    const line = row.map((cell) => cell.char).join("");
    const anchorIndex = line.indexOf(anchor);
    if (anchorIndex < 0) {
      continue;
    }
    const index = line.indexOf(needle, anchorIndex + anchor.length);
    if (index >= 0) {
      const offset = [...needle].findIndex((char) => char.trim().length > 0);
      return row[index + Math.max(0, offset)]?.style.color;
    }
  }
  return undefined;
}

function findCell(frame: TuiFrame, needle: string): { x: number; y: number } | undefined {
  for (let y = 0; y < frame.screen.height; y += 1) {
    const line = frame.screen.cells[y]?.map((cell) => cell.char).join("") ?? "";
    const x = line.indexOf(needle);
    if (x >= 0) {
      return { x, y };
    }
  }
  return undefined;
}
