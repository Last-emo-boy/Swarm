import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultSwarmSettings, type PermissionMode, type SwarmSettings } from "../config/settings.js";
import type { ToolAction } from "./types.js";
import {
  createToolApprovalRequest,
  decideToolPermission,
  riskClassForAction,
  toolRequiresApproval
} from "./permissions.js";

const workspace = process.cwd();

test("decides representative approval-mode and tool-risk permission branches", () => {
  const cases: Array<{
    name: string;
    mode: PermissionMode;
    action: ToolAction;
    expectedDecision: "allow" | "ask";
    expectedPermission: string;
    expectedRule?: string;
  }> = [
    {
      name: "ask mode asks before file.write",
      mode: "ask",
      action: writeAction("src/generated.ts"),
      expectedDecision: "ask",
      expectedPermission: "Write",
      expectedRule: "Write(**)"
    },
    {
      name: "auto-edit allows file.write without treating baseline ask as custom ask",
      mode: "auto-edit",
      action: writeAction("src/generated.ts"),
      expectedDecision: "allow",
      expectedPermission: "Write"
    },
    {
      name: "auto-edit keeps normal shell.exec approval gated",
      mode: "auto-edit",
      action: shellAction("npm test"),
      expectedDecision: "ask",
      expectedPermission: "Bash",
      expectedRule: "Bash(*)"
    },
    {
      name: "full-auto allows normal shell.exec",
      mode: "full-auto",
      action: shellAction("npm test"),
      expectedDecision: "allow",
      expectedPermission: "Bash"
    },
    {
      name: "yolo allows normal shell.exec",
      mode: "yolo",
      action: shellAction("npm test"),
      expectedDecision: "allow",
      expectedPermission: "Bash"
    },
    {
      name: "yolo allows baseline file.write",
      mode: "yolo",
      action: writeAction("src/generated.ts"),
      expectedDecision: "allow",
      expectedPermission: "Write"
    },
    {
      name: "ask mode allows agent status reads",
      mode: "ask",
      action: { type: "agent.status", worker_id: "worker-1" },
      expectedDecision: "allow",
      expectedPermission: "AgentRead"
    },
    {
      name: "ask mode asks before recalling an agent",
      mode: "ask",
      action: { type: "agent.continue", worker_id: "worker-1", message: "continue" },
      expectedDecision: "ask",
      expectedPermission: "Agent",
      expectedRule: "Agent(*)"
    }
  ];

  for (const item of cases) {
    const decision = decideToolPermission(item.action, settingsForMode(item.mode), { workspace });

    assert.equal(decision.decision, item.expectedDecision, item.name);
    assert.equal(decision.mode, item.mode, item.name);
    assert.equal(decision.permission_name, item.expectedPermission, item.name);
    assert.equal(decision.matched_rule, item.expectedRule, item.name);
  }
});

test("custom ask rules still prompt in yolo after baseline ask rules are bypassed", () => {
  const settings = settingsForMode("yolo");
  settings.permissions.ask = [...settings.permissions.ask, "Bash(npm publish*)"];

  const decision = decideToolPermission(shellAction("npm publish --dry-run"), settings, { workspace });

  assert.equal(decision.decision, "ask");
  assert.equal(decision.mode, "yolo");
  assert.equal(decision.permission_name, "Bash");
  assert.equal(decision.matched_rule, "Bash(npm publish*)");
  assert.match(decision.reason, /Approval required/);
});

test("riskClassForAction detects focused r4 destructive shell wrappers", () => {
  const cases: Array<{ command: string; expected: ReturnType<typeof riskClassForAction> }> = [
    { command: "cmd /c del build.log", expected: "r4" },
    { command: "powershell -Command Remove-Item build.log", expected: "r4" },
    { command: "bash -lc 'rm -rf build'", expected: "r4" },
    { command: "git reset --hard HEAD", expected: "r4" },
    { command: "Get-ChildItem -Path . -Depth 0 | Select-Object Mode, Length, Name | Format-Table -AutoSize", expected: "r2" },
    { command: "npm test", expected: "r2" }
  ];

  for (const item of cases) {
    assert.equal(riskClassForAction(shellAction(item.command)), item.expected, item.command);
  }
});

test("full-auto and yolo still ask for r4 destructive shell unless explicitly allowed", () => {
  const destructiveShell = shellAction("git reset --hard HEAD");
  const destructiveBuild = {
    type: "code.build",
    command: "bash -lc 'rm -rf dist'"
  } satisfies ToolAction;

  const yoloSettings = settingsForMode("yolo");
  const fullAutoSettings = settingsForMode("full-auto");

  const yoloDecision = decideToolPermission(destructiveShell, yoloSettings, { workspace });
  const fullAutoDecision = decideToolPermission(destructiveBuild, fullAutoSettings, { workspace });

  assert.equal(yoloDecision.decision, "ask");
  assert.match(yoloDecision.reason, /destructive command requires approval/);
  assert.match(yoloDecision.reason, /yolo/);
  assert.equal(fullAutoDecision.decision, "ask");
  assert.match(fullAutoDecision.reason, /full-auto/);
  assert.equal(toolRequiresApproval(destructiveShell, yoloSettings, { workspace }), true);
  assert.equal(toolRequiresApproval(destructiveBuild, fullAutoSettings, { workspace }), true);
  assert.equal(toolRequiresApproval(shellAction("npm test"), yoloSettings, { workspace }), false);

  const explicitAllowSettings = settingsForMode("yolo");
  explicitAllowSettings.permissions.allow = ["Bash(git reset --hard HEAD)"];

  const allowedDecision = decideToolPermission(destructiveShell, explicitAllowSettings, { workspace });
  assert.equal(allowedDecision.decision, "allow");
  assert.equal(allowedDecision.matched_rule, "Bash(git reset --hard HEAD)");
  assert.equal(toolRequiresApproval(destructiveShell, explicitAllowSettings, { workspace }), false);
});

test("createToolApprovalRequest includes r4 destructive shell permission evidence", () => {
  const action = shellAction("git reset --hard HEAD", { cwd: "repo", timeoutMs: 30000 });
  const decision = decideToolPermission(action, settingsForMode("yolo"), { workspace });
  const request = createToolApprovalRequest(action, decision);

  assert.equal(request.risk, "shell");
  assert.equal(request.risk_class, "r4");
  assert.match(request.summary, /Run destructive shell command/);
  assert.match(request.summary, /git reset --hard HEAD/);
  assert.match(request.detail, /Warning: Destructive shell command detected/);
  assert.match(request.detail, /Command: git reset --hard HEAD/);
  assert.match(request.detail, /CWD: repo/);
  assert.match(request.detail, /Timeout: 30000 ms/);
  assert.match(request.attention_note ?? "", /Destructive shell command detected/);
  assert.match(request.predicted_impact, /destructive local command/);
  assert.match(request.rollback_plan, /No automatic rollback/);
  assert.equal(request.permission_decision, "ask");
  assert.equal(request.permission_mode, "yolo");
  assert.equal(request.permission_name, "Bash");
  assert.equal(request.permission_reason, decision.reason);
});

function settingsForMode(mode: PermissionMode): SwarmSettings {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = mode;
  return settings;
}

function writeAction(path: string): ToolAction {
  return {
    type: "file.write",
    path,
    content: "export const generated = true;\n"
  };
}

function shellAction(command: string, overrides: Partial<Extract<ToolAction, { type: "shell.exec" }>> = {}): ToolAction {
  return {
    type: "shell.exec",
    command,
    ...overrides
  };
}
