import type { SwarmEnvelope, SwarmMessageType } from "../protocol/types.js";
import type { AgentActorRecord } from "../storage/agent-actor-store.js";

export type AgentAutonomyLevel = "observe" | "propose" | "claim" | "execute" | "approve_gated" | "admin";

export type AgentCapabilityLease = {
  capability: string;
  actions?: SwarmMessageType[];
  scope?: string[];
  status?: "active" | "revoked";
  expires_at?: string;
  source_envelope_id?: string;
};

export type AgentAutonomyPolicy = {
  level: AgentAutonomyLevel;
  allowed_envelope_types?: SwarmMessageType[];
  denied_envelope_types?: SwarmMessageType[];
  capability_leases?: AgentCapabilityLease[];
};

export type AgentAutonomyDecision = {
  decision: "allow" | "deny";
  actor_id?: string;
  required_level: AgentAutonomyLevel;
  actor_level: AgentAutonomyLevel;
  reason: string;
  recoverySuggestion?: string;
  capability?: string;
  lease_source_envelope_id?: string;
};

const LEVEL_RANK: Record<AgentAutonomyLevel, number> = {
  observe: 0,
  propose: 1,
  claim: 2,
  execute: 3,
  approve_gated: 4,
  admin: 5
};

export function policyFromActor(actor: AgentActorRecord | undefined): AgentAutonomyPolicy | undefined {
  const value = actor?.metadata.autonomy_policy;
  if (!isRecord(value)) {
    return undefined;
  }
  const level = typeof value.level === "string" && value.level in LEVEL_RANK
    ? value.level as AgentAutonomyLevel
    : undefined;
  if (!level) {
    return undefined;
  }
  return {
    level,
    allowed_envelope_types: swarmMessageList(value.allowed_envelope_types),
    denied_envelope_types: swarmMessageList(value.denied_envelope_types),
    capability_leases: capabilityLeases(value.capability_leases)
  };
}

export function decideEnvelopeAutonomy(
  envelope: SwarmEnvelope,
  actor: AgentActorRecord | undefined,
  options: { now?: string } = {}
): AgentAutonomyDecision {
  const required = requiredLevelForEnvelope(envelope.type);
  const policy = policyFromActor(actor);
  const actorLevel = policy?.level ?? "admin";
  const actorId = actor?.actor_id ?? envelope.from.agent_id;
  if (!policy) {
    return {
      decision: "allow",
      actor_id: actorId,
      required_level: required,
      actor_level: actorLevel,
      reason: "No autonomy policy is attached; legacy compatibility allows the envelope."
    };
  }
  if (policy.denied_envelope_types?.includes(envelope.type)) {
    return denied(actorId, required, actorLevel, `Envelope type ${envelope.type} is denied by actor autonomy policy.`);
  }
  if (policy.allowed_envelope_types && !policy.allowed_envelope_types.includes(envelope.type)) {
    return denied(actorId, required, actorLevel, `Envelope type ${envelope.type} is not in the actor allowlist.`);
  }
  if (LEVEL_RANK[actorLevel] < LEVEL_RANK[required]) {
    return denied(actorId, required, actorLevel, `Envelope type ${envelope.type} requires ${required} autonomy, actor has ${actorLevel}.`);
  }
  const capability = envelope.from.capability ?? capabilityFromPayload(envelope.payload);
  if (capability && !actor?.capabilities.includes(capability)) {
    const lease = activeCapabilityLease(policy, capability, envelope.type, options.now);
    if (!lease) {
      return denied(
        actorId,
        required,
        actorLevel,
        `Actor lacks capability lease for ${capability}.`,
        capability
      );
    }
    return {
      decision: "allow",
      actor_id: actorId,
      required_level: required,
      actor_level: actorLevel,
      reason: `Allowed by active capability lease for ${capability}.`,
      capability,
      lease_source_envelope_id: lease.source_envelope_id
    };
  }
  return {
    decision: "allow",
    actor_id: actorId,
    required_level: required,
    actor_level: actorLevel,
    reason: `Allowed by ${actorLevel} autonomy policy.`
  };
}

function requiredLevelForEnvelope(type: SwarmMessageType): AgentAutonomyLevel {
  if ([
    "ack",
    "swarm.heartbeat",
    "agent.update_status",
    "agent.capability_query",
    "agent.capability_response",
    "approval.request",
    "user.message",
    "blackboard.read",
    "blackboard.subscribe",
    "blackboard.notification"
  ].includes(type)) {
    return "observe";
  }
  if ([
    "bid.submit",
    "blackboard.write",
    "blackboard.update",
    "blackboard.proposal",
    "blackboard.review",
    "blackboard.decision",
    "blackboard.result",
    "negotiation.propose",
    "negotiation.counter",
    "negotiation.decline",
    "negotiation.escalate",
    "squad.join",
    "squad.leave",
    "review.result",
    "consensus.vote"
  ].includes(type)) {
    return "propose";
  }
  if ([
    "blackboard.lock",
    "blackboard.unlock",
    "blackboard.claim",
    "blackboard.release",
    "handoff.renew",
    "negotiation.accept",
    "negotiation.delegate",
    "squad.role.assign"
  ].includes(type)) {
    return "claim";
  }
  if (type === "approval.grant" || type === "approval.deny") {
    return "approve_gated";
  }
  if (type.startsWith("task.") || type.startsWith("handoff.")) {
    return "execute";
  }
  if (["swarm.shutdown", "task.create", "bid.award", "consensus.result", "agent.register", "squad.create", "squad.dissolve"].includes(type)) {
    return "admin";
  }
  return "observe";
}

function activeCapabilityLease(
  policy: AgentAutonomyPolicy,
  capability: string,
  type: SwarmMessageType,
  now = new Date().toISOString()
): AgentCapabilityLease | undefined {
  return policy.capability_leases?.find((lease) => {
    if (lease.capability !== capability || lease.status === "revoked") {
      return false;
    }
    if (lease.actions && !lease.actions.includes(type)) {
      return false;
    }
    if (lease.expires_at && Date.parse(lease.expires_at) <= Date.parse(now)) {
      return false;
    }
    return true;
  });
}

function denied(
  actorId: string | undefined,
  required: AgentAutonomyLevel,
  actorLevel: AgentAutonomyLevel,
  reason: string,
  capability?: string
): AgentAutonomyDecision {
  return {
    decision: "deny",
    actor_id: actorId,
    required_level: required,
    actor_level: actorLevel,
    reason,
    capability,
    recoverySuggestion: "Adjust the actor autonomy policy or grant a scoped capability lease before retrying the envelope."
  };
}

function capabilityFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const value = payload.capability ?? payload.required_capability;
  return typeof value === "string" ? value : undefined;
}

function swarmMessageList(value: unknown): SwarmMessageType[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is SwarmMessageType => typeof item === "string");
}

function capabilityLeases(value: unknown): AgentCapabilityLease[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isRecord).map((item) => ({
    capability: typeof item.capability === "string" ? item.capability : "",
    actions: swarmMessageList(item.actions),
    scope: Array.isArray(item.scope) ? item.scope.filter((entry): entry is string => typeof entry === "string") : undefined,
    status: item.status === "revoked" ? "revoked" as const : "active" as const,
    expires_at: typeof item.expires_at === "string" ? item.expires_at : undefined,
    source_envelope_id: typeof item.source_envelope_id === "string" ? item.source_envelope_id : undefined
  })).filter((lease) => lease.capability.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
