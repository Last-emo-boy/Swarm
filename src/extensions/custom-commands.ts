import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getSwarmPaths, type SwarmSettings } from "../config/settings.js";
import type { CapabilityDescriptor, CapabilityDiagnostic, CapabilityProvider, CapabilityTrust } from "./types.js";

export type CustomCommandScope = "project" | "user" | "explicit";

export type CustomCommandRecord = {
  name: string;
  title: string;
  description: string;
  path: string;
  directory: string;
  scope: CustomCommandScope;
  trust: CapabilityTrust;
  frontmatter: Record<string, unknown>;
  content: string;
  argumentHint?: string;
  shadowedBy?: string;
  diagnostics: CapabilityDiagnostic[];
};

type CommandRoot = {
  path: string;
  scope: CustomCommandScope;
  trust: CapabilityTrust;
  enabled: boolean;
};

export class CustomCommandProvider implements CapabilityProvider {
  readonly id = "custom-commands";
  readonly title = "Custom slash commands";
  private records: CustomCommandRecord[] = [];
  private providerDiagnostics: CapabilityDiagnostic[] = [];

  constructor(private readonly input: { settings: SwarmSettings; workspace: string }) {}

  refresh(): void {
    this.providerDiagnostics = [];
    if (!this.input.settings.extensions.commands.enabled) {
      this.records = [];
      this.providerDiagnostics.push({
        severity: "info",
        code: "CUSTOM_COMMANDS_DISABLED",
        message: "Custom commands are disabled by settings.extensions.commands.enabled."
      });
      return;
    }
    const scanned = commandRoots(this.input.settings, this.input.workspace)
      .flatMap((root) => root.enabled ? scanCommandRoot(root) : []);
    const records: CustomCommandRecord[] = [];
    const byName = new Map<string, CustomCommandRecord>();
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
              code: "CUSTOM_COMMAND_SHADOWED",
              message: `Custom command ${record.name} is shadowed by ${existing.path}.`
            }
          ]
        });
        continue;
      }
      byName.set(record.name, record);
      records.push(record);
    }
    this.records = records.slice(0, this.input.settings.extensions.commands.maxCommands);
    if (scanned.length > this.records.length) {
      this.providerDiagnostics.push({
        severity: "warn",
        code: "CUSTOM_COMMAND_LIMIT_REACHED",
        message: `Loaded ${this.records.length}/${scanned.length} discovered custom commands because settings.extensions.commands.maxCommands was reached.`
      });
    }
  }

  listCapabilities(): CapabilityDescriptor[] {
    return this.listCommands()
      .filter((record) => !record.shadowedBy)
      .map((record): CapabilityDescriptor => ({
        id: `custom-command.${record.name}`,
        kind: "slash_command",
        source: record.scope === "project" ? "project" : "user",
        trust: record.trust,
        providerId: this.id,
        name: `/${record.name}`,
        title: record.title,
        description: record.description,
        inputSchema: {
          type: "string",
          usage: `/${record.name}${record.argumentHint ? ` ${record.argumentHint}` : ""}`
        },
        riskClass: "r1",
        permissionName: `CustomSlashCommand(${record.name})`,
        modelVisible: false,
        userVisible: true,
        status: record.trust === "disabled" || record.trust === "untrusted" ? "disabled" : "available",
        diagnostics: record.diagnostics,
        metadata: {
          scope: record.scope,
          path: record.path,
          directory: record.directory,
          argument_hint: record.argumentHint,
          frontmatter: record.frontmatter
        }
      }));
  }

  diagnostics(): CapabilityDiagnostic[] {
    return this.providerDiagnostics;
  }

  listCommands(): CustomCommandRecord[] {
    if (this.records.length === 0 && this.providerDiagnostics.length === 0) {
      this.refresh();
    }
    return [...this.records];
  }

  getCommand(name: string): CustomCommandRecord | undefined {
    const normalized = normalizeCustomCommandName(name);
    return this.listCommands().find((record) => record.name === normalized && !record.shadowedBy);
  }
}

export function normalizeCustomCommandName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function renderCustomCommandObjective(command: CustomCommandRecord, rawArgs = ""): string {
  const args = rawArgs.trim();
  const expanded = command.content.replace(/\$ARGUMENTS\b/g, args);
  return [
    expanded,
    "",
    `Custom slash command: /${command.name}`,
    `Source: ${command.scope}`,
    `Path: ${command.path}`,
    args ? `Arguments: ${args}` : "Arguments: (none)"
  ].join("\n");
}

function commandRoots(settings: SwarmSettings, workspace: string): CommandRoot[] {
  const paths = getSwarmPaths();
  const projectMode = settings.extensions.commands.loadProjectCommands;
  const trustedWorkspace = isTrustedWorkspace(workspace);
  const projectEnabled = projectMode === "always" || (projectMode === "trustedWorkspaces" && trustedWorkspace);
  const projectTrust: CapabilityTrust = projectEnabled ? "trusted" : "untrusted";
  return [
    { path: paths.commandsDir, scope: "user", trust: "trusted", enabled: true },
    { path: resolve(paths.home, "..", ".agents", "commands"), scope: "user", trust: "trusted", enabled: true },
    ...settings.extensions.commands.roots.map((root) => ({
      path: root,
      scope: "explicit" as const,
      trust: "trusted" as const,
      enabled: true
    })),
    { path: resolve(workspace, ".swarm", "commands"), scope: "project", trust: projectTrust, enabled: projectMode !== "never" },
    { path: resolve(workspace, ".agents", "commands"), scope: "project", trust: projectTrust, enabled: projectMode !== "never" }
  ];
}

function scanCommandRoot(root: CommandRoot): CustomCommandRecord[] {
  if (!existsSync(root.path) || !safeIsDirectory(root.path)) {
    return [];
  }
  return listMarkdownFiles(root.path).map((path) => readCommand(path, root));
}

function readCommand(path: string, root: CommandRoot): CustomCommandRecord {
  const diagnostics: CapabilityDiagnostic[] = [];
  const content = readFileSync(path, "utf8");
  const parsed = parseCommandMarkdown(content);
  const relativeName = relative(root.path, path).replace(/\\/g, "/").replace(/\.md$/i, "");
  const name = normalizeCustomCommandName(stringFrontmatter(parsed.frontmatter, "name") || relativeName);
  const title = stringFrontmatter(parsed.frontmatter, "title") || stringFrontmatter(parsed.frontmatter, "name") || `/${name}`;
  const description = stringFrontmatter(parsed.frontmatter, "description") || firstUsefulParagraph(parsed.body) || "Custom slash command.";
  const argumentHint = stringFrontmatter(parsed.frontmatter, "argument-hint") || stringFrontmatter(parsed.frontmatter, "argument_hint");
  if (!name) {
    diagnostics.push({
      severity: "error",
      code: "CUSTOM_COMMAND_NAME_MISSING",
      message: `Custom command file has no usable command name: ${path}.`
    });
  }
  if (!parsed.body.trim()) {
    diagnostics.push({
      severity: "error",
      code: "CUSTOM_COMMAND_PROMPT_MISSING",
      message: `Custom command ${name || basename(path)} has an empty prompt body.`
    });
  }
  return {
    name,
    title,
    description,
    path,
    directory: dirname(path),
    scope: root.scope,
    trust: root.trust,
    frontmatter: parsed.frontmatter,
    content: parsed.body.trim(),
    argumentHint,
    diagnostics
  };
}

function listMarkdownFiles(root: string, depth = 0): string[] {
  if (depth > 3) {
    return [];
  }
  const entries = safeReadDir(root);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    if (safeIsDirectory(path)) {
      files.push(...listMarkdownFiles(path, depth + 1));
      continue;
    }
    if (/\.md$/i.test(entry)) {
      files.push(path);
    }
  }
  return files.sort();
}

function parseCommandMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
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

function firstUsefulParagraph(content: string): string | undefined {
  return content.split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .find((paragraph) => paragraph && !paragraph.startsWith("#"))?.slice(0, 180);
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
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

function isTrustedWorkspace(workspace: string): boolean {
  if (!process.env.SWARM_TRUSTED_WORKSPACE_ROOT) {
    return false;
  }
  const trustedRoot = resolve(process.env.SWARM_TRUSTED_WORKSPACE_ROOT);
  const current = resolve(workspace);
  return current === trustedRoot || current.startsWith(`${trustedRoot}\\`) || current.startsWith(`${trustedRoot}/`);
}
