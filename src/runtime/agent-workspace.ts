import type { ApprovalRecord } from "../storage/approval-store.js";
import type { CapabilityDescriptor, CapabilityDiagnostic, CapabilityProviderSnapshot, CapabilityTrust } from "../extensions/types.js";
import type { SkillRecord } from "../extensions/skills.js";
import type { SymphonyDaemonRecord, SymphonyDaemonStatus } from "../symphony/daemon.js";
import type { SymphonyStatus } from "../symphony/status.js";
import type { WorkBoard, WorkBoardClaim, WorkBoardNextAction, WorkBoardWorker } from "./work-board.js";

export type AgentWorkspaceSeverity = "info" | "warning" | "error";
export type AgentWorkspaceReadinessStatus = "ready" | "attention" | "blocked" | "unknown";

export type AgentWorkspaceSourceRef = {
  type: "worker" | "approval" | "handoff" | "check" | "artifact" | "session" | "task" | "automation" | "capability" | "skill" | "work_board";
  id: string;
  session_id?: string;
};

export type AgentWorkspaceControl = {
  id: "stop" | "continue" | "resume" | "take_back" | "inspect" | "approve" | "retry" | "open";
  label: string;
  intent: string;
  method: "GET" | "POST";
  route: string;
  enabled: boolean;
  reason?: string;
};

export type AgentWorkspaceTeammate = {
  id: string;
  display_name: string;
  role_title?: string;
  status: WorkBoardWorker["status"];
  state: "active" | "blocked" | "resumable" | "done" | "failed";
  session_id?: string;
  worker_session_id?: string;
  capability: string;
  agent_spec_id?: string;
  invocation_mode?: string;
  current_task: string;
  owner?: string;
  file_scope: string[];
  blocked_reason?: string;
  recovery?: string;
  last_artifact?: string;
  checks: string[];
  changed_files: string[];
  memory_hints: string[];
  updated_at: string;
  controls: AgentWorkspaceControl[];
};

export type AgentWorkspaceAttentionItem = {
  id: string;
  kind:
    | "approval"
    | "blocked_worker"
    | "failed_worker"
    | "failed_check"
    | "handoff_wait"
    | "automation_exception"
    | "work_board_action";
  severity: AgentWorkspaceSeverity;
  reason: string;
  owner?: string;
  source_ref: AgentWorkspaceSourceRef;
  recommended_action: string;
  control_intent?: string;
  created_at?: string;
  updated_at?: string;
};

export type AgentWorkspaceActivityItem = {
  id: string;
  kind: "worker" | "check" | "artifact" | "automation" | "work_action";
  severity: AgentWorkspaceSeverity;
  title: string;
  detail?: string;
  source_ref: AgentWorkspaceSourceRef;
  timestamp?: string;
};

export type AgentWorkspaceSkillState = {
  name: string;
  display_name: string;
  description: string;
  scope: SkillRecord["scope"];
  trust: CapabilityTrust;
  state: "trusted" | "untrusted" | "disabled" | "shadowed" | "available";
  path: string;
  shadowed_by?: string;
  allowed_tools: string[];
  resource_paths: string[];
  diagnostics: CapabilityDiagnostic[];
};

export type AgentWorkspaceCapabilityState = {
  id: string;
  kind: CapabilityDescriptor["kind"];
  provider_id: string;
  provider_title?: string;
  name: string;
  title?: string;
  description: string;
  trust: CapabilityTrust;
  risk_class: CapabilityDescriptor["riskClass"];
  enabled: boolean;
  hidden: boolean;
  model_visible: boolean;
  user_visible: boolean;
  read_only?: boolean;
  state: "available" | "disabled" | "failed" | "pending" | "untrusted";
  diagnostics: CapabilityDiagnostic[];
};

export type AgentWorkspaceReadinessItem = {
  id: "workspace" | "work_board" | "approvals" | "capability_providers" | "skills" | "automations" | "gateway_projection";
  label: string;
  status: AgentWorkspaceReadinessStatus;
  severity: AgentWorkspaceSeverity;
  summary: string;
  next_action?: string;
  source_ref?: AgentWorkspaceSourceRef;
};

export type AgentWorkspaceAutomationItem = {
  id: string;
  product_label: "Automations";
  internal_name: "symphony";
  kind: "status" | "daemon";
  status: string;
  severity: AgentWorkspaceSeverity;
  summary: string;
  route: string;
  workflow_path?: string;
  tick_count?: number;
  next_tick_at?: string;
  last_error?: string;
  controls: AgentWorkspaceControl[];
};

export type AgentWorkspaceProjection = {
  schema_version: "swarm.agent_workspace.v1";
  generated_at: string;
  workspace_path?: string;
  scope: WorkBoard["scope"];
  work_board_summary: WorkBoard["summary"];
  summary: {
    teammates: number;
    active_teammates: number;
    attention: number;
    critical_attention: number;
    activity: number;
    skills: number;
    capabilities: number;
    readiness: AgentWorkspaceReadinessStatus;
    automations: number;
  };
  teammates: AgentWorkspaceTeammate[];
  attention: AgentWorkspaceAttentionItem[];
  activity: AgentWorkspaceActivityItem[];
  skills: AgentWorkspaceSkillState[];
  capabilities: AgentWorkspaceCapabilityState[];
  readiness: AgentWorkspaceReadinessItem[];
  automations: AgentWorkspaceAutomationItem[];
};

export type BuildAgentWorkspaceProjectionInput = {
  board: WorkBoard;
  approvals?: ApprovalRecord[];
  skills?: SkillRecord[];
  capabilities?: CapabilityDescriptor[];
  providers?: CapabilityProviderSnapshot[];
  symphonyStatus?: SymphonyStatus;
  daemons?: SymphonyDaemonRecord[];
  workspacePath?: string;
};

const RAW_PROTOCOL_ACTIVITY = /\b(ASP|protocol|heartbeat|envelope)\b/i;

export function buildAgentWorkspaceProjection(input: BuildAgentWorkspaceProjectionInput): AgentWorkspaceProjection {
  const teammates = input.board.workers.map(teammateFromWorker);
  const automations = automationItems(input.symphonyStatus, input.daemons ?? []);
  const skills = (input.skills ?? []).map(skillState);
  const capabilities = capabilityStates(input.capabilities ?? [], input.providers ?? []);
  const attention = attentionItems({
    board: input.board,
    approvals: input.approvals ?? [],
    automations
  });
  const activity = activityItems(input.board, automations);
  const readiness = readinessItems({
    board: input.board,
    approvals: input.approvals ?? [],
    skills,
    capabilities,
    providers: input.providers ?? [],
    automations,
    workspacePath: input.workspacePath ?? input.board.scope.workspace_path
  });
  const readinessStatus = readiness.some((item) => item.status === "blocked")
    ? "blocked"
    : readiness.some((item) => item.status === "attention")
      ? "attention"
      : readiness.some((item) => item.status === "unknown")
        ? "unknown"
        : "ready";

  return {
    schema_version: "swarm.agent_workspace.v1",
    generated_at: input.board.generated_at,
    workspace_path: input.workspacePath ?? input.board.scope.workspace_path,
    scope: input.board.scope,
    work_board_summary: input.board.summary,
    summary: {
      teammates: teammates.length,
      active_teammates: teammates.filter((item) => item.state === "active" || item.state === "blocked").length,
      attention: attention.length,
      critical_attention: attention.filter((item) => item.severity === "error").length,
      activity: activity.length,
      skills: skills.length,
      capabilities: capabilities.length,
      readiness: readinessStatus,
      automations: automations.length
    },
    teammates,
    attention,
    activity,
    skills,
    capabilities,
    readiness,
    automations
  };
}

function teammateFromWorker(worker: WorkBoardWorker): AgentWorkspaceTeammate {
  return {
    id: worker.worker_id,
    display_name: worker.display_name,
    role_title: worker.role_title,
    status: worker.status,
    state: teammateState(worker),
    session_id: worker.session_id,
    worker_session_id: worker.worker_session_id,
    capability: worker.capability,
    agent_spec_id: worker.agent_spec_id,
    invocation_mode: worker.invocation_mode,
    current_task: worker.objective,
    owner: worker.claim_owner ?? worker.requested_by,
    file_scope: [...worker.file_scope],
    blocked_reason: worker.blocked_reason,
    recovery: worker.recovery,
    last_artifact: worker.last_artifact,
    checks: [...(worker.trajectory?.checks ?? [])],
    changed_files: [...(worker.trajectory?.changed_files ?? [])],
    memory_hints: teammateMemoryHints(worker),
    updated_at: worker.updated_at,
    controls: teammateControls(worker)
  };
}

function teammateState(worker: WorkBoardWorker): AgentWorkspaceTeammate["state"] {
  if (worker.blocked_reason || worker.heartbeat_state === "blocked") {
    return "blocked";
  }
  if (worker.status === "failed") {
    return "failed";
  }
  if (worker.status === "completed") {
    return "done";
  }
  if (worker.status === "stopped") {
    return "resumable";
  }
  return "active";
}

function teammateMemoryHints(worker: WorkBoardWorker): string[] {
  const hints = [
    worker.trajectory?.report,
    worker.last_artifact,
    worker.recovery
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(hints).slice(0, 3);
}

function teammateControls(worker: WorkBoardWorker): AgentWorkspaceControl[] {
  return [
    {
      id: "inspect",
      label: "Inspect",
      intent: "teammate.inspect",
      method: "GET",
      route: `/v1/workers/${encodeURIComponent(worker.worker_id)}`,
      enabled: true
    },
    {
      id: "stop",
      label: "Stop",
      intent: "teammate.stop",
      method: "POST",
      route: `/v1/workers/${encodeURIComponent(worker.worker_id)}/stop`,
      enabled: worker.status === "running" || worker.status === "pending",
      reason: worker.status === "running" || worker.status === "pending" ? undefined : "Only active teammates can be stopped."
    },
    {
      id: "continue",
      label: "Continue",
      intent: "teammate.continue",
      method: "POST",
      route: `/v1/workers/${encodeURIComponent(worker.worker_id)}/continue`,
      enabled: worker.status === "failed" || worker.status === "stopped" || Boolean(worker.blocked_reason),
      reason: worker.status === "failed" || worker.status === "stopped" || worker.blocked_reason ? undefined : "Continue is available for blocked or resumable teammates."
    },
    {
      id: "resume",
      label: "Resume",
      intent: "teammate.resume",
      method: "POST",
      route: `/v1/workers/${encodeURIComponent(worker.worker_id)}/continue`,
      enabled: worker.status === "failed" || worker.status === "stopped",
      reason: worker.status === "failed" || worker.status === "stopped" ? undefined : "Resume reuses the worker continue route for failed or stopped teammates."
    },
    {
      id: "take_back",
      label: "Take back",
      intent: "teammate.take_back",
      method: "POST",
      route: worker.handoff_id ? `/v1/handoffs/${encodeURIComponent(worker.handoff_id)}/take-back` : "/v1/handoffs",
      enabled: Boolean(worker.handoff_id),
      reason: worker.handoff_id ? undefined : "No handoff is attached to this teammate."
    }
  ];
}

function attentionItems(input: {
  board: WorkBoard;
  approvals: ApprovalRecord[];
  automations: AgentWorkspaceAutomationItem[];
}): AgentWorkspaceAttentionItem[] {
  const items: AgentWorkspaceAttentionItem[] = [];
  for (const approval of input.approvals.filter((item) => item.status === "pending")) {
    items.push({
      id: `approval:${approval.approval_id}`,
      kind: "approval",
      severity: approval.risk_class === "r4" || approval.risk_class === "r3" ? "error" : "warning",
      reason: approval.summary,
      owner: approval.session_id,
      source_ref: { type: "approval", id: approval.approval_id, session_id: approval.session_id },
      recommended_action: approval.challenge.attention_note ?? approval.challenge.why_now ?? "Review and decide the pending approval.",
      control_intent: "approval.decide",
      created_at: approval.created_at,
      updated_at: approval.updated_at
    });
  }

  for (const worker of input.board.workers) {
    if (worker.blocked_reason) {
      items.push({
        id: `blocked-worker:${worker.worker_id}`,
        kind: "blocked_worker",
        severity: "warning",
        reason: worker.blocked_reason,
        owner: worker.claim_owner ?? worker.requested_by,
        source_ref: { type: "worker", id: worker.worker_id, session_id: worker.session_id },
        recommended_action: worker.recovery ?? "Inspect the teammate blocker, then continue or take back the work.",
        control_intent: "teammate.continue",
        updated_at: worker.updated_at
      });
    }
    if (worker.status === "failed") {
      items.push({
        id: `failed-worker:${worker.worker_id}`,
        kind: "failed_worker",
        severity: "error",
        reason: worker.recovery ?? `Worker ${worker.worker_id} failed.`,
        owner: worker.claim_owner ?? worker.requested_by,
        source_ref: { type: "worker", id: worker.worker_id, session_id: worker.session_id },
        recommended_action: worker.recovery ?? "Inspect the failed teammate report and retry or continue.",
        control_intent: "teammate.continue",
        updated_at: worker.updated_at
      });
    }
  }

  for (const check of input.board.checks.filter((item) => item.status === "failed")) {
    items.push({
      id: `failed-check:${check.session_id}:${check.value}`,
      kind: "failed_check",
      severity: "error",
      reason: check.value,
      source_ref: { type: "check", id: check.value, session_id: check.session_id },
      recommended_action: check.recovery ?? "Inspect the failed check output, fix the issue, then rerun verification.",
      control_intent: "check.rerun"
    });
  }

  for (const claim of input.board.claims.filter(isHandoffAttentionClaim)) {
    items.push({
      id: `handoff:${claim.claim_id}`,
      kind: "handoff_wait",
      severity: claim.status === "conflict" || claim.status === "timeout" || claim.heartbeat_state === "stale" ? "warning" : "info",
      reason: claim.recovery ?? claim.stale_reason ?? claim.conflict_reason ?? `Review handoff ${claim.claim_id}.`,
      owner: claim.claim_owner,
      source_ref: { type: "handoff", id: claim.claim_id, session_id: claim.session_id },
      recommended_action: claim.recovery ?? "Inspect the handoff and decide whether to wait, renew, or take it back.",
      control_intent: "handoff.take_back",
      updated_at: claim.updated_at
    });
  }

  for (const automation of input.automations.filter((item) => item.severity === "error" || item.severity === "warning")) {
    items.push({
      id: `automation:${automation.id}`,
      kind: "automation_exception",
      severity: automation.severity,
      reason: automation.last_error ?? automation.summary,
      source_ref: { type: "automation", id: automation.id },
      recommended_action: automation.last_error ? "Inspect the automation error, then retry or stop the daemon." : "Inspect the automation status.",
      control_intent: "automation.inspect",
      updated_at: automation.next_tick_at
    });
  }

  for (const action of input.board.next_actions) {
    items.push({
      id: `work-board:${action.source}:${action.id}`,
      kind: "work_board_action",
      severity: action.severity,
      reason: action.action,
      source_ref: { type: workBoardSourceType(action.source), id: action.id },
      recommended_action: action.action,
      control_intent: "work_board.inspect"
    });
  }

  return dedupeAttention(items)
    .sort((left, right) => attentionRank(left) - attentionRank(right) || (right.updated_at ?? right.created_at ?? "").localeCompare(left.updated_at ?? left.created_at ?? ""));
}

function isHandoffAttentionClaim(claim: WorkBoardClaim): boolean {
  return claim.kind === "handoff" && (
    claim.status === "active" ||
    claim.status === "requested" ||
    claim.status === "accepted" ||
    claim.status === "renewed" ||
    claim.status === "checkpointed" ||
    claim.status === "conflict" ||
    claim.status === "timeout" ||
    claim.status === "stale" ||
    claim.heartbeat_state === "missing" ||
    claim.heartbeat_state === "stale" ||
    claim.heartbeat_state === "blocked"
  );
}

function attentionRank(item: AgentWorkspaceAttentionItem): number {
  switch (item.kind) {
    case "approval":
      return 10;
    case "blocked_worker":
      return 20;
    case "failed_worker":
      return 25;
    case "failed_check":
      return 30;
    case "handoff_wait":
      return 40;
    case "automation_exception":
      return 50;
    case "work_board_action":
      return 60;
  }
}

function dedupeAttention(items: AgentWorkspaceAttentionItem[]): AgentWorkspaceAttentionItem[] {
  const seen = new Set<string>();
  const output: AgentWorkspaceAttentionItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.source_ref.type}:${item.source_ref.id}:${item.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

function activityItems(board: WorkBoard, automations: AgentWorkspaceAutomationItem[]): AgentWorkspaceActivityItem[] {
  const items: AgentWorkspaceActivityItem[] = [
    ...board.workers.map((worker): AgentWorkspaceActivityItem => ({
      id: `worker:${worker.worker_id}:${worker.status}`,
      kind: "worker",
      severity: worker.status === "failed" ? "error" : worker.blocked_reason ? "warning" : "info",
      title: `${worker.display_name} is ${worker.status}`,
      detail: worker.blocked_reason ?? worker.trajectory?.report ?? worker.objective,
      source_ref: { type: "worker", id: worker.worker_id, session_id: worker.session_id },
      timestamp: worker.updated_at
    })),
    ...board.checks.map((check): AgentWorkspaceActivityItem => ({
      id: `check:${check.session_id}:${check.value}`,
      kind: "check",
      severity: check.status === "failed" ? "error" : "info",
      title: check.status === "failed" ? "Check failed" : "Check recorded",
      detail: check.value,
      source_ref: { type: "check", id: check.value, session_id: check.session_id }
    })),
    ...board.artifacts.map((artifact): AgentWorkspaceActivityItem => ({
      id: `artifact:${artifact.session_id}:${artifact.artifact_id ?? artifact.path}`,
      kind: "artifact",
      severity: "info",
      title: `Artifact ${artifact.type}`,
      detail: artifact.summary ?? artifact.path,
      source_ref: { type: "artifact", id: artifact.artifact_id ?? artifact.path, session_id: artifact.session_id },
      timestamp: artifact.created_at
    })),
    ...board.next_actions.map((action): AgentWorkspaceActivityItem => ({
      id: `action:${action.source}:${action.id}`,
      kind: "work_action",
      severity: action.severity,
      title: "Next action",
      detail: action.action,
      source_ref: { type: workBoardSourceType(action.source), id: action.id }
    })),
    ...automations.map((automation): AgentWorkspaceActivityItem => ({
      id: `automation:${automation.id}`,
      kind: "automation",
      severity: automation.severity,
      title: automation.product_label,
      detail: automation.summary,
      source_ref: { type: "automation", id: automation.id },
      timestamp: automation.next_tick_at
    }))
  ];
  return items
    .filter((item) => !RAW_PROTOCOL_ACTIVITY.test(item.title) && !RAW_PROTOCOL_ACTIVITY.test(item.detail ?? ""))
    .sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""));
}

function skillState(skill: SkillRecord): AgentWorkspaceSkillState {
  return {
    name: skill.name,
    display_name: skill.displayName,
    description: skill.description,
    scope: skill.scope,
    trust: skill.trust,
    state: skill.shadowedBy
      ? "shadowed"
      : skill.trust === "disabled"
        ? "disabled"
        : skill.trust === "untrusted"
          ? "untrusted"
          : skill.trust === "trusted"
            ? "trusted"
            : "available",
    path: skill.path,
    shadowed_by: skill.shadowedBy,
    allowed_tools: [...skill.allowedTools],
    resource_paths: [...skill.resourcePaths],
    diagnostics: [...skill.diagnostics]
  };
}

function capabilityStates(
  capabilities: CapabilityDescriptor[],
  providers: CapabilityProviderSnapshot[]
): AgentWorkspaceCapabilityState[] {
  const providersById = new Map(providers.map((provider) => [provider.providerId, provider]));
  return capabilities.map((capability) => {
    const enabled = capability.trust !== "disabled" && capability.status !== "disabled";
    return {
      id: capability.id,
      kind: capability.kind,
      provider_id: capability.providerId,
      provider_title: providersById.get(capability.providerId)?.title,
      name: capability.name,
      title: capability.title,
      description: capability.description,
      trust: capability.trust,
      risk_class: capability.riskClass,
      enabled,
      hidden: !capability.modelVisible || !capability.userVisible,
      model_visible: capability.modelVisible,
      user_visible: capability.userVisible,
      read_only: capability.readOnly,
      state: capability.trust === "untrusted"
        ? "untrusted"
        : enabled
          ? capability.status ?? "available"
          : "disabled",
      diagnostics: capability.diagnostics ?? []
    };
  });
}

function readinessItems(input: {
  board: WorkBoard;
  approvals: ApprovalRecord[];
  skills: AgentWorkspaceSkillState[];
  capabilities: AgentWorkspaceCapabilityState[];
  providers: CapabilityProviderSnapshot[];
  automations: AgentWorkspaceAutomationItem[];
  workspacePath?: string;
}): AgentWorkspaceReadinessItem[] {
  const pendingApprovals = input.approvals.filter((approval) => approval.status === "pending").length;
  const providerErrors = input.providers.flatMap((provider) => provider.diagnostics).filter((diagnostic) => diagnostic.severity === "error").length;
  const providerWarnings = input.providers.flatMap((provider) => provider.diagnostics).filter((diagnostic) => diagnostic.severity === "warn").length;
  const automationErrors = input.automations.filter((automation) => automation.severity === "error").length;
  return [
    {
      id: "workspace",
      label: "Workspace",
      status: input.workspacePath ? "ready" : "unknown",
      severity: input.workspacePath ? "info" : "warning",
      summary: input.workspacePath ? `Workspace ${input.workspacePath}` : "No workspace path is attached to the projection.",
      next_action: input.workspacePath ? undefined : "Open the projection from a workspace-scoped runtime."
    },
    {
      id: "work_board",
      label: "Work board",
      status: input.board.summary.failed > 0 ? "blocked" : input.board.summary.blocked > 0 ? "attention" : "ready",
      severity: input.board.summary.failed > 0 ? "error" : input.board.summary.blocked > 0 ? "warning" : "info",
      summary: `sessions=${input.board.summary.sessions} workers=${input.board.summary.workers} blocked=${input.board.summary.blocked} failed=${input.board.summary.failed}`,
      next_action: input.board.summary.failed > 0 || input.board.summary.blocked > 0 ? "Resolve work board attention before release." : undefined,
      source_ref: { type: "work_board", id: input.board.scope.session_id ?? input.board.scope.kind }
    },
    {
      id: "approvals",
      label: "Approvals",
      status: pendingApprovals > 0 ? "attention" : "ready",
      severity: pendingApprovals > 0 ? "warning" : "info",
      summary: pendingApprovals > 0 ? `${pendingApprovals} pending approval(s)` : "No pending approvals.",
      next_action: pendingApprovals > 0 ? "Review pending approvals." : undefined
    },
    {
      id: "capability_providers",
      label: "Capability providers",
      status: providerErrors > 0 ? "blocked" : providerWarnings > 0 ? "attention" : "ready",
      severity: providerErrors > 0 ? "error" : providerWarnings > 0 ? "warning" : "info",
      summary: `${input.providers.length} provider(s), ${input.capabilities.length} capability surface item(s)`,
      next_action: providerErrors > 0 ? "Fix provider diagnostics, then refresh capabilities." : providerWarnings > 0 ? "Review provider diagnostics." : undefined
    },
    {
      id: "skills",
      label: "Skills",
      status: input.skills.some((skill) => skill.state === "untrusted" || skill.state === "disabled") ? "attention" : "ready",
      severity: input.skills.some((skill) => skill.state === "untrusted" || skill.state === "disabled") ? "warning" : "info",
      summary: `${input.skills.length} skill(s), ${input.skills.filter((skill) => skill.state === "trusted" || skill.state === "available").length} usable`,
      next_action: input.skills.some((skill) => skill.state === "untrusted" || skill.state === "disabled") ? "Review disabled or untrusted skills before activation." : undefined
    },
    {
      id: "automations",
      label: "Automations",
      status: automationErrors > 0 ? "blocked" : input.automations.some((automation) => automation.severity === "warning") ? "attention" : "ready",
      severity: automationErrors > 0 ? "error" : input.automations.some((automation) => automation.severity === "warning") ? "warning" : "info",
      summary: `${input.automations.length} automation surface item(s)`,
      next_action: automationErrors > 0 ? "Inspect failed Automations/Symphony status." : undefined
    },
    {
      id: "gateway_projection",
      label: "Gateway projection",
      status: "ready",
      severity: "info",
      summary: "Agent workspace projection is derived from runtime state and is read-only."
    }
  ];
}

function automationItems(status: SymphonyStatus | undefined, daemons: SymphonyDaemonRecord[]): AgentWorkspaceAutomationItem[] {
  const items: AgentWorkspaceAutomationItem[] = [];
  if (status) {
    const workflowOk = status.workflow.ok;
    const failed = status.totals.failed + status.totals.cancelled;
    items.push({
      id: "symphony:status",
      product_label: "Automations",
      internal_name: "symphony",
      kind: "status",
      status: workflowOk ? status.live_control.status : "degraded",
      severity: workflowOk ? failed > 0 ? "warning" : "info" : "error",
      summary: workflowOk
        ? `Automations sessions=${status.totals.sessions} running=${status.totals.running} retrying=${status.totals.retrying}`
        : `Automations workflow error: ${status.workflow.error.code}: ${status.workflow.error.message}`,
      route: "/v1/symphony/status",
      workflow_path: workflowOk ? status.workflow.workflow.path : undefined,
      last_error: workflowOk ? undefined : `${status.workflow.error.code}: ${status.workflow.error.message}`,
      controls: [
        {
          id: "open",
          label: "Open status",
          intent: "automation.inspect",
          method: "GET",
          route: "/v1/symphony/status",
          enabled: true
        },
        {
          id: "retry",
          label: "Run once",
          intent: "automation.run_once",
          method: "POST",
          route: "/v1/symphony/tick",
          enabled: workflowOk
        }
      ]
    });
  }

  for (const daemon of daemons) {
    items.push({
      id: `symphony:daemon:${daemon.daemon_id}`,
      product_label: "Automations",
      internal_name: "symphony",
      kind: "daemon",
      status: daemon.status,
      severity: daemonSeverity(daemon.status),
      summary: `Automation daemon ${daemon.status}; ticks=${daemon.tick_count}`,
      route: "/v1/symphony/daemon",
      workflow_path: daemon.workflow_path,
      tick_count: daemon.tick_count,
      next_tick_at: daemon.next_tick_at,
      last_error: daemon.last_error,
      controls: [
        {
          id: "open",
          label: "Open daemon",
          intent: "automation.daemon.inspect",
          method: "GET",
          route: `/v1/symphony/daemon?daemon_id=${encodeURIComponent(daemon.daemon_id)}`,
          enabled: true
        },
        {
          id: "stop",
          label: "Stop daemon",
          intent: "automation.daemon.stop",
          method: "POST",
          route: "/v1/symphony/daemon/stop",
          enabled: daemon.status === "running" || daemon.status === "stopping"
        }
      ]
    });
  }
  return items;
}

function daemonSeverity(status: SymphonyDaemonStatus): AgentWorkspaceSeverity {
  if (status === "failed") {
    return "error";
  }
  if (status === "stopping") {
    return "warning";
  }
  return "info";
}

function workBoardSourceType(source: WorkBoardNextAction["source"]): AgentWorkspaceSourceRef["type"] {
  switch (source) {
    case "worker":
      return "worker";
    case "claim":
      return "handoff";
    case "check":
      return "check";
    case "artifact":
      return "artifact";
    case "session":
      return "session";
    case "task":
      return "task";
    case "action":
      return "automation";
  }
}

function uniqueStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}
