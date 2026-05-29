import { strict as assert } from "node:assert";
import test from "node:test";
import { SKILL_ACTIVATE_CAPABILITY_ID } from "../extensions/skills.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import type { ToolAction } from "../tools/types.js";
import {
  assertCapabilityAllowedBySandbox,
  assertToolActionAllowedBySandbox,
  decideCapabilitySandbox,
  decideToolActionSandbox,
  SandboxPolicyError
} from "./sandbox-policy.js";

const workspace = process.cwd();

test("read-only sandbox allows code.build as verification", () => {
  assert.doesNotThrow(() => assertToolActionAllowedBySandbox({
    type: "code.build",
    command: "npm run build"
  }, {
    writePolicy: "read_only",
    workspace: process.cwd()
  }));
});

test("read-only sandbox denies slash command capabilities", () => {
  assert.throws(() => assertCapabilityAllowedBySandbox(slashCommandCapability(), "read_only"), SandboxPolicyError);
});

test("read-only sandbox permits only conservative powershell.exec inspection commands", () => {
  const allowed = decideToolActionSandbox({
    type: "powershell.exec",
    command: "Get-ChildItem . | Select-Object Name"
  }, {
    writePolicy: "read_only",
    workspace
  });
  assert.equal(allowed.decision, "allow");

  const denied = decideToolActionSandbox({
    type: "powershell.exec",
    command: "Remove-Item build.log"
  }, {
    writePolicy: "read_only",
    workspace
  });
  assert.equal(denied.decision, "deny");

  const unknown = decideToolActionSandbox({
    type: "powershell.exec",
    command: "Invoke-RestMethod https://example.test"
  }, {
    writePolicy: "read_only",
    workspace
  });
  assert.equal(unknown.decision, "deny");
});

test("read-only sandbox permits conservative shell.exec inspection commands only", () => {
  const allowed = [
    "rg missing-pattern src",
    "git status --short",
    "git branch --list",
    "sed -n '1,20p' src/runtime/sandbox-policy.ts"
  ];
  for (const command of allowed) {
    const decision = decideToolActionSandbox({
      type: "shell.exec",
      command
    }, {
      writePolicy: "read_only",
      workspace
    });
    assert.equal(decision.decision, "allow", command);
  }

  const denied = [
    "sed -i 's/a/b/' src/index.ts",
    "git branch -D old-work",
    "git reset --hard HEAD",
    "npm test"
  ];
  for (const command of denied) {
    const decision = decideToolActionSandbox({
      type: "shell.exec",
      command
    }, {
      writePolicy: "read_only",
      workspace
    });
    assert.equal(decision.decision, "deny", command);
  }
});

test("decides representative tool actions for each write policy", () => {
  const cases: Array<{
    name: string;
    action: ToolAction;
    writePolicy: "workspace_write" | "read_only" | "scoped_write";
    expectedDecision: "allow" | "deny";
    fileScope?: string[];
  }> = [
    {
      name: "workspace_write permits writes without delegated scope",
      action: { type: "file.write", path: "docs/notes.md", content: "notes" },
      writePolicy: "workspace_write",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits read-only file reads",
      action: { type: "file.read", path: "src/runtime/sandbox-policy.ts" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies write actions",
      action: { type: "file.write", path: "src/runtime/sandbox-policy.test.ts", content: "test" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "scoped_write permits read-only actions without scope targets",
      action: { type: "code.build", command: "npm run check" },
      writePolicy: "scoped_write",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits agent status inspection",
      action: { type: "agent.status", worker_id: "worker-1" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits task output inspection",
      action: { type: "task.output", task_id: "task-1" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies task updates",
      action: { type: "task.update", task_id: "task-1", status: "running" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies worktree entry",
      action: { type: "worktree.enter", name: "task-7", dry_run: true },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only permits structured user questions",
      action: { type: "ask_user_question", prompt: "Choose next step" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits plan mode entry",
      action: { type: "plan.enter", objective: "Plan the change" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits plan approval handoff",
      action: { type: "plan.exit", plan: "1. Inspect\n2. Verify", summary: "Plan ready" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies agent continuation",
      action: { type: "agent.continue", worker_id: "worker-1", message: "continue" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies peer agent messages",
      action: { type: "agent.message", worker_id: "worker-1", message: "ping" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only permits runtime sleeps",
      action: { type: "runtime.sleep", duration_ms: 0 },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits structured output records",
      action: { type: "structured.output", value: { ok: true } },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits REPL mode guidance",
      action: { type: "repl.mode", mode: "interactive" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only permits safe config reads",
      action: { type: "config.get", setting: "tools.webSearch" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies config writes",
      action: { type: "config.set", setting: "tools.webSearch", value: false },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only permits MCP resource reads",
      action: { type: "mcp.read", server: "docs", uri: "file://guide.md" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies dynamic MCP calls",
      action: { type: "mcp.call", server: "docs", tool: "search", args: { q: "Swarm" } },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies skill activation",
      action: { type: "skill.invoke", name: "quality-review" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only permits schedule listing",
      action: { type: "schedule.list" },
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies schedule creation",
      action: { type: "schedule.create", cron: "0 9 * * 1", prompt: "Run weekly verification" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies schedule deletion",
      action: { type: "schedule.delete", schedule_id: "sched-1" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies remote triggers",
      action: { type: "remote.trigger", endpoint: "ci", payload: { ref: "main" } },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies team creation",
      action: { type: "team.create", objective: "Review the release" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies team deletion",
      action: { type: "team.delete", team_id: "team-1" },
      writePolicy: "read_only",
      expectedDecision: "deny"
    }
  ];

  for (const testCase of cases) {
    const decision = decideToolActionSandbox(testCase.action, {
      writePolicy: testCase.writePolicy,
      workspace,
      fileScope: testCase.fileScope
    });

    assert.equal(decision.decision, testCase.expectedDecision, testCase.name);
    assert.equal(decision.policy, testCase.writePolicy, testCase.name);
    assert.equal(decision.subject, "tool_action", testCase.name);
    assert.equal(decision.action, testCase.action.type, testCase.name);
  }
});

test("scoped-write sandbox enforces file_scope for representative write targets", () => {
  const cases: Array<{
    name: string;
    action: ToolAction;
    fileScope: string[];
    expectedDecision: "allow" | "deny";
    expectedTargets: string[];
    expectedFileScope: string[];
  }> = [
    {
      name: "in-scope path is allowed",
      action: { type: "file.write", path: "src/runtime/sandbox-policy.test.ts", content: "test" },
      fileScope: ["src/runtime"],
      expectedDecision: "allow",
      expectedTargets: ["src/runtime/sandbox-policy.test.ts"],
      expectedFileScope: ["src/runtime"]
    },
    {
      name: "out-of-scope path is denied",
      action: { type: "file.write", path: "docs/PRD.md", content: "test" },
      fileScope: ["src/runtime"],
      expectedDecision: "deny",
      expectedTargets: ["docs/PRD.md"],
      expectedFileScope: ["src/runtime"]
    },
    {
      name: "glob scope is allowed",
      action: {
        type: "file.patch",
        path: "src/runtime/sandbox-policy.test.ts",
        hunks: [{ oldText: "old", newText: "new" }]
      },
      fileScope: ["src/**/*.test.ts"],
      expectedDecision: "allow",
      expectedTargets: ["src/runtime/sandbox-policy.test.ts"],
      expectedFileScope: ["src/**/*.test.ts"]
    }
  ];

  for (const testCase of cases) {
    const decision = decideToolActionSandbox(testCase.action, {
      writePolicy: "scoped_write",
      workspace,
      fileScope: testCase.fileScope
    });

    assert.equal(decision.decision, testCase.expectedDecision, testCase.name);
    assert.equal(decision.policy, "scoped_write", testCase.name);
    assert.equal(decision.subject, "tool_action", testCase.name);
    assert.equal(decision.action, testCase.action.type, testCase.name);
    assert.deepEqual(decision.targets, testCase.expectedTargets, testCase.name);
    assert.deepEqual(decision.file_scope, testCase.expectedFileScope, testCase.name);
  }
});

test("decides read-only and scoped-write capability branches", () => {
  const cases: Array<{
    name: string;
    capability: CapabilityDescriptor;
    writePolicy: "read_only" | "scoped_write";
    expectedDecision: "allow" | "deny";
  }> = [
    {
      name: "read_only permits r0 read-only capabilities",
      capability: capability({ id: "capability.inspect", riskClass: "r0", readOnly: true }),
      writePolicy: "read_only",
      expectedDecision: "allow"
    },
    {
      name: "read_only denies high-risk write capabilities",
      capability: slashCommandCapability(),
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "read_only denies skill activation before r0 read-only allow",
      capability: capability({
        id: SKILL_ACTIVATE_CAPABILITY_ID,
        kind: "skill",
        providerId: "skills",
        name: SKILL_ACTIVATE_CAPABILITY_ID,
        riskClass: "r0",
        readOnly: true
      }),
      writePolicy: "read_only",
      expectedDecision: "deny"
    },
    {
      name: "scoped_write permits skill activation",
      capability: capability({
        id: SKILL_ACTIVATE_CAPABILITY_ID,
        kind: "skill",
        providerId: "skills",
        name: SKILL_ACTIVATE_CAPABILITY_ID,
        riskClass: "r2"
      }),
      writePolicy: "scoped_write",
      expectedDecision: "allow"
    },
    {
      name: "scoped_write denies non-read-only write capabilities",
      capability: capability({ id: "capability.write", riskClass: "r1", readOnly: false }),
      writePolicy: "scoped_write",
      expectedDecision: "deny"
    }
  ];

  for (const testCase of cases) {
    const decision = decideCapabilitySandbox(testCase.capability, testCase.writePolicy);

    assert.equal(decision.decision, testCase.expectedDecision, testCase.name);
    assert.equal(decision.policy, testCase.writePolicy, testCase.name);
    assert.equal(decision.subject, "capability", testCase.name);
    assert.equal(decision.capability_id, testCase.capability.id, testCase.name);
  }
});

function capability(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  const id = overrides.id ?? "capability.default";
  return {
    id,
    kind: "local_tool",
    source: "builtin",
    trust: "trusted",
    providerId: "test-provider",
    name: id,
    description: "Test capability.",
    riskClass: "r0",
    permissionName: id,
    modelVisible: true,
    userVisible: true,
    status: "available",
    ...overrides
  };
}

function slashCommandCapability(): CapabilityDescriptor {
  return capability({
    id: "custom-command.release",
    kind: "slash_command",
    source: "project",
    trust: "trusted",
    providerId: "custom-command",
    name: "/release",
    description: "Run a project release command.",
    riskClass: "r2",
    permissionName: "slash.command(release)",
    modelVisible: true,
    userVisible: true,
    status: "available"
  });
}
