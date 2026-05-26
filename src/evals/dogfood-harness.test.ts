import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { defaultSwarmConfig, defaultSwarmSettings, type SwarmSettings } from "../config/settings.js";
import { buildProviderProfiles, formatProviderProfiles } from "../providers/provider-profile.js";
import { buildSessionSnapshot } from "../server/session-view.js";
import { gatewayClientAuthHeaders } from "../server/gateway-auth.js";
import { SwarmGatewayServer } from "../server/gateway.js";
import { runTuiSmokeHarness } from "../tui/tui-smoke-harness.js";
import { SwarmRuntime } from "../runtime/runtime.js";

test("dogfood smoke wires temporary skill MCP stdio Gateway TUI and redaction evidence", async () => {
  const fixture = createDogfoodFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const skills = runtime.listSkills();
    const skill = skills.find((item) => item.name === "dogfood-repo-scout");
    assert(skill, "temporary SKILL.md should be discovered");
    assert.equal(skill.trust, "trusted");
    assert.equal(skill.scope, "user");

    const activated = runtime.activateSkill("dogfood-repo-scout", fixture.sessionId, "dogfood temporary skill smoke");
    assert.match(activated.content, /Dogfood Repo Scout/);
    const skillEvidence = runtime.blackboardStore.query(fixture.sessionId, { tag: "skill-activation" });
    assert(skillEvidence.some((entry) => {
      const value = entry.value as { name?: string; reason?: string };
      return value.name === "dogfood-repo-scout" && value.reason === "dogfood temporary skill smoke";
    }));

    const server = await runtime.refreshMcpServer("dogfood");
    assert.equal(server.status, "connected", server.lastError ?? "MCP server failed");
    assert.equal(server.toolCount, 1);
    assert.equal(server.resourceCount, 1);
    assert.equal(server.promptCount, 1);

    const capabilities = await runtime.listCapabilities({ providerId: "mcp:dogfood", includeDisabled: true });
    const tool = capabilities.find((item) => item.kind === "mcp_tool" && item.name.includes("echo"));
    assert(tool, "temporary MCP tool should be discoverable");
    const toolResult = await runtime.invokeCapability(tool.id, { text: "cache and tool smoke" }, fixture.sessionId, {
      taskId: "dogfood.mcp.tool",
      source: "runtime"
    });
    assert.equal(toolResult.status, "success");
    assert.match(toolResult.summary, /dogfood\.echo completed/);

    const resource = await runtime.readMcpResource("dogfood", "dogfood://readme", fixture.sessionId);
    assert.equal(resource.contents[0]?.text, "dogfood resource body");
    const resourceArtifact = resource._swarm_artifact as McpDogfoodArtifact | undefined;
    assert.equal(resourceArtifact?.server_id, "dogfood");
    assert.equal(resourceArtifact?.cache_policy.cachePolicy, "stable_summary");

    const prompt = await runtime.getMcpPrompt("dogfood", "dogfood-prompt", { topic: "cache" }, fixture.sessionId);
    assert.match(promptText(prompt), /dogfood/);
    const promptArtifact = prompt._swarm_artifact as McpDogfoodArtifact | undefined;
    assert.equal(promptArtifact?.cache_policy.cachePolicy, "dynamic_context");

    const snapshot = buildSessionSnapshot(runtime, fixture.sessionId) as DogfoodSessionSnapshot;
    assert.match(snapshot.extensions.skills.summary.runtime?.state ?? "", /active|shadowed|degraded/);
    assert(snapshot.extensions.skills.skills.some((item) => item.name === "dogfood-repo-scout"));
    assert.equal(snapshot.extensions.mcp.summary.runtime?.state, "connected");

    const providerText = formatProviderProfiles(buildProviderProfiles({
      settings: runtime.settings,
      config: {
        ...defaultSwarmConfig(),
        primaryProvider: "openai",
        providerApiKeys: {
          openai: "sk-dogfoodsecret123456"
        }
      }
    })).join("\n");
    assert.doesNotMatch(providerText, /sk-dogfoodsecret/);
    assert.match(providerText, /provider profile|provider/i);

    const tuiSmoke = await runTuiSmokeHarness({
      out: join(fixture.root, "tui-smoke"),
      columns: 120,
      rows: 32
    });
    assert.equal(tuiSmoke.status, "pass");
    assert(tuiSmoke.checks.some((check) => check.id === "empty-enter-guard" && check.status === "pass"));

    const gateway = new SwarmGatewayServer({
      host: "127.0.0.1",
      port: 0,
      workspace: fixture.workspace,
      databasePath: join(fixture.root, "gateway.db")
    });
    try {
      gateway.runtime.settings.extensions.skills.roots = [fixture.skillsRoot];
      gateway.runtime.settings.extensions.mcp.enabled = true;
      gateway.runtime.settings.extensions.mcp.servers = fixture.settings.extensions.mcp.servers;
      const started = await gateway.start();
      const skillsResponse = await readGatewayJson<{ skills: Array<{ name: string }>; summary: { totals: { skills: number } } }>(`${started.url}/v1/skills`);
      assert(skillsResponse.skills.some((item) => item.name === "dogfood-repo-scout"));
      assert(skillsResponse.summary.totals.skills > 0);

      const mcpRefresh = await postGatewayJson<{ server: { status: string; resourceCount: number; promptCount: number } }>(
        `${started.url}/v1/mcp/servers/dogfood/refresh`,
        {}
      );
      assert.equal(mcpRefresh.server.status, "connected");
      assert.equal(mcpRefresh.server.resourceCount, 1);
      assert.equal(mcpRefresh.server.promptCount, 1);
    } finally {
      await gateway.stop();
      await runtimeCapabilityPlane(gateway.runtime).dispose();
    }
  } finally {
    runtime.dispose();
    await runtimeCapabilityPlane(runtime).dispose();
    fixture.close();
  }
});

function createDogfoodFixture(): {
  root: string;
  workspace: string;
  skillsRoot: string;
  databasePath: string;
  sessionId: string;
  settings: SwarmSettings;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-dogfood-smoke-"));
  const workspace = join(root, "workspace");
  const skillsRoot = join(root, "skills");
  const serverPath = join(root, "dogfood-mcp-server.mjs");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(skillsRoot, "dogfood-repo-scout"), { recursive: true });
  writeFileSync(join(skillsRoot, "dogfood-repo-scout", "SKILL.md"), [
    "---",
    "name: dogfood-repo-scout",
    "description: Dogfood Repo Scout temporary skill for MCP smoke.",
    "allowed-tools: [Read, Grep]",
    "---",
    "",
    "# Dogfood Repo Scout",
    "Inspect the temporary workspace and explain MCP cache evidence."
  ].join("\n"), "utf8");
  writeFileSync(serverPath, dogfoodMcpServerSource(), "utf8");
  const settings = defaultSwarmSettings({
    home: root,
    settingsPath: join(root, "settings.json"),
    configPath: join(root, "config.json"),
    stateDir: join(root, "state"),
    sessionsDir: join(root, "sessions"),
    artifactsDir: join(root, "artifacts"),
    logsDir: join(root, "logs"),
    cacheDir: join(root, "cache"),
    agentsDir: join(root, "agents"),
    commandsDir: join(root, "commands"),
    skillsDir: join(root, "user-skills"),
    pluginsDir: join(root, "plugins"),
    projectsDir: join(root, "projects")
  });
  settings.extensions.skills.roots = [skillsRoot];
  settings.extensions.mcp.enabled = true;
  settings.extensions.mcp.servers = {
    dogfood: {
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      cwd: root,
      trust: "user",
      exposeTools: true,
      exposeResources: true,
      exposePrompts: true,
      timeoutMs: 10_000
    }
  };
  writeFileSync(join(root, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "config.json"), `${JSON.stringify({
    primaryProvider: "dogfood-provider",
    providerApiKeys: {
      "dogfood-provider": "sk-dogfoodsecret123456"
    }
  }, null, 2)}\n`, "utf8");
  const previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = root;
  return {
    root,
    workspace,
    skillsRoot,
    databasePath: join(root, "swarm.db"),
    sessionId: "dogfood_session",
    settings,
    close: () => {
      if (previousHome === undefined) {
        delete process.env.SWARM_HOME;
      } else {
        process.env.SWARM_HOME = previousHome;
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) {
        if (!isWindowsEphemeralCleanupError(error)) {
          throw error;
        }
      }
    }
  };
}

function dogfoodMcpServerSource(): string {
  const mcpServerUrl = pathToFileURL(join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "mcp.js")).href;
  const stdioUrl = pathToFileURL(join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "stdio.js")).href;
  return [
    `import { McpServer } from ${JSON.stringify(mcpServerUrl)};`,
    `import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};`,
    "const server = new McpServer({ name: 'dogfood-mcp', version: '1.0.0' });",
    "server.registerTool('echo', {",
    "  description: 'Echo dogfood input.',",
    "  inputSchema: {}",
    "}, async (args) => ({ content: [{ type: 'text', text: `echo:${args?.text ?? ''}` }] }));",
    "server.registerResource('dogfood-readme', 'dogfood://readme', { title: 'Dogfood README', description: 'Dogfood resource.', mimeType: 'text/plain' }, async () => ({",
    "  contents: [{ uri: 'dogfood://readme', text: 'dogfood resource body', mimeType: 'text/plain' }]",
    "}));",
    "server.registerPrompt('dogfood-prompt', { description: 'Dogfood prompt.', argsSchema: {} }, async (args) => ({",
    "  messages: [{ role: 'user', content: { type: 'text', text: `Explain ${args?.topic ?? 'dogfood'} from MCP.` } }]",
    "}));",
    "await server.connect(new StdioServerTransport());"
  ].join("\n");
}

async function readGatewayJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as T & { error?: unknown };
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function postGatewayJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...gatewayClientAuthHeaders() },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as T & { error?: unknown };
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

type McpDogfoodArtifact = {
  server_id: string;
  cache_policy: {
    cachePolicy: "stable_summary" | "dynamic_context";
  };
};

type DogfoodSessionSnapshot = {
  extensions: {
    skills: {
      skills: Array<{ name: string }>;
      summary: { runtime?: { state?: string } };
    };
    mcp: {
      summary: {
        runtime?: { state?: string };
      };
    };
  };
};

function promptText(prompt: { messages: Array<{ content: unknown }> }): string {
  const content = prompt.messages[0]?.content;
  if (content && typeof content === "object" && !Array.isArray(content) && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function runtimeCapabilityPlane(runtime: SwarmRuntime): { dispose: () => Promise<void> } {
  return (runtime as unknown as { capabilityPlane: { dispose: () => Promise<void> } }).capabilityPlane;
}

function isWindowsEphemeralCleanupError(error: unknown): boolean {
  return process.platform === "win32"
    && error instanceof Error
    && "code" in error
    && ((error as { code?: unknown }).code === "EPERM" || (error as { code?: unknown }).code === "EBUSY");
}
