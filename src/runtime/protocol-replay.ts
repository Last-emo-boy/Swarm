import type {
  AgentAddress,
  BlackboardDecisionOutcome,
  BlackboardDecisionPolicy,
  BlackboardDecisionPolicyStatus,
  BlackboardDecisionStatus,
  BlackboardDecisionVote,
  BlackboardEntry,
  HandoffProtocolStatus,
  SwarmEnvelope
} from "../protocol/types.js";
import type { AgentActorRecord } from "../storage/agent-actor-store.js";
import type { EnvelopeDeliveryRecord, EnvelopeDeliveryStatus } from "../storage/envelope-delivery-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { SymphonyClaimRecord } from "../storage/symphony-claim-store.js";
import type { WorkerRecord, WorkerStatus } from "../storage/worker-state-store.js";

export const SWARM_PROTOCOL_REPLAY_VERSION = "swarm.protocol_replay.v1";

export type ProtocolReplayTaskStatus =
  | "assigned"
  | "accepted"
  | "running"
  | "checkpointed"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled"
  | "superseded"
  | "unknown";

export type ProtocolReplayWorker = {
  worker_id: string;
  task_id: string;
  owner_agent_id?: string;
  assigned_by?: string;
  capability?: string;
  objective?: string;
  status: ProtocolReplayTaskStatus;
  accepted_at?: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  rejected_at?: string;
  last_progress?: string;
  checkpoints: ProtocolReplayCheckpoint[];
  result?: ProtocolReplayResult;
  error?: string;
  source_envelope_ids: string[];
};

export type ProtocolReplayHandoff = {
  handoff_id: string;
  worker_id?: string;
  task_id?: string;
  owner_agent_id?: string;
  source_agent?: string;
  target_agent_spec_id?: string;
  reason?: string;
  status: "active" | "returned" | "taken_back" | "failed" | "superseded" | "unknown";
  protocol_status?: HandoffProtocolStatus;
  requester_agent_id?: string;
  scope?: string[];
  lease_ttl_ms?: number;
  lease_expires_at?: string;
  deadline_at?: string;
  accepted_at?: string;
  last_checkpoint?: unknown;
  return_contract?: unknown;
  conflict_reason?: string;
  request_envelope_id?: string;
  accept_envelope_id?: string;
  return_envelope_id?: string;
  take_back_envelope_id?: string;
  last_envelope_id?: string;
  result?: string;
  source_envelope_ids: string[];
};

export type ProtocolReplaySymphonyClaim = {
  claim_key: string;
  work_item_key?: string;
  workflow_path?: string;
  session_id?: string;
  owner_id?: string;
  status: string;
  result?: string;
  source_envelope_ids: string[];
};

export type ProtocolReplayNegotiationAction = "propose" | "counter" | "accept" | "decline" | "delegate" | "escalate";
export type ProtocolReplayNegotiationStatus =
  | "proposed"
  | "countered"
  | "accepted"
  | "declined"
  | "delegated"
  | "escalated"
  | "unknown";

export type ProtocolReplayNegotiationEvent = {
  envelope_id: string;
  action: ProtocolReplayNegotiationAction;
  at: string;
  from?: string;
  to?: string;
  reason?: string;
  suggested_alternative?: unknown;
  terms?: unknown;
};

export type ProtocolReplayNegotiation = {
  negotiation_id: string;
  task_id?: string;
  status: ProtocolReplayNegotiationStatus;
  opened_by?: string;
  current_owner?: string;
  accepted_by?: string;
  declined_by?: string;
  escalated_to?: string;
  delegated_to?: string;
  reason?: string;
  suggested_alternative?: unknown;
  contract?: unknown;
  events: ProtocolReplayNegotiationEvent[];
  source_envelope_ids: string[];
};

export type ProtocolReplaySquadAction = "create" | "join" | "leave" | "role.assign" | "dissolve";
export type ProtocolReplaySquadStatus = "active" | "dissolved" | "unknown";

export type ProtocolReplaySquadMember = {
  agent_id: string;
  role?: string;
  capabilities: string[];
  status: "active" | "left";
  joined_at?: string;
  left_at?: string;
  source_envelope_ids: string[];
};

export type ProtocolReplaySquadEvent = {
  envelope_id: string;
  action: ProtocolReplaySquadAction;
  at: string;
  from?: string;
  member_id?: string;
  role?: string;
  required_capabilities: string[];
  reason?: string;
};

export type ProtocolReplaySquad = {
  squad_id: string;
  task_id?: string;
  status: ProtocolReplaySquadStatus;
  leader_agent_id?: string;
  objective?: string;
  risk_level?: string;
  cache_profile?: unknown;
  ownership_lease?: unknown;
  review_gate?: unknown;
  final_result_aggregator?: unknown;
  candidates?: unknown[];
  members: ProtocolReplaySquadMember[];
  events: ProtocolReplaySquadEvent[];
  source_envelope_ids: string[];
};

export type ProtocolReplayCheckpoint = {
  envelope_id: string;
  at: string;
  summary?: string;
  artifact?: string;
  payload: unknown;
};

export type ProtocolReplayResult = {
  envelope_id: string;
  at: string;
  status?: string;
  summary?: string;
  content?: string;
  output_ref?: string;
  payload: unknown;
};

export type ProtocolReplayActor = {
  actor_id: string;
  kind: AgentActorRecord["kind"];
  status: AgentActorRecord["status"];
  heartbeat_state: AgentActorRecord["heartbeat_state"];
  current_task_id?: string;
  current_worker_id?: string;
  current_session_id?: string;
};

export type ProtocolReplayBlackboardReview = {
  entry_id: string;
  proposal_id: string;
  reviewer?: string;
  verdict?: string;
  created_at: string;
  source_envelope_ids: string[];
};

export type ProtocolReplayBlackboardDecision = {
  entry_id: string;
  proposal_id: string;
  status: BlackboardDecisionStatus;
  decider?: string;
  policy?: BlackboardDecisionPolicy;
  policy_status?: BlackboardDecisionPolicyStatus;
  waiting_for?: string[];
  votes?: BlackboardDecisionVote[];
  outcome?: BlackboardDecisionOutcome;
  supersedes_decision_id?: string;
  created_at: string;
  source_envelope_ids: string[];
};

export type ProtocolReplayBlackboardProposal = {
  proposal_id: string;
  entry_id: string;
  key: string;
  task_id?: string;
  proposed_by?: string;
  claim_key?: string;
  target_key?: string;
  status: BlackboardDecisionStatus | "unknown";
  policy?: BlackboardDecisionPolicy;
  policy_status?: BlackboardDecisionPolicyStatus;
  waiting_for?: string[];
  votes?: BlackboardDecisionVote[];
  outcome?: BlackboardDecisionOutcome;
  supersedes_decision_id?: string;
  created_at: string;
  source_envelope_ids: string[];
  reviews: ProtocolReplayBlackboardReview[];
  decisions: ProtocolReplayBlackboardDecision[];
  result_entry_ids: string[];
};

export type ProtocolReplayBlackboard = {
  total: number;
  claims: number;
  proposals: number;
  decisions: number;
  results: number;
  evidence: number;
  entries: Array<{
    entry_id: string;
    key: string;
    type: BlackboardEntry["type"];
    task_id?: string;
    created_by?: string;
    tags: string[];
  }>;
  decision_history: ProtocolReplayBlackboardDecision[];
  unresolved_proposals: ProtocolReplayBlackboardProposal[];
};

export type ProtocolReplayDeliverySummary = {
  total: number;
  by_status: Partial<Record<EnvelopeDeliveryStatus, number>>;
  queued: number;
  delivered: number;
  acked: number;
  failed: number;
  expired: number;
  superseded: number;
};

export type ProtocolReplaySnapshot = {
  schema_version: typeof SWARM_PROTOCOL_REPLAY_VERSION;
  generated_at: string;
  session_id?: string;
  workers: ProtocolReplayWorker[];
  handoffs: ProtocolReplayHandoff[];
  symphony: ProtocolReplaySymphonyClaim[];
  negotiations: ProtocolReplayNegotiation[];
  squads: ProtocolReplaySquad[];
  actors: ProtocolReplayActor[];
  blackboard: ProtocolReplayBlackboard;
  deliveries: ProtocolReplayDeliverySummary;
  envelope_count: number;
};

export type ProtocolReplaySnapshotCounts = {
  envelopes: number;
  workers: number;
  handoffs: number;
  symphony: number;
  negotiations: number;
  squads: number;
  actors: number;
  blackboard: number;
  deliveries: number;
};

export type ProtocolReplayDiffIssue = {
  severity: "warning" | "error";
  source: "snapshot" | "worker" | "handoff" | "symphony" | "negotiation" | "squad" | "actor" | "blackboard" | "delivery";
  path: string;
  code: "missing_in_live" | "missing_in_replay" | "count_mismatch" | "value_mismatch";
  message: string;
  live?: unknown;
  replay?: unknown;
};

export type ProtocolReplayDiff = {
  schema_version: "swarm.protocol_replay.diff.v1";
  generated_at: string;
  session_id?: string;
  status: "pass" | "fail";
  replay_verdict: {
    forced: true;
    status: "pass" | "fail";
    reason: string;
  };
  summary: {
    issues: number;
    errors: number;
    warnings: number;
    live: ProtocolReplaySnapshotCounts;
    replay: ProtocolReplaySnapshotCounts;
  };
  issues: ProtocolReplayDiffIssue[];
};

export type ProtocolReplayInput = {
  sessionId?: string;
  generatedAt?: string;
  envelopes?: SwarmEnvelope[];
  deliveries?: EnvelopeDeliveryRecord[];
  actors?: AgentActorRecord[];
  blackboard?: BlackboardEntry[];
};

export type ProtocolReplayDiffInput = {
  live: ProtocolReplaySnapshot;
  replay: ProtocolReplaySnapshot;
  generatedAt?: string;
  sessionId?: string;
};

export type ProtocolMigrationAuditIssue = {
  severity: "info" | "warning" | "error";
  source: "worker" | "handoff" | "symphony" | "blackboard" | "delivery";
  id: string;
  code: string;
  message: string;
};

export type ProtocolMigrationAudit = {
  schema_version: "swarm.protocol_migration_audit.v1";
  generated_at: string;
  session_id?: string;
  status: "pass" | "warning" | "fail";
  summary: {
    issues: number;
    errors: number;
    warnings: number;
    replay_workers: number;
    direct_workers: number;
    replay_handoffs: number;
    direct_handoffs: number;
    replay_symphony_claims: number;
    direct_symphony_claims: number;
  };
  issues: ProtocolMigrationAuditIssue[];
};

export type ProtocolMigrationAuditInput = ProtocolReplayInput & {
  replay?: ProtocolReplaySnapshot;
  workers?: WorkerRecord[];
  handoffs?: HandoffSessionRecord[];
  symphonyClaims?: SymphonyClaimRecord[];
};

export function buildProtocolReplay(input: ProtocolReplayInput): ProtocolReplaySnapshot {
  const envelopes = normalizeReplayEnvelopes(input.envelopes ?? [], input.sessionId);
  const deliveries = normalizeReplayDeliveries(input.deliveries ?? [], input.sessionId);
  const actors = normalizeReplayActors(input.actors ?? [], input.sessionId);
  const blackboard = normalizeReplayBlackboard(input.blackboard ?? [], input.sessionId);

  const workers = new Map<string, ProtocolReplayWorker>();
  const handoffs = new Map<string, ProtocolReplayHandoff>();
  const symphony = new Map<string, ProtocolReplaySymphonyClaim>();
  const negotiations = new Map<string, ProtocolReplayNegotiation>();
  const squads = new Map<string, ProtocolReplaySquad>();

  for (const envelope of envelopes) {
    applyEnvelopeToWorkers(workers, envelope);
    applyEnvelopeToHandoffs(handoffs, envelope);
    applyEnvelopeToSymphony(symphony, envelope);
    applyEnvelopeToNegotiations(negotiations, envelope);
    applyEnvelopeToSquads(squads, envelope);
  }
  for (const actor of actors) {
    applyActorOwnership(workers, actor);
  }
  for (const entry of blackboard) {
    applyBlackboardToSymphony(symphony, entry);
    applyBlackboardToSquads(squads, entry);
  }

  return {
    schema_version: SWARM_PROTOCOL_REPLAY_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    session_id: input.sessionId,
    workers: [...workers.values()].sort((left, right) => left.worker_id.localeCompare(right.worker_id)),
    handoffs: [...handoffs.values()].sort((left, right) => left.handoff_id.localeCompare(right.handoff_id)),
    symphony: [...symphony.values()].sort((left, right) => left.claim_key.localeCompare(right.claim_key)),
    negotiations: [...negotiations.values()].sort((left, right) => left.negotiation_id.localeCompare(right.negotiation_id)),
    squads: [...squads.values()].map(finalizeSquad).sort((left, right) => left.squad_id.localeCompare(right.squad_id)),
    actors: actors.map((actor) => ({
      actor_id: actor.actor_id,
      kind: actor.kind,
      status: actor.status,
      heartbeat_state: actor.heartbeat_state,
      current_task_id: actor.current_task_id,
      current_worker_id: actor.current_worker_id,
      current_session_id: actor.current_session_id
    })).sort((left, right) => left.actor_id.localeCompare(right.actor_id)),
    blackboard: summarizeBlackboard(blackboard),
    deliveries: summarizeDeliveries(deliveries),
    envelope_count: envelopes.length
  };
}

export function diffProtocolReplaySnapshots(input: ProtocolReplayDiffInput): ProtocolReplayDiff {
  const sessionId = input.sessionId ?? input.replay.session_id ?? input.live.session_id;
  const issues: ProtocolReplayDiffIssue[] = [];
  compareScalar(issues, "snapshot", "envelope_count", input.live.envelope_count, input.replay.envelope_count);
  compareScalar(issues, "snapshot", "deliveries.total", input.live.deliveries.total, input.replay.deliveries.total);
  compareScalar(issues, "snapshot", "blackboard.total", input.live.blackboard.total, input.replay.blackboard.total);
  compareScalar(issues, "snapshot", "blackboard.decisions", input.live.blackboard.decisions, input.replay.blackboard.decisions);
  compareScalar(issues, "snapshot", "blackboard.unresolved_proposals", input.live.blackboard.unresolved_proposals.length, input.replay.blackboard.unresolved_proposals.length);
  compareCollection(issues, "worker", input.live.workers, input.replay.workers, "worker_id", ["status", "task_id", "owner_agent_id", "completed_at", "failed_at"]);
  compareCollection(issues, "handoff", input.live.handoffs, input.replay.handoffs, "handoff_id", ["status", "protocol_status", "owner_agent_id", "request_envelope_id", "return_envelope_id", "take_back_envelope_id"]);
  compareCollection(issues, "symphony", input.live.symphony, input.replay.symphony, "claim_key", ["status", "work_item_key", "workflow_path", "owner_id"]);
  compareCollection(issues, "negotiation", input.live.negotiations, input.replay.negotiations, "negotiation_id", ["status", "current_owner", "accepted_by", "declined_by"]);
  compareCollection(issues, "squad", input.live.squads, input.replay.squads, "squad_id", ["status", "leader_agent_id", "task_id"]);
  compareCollection(issues, "actor", input.live.actors, input.replay.actors, "actor_id", ["kind", "status", "heartbeat_state", "current_task_id", "current_worker_id"]);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const status = errors > 0 ? "fail" : "pass";
  return {
    schema_version: "swarm.protocol_replay.diff.v1",
    generated_at: input.generatedAt ?? input.replay.generated_at ?? new Date().toISOString(),
    session_id: sessionId,
    status,
    replay_verdict: {
      forced: true,
      status,
      reason: status === "pass"
        ? "live snapshot matches deterministic protocol replay"
        : `${errors} replay divergence${errors === 1 ? "" : "s"} detected`
    },
    summary: {
      issues: issues.length,
      errors,
      warnings,
      live: replaySnapshotCounts(input.live),
      replay: replaySnapshotCounts(input.replay)
    },
    issues
  };
}

export function diffProtocolReplay(input: ProtocolReplayInput & {
  live: ProtocolReplaySnapshot;
  replay?: ProtocolReplaySnapshot;
}): ProtocolReplayDiff {
  const replay = input.replay ?? buildProtocolReplay(input);
  return diffProtocolReplaySnapshots({
    live: input.live,
    replay,
    generatedAt: input.generatedAt,
    sessionId: input.sessionId
  });
}

export function auditProtocolMigration(input: ProtocolMigrationAuditInput): ProtocolMigrationAudit {
  const replay = input.replay ?? buildProtocolReplay(input);
  const issues: ProtocolMigrationAuditIssue[] = [];
  auditWorkers(issues, replay.workers, input.workers ?? []);
  auditHandoffs(issues, replay.handoffs, input.handoffs ?? []);
  auditSymphonyClaims(issues, replay.symphony, input.symphonyClaims ?? []);
  auditDeliveries(issues, replay.deliveries);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  return {
    schema_version: "swarm.protocol_migration_audit.v1",
    generated_at: input.generatedAt ?? replay.generated_at,
    session_id: input.sessionId ?? replay.session_id,
    status: errors > 0 ? "fail" : warnings > 0 ? "warning" : "pass",
    summary: {
      issues: issues.length,
      errors,
      warnings,
      replay_workers: replay.workers.length,
      direct_workers: input.workers?.length ?? 0,
      replay_handoffs: replay.handoffs.length,
      direct_handoffs: input.handoffs?.length ?? 0,
      replay_symphony_claims: replay.symphony.length,
      direct_symphony_claims: input.symphonyClaims?.length ?? 0
    },
    issues
  };
}

export function formatProtocolMigrationAudit(audit: ProtocolMigrationAudit): string[] {
  return [
    `protocol_replay status=${audit.status} issues=${audit.summary.issues} errors=${audit.summary.errors} warnings=${audit.summary.warnings}`,
    `workers replay=${audit.summary.replay_workers} direct=${audit.summary.direct_workers}`,
    `handoffs replay=${audit.summary.replay_handoffs} direct=${audit.summary.direct_handoffs}`,
    `symphony replay=${audit.summary.replay_symphony_claims} direct=${audit.summary.direct_symphony_claims}`,
    ...audit.issues.slice(0, 8).map((issue) => `${issue.severity} ${issue.source}:${issue.id} ${issue.code} ${issue.message}`)
  ];
}

function applyEnvelopeToWorkers(workers: Map<string, ProtocolReplayWorker>, envelope: SwarmEnvelope): void {
  if (envelope.type.startsWith("handoff.")) {
    return;
  }
  const workerId = workerIdFromEnvelope(envelope);
  if (!workerId) {
    return;
  }
  const worker = ensureWorker(workers, workerId, envelope);
  worker.source_envelope_ids.push(envelope.id);
  const payload = recordPayload(envelope.payload);
  const summary = stringField(payload.summary ?? payload.message ?? payload.objective);
  if (summary) {
    worker.last_progress = summary;
  }
  worker.capability = stringField(payload.capability) ?? capabilityFromAddress(envelope.to) ?? worker.capability;
  worker.objective = stringField(payload.objective ?? payload.task ?? payload.title) ?? worker.objective;

  switch (envelope.type) {
    case "task.assign":
      worker.status = "assigned";
      worker.assigned_by = envelope.from.agent_id ?? envelope.from.role;
      worker.owner_agent_id = addressLabelFromTo(envelope.to) ?? worker.owner_agent_id;
      break;
    case "task.accept":
      worker.status = "accepted";
      worker.owner_agent_id = envelope.from.agent_id ?? worker.owner_agent_id;
      worker.accepted_at = envelope.created_at;
      break;
    case "task.start":
      worker.status = "running";
      worker.owner_agent_id = envelope.from.agent_id ?? worker.owner_agent_id;
      worker.started_at = envelope.created_at;
      break;
    case "task.progress":
    case "task.checkpoint":
      if (isCheckpointEnvelope(envelope)) {
        worker.status = "checkpointed";
        worker.checkpoints.push(checkpointFromEnvelope(envelope));
      } else if (worker.status !== "completed" && worker.status !== "failed") {
        worker.status = "running";
      }
      break;
    case "task.result":
      worker.status = "completed";
      worker.owner_agent_id = envelope.from.agent_id ?? worker.owner_agent_id;
      worker.completed_at = envelope.created_at;
      worker.result = resultFromEnvelope(envelope);
      break;
    case "task.fail":
      worker.status = "failed";
      worker.owner_agent_id = envelope.from.agent_id ?? worker.owner_agent_id;
      worker.failed_at = envelope.created_at;
      worker.error = stringField(payload.message ?? payload.error ?? payload.summary) ?? envelope.intent;
      break;
    case "task.reject":
      worker.status = "rejected";
      worker.owner_agent_id = envelope.from.agent_id ?? worker.owner_agent_id;
      worker.rejected_at = envelope.created_at;
      worker.error = stringField(payload.message ?? payload.reason) ?? "Task rejected.";
      break;
    case "task.cancel":
      worker.status = "cancelled";
      worker.error = stringField(payload.reason ?? payload.message) ?? "Task cancelled.";
      break;
    case "task.supersede":
      worker.status = "superseded";
      worker.error = stringField(payload.reason ?? payload.message) ?? "Task superseded.";
      break;
    default:
      break;
  }
}

function applyEnvelopeToHandoffs(handoffs: Map<string, ProtocolReplayHandoff>, envelope: SwarmEnvelope): void {
  const payload = recordPayload(envelope.payload);
  const isHandoffProtocol = envelope.type.startsWith("handoff.");
  const isLegacyHandoffTask = Boolean(envelope.task_id?.startsWith("handoff"));
  const handoffId = stringField(payload.handoff_id ?? payload.handoffId) ?? (isLegacyHandoffTask ? envelope.task_id : undefined);
  if (!handoffId) {
    return;
  }
  if (!isHandoffProtocol && !isLegacyHandoffTask) {
    return;
  }
  const handoff = handoffs.get(handoffId) ?? {
    handoff_id: handoffId,
    task_id: envelope.task_id,
    status: "unknown",
    source_envelope_ids: []
  };
  assignString(handoff, "worker_id", payload.worker_id ?? payload.workerId);
  assignString(handoff, "source_agent", payload.source_agent ?? payload.sourceAgent);
  handoff.source_agent = handoff.source_agent ?? envelope.from.agent_id;
  assignString(handoff, "target_agent_spec_id", payload.target_agent_spec_id ?? payload.targetAgentSpecId ?? payload.agent_spec_id);
  assignString(handoff, "reason", payload.reason);
  handoff.source_envelope_ids.push(envelope.id);
  handoff.task_id = envelope.task_id ?? handoff.task_id;
  assignString(handoff, "worker_id", payload.worker_id ?? payload.workerId);
  assignString(handoff, "requester_agent_id", payload.requester_agent_id ?? payload.requesterAgentId ?? payload.requested_by);
  assignString(handoff, "owner_agent_id", payload.owner_agent_id ?? payload.ownerAgentId);
  assignString(handoff, "target_agent_spec_id", payload.target_agent_spec_id ?? payload.targetAgentSpecId ?? payload.agent_spec_id);
  assignString(handoff, "reason", payload.reason);
  assignStringArray(handoff, "scope", payload.scope ?? payload.file_scope ?? payload.fileScope);
  assignNumber(handoff, "lease_ttl_ms", payload.lease_ttl_ms ?? payload.leaseTtlMs);
  assignString(handoff, "lease_expires_at", payload.lease_expires_at ?? payload.leaseExpiresAt);
  assignString(handoff, "deadline_at", payload.deadline_at ?? payload.deadlineAt);
  handoff.last_envelope_id = envelope.id;

  if (isHandoffProtocol) {
    applyHandoffProtocolEnvelope(handoff, envelope, payload);
  } else if (envelope.type === "task.assign" || envelope.type === "task.accept" || envelope.type === "task.start" || envelope.type === "task.progress") {
    handoff.status = "active";
    handoff.protocol_status = handoff.protocol_status ?? "accepted";
    handoff.owner_agent_id = envelope.type === "task.assign"
      ? addressLabelFromTo(envelope.to) ?? handoff.owner_agent_id
      : envelope.from.agent_id ?? handoff.owner_agent_id;
  } else if (envelope.type === "task.result") {
    handoff.status = "returned";
    handoff.protocol_status = "returned";
    handoff.owner_agent_id = envelope.from.agent_id ?? handoff.owner_agent_id;
    handoff.result = stringField(payload.result ?? payload.content ?? payload.summary);
  } else if (envelope.type === "task.fail") {
    handoff.status = "failed";
    handoff.protocol_status = "failed";
    handoff.owner_agent_id = envelope.from.agent_id ?? handoff.owner_agent_id;
    handoff.result = stringField(payload.message ?? payload.error ?? payload.summary);
  } else if (envelope.type === "task.cancel") {
    handoff.status = "taken_back";
    handoff.protocol_status = "taken_back";
    handoff.result = stringField(payload.reason ?? payload.message);
  } else if (envelope.type === "task.supersede") {
    handoff.status = "superseded";
    handoff.protocol_status = "failed";
    handoff.result = stringField(payload.reason ?? payload.message);
  }
  handoffs.set(handoffId, handoff);
}

function applyHandoffProtocolEnvelope(
  handoff: ProtocolReplayHandoff,
  envelope: SwarmEnvelope,
  payload: Record<string, unknown>
): void {
  switch (envelope.type) {
    case "handoff.request":
      handoff.status = "active";
      handoff.protocol_status = "requested";
      handoff.request_envelope_id = envelope.id;
      handoff.requester_agent_id = handoff.requester_agent_id ?? envelope.from.agent_id ?? handoff.source_agent;
      break;
    case "handoff.accept":
      handoff.status = "active";
      handoff.protocol_status = "accepted";
      handoff.owner_agent_id = envelope.from.agent_id ?? handoff.owner_agent_id;
      handoff.accepted_at = envelope.created_at;
      handoff.accept_envelope_id = envelope.id;
      break;
    case "handoff.reject":
      handoff.status = "failed";
      handoff.protocol_status = "rejected";
      handoff.conflict_reason = stringField(payload.reason ?? payload.message ?? payload.summary) ?? handoff.conflict_reason;
      handoff.result = handoff.conflict_reason;
      break;
    case "handoff.renew":
      handoff.status = "active";
      handoff.protocol_status = "renewed";
      handoff.owner_agent_id = envelope.from.agent_id ?? handoff.owner_agent_id;
      break;
    case "handoff.checkpoint":
      handoff.status = "active";
      handoff.protocol_status = "checkpointed";
      handoff.owner_agent_id = envelope.from.agent_id ?? handoff.owner_agent_id;
      handoff.last_checkpoint = payload.checkpoint ?? payload.last_checkpoint ?? payload.lastCheckpoint ?? payload;
      break;
    case "handoff.return":
      handoff.status = stringField(payload.status) === "failed" ? "failed" : "returned";
      handoff.protocol_status = handoff.status === "failed" ? "failed" : "returned";
      handoff.owner_agent_id = envelope.from.agent_id ?? handoff.owner_agent_id;
      handoff.return_contract = payload.return_contract ?? payload.returnContract ?? payload;
      handoff.return_envelope_id = envelope.id;
      handoff.result = stringField(payload.result ?? payload.content ?? payload.summary) ?? handoff.result;
      break;
    case "handoff.take_back":
      handoff.status = "taken_back";
      handoff.protocol_status = "taken_back";
      handoff.requester_agent_id = stringField(payload.requester_agent_id ?? payload.requesterAgentId) ?? envelope.from.agent_id ?? handoff.requester_agent_id;
      handoff.owner_agent_id = stringField(payload.resulting_owner ?? payload.resultingOwner) ?? envelope.from.agent_id ?? handoff.owner_agent_id;
      handoff.take_back_envelope_id = envelope.id;
      handoff.result = stringField(payload.reason ?? payload.message ?? payload.summary) ?? handoff.result;
      break;
    case "handoff.conflict":
      handoff.status = "active";
      handoff.protocol_status = "conflict";
      handoff.conflict_reason = stringField(payload.reason ?? payload.message ?? payload.summary) ?? handoff.conflict_reason;
      break;
    case "handoff.timeout":
      handoff.status = "active";
      handoff.protocol_status = "timeout";
      handoff.conflict_reason = stringField(payload.reason ?? payload.message ?? payload.summary) ?? handoff.conflict_reason;
      break;
    default:
      break;
  }
}

function applyEnvelopeToSymphony(symphony: Map<string, ProtocolReplaySymphonyClaim>, envelope: SwarmEnvelope): void {
  const payload = recordPayload(envelope.payload);
  const participant = envelope.from.agent_id === "symphony.scheduler" ||
    addressIncludes(envelope.to, "symphony.scheduler") ||
    stringField(payload.source) === "symphony" ||
    stringField(payload.source_identity ?? payload.sourceIdentity)?.includes("symphony");
  const workItemKey = stringField(payload.work_item_key ?? payload.workItemKey ?? payload.source_id ?? payload.sourceId);
  const claimKey = stringField(payload.claim_key ?? payload.claimKey) ?? workItemKey;
  if (!participant && !claimKey) {
    return;
  }
  const key = claimKey ?? `${envelope.session_id}:${envelope.task_id ?? envelope.id}`;
  const claim = symphony.get(key) ?? {
    claim_key: key,
    work_item_key: workItemKey,
    workflow_path: stringField(payload.workflow_path ?? payload.workflowPath),
    session_id: envelope.session_id,
    owner_id: stringField(payload.owner_id ?? payload.ownerId) ?? envelope.from.agent_id,
    status: "observed",
    source_envelope_ids: []
  };
  claim.source_envelope_ids.push(envelope.id);
  claim.work_item_key = workItemKey ?? claim.work_item_key;
  claim.workflow_path = stringField(payload.workflow_path ?? payload.workflowPath) ?? claim.workflow_path;
  claim.session_id = stringField(payload.session_id ?? payload.sessionId) ?? envelope.session_id ?? claim.session_id;
  claim.owner_id = stringField(payload.owner_id ?? payload.ownerId) ?? envelope.from.agent_id ?? claim.owner_id;
  if (envelope.type === "task.assign" || envelope.type === "task.accept" || envelope.type === "task.start") {
    claim.status = envelope.type === "task.assign" ? "claimed" : "running";
  } else if (envelope.type === "task.result") {
    claim.status = "completed";
    claim.result = stringField(payload.result ?? payload.summary ?? payload.content);
  } else if (envelope.type === "task.fail") {
    claim.status = "failed";
    claim.result = stringField(payload.message ?? payload.error ?? payload.summary);
  } else if (envelope.type === "task.cancel") {
    claim.status = "cancelled";
    claim.result = stringField(payload.reason ?? payload.message);
  } else if (stringField(payload.status)) {
    claim.status = stringField(payload.status) ?? claim.status;
  }
  symphony.set(key, claim);
}

function applyEnvelopeToNegotiations(negotiations: Map<string, ProtocolReplayNegotiation>, envelope: SwarmEnvelope): void {
  const action = negotiationActionFromType(envelope.type);
  if (!action) {
    return;
  }
  const payload = recordPayload(envelope.payload);
  const negotiationId = stringField(payload.negotiation_id ?? payload.negotiationId) ?? envelope.correlation_id ?? envelope.task_id ?? envelope.id;
  const negotiation = negotiations.get(negotiationId) ?? {
    negotiation_id: negotiationId,
    task_id: envelope.task_id,
    status: "unknown",
    opened_by: envelope.from.agent_id ?? envelope.from.role,
    events: [],
    source_envelope_ids: []
  };
  negotiation.task_id = envelope.task_id ?? negotiation.task_id;
  negotiation.current_owner = envelope.from.agent_id ?? envelope.from.role ?? negotiation.current_owner;
  negotiation.source_envelope_ids.push(envelope.id);
  const event: ProtocolReplayNegotiationEvent = {
    envelope_id: envelope.id,
    action,
    at: envelope.created_at,
    from: actorLabel(envelope.from),
    to: addressLabelFromTo(envelope.to),
    reason: stringField(payload.reason ?? payload.message ?? payload.summary),
    suggested_alternative: payload.suggested_alternative ?? payload.suggestedAlternative,
    terms: payload.terms ?? payload.proposal ?? payload.counter_terms ?? payload.counterTerms ?? payload.handoff_terms ?? payload.handoffTerms ?? payload.contract ?? payload.value
  };
  negotiation.events.push(event);

  switch (action) {
    case "propose":
      negotiation.status = "proposed";
      break;
    case "counter":
      negotiation.status = "countered";
      break;
    case "accept":
      negotiation.status = "accepted";
      negotiation.accepted_by = event.from;
      negotiation.contract = payload.contract ?? payload.accepted_contract ?? payload.acceptedContract ?? event.terms;
      break;
    case "decline":
      negotiation.status = "declined";
      negotiation.declined_by = event.from;
      negotiation.reason = event.reason;
      negotiation.suggested_alternative = event.suggested_alternative;
      break;
    case "delegate":
      negotiation.status = "delegated";
      negotiation.delegated_to = event.to;
      break;
    case "escalate":
      negotiation.status = "escalated";
      negotiation.escalated_to = event.to;
      negotiation.reason = event.reason;
      break;
  }
  negotiations.set(negotiationId, negotiation);
}

function applyEnvelopeToSquads(squads: Map<string, ProtocolReplaySquad>, envelope: SwarmEnvelope): void {
  const action = squadActionFromType(envelope.type);
  if (!action) {
    return;
  }
  const payload = recordPayload(envelope.payload);
  const squadId = stringField(payload.squad_id ?? payload.squadId) ?? envelope.correlation_id ?? envelope.task_id ?? envelope.id;
  const leader = addressFromPayload(payload.leader ?? payload.leader_agent ?? payload.leaderAgent ?? payload.owner) ?? envelope.from;
  const squad = squads.get(squadId) ?? {
    squad_id: squadId,
    task_id: envelope.task_id,
    status: "unknown",
    leader_agent_id: actorLabel(leader),
    objective: stringField(payload.objective ?? payload.summary),
    members: [],
    events: [],
    source_envelope_ids: []
  };
  squad.task_id = envelope.task_id ?? squad.task_id;
  squad.leader_agent_id = actorLabel(leader) ?? squad.leader_agent_id;
  squad.objective = stringField(payload.objective ?? payload.summary) ?? squad.objective;
  enrichSquadFromPayload(squad, payload);
  squad.source_envelope_ids.push(envelope.id);
  const member = squadMemberFromPayload(payload) ?? addressFromTo(envelope.to);
  const requiredCapabilities = uniqueStrings([
    ...(stringArray(payload.required_capabilities ?? payload.requiredCapabilities) ?? []),
    ...(stringArray(payload.capabilities) ?? []),
    ...(member?.capabilities ?? [])
  ]);
  squad.events.push({
    envelope_id: envelope.id,
    action,
    at: envelope.created_at,
    from: actorLabel(envelope.from),
    member_id: member ? actorLabel(member) : undefined,
    role: stringField(payload.role ?? payload.role_id ?? payload.roleId) ?? member?.role,
    required_capabilities: requiredCapabilities,
    reason: stringField(payload.reason ?? payload.message ?? payload.summary)
  });

  if (action === "create") {
    squad.status = "active";
    upsertSquadMember(squad, leader, {
      role: stringField(payload.leader_role ?? payload.leaderRole) ?? "leader",
      capabilities: stringArray(payload.leader_capabilities ?? payload.leaderCapabilities) ?? [],
      at: envelope.created_at,
      envelopeId: envelope.id
    });
    for (const candidate of squadMembersFromPayload(payload)) {
      upsertSquadMember(squad, candidate, {
        role: candidate.role,
        capabilities: candidate.capabilities ?? [],
        at: envelope.created_at,
        envelopeId: envelope.id
      });
    }
    for (const role of squadRolesFromPayload(payload)) {
      const roleMember = addressFromPayload(role.member ?? role.agent ?? role.assignee) ??
        (stringField(role.agent_id ?? role.agentId) ? { agent_id: stringField(role.agent_id ?? role.agentId) } : undefined);
      if (roleMember) {
        upsertSquadMember(squad, roleMember, {
          role: stringField(role.role ?? role.role_id ?? role.roleId),
          capabilities: stringArray(role.required_capabilities ?? role.requiredCapabilities ?? role.capabilities) ?? [],
          at: envelope.created_at,
          envelopeId: envelope.id
        });
      }
    }
  } else if (action === "join" || action === "role.assign") {
    if (member) {
      upsertSquadMember(squad, member, {
        role: stringField(payload.role ?? payload.role_id ?? payload.roleId) ?? member.role,
        capabilities: requiredCapabilities,
        at: envelope.created_at,
        envelopeId: envelope.id
      });
    }
    squad.status = "active";
  } else if (action === "leave") {
    if (member) {
      markSquadMemberLeft(squad, actorLabel(member), envelope.created_at, envelope.id);
    }
  } else if (action === "dissolve") {
    squad.status = "dissolved";
    for (const existing of squad.members) {
      existing.status = "left";
      existing.left_at = existing.left_at ?? envelope.created_at;
      existing.source_envelope_ids = uniqueStrings([...existing.source_envelope_ids, envelope.id]);
    }
  }
  squads.set(squadId, squad);
}

function applyActorOwnership(workers: Map<string, ProtocolReplayWorker>, actor: AgentActorRecord): void {
  if (!actor.current_worker_id && !actor.current_task_id) {
    return;
  }
  const workerId = actor.current_worker_id ?? actor.current_task_id;
  if (!workerId) {
    return;
  }
  const existing = workers.get(workerId) ?? {
    worker_id: workerId,
    task_id: actor.current_task_id ?? workerId,
    owner_agent_id: actor.actor_id,
    status: actor.status === "offline" ? "unknown" : "running",
    checkpoints: [],
    source_envelope_ids: []
  };
  existing.owner_agent_id = actor.actor_id;
  existing.task_id = actor.current_task_id ?? existing.task_id;
  workers.set(workerId, existing);
}

function applyBlackboardToSymphony(symphony: Map<string, ProtocolReplaySymphonyClaim>, entry: BlackboardEntry): void {
  const tags = entry.tags ?? [];
  const value = recordPayload(entry.value);
  const workItemKey = stringField(value.work_item_key ?? value.workItemKey);
  const claimKey = stringField(value.claim_key ?? value.claimKey) ?? workItemKey;
  if (!claimKey || (!tags.includes("symphony") && !tags.includes("claim") && !entry.key.includes("symphony"))) {
    return;
  }
  const claim = symphony.get(claimKey) ?? {
    claim_key: claimKey,
    work_item_key: workItemKey,
    session_id: entry.session_id,
    owner_id: entry.created_by.agent_id,
    status: "observed",
    source_envelope_ids: []
  };
  claim.work_item_key = workItemKey ?? claim.work_item_key;
  claim.owner_id = stringField(value.owner_id ?? value.ownerId) ?? entry.created_by.agent_id ?? claim.owner_id;
  claim.status = stringField(value.status) ?? (entry.type === "decision" ? "decided" : claim.status);
  symphony.set(claimKey, claim);
}

function applyBlackboardToSquads(squads: Map<string, ProtocolReplaySquad>, entry: BlackboardEntry): void {
  const metadata = entry.metadata ?? {};
  const tags = entry.tags ?? [];
  const value = recordPayload(entry.value);
  const squadId = stringField(metadata.squad_id ?? metadata.squadId) ??
    (tags.includes("squad") ? squadIdFromBlackboardKey(entry.key) : undefined);
  if (!squadId) {
    return;
  }
  const action = squadActionFromMetadata(metadata, tags, value);
  const status = stringField(metadata.squad_status ?? metadata.squadStatus ?? value.status);
  const sourceEnvelopeId = stringField(metadata.source_envelope_id) ?? entry.entry_id;
  const leader = addressFromPayload(value.leader ?? value.leader_agent ?? value.leaderAgent ?? value.owner ?? value.coordinator) ??
    (stringField(metadata.owner_agent_id) ? { agent_id: stringField(metadata.owner_agent_id) } : undefined);
  const squad = squads.get(squadId) ?? {
    squad_id: squadId,
    task_id: entry.task_id,
    status: "unknown",
    leader_agent_id: leader ? actorLabel(leader) : undefined,
    objective: stringField(value.objective ?? value.summary),
    members: [],
    events: [],
    source_envelope_ids: []
  };
  squad.task_id = entry.task_id ?? squad.task_id;
  squad.leader_agent_id = (leader ? actorLabel(leader) : undefined) ?? squad.leader_agent_id;
  squad.objective = stringField(value.objective ?? value.summary) ?? squad.objective;
  enrichSquadFromPayload(squad, value);
  if (status === "dissolved") {
    squad.status = "dissolved";
  } else if (status === "active" || status === "member_left") {
    squad.status = squad.status === "dissolved" ? "dissolved" : "active";
  }
  if (leader) {
    upsertSquadMember(squad, leader, {
      role: leader.role ?? "leader",
      capabilities: stringArray(value.leader_capabilities ?? value.leaderCapabilities) ?? [],
      at: entry.created_at,
      envelopeId: sourceEnvelopeId
    });
  }
  for (const candidate of squadMembersFromPayload(value)) {
    upsertSquadMember(squad, candidate, {
      role: candidate.role,
      capabilities: candidate.capabilities ?? [],
      at: entry.created_at,
      envelopeId: sourceEnvelopeId
    });
  }
  for (const role of squadRolesFromPayload(value)) {
    const roleMember = addressFromPayload(role.member ?? role.agent ?? role.assignee) ??
      (stringField(role.agent_id ?? role.agentId) ? { agent_id: stringField(role.agent_id ?? role.agentId) } : undefined);
    if (roleMember) {
      upsertSquadMember(squad, roleMember, {
        role: stringField(role.role ?? role.role_id ?? role.roleId),
        capabilities: stringArray(role.required_capabilities ?? role.requiredCapabilities ?? role.capabilities) ?? [],
        at: entry.created_at,
        envelopeId: sourceEnvelopeId
      });
    }
  }
  const member = squadMemberFromPayload(value);
  const memberId = member ? actorLabel(member) : stringField(metadata.squad_member_id ?? metadata.squadMemberId);
  const requiredCapabilities = uniqueStrings([
    ...(stringArray(value.required_capabilities ?? value.requiredCapabilities) ?? []),
    ...(stringArray(value.capabilities) ?? []),
    ...(member?.capabilities ?? [])
  ]);
  if (member) {
    upsertSquadMember(squad, member, {
      role: stringField(value.role ?? value.role_id ?? value.roleId ?? metadata.squad_role ?? metadata.squadRole) ?? member.role,
      capabilities: requiredCapabilities,
      at: entry.created_at,
      envelopeId: sourceEnvelopeId
    });
  }
  if (action === "leave" && memberId) {
    markSquadMemberLeft(squad, memberId, entry.created_at, sourceEnvelopeId);
  }
  if (action === "dissolve" || status === "dissolved") {
    squad.status = "dissolved";
    for (const existing of squad.members) {
      existing.status = "left";
      existing.left_at = existing.left_at ?? entry.created_at;
      existing.source_envelope_ids = uniqueStrings([...existing.source_envelope_ids, sourceEnvelopeId]);
    }
  }
  if (action && !squad.events.some((event) => event.envelope_id === sourceEnvelopeId)) {
    squad.events.push({
      envelope_id: sourceEnvelopeId,
      action,
      at: entry.created_at,
      from: entry.created_by.agent_id ?? entry.created_by.role,
      member_id: memberId,
      role: stringField(value.role ?? value.role_id ?? value.roleId ?? metadata.squad_role ?? metadata.squadRole),
      required_capabilities: requiredCapabilities,
      reason: stringField(value.reason ?? value.message ?? value.summary)
    });
  }
  squad.source_envelope_ids.push(sourceEnvelopeId);
  squads.set(squadId, squad);
}

function normalizeReplayEnvelopes(envelopes: SwarmEnvelope[], sessionId: string | undefined): SwarmEnvelope[] {
  const ordered = envelopes
    .filter((envelope) => !sessionId || envelope.session_id === sessionId)
    .sort(compareEnvelopes);
  const byId = new Set<string>();
  const byIdempotencyKey = new Set<string>();
  const output: SwarmEnvelope[] = [];
  for (const envelope of ordered) {
    if (byId.has(envelope.id)) {
      continue;
    }
    if (envelope.idempotency_key && byIdempotencyKey.has(envelope.idempotency_key)) {
      continue;
    }
    byId.add(envelope.id);
    if (envelope.idempotency_key) {
      byIdempotencyKey.add(envelope.idempotency_key);
    }
    output.push(envelope);
  }
  return output;
}

function normalizeReplayDeliveries(deliveries: EnvelopeDeliveryRecord[], sessionId: string | undefined): EnvelopeDeliveryRecord[] {
  const ordered = deliveries
    .filter((delivery) => !sessionId || delivery.session_id === sessionId)
    .sort((left, right) =>
      left.queued_at.localeCompare(right.queued_at) ||
      left.delivery_id.localeCompare(right.delivery_id)
    );
  const byId = new Map<string, EnvelopeDeliveryRecord>();
  for (const delivery of ordered) {
    byId.set(delivery.delivery_id, delivery);
  }
  return [...byId.values()].sort((left, right) =>
    left.queued_at.localeCompare(right.queued_at) ||
    left.delivery_id.localeCompare(right.delivery_id)
  );
}

function normalizeReplayActors(actors: AgentActorRecord[], sessionId: string | undefined): AgentActorRecord[] {
  const ordered = actors
    .filter((actor) => !sessionId || actor.current_session_id === sessionId || !actor.current_session_id)
    .sort((left, right) =>
      left.updated_at.localeCompare(right.updated_at) ||
      left.actor_id.localeCompare(right.actor_id)
    );
  const byId = new Map<string, AgentActorRecord>();
  for (const actor of ordered) {
    byId.set(actor.actor_id, actor);
  }
  return [...byId.values()].sort((left, right) => left.actor_id.localeCompare(right.actor_id));
}

function normalizeReplayBlackboard(entries: BlackboardEntry[], sessionId: string | undefined): BlackboardEntry[] {
  const ordered = entries
    .filter((entry) => !sessionId || entry.session_id === sessionId)
    .sort(compareBlackboardEntries);
  const byId = new Map<string, BlackboardEntry>();
  for (const entry of ordered) {
    byId.set(entry.entry_id, entry);
  }
  return [...byId.values()].sort(compareBlackboardEntries);
}

function compareEnvelopes(left: SwarmEnvelope, right: SwarmEnvelope): number {
  return left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id);
}

function entryOrderKey(entry: BlackboardEntry): string {
  return `${entry.entry_id}\u0000${entry.key}`;
}

function compareBlackboardEntries(left: BlackboardEntry, right: BlackboardEntry): number {
  return left.created_at.localeCompare(right.created_at) ||
    blackboardEntryRank(left) - blackboardEntryRank(right) ||
    entryOrderKey(left).localeCompare(entryOrderKey(right));
}

function blackboardEntryRank(entry: BlackboardEntry): number {
  const tags = entry.tags ?? [];
  if (entry.metadata?.kind === "claim" || tags.includes("claim") || entry.key.includes("claim")) {
    return 0;
  }
  if (entry.metadata?.kind === "proposal" || tags.includes("proposal") || entry.key.includes("proposal")) {
    return 1;
  }
  if (entry.metadata?.kind === "decision" || tags.includes("decision") || entry.type === "decision") {
    return 2;
  }
  if (entry.metadata?.kind === "result" || tags.includes("result") || entry.type === "result") {
    return 3;
  }
  if (tags.includes("evidence") || entry.type === "evidence") {
    return 4;
  }
  return 5;
}

function ensureWorker(workers: Map<string, ProtocolReplayWorker>, workerId: string, envelope: SwarmEnvelope): ProtocolReplayWorker {
  const existing = workers.get(workerId);
  if (existing) {
    return existing;
  }
  const worker: ProtocolReplayWorker = {
    worker_id: workerId,
    task_id: envelope.task_id ?? workerId,
    owner_agent_id: addressLabelFromTo(envelope.to),
    assigned_by: envelope.from.agent_id,
    status: "unknown",
    checkpoints: [],
    source_envelope_ids: []
  };
  workers.set(workerId, worker);
  return worker;
}

function auditWorkers(issues: ProtocolMigrationAuditIssue[], replayWorkers: ProtocolReplayWorker[], directWorkers: WorkerRecord[]): void {
  const replayById = new Map(replayWorkers.map((worker) => [worker.worker_id, worker]));
  const directById = new Map(directWorkers.map((worker) => [worker.worker_id, worker]));
  for (const worker of directWorkers) {
    const replay = replayById.get(worker.worker_id);
    if (!replay) {
      issues.push(issue("warning", "worker", worker.worker_id, "legacy_direct_without_protocol", "WorkerRecord has no matching protocol replay worker."));
      continue;
    }
    const expected = replayStatusFromWorkerStatus(worker.status);
    if (expected !== replay.status && !(worker.status === "running" && replay.status === "checkpointed")) {
      issues.push(issue("error", "worker", worker.worker_id, "worker_status_divergence", `direct=${worker.status} replay=${replay.status}`));
    }
  }
  for (const replay of replayWorkers) {
    if (!directById.has(replay.worker_id)) {
      issues.push(issue("info", "worker", replay.worker_id, "protocol_without_direct_worker", "Protocol replay has no legacy WorkerRecord projection."));
    }
  }
}

function auditHandoffs(issues: ProtocolMigrationAuditIssue[], replayHandoffs: ProtocolReplayHandoff[], directHandoffs: HandoffSessionRecord[]): void {
  const replayById = new Map(replayHandoffs.map((handoff) => [handoff.handoff_id, handoff]));
  const directById = new Map(directHandoffs.map((handoff) => [handoff.handoff_id, handoff]));
  for (const handoff of directHandoffs) {
    const replay = replayById.get(handoff.handoff_id);
    if (!replay) {
      issues.push(issue("warning", "handoff", handoff.handoff_id, "legacy_direct_without_protocol", "HandoffStore row has no matching protocol replay handoff."));
      continue;
    }
    if (handoff.status !== replay.status) {
      issues.push(issue("error", "handoff", handoff.handoff_id, "handoff_status_divergence", `direct=${handoff.status} replay=${replay.status}`));
    }
  }
  for (const replay of replayHandoffs) {
    if (!directById.has(replay.handoff_id)) {
      issues.push(issue("info", "handoff", replay.handoff_id, "protocol_without_direct_handoff", "Protocol replay has no legacy HandoffStore row."));
    }
  }
}

function auditSymphonyClaims(issues: ProtocolMigrationAuditIssue[], replayClaims: ProtocolReplaySymphonyClaim[], directClaims: SymphonyClaimRecord[]): void {
  const replayById = new Map(replayClaims.map((claim) => [claim.claim_key, claim]));
  const directById = new Map(directClaims.map((claim) => [claim.claim_key, claim]));
  for (const claim of directClaims) {
    const replay = replayById.get(claim.claim_key);
    if (!replay) {
      issues.push(issue("warning", "symphony", claim.claim_key, "legacy_direct_without_protocol", "SymphonyClaimStore row has no matching protocol replay claim."));
      continue;
    }
    if (!compatibleSymphonyStatus(claim.status, replay.status)) {
      issues.push(issue("error", "symphony", claim.claim_key, "symphony_status_divergence", `direct=${claim.status} replay=${replay.status}`));
    }
  }
  for (const replay of replayClaims) {
    if (!directById.has(replay.claim_key)) {
      issues.push(issue("info", "symphony", replay.claim_key, "protocol_without_direct_claim", "Protocol replay has no legacy Symphony claim row."));
    }
  }
}

function auditDeliveries(issues: ProtocolMigrationAuditIssue[], deliveries: ProtocolReplayDeliverySummary): void {
  if (deliveries.failed > 0 || deliveries.expired > 0) {
    issues.push(issue("warning", "delivery", "envelope_deliveries", "delivery_failures_present", `failed=${deliveries.failed} expired=${deliveries.expired}`));
  }
}

function replaySnapshotCounts(snapshot: ProtocolReplaySnapshot): ProtocolReplaySnapshotCounts {
  return {
    envelopes: snapshot.envelope_count,
    workers: snapshot.workers.length,
    handoffs: snapshot.handoffs.length,
    symphony: snapshot.symphony.length,
    negotiations: snapshot.negotiations.length,
    squads: snapshot.squads.length,
    actors: snapshot.actors.length,
    blackboard: snapshot.blackboard.total,
    deliveries: snapshot.deliveries.total
  };
}

function compareScalar(
  issues: ProtocolReplayDiffIssue[],
  source: ProtocolReplayDiffIssue["source"],
  path: string,
  live: unknown,
  replay: unknown
): void {
  if (stableValueKey(live) === stableValueKey(replay)) {
    return;
  }
  issues.push({
    severity: "error",
    source,
    path,
    code: "value_mismatch",
    message: `${path} mismatch: live=${JSON.stringify(live)} replay=${JSON.stringify(replay)}`,
    live,
    replay
  });
}

function compareCollection<T extends object>(
  issues: ProtocolReplayDiffIssue[],
  source: ProtocolReplayDiffIssue["source"],
  liveItems: T[],
  replayItems: T[],
  idKey: string,
  fields: string[]
): void {
  if (liveItems.length !== replayItems.length) {
    issues.push({
      severity: "error",
      source,
      path: `${source}.count`,
      code: "count_mismatch",
      message: `${source} count mismatch: live=${liveItems.length} replay=${replayItems.length}`,
      live: liveItems.length,
      replay: replayItems.length
    });
  }
  const liveById = new Map<string, T>();
  const replayById = new Map<string, T>();
  for (const item of liveItems) {
    const id = stringField((item as Record<string, unknown>)[idKey]);
    if (id) {
      liveById.set(id, item);
    }
  }
  for (const item of replayItems) {
    const id = stringField((item as Record<string, unknown>)[idKey]);
    if (id) {
      replayById.set(id, item);
    }
  }
  const ids = uniqueStrings([...liveById.keys(), ...replayById.keys()]).sort();
  for (const id of ids) {
    const live = liveById.get(id);
    const replay = replayById.get(id);
    if (!live) {
      issues.push({
        severity: "error",
        source,
        path: `${source}.${id}`,
        code: "missing_in_live",
        message: `${source} ${id} exists in replay snapshot but not live snapshot.`,
        replay
      });
      continue;
    }
    if (!replay) {
      issues.push({
        severity: "error",
        source,
        path: `${source}.${id}`,
        code: "missing_in_replay",
        message: `${source} ${id} exists in live snapshot but not replay snapshot.`,
        live
      });
      continue;
    }
    for (const field of fields) {
      const liveValue = (live as Record<string, unknown>)[field];
      const replayValue = (replay as Record<string, unknown>)[field];
      if (stableValueKey(liveValue) === stableValueKey(replayValue)) {
        continue;
      }
      issues.push({
        severity: "error",
        source,
        path: `${source}.${id}.${field}`,
        code: "value_mismatch",
        message: `${source} ${id} ${field} mismatch: live=${JSON.stringify(liveValue)} replay=${JSON.stringify(replayValue)}`,
        live: liveValue,
        replay: replayValue
      });
    }
  }
}

function stableValueKey(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortStable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortStable(item)])
    );
  }
  return value;
}

function summarizeBlackboard(entries: BlackboardEntry[]): ProtocolReplayBlackboard {
  const orderedEntries = [...entries].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const claimEntries = orderedEntries.filter((entry) => entry.metadata?.kind === "claim" || entry.key.includes("claim") || (entry.tags ?? []).includes("claim"));
  const proposalEntries = orderedEntries.filter((entry) => entry.metadata?.kind === "proposal" || entry.key.includes("proposal") || (entry.tags ?? []).includes("proposal"));
  const collaboration = summarizeBlackboardCollaboration(orderedEntries);
  return {
    total: orderedEntries.length,
    claims: claimEntries.length,
    proposals: proposalEntries.length,
    decisions: orderedEntries.filter((entry) => entry.type === "decision").length,
    results: orderedEntries.filter((entry) => entry.type === "result").length,
    evidence: orderedEntries.filter((entry) => entry.type === "evidence").length,
    entries: orderedEntries.map((entry) => ({
      entry_id: entry.entry_id,
      key: entry.key,
      type: entry.type,
      task_id: entry.task_id,
      created_by: entry.created_by.agent_id ?? entry.created_by.role,
      tags: entry.tags ?? []
    })),
    decision_history: collaboration.decision_history,
    unresolved_proposals: collaboration.unresolved_proposals
  };
}

function summarizeBlackboardCollaboration(entries: BlackboardEntry[]): {
  decision_history: ProtocolReplayBlackboardDecision[];
  unresolved_proposals: ProtocolReplayBlackboardProposal[];
} {
  const proposals = new Map<string, ProtocolReplayBlackboardProposal>();
  const decisionHistory: ProtocolReplayBlackboardDecision[] = [];

  for (const entry of entries) {
    const metadata = entry.metadata ?? {};
    const kind = metadata.kind;
    const proposalId = stringField(metadata.proposal_id) ?? proposalIdFromKey(entry.key);
    if ((kind === "proposal" || (entry.tags ?? []).includes("proposal")) && proposalId) {
      const proposal = ensureReplayProposal(proposals, proposalId, entry);
      proposal.claim_key = stringField(metadata.claim_key) ?? proposal.claim_key;
      proposal.target_key = stringField(metadata.target_key) ?? proposal.target_key;
      proposal.status = blackboardDecisionStatus(metadata.decision_status) ?? proposal.status;
      applyDecisionPolicyProjection(proposal, entry);
      proposal.source_envelope_ids = uniqueStrings([...proposal.source_envelope_ids, ...blackboardSourceEnvelopeIds(entry)]);
      continue;
    }

    if (kind === "review" && proposalId) {
      const proposal = ensureReplayProposal(proposals, proposalId, entry);
      const value = recordPayload(entry.value);
      proposal.reviews.push({
        entry_id: entry.entry_id,
        proposal_id: proposalId,
        reviewer: actorLabel(entry.created_by),
        verdict: stringField(value.verdict),
        created_at: entry.created_at,
        source_envelope_ids: blackboardSourceEnvelopeIds(entry)
      });
      if (proposal.status === "proposed" || proposal.status === "unknown") {
        proposal.status = "reviewed";
      }
      proposal.source_envelope_ids = uniqueStrings([...proposal.source_envelope_ids, ...blackboardSourceEnvelopeIds(entry)]);
      continue;
    }

    if (kind === "decision" && proposalId) {
      const status = blackboardDecisionStatus(metadata.decision_status) ?? blackboardDecisionStatus(recordPayload(entry.value).status);
      if (!status) {
        continue;
      }
      const decision: ProtocolReplayBlackboardDecision = {
        entry_id: entry.entry_id,
        proposal_id: proposalId,
        status,
        decider: actorLabel(entry.created_by),
        policy: decisionPolicyFromEntry(entry),
        policy_status: decisionPolicyStatusFromEntry(entry),
        waiting_for: decisionWaitingForFromEntry(entry),
        votes: decisionVotesFromEntry(entry),
        outcome: decisionOutcomeFromEntry(entry),
        supersedes_decision_id: decisionSupersedesIdFromEntry(entry),
        created_at: entry.created_at,
        source_envelope_ids: blackboardSourceEnvelopeIds(entry)
      };
      decisionHistory.push(decision);
      const proposal = ensureReplayProposal(proposals, proposalId, entry);
      proposal.decisions.push(decision);
      proposal.status = status;
      applyDecisionProjectionToProposal(proposal, decision);
      proposal.source_envelope_ids = uniqueStrings([...proposal.source_envelope_ids, ...decision.source_envelope_ids]);
      continue;
    }

    if (kind === "result" && proposalId) {
      const proposal = ensureReplayProposal(proposals, proposalId, entry);
      proposal.result_entry_ids = uniqueStrings([...proposal.result_entry_ids, entry.entry_id]);
      proposal.source_envelope_ids = uniqueStrings([...proposal.source_envelope_ids, ...blackboardSourceEnvelopeIds(entry)]);
    }
  }

  const unresolved = [...proposals.values()]
    .filter((proposal) => !proposal.decisions.some((decision) => isFinalBlackboardDecisionStatus(decision.status)))
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.proposal_id.localeCompare(right.proposal_id));
  return {
    decision_history: decisionHistory.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.entry_id.localeCompare(right.entry_id)),
    unresolved_proposals: unresolved
  };
}

function ensureReplayProposal(
  proposals: Map<string, ProtocolReplayBlackboardProposal>,
  proposalId: string,
  entry: BlackboardEntry
): ProtocolReplayBlackboardProposal {
  const existing = proposals.get(proposalId);
  if (existing) {
    return existing;
  }
  const metadata = entry.metadata ?? {};
  const proposal: ProtocolReplayBlackboardProposal = {
    proposal_id: proposalId,
    entry_id: entry.entry_id,
    key: entry.key,
    task_id: entry.task_id,
    proposed_by: actorLabel(entry.created_by),
    claim_key: stringField(metadata.claim_key),
    target_key: stringField(metadata.target_key),
    status: blackboardDecisionStatus(metadata.decision_status) ?? "proposed",
    policy: decisionPolicyFromEntry(entry),
    policy_status: decisionPolicyStatusFromEntry(entry),
    waiting_for: decisionWaitingForFromEntry(entry),
    votes: decisionVotesFromEntry(entry),
    outcome: decisionOutcomeFromEntry(entry),
    supersedes_decision_id: decisionSupersedesIdFromEntry(entry),
    created_at: entry.created_at,
    source_envelope_ids: blackboardSourceEnvelopeIds(entry),
    reviews: [],
    decisions: [],
    result_entry_ids: []
  };
  proposals.set(proposalId, proposal);
  return proposal;
}

function applyDecisionPolicyProjection(proposal: ProtocolReplayBlackboardProposal, entry: BlackboardEntry): void {
  proposal.policy = decisionPolicyFromEntry(entry) ?? proposal.policy;
  proposal.policy_status = decisionPolicyStatusFromEntry(entry) ?? proposal.policy_status;
  proposal.waiting_for = decisionWaitingForFromEntry(entry) ?? proposal.waiting_for;
  proposal.votes = decisionVotesFromEntry(entry) ?? proposal.votes;
  proposal.outcome = decisionOutcomeFromEntry(entry) ?? proposal.outcome;
  proposal.supersedes_decision_id = decisionSupersedesIdFromEntry(entry) ?? proposal.supersedes_decision_id;
}

function applyDecisionProjectionToProposal(
  proposal: ProtocolReplayBlackboardProposal,
  decision: ProtocolReplayBlackboardDecision
): void {
  proposal.policy = decision.policy ?? proposal.policy;
  proposal.policy_status = decision.policy_status ?? proposal.policy_status;
  proposal.waiting_for = decision.waiting_for ?? proposal.waiting_for;
  proposal.votes = decision.votes ?? proposal.votes;
  proposal.outcome = decision.outcome ?? proposal.outcome;
  proposal.supersedes_decision_id = decision.supersedes_decision_id ?? proposal.supersedes_decision_id;
}

function summarizeDeliveries(deliveries: EnvelopeDeliveryRecord[]): ProtocolReplayDeliverySummary {
  const byStatus: Partial<Record<EnvelopeDeliveryStatus, number>> = {};
  for (const delivery of deliveries) {
    byStatus[delivery.status] = (byStatus[delivery.status] ?? 0) + 1;
  }
  return {
    total: deliveries.length,
    by_status: byStatus,
    queued: byStatus.queued ?? 0,
    delivered: byStatus.delivered ?? 0,
    acked: byStatus.acked ?? 0,
    failed: byStatus.failed ?? 0,
    expired: byStatus.expired ?? 0,
    superseded: byStatus.superseded ?? 0
  };
}

function checkpointFromEnvelope(envelope: SwarmEnvelope): ProtocolReplayCheckpoint {
  const payload = recordPayload(envelope.payload);
  return {
    envelope_id: envelope.id,
    at: envelope.created_at,
    summary: stringField(payload.summary ?? payload.message),
    artifact: stringField(payload.artifact ?? payload.outputRef ?? payload.output_ref),
    payload: envelope.payload
  };
}

function resultFromEnvelope(envelope: SwarmEnvelope): ProtocolReplayResult {
  const payload = recordPayload(envelope.payload);
  return {
    envelope_id: envelope.id,
    at: envelope.created_at,
    status: stringField(payload.status),
    summary: stringField(payload.summary),
    content: stringField(payload.content ?? payload.result),
    output_ref: stringField(payload.outputRef ?? payload.output_ref),
    payload: envelope.payload
  };
}

function workerIdFromEnvelope(envelope: SwarmEnvelope): string | undefined {
  const payload = recordPayload(envelope.payload);
  const explicit = stringField(payload.worker_id ?? payload.workerId);
  if (explicit) {
    return explicit;
  }
  if (envelope.task_id?.startsWith("worker")) {
    return envelope.task_id;
  }
  const fromId = normalizeWorkerAgentId(envelope.from.agent_id);
  if (fromId) {
    return fromId;
  }
  const to = Array.isArray(envelope.to) ? envelope.to : [envelope.to];
  for (const address of to) {
    const workerId = normalizeWorkerAgentId(address.agent_id);
    if (workerId) {
      return workerId;
    }
  }
  return undefined;
}

function normalizeWorkerAgentId(agentId: string | undefined): string | undefined {
  if (!agentId) {
    return undefined;
  }
  if (agentId.startsWith("worker:")) {
    return agentId.slice("worker:".length);
  }
  return agentId.startsWith("worker") ? agentId : undefined;
}

function replayStatusFromWorkerStatus(status: WorkerStatus): ProtocolReplayTaskStatus {
  switch (status) {
    case "pending":
      return "assigned";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
  }
}

function compatibleSymphonyStatus(direct: string, replay: string): boolean {
  if (direct === replay) {
    return true;
  }
  if (direct === "running" && replay === "claimed") {
    return true;
  }
  return false;
}

function issue(
  severity: ProtocolMigrationAuditIssue["severity"],
  source: ProtocolMigrationAuditIssue["source"],
  id: string,
  code: string,
  message: string
): ProtocolMigrationAuditIssue {
  return { severity, source, id, code, message };
}

function isCheckpointEnvelope(envelope: SwarmEnvelope): boolean {
  if (envelope.type === "task.checkpoint") {
    return true;
  }
  const payload = recordPayload(envelope.payload);
  return envelope.intent.includes("checkpoint") ||
    stringField(payload.kind) === "checkpoint" ||
    stringField(payload.type) === "checkpoint" ||
    Boolean(payload.checkpoint);
}

function addressIncludes(address: AgentAddress | AgentAddress[], agentId: string): boolean {
  return (Array.isArray(address) ? address : [address]).some((item) => item.agent_id === agentId);
}

function addressLabelFromTo(address: AgentAddress | AgentAddress[]): string | undefined {
  const first = Array.isArray(address) ? address[0] : address;
  return first?.agent_id ?? first?.role ?? first?.capability;
}

function negotiationActionFromType(type: SwarmEnvelope["type"]): ProtocolReplayNegotiationAction | undefined {
  switch (type) {
    case "negotiation.propose":
      return "propose";
    case "negotiation.counter":
      return "counter";
    case "negotiation.accept":
      return "accept";
    case "negotiation.decline":
      return "decline";
    case "negotiation.delegate":
      return "delegate";
    case "negotiation.escalate":
      return "escalate";
    default:
      return undefined;
  }
}

type ReplaySquadAddress = AgentAddress & { capabilities?: string[] };

function squadActionFromType(type: SwarmEnvelope["type"]): ProtocolReplaySquadAction | undefined {
  switch (type) {
    case "squad.create":
      return "create";
    case "squad.join":
      return "join";
    case "squad.leave":
      return "leave";
    case "squad.role.assign":
      return "role.assign";
    case "squad.dissolve":
      return "dissolve";
    default:
      return undefined;
  }
}

function addressFromPayload(value: unknown): ReplaySquadAddress | undefined {
  if (!recordPayload(value)) {
    return undefined;
  }
  const record = recordPayload(value);
  const address: ReplaySquadAddress = {
    agent_id: stringField(record.agent_id ?? record.agentId ?? record.id),
    role: stringField(record.role ?? record.role_id ?? record.roleId),
    capability: stringField(record.capability),
    capabilities: stringArray(record.capabilities ?? record.required_capabilities ?? record.requiredCapabilities)
  };
  return address.agent_id || address.role || address.capability ? address : undefined;
}

function addressFromTo(address: AgentAddress | AgentAddress[]): ReplaySquadAddress | undefined {
  const first = Array.isArray(address) ? address[0] : address;
  return first
    ? {
        ...first,
        capabilities: first.capability ? [first.capability] : []
      }
    : undefined;
}

function squadMemberFromPayload(payload: Record<string, unknown>): ReplaySquadAddress | undefined {
  return addressFromPayload(payload.member ?? payload.member_agent ?? payload.memberAgent ?? payload.actor ?? payload.assignee ?? payload.agent);
}

function squadMembersFromPayload(payload: Record<string, unknown>): ReplaySquadAddress[] {
  const members = payload.members;
  return Array.isArray(members)
    ? members.map(addressFromPayload).filter((member): member is ReplaySquadAddress => Boolean(member))
    : [];
}

function squadRolesFromPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  const roles = payload.roles ?? payload.role_assignments ?? payload.roleAssignments;
  return Array.isArray(roles)
    ? roles.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function enrichSquadFromPayload(squad: ProtocolReplaySquad, payload: Record<string, unknown>): void {
  squad.risk_level = stringField(payload.risk_level ?? payload.riskLevel) ?? squad.risk_level;
  squad.cache_profile = payload.cache_profile ?? payload.cacheProfile ?? squad.cache_profile;
  squad.ownership_lease = payload.ownership_lease ?? payload.ownershipLease ?? squad.ownership_lease;
  squad.review_gate = payload.review_gate ?? payload.reviewGate ?? squad.review_gate;
  squad.final_result_aggregator = payload.final_result_aggregator ?? payload.finalResultAggregator ?? squad.final_result_aggregator;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : undefined;
  if (candidates) {
    squad.candidates = [
      ...(Array.isArray(squad.candidates) ? squad.candidates : []),
      ...candidates
    ];
  }
}

function squadIdFromBlackboardKey(key: string): string | undefined {
  const squadMatch = key.match(/^squad\/([^/]+)/u);
  if (squadMatch?.[1]) {
    return squadMatch[1];
  }
  const claimMatch = key.match(/^claim\/squad\/([^/]+)/u);
  return claimMatch?.[1];
}

function squadActionFromMetadata(
  metadata: NonNullable<BlackboardEntry["metadata"]>,
  tags: string[],
  value: Record<string, unknown>
): ProtocolReplaySquadAction | undefined {
  const raw = stringField(metadata.squad_action ?? metadata.squadAction ?? value.action ?? value.squad_action ?? value.squadAction) ??
    tags.find((tag) => ["create", "join", "leave", "role.assign", "dissolve"].includes(tag));
  return raw === "create" ||
    raw === "join" ||
    raw === "leave" ||
    raw === "role.assign" ||
    raw === "dissolve"
    ? raw
    : undefined;
}

function upsertSquadMember(
  squad: ProtocolReplaySquad,
  member: ReplaySquadAddress | AgentAddress,
  input: {
    role?: string;
    capabilities: string[];
    at: string;
    envelopeId: string;
  }
): void {
  const agentId = actorLabel(member);
  if (!agentId) {
    return;
  }
  const existing = squad.members.find((item) => item.agent_id === agentId);
  if (existing) {
    existing.role = input.role ?? member.role ?? existing.role;
    existing.capabilities = uniqueStrings([...existing.capabilities, ...input.capabilities, member.capability]);
    existing.status = "active";
    existing.joined_at = existing.joined_at ?? input.at;
    existing.source_envelope_ids = uniqueStrings([...existing.source_envelope_ids, input.envelopeId]);
    return;
  }
  squad.members.push({
    agent_id: agentId,
    role: input.role ?? member.role,
    capabilities: uniqueStrings([...input.capabilities, member.capability]),
    status: "active",
    joined_at: input.at,
    source_envelope_ids: [input.envelopeId]
  });
}

function markSquadMemberLeft(
  squad: ProtocolReplaySquad,
  agentId: string | undefined,
  at: string,
  envelopeId: string
): void {
  if (!agentId) {
    return;
  }
  const existing = squad.members.find((item) => item.agent_id === agentId);
  if (!existing) {
    squad.members.push({
      agent_id: agentId,
      capabilities: [],
      status: "left",
      left_at: at,
      source_envelope_ids: [envelopeId]
    });
    return;
  }
  existing.status = "left";
  existing.left_at = at;
  existing.source_envelope_ids = uniqueStrings([...existing.source_envelope_ids, envelopeId]);
}

function finalizeSquad(squad: ProtocolReplaySquad): ProtocolReplaySquad {
  return {
    ...squad,
    members: squad.members
      .map((member) => ({
        ...member,
        capabilities: uniqueStrings(member.capabilities),
        source_envelope_ids: uniqueStrings(member.source_envelope_ids)
      }))
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
    events: [...squad.events].sort((left, right) => left.at.localeCompare(right.at) || left.envelope_id.localeCompare(right.envelope_id)),
    source_envelope_ids: uniqueStrings(squad.source_envelope_ids)
  };
}

function actorLabel(address: AgentAddress): string | undefined {
  return address.agent_id ?? address.role ?? address.capability;
}

function capabilityFromAddress(address: AgentAddress | AgentAddress[]): string | undefined {
  const first = Array.isArray(address) ? address[0] : address;
  return first?.capability;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : undefined;
}

function stringArrayPreservingEmpty(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
}

function blackboardDecisionStatus(value: unknown): BlackboardDecisionStatus | undefined {
  return value === "proposed" ||
    value === "reviewed" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "superseded"
    ? value
    : undefined;
}

function isFinalBlackboardDecisionStatus(status: BlackboardDecisionStatus): boolean {
  return status === "accepted" || status === "rejected" || status === "superseded";
}

function proposalIdFromKey(key: string): string | undefined {
  const parts = key.split("/");
  return parts[0] === "proposal" && parts[1] ? parts[1] : undefined;
}

function blackboardSourceEnvelopeIds(entry: BlackboardEntry): string[] {
  return uniqueStrings([
    ...((stringArray(entry.metadata?.source_envelope_ids) ?? [])),
    stringField(entry.metadata?.source_envelope_id)
  ]);
}

function decisionPolicyFromEntry(entry: BlackboardEntry): BlackboardDecisionPolicy | undefined {
  const metadata = entry.metadata ?? {};
  const value = recordPayload(entry.value);
  return decisionPolicyFromUnknown(metadata.decision_policy) ??
    decisionPolicyFromUnknown(value.decision_policy ?? value.decisionPolicy ?? value.policy);
}

function decisionPolicyFromUnknown(value: unknown): BlackboardDecisionPolicy | undefined {
  const record = recordPayload(value);
  const mode = decisionPolicyMode(record.mode);
  if (!mode) {
    return undefined;
  }
  return compactPolicy({
    mode,
    risk_level: riskClass(record.risk_level ?? record.riskLevel ?? record.risk_class ?? record.riskClass),
    required_reviewers: stringArray(record.required_reviewers ?? record.requiredReviewers),
    quorum: positiveNumber(record.quorum),
    timeout_ms: positiveNumber(record.timeout_ms ?? record.timeoutMs),
    fallback_status: finalDecisionStatus(record.fallback_status ?? record.fallbackStatus),
    user_approval_required: typeof record.user_approval_required === "boolean" ? record.user_approval_required : undefined,
    reason: stringField(record.reason)
  });
}

function compactPolicy(policy: BlackboardDecisionPolicy): BlackboardDecisionPolicy {
  return Object.fromEntries(
    Object.entries(policy).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))
  ) as BlackboardDecisionPolicy;
}

function decisionPolicyMode(value: unknown): BlackboardDecisionPolicy["mode"] | undefined {
  return value === "single_owner" ||
    value === "reviewer_approval" ||
    value === "quorum" ||
    value === "user_approval" ||
    value === "timeout_fallback"
    ? value
    : undefined;
}

function decisionPolicyStatusFromEntry(entry: BlackboardEntry): BlackboardDecisionPolicyStatus | undefined {
  const metadata = entry.metadata ?? {};
  const value = recordPayload(entry.value);
  return decisionPolicyStatus(metadata.decision_policy_status) ??
    decisionPolicyStatus(value.decision_policy_status ?? value.decisionPolicyStatus);
}

function decisionPolicyStatus(value: unknown): BlackboardDecisionPolicyStatus | undefined {
  return value === "open" ||
    value === "waiting" ||
    value === "satisfied" ||
    value === "blocked" ||
    value === "timeout_fallback"
    ? value
    : undefined;
}

function decisionWaitingForFromEntry(entry: BlackboardEntry): string[] | undefined {
  const metadata = entry.metadata ?? {};
  const value = recordPayload(entry.value);
  return stringArrayPreservingEmpty(metadata.decision_waiting_for) ??
    stringArrayPreservingEmpty(value.decision_waiting_for ?? value.decisionWaitingFor);
}

function decisionVotesFromEntry(entry: BlackboardEntry): BlackboardDecisionVote[] | undefined {
  const metadata = entry.metadata ?? {};
  const value = recordPayload(entry.value);
  return decisionVotesFromUnknown(metadata.decision_votes) ??
    decisionVotesFromUnknown(value.decision_votes ?? value.decisionVotes ?? value.votes);
}

function decisionVotesFromUnknown(value: unknown): BlackboardDecisionVote[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const votes = value.map(decisionVoteFromUnknown).filter((vote): vote is BlackboardDecisionVote => Boolean(vote));
  return votes.length ? votes : undefined;
}

function decisionVoteFromUnknown(value: unknown): BlackboardDecisionVote | undefined {
  const record = recordPayload(value);
  const vote = stringField(record.vote ?? record.verdict);
  if (!vote) {
    return undefined;
  }
  return {
    voter: stringField(record.voter ?? record.agent_id ?? record.agentId ?? record.reviewer),
    vote,
    confidence: numberField(record.confidence),
    reason: stringField(record.reason),
    source_envelope_id: stringField(record.source_envelope_id ?? record.sourceEnvelopeId)
  };
}

function decisionOutcomeFromEntry(entry: BlackboardEntry): BlackboardDecisionOutcome | undefined {
  const metadata = entry.metadata ?? {};
  const value = recordPayload(entry.value);
  return decisionOutcomeFromUnknown(metadata.decision_outcome) ??
    decisionOutcomeFromUnknown(value.decision_outcome ?? value.decisionOutcome ?? value.outcome);
}

function decisionOutcomeFromUnknown(value: unknown): BlackboardDecisionOutcome | undefined {
  const record = recordPayload(value);
  const status = blackboardDecisionStatus(record.status);
  if (!status) {
    return undefined;
  }
  return {
    status,
    reason: stringField(record.reason),
    votes: decisionVotesFromUnknown(record.votes),
    policy_status: decisionPolicyStatus(record.policy_status ?? record.policyStatus),
    supersedes_decision_id: stringField(record.supersedes_decision_id ?? record.supersedesDecisionId)
  };
}

function decisionSupersedesIdFromEntry(entry: BlackboardEntry): string | undefined {
  const metadata = entry.metadata ?? {};
  const value = recordPayload(entry.value);
  const metadataOutcome = recordPayload(metadata.decision_outcome);
  const valueOutcome = recordPayload(value.decision_outcome ?? value.decisionOutcome ?? value.outcome);
  return stringField(metadataOutcome.supersedes_decision_id ?? metadataOutcome.supersedesDecisionId) ??
    stringField(valueOutcome.supersedes_decision_id ?? valueOutcome.supersedesDecisionId) ??
    stringField(metadata.supersedes_decision_id ?? metadata.supersedesDecisionId) ??
    stringField(value.supersedes_decision_id ?? value.supersedesDecisionId);
}

function riskClass(value: unknown): BlackboardDecisionPolicy["risk_level"] {
  return value === "r0" || value === "r1" || value === "r2" || value === "r3" || value === "r4"
    ? value
    : undefined;
}

function finalDecisionStatus(value: unknown): Extract<BlackboardDecisionStatus, "accepted" | "rejected" | "superseded"> | undefined {
  return value === "accepted" || value === "rejected" || value === "superseded" ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function assignString(
  handoff: ProtocolReplayHandoff,
  key: "worker_id" | "source_agent" | "target_agent_spec_id" | "reason" | "requester_agent_id" | "owner_agent_id" | "lease_expires_at" | "deadline_at",
  value: unknown
): void {
  const next = stringField(value);
  if (next) {
    handoff[key] = next;
  }
}

function assignNumber(
  handoff: ProtocolReplayHandoff,
  key: "lease_ttl_ms",
  value: unknown
): void {
  const next = numberField(value);
  if (next !== undefined) {
    handoff[key] = next;
  }
}

function assignStringArray(
  handoff: ProtocolReplayHandoff,
  key: "scope",
  value: unknown
): void {
  const next = stringArray(value);
  if (next) {
    handoff[key] = next;
  }
}
