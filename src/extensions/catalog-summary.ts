import type { CapabilityDescriptor, CapabilityProviderSnapshot } from "./types.js";
import type { SkillRecord } from "./skills.js";
import type { PluginRecord } from "./plugins.js";
import type { McpServerRecord } from "./mcp.js";

export type CapabilityCatalogSummary = {
  totals: {
    capabilities: number;
    providers: number;
    ready: number;
    modelVisible: number;
    hidden: number;
    disabled: number;
    userVisible: number;
  };
  byKind: Array<{ kind: string; count: number }>;
  topCapabilities: Array<{
    id: string;
    title: string;
    kind: string;
    providerId: string;
    trust: CapabilityDescriptor["trust"];
    modelVisible: boolean;
    userVisible: boolean;
  }>;
  providers: Array<{
    providerId: string;
    capabilities: number;
    diagnostics: Array<{ severity: string; code?: string; message: string }>;
  }>;
  diagnostics: Array<{ providerId: string; code?: string; message: string }>;
};

export type SkillCatalogSummary = {
  totals: {
    skills: number;
    active: number;
    shadowed: number;
    trusted: number;
  };
  topSkills: Array<{
    name: string;
    scope: string;
    trust: string;
    description: string;
    shadowedBy?: string;
  }>;
  diagnostics: Array<{ name: string; code?: string; message: string }>;
};

export type PluginCatalogSummary = {
  totals: {
    plugins: number;
    trusted: number;
    contributions: number;
    slashCommands: number;
  };
  topPlugins: Array<{
    id: string;
    scope: string;
    trust: string;
    description: string;
    contributions: number;
  }>;
  slashContributions: Array<{
    pluginId: string;
    id: string;
    description: string;
  }>;
  diagnostics: Array<{ pluginId: string; code?: string; message: string }>;
};

export type McpCatalogSummary = {
  totals: {
    servers: number;
    connected: number;
    pending: number;
    failed: number;
    disabled: number;
    tools: number;
    resources: number;
    prompts: number;
  };
  topServers: Array<{
    id: string;
    status: McpServerRecord["status"];
    transport: McpServerRecord["transport"];
    trust: McpServerRecord["trust"];
    tools: number;
    resources: number;
    prompts: number;
  }>;
  diagnostics: Array<{ serverId: string; code?: string; message: string }>;
  errors: Array<{ serverId: string; message: string }>;
};

export function summarizeCapabilityCatalog(
  capabilities: CapabilityDescriptor[],
  providers: CapabilityProviderSnapshot[]
): CapabilityCatalogSummary {
  const byKind = new Map<string, number>();
  for (const capability of capabilities) {
    byKind.set(capability.kind, (byKind.get(capability.kind) ?? 0) + 1);
  }
  return {
    totals: {
      capabilities: capabilities.length,
      providers: providers.length,
      ready: capabilities.filter((capability) => capability.status !== "disabled" && capability.trust !== "disabled").length,
      modelVisible: capabilities.filter((capability) => capability.modelVisible).length,
      hidden: capabilities.filter((capability) => !capability.userVisible || !capability.modelVisible).length,
      disabled: capabilities.filter((capability) => capability.status === "disabled" || capability.trust === "disabled").length,
      userVisible: capabilities.filter((capability) => capability.userVisible).length
    },
    byKind: [...byKind.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => ({ kind, count })),
    topCapabilities: [...capabilities]
      .filter((capability) => capability.userVisible || capability.modelVisible)
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
      .slice(0, 8)
      .map((capability) => ({
        id: capability.id,
        title: capability.title ?? capability.name,
        kind: capability.kind,
        providerId: capability.providerId,
        trust: capability.trust,
        modelVisible: capability.modelVisible,
        userVisible: capability.userVisible
      })),
    providers: [...providers]
      .sort((left, right) => right.capabilities - left.capabilities || left.providerId.localeCompare(right.providerId))
      .slice(0, 6)
      .map((provider) => ({
        providerId: provider.providerId,
        capabilities: provider.capabilities,
        diagnostics: provider.diagnostics.map((item) => ({
          severity: item.severity,
          code: item.code,
          message: item.message
        }))
      })),
    diagnostics: providers.flatMap((provider) =>
      provider.diagnostics.map((item) => ({
        providerId: provider.providerId,
        code: item.code,
        message: item.message
      }))
    ).slice(0, 4)
  };
}

export function summarizeSkillCatalog(skills: SkillRecord[]): SkillCatalogSummary {
  const active = skills.filter((skill) => !skill.shadowedBy);
  return {
    totals: {
      skills: skills.length,
      active: active.length,
      shadowed: skills.length - active.length,
      trusted: skills.filter((skill) => skill.trust === "trusted").length
    },
    topSkills: active
      .slice(0, 6)
      .map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        trust: skill.trust,
        description: skill.description,
        shadowedBy: skill.shadowedBy
      })),
    diagnostics: skills.flatMap((skill) =>
      skill.diagnostics.map((item) => ({
        name: skill.name,
        code: item.code,
        message: item.message
      }))
    ).slice(0, 4)
  };
}

export function summarizePluginCatalog(plugins: PluginRecord[]): PluginCatalogSummary {
  return {
    totals: {
      plugins: plugins.length,
      trusted: plugins.filter((plugin) => plugin.trust === "trusted").length,
      contributions: plugins.reduce((total, plugin) => total + plugin.contributions.length, 0),
      slashCommands: plugins.reduce((total, plugin) => total + plugin.contributions.filter((item) => item.kind === "slash_command").length, 0)
    },
    topPlugins: [...plugins]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 6)
      .map((plugin) => ({
        id: plugin.id,
        scope: plugin.scope,
        trust: plugin.trust,
        description: plugin.description,
        contributions: plugin.contributions.length
      })),
    slashContributions: plugins.flatMap((plugin) =>
      plugin.contributions
        .filter((item) => item.kind === "slash_command")
        .map((item) => ({
          pluginId: plugin.id,
          id: item.id,
          description: item.description
        }))
    ).slice(0, 4),
    diagnostics: plugins.flatMap((plugin) =>
      plugin.diagnostics.map((item) => ({
        pluginId: plugin.id,
        code: item.code,
        message: item.message
      }))
    ).slice(0, 4)
  };
}

export function summarizeMcpCatalog(servers: McpServerRecord[]): McpCatalogSummary {
  return {
    totals: {
      servers: servers.length,
      connected: servers.filter((server) => server.status === "connected").length,
      pending: servers.filter((server) => server.status === "pending").length,
      failed: servers.filter((server) => server.status === "failed").length,
      disabled: servers.filter((server) => server.status === "disabled").length,
      tools: servers.reduce((total, server) => total + server.toolCount, 0),
      resources: servers.reduce((total, server) => total + server.resourceCount, 0),
      prompts: servers.reduce((total, server) => total + server.promptCount, 0)
    },
    topServers: [...servers]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 6)
      .map((server) => ({
        id: server.id,
        status: server.status,
        transport: server.transport,
        trust: server.trust,
        tools: server.toolCount,
        resources: server.resourceCount,
        prompts: server.promptCount
      })),
    diagnostics: servers.flatMap((server) =>
      server.diagnostics.map((item) => ({
        serverId: server.id,
        code: item.code,
        message: item.message
      }))
    ).slice(0, 4),
    errors: servers
      .filter((server) => Boolean(server.lastError))
      .slice(0, 4)
      .map((server) => ({
        serverId: server.id,
        message: server.lastError as string
      }))
  };
}
