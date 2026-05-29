import { relative, resolve } from "node:path";
import { SKILL_ACTIVATE_CAPABILITY_ID } from "../extensions/skills.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import { isReadOnlyPowerShellCommand, isReadOnlyShellCommand } from "../tools/command-safety.js";
import type { ToolAction } from "../tools/types.js";

export type SandboxWritePolicy = "read_only" | "scoped_write" | "workspace_write";

export type SandboxDecision = {
  decision: "allow" | "deny";
  policy: SandboxWritePolicy;
  subject: "tool_action" | "capability";
  reason: string;
  action?: string;
  capability_id?: string;
  targets?: string[];
  file_scope?: string[];
};

export class SandboxPolicyError extends Error {
  readonly name = "SandboxPolicyError";

  constructor(readonly decision: SandboxDecision) {
    super(decision.reason);
  }
}

export type SandboxActionInput = {
  writePolicy?: SandboxWritePolicy;
  workspace: string;
  fileScope?: string[];
};

export function decideToolActionSandbox(action: ToolAction, input: SandboxActionInput): SandboxDecision {
  const policy = input.writePolicy ?? "workspace_write";
  if (policy === "workspace_write") {
    return allowSandboxDecision(policy, "tool_action", `Workspace-write sandbox permits tool action: ${action.type}`, { action: action.type });
  }
  if (policy === "read_only" && isReadOnlySandboxAction(action)) {
    return allowSandboxDecision(policy, "tool_action", `Read-only sandbox permits tool action: ${action.type}`, { action: action.type });
  }
  if (policy === "read_only") {
    return denySandboxDecision(policy, "tool_action", `Read-only sandbox denied tool action: ${action.type}`, { action: action.type });
  }
  if (policy === "scoped_write") {
    const targets = scopedWriteTargetPaths(action);
    if (isReadOnlySandboxAction(action)) {
      return allowSandboxDecision(policy, "tool_action", `Scoped-write sandbox permits read-only tool action: ${action.type}`, { action: action.type });
    }
    if (targets.length > 0 && targets.every((path) => isPathAllowedByScope(path, input.workspace, input.fileScope ?? []))) {
      return allowSandboxDecision(policy, "tool_action", `Scoped-write sandbox permits tool action in file_scope: ${action.type}`, {
        action: action.type,
        targets: relativeSandboxTargets(targets, input.workspace),
        file_scope: normalizedScope(input.fileScope)
      });
    }
    return denySandboxDecision(policy, "tool_action", scopedWriteDeniedMessage(action, input.workspace), {
      action: action.type,
      targets: relativeSandboxTargets(targets, input.workspace),
      file_scope: normalizedScope(input.fileScope)
    });
  }
  return allowSandboxDecision(policy, "tool_action", `Sandbox policy permits tool action: ${action.type}`, { action: action.type });
}

export function assertToolActionAllowedBySandbox(action: ToolAction, input: SandboxActionInput): void {
  const decision = decideToolActionSandbox(action, input);
  if (decision.decision === "deny") {
    throw new SandboxPolicyError(decision);
  }
}

export function decideCapabilitySandbox(
  capability: CapabilityDescriptor,
  writePolicy?: SandboxWritePolicy
): SandboxDecision {
  const policy = writePolicy ?? "workspace_write";
  if (policy === "workspace_write") {
    return allowSandboxDecision(policy, "capability", `Workspace-write sandbox permits capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  if (policy === "read_only" && capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
    return denySandboxDecision(policy, "capability", `Read-only sandbox denied capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  if (policy === "read_only" && capability.riskClass === "r0" && capability.readOnly === true) {
    return allowSandboxDecision(policy, "capability", `Read-only sandbox permits capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  if (policy === "read_only") {
    return denySandboxDecision(policy, "capability", `Read-only sandbox denied capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  if (policy === "scoped_write" && capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
    return allowSandboxDecision(policy, "capability", `Scoped-write sandbox permits capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  if (policy === "scoped_write" && capability.riskClass === "r0" && capability.readOnly === true) {
    return allowSandboxDecision(policy, "capability", `Scoped-write sandbox permits read-only capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  if (policy === "scoped_write") {
    return denySandboxDecision(policy, "capability", `Scoped-write sandbox denied capability: ${capability.id}`, {
      capability_id: capability.id
    });
  }
  return allowSandboxDecision(policy, "capability", `Sandbox policy permits capability: ${capability.id}`, {
    capability_id: capability.id
  });
}

export function assertCapabilityAllowedBySandbox(
  capability: CapabilityDescriptor,
  writePolicy?: SandboxWritePolicy
): void {
  const decision = decideCapabilitySandbox(capability, writePolicy);
  if (decision.decision === "deny") {
    throw new SandboxPolicyError(decision);
  }
}

export function sandboxDecisionFromError(error: unknown): SandboxDecision | undefined {
  return error instanceof SandboxPolicyError ? error.decision : undefined;
}

export function sandboxDecisionFromUnknown(value: unknown): SandboxDecision | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const maybeSandbox = isRecord(value.sandbox) ? value.sandbox : value;
  if (
    (maybeSandbox.decision === "allow" || maybeSandbox.decision === "deny") &&
    (maybeSandbox.subject === "tool_action" || maybeSandbox.subject === "capability") &&
    typeof maybeSandbox.policy === "string" &&
    typeof maybeSandbox.reason === "string"
  ) {
    return {
      decision: maybeSandbox.decision,
      policy: maybeSandbox.policy as SandboxWritePolicy,
      subject: maybeSandbox.subject,
      reason: maybeSandbox.reason,
      action: typeof maybeSandbox.action === "string" ? maybeSandbox.action : undefined,
      capability_id: typeof maybeSandbox.capability_id === "string" ? maybeSandbox.capability_id : undefined,
      targets: Array.isArray(maybeSandbox.targets) ? maybeSandbox.targets.map(String) : undefined,
      file_scope: Array.isArray(maybeSandbox.file_scope) ? maybeSandbox.file_scope.map(String) : undefined
    };
  }
  return undefined;
}

export function sandboxFailureSummary(sandbox: SandboxDecision): string {
  if (sandbox.decision !== "deny") {
    return sandbox.reason;
  }
  if (sandbox.subject === "tool_action" && sandbox.policy === "read_only") {
    return `Sandbox blocked ${sandbox.action ?? "tool action"}: read-only mode only permits read-only tools.`;
  }
  if (sandbox.subject === "tool_action" && sandbox.policy === "scoped_write") {
    return sandbox.targets?.length
      ? `Sandbox blocked ${sandbox.action ?? "tool action"}: outside delegated file scope (${sandbox.targets.join(", ")}).`
      : `Sandbox blocked ${sandbox.action ?? "tool action"}: outside delegated file scope.`;
  }
  if (sandbox.subject === "capability" && sandbox.policy === "read_only") {
    return `Sandbox blocked capability ${sandbox.capability_id ?? "unknown"}: read-only mode only permits read-only capabilities.`;
  }
  if (sandbox.subject === "capability" && sandbox.policy === "scoped_write") {
    return `Sandbox blocked capability ${sandbox.capability_id ?? "unknown"}: scoped-write mode only permits read-only capabilities outside the delegated file scope.`;
  }
  return sandbox.reason;
}

export function sandboxRecoverySuggestion(sandbox: SandboxDecision): string {
  if (sandbox.subject === "tool_action" && sandbox.policy === "read_only") {
    return "Retry in workspace-write sandbox if this write or command is intended, or keep the task read-only and choose read-only tools.";
  }
  if (sandbox.subject === "tool_action" && sandbox.policy === "scoped_write") {
    return "Keep the write inside file_scope, or relaunch the workstream with a broader delegated file scope.";
  }
  if (sandbox.subject === "capability" && sandbox.policy === "read_only") {
    return "Retry in workspace-write sandbox, or switch to a read-only capability that can answer the same question.";
  }
  if (sandbox.subject === "capability" && sandbox.policy === "scoped_write") {
    return "Keep this work in the main coding loop, or relaunch the worker with a broader file scope or a read-only capability.";
  }
  return "Adjust the sandbox mode or scope, then retry the same action.";
}

export function formatSandboxFailureDetail(sandbox: SandboxDecision): string {
  return [
    `Sandbox: ${sandbox.policy}/${sandbox.decision} ${sandbox.subject}`,
    `Sandbox reason: ${sandbox.reason}`,
    sandbox.targets?.length ? `Sandbox targets: ${sandbox.targets.join(", ")}` : undefined,
    sandbox.file_scope?.length ? `Sandbox file_scope: ${sandbox.file_scope.join(", ")}` : undefined
  ].filter(Boolean).join("\n");
}

export function isReadOnlySandboxAction(action: ToolAction): boolean {
  switch (action.type) {
    case "file.read":
    case "file.list":
    case "file.glob":
    case "file.grep":
    case "file.stat":
    case "file.resolve":
    case "json.read":
    case "package.info":
    case "project.detect":
    case "git.status":
    case "git.diff":
    case "git.log":
    case "git.show":
    case "process.status":
    case "process.list":
    case "process.tail":
    case "process.grep":
    case "web.search":
    case "web.fetch":
    case "config.get":
    case "mcp.resources":
    case "mcp.read":
    case "mcp.auth":
    case "ask_user_question":
    case "plan.enter":
    case "plan.exit":
    case "blackboard.read":
    case "blackboard.search":
    case "blackboard.list":
    case "agent.list":
    case "agent.status":
    case "task.get":
    case "task.list":
    case "task.output":
    case "runtime.sleep":
    case "structured.output":
    case "repl.mode":
    case "schedule.list":
    case "code.test":
    case "code.lint":
    case "code.build":
    case "lsp.diagnostics":
    case "lsp.hover":
    case "lsp.definition":
    case "lsp.references":
    case "lsp.document_symbols":
    case "lsp.workspace_symbols":
    case "lsp.completion":
    case "lsp.code_actions":
    case "lsp.rename_preview":
    case "lsp.format":
      return true;
    case "shell.exec":
      return isReadOnlyShellCommand(action.command);
    case "powershell.exec":
      return isReadOnlyPowerShellCommand(action.command);
    case "git.branch":
      return !action.action || action.action === "list";
    default:
      return false;
  }
}

function scopedWriteTargetPaths(action: ToolAction): string[] {
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "file.mkdir":
    case "file.delete":
    case "file.patch":
    case "json.edit":
      return [action.path];
    case "file.move":
      return [action.source, action.destination];
    case "file.copy":
      return [action.destination];
    case "notebook.edit":
      return [action.notebookPath];
    default:
      return [];
  }
}

function isPathAllowedByScope(path: string, workspace: string, fileScope: string[]): boolean {
  const scopes = fileScope.map((scope) => scope.trim()).filter(Boolean);
  if (scopes.length === 0) {
    return false;
  }
  const workspaceRoot = normalizeAbsolutePath(workspace, process.cwd());
  const targetAbs = normalizeAbsolutePath(path, workspaceRoot);
  const targetRel = normalizeRelativePath(relative(workspaceRoot, targetAbs));
  return scopes.some((scope) => {
    const normalizedScope = normalizeRelativePath(scope);
    if (containsScopeGlob(normalizedScope)) {
      return wildcardScopeMatch(targetRel, normalizedScope) || wildcardScopeMatch(targetAbs, normalizedScope);
    }
    const scopeAbs = normalizeAbsolutePath(scope, workspaceRoot);
    return targetAbs === scopeAbs || targetAbs.startsWith(`${scopeAbs}/`);
  });
}

function scopedWriteDeniedMessage(action: ToolAction, workspace: string): string {
  const targets = scopedWriteTargetPaths(action).map((path) => normalizeRelativePath(relative(resolve(workspace), resolve(workspace, path))));
  if (targets.length > 0) {
    return `Scoped-write sandbox denied tool action: ${action.type} outside file_scope (${targets.join(", ")})`;
  }
  return `Scoped-write sandbox denied tool action: ${action.type}`;
}

function normalizeAbsolutePath(path: string, base: string): string {
  return resolve(base, path).replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function containsScopeGlob(value: string): boolean {
  return value.includes("*");
}

function wildcardScopeMatch(value: string, pattern: string): boolean {
  const normalizedValue = normalizeRelativePath(value);
  const normalizedPattern = normalizeRelativePath(pattern);
  const source = normalizedPattern
    .split("**")
    .map((part) => part.split("*").map(escapeScopeRegExp).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(normalizedValue);
}

function escapeScopeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function relativeSandboxTargets(targets: string[], workspace: string): string[] | undefined {
  if (!targets.length) {
    return undefined;
  }
  return targets.map((path) => normalizeRelativePath(relative(resolve(workspace), resolve(workspace, path))));
}

function normalizedScope(fileScope: string[] | undefined): string[] | undefined {
  const scopes = fileScope?.map((scope) => normalizeRelativePath(scope.trim())).filter(Boolean);
  return scopes?.length ? scopes : undefined;
}

function allowSandboxDecision(
  policy: SandboxWritePolicy,
  subject: SandboxDecision["subject"],
  reason: string,
  metadata: Partial<Pick<SandboxDecision, "action" | "capability_id" | "targets" | "file_scope">>
): SandboxDecision {
  return {
    decision: "allow",
    policy,
    subject,
    reason,
    ...stripEmptySandboxMetadata(metadata)
  };
}

function denySandboxDecision(
  policy: SandboxWritePolicy,
  subject: SandboxDecision["subject"],
  reason: string,
  metadata: Partial<Pick<SandboxDecision, "action" | "capability_id" | "targets" | "file_scope">>
): SandboxDecision {
  return {
    decision: "deny",
    policy,
    subject,
    reason,
    ...stripEmptySandboxMetadata(metadata)
  };
}

function stripEmptySandboxMetadata<T extends Partial<Pick<SandboxDecision, "action" | "capability_id" | "targets" | "file_scope">>>(metadata: T): T {
  const copy = { ...metadata };
  if (Array.isArray(copy.targets) && copy.targets.length === 0) {
    delete copy.targets;
  }
  if (Array.isArray(copy.file_scope) && copy.file_scope.length === 0) {
    delete copy.file_scope;
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
