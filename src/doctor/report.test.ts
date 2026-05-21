import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { McpServerRecord } from "../extensions/mcp.js";
import type { PluginRecord } from "../extensions/plugins.js";
import type { SkillRecord } from "../extensions/skills.js";
import type { CustomCommandRecord } from "../extensions/custom-commands.js";
import { buildDoctorReport } from "./report.js";

test("doctor report includes model, kernel store, extension, and Symphony sections", async () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-doctor-"));
  try {
    const workspaceRoot = join(root, "workspaces");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(root, "WORKFLOW.md"),
      [
        "---",
        "work_source:",
        "  kind: fake",
        "workspace:",
        `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
        "agent:",
        "  max_concurrent_agents: 2",
        "---",
        "Implement {{issue.identifier}}"
      ].join("\n"),
      "utf8"
    );

    const report = await buildDoctorReport({
      workspace: root,
      runtime: doctorRuntime(root)
    });

    assert.match(report.detail, /Swarm Doctor/);
    assert.match(report.detail, /Paths/);
    assert.match(report.detail, /Models/);
    assert.match(report.detail, /Permissions/);
    assert.match(report.detail, /Kernel Stores/);
    assert.match(report.detail, /sessions=1 attempts=1 leases=1 workers=1 handoffs=1/);
    assert.match(report.detail, /pending_approvals=1 approvals=1/);
    assert.match(report.detail, /Extensions/);
    assert.match(report.detail, /commands total=1 active=1 trusted=1/);
    assert.match(report.detail, /skills total=1 active=1 trusted=1/);
    assert.match(report.detail, /plugins total=1 trusted=1 slash_commands=1/);
    assert.match(report.detail, /mcp servers=1 connected=1 pending=0 failed=0 disabled=0/);
    assert.match(report.detail, /Symphony/);
    assert.match(report.detail, /workflow=.*WORKFLOW\.md/);
    assert.match(report.detail, /preflight issues=0/);
    assert.equal(report.ok, report.failed === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor report warns and skips preflight when workflow is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-doctor-missing-"));
  try {
    const report = await buildDoctorReport({
      workspace: root,
      runtime: doctorRuntime(root),
      workflowPath: "missing-WORKFLOW.md"
    });

    assert.match(report.detail, /Symphony/);
    assert.match(report.detail, /WARN missing_workflow_file:/);
    assert.doesNotMatch(report.detail, /preflight issues=/);
    assert.equal(report.ok, report.failed === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function doctorRuntime(workspace: string): SwarmRuntime {
  return {
    workspaceRoot: () => workspace,
    getWorkspacePath: () => workspace,
    listRecentSessionsForWorkspace: () => [
      {
        session_id: "session-1",
        swarm_id: "swarm-1",
        objective: "Test",
        status: "running",
        policy_json: "{}",
        participants_json: "[]",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }
    ],
    listRecentAttemptsForWorkspace: () => [
      {
        attempt_id: "attempt-1",
        session_id: "session-1",
        kind: "swarm_task",
        status: "started",
        attempt: 0,
        started_at: "2026-05-11T00:00:00.000Z",
        last_event_at: "2026-05-11T00:00:00.000Z",
        metadata: {}
      }
    ],
    listRecentLeasesForWorkspace: () => [
      {
        lease_id: "lease-1",
        session_id: "session-1",
        workspace_root: workspace,
        workspace_path: workspace,
        scope: [],
        write_boundary: "workspace",
        created_at: "2026-05-11T00:00:00.000Z",
        metadata: {}
      }
    ],
    listRecentApprovalsForWorkspace: () => [approvalRecord()],
    listRecentWorkersForWorkspace: () => [
      {
        worker_id: "worker-1",
        parent_session_id: "session-1",
        capability: "code.review",
        objective: "Review",
        status: "running",
        file_scope_json: "[]",
        tool_budget_json: "{}",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }
    ],
    listHandoffsForWorkspace: () => [
      {
        handoff_id: "handoff-1",
        worker_id: "worker-1",
        parent_session_id: "session-1",
        source_agent: "main",
        target_agent_spec_id: "reviewer",
        reason: "Need review",
        status: "active",
        task_packet_json: "{}",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }
    ],
    listRecentBlackboardForWorkspace: () => [
      {
        entry_id: "bb-1",
        swarm_id: "swarm-1",
        session_id: "session-1",
        key: "fact",
        value: { ok: true },
        type: "observation",
        created_by: { agent_id: "test" },
        created_at: "2026-05-11T00:00:00.000Z",
        visibility: "team",
        version: 1
      }
    ],
    listCustomCommands: () => [customCommand()],
    listSkills: () => [skillRecord()],
    listPlugins: () => [pluginRecord()],
    listMcpServers: () => [mcpServer()],
    settings: {
      runtime: {
        databasePath: join(workspace, ".swarm", "swarm.db")
      },
      permissions: {
        defaultMode: "on-request",
        allow: [],
        ask: ["tool.shell.exec"],
        deny: [],
        additionalDirectories: []
      }
    }
  } as unknown as SwarmRuntime;
}

function approvalRecord(): ApprovalRecord {
  return {
    approval_id: "approval-1",
    session_id: "session-1",
    task_id: "task-1",
    action: "file.write",
    summary: "Write file",
    detail: "Need write",
    risk: "write",
    risk_class: "r3",
    target: "src/example.ts",
    status: "pending",
    challenge: {
      id: "approval-1",
      session_id: "session-1",
      task_id: "task-1",
      action: "file.write",
      summary: "Write file",
      detail: "Need write",
      risk: "write",
      risk_class: "r3",
      target: "src/example.ts",
      why_now: "Need write",
      predicted_impact: "File changes",
      rollback_plan: "Revert",
      permission_decision: "ask",
      permission_reason: "write",
      permission_mode: "ask"
    },
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: "2026-05-11T00:00:00.000Z"
  };
}

function customCommand(): CustomCommandRecord {
  return {
    name: "release-check",
    title: "Release Check",
    description: "Check release readiness.",
    path: "E:/Playground/Swarm/.swarm/commands/release-check.md",
    directory: "E:/Playground/Swarm/.swarm/commands",
    scope: "project",
    trust: "trusted",
    frontmatter: {},
    content: "Check release readiness.",
    diagnostics: []
  };
}

function skillRecord(): SkillRecord {
  return {
    name: "reviewer",
    displayName: "Reviewer",
    description: "Review changes.",
    path: "E:/Playground/Swarm/.swarm/skills/reviewer/SKILL.md",
    directory: "E:/Playground/Swarm/.swarm/skills/reviewer",
    scope: "project",
    trust: "trusted",
    frontmatter: {},
    allowedTools: ["Read"],
    resourcePaths: [],
    diagnostics: []
  };
}

function pluginRecord(): PluginRecord {
  return {
    id: "release-tools",
    name: "Release Tools",
    description: "Release helper plugin.",
    path: "E:/Playground/Swarm/.swarm/plugins/release-tools/plugin.json",
    directory: "E:/Playground/Swarm/.swarm/plugins/release-tools",
    scope: "project",
    trust: "trusted",
    checksum: "abc123",
    manifest: {},
    diagnostics: [],
    contributions: [
      {
        kind: "slash_command",
        id: "release-check",
        title: "Release Check",
        description: "Check release readiness.",
        riskClass: "r1",
        metadata: {}
      }
    ]
  };
}

function mcpServer(): McpServerRecord {
  return {
    id: "docs",
    status: "connected",
    transport: "stdio",
    trust: "user",
    exposeTools: true,
    exposeResources: false,
    exposePrompts: false,
    command: "node",
    toolCount: 1,
    resourceCount: 0,
    promptCount: 0,
    diagnostics: []
  };
}
