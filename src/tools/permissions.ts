import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode, SwarmSettings } from "../config/settings.js";
import type { LocalToolContext, ToolAction, ToolApprovalRequest } from "./types.js";
import type { RiskClass } from "../protocol/types.js";

export function resolveReadablePath(path: string, context: LocalToolContext): string {
  const resolved = resolveToolPath(path, context.workspace);
  assertInsideReadRoots(resolved, context);
  assertReadableByDenyRules(resolved, context);
  return resolved;
}

export function resolveWritablePath(path: string, context: LocalToolContext): string {
  const resolved = resolveToolPath(path, context.workspace);
  if (!isInsidePath(resolved, context.workspace)) {
    throw new Error(`Write denied outside startup workspace: ${path}`);
  }
  return resolved;
}

export function resolveShellCwd(path: string | undefined, context: LocalToolContext): string {
  const resolved = resolveToolPath(path?.trim() || ".", context.workspace);
  if (!isInsidePath(resolved, context.workspace)) {
    throw new Error(`Shell cwd denied outside startup workspace: ${path}`);
  }
  return resolved;
}

export function displayPath(path: string, workspace: string): string {
  const rel = relative(workspace, path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return rel.replace(/\\/g, "/") || ".";
  }
  return path;
}

export function toolRequiresApproval(action: ToolAction, settings: SwarmSettings): boolean {
  assertToolAllowedByPermissions(action, settings);
  const mode = normalizePermissionMode(settings.permissions.defaultMode);
  if (matchesPermissionRules(action, settings.permissions.allow)) {
    return false;
  }

  if (mode === "yolo") {
    return false;
  }

  if (matchesPermissionRules(action, settings.permissions.ask)) {
    return true;
  }

  if (isShellLikeAction(action) || action.type === "package.install" || action.type === "solidity.compile") {
    return !skipsApproval(mode);
  }
  if (action.type === "file.write" || action.type === "file.edit") {
    return mode === "ask";
  }
  if (action.type === "agent.delegate") {
    return !skipsApproval(mode);
  }
  if (action.type === "git.branch" && action.action !== "list") {
    return !skipsApproval(mode);
  }
  if (action.type === "web.fetch") {
    return mode === "ask";
  }
  return false;
}

export function assertToolAllowedByPermissions(action: ToolAction, settings: SwarmSettings): void {
  if (matchesPermissionRules(action, settings.permissions.deny)) {
    throw new Error(`Tool action denied by ~/.swarm/settings.json permissions: ${approvalSummary(action)}`);
  }
}

export function createToolApprovalRequest(action: ToolAction): ToolApprovalRequest {
  const id = `approval_${randomUUID()}`;
  const risk = riskForAction(action);
  const riskClass = riskClassForAction(action);
  const target = approvalTarget(action);
  const base = {
    id,
    action: action.type,
    risk,
    risk_class: riskClass,
    target,
    why_now: `Swarm needs to run ${action.type} to continue the current task.`,
    predicted_impact: predictedImpact(action, riskClass),
    rollback_plan: rollbackPlan(action, riskClass)
  };
  if (action.type === "shell.exec" || action.type === "code.test") {
    const command = action.command;
    return {
      ...base,
      summary: `Run ${action.type === "code.test" ? "test" : "shell"} command: ${command}`,
      detail: [`Command: ${command}`, `CWD: ${action.cwd || "."}`, `Timeout: ${action.timeoutMs ?? 120000} ms`].join("\n")
    };
  }

  return {
    ...base,
    summary: approvalSummary(action),
    detail: renderActionDetail(action)
  };
}

export function riskClassForAction(action: ToolAction): RiskClass {
  if (action.type === "shell.exec" && isDestructiveCommand(action.command)) {
    return "r4";
  }
  if (action.type === "package.install" || action.type === "web.fetch") {
    return "r2";
  }
  if (action.type === "git.branch" && action.action !== "list") {
    return "r2";
  }
  if (action.type === "shell.exec") {
    return "r2";
  }
  if (action.type === "file.write" || action.type === "file.edit" || action.type === "code.test" || action.type === "code.lint" || action.type === "agent.delegate") {
    return "r1";
  }
  return "r0";
}

export function assertReadableByDenyRules(path: string, context: LocalToolContext): void {
  if (isDeniedReadPath(path, context)) {
    throw new Error(`Read denied by ~/.swarm/settings.json permissions: ${displayPath(path, context.workspace)}`);
  }
}

export function isDeniedReadPath(path: string, context: LocalToolContext): boolean {
  const normalized = path.replace(/\\/g, "/");
  const relativeToWorkspace = relative(context.workspace, path).replace(/\\/g, "/");
  const candidates = [normalized, relativeToWorkspace, basename(path)];
  for (const pattern of context.settings.permissions.deny) {
    if (!pattern.startsWith("Read(") || !pattern.endsWith(")")) {
      continue;
    }
    const rule = pattern.slice(5, -1).replace(/\\/g, "/");
    if (matchesReadDenyRule(rule, candidates)) {
      return true;
    }
  }
  return false;
}

export function getReadRoots(context: LocalToolContext): string[] {
  return [
    resolve(context.workspace),
    ...context.settings.permissions.additionalDirectories
      .map((path) => expandPath(path))
      .filter((path) => path.trim())
      .map((path) => resolve(path))
  ];
}

function assertInsideReadRoots(path: string, context: LocalToolContext): void {
  const roots = getReadRoots(context);
  if (!roots.some((root) => isInsidePath(path, root))) {
    throw new Error(
      `Read denied outside startup workspace and configured additionalDirectories: ${displayPath(path, context.workspace)}`
    );
  }
}

function isInsidePath(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveToolPath(path: string, workspace: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
}

function normalizePermissionMode(mode: SwarmSettings["permissions"]["defaultMode"]): PermissionMode {
  if (mode === "yolo") {
    return "yolo";
  }
  if (mode === "full-auto" || mode === "auto") {
    return "full-auto";
  }
  if (mode === "auto-edit") {
    return "auto-edit";
  }
  return "ask";
}

function skipsApproval(mode: PermissionMode): boolean {
  return mode === "full-auto" || mode === "yolo";
}

function matchesPermissionRules(action: ToolAction, rules: string[]): boolean {
  const permissionName = permissionNameForAction(action);
  const content = permissionRuleContentForAction(action);
  return rules.some((rule) => {
    const parsed = parsePermissionRule(rule);
    if (!parsed || parsed.name !== permissionName) {
      return false;
    }
    if (!parsed.content || parsed.content === "*" || parsed.content === "**") {
      return true;
    }
    if (!content) {
      return false;
    }
    return wildcardMatch(content, parsed.content);
  });
}

function permissionNameForAction(action: ToolAction): string {
  if (action.type === "shell.exec") {
    return "Bash";
  }
  if (action.type === "code.test") {
    return "CodeTest";
  }
  if (action.type === "code.lint") {
    return "CodeLint";
  }
  if (action.type === "file.write") {
    return "Write";
  }
  if (action.type === "file.edit") {
    return "Edit";
  }
  if (action.type === "web.search") {
    return "WebSearch";
  }
  if (action.type === "web.fetch") {
    return "WebFetch";
  }
  if (action.type === "file.list") {
    return "LS";
  }
  if (action.type === "file.grep") {
    return "Grep";
  }
  if (action.type === "file.glob") {
    return "Glob";
  }
  if (action.type === "file.stat") {
    return "Stat";
  }
  if (action.type === "git.status") {
    return "GitStatus";
  }
  if (action.type === "git.diff") {
    return "GitDiff";
  }
  if (action.type === "git.log") {
    return "GitLog";
  }
  if (action.type === "git.branch") {
    return "GitBranch";
  }
  if (action.type === "package.install") {
    return "PackageInstall";
  }
  if (action.type === "solidity.compile") {
    return "SolidityCompile";
  }
  if (action.type === "agent.delegate") {
    return "Delegate";
  }
  return "Read";
}

function renderActionDetail(action: ToolAction): string {
  if (action.type === "file.write") {
    return [`Path: ${action.path}`, `Bytes: ${Buffer.byteLength(action.content, "utf8")}`].join("\n");
  }
  if (action.type === "file.edit") {
    return [`Path: ${action.path}`, `Operation: ${action.operation}`].join("\n");
  }
  return JSON.stringify(action, null, 2);
}

function approvalSummary(action: ToolAction): string {
  if (action.type === "file.write") {
    return `Write file: ${action.path}`;
  }
  if (action.type === "file.edit") {
    return `Edit file: ${action.path}`;
  }
  if (action.type === "web.fetch") {
    return `Fetch URL: ${action.url}`;
  }
  if (action.type === "web.search") {
    return `Search web: ${action.query}`;
  }
  if (action.type === "code.lint") {
    return `Run linter in ${action.root ?? "."}`;
  }
  if (action.type === "git.branch") {
    return `Git branch ${action.action ?? "list"}${action.name ? `: ${action.name}` : ""}`;
  }
  if (action.type === "package.install") {
    return `Install packages: ${action.command}`;
  }
  if (action.type === "solidity.compile") {
    return `Compile Solidity project with ${action.framework ?? "hardhat"}`;
  }
  if (action.type === "agent.delegate") {
    return `Delegate task to ${action.capability}: ${action.task}`;
  }
  return `${action.type}: ${permissionRuleContentForAction(action) ?? ""}`.trim();
}

function approvalTarget(action: ToolAction): string {
  if ("path" in action && typeof action.path === "string") {
    return action.path;
  }
  if ("cwd" in action && typeof action.cwd === "string") {
    return action.cwd;
  }
  if ("root" in action && typeof action.root === "string") {
    return action.root;
  }
  if (action.type === "web.fetch") {
    return action.url;
  }
  if (action.type === "web.search") {
    return action.query;
  }
  if (action.type === "git.branch") {
    return [action.action ?? "list", action.name].filter(Boolean).join(" ");
  }
  if (action.type === "package.install") {
    return action.command;
  }
  if (action.type === "agent.delegate") {
    return action.capability;
  }
  return permissionRuleContentForAction(action) ?? action.type;
}

function predictedImpact(action: ToolAction, riskClass: RiskClass): string {
  if (action.type === "file.write") {
    return `Creates or replaces workspace file ${action.path}.`;
  }
  if (action.type === "file.edit") {
    return `Edits workspace file ${action.path}.`;
  }
  if (action.type === "shell.exec" || action.type === "code.test" || action.type === "code.lint") {
    return `Runs a local command in ${"cwd" in action ? action.cwd ?? "." : "."}; effects depend on the command.`;
  }
  if (action.type === "web.fetch") {
    return `Fetches network content from ${action.url}.`;
  }
  if (action.type === "package.install") {
    return "Installs or changes project dependencies and may contact package registries.";
  }
  if (action.type === "agent.delegate") {
    return "Spawns an internal specialist with its own tool budget.";
  }
  return riskClass === "r0" ? "Read-only or low-risk operation." : "Changes local state or uses an external resource.";
}

function rollbackPlan(action: ToolAction, riskClass: RiskClass): string {
  if (action.type === "file.write" || action.type === "file.edit") {
    return "Use the recorded diff/audit entry to revert the file manually or with a follow-up edit.";
  }
  if (action.type === "package.install") {
    return "Restore lockfiles/package manifests from git or rerun the package manager with the previous dependency set.";
  }
  if (action.type === "git.branch") {
    return "Switch back to the previous branch or delete the created branch if needed.";
  }
  if (riskClass === "r4") {
    return "No automatic rollback is guaranteed; deny unless explicitly intended.";
  }
  return "No persistent workspace change is expected, or recovery is task-specific.";
}

function riskForAction(action: ToolAction): ToolApprovalRequest["risk"] {
  if (action.type === "web.search" || action.type === "web.fetch") {
    return "web";
  }
  if (action.type === "package.install") {
    return "install";
  }
  if (action.type === "agent.delegate") {
    return "delegate";
  }
  if (isShellLikeAction(action) || action.type === "solidity.compile" || action.type === "git.branch") {
    return "shell";
  }
  return "write";
}

function isShellLikeAction(action: ToolAction): boolean {
  return action.type === "shell.exec" || action.type === "code.test" || action.type === "code.lint";
}

function isDestructiveCommand(command: string): boolean {
  return /\b(rm\s+-rf|del\s+\/[sq]|remove-item\b.*\b-recurse\b|format\b|diskpart\b|git\s+reset\s+--hard)\b/i.test(command);
}

function permissionRuleContentForAction(action: ToolAction): string | undefined {
  if ("path" in action && typeof action.path === "string") {
    return action.path;
  }
  if ("root" in action && typeof action.root === "string") {
    return action.root;
  }
  if ("command" in action && typeof action.command === "string") {
    return action.command;
  }
  if (action.type === "web.search") {
    return action.query;
  }
  if (action.type === "web.fetch") {
    return action.url;
  }
  if (action.type === "git.branch") {
    return [action.action ?? "list", action.name].filter(Boolean).join(" ");
  }
  if (action.type === "solidity.compile") {
    return action.framework ?? "hardhat";
  }
  if (action.type === "agent.delegate") {
    return action.capability;
  }
  return undefined;
}

function parsePermissionRule(rule: string): { name: string; content?: string } | undefined {
  const match = rule.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/);
  if (!match) {
    return undefined;
  }
  return { name: match[1], content: match[2] };
}

function wildcardMatch(value: string, pattern: string): boolean {
  const normalizedValue = value.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");
  if (normalizedPattern === "*" || normalizedPattern === "**") {
    return true;
  }
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  return regex.test(normalizedValue);
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(character);
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function matchesReadDenyRule(rule: string, candidates: string[]): boolean {
  const normalizedRule = rule.replace(/\\/g, "/");
  return candidates.some((path) => matchesReadDenyCandidate(path.replace(/\\/g, "/"), normalizedRule));
}

function matchesReadDenyCandidate(path: string, rule: string): boolean {
  if (wildcardMatch(path, rule)) {
    return true;
  }
  if (rule.startsWith("**/") && wildcardMatch(path, rule.slice(3))) {
    return true;
  }
  if (containsGlob(rule)) {
    return false;
  }
  return path === rule || path.endsWith(`/${rule}`);
}

function containsGlob(value: string): boolean {
  return value.includes("*");
}

function expandPath(path: string): string {
  const expanded = path.replace(/\$\{?([A-Z0-9_]+)\}?/gi, (_, name: string) => process.env[name] ?? "");
  if (expanded === "~") {
    return homedir();
  }
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    return resolve(homedir(), expanded.slice(2));
  }
  return expanded;
}
