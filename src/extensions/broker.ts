import { randomUUID } from "node:crypto";
import type { SwarmSettings } from "../config/settings.js";
import type { RiskClass } from "../protocol/types.js";
import {
  assertCapabilityAllowedBySandbox,
  assertToolActionAllowedBySandbox,
  formatSandboxFailureDetail,
  sandboxDecisionFromError,
  sandboxDecisionFromUnknown,
  sandboxFailureSummary,
  sandboxRecoverySuggestion,
  type SandboxDecision,
  type SandboxWritePolicy
} from "../runtime/sandbox-policy.js";
import { attachApprovalGovernance, shouldRecordGovernanceEvidence } from "../runtime/safety-governance.js";
import type { ApprovalGovernanceEvidence } from "../runtime/safety-governance.js";
import { taskContractForToolAction } from "../runtime/tool-task-sandbox.js";
import { writeTaskOutput } from "../storage/task-output-store.js";
import { normalizeToolAction, renderToolResultDetail, runLocalTool } from "../tools/local-tools.js";
import { createToolApprovalRequest, decideToolPermission, riskClassForAction } from "../tools/permissions.js";
import type { AgentDelegateAction, LocalToolContext, ToolApprovalRequest, ToolResult, WorkspaceChangeMetadata, FileLockEvent } from "../tools/types.js";
import { renderCustomCommandObjective } from "./custom-commands.js";
import { renderPluginSlashCommandObjective } from "./plugins.js";
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
  emitGovernance?: (governance: ApprovalGovernanceEvidence) => void;
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
    write_policy?: SandboxWritePolicy;
    file_scope?: string[];
    capability?: { id: string; providerId: string; permissionName: string; riskClass: RiskClass };
    sandbox?: SandboxDecision;
  }) => void;
  delegate?: (action: AgentDelegateAction, sessionId: string, taskId: string) => Promise<ToolResult>;
  agentControl?: LocalToolContext["agentControl"];
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
  blackboard?: LocalToolContext["blackboard"];
  materializeMcp?: (input: {
    kind: "resource" | "prompt";
    serverId: string;
    nameOrUri: string;
    result: unknown;
    sessionId?: string;
    args?: Record<string, string>;
  }) => Promise<unknown>;
  runSlashCommandObjective?: (
    objective: string,
    input: {
      capability: CapabilityDescriptor;
      args: Record<string, unknown>;
      sessionId?: string;
      taskId: string;
    }
  ) => Promise<ToolResult>;
};

export type CapabilityInvokeOptions = {
  taskId?: string;
  title?: string;
  allowDelegate?: boolean;
  source?: "coding_loop" | "gateway" | "runtime";
  writePolicy?: SandboxWritePolicy;
  fileScope?: string[];
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
      this.assertSandboxAllowed(capability, args, sessionId, options);
      await this.ensureApproval(capability, args, sessionId, taskId, options);
      result = await this.invokeProviderCapability(capability, args, sessionId, taskId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sandbox = sandboxDecisionFromError(error);
      const summary = sandbox ? sandboxFailureSummary(sandbox) : message;
      const errorCode = sandbox ? "PERMISSION_DENIED" : "CAPABILITY_INVOKE_FAILED";
      const recoverySuggestion = sandbox
        ? sandboxRecoverySuggestion(sandbox)
        : "Inspect the capability diagnostics, permissions, and provider status before retrying.";
      result = {
        action: capability.name,
        status: "failed",
        summary,
        content: formatCapabilityFailureContent(capability, summary, errorCode, recoverySuggestion, sandbox),
        errors: [message],
        errorCode,
        retryable: !sandbox,
        recoverable: true,
        recoverySuggestion,
        metadata: {
          capability_id: capability.id,
          provider_id: capability.providerId,
          permission: capability.permissionName,
          participant_id: capabilityStringMetadata(capability, "participant_id") ?? participantIdForCapability(capability),
          capability_lease: capabilityLeaseEvidence(capability, options),
          envelope_evidence: capabilityEnvelopeEvidence(capability, sessionId, taskId, options),
          ...(sandbox ? { sandbox } : {})
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
        participant_id: capabilityStringMetadata(capability, "participant_id") ?? participantIdForCapability(capability),
        capability_lease: capabilityLeaseEvidence(capability, options),
        envelope_evidence: capabilityEnvelopeEvidence(capability, sessionId, taskId, options),
        outputRef: prepared.outputRef
      }
    };
    const sandbox = sandboxDecisionFromUnknown(normalized.metadata?.sandbox ?? normalized.data);
    const taskContract = taskContractForCapability(capability, args, options);
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
      write_policy: taskContract.write_policy,
      file_scope: taskContract.file_scope,
      capability: capabilityEvent(capability, riskClassForInvocation(capability, args)),
      sandbox
    });
    return normalized;
  }

  private assertSandboxAllowed(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    options: CapabilityInvokeOptions
  ): void {
    if (!options.writePolicy) {
      return;
    }
    if (capability.kind === "local_tool" || capability.id.startsWith("local_tool.")) {
      const actionName = localActionNameForCapability(capability);
      const action = normalizeToolAction({ ...args, action: args.action ?? capability.name ?? actionName }, actionName);
      assertToolActionAllowedBySandbox(action, {
        writePolicy: options.writePolicy,
        workspace: this.input.workspaceForSession(sessionId),
        fileScope: options.fileScope
      });
      return;
    }
    assertCapabilityAllowedBySandbox(capability, options.writePolicy);
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
      const action = normalizeToolAction({ ...args, action: args.action ?? capability.name ?? actionName }, actionName);
      const context: LocalToolContext = {
        workspace: this.input.workspaceForSession(sessionId),
        settings: this.input.settings,
        sessionId,
        taskId,
        attempt: 0,
        serverWebSearch: this.input.serverWebSearch,
        blackboard: this.input.blackboard,
        agentControl: this.input.agentControl,
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

    if (capability.kind === "mcp_resource" || capability.id.startsWith("mcp_resource.")) {
      return this.invokeMcpResource(capability, args, sessionId);
    }

    if (capability.kind === "mcp_prompt" || capability.id.startsWith("mcp_prompt.")) {
      return this.invokeMcpPrompt(capability, args, sessionId);
    }

    if (capability.id === SKILL_ACTIVATE_CAPABILITY_ID) {
      return this.invokeSkillActivation(args, sessionId);
    }

    if (capability.kind === "skill" || capability.id.startsWith("skill.")) {
      return this.invokeNamedSkill(capability, args, sessionId);
    }

    if (capability.kind === "agent_spec" || capability.id.startsWith("agent_spec.")) {
      return this.invokeAgentSpec(capability, args, sessionId, taskId);
    }

    if (capability.kind === "slash_command") {
      return this.invokeSlashCommand(capability, args, sessionId, taskId);
    }

    throw new Error(`Capability invocation is not implemented for ${capability.id}`);
  }

  private async invokeSlashCommand(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    taskId: string
  ): Promise<ToolResult> {
    if (!this.input.runSlashCommandObjective) {
      return slashCommandNotInvokable(capability);
    }
    const rawArgs = slashCommandRawArgs(args);
    const objective = this.renderSlashCommandObjective(capability, rawArgs);
    if (!objective) {
      return slashCommandNotInvokable(capability);
    }
    const result = await this.input.runSlashCommandObjective(objective, { capability, args, sessionId, taskId });
    return {
      ...result,
      action: capability.name,
      summary: result.summary || `Slash command completed: ${capability.name}`,
      metadata: {
        ...(result.metadata ?? {}),
        slash_command: capability.name,
        rendered_objective: objective
      }
    };
  }

  private renderSlashCommandObjective(capability: CapabilityDescriptor, rawArgs: string): string | undefined {
    if (capability.id.startsWith("custom-command.")) {
      const name = customCommandNameForCapability(capability);
      const command = this.input.capabilityPlane.getCustomCommand(name);
      return command ? renderCustomCommandObjective(command, rawArgs) : undefined;
    }
    if (capability.id.startsWith("plugin.") && capability.providerId.startsWith("plugin:")) {
      const pluginId = capabilityStringMetadata(capability, "plugin_id") ?? capability.providerId.slice("plugin:".length);
      const contributionId = pluginSlashContributionIdForCapability(capability);
      const plugin = this.input.capabilityPlane.listPlugins().find((item) => item.id === pluginId);
      const contribution = plugin?.contributions.find((item) => item.kind === "slash_command" && item.id === contributionId);
      return plugin && contribution ? renderPluginSlashCommandObjective(plugin, contribution, rawArgs) : undefined;
    }
    return undefined;
  }

  private invokeNamedSkill(capability: CapabilityDescriptor, args: Record<string, unknown>, sessionId?: string): ToolResult {
    return this.invokeSkillActivation({
      name: capability.name,
      reason: typeof args.reason === "string" ? args.reason : `capability invoke ${capability.id}`
    }, sessionId);
  }

  private async invokeAgentSpec(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    taskId: string
  ): Promise<ToolResult> {
    if (!this.input.delegate || !sessionId) {
      return {
        action: capability.name,
        status: "failed",
        summary: "Agent spec invocation requires an active parent session.",
        errors: ["Missing session_id or delegate runtime."],
        errorCode: "AGENT_SPEC_SESSION_REQUIRED",
        retryable: false,
        recoverable: true,
        recoverySuggestion: "Create or resume a WorkSession, then invoke the agent spec with session_id."
      };
    }
    const task = requiredStringArg(args, ["task", "prompt", "objective", "description"], "Agent spec invocation requires task or prompt.");
    const context = optionalStringArg(args, ["context"]);
    const runInBackground = args.run_in_background === true || args.runInBackground === true;
    const preferredMode = runInBackground ? "parallel" : agentInvocationModeArg(args.mode ?? args.preferred_mode ?? args.invocation_mode);
    const action: AgentDelegateAction = {
      type: "agent.delegate",
      capability: capability.name,
      task,
      context,
      preferred_agent_spec_id: agentSpecIdForCapability(capability),
      preferred_mode: preferredMode,
      run_in_background: runInBackground,
      file_scope: stringArrayArg(args.file_scope ?? args.fileScope ?? args.paths)
    };
    return this.input.delegate(action, sessionId, taskId);
  }

  private async invokeMcpResource(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const serverId = capabilityStringMetadata(capability, "server_id") ?? mcpServerIdFromProvider(capability.providerId);
    const uri = stringArg(args, "uri") ?? capabilityStringMetadata(capability, "uri");
    if (!serverId || !uri) {
      throw new Error(`MCP resource capability is missing server_id or uri metadata: ${capability.id}`);
    }
    const raw = await this.input.capabilityPlane.readMcpResource(serverId, uri);
    const materialized = await this.input.materializeMcp?.({
      kind: "resource",
      serverId,
      nameOrUri: uri,
      result: raw,
      sessionId
    }) ?? raw;
    return {
      action: capability.name,
      status: "success",
      summary: `MCP resource read: ${serverId}:${uri}`,
      content: JSON.stringify(materialized, null, 2),
      data: materialized,
      metadata: {
        server_id: serverId,
        uri,
        capability_id: capability.id,
        materialized: Boolean(this.input.materializeMcp)
      }
    };
  }

  private async invokeMcpPrompt(
    capability: CapabilityDescriptor,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    const serverId = capabilityStringMetadata(capability, "server_id") ?? mcpServerIdFromProvider(capability.providerId);
    const name = stringArg(args, "name") ?? stringArg(args, "prompt") ?? stringArg(args, "prompt_name") ?? capabilityStringMetadata(capability, "prompt_name");
    if (!serverId || !name) {
      throw new Error(`MCP prompt capability is missing server_id or prompt_name metadata: ${capability.id}`);
    }
    const promptArgs = promptArguments(args);
    const raw = await this.input.capabilityPlane.getMcpPrompt(serverId, name, promptArgs);
    const materialized = await this.input.materializeMcp?.({
      kind: "prompt",
      serverId,
      nameOrUri: name,
      result: raw,
      sessionId,
      args: promptArgs
    }) ?? raw;
    return {
      action: capability.name,
      status: "success",
      summary: `MCP prompt materialized: ${serverId}:${name}`,
      content: JSON.stringify(materialized, null, 2),
      data: materialized,
      metadata: {
        server_id: serverId,
        prompt_name: name,
        capability_id: capability.id,
        materialized: Boolean(this.input.materializeMcp)
      }
    };
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
    if (request.governance && shouldRecordGovernanceEvidence(request) && request.permission_decision === "allow") {
      if (this.input.emitGovernance) {
        this.input.emitGovernance(request.governance);
      } else {
        this.input.emitApproval(request, "approved");
      }
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
      const permissionDecision = decideToolPermission(action, this.input.settings, { workspace: this.input.workspaceForSession(sessionId) });
      if (permissionDecision.decision === "deny") {
        throw new Error(`Tool action denied by ~/.swarm/settings.json permissions: ${capability.permissionName}`);
      }
      if (permissionDecision.decision !== "ask") {
        const evidenceRequest = createToolApprovalRequest(action, permissionDecision);
        if (!shouldRecordGovernanceEvidence(evidenceRequest)) {
          return undefined;
        }
        const request = {
          ...evidenceRequest,
          session_id: sessionId,
          task_id: taskId,
          detail: [
            evidenceRequest.detail,
            "",
            `Capability: ${capability.id}`,
            `Provider: ${capability.providerId}`,
            `Permission: ${capability.permissionName}`,
            `Source: ${source}`
          ].join("\n")
        };
        return attachApprovalGovernance(request, {
          status: "evidence",
          decision_source: `capability.${source}`,
          actor_id: source === "gateway" ? "gateway.local" : "main_swarm"
        });
      }
      const request = createToolApprovalRequest(action, permissionDecision);
      return attachApprovalGovernance({
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
      }, {
        status: "requested",
        decision_source: `capability.${source}`,
        actor_id: source === "gateway" ? "gateway.local" : "main_swarm"
      });
    }
    if (!capabilityRequiresApproval(capability, this.input.settings)) {
      if (!["yolo", "full-auto", "auto"].includes(this.input.settings.permissions.defaultMode) || capability.riskClass === "r0") {
        return undefined;
      }
      const request: ToolApprovalRequest = {
        ...createCapabilityApprovalRequest(capability, args, sessionId, taskId, source),
        permission_decision: "allow",
        permission_reason: `Allowed by ${this.input.settings.permissions.defaultMode} permission mode with governance evidence.`,
        permission_mode: this.input.settings.permissions.defaultMode,
        permission_name: capability.permissionName
      };
      return attachApprovalGovernance(request, {
        status: "evidence",
        decision_source: `capability.${source}`,
        actor_id: source === "gateway" ? "gateway.local" : "main_swarm"
      });
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

function taskContractForCapability(
  capability: CapabilityDescriptor,
  args: Record<string, unknown>,
  options: CapabilityInvokeOptions
): {
  write_policy?: SandboxWritePolicy;
  file_scope?: string[];
} {
  if (capability.kind === "local_tool" || capability.id.startsWith("local_tool.")) {
    const actionName = localActionNameForCapability(capability);
    try {
      const action = normalizeToolAction({ ...args, action: args.action ?? capability.name ?? actionName }, actionName);
      return taskContractForToolAction(action, {
        writePolicy: options.writePolicy,
        fileScope: options.fileScope
      });
    } catch {
      // Fall through to capability-level contract.
    }
  }
  if (options.writePolicy === "read_only" || capability.readOnly === true) {
    return { write_policy: "read_only" };
  }
  if (options.writePolicy === "scoped_write") {
    return {
      write_policy: "scoped_write",
      ...(options.fileScope?.length ? { file_scope: options.fileScope } : {})
    };
  }
  if (options.writePolicy === "workspace_write") {
    return {
      write_policy: "workspace_write",
      ...(options.fileScope?.length ? { file_scope: options.fileScope } : {})
    };
  }
  if (options.fileScope?.length) {
    return {
      write_policy: "scoped_write",
      file_scope: options.fileScope
    };
  }
  return {};
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
  return attachApprovalGovernance({
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
  }, {
    status: "requested",
    decision_source: `capability.${source}`,
    actor_id: source === "gateway" ? "gateway.local" : "main_swarm"
  });
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

function agentSpecIdForCapability(capability: CapabilityDescriptor): string {
  return capability.id.startsWith("agent_spec.")
    ? capability.id.slice("agent_spec.".length)
    : capability.name;
}

function slashCommandRawArgs(args: Record<string, unknown>): string {
  return [
    args.rawArgs,
    args.raw_args,
    args.arguments,
    args.args,
    args.input
  ].find((value) => typeof value === "string" && value.trim()) as string | undefined ?? "";
}

function customCommandNameForCapability(capability: CapabilityDescriptor): string {
  return capability.id.startsWith("custom-command.")
    ? capability.id.slice("custom-command.".length)
    : capability.name.replace(/^\//, "");
}

function pluginSlashContributionIdForCapability(capability: CapabilityDescriptor): string {
  const metadataContribution = capabilityStringMetadata(capability, "contribution_id");
  if (metadataContribution) {
    return metadataContribution;
  }
  const parts = capability.id.split(".");
  return parts[parts.length - 1] || capability.name.replace(/^\//, "");
}

function slashCommandNotInvokable(capability: CapabilityDescriptor): ToolResult {
  return {
    action: capability.name,
    status: "failed",
    summary: `Slash command capability is inspect-only: ${capability.name}`,
    errors: [`No runtime executor is available for ${capability.id}.`],
    errorCode: "SLASH_COMMAND_NOT_INVOKABLE",
    retryable: false,
    recoverable: true,
    recoverySuggestion: "Use the command in the TUI, or invoke a custom/plugin slash command through a runtime that provides a slash objective executor."
  };
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

function formatCapabilityFailureContent(
  capability: CapabilityDescriptor,
  summary: string,
  errorCode: string,
  recoverySuggestion: string,
  sandbox?: SandboxDecision
): string {
  return [
    `ERROR: ${summary}`,
    `Error code: ${errorCode}`,
    `Recovery: ${recoverySuggestion}`,
    `Capability: ${capability.id}`,
    `Provider: ${capability.providerId}`,
    `Permission: ${capability.permissionName}`,
    sandbox ? formatSandboxFailureDetail(sandbox) : undefined
  ].filter(Boolean).join("\n");
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

function capabilityStringMetadata(capability: CapabilityDescriptor, key: string): string | undefined {
  const value = capability.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function participantIdForCapability(capability: CapabilityDescriptor): string {
  if (capability.providerId.startsWith("mcp:")) {
    return `capability:mcp:${capability.providerId.slice("mcp:".length)}`;
  }
  if (capability.providerId.startsWith("lsp:")) {
    return `capability:lsp:${capability.providerId.slice("lsp:".length)}`;
  }
  if (capability.kind === "skill" && capability.id !== SKILL_ACTIVATE_CAPABILITY_ID) {
    return `capability:skill:${capability.name}`;
  }
  return `capability:${capability.providerId}`;
}

function capabilityLeaseEvidence(
  capability: CapabilityDescriptor,
  options: CapabilityInvokeOptions
): Record<string, unknown> {
  return {
    required: capability.kind !== "local_tool",
    capability: capability.id,
    provider_id: capability.providerId,
    permission: capability.permissionName,
    source: options.source ?? "runtime",
    write_policy: options.writePolicy,
    file_scope: options.fileScope,
    reason: capability.kind === "local_tool"
      ? "Local tools are still gated by run tool policy, permissions, and sandbox policy."
      : "External and durable-context capability calls require capability-plane mediation and recorded lease evidence."
  };
}

function capabilityEnvelopeEvidence(
  capability: CapabilityDescriptor,
  sessionId: string | undefined,
  taskId: string,
  options: CapabilityInvokeOptions
): Record<string, unknown> {
  return {
    schema_version: "swarm.capability_envelope_evidence.v1",
    actor_id: options.source === "gateway" ? "gateway.local" : options.source === "coding_loop" ? "main_swarm" : "runtime",
    session_id: sessionId,
    task_id: taskId,
    capability_id: capability.id,
    provider_id: capability.providerId,
    participant_id: capabilityStringMetadata(capability, "participant_id") ?? participantIdForCapability(capability),
    source: options.source ?? "runtime",
    envelope_type: "task.progress",
    intent: "capability.invoke"
  };
}

function mcpServerIdFromProvider(providerId: string): string | undefined {
  return providerId.startsWith("mcp:") ? providerId.slice("mcp:".length) : undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringArg(args, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function requiredStringArg(args: Record<string, unknown>, keys: string[], message: string): string {
  const value = optionalStringArg(args, keys);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function agentInvocationModeArg(value: unknown): AgentDelegateAction["preferred_mode"] {
  return value === "handoff" || value === "parallel" || value === "call_subagent" ? value : undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function promptArguments(args: Record<string, unknown>): Record<string, string> | undefined {
  const raw = isRecord(args.arguments)
    ? args.arguments
    : isRecord(args.args)
      ? args.args
      : undefined;
  if (!raw) {
    return undefined;
  }
  const entries = Object.entries(raw)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
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
