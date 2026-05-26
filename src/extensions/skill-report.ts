import type { SwarmRuntime } from "../runtime/runtime.js";
import { summarizeSkillCatalog } from "./catalog-summary.js";
import type { ActivatedSkill, SkillRecord } from "./skills.js";

export type SkillSelectorResolution = {
  skillName?: string;
  error?: string;
};

export type SkillCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export function buildSkillListReport(runtime: SwarmRuntime): SkillCliReport {
  const skills = runtime.listSkills();
  const settings = skillSettingsSnapshot(runtime);
  const summary = summarizeSkillCatalog(skills, settings);
  const lines = [
    "Swarm Skills",
    `workspace=${runtime.getWorkspacePath()}`,
    `settings enabled=${settings.enabled ? "yes" : "no"} load_project=${settings.load_project_skills} configured_roots=${settings.configured_roots.length} max=${settings.max_skills}`,
    `summary skills=${summary.totals.skills} active=${summary.totals.active} shadowed=${summary.totals.shadowed} trusted=${summary.totals.trusted}`,
    summary.runtime ? `runtime ${summary.runtime.label} state=${summary.runtime.state} severity=${summary.runtime.severity} evidence=${summary.runtime.evidence}` : undefined,
    summary.runtime ? `reason=${summary.runtime.reason}` : undefined,
    summary.runtime ? `next=${summary.runtime.nextAction}` : undefined,
    ""
  ].filter((line): line is string => typeof line === "string");
  if (!skills.length) {
    lines.push("No skills discovered.");
    lines.push("");
    lines.push("Use `swarm skills show <name>` after adding a project or user skill root.");
  } else {
    for (const skill of skills) {
      lines.push(formatSkillSummaryLine(skill));
      if (skill.diagnostics.length) {
        lines.push(`  diagnostics=${skill.diagnostics.length}`);
      }
    }
    lines.push("");
    lines.push("Use `swarm skills show <name>` for paths and diagnostics, or `swarm skills activate <name>` for full instructions.");
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings,
      summary,
      skills
    }
  };
}

export async function buildSkillDetailReport(runtime: SwarmRuntime, selector?: string): Promise<SkillCliReport> {
  const resolution = resolveSkillSelector(runtime, selector);
  if (!resolution.skillName) {
    throw new Error(resolution.error ?? `Unknown skill: ${selector ?? "(missing)"}`);
  }
  const skill = requireSkill(runtime, resolution.skillName);
  const capability = await runtime.getCapability(`skill.${skill.name}`);
  const lines = [
    "Swarm Skill",
    `workspace=${runtime.getWorkspacePath()}`,
    `skill=${skill.name} scope=${skill.scope} trust=${skill.trust}${skill.shadowedBy ? ` shadowed_by=${skill.shadowedBy}` : ""}`,
    `path=${skill.path}`,
    `directory=${skill.directory}`,
    "",
    "Description",
    skill.description,
    "",
    "Access",
    skill.allowedTools.length ? `allowed_tools=${skill.allowedTools.join(", ")}` : "allowed_tools=(none)",
    skill.resourcePaths.length ? `resources=\n${skill.resourcePaths.map((path) => `  ${path}`).join("\n")}` : "resources=(none)",
    capability ? `capability=${capability.id} status=${capability.status} model_visible=${capability.modelVisible ? "yes" : "no"}` : undefined
  ].filter(Boolean);
  if (skill.diagnostics.length) {
    lines.push("");
    lines.push("Diagnostics");
    for (const diagnostic of skill.diagnostics) {
      lines.push(`  ${diagnostic.severity}: ${diagnostic.code ?? "diagnostic"} ${diagnostic.message}`);
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings: skillSettingsSnapshot(runtime),
      skill,
      capability
    }
  };
}

export function buildSkillActivationReport(
  runtime: SwarmRuntime,
  selector: string,
  options: {
    sessionId?: string;
    reason?: string;
  } = {}
): SkillCliReport {
  const resolution = resolveSkillSelector(runtime, selector);
  if (!resolution.skillName) {
    throw new Error(resolution.error ?? `Unknown skill: ${selector}`);
  }
  const activated = runtime.activateSkill(resolution.skillName, options.sessionId, options.reason);
  const lines = [
    "Swarm Skill Activation",
    `workspace=${runtime.getWorkspacePath()}`,
    `skill=${activated.name} scope=${activated.scope} trust=${activated.trust}`,
    `session=${options.sessionId ?? "(none)"}`,
    options.reason ? `reason=${options.reason}` : undefined,
    `activated_at=${activated.activatedAt}`,
    "",
    formatActivatedSkill(activated)
  ].filter(Boolean);
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      session_id: options.sessionId,
      reason: options.reason,
      skill: activated
    }
  };
}

export function resolveSkillSelector(runtime: SwarmRuntime, query?: string): SkillSelectorResolution {
  const trimmed = query?.trim();
  const skills = runtime.listSkills();
  if (!trimmed) {
    return { error: "Skill name is required." };
  }
  const exact = skills.find((skill) => skill.name === trimmed);
  if (exact) {
    return { skillName: exact.name };
  }
  const normalized = trimmed.toLowerCase();
  const exactInsensitive = skills.find((skill) => skill.name.toLowerCase() === normalized);
  if (exactInsensitive) {
    return { skillName: exactInsensitive.name };
  }
  const prefixMatches = skills.filter((skill) => skill.name.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { skillName: prefixMatches[0].name };
  }
  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous skill selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((skill) => skill.name).join(", ")}`
    };
  }
  const fuzzyMatches = skills.filter((skill) =>
    skill.name.toLowerCase().includes(normalized) || skill.displayName.toLowerCase().includes(normalized)
  );
  if (fuzzyMatches.length === 1) {
    return { skillName: fuzzyMatches[0].name };
  }
  if (fuzzyMatches.length > 1) {
    return {
      error: `Ambiguous skill selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((skill) => skill.name).join(", ")}`
    };
  }
  return { error: `Unknown skill: ${trimmed}` };
}

function requireSkill(runtime: SwarmRuntime, selector: string): SkillRecord {
  const resolution = resolveSkillSelector(runtime, selector);
  if (!resolution.skillName) {
    throw new Error(resolution.error ?? `Unknown skill: ${selector}`);
  }
  const skill = runtime.listSkills().find((item) => item.name === resolution.skillName);
  if (!skill) {
    throw new Error(`Unknown skill: ${resolution.skillName}`);
  }
  return skill;
}

export function skillSettingsSnapshot(runtime: SwarmRuntime): {
  enabled: boolean;
  load_project_skills: string;
  configured_roots: string[];
  max_skills: number;
} {
  return {
    enabled: runtime.settings.extensions.skills.enabled,
    load_project_skills: runtime.settings.extensions.skills.loadProjectSkills,
    configured_roots: [...runtime.settings.extensions.skills.roots],
    max_skills: runtime.settings.extensions.skills.maxSkills
  };
}

function formatSkillSummaryLine(skill: SkillRecord): string {
  return [
    `${skill.name} [${skill.scope}/${skill.trust}]${skill.shadowedBy ? " shadowed" : ""}`,
    truncateText(skill.description, 88)
  ].join(" ");
}

function formatActivatedSkill(skill: ActivatedSkill): string {
  return [
    `${skill.name} [${skill.scope}/${skill.trust}]`,
    skill.description,
    `path=${skill.path}`,
    skill.allowedTools.length ? `allowed-tools=${skill.allowedTools.join(", ")}` : undefined,
    skill.resourcePaths.length ? `resources=\n${skill.resourcePaths.map((path) => `  ${path}`).join("\n")}` : undefined,
    "",
    skill.content
  ].filter(Boolean).join("\n");
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
