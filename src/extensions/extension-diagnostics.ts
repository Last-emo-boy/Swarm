import type { McpCatalogSummary, SkillCatalogSummary } from "./catalog-summary.js";
import type { McpServerRecord } from "./mcp.js";
import type { SkillRecord } from "./skills.js";

export type ExtensionDiagnosticSeverity = "ok" | "info" | "warning" | "error";

export type McpRuntimeState =
  | "disabled"
  | "enabled_empty"
  | "configured"
  | "connected"
  | "pending"
  | "failed"
  | "degraded";

export type SkillRuntimeState =
  | "disabled"
  | "empty"
  | "active"
  | "shadowed"
  | "untrusted"
  | "degraded";

export type McpRuntimeDiagnostic = {
  state: McpRuntimeState;
  severity: ExtensionDiagnosticSeverity;
  label: string;
  evidence: string;
  reason: string;
  nextAction: string;
};

export type SkillRuntimeDiagnostic = {
  state: SkillRuntimeState;
  severity: ExtensionDiagnosticSeverity;
  label: string;
  evidence: string;
  reason: string;
  nextAction: string;
};

export type McpRuntimeSettingsSnapshot = {
  enabled: boolean;
  expose_gateway_server?: boolean;
  configured_servers: number;
  runtime_config?: string;
};

export type SkillRuntimeSettingsSnapshot = {
  enabled: boolean;
  load_project_skills: string;
  configured_roots: string[];
  max_skills: number;
};

export function summarizeMcpRuntimeState(input: {
  settings: McpRuntimeSettingsSnapshot;
  servers: McpServerRecord[];
  summary?: McpCatalogSummary;
}): McpRuntimeDiagnostic {
  const settings = input.settings;
  const servers = input.servers;
  const connected = servers.filter((server) => server.status === "connected").length;
  const pending = servers.filter((server) => server.status === "pending").length;
  const failed = servers.filter((server) => server.status === "failed").length;
  const disabled = servers.filter((server) => server.status === "disabled").length;
  const tools = servers.reduce((total, server) => total + server.toolCount, 0);
  const resources = servers.reduce((total, server) => total + server.resourceCount, 0);
  const prompts = servers.reduce((total, server) => total + server.promptCount, 0);
  const configured = settings.configured_servers || servers.length;

  if (!settings.enabled) {
    return {
      state: "disabled",
      severity: "info",
      label: "MCP OFF",
      evidence: "disabled",
      reason: "MCP client support is disabled by settings.extensions.mcp.enabled.",
      nextAction: "Set settings.extensions.mcp.enabled=true or pass --mcp-config for a run."
    };
  }
  if (configured === 0 && servers.length === 0) {
    return {
      state: "enabled_empty",
      severity: "info",
      label: "MCP EMPTY",
      evidence: "0 servers",
      reason: "MCP is enabled but no servers are configured.",
      nextAction: "Add settings.extensions.mcp.servers or pass --mcp-config JSON_OR_FILE."
    };
  }
  if (failed > 0 && connected === 0) {
    return {
      state: "failed",
      severity: "error",
      label: "MCP FAILED",
      evidence: `${failed} failed/${servers.length} servers`,
      reason: firstMcpFailureReason(servers) ?? "All configured MCP servers failed to connect.",
      nextAction: "Run swarm mcp show <server_id> and swarm mcp refresh <server_id>."
    };
  }
  if (failed > 0 || disabled > 0) {
    return {
      state: "degraded",
      severity: "warning",
      label: "MCP DEGRADED",
      evidence: `${connected} connected/${failed} failed/${disabled} disabled`,
      reason: firstMcpFailureReason(servers) ?? "Some MCP servers are unavailable.",
      nextAction: "Inspect /mcp all or GET /v1/mcp/servers for diagnostics."
    };
  }
  if (pending > 0 && connected === 0) {
    return {
      state: "pending",
      severity: "info",
      label: "MCP PENDING",
      evidence: `${pending} pending`,
      reason: "MCP servers are configured but have not connected yet.",
      nextAction: "Run swarm mcp refresh <server_id> or open /mcp all."
    };
  }
  if (connected > 0) {
    return {
      state: "connected",
      severity: "ok",
      label: "MCP ON",
      evidence: `${connected} servers ${tools} tools ${resources} resources ${prompts} prompts`,
      reason: "At least one MCP server is connected.",
      nextAction: "Use /mcp all, /mcp-resources, /mcp-prompts, or ToolSearch for deferred tools."
    };
  }
  return {
    state: "configured",
    severity: "info",
    label: "MCP CONFIG",
    evidence: `${configured} configured`,
    reason: "MCP servers are configured but no active catalog is loaded.",
    nextAction: "Run swarm mcp refresh <server_id>."
  };
}

export function summarizeSkillRuntimeState(input: {
  settings: SkillRuntimeSettingsSnapshot;
  skills: SkillRecord[];
  summary?: SkillCatalogSummary;
}): SkillRuntimeDiagnostic {
  const settings = input.settings;
  const skills = input.skills;
  const active = skills.filter((skill) => !skill.shadowedBy);
  const shadowed = skills.length - active.length;
  const trusted = active.filter((skill) => skill.trust === "trusted");
  const untrusted = active.filter((skill) => skill.trust === "untrusted" || skill.trust === "disabled");
  const actionableDiagnostics = skills.flatMap((skill) =>
    (skill.diagnostics ?? []).filter((diagnostic) => diagnostic.severity !== "info")
  );

  if (!settings.enabled) {
    return {
      state: "disabled",
      severity: "info",
      label: "SKILLS OFF",
      evidence: "disabled",
      reason: "Agent Skills are disabled by settings.extensions.skills.enabled.",
      nextAction: "Set settings.extensions.skills.enabled=true."
    };
  }
  if (skills.length === 0) {
    const roots = skillDiscoveryRoots(settings).join(", ");
    return {
      state: "empty",
      severity: "info",
      label: "SKILLS EMPTY",
      evidence: "0 discovered",
      reason: `No SKILL.md files were discovered. Project mode=${settings.load_project_skills}; configured roots=${settings.configured_roots.length}.`,
      nextAction: `Add a SKILL.md under ${roots} or configure settings.extensions.skills.roots.`
    };
  }
  if (trusted.length === 0 && untrusted.length > 0) {
    return {
      state: "untrusted",
      severity: "warning",
      label: "SKILLS UNTRUSTED",
      evidence: `${untrusted.length} untrusted`,
      reason: "Skills were found but none are trusted for activation.",
      nextAction: "Trust the workspace, move the skill to the user skill root, or adjust loadProjectSkills."
    };
  }
  if (shadowed > 0 || actionableDiagnostics.length > 0) {
    return {
      state: shadowed > 0 ? "shadowed" : "degraded",
      severity: "warning",
      label: shadowed > 0 ? "SKILLS SHADOWED" : "SKILLS WARN",
      evidence: `${active.length} active/${shadowed} shadowed/${trusted.length} trusted`,
      reason: firstSkillDiagnostic(skills) ?? "Some skills have diagnostics.",
      nextAction: "Run swarm skills --json or /skills all to inspect paths and shadowing."
    };
  }
  return {
    state: "active",
    severity: "ok",
    label: "SKILLS ON",
    evidence: `${active.length} active/${trusted.length} trusted`,
    reason: "Trusted skills are available for activation.",
    nextAction: "Use /skill <name>, swarm skills activate <name>, or --skill for headless runs."
  };
}

function firstMcpFailureReason(servers: McpServerRecord[]): string | undefined {
  const failed = servers.find((server) => server.lastError || server.diagnostics.length);
  return failed?.lastError ?? failed?.diagnostics[0]?.message;
}

function firstSkillDiagnostic(skills: SkillRecord[]): string | undefined {
  for (const skill of skills) {
    const diagnostic = skill.diagnostics[0];
    if (diagnostic) {
      return `${skill.name}: ${diagnostic.message}`;
    }
    if (skill.shadowedBy) {
      return `${skill.name} is shadowed by ${skill.shadowedBy}.`;
    }
  }
  return undefined;
}

function skillDiscoveryRoots(settings: SkillRuntimeSettingsSnapshot): string[] {
  return [
    "$SWARM_HOME/skills",
    ".swarm/skills",
    ".agents/skills",
    ...settings.configured_roots
  ];
}
