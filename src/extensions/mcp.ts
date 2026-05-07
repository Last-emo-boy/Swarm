import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerSettings, SwarmSettings } from "../config/settings.js";
import type { ToolResult } from "../tools/types.js";
import { loadPluginMcpServerSettings } from "./plugins.js";
import type { CapabilityDescriptor, CapabilityDiagnostic, CapabilityProvider, CapabilityTrust } from "./types.js";

export type McpServerStatus = "disabled" | "pending" | "connected" | "failed";

export type McpServerRecord = {
  id: string;
  status: McpServerStatus;
  transport: McpServerSettings["transport"];
  trust: McpServerSettings["trust"];
  exposeTools: boolean;
  exposeResources: boolean;
  exposePrompts: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastConnectedAt?: string;
  lastError?: string;
  diagnostics: CapabilityDiagnostic[];
};

type McpServerRuntime = {
  id: string;
  capabilityIdPart: string;
  config: McpServerSettings;
  status: McpServerStatus;
  client?: Client;
  transport?: StdioClientTransport;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  lastConnectedAt?: string;
  lastError?: string;
  diagnostics: CapabilityDiagnostic[];
};

export class McpClientProvider implements CapabilityProvider {
  readonly id = "mcp";
  readonly title = "MCP servers";
  private readonly servers = new Map<string, McpServerRuntime>();
  private providerDiagnostics: CapabilityDiagnostic[] = [];

  constructor(private readonly input: { settings: SwarmSettings; workspace: string }) {
    this.reloadConfig();
  }

  async refresh(): Promise<void> {
    this.reloadConfig();
    this.providerDiagnostics = [];
    if (!this.input.settings.extensions.mcp.enabled) {
      this.providerDiagnostics.push({
        severity: "info",
        code: "MCP_DISABLED",
        message: "MCP client support is disabled by settings.extensions.mcp.enabled."
      });
      return;
    }
    await Promise.all([...this.servers.keys()].map((serverId) => this.refreshServer(serverId)));
  }

  async refreshServer(serverId: string): Promise<McpServerRecord> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    await this.disconnectServer(server);
    server.tools = [];
    server.diagnostics = [];
    server.lastError = undefined;

    if (!this.input.settings.extensions.mcp.enabled || server.config.disabled) {
      server.status = "disabled";
      return this.toRecord(server);
    }
    if (server.config.transport !== "stdio") {
      server.status = "failed";
      server.lastError = "Only stdio MCP transport is implemented.";
      server.diagnostics.push({
        severity: "warn",
        code: "MCP_TRANSPORT_UNSUPPORTED",
        message: "Only stdio MCP transport is implemented in this phase."
      });
      return this.toRecord(server);
    }
    if (!server.config.command?.trim()) {
      server.status = "failed";
      server.lastError = "MCP stdio server requires a command.";
      server.diagnostics.push({
        severity: "error",
        code: "MCP_COMMAND_MISSING",
        message: "MCP stdio server requires settings.extensions.mcp.servers.<id>.command."
      });
      return this.toRecord(server);
    }

    server.status = "pending";
    try {
      const client = new Client(
        { name: "swarm", version: "0.1.0" },
        { capabilities: {} }
      );
      const transport = new StdioClientTransport({
        command: server.config.command,
        args: server.config.args ?? [],
        cwd: server.config.cwd ?? this.input.workspace,
        env: resolveMcpEnv(server.config.env),
        stderr: "pipe"
      });
      const stderr = transport.stderr;
      stderr?.on("data", (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (!text.trim()) {
          return;
        }
        server.diagnostics.push({
          severity: "info",
          code: "MCP_STDERR",
          message: redactEnvValues(text.trim(), server.config.env)
        });
      });
      await client.connect(transport, { timeout: server.config.timeoutMs ?? 30_000 });
      server.client = client;
      server.transport = transport;
      server.status = "connected";
      server.lastConnectedAt = new Date().toISOString();
      if (server.config.exposeTools !== false) {
        const result = await client.listTools(undefined, { timeout: server.config.timeoutMs ?? 30_000 });
        server.tools = result.tools;
      }
      if (server.config.exposeResources === true) {
        const result = await client.listResources(undefined, { timeout: server.config.timeoutMs ?? 30_000 });
        server.resources = result.resources;
      }
      if (server.config.exposePrompts === true) {
        const result = await client.listPrompts(undefined, { timeout: server.config.timeoutMs ?? 30_000 });
        server.prompts = result.prompts;
      }
    } catch (error) {
      server.status = "failed";
      server.lastError = error instanceof Error ? error.message : String(error);
      server.diagnostics.push({
        severity: "error",
        code: "MCP_CONNECT_FAILED",
        message: server.lastError
      });
      await this.disconnectServer(server);
    }
    return this.toRecord(server);
  }

  listCapabilities(): CapabilityDescriptor[] {
    return [...this.servers.values()]
      .filter((server) => server.status === "connected")
      .flatMap((server) => [
        ...(server.config.exposeTools !== false ? server.tools.map((tool) => mcpToolDescriptor(server, tool)) : []),
        ...(server.config.exposeResources === true ? server.resources.map((resource) => mcpResourceDescriptor(server, resource)) : []),
        ...(server.config.exposePrompts === true ? server.prompts.map((prompt) => mcpPromptDescriptor(server, prompt)) : [])
      ]);
  }

  diagnostics(): CapabilityDiagnostic[] {
    return this.providerDiagnostics;
  }

  listServers(): McpServerRecord[] {
    return [...this.servers.values()].map((server) => this.toRecord(server));
  }

  listResources(serverId: string): Resource[] {
    const server = this.requireServer(serverId);
    return [...server.resources];
  }

  listPrompts(serverId: string): Prompt[] {
    const server = this.requireServer(serverId);
    return [...server.prompts];
  }

  async readResource(serverId: string, uri: string): Promise<Awaited<ReturnType<Client["readResource"]>>> {
    const server = await this.ensureConnectedServer(serverId);
    return server.client.readResource({ uri }, { timeout: server.config.timeoutMs ?? 30_000 });
  }

  async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<Awaited<ReturnType<Client["getPrompt"]>>> {
    const server = await this.ensureConnectedServer(serverId);
    return server.client.getPrompt({ name, arguments: args }, { timeout: server.config.timeoutMs ?? 30_000 });
  }

  async callTool(capabilityId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseMcpToolCapabilityId(capabilityId);
    const server = this.servers.get(parsed.serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${parsed.serverId}`);
    }
    await this.ensureConnectedServer(server.id);
    try {
      const result = await server.client?.callTool(
        { name: parsed.toolName, arguments: args },
        undefined,
        { timeout: server.config.timeoutMs ?? 30_000 }
      );
      return normalizeMcpToolResult(server.id, parsed.toolName, result as Awaited<ReturnType<Client["callTool"]>>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        action: `mcp.${server.id}.${parsed.toolName}`,
        status: "failed",
        summary: `MCP tool ${server.id}.${parsed.toolName} failed: ${message}`,
        errors: [message],
        errorCode: "MCP_TOOL_FAILED",
        retryable: true,
        recoverable: true,
        recoverySuggestion: "Inspect /mcp for server status, then refresh the server or retry with narrower arguments.",
        metadata: {
          server_id: server.id,
          tool: parsed.toolName
        }
      };
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => this.disconnectServer(server)));
    this.servers.clear();
  }

  private reloadConfig(): void {
    const configs = loadMcpServerSettings(this.input.settings, this.input.workspace);
    const currentIds = new Set(this.servers.keys());
    for (const [id, config] of Object.entries(configs)) {
      currentIds.delete(id);
      const existing = this.servers.get(id);
      if (existing) {
        existing.config = config;
      } else {
        this.servers.set(id, {
          id,
          capabilityIdPart: encodeMcpIdPart(id),
          config,
          status: config.disabled ? "disabled" : "pending",
          tools: [],
          resources: [],
          prompts: [],
          diagnostics: []
        });
      }
    }
    for (const deletedId of currentIds) {
      const existing = this.servers.get(deletedId);
      if (existing) {
        void this.disconnectServer(existing);
      }
      this.servers.delete(deletedId);
    }
  }

  private async disconnectServer(server: McpServerRuntime): Promise<void> {
    const client = server.client;
    const transport = server.transport;
    server.client = undefined;
    server.transport = undefined;
    await Promise.allSettled([
      client?.close(),
      transport?.close()
    ]);
  }

  private toRecord(server: McpServerRuntime): McpServerRecord {
    const version = server.client?.getServerVersion();
    return {
      id: server.id,
      status: server.status,
      transport: server.config.transport,
      trust: server.config.trust,
      exposeTools: server.config.exposeTools !== false,
      exposeResources: server.config.exposeResources === true,
      exposePrompts: server.config.exposePrompts === true,
      command: server.config.command,
      args: server.config.args,
      cwd: server.config.cwd,
      url: server.config.url,
      serverName: version?.name,
      serverVersion: version?.version,
      toolCount: server.tools.length,
      resourceCount: server.resources.length,
      promptCount: server.prompts.length,
      lastConnectedAt: server.lastConnectedAt,
      lastError: server.lastError,
      diagnostics: server.diagnostics
    };
  }

  private requireServer(serverId: string): McpServerRuntime {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  private async ensureConnectedServer(serverId: string): Promise<McpServerRuntime & { client: Client }> {
    const server = this.requireServer(serverId);
    if (server.status !== "connected" || !server.client) {
      await this.refreshServer(server.id);
    }
    if (server.status !== "connected" || !server.client) {
      throw new Error(`MCP server is not connected: ${server.id}${server.lastError ? ` (${server.lastError})` : ""}`);
    }
    return server as McpServerRuntime & { client: Client };
  }
}

export function mcpToolCapabilityId(serverId: string, toolName: string): string {
  return `mcp_tool.${encodeMcpIdPart(serverId)}.${encodeMcpIdPart(toolName)}`;
}

function parseMcpToolCapabilityId(capabilityId: string): { serverId: string; toolName: string } {
  const parts = capabilityId.split(".");
  if (parts.length < 3 || parts[0] !== "mcp_tool") {
    throw new Error(`Invalid MCP tool capability id: ${capabilityId}`);
  }
  return {
    serverId: decodeMcpIdPart(parts[1]),
    toolName: decodeMcpIdPart(parts.slice(2).join("."))
  };
}

function mcpToolDescriptor(server: McpServerRuntime, tool: Tool): CapabilityDescriptor {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint === true;
  const openWorld = tool.annotations?.openWorldHint === true;
  return {
    id: `mcp_tool.${server.capabilityIdPart}.${encodeMcpIdPart(tool.name)}`,
    kind: "mcp_tool",
    source: "mcp",
    trust: mcpTrust(server.config),
    providerId: `mcp:${server.id}`,
    name: `mcp__${modelToolNamePart(server.id)}__${modelToolNamePart(tool.name)}`,
    title: tool.title ?? tool.name,
    description: tool.description ?? `MCP tool ${tool.name} from ${server.id}.`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    riskClass: destructive ? "r3" : openWorld ? "r2" : readOnly ? "r0" : "r1",
    permissionName: `McpTool(${server.id}:${tool.name})`,
    modelVisible: server.config.exposeTools !== false && mcpTrust(server.config) === "trusted",
    userVisible: true,
    status: server.status === "connected" ? "available" : server.status,
    diagnostics: server.diagnostics,
    metadata: {
      server_id: server.id,
      tool_name: tool.name,
      annotations: tool.annotations,
      execution: tool.execution,
      server_capabilities: server.client?.getServerCapabilities()
    }
  };
}

function mcpResourceDescriptor(server: McpServerRuntime, resource: Resource): CapabilityDescriptor {
  return {
    id: `mcp_resource.${server.capabilityIdPart}.${encodeMcpIdPart(resource.uri)}`,
    kind: "mcp_resource",
    source: "mcp",
    trust: mcpTrust(server.config),
    providerId: `mcp:${server.id}`,
    name: `mcp_resource__${modelToolNamePart(server.id)}__${modelToolNamePart(resource.name)}`,
    title: resource.title ?? resource.name,
    description: resource.description ?? `MCP resource ${resource.uri} from ${server.id}.`,
    riskClass: "r0",
    permissionName: `McpResource(${server.id}:${resource.uri})`,
    modelVisible: false,
    userVisible: true,
    status: server.status === "connected" ? "available" : server.status,
    diagnostics: server.diagnostics,
    metadata: {
      server_id: server.id,
      uri: resource.uri,
      mimeType: resource.mimeType,
      size: resource.size,
      annotations: resource.annotations
    }
  };
}

function mcpPromptDescriptor(server: McpServerRuntime, prompt: Prompt): CapabilityDescriptor {
  return {
    id: `mcp_prompt.${server.capabilityIdPart}.${encodeMcpIdPart(prompt.name)}`,
    kind: "mcp_prompt",
    source: "mcp",
    trust: mcpTrust(server.config),
    providerId: `mcp:${server.id}`,
    name: `mcp_prompt__${modelToolNamePart(server.id)}__${modelToolNamePart(prompt.name)}`,
    title: prompt.title ?? prompt.name,
    description: prompt.description ?? `MCP prompt ${prompt.name} from ${server.id}.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries((prompt.arguments ?? []).map((argument) => [
        argument.name,
        { description: argument.description ?? "", required: argument.required === true }
      ]))
    },
    riskClass: "r0",
    permissionName: `McpPrompt(${server.id}:${prompt.name})`,
    modelVisible: false,
    userVisible: true,
    status: server.status === "connected" ? "available" : server.status,
    diagnostics: server.diagnostics,
    metadata: {
      server_id: server.id,
      prompt_name: prompt.name,
      arguments: prompt.arguments
    }
  };
}

function normalizeMcpToolResult(serverId: string, toolName: string, result: Awaited<ReturnType<Client["callTool"]>>): ToolResult {
  if ("toolResult" in result) {
    return {
      action: `mcp.${serverId}.${toolName}`,
      status: "success",
      summary: `MCP tool ${serverId}.${toolName} completed.`,
      data: result.toolResult,
      metadata: { server_id: serverId, tool: toolName }
    };
  }
  const text = result.content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource") return "text" in item.resource ? item.resource.text : `[resource blob: ${item.resource.uri}]`;
      if (item.type === "resource_link") return `[resource link: ${item.uri}]`;
      if (item.type === "image") return `[image: ${item.mimeType}]`;
      if (item.type === "audio") return `[audio: ${item.mimeType}]`;
      return JSON.stringify(item);
    })
    .join("\n");
  return {
    action: `mcp.${serverId}.${toolName}`,
    status: result.isError ? "failed" : "success",
    summary: `MCP tool ${serverId}.${toolName} ${result.isError ? "failed" : "completed"}.`,
    content: text || undefined,
    data: result.structuredContent,
    errorCode: result.isError ? "MCP_TOOL_ERROR" : undefined,
    retryable: result.isError ? true : undefined,
    recoverable: result.isError ? true : undefined,
    recoverySuggestion: result.isError ? "Inspect the MCP tool output and retry with adjusted arguments." : undefined,
    metadata: {
      server_id: serverId,
      tool: toolName,
      meta: result._meta
    }
  };
}

function loadMcpServerSettings(settings: SwarmSettings, workspace: string): Record<string, McpServerSettings> {
  const projectConfig = readMcpJson(resolve(workspace, ".mcp.json"), "project");
  const pluginConfig = loadPluginMcpServerSettings(settings, workspace);
  return {
    ...projectConfig,
    ...pluginConfig,
    ...settings.extensions.mcp.servers
  };
}

function readMcpJson(path: string, trust: McpServerSettings["trust"]): Record<string, McpServerSettings> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
    const servers = parsed.mcpServers ?? parsed.servers ?? {};
    return Object.fromEntries(
      Object.entries(servers)
        .filter(([, value]) => isRecord(value))
        .map(([id, value]) => [
          id,
          {
            disabled: value.disabled === true,
            transport: value.transport === "http" ? "http" : "stdio",
            command: typeof value.command === "string" ? value.command : undefined,
            args: Array.isArray(value.args) ? value.args.map(String) : [],
            cwd: typeof value.cwd === "string" ? resolve(dirname(path), value.cwd) : undefined,
            env: isStringRecord(value.env),
            url: typeof value.url === "string" ? value.url : undefined,
            headers: isStringRecord(value.headers),
            trust,
            exposeTools: value.exposeTools !== false,
            exposeResources: value.exposeResources === true,
            exposePrompts: value.exposePrompts === true,
            timeoutMs: positiveInteger(value.timeoutMs, 30_000)
          } satisfies McpServerSettings
        ])
    );
  } catch {
    return {};
  }
}

function resolveMcpEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        resolveEnvValue(value)
      ])
    )
  };
}

function resolveEnvValue(value: string): string {
  const envRef = /^\$\{?([A-Z0-9_]+)\}?$/i.exec(value.trim());
  return envRef ? process.env[envRef[1]] ?? "" : value;
}

function redactEnvValues(message: string, env: Record<string, string> | undefined): string {
  let redacted = message;
  for (const value of Object.values(env ?? {})) {
    const resolved = resolveEnvValue(value);
    if (resolved) {
      redacted = redacted.split(resolved).join("[redacted]");
    }
  }
  return redacted;
}

function mcpTrust(config: McpServerSettings): CapabilityTrust {
  if (config.disabled) {
    return "disabled";
  }
  return config.trust === "user" || config.trust === "workspace" ? "trusted" : "untrusted";
}

function encodeMcpIdPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeMcpIdPart(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function modelToolNamePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value).map(([key, next]) => [key, String(next)]));
}
