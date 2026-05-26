import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { render, withTuiRendererMode } from "./ui.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { ApprovalOverlay } from "./components/ApprovalOverlay.js";
import { PlanApprovalOverlay } from "./components/PlanApprovalOverlay.js";
import { createTuiRoot } from "./renderer/root.js";
import type { TuiFrame } from "./renderer/frame.js";
import { renderTuiToFrame } from "./renderer/testing.js";
import { resolveTuiColor } from "./theme.js";

test("ApprovalOverlay puts decision controls before high-risk detail", async () => {
  const plain = stripAnsi(await renderElement(React.createElement(ApprovalOverlay, {
    request: approvalFixture()
  })));

  const decisionIndex = plain.indexOf("DECISION Y approve once");
  const riskIndex = plain.indexOf("[HIGH] R4/SHELL shell.exec · TARGET Remove-Item -Recurse build");
  const summaryIndex = plain.indexOf("SUMMARY Delete generated files under the workspace.");
  const impactIndex = plain.indexOf("IMPACT Deletes generated output.");
  const rollbackIndex = plain.indexOf("ROLLBACK Restore from checkpoint or rebuild artifacts.");

  assert(decisionIndex >= 0);
  assert(riskIndex > decisionIndex);
  assert(summaryIndex > riskIndex);
  assert(impactIndex > summaryIndex);
  assert(rollbackIndex > impactIndex);
  assert.doesNotMatch(plain, /[┌┐└┘]/);
  assert.match(plain, /^\s*─{20,}/m);
  assert.match(plain, /Destructive shell command detected/);
  assert.match(plain, /GOVERNANCE actor=worker:safety scope=Remove-Item -Recurse build ttl=900000ms/);
  assert.match(plain, /PREVIEW/);
});

test("ApprovalOverlay renders compact risk row with top divider and local accents", () => {
  const frame = renderTuiToFrame(React.createElement(ApprovalOverlay, {
    request: approvalFixture()
  }), { columns: 100, rows: 12 });
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).join("\n");

  assert.match(plain, /^\s*─{20,}/m);
  assert.match(plain, /\[HIGH\] R4\/SHELL shell\.exec · TARGET Remove-Item -Recurse build/);
  assert.equal(colorAtText(frame, "[HIGH]"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "TARGET"), resolveTuiColor("role.gateway"));
  assert.equal(colorAtText(frame, "SUMMARY"), resolveTuiColor("text.muted"));
  assert.equal(colorAtText(frame, "Delete generated files"), resolveTuiColor("status.danger"));
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
  root.dispatchInput("s");
  root.dispatchInput(undefined, { escape: true });

  assert.deepEqual(decisions, ["true:true", "false:false"]);
  root.unmount();
});

test("PlanApprovalOverlay renders pending plan controls with semantic colors", () => {
  const frame = renderTuiToFrame(React.createElement(PlanApprovalOverlay, {
    summary: "Refactor the TUI footer and command-output focus flow.",
    taskCount: 3
  }), { columns: 96, rows: 5 });
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("")).join("\n");

  assert.match(plain, /PLAN APPROVAL/);
  assert.match(plain, /Refactor the TUI footer/);
  assert.match(plain, /y approve/);
  assert.match(plain, /^\s*─{20,}/m);
  assert.doesNotMatch(plain, /[┌┐└┘]/);
  assert.equal(colorAtText(frame, "[?]"), resolveTuiColor("status.pending"));
  assert.equal(colorAtText(frame, "REVIEW"), resolveTuiColor("role.gateway"));
  assert.equal(colorAtText(frame, "Refactor the TUI footer"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "[ASK]"), resolveTuiColor("status.pending"));
  assert.equal(colorAtText(frame, "y approve"), resolveTuiColor("text.muted"));
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
