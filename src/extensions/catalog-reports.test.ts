import { strict as assert } from "node:assert";
import test from "node:test";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { buildCapabilityListReport } from "./capability-report.js";
import { buildMcpListReport } from "./mcp-report.js";
import { buildPluginListReport, buildPluginValidationReport } from "./plugin-report.js";
import { buildSkillListReport } from "./skill-report.js";
import type { McpServerRecord } from "./mcp.js";
import type { PluginRecord } from "./plugins.js";
import type { SkillRecord } from "./skills.js";
import type { CapabilityDescriptor, CapabilityProviderSnapshot } from "./types.js";

test("catalog report builders expose capability, plugin, skill, and MCP summaries", async () => {
  const runtime = catalogRuntime();

  const capabilities = await buildCapabilityListReport(runtime, { advanced: true });
  const plugins = buildPluginListReport(runtime);
  const pluginValidation = buildPluginValidationReport(runtime);
  const skills = buildSkillListReport(runtime);
  const mcp = buildMcpListReport(runtime);

  assert.match(capabilities.detail, /Swarm Capabilities/);
  assert.match(capabilities.detail, /summary capabilities=1 providers=1 ready=1/);
  assert.equal(capabilities.data.summary && typeof capabilities.data.summary, "object");

  assert.match(plugins.detail, /Swarm Plugins/);
  assert.match(plugins.detail, /summary plugins=1 trusted=1 disabled=0 untrusted=0 contributions=1 slash_commands=1/);
  assert.equal(plugins.data.plugins && Array.isArray(plugins.data.plugins), true);

  assert.match(pluginValidation.detail, /Swarm Plugin Validation/);
  assert.match(pluginValidation.detail, /summary plugins=1 errors=0 warnings=0/);
  assert.equal(pluginValidation.ok, true);

  assert.match(skills.detail, /Swarm Skills/);
  assert.match(skills.detail, /summary skills=1 active=1 shadowed=0 trusted=1/);
  assert.equal(skills.data.skills && Array.isArray(skills.data.skills), true);

  assert.match(mcp.detail, /Swarm MCP/);
  assert.match(mcp.detail, /summary servers=1 connected=1 pending=0 failed=0 disabled=0 tools=2 resources=1 prompts=1/);
  assert.equal(mcp.data.servers && Array.isArray(mcp.data.servers), true);
});

function catalogRuntime(): SwarmRuntime {
  const capability: CapabilityDescriptor = {
    id: "local.read",
    kind: "local_tool",
    source: "builtin",
    trust: "builtin",
    providerId: "local-tools",
    name: "read",
    title: "Read file",
    description: "Read a workspace file.",
    riskClass: "r0",
    permissionName: "FileRead",
    modelVisible: true,
    userVisible: true,
    status: "available",
    readOnly: true
  };
  const provider: CapabilityProviderSnapshot = {
    providerId: "local-tools",
    title: "Local tools",
    capabilities: 1,
    diagnostics: []
  };
  return {
    getWorkspacePath: () => "E:/Playground/Swarm",
    listCapabilities: async () => [capability],
    listCapabilityProviders: async () => [provider],
    listPlugins: () => [pluginRecord()],
    listSkills: () => [skillRecord()],
    listMcpServers: () => [mcpServer()],
    settings: {
      extensions: {
        capabilities: {
          disabled: [],
          hiddenFromModel: []
        },
        plugins: {
          enabled: true,
          loadProjectPlugins: "trustedWorkspaces",
          roots: [],
          disabled: [],
          maxPlugins: 20
        },
        skills: {
          enabled: true,
          loadProjectSkills: "trustedWorkspaces",
          roots: [],
          maxSkills: 20
        },
        mcp: {
          enabled: true,
          exposeGatewayServer: false,
          servers: {},
          runtimeConfig: undefined
        }
      }
    }
  } as unknown as SwarmRuntime;
}

function pluginRecord(): PluginRecord {
  return {
    id: "release-tools",
    name: "Release Tools",
    version: "1.0.0",
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
        metadata: {
          usage: "/release-check",
          prompt: "Check release readiness."
        }
      }
    ]
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
    frontmatter: { name: "reviewer", description: "Review changes." },
    allowedTools: ["Read", "Grep"],
    resourcePaths: [],
    diagnostics: []
  };
}

function mcpServer(): McpServerRecord {
  return {
    id: "docs",
    status: "connected",
    transport: "stdio",
    trust: "user",
    exposeTools: true,
    exposeResources: true,
    exposePrompts: true,
    command: "node",
    args: ["server.js"],
    cwd: "E:/Playground/Swarm",
    serverName: "Docs MCP",
    serverVersion: "1.0.0",
    toolCount: 2,
    resourceCount: 1,
    promptCount: 1,
    lastConnectedAt: "2026-05-11T00:00:00.000Z",
    diagnostics: []
  };
}
