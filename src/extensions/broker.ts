import { randomUUID } from "node:crypto";
import type { SwarmSettings } from "../config/settings.js";
import type { RiskClass } from "../protocol/types.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, riskClassForAction, toolRequiresApproval } from "../tools/permissions.js";
import type { AgentDelegateAction, LocalToolContext, ToolApprovalRequest, ToolResult, WorkspaceChangeMetadata, FileLockEvent } from "../tools/types.js";
import type { SkillScope } from "./skills.js";
import { SKILL_ACTIVATE_CAPABILITY_ID } from "./skills.js";
import type { CapabilityDescriptor } from "./types.js";
import type { CapabilityPlane } from "./capability-plane.js";

export type CapabilityBrokerInput = {
  capabilityPlane: CapabilityPlane;
  settings: SwarmSettings;
  workspaceForSession: (sessionId?: string) => string;
  approvalHandler?: (request: ToolApprovalRequest) => Promise<boolean>;
  emitApproval: (request: ToolApprovalRequest, status: "pending" | "approved" | "denied") => void;
  emitToolResult: (event: {
    session_id?: string;
    task_id: string;
    title: string;
    action: string;
    summary: string;
    content?: string;
    status?: "success" | "partial" | "failed";
    outputRef?: string;
    errorCode?: string;
    recoverySuggestion?: string;
    capability?: { id: string; providerId: string; permissionName: string; riskClass: RiskClass };
  }) => void;
  delegate?: (action: AgentDelegateAction, sessionId: string, taskId: string) => Promise<ToolResult>;
  onWorkspaceChange?: (sessionId: string | undefined, change: WorkspaceChangeMetadata) => void;
  onFileLock?: (event: FileLockEvent) => void;
  activateSkill: (name: string, sessionId?: string, reason?: string) => {
    name: string;
    displayName: string;
    description: string;
    path: string;
    directory: string;
    allowedTools: string[];
    resourcePaths: string[];
    activatedAt: string;
    content: string;
    scope: SkillScope;
    trust: CapabilityDescriptor["trust"];
  };
  serverWebSearch?: LocalToolContext["serverWebSearch"];
};

export type CapabilityInvokeOptions = {
  taskId?: string;
  title?: string;
  allowDelegate?: boolean;
  source?: "coding_loop" | "gateway" | "runtime";
};

const LONG_OUTPUT_THRESHOLD_BYTES = 32_000;
const LONG_OUTPUT_PREVIEW_BYTES = 18_000;

export class CapabilityBroker {
  constructor(private readonly input: CapabilityBrokerInput) {}

  async invoke(
    capabilityId: string,
    args: Record<string, unknown>,
    sessionId?: string,
    options: CapabilityInvokeOptions = {}
  ): Promise<ToolResult> {
    const capability = await this.input.capabilityPlane.getCapability(capabilityId);
    if (!capability) {
      throw new Error(`Unknown capability: ${capabilityId}`);
    }
    const taskId = options.taskId ?? `capability_${randomUUID()}`;

    let result: ToolResult;
    try {
      this.assertCapabilityUsable(capability);
      await this.ensureApproval(capability, args, sessionId, taskId, options);
      result = await this.invokeProviderCapability(capability, args, sessionId, taskId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        action: capability.name,
        status: "failed",
        summary: message,
        errors: [message],
        errorCode: "CAPABILITY_INVOKE_FAILED",
        retryable: true,
        recoverable: true,
        recoverySuggestion: "Inspect the capability diagnostics, permissions, and provider status before retrying.",
        metadata: {
          capability_id: capability.id,
          provider_id: capability.providerId,
          permission: capability.permissionName
        }
      };
    }

    const prepared = sessionId
      ? await prepareBrokerOutput(sessionId, taskId, result, renderToolResultDetail(result))
      : { content: result.content, outputRef: result.outputRef, data: result.data ?? result.metadata };
    const normalized: ToolResult = {
      ...result,
      content: prepared.content,
      outputRef: prepared.outputRef,
      data: prepared.data,
      metadata: {
        ...(result.metadata ?? {}),
        capability_id: capability.id,
        provider_id: capability.providerId,
        permission: capability.permissionName,
        source: options.source ?? "runtime",
        outputRef: prepared.outputRef
      }
    };
    this.input.emitToolResult({
      session_id: sessionId,
      task_id: taskId,
      title: options.title ?? `Invoke ${capability.title ?? capability.name}`,
      action: capability.name,
      summary: normalized.summary,
      content: normalized.content,
      status: normalized.status ?? "success",
      outputRef: normalized.outputRef,
      errorCode: normalized.errorCode,
      recoverySuggestion: normalized.recoverySuggestion,
      capability: capabilityEvent(capability, riskClassForInvocation(capability, args))
    });
    return normalized;
  }

  private async invokeProviderCapability(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    taskId: string,
    options: CapabilityInvokeOptions
  ): Promise<ToolResult> {
    if (capability.kind === "local_tool" || capability.id.startsWith("local_tool.")) {
      const actionName = localActionNameForCapability(capability);
      const action = normalizeToolAction({ ...args, action: actionName });
      const context: LocalToolContext = {
        workspace: this.input.workspaceForSession(sessionId),
        settings: this.input.settings,
        sessionId,
        taskId,
        attempt: 0,
        serverWebSearch: this.input.serverWebSearch,
        onWorkspaceChange: (change) => this.input.onWorkspaceChange?.(sessionId, change),
        onFileLock: this.input.onFileLock,
        delegate: options.allowDelegate && sessionId && this.input.delegate
          ? (delegateAction) => this.input.delegate?.(delegateAction, sessionId, taskId) ?? Promise.reject(new Error("Delegate unavailable."))
          : undefined
      };
      return runLocalTool(action, context);
    }

    if (capability.kind === "mcp_tool" || capability.id.startsWith("mcp_tool.")) {
      return this.input.capabilityPlane.callMcpTool(capability.id, args);
    }

    if (capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
      return this.invokeSkillActivation(args, sessionId);
    }

    throw new Error(`Capability invocation is not implemented for ${capability.id}`);
  }

  private async ensureApproval(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    taskId: string,
    options: CapabilityInvokeOptions
  ): Promise<void> {
    const request = this.createApprovalRequest(capability, args, sessionId, taskId, options.source ?? "runtime");
    if (!request) {
      return;
    }
    if (!this.input.approvalHandler) {
      throw new Error(`Capability requires approval but no approval handler is available: ${capability.permissionName}`);
    }
    this.input.emitApproval(request, "pending");
    const approved = await this.input.approvalHandler(request);
    this.input.emitApproval(request, approved ? "approved" : "denied");
    if (!approved) {
      throw new Error(`Capability denied: ${capability.permissionName}`);
    }
  }

  private createApprovalRequest(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    taskId: string,
    source: string
  ): ToolApprovalRequest | undefined {
    if (capability.kind === "local_tool" || capability.id.startsWith("local_tool.")) {
      const action = normalizeToolAction({ ...args, action: localActionNameForCapability(capability) });
      if (!toolRequiresApproval(action, this.input.settings, { workspace: this.input.workspaceForSession(sessionId) })) {
        return undefined;
      }
      const request = createToolApprovalRequest(action);
      return {
        ...request,
        session_id: sessionId,
        task_id: taskId,
        detail: [
          request.detail,
          "",
          `Capability: ${capability.id}`,
          `Provider: ${capability.providerId}`,
          `Permission: ${capability.permissionName}`,
          `Source: ${source}`
        ].join("\n")
      };
    }
    if (!capabilityRequiresApproval(capability, this.input.settings)) {
      return undefined;
    }
    return createCapabilityApprovalRequest(capability, args, sessionId, taskId, source);
  }

  private assertCapabilityUsable(capability: CapabilityDescriptor): void {
    if (capability.trust === "disabled" || capability.status === "disabled") {
      throw new Error(`Capability is disabled: ${capability.id}`);
    }
    if (matchesCapabilityPermission(capability, this.input.settings.permissions.deny)) {
      throw new Error(`Capability denied by settings: ${capability.permissionName}`);
    }
    if (capability.trust === "untrusted") {
      throw new Error(`Capability is not trusted in this workspace: ${capability.id}`);
    }
    if (capability.status === "failed") {
      throw new Error(`Capability provider is failed: ${capability.id}`);
    }
  }

  private invokeSkillActivation(args: Record<string, unknown>, sessionId?: string): ToolResult {
    const name = typeof args.name === "string" ? args.name : typeof args.skill === "string" ? args.skill : "";
    if (!name.trim()) {
      return {
        action: SKILL_ACTIVATE_CAPABILITY_ID,
        status: "failed",
        summary: "Skill activation failed: missing skill name.",
        errors: ["Missing required input: name"],
        errorCode: "SKILL_NAME_MISSING",
        recoverable: true,
        retryable: true,
        recoverySuggestion: "Call skill.activate with a trusted skill name from the capabilities catalog."
      };
    }
    const reason = typeof args.reason === "string" ? args.reason : "model requested skill activation";
    try {
      const skill = this.input.activateSkill(name, sessionId, reason);
      return {
        action: SKILL_ACTIVATE_CAPABILITY_ID,
        status: "success",
        summary: `Skill activated: ${skill.name}.`,
        content: [
          `Skill: ${skill.displayName} (${skill.name})`,
          skill.description,
          "",
          skill.content
        ].join("\n"),
        data: {
          name: skill.name,
          title: skill.displayName,
          description: skill.description,
          path: skill.path,
          directory: skill.directory,
          allowed_tools: skill.allowedTools,
          resource_paths: skill.resourcePaths,
          activated_at: skill.activatedAt,
          durable_context: true
        },
        metadata: {
          skill: skill.name,
          scope: skill.scope,
          trust: skill.trust,
          durable_context: true
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        action: SKILL_ACTIVATE_CAPABILITY_ID,
        status: "failed",
        summary: `Skill activation failed: ${message}`,
        errors: [message],
        errorCode: "SKILL_ACTIVATE_FAILED",
        recoverable: true,
        retryable: false,
        recoverySuggestion: "Inspect /skills or GET /v1/skills, then retry with an available trusted skill."
      };
    }
  }
}

export function capabilityRequiresApproval(capability: CapabilityDescriptor, settings: SwarmSettings): boolean {
  if (matchesCapabilityPermission(capability, settings.permissions.deny)) {
    throw new Error(`Capability denied by settings: ${capability.permissionName}`);
  }
  if (matchesCapabilityPermission(capability, settings.permissions.allow)) {
    return false;
  }
  if (settings.permissions.defaultMode === "yolo" || settings.permissions.defaultMode === "full-auto" || settings.permissions.defaultMode === "auto") {
    return false;
  }
  return capability.trust === "untrusted" ||
    capability.riskClass !== "r0" ||
    matchesCapabilityPermission(capability, settings.permissions.ask);
}

export function createCapabilityApprovalRequest(
  capability: CapabilityDescriptor,
  args: Record<string, unknown>,
  sessionId: string | undefined,
  taskId: string,
  source: string
): ToolApprovalRequest {
  return {
    id: `approval_${randomUUID()}`,
    session_id: sessionId,
    task_id: taskId,
    action: capability.name,
    summary: `Use capability: ${capability.title ?? capability.name}`,
    detail: [
      capability.description,
      "",
      `Capability: ${capability.id}`,
      `Provider: ${capability.providerId}`,
      `Permission: ${capability.permissionName}`,
      `Source: ${source}`,
      `Arguments: ${JSON.stringify(redactCapabilityArguments(args), null, 2)}`,
      capability.inputSchema ? `Input schema:\n${JSON.stringify(capability.inputSchema, null, 2)}` : undefined
    ].filter(Boolean).join("\n"),
    risk: riskForCapability(capability),
    risk_class: capability.riskClass,
    target: capability.providerId,
    why_now: `Swarm needs ${capability.name} to continue the current task.`,
    predicted_impact: predictedCapabilityImpact(capability),
    rollback_plan: rollbackPlanForCapability(capability)
  };
}

export function matchesCapabilityPermission(capability: CapabilityDescriptor, rules: string[]): boolean {
  if (rules.includes(capability.permissionName) || rules.includes(`${capability.permissionName}(*)`)) {
    return true;
  }
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/.exec(capability.permissionName);
  if (!match) {
    return false;
  }
  const permissionName = match[1];
  const permissionTarget = match[2];
  return rules.some((rule) => {
    const parsed = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/.exec(rule);
    if (!parsed || parsed[1] !== permissionName) {
      return false;
    }
    return parsed[2] === "*" || parsed[2] === permissionTarget || wildcardMatch(permissionTarget, parsed[2]);
  });
}

function capabilityEvent(capability: CapabilityDescriptor, riskClass = capability.riskClass): { id: string; providerId: string; permissionName: string; riskClass: RiskClass } {
  return {
    id: capability.id,
    providerId: capability.providerId,
    permissionName: capability.permissionName,
    riskClass
  };
}

function localActionNameForCapability(capability: CapabilityDescriptor): string {
  return typeof capability.metadata?.action === "string"
    ? capability.metadata.action
    : capability.id.replace(/^local_tool\./, "");
}

function riskClassForInvocation(capability: CapabilityDescriptor, args: Record<string, unknown>): RiskClass {
  if (capability.kind !== "local_tool" && !capability.id.startsWith("local_tool.")) {
    return capability.riskClass;
  }
  try {
    return riskClassForAction(normalizeToolAction({ ...args, action: localActionNameForCapability(capability) }));
  } catch {
    return capability.riskClass;
  }
}

async function prepareBrokerOutput(
  sessionId: string,
  taskId: string,
  result: ToolResult,
  detail: string
): Promise<{ content?: string; outputRef?: string; data?: unknown }> {
  const data = result.data ?? result.metadata;
  const bytes = Buffer.byteLength(detail, "utf8");
  if (bytes <= LONG_OUTPUT_THRESHOLD_BYTES) {
    return { content: detail, outputRef: result.outputRef, data };
  }
  const ref = await writeTaskOutput({ sessionId, taskId, attempt: 0, content: detail });
  return {
    content: truncateMiddle(detail, LONG_OUTPUT_PREVIEW_BYTES, ref.bytes, ref.lines, ref.path),
    outputRef: ref.path,
    data: isRecord(data) ? { ...data, outputRef: ref } : { value: data, outputRef: ref }
  };
}

function riskForCapability(capability: CapabilityDescriptor): ToolApprovalRequest["risk"] {
  if (capability.permissionName.startsWith("Mcp") || capability.kind === "mcp_tool") {
    return capability.riskClass === "r0" ? "web" : "shell";
  }
  if (capability.permissionName.startsWith("Skill")) {
    return "delegate";
  }
  if (capability.permissionName === "PackageInstall") {
    return "install";
  }
  if (capability.permissionName === "WebSearch" || capability.permissionName === "WebFetch") {
    return "web";
  }
  if (capability.riskClass === "r2" || capability.riskClass === "r3" || capability.riskClass === "r4") {
    return "shell";
  }
  return capability.riskClass === "r1" ? "write" : "web";
}

function predictedCapabilityImpact(capability: CapabilityDescriptor): string {
  if (capability.kind === "mcp_tool") {
    return "External MCP server code may read local or remote data according to its own implementation; Swarm records and gates the invocation but cannot enforce the server internals.";
  }
  if (capability.kind === "local_tool") {
    return capability.riskClass === "r0"
      ? "Read-only or low-risk local tool call inside Swarm workspace policy."
      : "Local tool call may change workspace state or run commands under Swarm permission policy.";
  }
  if (capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
    return "Adds trusted skill instructions as durable session context.";
  }
  return capability.riskClass === "r0" ? "Read-only or low-risk capability call." : "Capability call may affect local or external state.";
}

function rollbackPlanForCapability(capability: CapabilityDescriptor): string {
  if (capability.kind === "local_tool") {
    return "Use recorded tool output, workspace change audit, and git diff to revert any workspace changes.";
  }
  if (capability.kind === "mcp_tool") {
    return "No automatic rollback is guaranteed for external MCP behavior; inspect provider output and audit records.";
  }
  if (capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
    return "Start a new session or deactivate/avoid the skill in subsequent turns if the context is no longer desired.";
  }
  return "No automatic rollback is guaranteed; inspect audit and follow up with a corrective action.";
}

function redactCapabilityArguments(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCapabilityArguments);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, next]) => [
    key,
    /token|secret|password|api[_-]?key|authorization/i.test(key)
      ? "[redacted]"
      : redactCapabilityArguments(next)
  ]));
}

function truncateMiddle(content: string, maxBytes: number, totalBytes: number, totalLines: number, path: string): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = maxBytes - headBytes;
  const omitted = Math.max(0, totalBytes - headBytes - tailBytes);
  return [
    buffer.subarray(0, headBytes).toString("utf8").trimEnd(),
    "",
    `[... ${omitted} bytes omitted from ${totalLines} lines. Full output: ${path}]`,
    "",
    buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8").trimStart()
  ].join("\n");
}

function wildcardMatch(value: string, pattern: string): boolean {
  const source = pattern
    .replace(/[\\^$+?.()|[\]{}]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${source}$`).test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
