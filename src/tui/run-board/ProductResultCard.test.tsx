import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { createTuiRoot } from "../renderer/root.js";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import { ProductResultCard } from "./ProductResultCard.js";
import type { AttentionItemView, ResultPreview } from "./run-board-types.js";

test("ProductResultCard keeps the empty state to one quiet line", () => {
  const frame = renderTuiToFrame(React.createElement(ProductResultCard, {}), { columns: 80, rows: 8 });
  const text = frameText(frame);

  assert.match(text, /Waiting for your first task\./);
  assert.doesNotMatch(text, /No activity yet\./);
});

test("ProductResultCard keeps team reasoning optional until expanded", () => {
  const preview: ResultPreview = {
    ...emptyPreview(),
    contributors: [
      { workerId: "worker_code", label: "Code Worker", contribution: "implemented patch" },
      { workerId: "worker_test", label: "Test Runner", contribution: "verified focused test" }
    ]
  };
  const attentionHistory: AttentionItemView[] = [{
    id: "slow-test",
    kind: "slow",
    severity: "warning",
    title: "Test Runner may be slow",
    summary: "Test Runner had no output for 72s",
    evidence: ["npm test -- session-row"],
    recommendation: "Wait briefly before stopping.",
    actions: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:01:12.000Z",
    resolvedAt: "2026-05-28T00:01:20.000Z",
    resolution: "waited; command completed successfully"
  }];

  const frame = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "work",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff", "/commit"]
    },
    preview,
    attentionHistory
  }), { columns: 120, rows: 26 });
  const text = frameText(frame);

  assert.match(text, /RESULT/);
  assert.match(text, /Status\s+\[OK\] completed/);
  assert.match(text, /Session\s+sess-1/);
  assert.doesNotMatch(text, /route:/i);
  assert.doesNotMatch(text, /WORK/);
  assert.doesNotMatch(text, /Risk\s+low/);
  assert.match(text, /Verified\s+\[OK\] npm test -- session-row/);
  assert.match(text, /Details\s+4 items\. Show details/);
  assert.doesNotMatch(text, /Evidence\s+4 items/);
  assert.match(text, /NEXT\s+Review changes\s+Commit when ready/);
  assert.doesNotMatch(text, /NEXT\s+\/diff\s+\/commit/);
  assert.doesNotMatch(text, /NEXT\s+Show details/);
  assert.doesNotMatch(text, /CONTRIBUTORS/);
  assert.doesNotMatch(text, /Code Worker implemented patch/);
  assert.doesNotMatch(text, /REQUESTS/);
  assert.doesNotMatch(text, /waited; command completed successfully/);

  const expanded = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "work",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff", "/commit"]
    },
    preview,
    attentionHistory,
    teamReasoningExpanded: true
  }), { columns: 120, rows: 26 });
  const expandedText = frameText(expanded);

  assert.match(expandedText, /Details\s+4 items\. Show details/);
  assert.match(expandedText, /Detail\s+verification passed: npm test -- session-row/);
  assert.match(expandedText, /CONTRIBUTORS/);
  assert.match(expandedText, /Code Worker implemented patch/);
  assert.match(expandedText, /Test Runner verified focused test/);
  assert.match(expandedText, /REQUESTS/);
  assert.match(expandedText, /waited; command completed successfully/);
  assert.doesNotMatch(expandedText, /TEAM SUMMARY|WORKER SUMMARY|REQUEST HISTORY|ATTENTION HISTORY/);
});

test("ProductResultCard uses product-facing overflow labels in expanded detail", () => {
  const preview: ResultPreview = {
    ...emptyPreview(),
    contributors: [
      { workerId: "worker_code", label: "Code Worker", contribution: "implemented patch" },
      { workerId: "worker_test", label: "Test Runner", contribution: "verified focused test" },
      { workerId: "worker_docs", label: "Docs Pass", contribution: "checked user-facing copy" }
    ]
  };
  const attentionHistory: AttentionItemView[] = [
    attentionHistoryFixture("slow-test", "waited; command completed successfully"),
    attentionHistoryFixture("slow-lint", "continued after user approval")
  ];

  const frame = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: completedCardFixture(),
    preview,
    attentionHistory,
    density: "compact",
    teamReasoningExpanded: true
  }), { columns: 120, rows: 28 });
  const text = frameText(frame);

  assert.match(text, /\+1 more contributions/);
  assert.match(text, /\+1 more requests/);
  assert.doesNotMatch(text, /more workers|more attention items/i);
});

test("ProductResultCard dispatches final next action clicks", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 120,
    rows: 20,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "work",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff", "/commit"]
    },
    preview: emptyPreview(),
    attentionHistory: [],
    onNextAction: (action) => clicked.push(`${action.source}:${action.command}`)
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findLastCell(frame, "Commit when ready");
  assert(target, "expected final next action to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["final:/commit"]);
  root.unmount();
});

test("ProductResultCard renders decision trail from VM and toggles by click", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 120,
    rows: 20,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "team",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff"],
      decisionTrail: {
        split: ["Objective adopted"],
        assign: ["Code Worker owns patch"],
        verify: ["focused test passed"],
        decide: ["Reviewer approved"],
        risk: ["low: narrow change"]
      }
    },
    preview: emptyPreview(),
    attentionHistory: [],
    decisionTrailExpanded: false,
    onDecisionTrailToggle: () => clicked.push("trail")
  }));

  const frame = root.getFrame();
  assert(frame);
  const text = frameText(frame);
  assert.match(text, /Why\s+5 decisions\. Show details/);
  assert.doesNotMatch(text, /Objective adopted|Code Worker owns patch|focused test passed/);
  assert.doesNotMatch(text, /Ctrl\+O details|Trail\s+5 sections|split\s+Objective adopted/);
  const target = findLastCell(frame, "Why");
  assert(target, "expected why row to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["trail"]);
  root.unmount();

  const expanded = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "team",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      artifacts: [],
      next: ["/diff"],
      decisionTrail: {
        split: ["Objective adopted"],
        assign: ["Code Worker owns patch"],
        verify: ["focused test passed"],
        decide: ["Reviewer approved"],
        risk: ["low: narrow change"]
      }
    },
    preview: emptyPreview(),
    attentionHistory: [],
    decisionTrailExpanded: true
  }), { columns: 120, rows: 20 });
  const expandedText = frameText(expanded);

  assert.match(expandedText, /Why\s+showing 5 decisions/);
  assert.match(expandedText, /Plan\s+Objective adopted/);
  assert.match(expandedText, /Owner\s+Code Worker owns patch/);
  assert.match(expandedText, /Check\s+focused test passed/);
  assert.doesNotMatch(expandedText, /split\s+Objective adopted|assign\s+Code Worker owns patch|verify\s+focused test passed/);
});

test("ProductResultCard renders review findings as result-first report rows", () => {
  const frame = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-review",
      route: "work",
      summary: "Codebase Deep Review complete.",
      changedFiles: [],
      checks: [{ command: "review evidence collected", status: "passed" }],
      review: { status: "warning", summary: "2 actionable findings." },
      reviewFindings: [{
        severity: "high",
        title: "Permission check can be bypassed for inherited roles.",
        file: "src/auth/permissions.ts",
        line: 42,
        recommendation: "Validate inherited roles before granting access.",
        confidence: "high",
        evidence: ["src/auth/permissions.ts:42"]
      }, {
        severity: "medium",
        title: "Audit trail misses denied requests.",
        file: "src/auth/audit.ts",
        recommendation: "Record denied checks with request id.",
        confidence: "medium"
      }],
      risks: [],
      artifacts: [],
      next: ["/review auth and permissions"]
    },
    preview: emptyPreview(),
    attentionHistory: []
  }), { columns: 180, rows: 20 });
  const text = frameText(frame);

  assert.match(text, /Finding\s+High: src\/auth\/permissions\.ts:42 Permission check can be bypassed/);
  assert.match(text, /Fix: Validate inherited roles before granting access/);
  assert.match(text, /Medium: src\/auth\/audit\.ts Audit trail misses denied requests/);
  assert.doesNotMatch(text, /confidence=|fix=/);
  assert.doesNotMatch(text, /Changed\s+none/);
  assert.match(text, /NEXT\s+Review this workspace/);
  assert.doesNotMatch(text, /\/review auth and permissions/);
});

test("ProductResultCard renders recovery next steps in the result report", () => {
  const frame = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "failed",
      sessionId: "sess-recovery",
      route: "work",
      summary: "Edit failed because the replacement was ambiguous.",
      changedFiles: [],
      checks: [{ command: "file.edit", status: "failed" }],
      review: { status: "skipped", summary: "review not run" },
      risks: [{ level: "high", message: "tool action failed" }],
      recovery: [{
        category: "tool",
        severity: "warning",
        retryable: true,
        summary: "Tool action file.edit failed.",
        nextAction: "Run file.grep for a unique oldText, then retry file.edit.",
        commandHint: "file.grep"
      }, {
        category: "cache",
        severity: "info",
        retryable: true,
        summary: "Prompt cache prefix changed.",
        nextAction: "Keep stable system text and tool schemas unchanged."
      }],
      artifacts: [],
      next: ["/debug latest"]
    },
    preview: emptyPreview(),
    attentionHistory: []
  }), { columns: 180, rows: 20 });
  const text = frameText(frame);

  assert.match(text, /Recovery\s+Tool action file\.edit failed\./);
  assert.match(text, /Risk\s+high: tool action failed/);
  assert.match(text, /Next: Run file\.grep for a unique oldText, then retry file\.edit\./);
  assert.match(text, /Try: file\.grep/);
  assert.match(text, /Prompt cache prefix changed\./);
  assert.doesNotMatch(text, /\[tool\/warning\/retry\]|\[cache\/info\/retry\]|Hint:/);

  const compact = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "failed",
      sessionId: "sess-recovery",
      route: "work",
      summary: "Edit failed because the replacement was ambiguous.",
      changedFiles: [],
      checks: [],
      review: { status: "skipped", summary: "review not run" },
      risks: [],
      recovery: [{
        category: "tool",
        severity: "warning",
        retryable: true,
        summary: "Tool action file.edit failed.",
        nextAction: "Run file.grep for a unique oldText, then retry file.edit."
      }, {
        category: "cache",
        severity: "info",
        retryable: true,
        summary: "Prompt cache prefix changed.",
        nextAction: "Keep stable system text and tool schemas unchanged."
      }],
      artifacts: [],
      next: []
    },
    preview: emptyPreview(),
    attentionHistory: [],
    density: "compact"
  }), { columns: 160, rows: 16 });
  const compactText = frameText(compact);

  assert.match(compactText, /Recovery\s+Tool action file\.edit failed\./);
  assert.match(compactText, /\+1 more steps/);
  assert.doesNotMatch(compactText, /\[cache\/info\/retry\] Prompt cache prefix changed\./);
});

test("ProductResultCard renders checkpoint rollback status in the result report", () => {
  const available = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "completed",
      sessionId: "sess-checkpoint",
      route: "work",
      summary: "Runtime created a rollback checkpoint before applying edits.",
      changedFiles: ["src/runtime/runtime.ts"],
      checks: [{ command: "npm test -- checkpoints", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [],
      checkpoint: {
        id: "cp_git_1",
        name: "Workspace checkpoint",
        mode: "git",
        revertAvailable: true
      },
      artifacts: [],
      next: ["/diff"]
    },
    preview: emptyPreview(),
    attentionHistory: []
  }), { columns: 160, rows: 20 });
  const availableText = frameText(available);

  assert.match(availableText, /Undo\s+Workspace checkpoint available/);
  assert.doesNotMatch(availableText, /\[git\]|revert available/);
  assert.match(availableText, /NEXT\s+Undo latest change\s+Review changes/);

  const unavailable = renderTuiToFrame(React.createElement(ProductResultCard, {
    card: {
      status: "failed",
      sessionId: "sess-checkpoint-missing",
      route: "work",
      summary: "Checkpoint manifest is missing.",
      changedFiles: [],
      checks: [],
      review: { status: "skipped", summary: "review not run" },
      risks: [{ level: "medium", message: "rollback checkpoint is unavailable" }],
      checkpoint: {
        id: "cp_snapshot_missing",
        name: "Missing snapshot",
        mode: "snapshot",
        revertAvailable: false
      },
      artifacts: [],
      next: ["/debug latest"]
    },
    preview: emptyPreview(),
    attentionHistory: []
  }), { columns: 160, rows: 20 });
  const unavailableText = frameText(unavailable);

  assert.match(unavailableText, /Undo\s+Missing snapshot unavailable/);
  assert.doesNotMatch(unavailableText, /\[snapshot\]|revert unavailable/);
  assert.doesNotMatch(unavailableText, /Changed\s+none|Verified\s+none/);
  assert.doesNotMatch(unavailableText, /Undo latest change/);
});

function emptyPreview(): ResultPreview {
  return {
    status: "ready",
    summary: "Fixed session restore.",
    changedFiles: ["src/runtime/session-row.ts"],
    checks: [{ command: "npm test -- session-row", status: "passed" }],
    artifacts: [],
    blockers: [],
    confidence: "high",
    contributors: [],
    risks: [],
    nextActions: ["/diff", "/commit"]
  };
}

function completedCardFixture(): NonNullable<React.ComponentProps<typeof ProductResultCard>["card"]> {
  return {
    status: "completed",
    sessionId: "sess-1",
    route: "work",
    summary: "Fixed session restore.",
    changedFiles: ["src/runtime/session-row.ts"],
    checks: [{ command: "npm test -- session-row", status: "passed" }],
    review: { status: "passed", summary: "review passed" },
    risks: [],
    artifacts: [],
    next: ["/diff", "/commit"]
  };
}

function attentionHistoryFixture(id: string, resolution: string): AttentionItemView {
  return {
    id,
    kind: "slow",
    severity: "warning",
    title: "Test Runner may be slow",
    summary: "Test Runner had no output for 72s",
    evidence: ["npm test -- session-row"],
    recommendation: "Wait briefly before stopping.",
    actions: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:01:12.000Z",
    resolvedAt: "2026-05-28T00:01:20.000Z",
    resolution
  };
}

function findLastCell(frame: NonNullable<ReturnType<ReturnType<typeof createTuiRoot>["getFrame"]>>, needle: string): { x: number; y: number } | undefined {
  let target: { x: number; y: number } | undefined;
  for (let y = 0; y < frame.screen.height; y += 1) {
    const line = frame.screen.cells[y]?.map((cell) => cell.char).join("") ?? "";
    const x = line.indexOf(needle);
    if (x >= 0) {
      target = { x, y };
    }
  }
  return target;
}
