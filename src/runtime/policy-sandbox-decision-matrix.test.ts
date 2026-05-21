import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultSwarmSettings, type PermissionMode, type SwarmSettings } from "../config/settings.js";
import type { TaskStateSnapshot } from "../protocol/types.js";
import { decideToolPermission } from "../tools/permissions.js";
import type { ToolAction } from "../tools/types.js";
import { buildPermissionReport } from "./permission-report.js";
import { decideToolActionSandbox, type SandboxWritePolicy } from "./sandbox-policy.js";
import { taskContractForToolAction } from "./tool-task-sandbox.js";
import { buildTaskContractSnapshot } from "./work-contracts.js";

const NOW = "2026-05-12T00:00:00.000Z";
const workspace = process.cwd();

test("policy-sandbox decision matrix preserves representative cross-layer contracts", () => {
  const cases: Array<{
    name: string;
    action: ToolAction;
    mode: PermissionMode;
    permissionRules?: Partial<SwarmSettings["permissions"]>;
    sandboxPolicy: SandboxWritePolicy;
    fileScope?: string[];
    contractOptions?: Parameters<typeof taskContractForToolAction>[1];
    reportSandboxMode?: "workspace-write" | "read-only";
    expectedPermission: {
      decision: "allow" | "ask" | "deny";
      permissionName: string;
      matchedRule?: string;
    };
    expectedSandbox: {
      decision: "allow" | "deny";
      targets?: string[];
      fileScope?: string[];
      reason?: RegExp;
    };
    expectedContract: {
      writePolicy?: SandboxWritePolicy;
      fileScope?: string[];
    };
    expectedSummary: {
      readOnly?: number;
      scopedWrite?: number;
      workspaceWrite?: number;
      scopedTargets?: string[];
    };
    expectedReportText: RegExp[];
  }> = [
    {
      name: "deny rule wins before explicit write allow",
      action: writeAction("src/runtime/blocked.ts"),
      mode: "auto-edit",
      permissionRules: {
        allow: ["Write(src/runtime/blocked.ts)"],
        deny: ["Write(src/runtime/blocked.ts)"]
      },
      sandboxPolicy: "workspace_write",
      expectedPermission: {
        decision: "deny",
        permissionName: "Write",
        matchedRule: "Write(src/runtime/blocked.ts)"
      },
      expectedSandbox: { decision: "allow" },
      expectedContract: {
        writePolicy: "scoped_write",
        fileScope: ["src/runtime/blocked.ts"]
      },
      expectedSummary: {
        scopedWrite: 1,
        scopedTargets: ["src/runtime/blocked.ts"]
      },
      expectedReportText: [/deny rules are checked first and always win/]
    },
    {
      name: "explicit allow permits exact r4 destructive shell while report keeps r4 guardrail text",
      action: shellAction("git reset --hard HEAD"),
      mode: "yolo",
      permissionRules: {
        allow: ["Bash(git reset --hard HEAD)"]
      },
      sandboxPolicy: "workspace_write",
      contractOptions: { writePolicy: "workspace_write" },
      expectedPermission: {
        decision: "allow",
        permissionName: "Bash",
        matchedRule: "Bash(git reset --hard HEAD)"
      },
      expectedSandbox: { decision: "allow" },
      expectedContract: {
        writePolicy: "workspace_write"
      },
      expectedSummary: {
        workspaceWrite: 1
      },
      expectedReportText: [
        /allow rules bypass mode defaults, including ask-mode prompts and the destructive-shell guard/,
        /full-auto and yolo still ask for r4 destructive shell actions unless explicitly allowed/,
        /Bash\(git reset --hard HEAD\)/
      ]
    },
    {
      name: "auto-edit permission allows write but read-only sandbox denies the same action",
      action: writeAction("src/runtime/generated.ts"),
      mode: "auto-edit",
      sandboxPolicy: "read_only",
      reportSandboxMode: "read-only",
      expectedPermission: {
        decision: "allow",
        permissionName: "Write"
      },
      expectedSandbox: {
        decision: "deny",
        reason: /Read-only sandbox denied tool action: file\.write/
      },
      expectedContract: {
        writePolicy: "read_only"
      },
      expectedSummary: {
        readOnly: 1
      },
      expectedReportText: [
        /auto-edit: file edits and other write-like actions auto-allow/,
        /read-only: workspace writes, shell execution, package install, delegation, and durable mutations are denied/
      ]
    },
    {
      name: "scoped-write in-scope write keeps delegated target consistent",
      action: writeAction("src/runtime/policy-sandbox-decision-matrix.test.ts"),
      mode: "auto-edit",
      sandboxPolicy: "scoped_write",
      fileScope: ["src/runtime"],
      expectedPermission: {
        decision: "allow",
        permissionName: "Write"
      },
      expectedSandbox: {
        decision: "allow",
        targets: ["src/runtime/policy-sandbox-decision-matrix.test.ts"],
        fileScope: ["src/runtime"]
      },
      expectedContract: {
        writePolicy: "scoped_write",
        fileScope: ["src/runtime"]
      },
      expectedSummary: {
        scopedWrite: 1,
        scopedTargets: ["src/runtime"]
      },
      expectedReportText: [/workspace-write: workspace writes are allowed when the permission policy allows them/]
    },
    {
      name: "scoped-write out-of-scope write denies and reports delegated scope",
      action: writeAction("docs/PRD.md"),
      mode: "auto-edit",
      sandboxPolicy: "scoped_write",
      fileScope: ["src/runtime"],
      expectedPermission: {
        decision: "allow",
        permissionName: "Write"
      },
      expectedSandbox: {
        decision: "deny",
        targets: ["docs/PRD.md"],
        fileScope: ["src/runtime"],
        reason: /outside file_scope \(docs\/PRD\.md\)/
      },
      expectedContract: {
        writePolicy: "scoped_write",
        fileScope: ["src/runtime"]
      },
      expectedSummary: {
        scopedWrite: 1,
        scopedTargets: ["src/runtime"]
      },
      expectedReportText: [/Rule precedence/]
    },
    {
      name: "read-only action stays read-only in permission sandbox and task summary",
      action: { type: "file.read", path: "src/runtime/sandbox-policy.ts" },
      mode: "ask",
      sandboxPolicy: "read_only",
      reportSandboxMode: "read-only",
      expectedPermission: {
        decision: "allow",
        permissionName: "Read",
        matchedRule: "Read(**)"
      },
      expectedSandbox: { decision: "allow" },
      expectedContract: {
        writePolicy: "read_only"
      },
      expectedSummary: {
        readOnly: 1
      },
      expectedReportText: [
        /read-only and low-risk actions stay allowed unless a deny rule matches/,
        /read-only: read-only file, git inspection, process inspection, and bounded web tools still run/
      ]
    }
  ];

  for (const item of cases) {
    const settings = settingsForMode(item.mode, item.permissionRules);
    const permission = decideToolPermission(item.action, settings, { workspace });
    const sandbox = decideToolActionSandbox(item.action, {
      writePolicy: item.sandboxPolicy,
      workspace,
      fileScope: item.fileScope
    });
    const contract = taskContractForToolAction(
      item.action,
      item.contractOptions ?? { writePolicy: item.sandboxPolicy, fileScope: item.fileScope }
    );
    const taskSnapshot = buildTaskContractSnapshot([
      taskFromContract(`task-${cases.indexOf(item)}`, item.name, item.action, contract)
    ]);
    const report = buildPermissionReport({
      permissions: settings.permissions,
      sandboxMode: item.reportSandboxMode ?? "workspace-write",
      workspace
    });

    assert.equal(permission.decision, item.expectedPermission.decision, item.name);
    assert.equal(permission.permission_name, item.expectedPermission.permissionName, item.name);
    assert.equal(permission.matched_rule, item.expectedPermission.matchedRule, item.name);

    assert.equal(sandbox.decision, item.expectedSandbox.decision, item.name);
    assert.equal(sandbox.policy, item.sandboxPolicy, item.name);
    assert.equal(sandbox.subject, "tool_action", item.name);
    assert.equal(sandbox.action, item.action.type, item.name);
    if (item.expectedSandbox.targets) {
      assert.deepEqual(sandbox.targets, item.expectedSandbox.targets, item.name);
    }
    if (item.expectedSandbox.fileScope) {
      assert.deepEqual(sandbox.file_scope, item.expectedSandbox.fileScope, item.name);
    }
    if (item.expectedSandbox.reason) {
      assert.match(sandbox.reason, item.expectedSandbox.reason, item.name);
    }

    assert.equal(contract.write_policy, item.expectedContract.writePolicy, item.name);
    assert.deepEqual(contract.file_scope, item.expectedContract.fileScope, item.name);

    assert.equal(taskSnapshot.summary.read_only, item.expectedSummary.readOnly ?? 0, item.name);
    assert.equal(taskSnapshot.summary.scoped_write, item.expectedSummary.scopedWrite ?? 0, item.name);
    assert.equal(taskSnapshot.summary.workspace_write, item.expectedSummary.workspaceWrite ?? 0, item.name);
    if (item.expectedSummary.scopedTargets) {
      assert.deepEqual(taskSnapshot.summary.scoped_targets, item.expectedSummary.scopedTargets, item.name);
    }

    for (const pattern of item.expectedReportText) {
      assert.match(report.detail, pattern, item.name);
    }
  }
});

function settingsForMode(
  mode: PermissionMode,
  permissionRules: Partial<SwarmSettings["permissions"]> = {}
): SwarmSettings {
  const settings = defaultSwarmSettings();
  settings.permissions.defaultMode = mode;
  settings.permissions.allow = [
    ...settings.permissions.allow,
    ...(permissionRules.allow ?? [])
  ];
  settings.permissions.ask = permissionRules.ask ?? settings.permissions.ask;
  settings.permissions.deny = [
    ...settings.permissions.deny,
    ...(permissionRules.deny ?? [])
  ];
  settings.permissions.additionalDirectories =
    permissionRules.additionalDirectories ?? settings.permissions.additionalDirectories;
  return settings;
}

function taskFromContract(
  taskId: string,
  title: string,
  action: ToolAction,
  contract: ReturnType<typeof taskContractForToolAction>
): TaskStateSnapshot {
  return {
    session_id: "policy-sandbox-matrix-session",
    swarm_id: "policy-sandbox-matrix-swarm",
    task_id: taskId,
    title,
    status: "pending",
    attempt: 0,
    required_capabilities: [action.type],
    dependencies: [],
    capability: action.type,
    write_policy: contract.write_policy,
    file_scope: contract.file_scope,
    updated_at: NOW
  };
}

function writeAction(path: string): ToolAction {
  return {
    type: "file.write",
    path,
    content: "export const generated = true;\n"
  };
}

function shellAction(command: string): ToolAction {
  return {
    type: "shell.exec",
    command
  };
}
