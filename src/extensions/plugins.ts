import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getSwarmPaths, type McpServerSettings, type SwarmSettings } from "../config/settings.js";
import type { CapabilityDescriptor, CapabilityDiagnostic, CapabilityProvider, CapabilityTrust } from "./types.js";

export type PluginScope = "project" | "user" | "explicit";

export type PluginContributionKind = "slash_command" | "skill" | "agent_spec" | "mcp_server";

export type PluginContributionRecord = {
  kind: PluginContributionKind;
  id: string;
  title: string;
  description: string;
  riskClass: CapabilityDescriptor["riskClass"];
  metadata: Record<string, unknown>;
  mcpServer?: McpServerSettings;
};

export type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  description: string;
  path: string;
  directory: string;
  scope: PluginScope;
  trust: CapabilityTrust;
  checksum: string;
  manifest: PluginManifest;
  contributions: PluginContributionRecord[];
  diagnostics: CapabilityDiagnostic[];
};

export type PluginManifest = {
  id?: string;
  name?: string;
  title?: string;
  version?: string;
  description?: string;
  contributes?: {
    slashCommands?: PluginSlashCommandManifest[];
    skills?: PluginSkillManifest[];
    agentSpecs?: PluginAgentSpecManifest[];
    mcpServers?: Record<string, PluginMcpServerManifest>;
  };
};

type PluginSlashCommandManifest = {
  name?: string;
  title?: string;
  usage?: string;
  description?: string;
};

type PluginSkillManifest = {
  name?: string;
  title?: string;
  path?: string;
  description?: string;
};

type PluginAgentSpecManifest = {
  id?: string;
  name?: string;
  role?: string;
  description?: string;
  write_policy?: "read_only" | "scoped_write" | "workspace_write";
  capabilities?: string[];
};

type PluginMcpServerManifest = Partial<McpServerSettings> & {
  description?: string;
};

type PluginRoot = {
  path: string;
  scope: PluginScope;
  trust: CapabilityTrust;
  enabled: boolean;
};

export class PluginProvider implements CapabilityProvider {
  readonly id = "plugins";
  readonly title = "Plugins";
  private records: PluginRecord[] = [];
  private providerDiagnostics: CapabilityDiagnostic[] = [];

  constructor(private readonly input: { settings: SwarmSettings; workspace: string }) {}

  refresh(): void {
    this.providerDiagnostics = [];
    if (!this.input.settings.extensions.plugins.enabled) {
      this.records = [];
      this.providerDiagnostics.push({
        severity: "info",
        code: "PLUGINS_DISABLED",
        message: "Plugins are disabled by settings.extensions.plugins.enabled."
      });
      return;
    }

    const disabled = new Set(this.input.settings.extensions.plugins.disabled.map(normalizePluginId));
    const scanned = pluginRoots(this.input.settings, this.input.workspace)
      .flatMap((root) => root.enabled ? scanPluginRoot(root, disabled) : []);
    const records = dedupePlugins(scanned);
    this.records = records.slice(0, this.input.settings.extensions.plugins.maxPlugins);
    if (records.length > this.records.length) {
      this.providerDiagnostics.push({
        severity: "warn",
        code: "PLUGIN_LIMIT_REACHED",
        message: `Loaded ${this.records.length}/${records.length} discovered plugins because settings.extensions.plugins.maxPlugins was reached.`
      });
    }
  }

  listCapabilities(): CapabilityDescriptor[] {
    if (this.records.length === 0 && this.providerDiagnostics.length === 0) {
      this.refresh();
    }
    return this.records.flatMap((record) => [
      pluginDescriptor(record),
      ...record.contributions.map((contribution) => contributionDescriptor(record, contribution))
    ]);
  }

  diagnostics(): CapabilityDiagnostic[] {
    return this.providerDiagnostics;
  }

  listPlugins(): PluginRecord[] {
    if (this.records.length === 0 && this.providerDiagnostics.length === 0) {
      this.refresh();
    }
    return [...this.records];
  }
}

function pluginRoots(settings: SwarmSettings, workspace: string): PluginRoot[] {
  const paths = getSwarmPaths();
  const trustedWorkspace = isTrustedWorkspace(workspace);
  const projectMode = settings.extensions.plugins.loadProjectPlugins;
  const projectEnabled = projectMode === "always" || (projectMode === "trustedWorkspaces" && trustedWorkspace);
  const projectTrust: CapabilityTrust = projectEnabled ? "trusted" : "untrusted";
  return [
    { path: resolve(workspace, ".swarm", "plugins"), scope: "project", trust: projectTrust, enabled: projectMode !== "never" },
    { path: resolve(workspace, ".agents", "plugins"), scope: "project", trust: projectTrust, enabled: projectMode !== "never" },
    { path: paths.pluginsDir, scope: "user", trust: "trusted", enabled: true },
    { path: resolve(paths.home, "..", ".agents", "plugins"), scope: "user", trust: "trusted", enabled: true },
    ...settings.extensions.plugins.roots.map((root) => ({
      path: root,
      scope: "explicit" as const,
      trust: "trusted" as const,
      enabled: true
    }))
  ];
}

function scanPluginRoot(root: PluginRoot, disabled: Set<string>): PluginRecord[] {
  if (!existsSync(root.path)) {
    return [];
  }
  return safeReadDir(root.path)
    .flatMap((entry) => {
      const directory = join(root.path, entry);
      if (!safeIsDirectory(directory)) {
        return [];
      }
      const manifestPath = findManifestPath(directory);
      return manifestPath ? [readPlugin(manifestPath, root, disabled)] : [];
    });
}

function findManifestPath(directory: string): string | undefined {
  return [
    join(directory, "swarm-plugin.json"),
    join(directory, "plugin.json"),
    join(directory, ".swarm-plugin", "plugin.json"),
    join(directory, ".codex-plugin", "plugin.json")
  ].find((path) => existsSync(path));
}

function readPlugin(path: string, root: PluginRoot, disabled: Set<string>): PluginRecord {
  const diagnostics: CapabilityDiagnostic[] = [];
  let manifest: PluginManifest = {};
  const raw = readFileSync(path, "utf8");
  try {
    manifest = JSON.parse(raw) as PluginManifest;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "PLUGIN_MANIFEST_INVALID",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const directory = dirname(path);
  const id = normalizePluginId(stringValue(manifest.id) || basename(directory));
  const trust: CapabilityTrust = disabled.has(id) ? "disabled" : root.trust;
  if (!stringValue(manifest.description)) {
    diagnostics.push({
      severity: "warn",
      code: "PLUGIN_DESCRIPTION_MISSING",
      message: `Plugin ${id} does not define description.`
    });
  }
  return {
    id,
    name: stringValue(manifest.title) || stringValue(manifest.name) || id,
    version: stringValue(manifest.version),
    description: stringValue(manifest.description) || "No plugin description provided.",
    path,
    directory,
    scope: root.scope,
    trust,
    checksum: createHash("sha256").update(raw).digest("hex"),
    manifest,
    contributions: collectContributions(manifest, directory, diagnostics),
    diagnostics
  };
}

function collectContributions(
  manifest: PluginManifest,
  directory: string,
  diagnostics: CapabilityDiagnostic[]
): PluginContributionRecord[] {
  const contributes = manifest.contributes ?? {};
  return [
    ...(Array.isArray(contributes.slashCommands) ? contributes.slashCommands.map((item) => slashContribution(item)) : []),
    ...(Array.isArray(contributes.skills) ? contributes.skills.map((item) => skillContribution(item, directory, diagnostics)) : []),
    ...(Array.isArray(contributes.agentSpecs) ? contributes.agentSpecs.map((item) => agentSpecContribution(item)) : []),
    ...(isRecord(contributes.mcpServers)
      ? Object.entries(contributes.mcpServers).map(([id, item]) => mcpServerContribution(id, item))
      : [])
  ].filter((item): item is PluginContributionRecord => item !== undefined);
}

function slashContribution(item: PluginSlashCommandManifest): PluginContributionRecord | undefined {
  const name = normalizePluginId(stringValue(item.name) || "");
  if (!name) {
    return undefined;
  }
  return {
    kind: "slash_command",
    id: name,
    title: stringValue(item.title) || stringValue(item.usage) || `/${name}`,
    description: stringValue(item.description) || "Plugin slash command.",
    riskClass: "r1",
    metadata: {
      usage: stringValue(item.usage) || `/${name}`,
      manifest: item
    }
  };
}

function skillContribution(
  item: PluginSkillManifest,
  directory: string,
  diagnostics: CapabilityDiagnostic[]
): PluginContributionRecord | undefined {
  const name = normalizePluginId(stringValue(item.name) || "");
  if (!name) {
    return undefined;
  }
  const relativePath = stringValue(item.path);
  const path = relativePath ? resolve(directory, relativePath) : undefined;
  if (path && !existsSync(path)) {
    diagnostics.push({
      severity: "warn",
      code: "PLUGIN_SKILL_PATH_MISSING",
      message: `Plugin skill ${name} points to a missing path: ${relativePath}.`
    });
  }
  return {
    kind: "skill",
    id: name,
    title: stringValue(item.title) || name,
    description: stringValue(item.description) || "Plugin skill contribution.",
    riskClass: "r0",
    metadata: {
      path,
      manifest: item
    }
  };
}

function agentSpecContribution(item: PluginAgentSpecManifest): PluginContributionRecord | undefined {
  const id = normalizePluginId(stringValue(item.id) || stringValue(item.name) || "");
  if (!id) {
    return undefined;
  }
  const writePolicy = item.write_policy === "workspace_write" || item.write_policy === "scoped_write" ? item.write_policy : "read_only";
  return {
    kind: "agent_spec",
    id,
    title: stringValue(item.name) || id,
    description: stringValue(item.description) || "Plugin agent spec contribution.",
    riskClass: writePolicy === "workspace_write" ? "r2" : writePolicy === "scoped_write" ? "r1" : "r0",
    metadata: {
      role: stringValue(item.role),
      write_policy: writePolicy,
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.map(String) : [],
      manifest: item
    }
  };
}

function mcpServerContribution(id: string, item: unknown): PluginContributionRecord | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const normalizedId = normalizePluginId(id);
  if (!normalizedId) {
    return undefined;
  }
  const mcpServer = normalizePluginMcpServer(item);
  const diagnostics = !mcpServer
    ? [{
        severity: "warn",
        code: "PLUGIN_MCP_SERVER_INVALID",
        message: `Plugin MCP server ${normalizedId} requires ${item.transport === "http" ? "url" : "command"}.`
      } satisfies CapabilityDiagnostic]
    : [];
  return {
    kind: "mcp_server",
    id: normalizedId,
    title: normalizedId,
    description: stringValue(item.description) || "Plugin MCP server contribution.",
    riskClass: "r2",
    metadata: {
      transport: item.transport === "http" ? "http" : "stdio",
      command: typeof item.command === "string" ? item.command : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      exposeTools: item.exposeTools !== false,
      exposeResources: item.exposeResources === true,
      exposePrompts: item.exposePrompts === true,
      diagnostics,
      manifest: item
    },
    mcpServer
  };
}

export function loadPluginMcpServerSettings(settings: SwarmSettings, workspace: string): Record<string, McpServerSettings> {
  const provider = new PluginProvider({ settings, workspace });
  return Object.fromEntries(provider.listPlugins()
    .filter((plugin) => plugin.trust === "trusted")
    .flatMap((plugin) => plugin.contributions
      .filter((contribution) => contribution.kind === "mcp_server" && contribution.mcpServer)
      .map((contribution) => [
        `${plugin.id}.${contribution.id}`,
        {
          ...contribution.mcpServer!,
          trust: plugin.scope === "project" ? "project" : "user",
          cwd: contribution.mcpServer!.cwd ? resolve(plugin.directory, contribution.mcpServer!.cwd) : plugin.directory
        } satisfies McpServerSettings
      ] as const)));
}

function normalizePluginMcpServer(item: Record<string, unknown>): McpServerSettings | undefined {
  const transport = item.transport === "http" ? "http" : "stdio";
  const command = typeof item.command === "string" && item.command.trim() ? item.command.trim() : undefined;
  const url = typeof item.url === "string" && item.url.trim() ? item.url.trim() : undefined;
  if (transport === "stdio" && !command) {
    return undefined;
  }
  if (transport === "http" && !url) {
    return undefined;
  }
  return {
    disabled: item.disabled === true,
    transport,
    command,
    args: Array.isArray(item.args) ? item.args.map(String) : [],
    cwd: typeof item.cwd === "string" && item.cwd.trim() ? item.cwd : undefined,
    env: isStringRecord(item.env),
    url,
    headers: isStringRecord(item.headers),
    trust: "user",
    exposeTools: item.exposeTools !== false,
    exposeResources: item.exposeResources === true,
    exposePrompts: item.exposePrompts === true,
    timeoutMs: positiveInteger(item.timeoutMs, 30_000)
  };
}

function pluginDescriptor(record: PluginRecord): CapabilityDescriptor {
  return {
    id: `plugin.${record.id}`,
    kind: "plugin",
    source: record.scope === "project" ? "project" : "plugin",
    trust: record.trust,
    providerId: "plugins",
    name: record.id,
    title: record.name,
    description: record.description,
    riskClass: "r0",
    permissionName: `Plugin(${record.id})`,
    modelVisible: false,
    userVisible: true,
    status: record.trust === "disabled" || record.trust === "untrusted" ? "disabled" : "available",
    diagnostics: [
      ...record.diagnostics,
      ...(Array.isArray(contribution.metadata.diagnostics) ? contribution.metadata.diagnostics as CapabilityDiagnostic[] : [])
    ],
    metadata: {
      version: record.version,
      scope: record.scope,
      path: record.path,
      directory: record.directory,
      checksum: record.checksum,
      contributions: record.contributions.map((item) => `${item.kind}:${item.id}`)
    }
  };
}

function contributionDescriptor(record: PluginRecord, contribution: PluginContributionRecord): CapabilityDescriptor {
  const id = `plugin.${record.id}.${contribution.kind}.${contribution.id}`;
  return {
    id,
    kind: contribution.kind === "mcp_server" ? "plugin" : contribution.kind,
    source: record.scope === "project" ? "project" : "plugin",
    trust: record.trust,
    providerId: `plugin:${record.id}`,
    name: contribution.kind === "slash_command" ? `/${contribution.id}` : contribution.id,
    title: contribution.title,
    description: contribution.description,
    inputSchema: {
      type: "object",
      contribution: contribution.kind
    },
    riskClass: contribution.riskClass,
    permissionName: `PluginContribution(${record.id}:${contribution.kind}:${contribution.id})`,
    modelVisible: false,
    userVisible: true,
    status: record.trust === "disabled" || record.trust === "untrusted" ? "disabled" : "available",
    diagnostics: record.diagnostics,
    metadata: {
      plugin_id: record.id,
      plugin_path: record.path,
      contribution: contribution.kind,
      checksum: record.checksum,
      ...contribution.metadata
    }
  };
}

function dedupePlugins(records: PluginRecord[]): PluginRecord[] {
  const seen = new Map<string, PluginRecord>();
  const result: PluginRecord[] = [];
  for (const record of records) {
    const existing = seen.get(record.id);
    if (existing) {
      result.push({
        ...record,
        trust: "disabled",
        diagnostics: [
          ...record.diagnostics,
          {
            severity: "error",
            code: "PLUGIN_SHADOWED",
            message: `Plugin ${record.id} is shadowed by ${existing.path}.`
          }
        ]
      });
      continue;
    }
    seen.set(record.id, record);
    result.push(record);
  }
  return result;
}

function normalizePluginId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTrustedWorkspace(workspace: string): boolean {
  if (process.env.SWARM_TRUSTED_WORKSPACE_ROOT) {
    const trustedRoot = resolve(process.env.SWARM_TRUSTED_WORKSPACE_ROOT);
    const current = resolve(workspace);
    return current === trustedRoot || current.startsWith(`${trustedRoot}\\`) || current.startsWith(`${trustedRoot}/`);
  }
  return process.env.SWARM_TRUST_PROJECT_PLUGINS === "1";
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
