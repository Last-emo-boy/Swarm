import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { render } from "ink";
import type { ToolApprovalRequest } from "../tools/types.js";
import { ApprovalOverlay } from "./components/ApprovalOverlay.js";

test("ApprovalOverlay puts decision controls before high-risk detail", async () => {
  const plain = stripAnsi(await renderElement(React.createElement(ApprovalOverlay, {
    request: {
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
      summary_diff: "- build/old.js\n+ (deleted)"
    } satisfies ToolApprovalRequest
  })));

  const decisionIndex = plain.indexOf("DECISION Y approve once");
  const riskIndex = plain.indexOf("[HIGH] R4/SHELL shell.exec");
  const targetIndex = plain.indexOf("TARGET Remove-Item -Recurse build");
  const impactIndex = plain.indexOf("IMPACT Deletes generated output.");
  const rollbackIndex = plain.indexOf("ROLLBACK Restore from checkpoint or rebuild artifacts.");

  assert(decisionIndex >= 0);
  assert(riskIndex > decisionIndex);
  assert(targetIndex > riskIndex);
  assert(impactIndex > targetIndex);
  assert(rollbackIndex > impactIndex);
  assert.match(plain, /Destructive shell command detected/);
  assert.match(plain, /PREVIEW/);
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
