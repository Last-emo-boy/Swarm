import type { Prompt, Resource } from "@modelcontextprotocol/sdk/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { summarizeMcpCatalog } from "./catalog-summary.js";
import type { McpServerRecord } from "./mcp.js";

export type McpServerSelectorResolution = {
  serverId?: string;
  error?: string;
};

export type McpCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export function buildMcpListReport(runtime: SwarmRuntime): McpCliReport {
  const servers = runtime.listMcpServers();
  const settings = mcpSettingsSnapshot(runtime);
  const summary = summarizeMcpCatalog(servers, settings);
  const lines = [
    "Swarm MCP",
    `workspace=${runtime.getWorkspacePath()}`,
    `settings enabled=${settings.enabled ? "yes" : "no"} expose_gateway=${settings.expose_gateway_server ? "yes" : "no"} configured_servers=${settings.configured_servers} runtime_config=${settings.runtime_config}`,
    `summary servers=${summary.totals.servers} connected=${summary.totals.connected} pending=${summary.totals.pending} failed=${summary.totals.failed} disabled=${summary.totals.disabled} tools=${summary.totals.tools} resources=${summary.totals.resources} prompts=${summary.totals.prompts}`,
    summary.runtime ? `runtime ${summary.runtime.label} state=${summary.runtime.state} severity=${summary.runtime.severity} evidence=${summary.runtime.evidence}` : undefined,
    summary.runtime ? `reason=${summary.runtime.reason}` : undefined,
    summary.runtime ? `next=${summary.runtime.nextAction}` : undefined,
    ""
  ].filter((line): line is string => typeof line === "string");
  if (!servers.length) {
    lines.push("No MCP servers configured.");
    lines.push("");
    lines.push("Use `swarm mcp show <server_id>` after enabling MCP or adding a server.");
  } else {
    for (const server of servers) {
      lines.push(formatMcpSummaryLine(server));
      if (server.lastError) {
        lines.push(`  error=${server.lastError}`);
      }
      if (server.diagnostics.length) {
        lines.push(`  diagnostics=${server.diagnostics.length}`);
      }
    }
    lines.push("");
    lines.push("Use `swarm mcp show <server_id>` for transport details, `refresh` to reconnect, or `resources`/`prompts` for catalog inspection.");
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings,
      summary,
      servers
    }
  };
}

export async function buildMcpDetailReport(runtime: SwarmRuntime, selector?: string): Promise<McpCliReport> {
  const resolution = resolveMcpServerSelector(runtime, selector);
  if (!resolution.serverId) {
    throw new Error(resolution.error ?? `Unknown MCP server: ${selector ?? "(missing)"}`);
  }
  const server = requireMcpServer(runtime, resolution.serverId);
  const capabilities = await runtime.listCapabilities({
    providerId: `mcp:${server.id}`,
    includeDisabled: true
  });
  const lines = [
    "Swarm MCP Server",
    `workspace=${runtime.getWorkspacePath()}`,
    `${server.id} [${server.status}/${server.transport}/${server.trust}]`,
    server.serverName ? `server=${server.serverName}${server.serverVersion ? ` ${server.serverVersion}` : ""}` : undefined,
    server.command ? `command=${[server.command, ...(server.args ?? [])].join(" ")}` : undefined,
    server.cwd ? `cwd=${server.cwd}` : undefined,
    server.url ? `url=${server.url}` : undefined,
    `expose tools=${server.exposeTools ? "yes" : "no"} resources=${server.exposeResources ? "yes" : "no"} prompts=${server.exposePrompts ? "yes" : "no"}`,
    `counts tools=${server.toolCount} resources=${server.resourceCount} prompts=${server.promptCount}`,
    server.lastConnectedAt ? `connected=${server.lastConnectedAt}` : undefined,
    server.lastError ? `error=${server.lastError}` : undefined
  ].filter(Boolean);
  lines.push("");
  lines.push("Capabilities");
  if (!capabilities.length) {
    lines.push("  (none)");
  } else {
    for (const capability of capabilities) {
      lines.push(`  ${capability.id} [${capability.kind}/${capability.status}] ${capability.title ?? capability.name}`);
    }
  }
  if (server.diagnostics.length) {
    lines.push("");
    lines.push("Diagnostics");
    for (const diagnostic of server.diagnostics) {
      lines.push(`  ${diagnostic.severity}: ${diagnostic.code ?? "diagnostic"} ${diagnostic.message}`);
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings: mcpSettingsSnapshot(runtime),
      server,
      capabilities
    }
  };
}

export function buildMcpResourcesReport(runtime: SwarmRuntime, selector: string): McpCliReport {
  const server = requireMcpServer(runtime, selector);
  const resources = runtime.listMcpResources(server.id);
  return {
    detail: [
      "Swarm MCP Resources",
      `workspace=${runtime.getWorkspacePath()}`,
      `server=${server.id} count=${resources.length}`,
      "",
      resources.length ? resources.map(formatMcpResource).join("\n\n") : "No MCP resources exposed."
    ].join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      server,
      resources
    }
  };
}

export async function buildMcpResourceReadReport(
  runtime: SwarmRuntime,
  selector: string,
  uri: string,
  sessionId?: string
): Promise<McpCliReport> {
  const server = requireMcpServer(runtime, selector);
  const result = await runtime.readMcpResource(server.id, uri, sessionId);
  return {
    detail: [
      "Swarm MCP Resource",
      `workspace=${runtime.getWorkspacePath()}`,
      `server=${server.id}`,
      `uri=${uri}`,
      sessionId ? `session=${sessionId}` : undefined,
      "",
      formatMcpResourceReadResult(result)
    ].filter(Boolean).join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      server,
      session_id: sessionId,
      uri,
      result
    }
  };
}

export function buildMcpPromptsReport(runtime: SwarmRuntime, selector: string): McpCliReport {
  const server = requireMcpServer(runtime, selector);
  const prompts = runtime.listMcpPrompts(server.id);
  return {
    detail: [
      "Swarm MCP Prompts",
      `workspace=${runtime.getWorkspacePath()}`,
      `server=${server.id} count=${prompts.length}`,
      "",
      prompts.length ? prompts.map(formatMcpPrompt).join("\n\n") : "No MCP prompts exposed."
    ].join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      server,
      prompts
    }
  };
}

export async function buildMcpPromptResultReport(
  runtime: SwarmRuntime,
  selector: string,
  name: string,
  args?: Record<string, string>,
  sessionId?: string
): Promise<McpCliReport> {
  const server = requireMcpServer(runtime, selector);
  const result = await runtime.getMcpPrompt(server.id, name, args, sessionId);
  return {
    detail: [
      "Swarm MCP Prompt",
      `workspace=${runtime.getWorkspacePath()}`,
      `server=${server.id}`,
      `name=${name}`,
      args && Object.keys(args).length ? `arguments=${JSON.stringify(args)}` : "arguments={}",
      sessionId ? `session=${sessionId}` : undefined,
      "",
      formatMcpPromptResult(result)
    ].filter(Boolean).join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      server,
      session_id: sessionId,
      name,
      arguments: args ?? {},
      result
    }
  };
}

export function resolveMcpServerSelector(runtime: SwarmRuntime, query?: string): McpServerSelectorResolution {
  const trimmed = query?.trim();
  const servers = runtime.listMcpServers();
  if (!trimmed) {
    return { error: "MCP server id is required." };
  }
  const exact = servers.find((server) => server.id === trimmed);
  if (exact) {
    return { serverId: exact.id };
  }
  const normalized = trimmed.toLowerCase();
  const exactInsensitive = servers.find((server) => server.id.toLowerCase() === normalized);
  if (exactInsensitive) {
    return { serverId: exactInsensitive.id };
  }
  const prefixMatches = servers.filter((server) => server.id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { serverId: prefixMatches[0].id };
  }
  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous MCP server selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((server) => server.id).join(", ")}`
    };
  }
  const fuzzyMatches = servers.filter((server) =>
    server.id.toLowerCase().includes(normalized) || (server.serverName ?? "").toLowerCase().includes(normalized)
  );
  if (fuzzyMatches.length === 1) {
    return { serverId: fuzzyMatches[0].id };
  }
  if (fuzzyMatches.length > 1) {
    return {
      error: `Ambiguous MCP server selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((server) => server.id).join(", ")}`
    };
  }
  return { error: `Unknown MCP server: ${trimmed}` };
}

function requireMcpServer(runtime: SwarmRuntime, selector: string): McpServerRecord {
  const resolution = resolveMcpServerSelector(runtime, selector);
  if (!resolution.serverId) {
    throw new Error(resolution.error ?? `Unknown MCP server: ${selector}`);
  }
  const server = runtime.listMcpServers().find((item) => item.id === resolution.serverId);
  if (!server) {
    throw new Error(`Unknown MCP server: ${resolution.serverId}`);
  }
  return server;
}

export function mcpSettingsSnapshot(runtime: SwarmRuntime): {
  enabled: boolean;
  expose_gateway_server: boolean;
  configured_servers: number;
  runtime_config: string;
} {
  const runtimeConfig = runtime.settings.extensions.mcp.runtimeConfig;
  return {
    enabled: runtime.settings.extensions.mcp.enabled,
    expose_gateway_server: runtime.settings.extensions.mcp.exposeGatewayServer,
    configured_servers: Object.keys(runtime.settings.extensions.mcp.servers).length,
    runtime_config: runtimeConfig
      ? `${runtimeConfig.strict === true ? "strict" : "merge"}:${runtimeConfig.paths?.length ?? 0}`
      : "none"
  };
}

function formatMcpSummaryLine(server: McpServerRecord): string {
  return `${server.id} [${server.status}/${server.transport}/${server.trust}] tools=${server.toolCount} resources=${server.resourceCount} prompts=${server.promptCount}`;
}

function formatMcpResource(resource: Resource): string {
  return [
    `${resource.name} ${resource.title ? `(${resource.title})` : ""}`,
    `uri=${resource.uri}`,
    resource.mimeType ? `mime=${resource.mimeType}` : undefined,
    typeof resource.size === "number" ? `size=${resource.size}` : undefined,
    resource.description
  ].filter(Boolean).join("\n");
}

function formatMcpPrompt(prompt: Prompt): string {
  return [
    `${prompt.name} ${prompt.title ? `(${prompt.title})` : ""}`,
    prompt.description,
    prompt.arguments?.length
      ? `args=${prompt.arguments.map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ")}`
      : "args=(none)"
  ].filter(Boolean).join("\n");
}

function formatMcpResourceReadResult(result: { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }): string {
  return result.contents.map((item) => [
    `--- ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ""} ---`,
    item.text ?? (item.blob ? `[blob base64 ${item.blob.length} chars]` : "")
  ].join("\n")).join("\n\n");
}

function formatMcpPromptResult(result: { description?: string; messages: Array<{ role: string; content: unknown }> }): string {
  return [
    result.description,
    ...result.messages.map((message, index) => [
      `--- ${index + 1}. ${message.role} ---`,
      formatMcpPromptContent(message.content)
    ].join("\n"))
  ].filter(Boolean).join("\n\n");
}

function formatMcpPromptContent(content: unknown): string {
  if (typeof content === "object" && content !== null && "type" in content) {
    const typed = content as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown; resource?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      return typed.text;
    }
    if (typed.type === "image" || typed.type === "audio") {
      return `[${String(typed.type)} ${String(typed.mimeType ?? "")} ${typeof typed.data === "string" ? `${typed.data.length} chars` : ""}]`;
    }
    if (typed.type === "resource") {
      return JSON.stringify(typed.resource, null, 2);
    }
  }
  return JSON.stringify(content, null, 2);
}
