import { strict as assert } from "node:assert";
import test from "node:test";
import type { McpServerRecord } from "./mcp.js";
import type { SkillRecord } from "./skills.js";
import { summarizeMcpRuntimeState, summarizeSkillRuntimeState } from "./extension-diagnostics.js";

test("MCP runtime diagnostics distinguish disabled empty connected and failed states", () => {
  assert.deepEqual(
    summarizeMcpRuntimeState({
      settings: { enabled: false, configured_servers: 0, runtime_config: "none" },
      servers: []
    }),
    {
      state: "disabled",
      severity: "info",
      label: "MCP OFF",
      evidence: "disabled",
      reason: "MCP client support is disabled by settings.extensions.mcp.enabled.",
      nextAction: "Set settings.extensions.mcp.enabled=true or pass --mcp-config for a run."
    }
  );

  assert.equal(summarizeMcpRuntimeState({
    settings: { enabled: true, configured_servers: 0 },
    servers: []
  }).state, "enabled_empty");

  assert.equal(summarizeMcpRuntimeState({
    settings: { enabled: true, configured_servers: 1 },
    servers: [mcpServer({ status: "connected", toolCount: 2 })]
  }).evidence, "1 servers 2 tools 0 resources 0 prompts");

  const failed = summarizeMcpRuntimeState({
    settings: { enabled: true, configured_servers: 1 },
    servers: [mcpServer({ status: "failed", lastError: "boom" })]
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.severity, "error");
  assert.equal(failed.reason, "boom");
});

test("Skill runtime diagnostics explain empty untrusted shadowed and active catalogs", () => {
  assert.equal(summarizeSkillRuntimeState({
    settings: { enabled: true, load_project_skills: "trustedWorkspaces", configured_roots: [], max_skills: 100 },
    skills: []
  }).state, "empty");

  assert.equal(summarizeSkillRuntimeState({
    settings: { enabled: true, load_project_skills: "trustedWorkspaces", configured_roots: [], max_skills: 100 },
    skills: [skill({ trust: "untrusted" })]
  }).state, "untrusted");

  const shadowed = summarizeSkillRuntimeState({
    settings: { enabled: true, load_project_skills: "trustedWorkspaces", configured_roots: [], max_skills: 100 },
    skills: [
      skill({ name: "reviewer" }),
      skill({ name: "reviewer", path: "shadow/SKILL.md", shadowedBy: "winner/SKILL.md" })
    ]
  });
  assert.equal(shadowed.state, "shadowed");
  assert.match(shadowed.reason, /shadowed by/);

  assert.equal(summarizeSkillRuntimeState({
    settings: { enabled: true, load_project_skills: "trustedWorkspaces", configured_roots: [], max_skills: 100 },
    skills: [skill({ name: "reviewer" })]
  }).state, "active");
});

function mcpServer(input: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "docs",
    status: "pending",
    transport: "stdio",
    trust: "user",
    exposeTools: true,
    exposeResources: false,
    exposePrompts: false,
    toolCount: 0,
    resourceCount: 0,
    promptCount: 0,
    diagnostics: [],
    ...input
  };
}

function skill(input: Partial<SkillRecord> = {}): SkillRecord {
  return {
    name: "audit",
    displayName: "Audit",
    description: "Audit repository changes.",
    path: "skills/audit/SKILL.md",
    directory: "skills/audit",
    scope: "user",
    trust: "trusted",
    frontmatter: {},
    allowedTools: [],
    resourcePaths: [],
    diagnostics: [],
    ...input
  };
}
