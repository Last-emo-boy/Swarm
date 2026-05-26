import type { LspStatusReport } from "../lsp/manager.js";
import type { CapabilityDescriptor } from "./types.js";
import type { McpCatalogSummary } from "./catalog-summary.js";
import type { McpServerRecord } from "./mcp.js";
import type { SkillRecord } from "./skills.js";

export type CapabilityParticipantKind = "lsp" | "mcp" | "skill";
export type CapabilityParticipantState =
  | "available"
  | "disabled"
  | "untrusted"
  | "shadowed"
  | "failed"
  | "pending"
  | "no-provider"
  | "degraded";

export type CapabilityParticipantProjection = {
  participant_id: string;
  kind: CapabilityParticipantKind;
  label: string;
  state: CapabilityParticipantState;
  trust: CapabilityDescriptor["trust"];
  capability_ids: string[];
  evidence: Record<string, unknown>;
  recoverySuggestion?: string;
  lease: {
    required: boolean;
    capability: string;
    source: "capability_plane";
    reason: string;
  };
};

export type CapabilityParticipantSnapshot = {
  schema_version: "swarm.capability_participants.v1";
  generated_at: string;
  participants: CapabilityParticipantProjection[];
  summary: {
    total: number;
    available: number;
    disabled: number;
    untrusted: number;
    shadowed: number;
    failed: number;
    pending: number;
    no_provider: number;
    degraded: number;
    by_kind: Record<CapabilityParticipantKind, number>;
  };
};

export function buildCapabilityParticipantSnapshot(input: {
  capabilities?: CapabilityDescriptor[];
  mcpServers?: McpServerRecord[];
  mcpSummary?: McpCatalogSummary;
  skills?: SkillRecord[];
  lspStatus?: LspStatusReport;
  generatedAt?: string;
}): CapabilityParticipantSnapshot {
  const capabilities = input.capabilities ?? [];
  const participants = [
    ...mcpParticipants(input.mcpServers ?? [], capabilities, input.mcpSummary),
    ...skillParticipants(input.skills ?? [], capabilities),
    ...lspParticipants(input.lspStatus, capabilities)
  ];
  return {
    schema_version: "swarm.capability_participants.v1",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    participants,
    summary: summarizeParticipants(participants)
  };
}

function mcpParticipants(
  servers: McpServerRecord[],
  capabilities: CapabilityDescriptor[],
  summary: McpCatalogSummary | undefined
): CapabilityParticipantProjection[] {
  return servers.map((server) => {
    const capabilityIds = capabilities
      .filter((capability) => capability.providerId === `mcp:${server.id}`)
      .map((capability) => capability.id)
      .sort();
    const state = mcpParticipantState(server);
    return {
      participant_id: `capability:mcp:${server.id}`,
      kind: "mcp",
      label: `MCP ${server.id}`,
      state,
      trust: server.status === "disabled" ? "disabled" : server.trust === "user" || server.trust === "workspace" ? "trusted" : "untrusted",
      capability_ids: capabilityIds,
      evidence: {
        server_id: server.id,
        status: server.status,
        transport: server.transport,
        tool_count: server.toolCount,
        resource_count: server.resourceCount,
        prompt_count: server.promptCount,
        last_error: server.lastError,
        diagnostics: server.diagnostics,
        runtime_state: summary?.runtime?.state
      },
      recoverySuggestion: mcpRecovery(server, summary),
      lease: leaseProjection(`mcp:${server.id}`, "MCP server calls require a scoped capability lease because they cross the local capability boundary.")
    };
  });
}

function skillParticipants(skills: SkillRecord[], capabilities: CapabilityDescriptor[]): CapabilityParticipantProjection[] {
  return skills.map((skill) => {
    const capabilityIds = capabilities
      .filter((capability) => capability.kind === "skill" && (capability.name === skill.name || capability.id === `skill.${skill.name}`))
      .map((capability) => capability.id)
      .sort();
    const state = skillParticipantState(skill);
    return {
      participant_id: `capability:skill:${skill.name}`,
      kind: "skill",
      label: `Skill ${skill.name}`,
      state,
      trust: skill.shadowedBy ? "disabled" : skill.trust,
      capability_ids: capabilityIds,
      evidence: {
        name: skill.name,
        scope: skill.scope,
        path: skill.path,
        shadowed_by: skill.shadowedBy,
        diagnostics: skill.diagnostics,
        allowed_tools: skill.allowedTools,
        resource_paths: skill.resourcePaths
      },
      recoverySuggestion: skillRecovery(skill),
      lease: leaseProjection(`skill:${skill.name}`, "Skill activation requires a trusted capability lease before instructions enter durable context.")
    };
  });
}

function lspParticipants(
  report: LspStatusReport | undefined,
  capabilities: CapabilityDescriptor[]
): CapabilityParticipantProjection[] {
  if (!report) {
    return [];
  }
  return report.providers.map((provider) => {
    const providerCapabilities = capabilities
      .filter((capability) => capability.providerId === `lsp:${provider.providerId}`)
      .map((capability) => capability.id)
      .sort();
    const facts = provider.capabilities ?? [];
    const unavailable = facts.filter((fact) => !fact.available);
    const state = lspParticipantState(provider, unavailable.length, facts.length);
    const nextAction = uniqueStrings([
      provider.reason,
      ...facts.map((fact) => fact.next_action)
    ])[0];
    return {
      participant_id: `capability:lsp:${provider.providerId}`,
      kind: "lsp",
      label: `LSP ${provider.providerId}`,
      state,
      trust: state === "no-provider" ? "disabled" : "trusted",
      capability_ids: providerCapabilities,
      evidence: {
        provider_id: provider.providerId,
        status: provider.status,
        detected: provider.detected,
        available: provider.available,
        root: provider.root,
        command: provider.command,
        fallback_reasons: uniqueStrings(facts.map((fact) => fact.fallback_reason)),
        unavailable_actions: unavailable.map((fact) => fact.action),
        last_error: provider.lastError
      },
      recoverySuggestion: nextAction,
      lease: leaseProjection(`lsp:${provider.providerId}`, "LSP semantic evidence requires a read-only capability lease tied to the requesting actor/task.")
    };
  });
}

function mcpParticipantState(server: McpServerRecord): CapabilityParticipantState {
  if (server.status === "connected") return "available";
  if (server.status === "failed") return "failed";
  if (server.status === "pending") return "pending";
  return "disabled";
}

function skillParticipantState(skill: SkillRecord): CapabilityParticipantState {
  if (skill.shadowedBy) return "shadowed";
  if (skill.trust === "untrusted") return "untrusted";
  if (skill.trust === "disabled") return "disabled";
  return "available";
}

function lspParticipantState(
  provider: LspStatusReport["providers"][number],
  unavailableCapabilities: number,
  totalCapabilities: number
): CapabilityParticipantState {
  if (!provider.detected) return "no-provider";
  if (provider.status === "failed" || provider.status === "exited") return "failed";
  if (provider.status === "starting") return "pending";
  if (!provider.available || provider.status === "unavailable") return "disabled";
  if (unavailableCapabilities > 0 && totalCapabilities > 0) return "degraded";
  return "available";
}

function mcpRecovery(server: McpServerRecord, summary: McpCatalogSummary | undefined): string | undefined {
  if (server.status === "disabled") {
    return "Enable MCP and the specific server before granting a capability lease.";
  }
  if (server.status === "failed") {
    return server.lastError ?? summary?.runtime?.nextAction ?? "Inspect the MCP server diagnostics and refresh it.";
  }
  if (server.status === "pending") {
    return "Refresh the MCP server to connect and populate its capability catalog.";
  }
  return undefined;
}

function skillRecovery(skill: SkillRecord): string | undefined {
  if (skill.shadowedBy) {
    return `Use the active skill shadowing this one, or remove the duplicate at ${skill.shadowedBy}.`;
  }
  if (skill.trust === "untrusted") {
    return "Trust the workspace, move the skill to a trusted user root, or choose a trusted skill.";
  }
  if (skill.trust === "disabled") {
    return "Enable skills before activating this capability.";
  }
  return undefined;
}

function leaseProjection(capability: string, reason: string): CapabilityParticipantProjection["lease"] {
  return {
    required: true,
    capability,
    source: "capability_plane",
    reason
  };
}

function summarizeParticipants(participants: CapabilityParticipantProjection[]): CapabilityParticipantSnapshot["summary"] {
  const byKind = { lsp: 0, mcp: 0, skill: 0 };
  for (const participant of participants) {
    byKind[participant.kind] += 1;
  }
  return {
    total: participants.length,
    available: participants.filter((participant) => participant.state === "available").length,
    disabled: participants.filter((participant) => participant.state === "disabled").length,
    untrusted: participants.filter((participant) => participant.state === "untrusted").length,
    shadowed: participants.filter((participant) => participant.state === "shadowed").length,
    failed: participants.filter((participant) => participant.state === "failed").length,
    pending: participants.filter((participant) => participant.state === "pending").length,
    no_provider: participants.filter((participant) => participant.state === "no-provider").length,
    degraded: participants.filter((participant) => participant.state === "degraded").length,
    by_kind: byKind
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort();
}
