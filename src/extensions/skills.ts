import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getSwarmPaths, type SwarmSettings } from "../config/settings.js";
import { loadPluginSkillRoots } from "./plugins.js";
import type { CapabilityDescriptor, CapabilityDiagnostic, CapabilityProvider, CapabilityTrust } from "./types.js";

export type SkillScope = "project" | "user" | "explicit" | "plugin";

export type SkillRecord = {
  name: string;
  displayName: string;
  description: string;
  path: string;
  directory: string;
  scope: SkillScope;
  trust: CapabilityTrust;
  frontmatter: Record<string, unknown>;
  allowedTools: string[];
  resourcePaths: string[];
  shadowedBy?: string;
  diagnostics: CapabilityDiagnostic[];
};

export type ActivatedSkill = SkillRecord & {
  content: string;
  activatedAt: string;
};

export const SKILL_ACTIVATE_CAPABILITY_ID = "skill.activate";
export const SKILL_ACTIVATE_TOOL_NAME = "skill.activate";

type SkillRoot = {
  path: string;
  scope: SkillScope;
  trust: CapabilityTrust;
  enabled: boolean;
  pluginId?: string;
};

export class SkillProvider implements CapabilityProvider {
  readonly id = "skills";
  readonly title = "Agent skills";
  private records: SkillRecord[] = [];
  private providerDiagnostics: CapabilityDiagnostic[] = [];

  constructor(private readonly input: { settings: SwarmSettings; workspace: string }) {}

  refresh(): void {
    this.providerDiagnostics = [];
    if (!this.input.settings.extensions.skills.enabled) {
      this.records = [];
      this.providerDiagnostics.push({
        severity: "info",
        code: "SKILLS_DISABLED",
        message: "Skills are disabled by settings.extensions.skills.enabled."
      });
      return;
    }
    const roots = skillRoots(this.input.settings, this.input.workspace);
    const scanned = roots.flatMap((root) => root.enabled ? scanSkillRoot(root) : []);
    const byName = new Map<string, SkillRecord>();
    const records: SkillRecord[] = [];
    for (const record of scanned) {
      const existing = byName.get(record.name);
      if (existing) {
        records.push({
          ...record,
          shadowedBy: existing.path,
          diagnostics: [
            ...record.diagnostics,
            {
              severity: "warn",
              code: "SKILL_SHADOWED",
              message: `Skill ${record.name} is shadowed by ${existing.path}.`
            }
          ]
        });
        continue;
      }
      byName.set(record.name, record);
      records.push(record);
    }
    this.records = records.slice(0, this.input.settings.extensions.skills.maxSkills);
    if (scanned.length > this.records.length) {
      this.providerDiagnostics.push({
        severity: "warn",
        code: "SKILL_LIMIT_REACHED",
        message: `Loaded ${this.records.length}/${scanned.length} discovered skills because settings.extensions.skills.maxSkills was reached.`
      });
    }
  }

  listCapabilities(): CapabilityDescriptor[] {
    if (this.records.length === 0 && this.providerDiagnostics.length === 0) {
      this.refresh();
    }
    const skills: CapabilityDescriptor[] = this.records
      .filter((record) => !record.shadowedBy)
      .map((record): CapabilityDescriptor => ({
        id: skillCapabilityId(record.name),
        kind: "skill",
        source: skillSource(record.scope),
        trust: record.trust,
        providerId: this.id,
        name: record.name,
        title: record.displayName,
        description: record.description,
        inputSchema: {
          type: "object",
          properties: {
            name: { description: "skill name" },
            reason: { description: "optional activation reason" }
          }
        },
        riskClass: "r0",
        permissionName: `Skill(${record.name})`,
        modelVisible: record.trust !== "untrusted",
        userVisible: true,
        status: record.trust === "disabled" || record.trust === "untrusted" ? "disabled" : "available",
        diagnostics: record.diagnostics,
        metadata: {
          scope: record.scope,
          path: record.path,
          directory: record.directory,
          allowed_tools: record.allowedTools,
          resource_paths: record.resourcePaths,
          frontmatter: record.frontmatter
        }
      }));
    const availableSkills = skills.filter((skill) => skill.status !== "disabled" && skill.trust !== "disabled" && skill.trust !== "untrusted");
    const activateTool: CapabilityDescriptor = {
      id: SKILL_ACTIVATE_CAPABILITY_ID,
      kind: "skill",
      source: "builtin",
      trust: availableSkills.length ? "trusted" : "disabled",
      providerId: this.id,
      name: SKILL_ACTIVATE_TOOL_NAME,
      title: "Activate skill",
      description: "Activate one trusted Agent Skill by name and add its instructions to the current Swarm session.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "trusted skill name" },
          reason: { type: "string", description: "why the skill is needed now" }
        },
        required: ["name"]
      },
      riskClass: "r0",
      permissionName: "SkillActivate",
      modelVisible: availableSkills.length > 0,
      userVisible: true,
      status: availableSkills.length ? "available" : "disabled",
      metadata: {
        available_skills: availableSkills.map((skill) => skill.name)
      }
    };
    return [activateTool, ...skills];
  }

  diagnostics(): CapabilityDiagnostic[] {
    return this.providerDiagnostics;
  }

  listSkills(): SkillRecord[] {
    if (this.records.length === 0 && this.providerDiagnostics.length === 0) {
      this.refresh();
    }
    return [...this.records];
  }

  getSkill(name: string): SkillRecord | undefined {
    const normalized = normalizeSkillName(name);
    return this.listSkills().find((record) => record.name === normalized && !record.shadowedBy);
  }

  activateSkill(name: string): ActivatedSkill {
    const skill = this.getSkill(name);
    if (!skill) {
      throw new Error(`Unknown skill: ${name}`);
    }
    if (skill.trust === "disabled" || skill.trust === "untrusted") {
      throw new Error(`Skill is not trusted for activation: ${skill.name}`);
    }
    return {
      ...skill,
      content: readFileSync(skill.path, "utf8"),
      activatedAt: new Date().toISOString()
    };
  }
}

export function skillCapabilityId(name: string): string {
  return `skill.${normalizeSkillName(name)}`;
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function skillSource(scope: SkillScope): CapabilityDescriptor["source"] {
  if (scope === "project") {
    return "project";
  }
  if (scope === "plugin") {
    return "plugin";
  }
  return "user";
}

function skillRoots(settings: SwarmSettings, workspace: string): SkillRoot[] {
  const paths = getSwarmPaths();
  const trustedWorkspace = isTrustedWorkspace(workspace);
  const projectMode = settings.extensions.skills.loadProjectSkills;
  const projectEnabled = projectMode === "always" || (projectMode === "trustedWorkspaces" && trustedWorkspace);
  const projectTrust: CapabilityTrust = projectEnabled ? "trusted" : "untrusted";
  return [
    { path: resolve(workspace, ".swarm", "skills"), scope: "project", trust: projectTrust, enabled: projectMode !== "never" },
    { path: resolve(workspace, ".agents", "skills"), scope: "project", trust: projectTrust, enabled: projectMode !== "never" },
    { path: paths.skillsDir, scope: "user", trust: "trusted", enabled: true },
    { path: resolve(paths.home, "..", ".agents", "skills"), scope: "user", trust: "trusted", enabled: true },
    ...settings.extensions.skills.roots.map((root) => ({
      path: root,
      scope: "explicit" as const,
      trust: "trusted" as const,
      enabled: true
    })),
    ...loadPluginSkillRoots(settings, workspace).map((root) => ({
      path: root.path,
      scope: "plugin" as const,
      trust: root.trust,
      enabled: true,
      pluginId: root.pluginId
    }))
  ];
}

function scanSkillRoot(root: SkillRoot): SkillRecord[] {
  if (!existsSync(root.path)) {
    return [];
  }
  if (!safeIsDirectory(root.path) && basename(root.path).toLowerCase() === "skill.md") {
    return [readSkill(root.path, root)];
  }
  if (existsSync(join(root.path, "SKILL.md"))) {
    return [readSkill(join(root.path, "SKILL.md"), root)];
  }
  const entries = safeReadDir(root.path);
  const records: SkillRecord[] = [];
  for (const entry of entries) {
    const directory = join(root.path, entry);
    const skillPath = join(directory, "SKILL.md");
    if (!safeIsDirectory(directory) || !existsSync(skillPath)) {
      continue;
    }
    records.push(readSkill(skillPath, root));
  }
  return records;
}

function readSkill(path: string, root: SkillRoot): SkillRecord {
  const diagnostics: CapabilityDiagnostic[] = [];
  const content = readFileSync(path, "utf8");
  const parsed = parseSkillMarkdown(content);
  const name = normalizeSkillName(stringFrontmatter(parsed.frontmatter, "name") || basename(dirname(path)));
  const displayName = stringFrontmatter(parsed.frontmatter, "title") || stringFrontmatter(parsed.frontmatter, "name") || name;
  const description = stringFrontmatter(parsed.frontmatter, "description") || firstUsefulParagraph(parsed.body) || "No skill description provided.";
  if (!stringFrontmatter(parsed.frontmatter, "description")) {
    diagnostics.push({
      severity: "warn",
      code: "SKILL_DESCRIPTION_MISSING",
      message: `Skill ${name} does not define frontmatter.description.`
    });
  }
  return {
    name,
    displayName,
    description,
    path,
    directory: dirname(path),
    scope: root.scope,
    trust: root.trust,
    frontmatter: root.pluginId ? { ...parsed.frontmatter, plugin_id: root.pluginId } : parsed.frontmatter,
    allowedTools: listFrontmatter(parsed.frontmatter, "allowed-tools"),
    resourcePaths: listSkillResources(dirname(path)),
    diagnostics
  };
}

function parseSkillMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  return {
    frontmatter: parseFrontmatter(match[1]),
    body: content.slice(match[0].length)
  };
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let activeKey: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const listItem = /^\s*-\s*(.+)$/.exec(line);
    if (listItem && activeKey) {
      const current = Array.isArray(result[activeKey]) ? result[activeKey] as string[] : [];
      result[activeKey] = [...current, stripQuotes(listItem[1].trim())];
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      activeKey = undefined;
      continue;
    }
    activeKey = match[1];
    const value = match[2].trim();
    if (!value) {
      result[activeKey] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[activeKey] = value.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
    } else {
      result[activeKey] = stripQuotes(value);
    }
  }
  return result;
}

function stringFrontmatter(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listFrontmatter(frontmatter: Record<string, unknown>, key: string): string[] {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function firstUsefulParagraph(body: string): string | undefined {
  return body
    .split(/\r?\n\r?\n/)
    .map((paragraph) => paragraph.replace(/^#+\s*/gm, "").trim())
    .find((paragraph) => paragraph.length > 0)
    ?.slice(0, 500);
}

function listSkillResources(directory: string): string[] {
  return ["scripts", "references", "assets"]
    .map((name) => join(directory, name))
    .filter((path) => existsSync(path))
    .flatMap((path) => safeReadDir(path).map((entry) => join(path, entry)));
}

function isTrustedWorkspace(workspace: string): boolean {
  if (process.env.SWARM_TRUSTED_WORKSPACE_ROOT) {
    const trustedRoot = resolve(process.env.SWARM_TRUSTED_WORKSPACE_ROOT);
    const current = resolve(workspace);
    return current === trustedRoot || current.startsWith(`${trustedRoot}\\`) || current.startsWith(`${trustedRoot}/`);
  }
  return process.env.SWARM_TRUST_PROJECT_SKILLS === "1";
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

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed[0] === "\"" && trimmed[trimmed.length - 1] === "\"") || (trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
