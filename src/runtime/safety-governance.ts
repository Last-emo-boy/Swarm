import { createEnvelope } from "../protocol/envelope.js";
import type { RiskClass, SwarmEnvelope } from "../protocol/types.js";
import type { ToolApprovalRequest } from "../tools/types.js";

export const SAFETY_GOVERNANCE_VERSION = "swarm.safety_governance.v1";
export const APPROVAL_ENVELOPE_VERSION = "swarm.approval_envelope.v1";
export const DEFAULT_APPROVAL_GRANT_TTL_MS = 15 * 60 * 1000;

export type ApprovalGovernanceStatus = "requested" | "granted" | "denied" | "evidence";

export type ApprovalGovernanceEvidence = {
  schema_version: typeof SAFETY_GOVERNANCE_VERSION;
  approval_id: string;
  status: ApprovalGovernanceStatus;
  action: string;
  risk: ToolApprovalRequest["risk"];
  risk_class: RiskClass;
  actor_id: string;
  actor_binding: {
    actor_id: string;
    session_id?: string;
    task_id?: string;
  };
  scope: {
    kind: ToolApprovalRequest["risk"] | "capability";
    target: string;
    actions: string[];
    resources: string[];
    permission_name?: string;
    risk_class: RiskClass;
  };
  ttl_ms: number;
  expires_at: string;
  permission_mode?: string;
  permission_decision?: ToolApprovalRequest["permission_decision"];
  permission_name?: string;
  permission_rule?: string;
  decision_source: string;
  policy_evidence: string[];
  yolo_evidence?: string;
  created_at: string;
  source_envelope_id?: string;
};

export type ApprovalGrantValidation = {
  valid: boolean;
  reason: string;
  expires_at?: string;
  actor_id?: string;
  scope?: string;
};

export function buildApprovalGovernance(input: {
  request: ToolApprovalRequest;
  status: ApprovalGovernanceStatus;
  actor_id?: string;
  decision_source: string;
  now?: string;
  ttl_ms?: number;
  expires_at?: string;
  source_envelope_id?: string;
}): ApprovalGovernanceEvidence {
  const now = input.now ?? new Date().toISOString();
  const ttlMs = Math.max(1, input.ttl_ms ?? input.request.governance?.ttl_ms ?? DEFAULT_APPROVAL_GRANT_TTL_MS);
  const expiresAt = input.expires_at ??
    (input.ttl_ms !== undefined ? addMsIso(now, ttlMs) : input.request.governance?.expires_at ?? addMsIso(now, ttlMs));
  const actorId = input.actor_id ?? input.request.governance?.actor_id ?? "main_swarm";
  const policyEvidence = [
    `risk=${input.request.risk_class}/${input.request.risk}`,
    `decision_source=${input.decision_source}`,
    input.request.permission_mode ? `permission_mode=${input.request.permission_mode}` : undefined,
    input.request.permission_decision ? `permission_decision=${input.request.permission_decision}` : undefined,
    input.request.permission_rule ? `permission_rule=${input.request.permission_rule}` : undefined
  ].filter((item): item is string => Boolean(item));

  return {
    schema_version: SAFETY_GOVERNANCE_VERSION,
    approval_id: input.request.id,
    status: input.status,
    action: input.request.action,
    risk: input.request.risk,
    risk_class: input.request.risk_class,
    actor_id: actorId,
    actor_binding: {
      actor_id: actorId,
      session_id: input.request.session_id,
      task_id: input.request.task_id
    },
    scope: {
      kind: input.request.risk,
      target: input.request.target,
      actions: [input.request.action],
      resources: [input.request.target],
      permission_name: input.request.permission_name,
      risk_class: input.request.risk_class
    },
    ttl_ms: ttlMs,
    expires_at: expiresAt,
    permission_mode: input.request.permission_mode,
    permission_decision: input.request.permission_decision,
    permission_name: input.request.permission_name,
    permission_rule: input.request.permission_rule,
    decision_source: input.decision_source,
    policy_evidence: policyEvidence,
    yolo_evidence: input.request.permission_mode === "yolo"
      ? "Yolo permission mode allowed the action, but the approval lattice still records actor, scope, ttl, and policy evidence."
      : undefined,
    created_at: now,
    source_envelope_id: input.source_envelope_id
  };
}

export function attachApprovalGovernance(
  request: ToolApprovalRequest,
  input: Omit<Parameters<typeof buildApprovalGovernance>[0], "request">
): ToolApprovalRequest {
  request.governance = buildApprovalGovernance({ request, ...input });
  return request;
}

export function approvalEnvelopeForRequest(
  request: ToolApprovalRequest,
  status: "pending" | "approved" | "denied",
  options: {
    actor_id?: string;
    actor_role?: string;
    decision_source?: string;
    swarm_id?: string;
    correlation_id?: string;
    reply_to?: string;
    now?: string;
  } = {}
): SwarmEnvelope<Record<string, unknown>> | undefined {
  if (!request.session_id) {
    return undefined;
  }
  const governanceStatus = status === "pending" ? "requested" : status === "approved" ? "granted" : "denied";
  const governance = buildApprovalGovernance({
    request,
    status: governanceStatus,
    actor_id: options.actor_id ?? request.governance?.actor_id,
    decision_source: options.decision_source ?? `approval.${status}`,
    now: options.now,
    ttl_ms: request.governance?.ttl_ms,
    expires_at: request.governance?.expires_at
  });
  const type = governanceStatus === "requested"
    ? "approval.request"
    : governanceStatus === "denied"
      ? "approval.deny"
      : "approval.grant";

  return createEnvelope<Record<string, unknown>>({
    swarm_id: options.swarm_id ?? `swarm_${request.session_id}`,
    session_id: request.session_id,
    task_id: request.task_id ?? request.id,
    from: { agent_id: governance.actor_id, role: options.actor_role ?? (status === "pending" ? "policy" : "operator") },
    to: status === "pending" ? { agent_id: "local_user", role: "operator" } : { agent_id: "main_swarm", role: "coordinator" },
    type,
    intent: `approval.${governanceStatus}`,
    correlation_id: options.correlation_id ?? request.id,
    reply_to: options.reply_to,
    idempotency_key: `${request.session_id}:${request.id}:${type}`,
    ttl_ms: governance.ttl_ms,
    priority: request.risk_class === "r4" ? "critical" : "high",
    auth: {
      actor: governance.actor_id,
      scopes: ["approval.governance", `approval.${governanceStatus}`, ...governance.scope.actions]
    },
    payload: {
      schema_version: APPROVAL_ENVELOPE_VERSION,
      approval_id: request.id,
      status: governanceStatus,
      action: request.action,
      risk: request.risk,
      risk_class: request.risk_class,
      target: request.target,
      summary: request.summary,
      permission_mode: request.permission_mode,
      permission_name: request.permission_name,
      permission_rule: request.permission_rule,
      governance
    }
  });
}

export function approvalEnvelopeForGovernance(
  governance: ApprovalGovernanceEvidence,
  options: {
    session_id?: string;
    task_id?: string;
    swarm_id?: string;
    correlation_id?: string;
  } = {}
): SwarmEnvelope<Record<string, unknown>> | undefined {
  const sessionId = options.session_id ?? governance.actor_binding.session_id;
  if (!sessionId) {
    return undefined;
  }
  const type = governance.status === "requested"
    ? "approval.request"
    : governance.status === "denied"
      ? "approval.deny"
      : "approval.grant";
  return createEnvelope<Record<string, unknown>>({
    swarm_id: options.swarm_id ?? `swarm_${sessionId}`,
    session_id: sessionId,
    task_id: options.task_id ?? governance.actor_binding.task_id ?? governance.approval_id,
    from: { agent_id: governance.actor_id, role: governance.status === "requested" ? "policy" : "operator" },
    to: { agent_id: "main_swarm", role: "coordinator" },
    type,
    intent: `approval.${governance.status}`,
    correlation_id: options.correlation_id ?? governance.approval_id,
    idempotency_key: `${sessionId}:${governance.approval_id}:${type}`,
    ttl_ms: governance.ttl_ms,
    priority: governance.risk_class === "r4" ? "critical" : "high",
    auth: {
      actor: governance.actor_id,
      scopes: ["approval.governance", `approval.${governance.status}`, ...governance.scope.actions]
    },
    payload: {
      schema_version: APPROVAL_ENVELOPE_VERSION,
      approval_id: governance.approval_id,
      status: governance.status,
      action: governance.action,
      risk: governance.risk,
      risk_class: governance.risk_class,
      target: governance.scope.target,
      governance
    }
  });
}

export function isApprovalGrantValid(
  governance: ApprovalGovernanceEvidence | undefined,
  input: {
    actor_id: string;
    session_id?: string;
    task_id?: string;
    action: string;
    target?: string;
    now?: string;
  }
): ApprovalGrantValidation {
  if (!governance || governance.status !== "granted") {
    return { valid: false, reason: "No granted approval evidence is available." };
  }
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const expiresMs = Date.parse(governance.expires_at);
  if (Number.isFinite(expiresMs) && nowMs >= expiresMs) {
    return {
      valid: false,
      reason: `Approval grant expired at ${governance.expires_at}.`,
      expires_at: governance.expires_at,
      actor_id: governance.actor_binding.actor_id,
      scope: governance.scope.target
    };
  }
  if (governance.actor_binding.actor_id !== input.actor_id) {
    return { valid: false, reason: `Approval grant is bound to actor ${governance.actor_binding.actor_id}.` };
  }
  if (governance.actor_binding.session_id && input.session_id && governance.actor_binding.session_id !== input.session_id) {
    return { valid: false, reason: `Approval grant is bound to session ${governance.actor_binding.session_id}.` };
  }
  if (governance.actor_binding.task_id && input.task_id && governance.actor_binding.task_id !== input.task_id) {
    return { valid: false, reason: `Approval grant is bound to task ${governance.actor_binding.task_id}.` };
  }
  if (!governance.scope.actions.includes(input.action)) {
    return { valid: false, reason: `Approval grant scope does not include action ${input.action}.` };
  }
  if (input.target && !governance.scope.resources.includes(input.target) && governance.scope.target !== input.target) {
    return { valid: false, reason: `Approval grant scope does not include target ${input.target}.` };
  }
  return {
    valid: true,
    reason: "Approval grant is valid for actor, scope, and ttl.",
    expires_at: governance.expires_at,
    actor_id: governance.actor_binding.actor_id,
    scope: governance.scope.target
  };
}

export function shouldRecordGovernanceEvidence(request: ToolApprovalRequest): boolean {
  return request.permission_mode === "yolo" ||
    request.permission_mode === "full-auto" ||
    request.risk_class === "r3" ||
    request.risk_class === "r4";
}

function addMsIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
