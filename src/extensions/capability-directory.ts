import type { RiskClass } from "../protocol/types.js";
import type { AgentActorRecord } from "../storage/agent-actor-store.js";
import { policyFromActor, type AgentCapabilityLease } from "../runtime/agent-autonomy-policy.js";
import type { CapabilityParticipantProjection, CapabilityParticipantSnapshot } from "./capability-participants.js";
import type { CapabilityDescriptor } from "./types.js";

export type CapabilityDirectoryParticipantKind = "actor" | "lsp" | "mcp" | "skill";
export type CapabilityDirectoryHealthState =
  | "available"
  | "busy"
  | "blocked"
  | "degraded"
  | "offline"
  | "unavailable";

export type CapabilityTrustBoundary = "local_actor" | "local_tool" | "workspace" | "project" | "user" | "external" | "disabled" | "unknown";
export type CapabilityCostClass = "free" | "low" | "medium" | "high" | "unknown";
export type CapabilityCacheProfile = "stable" | "dynamic" | "mixed" | "none" | "unknown";

export type CapabilityLeaseProjection = {
  capability: string;
  status: "active" | "expired" | "revoked";
  source_envelope_id?: string;
  expires_at?: string;
  scope?: string[];
};

export type CapabilityDirectoryCard = {
  schema_version: "swarm.capability_card.v1";
  participant_id: string;
  kind: CapabilityDirectoryParticipantKind;
  label: string;
  provider: string;
  capability_ids: string[];
  tools: string[];
  languages: string[];
  skills: string[];
  risk_level: RiskClass;
  cost_class: CapabilityCostClass;
  cache_profile: CapabilityCacheProfile;
  trust_boundary: CapabilityTrustBoundary;
  health: {
    state: CapabilityDirectoryHealthState;
    available: boolean;
    reason?: string;
    recoverySuggestion?: string;
  };
  leases: {
    required: boolean;
    active: CapabilityLeaseProjection[];
    expired: CapabilityLeaseProjection[];
    revoked: CapabilityLeaseProjection[];
  };
  evidence: Record<string, unknown>;
};

export type CapabilityDirectorySnapshot = {
  schema_version: "swarm.capability_directory.v1";
  generated_at: string;
  cards: CapabilityDirectoryCard[];
  summary: {
    total: number;
    available: number;
    unavailable: number;
    by_kind: Record<CapabilityDirectoryParticipantKind, number>;
  };
};

export type CapabilityCandidateEvaluation = {
  participant_id?: string;
  available: boolean;
  matched_capabilities: string[];
  missing_capabilities: string[];
  reasons: string[];
  recoverySuggestion?: string;
  card?: CapabilityDirectoryCard;
};

export function buildCapabilityDirectory(input: {
  actors?: AgentActorRecord[];
  capabilities?: CapabilityDescriptor[];
  capabilityParticipants?: CapabilityParticipantSnapshot | CapabilityParticipantProjection[];
  generatedAt?: string;
  now?: string;
}): CapabilityDirectorySnapshot {
  const now = input.now ?? input.generatedAt ?? new Date().toISOString();
  const capabilityParticipants = Array.isArray(input.capabilityParticipants)
    ? input.capabilityParticipants
    : input.capabilityParticipants?.participants ?? [];
  const cards = [
    ...(input.actors ?? []).map((actor) => buildActorCapabilityCard(actor, { now })),
    ...capabilityParticipants.map((participant) => capabilityParticipantCard(participant, input.capabilities ?? [], now))
  ].sort((left, right) => left.participant_id.localeCompare(right.participant_id));
  return {
    schema_version: "swarm.capability_directory.v1",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    cards,
    summary: summarize(cards)
  };
}

export function buildActorCapabilityCard(
  actor: AgentActorRecord,
  options: { now?: string } = {}
): CapabilityDirectoryCard {
  const now = options.now ?? new Date().toISOString();
  const policy = policyFromActor(actor);
  const leases = classifyLeases(policy?.capability_leases ?? [], now);
  const capabilityIds = uniqueStrings([
    ...actor.capabilities,
    ...leases.active.map((lease) => lease.capability)
  ]);
  const capacityBlocked = actor.status === "busy" && actor.load.running_tasks >= actor.load.max_tasks;
  const blockedReason = stringField(actor.metadata.blocked_reason) ?? stringField(actor.metadata.capability_unavailable_reason);
  const state = actor.status === "offline" || actor.heartbeat_state === "offline"
    ? "offline"
    : actor.heartbeat_state === "blocked" || blockedReason
      ? "blocked"
      : actor.status === "degraded"
        ? "degraded"
        : capacityBlocked
          ? "busy"
          : "available";
  const reason = state === "offline"
    ? "Actor is offline."
    : state === "blocked"
      ? blockedReason ?? "Actor is blocked."
      : state === "degraded"
        ? "Actor is degraded."
        : state === "busy"
          ? "Actor has no free task capacity."
          : leases.expired.length > 0 && capabilityIds.length === 0
            ? "Actor has expired capability leases and no declared fallback capability."
            : undefined;
  return {
    schema_version: "swarm.capability_card.v1",
    participant_id: actor.actor_id,
    kind: "actor",
    label: actor.name,
    provider: "agent-registry",
    capability_ids: capabilityIds,
    tools: stringArray(actor.metadata.tools ?? actor.metadata.allowed_tools),
    languages: stringArray(actor.metadata.languages),
    skills: stringArray(actor.metadata.skills),
    risk_level: riskClassField(actor.metadata.risk_level ?? actor.metadata.riskClass) ?? "r1",
    cost_class: costClassField(actor.metadata.cost_class ?? actor.metadata.costClass) ?? "unknown",
    cache_profile: cacheProfileField(actor.metadata.cache_profile ?? actor.metadata.cacheProfile) ?? "mixed",
    trust_boundary: "local_actor",
    health: {
      state,
      available: state === "available",
      reason,
      recoverySuggestion: reason ? "Wait for capacity, refresh the actor heartbeat, or grant a valid capability lease before assigning work." : undefined
    },
    leases: {
      required: Boolean(policy?.capability_leases?.length),
      active: leases.active,
      expired: leases.expired,
      revoked: leases.revoked
    },
    evidence: {
      actor_id: actor.actor_id,
      kind: actor.kind,
      role: actor.role,
      status: actor.status,
      heartbeat_state: actor.heartbeat_state,
      running_tasks: actor.load.running_tasks,
      max_tasks: actor.load.max_tasks,
      autonomy_level: policy?.level ?? "legacy",
      current_task_id: actor.current_task_id,
      current_session_id: actor.current_session_id
    }
  };
}

export function evaluateCapabilityCandidate(input: {
  card?: CapabilityDirectoryCard;
  requestedCapability?: string;
  requiredCapabilities?: string[];
  leaseSourceEnvelopeId?: string;
  now?: string;
}): CapabilityCandidateEvaluation {
  const required = uniqueStrings([
    ...(input.requiredCapabilities ?? []),
    input.requestedCapability
  ]);
  if (!input.card) {
    return {
      available: false,
      matched_capabilities: [],
      missing_capabilities: required,
      reasons: ["No capability directory card is registered for this participant."]
    };
  }
  const allCapabilities = new Set([
    ...input.card.capability_ids,
    ...input.card.leases.active.map((lease) => lease.capability)
  ]);
  const matched = required.filter((capability) => allCapabilities.has(capability));
  const missing = required.filter((capability) => !allCapabilities.has(capability));
  const reasons: string[] = [];
  if (!input.card.health.available) {
    reasons.push(input.card.health.reason ?? `Participant ${input.card.participant_id} is ${input.card.health.state}.`);
  }
  if (missing.length > 0) {
    reasons.push(`Missing required capabilities: ${missing.join(", ")}.`);
  }
  if (input.leaseSourceEnvelopeId) {
    const activeLease = input.card.leases.active.find((lease) => lease.source_envelope_id === input.leaseSourceEnvelopeId);
    if (!activeLease) {
      const expired = input.card.leases.expired.find((lease) => lease.source_envelope_id === input.leaseSourceEnvelopeId);
      const revoked = input.card.leases.revoked.find((lease) => lease.source_envelope_id === input.leaseSourceEnvelopeId);
      reasons.push(expired
        ? `Capability lease ${input.leaseSourceEnvelopeId} expired at ${expired.expires_at}.`
        : revoked
          ? `Capability lease ${input.leaseSourceEnvelopeId} is revoked.`
          : `Capability lease ${input.leaseSourceEnvelopeId} is not active for this participant.`);
    }
  }
  return {
    participant_id: input.card.participant_id,
    available: reasons.length === 0,
    matched_capabilities: matched,
    missing_capabilities: missing,
    reasons,
    recoverySuggestion: reasons.length > 0
      ? input.card.health.recoverySuggestion ?? "Choose another participant or refresh capability leases before assigning work."
      : undefined,
    card: input.card
  };
}

function capabilityParticipantCard(
  participant: CapabilityParticipantProjection,
  capabilities: CapabilityDescriptor[],
  now: string
): CapabilityDirectoryCard {
  const descriptors = capabilities.filter((capability) => participant.capability_ids.includes(capability.id));
  const available = participant.state === "available" || participant.state === "degraded";
  return {
    schema_version: "swarm.capability_card.v1",
    participant_id: participant.participant_id,
    kind: participant.kind,
    label: participant.label,
    provider: participant.lease.capability,
    capability_ids: participant.capability_ids,
    tools: descriptors.filter((capability) => capability.kind.endsWith("_tool")).map((capability) => capability.name).sort(),
    languages: uniqueStrings(descriptors.flatMap((capability) => stringArray(capability.metadata?.languages))),
    skills: participant.kind === "skill" ? [participant.label.replace(/^Skill\s+/u, "")] : [],
    risk_level: maxRisk(descriptors.map((capability) => capability.riskClass)),
    cost_class: participant.kind === "mcp" ? "medium" : "free",
    cache_profile: participant.kind === "skill" ? "stable" : participant.kind === "mcp" ? "dynamic" : "mixed",
    trust_boundary: trustBoundary(participant),
    health: {
      state: available ? "available" : "unavailable",
      available,
      reason: available ? undefined : unavailableReason(participant),
      recoverySuggestion: participant.recoverySuggestion
    },
    leases: {
      required: participant.lease.required,
      active: participant.lease.required ? [{
        capability: participant.lease.capability,
        status: "active",
        source_envelope_id: stringField(participant.evidence.source_envelope_id)
      }] : [],
      expired: [],
      revoked: []
    },
    evidence: {
      ...participant.evidence,
      participant_state: participant.state,
      participant_trust: participant.trust,
      generated_at: now
    }
  };
}

function classifyLeases(leases: AgentCapabilityLease[], now: string): {
  active: CapabilityLeaseProjection[];
  expired: CapabilityLeaseProjection[];
  revoked: CapabilityLeaseProjection[];
} {
  const output = {
    active: [] as CapabilityLeaseProjection[],
    expired: [] as CapabilityLeaseProjection[],
    revoked: [] as CapabilityLeaseProjection[]
  };
  for (const lease of leases) {
    const projection: CapabilityLeaseProjection = {
      capability: lease.capability,
      status: "active",
      source_envelope_id: lease.source_envelope_id,
      expires_at: lease.expires_at,
      scope: lease.scope
    };
    if (lease.status === "revoked") {
      output.revoked.push({ ...projection, status: "revoked" });
    } else if (lease.expires_at && Date.parse(lease.expires_at) <= Date.parse(now)) {
      output.expired.push({ ...projection, status: "expired" });
    } else {
      output.active.push(projection);
    }
  }
  return output;
}

function summarize(cards: CapabilityDirectoryCard[]): CapabilityDirectorySnapshot["summary"] {
  const byKind = { actor: 0, lsp: 0, mcp: 0, skill: 0 };
  for (const card of cards) {
    byKind[card.kind] += 1;
  }
  return {
    total: cards.length,
    available: cards.filter((card) => card.health.available).length,
    unavailable: cards.filter((card) => !card.health.available).length,
    by_kind: byKind
  };
}

function unavailableReason(participant: CapabilityParticipantProjection): string {
  return participant.recoverySuggestion ??
    `${participant.label} is ${participant.state}; capability ${participant.lease.capability} is unavailable.`;
}

function trustBoundary(participant: CapabilityParticipantProjection): CapabilityTrustBoundary {
  if (participant.trust === "disabled") return "disabled";
  if (participant.kind === "mcp") return "external";
  if (participant.kind === "skill") return "workspace";
  if (participant.kind === "lsp") return "local_tool";
  return "unknown";
}

function maxRisk(values: RiskClass[]): RiskClass {
  const order: RiskClass[] = ["r0", "r1", "r2", "r3", "r4"];
  return values.reduce<RiskClass>((max, value) => order.indexOf(value) > order.indexOf(max) ? value : max, "r0");
}

function riskClassField(value: unknown): RiskClass | undefined {
  return value === "r0" || value === "r1" || value === "r2" || value === "r3" || value === "r4" ? value : undefined;
}

function costClassField(value: unknown): CapabilityCostClass | undefined {
  return value === "free" || value === "low" || value === "medium" || value === "high" || value === "unknown" ? value : undefined;
}

function cacheProfileField(value: unknown): CapabilityCacheProfile | undefined {
  return value === "stable" || value === "dynamic" || value === "mixed" || value === "none" || value === "unknown" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).sort()
    : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].sort();
}
