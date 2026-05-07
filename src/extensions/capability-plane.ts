import type { SwarmSettings } from "../config/settings.js";
import { AgentSpecProvider } from "./agent-specs.js";
import { BuiltinLocalToolProvider } from "./builtin-tools.js";
import { CapabilityRegistry } from "./registry.js";
import { McpClientProvider, type McpServerRecord } from "./mcp.js";
import { PluginProvider, type PluginRecord } from "./plugins.js";
import { SkillProvider, type ActivatedSkill, type SkillRecord } from "./skills.js";
import { SlashCommandProvider } from "./slash-commands.js";
import type {
  CapabilityDescriptor,
  CapabilityFilter,
  CapabilityProviderSnapshot
} from "./types.js";

export class CapabilityPlane {
  readonly registry = new CapabilityRegistry();
  readonly skills: SkillProvider;
  readonly mcp: McpClientProvider;
  readonly plugins: PluginProvider;

  constructor(readonly settings: SwarmSettings, readonly workspace: string) {
    this.skills = new SkillProvider({ settings, workspace });
    this.mcp = new McpClientProvider({ settings, workspace });
    this.plugins = new PluginProvider({ settings, workspace });
    this.registry.register(new BuiltinLocalToolProvider());
    this.registry.register(new SlashCommandProvider());
    this.registry.register(new AgentSpecProvider({ settings, workspace }));
    this.registry.register(this.skills);
    this.registry.register(this.mcp);
    this.registry.register(this.plugins);
  }

  async listCapabilities(filter: CapabilityFilter = {}): Promise<CapabilityDescriptor[]> {
    const capabilities = (await this.registry.list({ includeDisabled: true }))
      .map((capability) => applyCapabilitySettings(capability, this.settings))
      .filter((capability) => matchesCapabilityFilter(capability, filter));
    return capabilities;
  }

  async getCapability(id: string): Promise<CapabilityDescriptor | undefined> {
    const capability = await this.registry.get(id);
    return capability ? applyCapabilitySettings(capability, this.settings) : undefined;
  }

  refresh(providerId?: string): Promise<CapabilityProviderSnapshot[]> {
    return this.registry.refresh(providerId?.startsWith("mcp:") ? "mcp" : providerId);
  }

  listProviders(): Promise<CapabilityProviderSnapshot[]> {
    return this.registry.listProviders();
  }

  listSkills(): SkillRecord[] {
    return this.skills.listSkills();
  }

  activateSkill(name: string): ActivatedSkill {
    return this.skills.activateSkill(name);
  }

  listPlugins(): PluginRecord[] {
    return this.plugins.listPlugins();
  }

  listMcpServers(): McpServerRecord[] {
    return this.mcp.listServers();
  }

  async refreshMcpServer(serverId: string): Promise<McpServerRecord> {
    const record = await this.mcp.refreshServer(serverId);
    this.registry.invalidate("mcp");
    return record;
  }

  callMcpTool(capabilityId: string, args: Record<string, unknown>) {
    return this.mcp.callTool(capabilityId, args);
  }

  listMcpResources(serverId: string) {
    return this.mcp.listResources(serverId);
  }

  listMcpPrompts(serverId: string) {
    return this.mcp.listPrompts(serverId);
  }

  readMcpResource(serverId: string, uri: string) {
    return this.mcp.readResource(serverId, uri);
  }

  getMcpPrompt(serverId: string, name: string, args?: Record<string, string>) {
    return this.mcp.getPrompt(serverId, name, args);
  }

  dispose(): Promise<void> {
    return this.registry.dispose();
  }
}

function applyCapabilitySettings(capability: CapabilityDescriptor, settings: SwarmSettings): CapabilityDescriptor {
  const disabled = capabilityIdMatches(settings.extensions.capabilities.disabled, capability);
  const hidden = capabilityIdMatches(settings.extensions.capabilities.hiddenFromModel, capability);
  if (!disabled && !hidden) {
    return capability;
  }
  return {
    ...capability,
    trust: disabled ? "disabled" : capability.trust,
    status: disabled ? "disabled" : capability.status,
    modelVisible: hidden ? false : capability.modelVisible,
    diagnostics: [
      ...(capability.diagnostics ?? []),
      disabled
        ? {
            severity: "info",
            code: "CAPABILITY_DISABLED_BY_SETTINGS",
            message: `Capability ${capability.id} is disabled by settings.extensions.capabilities.disabled.`
          }
        : {
            severity: "info",
            code: "CAPABILITY_HIDDEN_FROM_MODEL",
            message: `Capability ${capability.id} is hidden by settings.extensions.capabilities.hiddenFromModel.`
          }
    ]
  };
}

function capabilityIdMatches(patterns: string[], capability: CapabilityDescriptor): boolean {
  return patterns.some((pattern) =>
    pattern === capability.id ||
    pattern === capability.providerId ||
    pattern === `${capability.providerId}:*` ||
    pattern === `${capability.kind}:*` ||
    (pattern.endsWith("*") && capability.id.startsWith(pattern.slice(0, -1)))
  );
}

function matchesCapabilityFilter(capability: CapabilityDescriptor, filter: CapabilityFilter): boolean {
  if (!filter.includeDisabled && (capability.trust === "disabled" || capability.status === "disabled")) {
    return false;
  }
  if (filter.kind && capability.kind !== filter.kind) {
    return false;
  }
  if (filter.source && capability.source !== filter.source) {
    return false;
  }
  if (filter.trust && capability.trust !== filter.trust) {
    return false;
  }
  const provider = filter.providerId ?? filter.provider;
  if (provider && capability.providerId !== provider) {
    return false;
  }
  if (typeof filter.modelVisible === "boolean" && capability.modelVisible !== filter.modelVisible) {
    return false;
  }
  if (typeof filter.userVisible === "boolean" && capability.userVisible !== filter.userVisible) {
    return false;
  }
  if (filter.query) {
    const query = filter.query.toLowerCase();
    const haystack = [
      capability.id,
      capability.name,
      capability.title ?? "",
      capability.description,
      capability.providerId,
      capability.permissionName
    ].join("\n").toLowerCase();
    return haystack.includes(query);
  }
  return true;
}

export function createCapabilityPlane(input: {
  settings: SwarmSettings;
  workspace: string;
}): CapabilityPlane {
  return new CapabilityPlane(input.settings, input.workspace);
}
