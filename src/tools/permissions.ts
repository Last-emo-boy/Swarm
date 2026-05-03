import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode, SwarmSettings } from "../config/settings.js";
import type { LocalToolContext, ToolAction, ToolApprovalRequest } from "./types.js";

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
  if (matchesPermissionRules(action, settings.permissions.allow)) {
    return false;
  }

  if (matchesPermissionRules(action, settings.permissions.ask)) {
    return true;
  }

  const mode = normalizePermissionMode(settings.permissions.defaultMode);
  if (action.type === "shell.exec") {
    return mode !== "full-auto";
  }
  if (action.type === "file.write" || action.type === "file.edit") {
    return mode === "ask";
  }
  return false;
}

export function createToolApprovalRequest(action: ToolAction): ToolApprovalRequest {
  const id = `approval_${randomUUID()}`;
  if (action.type === "shell.exec") {
    return {
      id,
      action: action.type,
      risk: "shell",
      summary: `Run shell command: ${action.command}`,
      detail: [`Command: ${action.command}`, `CWD: ${action.cwd || "."}`, `Timeout: ${action.timeoutMs ?? 120000} ms`].join("\n")
    };
  }

  return {
    id,
    action: action.type,
    risk: "write",
    summary: `${action.type === "file.edit" ? "Edit" : "Write"} file: ${"path" in action ? action.path : ""}`,
    detail: renderActionDetail(action)
  };
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
  if (mode === "full-auto" || mode === "auto") {
    return "full-auto";
  }
  if (mode === "auto-edit") {
    return "auto-edit";
  }
  return "ask";
}

function matchesPermissionRules(action: ToolAction, rules: string[]): boolean {
  const permissionName = permissionNameForAction(action);
  return rules.some((rule) => rule === `${permissionName}(*)` || rule === `${permissionName}(**)`);
}

function permissionNameForAction(action: ToolAction): string {
  if (action.type === "shell.exec") {
    return "Bash";
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

function matchesReadDenyRule(rule: string, candidates: string[]): boolean {
  if (rule === "**/.swarm/config.json") {
    return candidates.some((path) => path.endsWith("/.swarm/config.json") || path.endsWith("\\.swarm\\config.json"));
  }
  if (rule === ".env") {
    return candidates.some((path) => basename(path) === ".env");
  }
  if (rule === ".env.*") {
    return candidates.some((path) => basename(path).startsWith(".env."));
  }
  if (rule === "secrets/**") {
    return candidates.some((path) => path.includes("/secrets/") || path.startsWith("secrets/"));
  }
  if (rule === "config/credentials.json") {
    return candidates.some((path) => path.endsWith("config/credentials.json"));
  }
  return candidates.some((path) => path === rule || path.endsWith(`/${rule}`));
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
