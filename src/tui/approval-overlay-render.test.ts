import { strict as assert } from "node:assert";
import React from "react";
import test from "node:test";
import { withTuiRendererMode } from "./ui.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { ApprovalOverlay, approvalCardRows, approvalExpandedRows } from "./components/ApprovalOverlay.js";
import { PLAN_CARD_ROWS, PlanApprovalOverlay } from "./components/PlanApprovalOverlay.js";
import { approvalInputDecision } from "./approval-input.js";
import { createTuiRoot } from "./renderer/root.js";
import type { TuiFrame } from "./renderer/frame.js";
import { renderTuiToFrame } from "./renderer/testing.js";
import { resolveTuiColor } from "./theme.js";

test("an ordinary approval is a short card: what, why it was asked, and the keys", () => {
  const request: ToolApprovalRequest = {
    ...approvalFixture(),
    action: "shell.exec",
    summary: "Run shell command: ls src",
    detail: "Command: ls src\nCWD: .\nTimeout: 120000 ms",
    risk_class: "r2",
    target: "ls src",
    attention_note: undefined,
    permission_rule: "Bash(*)",
    summary_diff: undefined
  };
  const rows = approvalCardRows(request);
  const frame = renderTuiToFrame(React.createElement(ApprovalOverlay, { request }), { columns: 80, rows });
  const lines = frameLines(frame);

  assert.equal(rows, 4);
  assert.match(lines[0] ?? "", /^─{80}$/);
  assert.equal(lines[1], " ? Run a command  ls src");
  assert.equal(lines[2], "   rule Bash(*)");
  assert.equal(lines[3], "   y yes · a always · n no · ? details");
  assert.equal(colorAtText(frame, "?"), resolveTuiColor("status.pending"));
  assert.equal(colorAtText(frame, "Run a command"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "rule Bash"), resolveTuiColor("text.muted"));
});

test("a high-risk approval says so in red and an edit shows the first lines of its diff", () => {
  const frame = renderTuiToFrame(React.createElement(ApprovalOverlay, { request: approvalFixture() }), { columns: 100, rows: approvalCardRows(approvalFixture()) });
  const lines = frameLines(frame);

  assert.equal(lines[1], " ! Run a command  Remove-Item -Recurse build");
  assert.equal(lines[2], "   rule r4 shell · in E:/Playground/Swarm");
  assert.equal(lines[3], "   Destructive shell command detected. Review the command literally before approving.");
  assert.deepEqual(lines.slice(4, 6), ["   - build/old.js", "   + (deleted)"]);
  assert.equal(colorAtText(frame, "!"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "Destructive"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "- build"), resolveTuiColor("diff.removed"));
  assert.equal(colorAtText(frame, "+ (deleted)"), resolveTuiColor("diff.added"));

  const edit: ToolApprovalRequest = {
    ...approvalFixture(),
    action: "file.edit",
    risk: "write",
    risk_class: "r2",
    target: "src/pair.ts",
    attention_note: undefined,
    summary_diff: Array.from({ length: 12 }, (_, index) => `${index % 2 ? "+" : "-"} line ${index + 1}`).join("\n")
  };
  assert.equal(approvalCardRows(edit), 4 + 8, "at most eight diff lines before ?");
  assert.match(frameLines(renderTuiToFrame(React.createElement(ApprovalOverlay, { request: edit }), { columns: 80, rows: 12 }))[1] ?? "", /^ \? Edit a file {2}src\/pair\.ts$/);
});

test("? opens the whole request inside the card, cut to the rows it is given", () => {
  const request = approvalFixture();
  const plain = frameLines(renderTuiToFrame(React.createElement(ApprovalOverlay, { request, expanded: true }), { columns: 140, rows: 24 })).join("\n");

  assert.match(plain, /Risk \[HIGH\] R4\/SHELL shell\.exec/);
  assert.match(plain, /Summary Delete generated files under the workspace\./);
  assert.match(plain, /Review focus: high-risk operation/);
  assert.match(plain, /Why now The build folder must be cleared/);
  assert.match(plain, /Permission: shell\.exec ask \| Destructive shell command requires explicit approval\./);
  assert.match(plain, /Governance actor=worker:safety scope=Remove-Item -Recurse build ttl=900000ms/);
  assert.match(plain, /Impact Deletes generated output\./);
  assert.match(plain, /Rollback Restore from checkpoint or rebuild artifacts\./);
  assert.match(plain, /a always allows this target for the rest of the session/);
  assert.match(plain, /y yes · a always · n no · \? less/);
  assert(approvalExpandedRows(request) > approvalCardRows(request));

  const cut = frameLines(renderTuiToFrame(React.createElement(ApprovalOverlay, { request, expanded: true, maxRows: 8 }), { columns: 80, rows: 12 }));
  assert.equal(cut.filter(Boolean).length, 8, "the card keeps to the rows it is given");
  assert.match(cut.filter(Boolean).at(-1) ?? "", /\? less$/, "the keys stay visible");
  assert(cut.every((line) => line.length <= 80), "long lines are cut at the terminal's edge");
});

test("approval keys: y once, a or s for the rest of the session, n, Esc or Ctrl+C no", () => {
  const decide = (character: string, key = {}) => {
    const decision = approvalInputDecision(character, key);
    return decision.handled ? [decision.approved, decision.rememberForSession] : "ignored";
  };
  assert.deepEqual(decide("y"), [true, false]);
  assert.deepEqual(decide("a"), [true, true]);
  assert.deepEqual(decide("s"), [true, true]);
  assert.deepEqual(decide("n"), [false, false]);
  assert.deepEqual(decide("", { escape: true }), [false, false]);
  assert.deepEqual(decide("c", { ctrl: true }), [false, false]);
  assert.equal(decide("?"), "ignored", "? opens the details; the app handles it");
});

test("ApprovalOverlay claims dom-renderer approval keys through focused DOM handler", () => {
  const decisions: string[] = [];
  const root = createTuiRoot({ columns: 80, rows: 12 });

  withTuiRendererMode("dom-renderer", () => {
    root.render(React.createElement(ApprovalOverlay, {
      request: approvalFixture(),
      onDecision(decision) {
        decisions.push(`${decision.approved}:${decision.rememberForSession}`);
      }
    }));
  });

  assert.equal(root.getFocusManager().activeElement?.focusable, true);
  root.dispatchInput("a");
  root.dispatchInput(undefined, { escape: true });

  assert.deepEqual(decisions, ["true:true", "false:false"]);
  root.unmount();
});

test("a plan waiting for approval is the same short card", () => {
  const frame = renderTuiToFrame(React.createElement(PlanApprovalOverlay, {
    summary: "Refactor the TUI footer and command-output focus flow.\nSecond line is not shown.",
    taskCount: 3
  }), { columns: 96, rows: PLAN_CARD_ROWS });
  const lines = frameLines(frame);

  assert.match(lines[0] ?? "", /^─{96}$/);
  assert.equal(lines[1], " ? Run this plan  Refactor the TUI footer and command-output focus flow. · 3 tasks");
  assert.equal(lines[2], "   y yes · n no · Ctrl+O plan");
  assert.equal(colorAtText(frame, "?"), resolveTuiColor("status.pending"));
  assert.equal(colorAtText(frame, "· 3 tasks"), resolveTuiColor("text.muted"));
});

function frameLines(frame: TuiFrame): string[] {
  return frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd());
}

function approvalFixture(): ToolApprovalRequest {
  return {
    id: "approval-1",
    action: "shell.exec",
    summary: "Delete generated files under the workspace.",
    detail: "cwd=E:/Playground/Swarm\ncommand=Remove-Item -Recurse build",
    risk: "shell",
    risk_class: "r4",
    target: "Remove-Item -Recurse build",
    why_now: "The build folder must be cleared before rerunning tests.",
    predicted_impact: "Deletes generated output.",
    rollback_plan: "Restore from checkpoint or rebuild artifacts.",
    permission_decision: "ask",
    permission_reason: "Destructive shell command requires explicit approval.",
    permission_name: "shell.exec",
    permission_rule: "r4 shell",
    governance: {
      schema_version: "swarm.safety_governance.v1",
      approval_id: "approval-1",
      status: "requested",
      action: "shell.exec",
      risk: "shell",
      risk_class: "r4",
      actor_id: "worker:safety",
      actor_binding: {
        actor_id: "worker:safety",
        session_id: "session-approval",
        task_id: "task-approval"
      },
      scope: {
        kind: "shell",
        target: "Remove-Item -Recurse build",
        actions: ["shell.exec"],
        resources: ["Remove-Item -Recurse build"],
        permission_name: "shell.exec",
        risk_class: "r4"
      },
      ttl_ms: 900000,
      expires_at: "2026-05-26T00:15:00.000Z",
      permission_mode: "ask",
      permission_decision: "ask",
      permission_name: "shell.exec",
      permission_rule: "r4 shell",
      decision_source: "test",
      policy_evidence: ["risk=r4/shell"],
      created_at: "2026-05-26T00:00:00.000Z"
    },
    summary_diff: "- build/old.js\n+ (deleted)"
  };
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
