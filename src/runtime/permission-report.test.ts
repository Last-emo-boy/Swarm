import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultSwarmSettings, type PermissionMode } from "../config/settings.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { buildPermissionReport } from "./permission-report.js";

const workspace = process.cwd();

test("permission report describes auto-edit shell ask and sandbox context", () => {
  const settings = settingsForMode("auto-edit");
  const report = buildPermissionReport({
    permissions: settings.permissions,
    sandboxMode: "workspace-write",
    workspace
  });

  assert.match(report.brief, /Permissions: auto-edit\./);
  assert.match(report.brief, /Sandbox: workspace-write\./);
  assert.match(report.detail, /auto-edit: file edits and other write-like actions auto-allow/);
  assert.match(report.detail, /auto-edit: shell, exec, package install, delegate, and branch changes still ask/);
  assert.match(report.detail, /workspace-write: workspace writes are allowed when the permission policy allows them/);
});

test("permission report describes full-auto and yolo r4/custom ask precedence", () => {
  const fullAuto = buildPermissionReport({
    permissions: settingsForMode("full-auto").permissions,
    sandboxMode: "read-only",
    workspace
  });
  const yoloSettings = settingsForMode("yolo");
  yoloSettings.permissions.ask = [...yoloSettings.permissions.ask, "Bash(npm publish*)"];
  const yolo = buildPermissionReport({
    permissions: yoloSettings.permissions,
    workspace
  });

  assert.match(fullAuto.detail, /full-auto: edits, shell, exec, package install, delegate, fetch, and branch changes auto-allow/);
  assert.match(fullAuto.detail, /full-auto: r4 destructive shell actions still stop for approval unless explicitly allowed/);
  assert.match(fullAuto.detail, /read-only: workspace writes, shell execution, package install, delegation, and durable mutations are denied/);

  assert.match(yolo.detail, /custom ask rules override mode defaults, including full-auto and yolo bypasses/);
  assert.match(yolo.detail, /baseline ask catalog entries do not cancel full-auto or yolo by themselves/);
  assert.match(yolo.detail, /full-auto and yolo still ask for r4 destructive shell actions unless explicitly allowed/);
  assert.match(yolo.detail, /yolo: custom ask rules and r4 destructive shell still stop for approval unless explicitly allowed/);
  assert.match(yolo.detail, /Bash\(npm publish\*\)/);
});

test("permission report includes recent approval counts and r4 approval rows", () => {
  const report = buildPermissionReport({
    permissions: settingsForMode("yolo").permissions,
    workspace,
    recentApprovals: [
      approvalRecord("approval-pending", "pending", "r4"),
      approvalRecord("approval-approved", "approved", "r2"),
      approvalRecord("approval-denied", "denied", "r4")
    ]
  });

  assert.match(report.brief, /Approvals pending=1 approved=1 denied=1/);
  assert.match(report.detail, /summary: pending=1 approved=1 denied=1/);
  assert.match(report.detail, /\[pending\/r4\] shell.exec target=repo rule=Bash\(git reset --hard HEAD\)/);
  assert.match(report.detail, /\[approved\/r2\] shell.exec target=repo/);
  assert.match(report.detail, /\[denied\/r4\] shell.exec target=repo/);
});

function settingsForMode(mode: PermissionMode) {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = mode;
  return settings;
}

function approvalRecord(approvalId: string, status: ApprovalRecord["status"], riskClass: ApprovalRecord["risk_class"]): ApprovalRecord {
  const challenge: ToolApprovalRequest = {
    id: approvalId,
    action: "shell.exec",
    summary: "Run destructive shell command: git reset --hard HEAD",
    detail: "Command: git reset --hard HEAD",
    risk: "shell",
    risk_class: riskClass,
    target: "repo",
    why_now: "Test approval reporting.",
    predicted_impact: "Runs a local command.",
    rollback_plan: "Task-specific.",
    permission_rule: riskClass === "r4" ? "Bash(git reset --hard HEAD)" : undefined
  };
  return {
    approval_id: approvalId,
    action: "shell.exec",
    summary: challenge.summary,
    detail: challenge.detail,
    risk: "shell",
    risk_class: riskClass,
    target: "repo",
    status,
    challenge,
    created_at: "2026-05-12T00:00:00.000Z",
    updated_at: "2026-05-12T00:00:00.000Z"
  };
}
