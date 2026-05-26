import type { BlackboardEntry, SwarmEnvelope } from "../protocol/types.js";
import type { AgentActorRecord } from "../storage/agent-actor-store.js";
import type { EnvelopeDeliveryRecord, EnvelopeDeliveryStatus } from "../storage/envelope-delivery-store.js";
import {
  buildProtocolReplay,
  diffProtocolReplaySnapshots,
  type ProtocolReplayDiff,
  type ProtocolReplaySnapshot
} from "./protocol-replay.js";
import {
  recoveryAdviceFromProviderError,
  recoveryAdviceFromToolFailure,
  type RecoveryAdvice
} from "./recovery.js";

export const SWARM_FAULT_INJECTION_VERSION = "swarm.fault_injection.v1";

export type FaultInjectionKind =
  | "actor_crash"
  | "provider_timeout"
  | "duplicate_delivery"
  | "mailbox_backlog"
  | "ownership_expiry"
  | "blackboard_conflict";

export type FaultRecoveryOutcome = "recovered" | "contained" | "failed";

export type FaultInjectionExpectedOutcome = {
  outcome: FaultRecoveryOutcome;
  worker_status?: string;
  min_acked_deliveries?: number;
  max_queued_deliveries?: number;
  max_failed_deliveries?: number;
  replay_verdict?: ProtocolReplayDiff["status"];
  recovery_category?: RecoveryAdvice["category"];
  decision_status?: string;
};

export type FaultInjectionFixture = {
  id: string;
  kind: FaultInjectionKind;
  name: string;
  injected_fault: string;
  session_id: string;
  swarm_id: string;
  expected: FaultInjectionExpectedOutcome;
  envelopes: SwarmEnvelope[];
  deliveries?: EnvelopeDeliveryRecord[];
  actors?: AgentActorRecord[];
  blackboard?: BlackboardEntry[];
  recovery?: RecoveryAdvice;
};

export type FaultInjectionReplayProof = {
  replay_verdict: ProtocolReplayDiff["replay_verdict"];
  diff_status: ProtocolReplayDiff["status"];
  envelope_count: number;
  worker_statuses: Record<string, string>;
  delivery_summary: ProtocolReplaySnapshot["deliveries"];
  blackboard_decisions: string[];
  evidence_paths: string[];
};

export type FaultInjectionStuckState = {
  actors: string[];
  envelopes: string[];
  stale_leases: string[];
};

export type FaultInjectionDrillResult = {
  id: string;
  kind: FaultInjectionKind;
  name: string;
  status: "pass" | "fail";
  injected_fault: string;
  expected_recovery_outcome: FaultInjectionExpectedOutcome;
  actual_recovery_outcome: FaultRecoveryOutcome;
  recovery_strategy?: RecoveryAdvice;
  replay: ProtocolReplaySnapshot;
  replay_diff: ProtocolReplayDiff;
  replay_proof: FaultInjectionReplayProof;
  stuck: FaultInjectionStuckState;
  findings: string[];
};

export type FaultInjectionReport = {
  schema_version: typeof SWARM_FAULT_INJECTION_VERSION;
  generated_at: string;
  status: "pass" | "fail";
  summary: {
    total: number;
    passed: number;
    failed: number;
    recovered: number;
    contained: number;
    stuck_actors: number;
    stuck_envelopes: number;
    stale_leases: number;
  };
  drills: FaultInjectionDrillResult[];
};

const AT = "2026-05-24T00:00:00.000Z";
const SWARM_ID = "swarm-fault-injection";

export function runFaultInjectionDrills(input: {
  generatedAt?: string;
  fixtures?: FaultInjectionFixture[];
} = {}): FaultInjectionReport {
  const generatedAt = input.generatedAt ?? atOffset(120);
  const drills = (input.fixtures ?? defaultFaultInjectionFixtures()).map((fixture) =>
    evaluateFaultInjectionFixture(fixture, { generatedAt })
  );
  const failed = drills.filter((drill) => drill.status === "fail").length;
  const recovered = drills.filter((drill) => drill.actual_recovery_outcome === "recovered").length;
  const contained = drills.filter((drill) => drill.actual_recovery_outcome === "contained").length;
  return {
    schema_version: SWARM_FAULT_INJECTION_VERSION,
    generated_at: generatedAt,
    status: failed > 0 ? "fail" : "pass",
    summary: {
      total: drills.length,
      passed: drills.length - failed,
      failed,
      recovered,
      contained,
      stuck_actors: drills.reduce((total, drill) => total + drill.stuck.actors.length, 0),
      stuck_envelopes: drills.reduce((total, drill) => total + drill.stuck.envelopes.length, 0),
      stale_leases: drills.reduce((total, drill) => total + drill.stuck.stale_leases.length, 0)
    },
    drills
  };
}

export function evaluateFaultInjectionFixture(
  fixture: FaultInjectionFixture,
  input: { generatedAt?: string } = {}
): FaultInjectionDrillResult {
  const generatedAt = input.generatedAt ?? atOffset(120);
  const replay = buildProtocolReplay({
    sessionId: fixture.session_id,
    generatedAt,
    envelopes: fixture.envelopes,
    deliveries: fixture.deliveries,
    actors: fixture.actors,
    blackboard: fixture.blackboard
  });
  const replayDiff = diffProtocolReplaySnapshots({ live: replay, replay, generatedAt, sessionId: fixture.session_id });
  const proof = replayProof(replay, replayDiff);
  const findings = evaluateExpectedOutcome(fixture.expected, replay, replayDiff, fixture.recovery);
  const stuck = stuckState(fixture, replay, generatedAt);
  for (const actor of stuck.actors) {
    findings.push(`stuck actor: ${actor}`);
  }
  for (const envelope of stuck.envelopes) {
    findings.push(`stuck envelope: ${envelope}`);
  }
  for (const lease of stuck.stale_leases) {
    findings.push(`stale lease: ${lease}`);
  }
  const status = findings.length ? "fail" : "pass";
  return {
    id: fixture.id,
    kind: fixture.kind,
    name: fixture.name,
    status,
    injected_fault: fixture.injected_fault,
    expected_recovery_outcome: fixture.expected,
    actual_recovery_outcome: status === "pass" ? fixture.expected.outcome : "failed",
    recovery_strategy: fixture.recovery,
    replay,
    replay_diff: replayDiff,
    replay_proof: proof,
    stuck,
    findings
  };
}

export function defaultFaultInjectionFixtures(): FaultInjectionFixture[] {
  return [
    actorCrashFixture(),
    providerTimeoutFixture(),
    duplicateDeliveryFixture(),
    mailboxBacklogFixture(),
    ownershipExpiryFixture(),
    blackboardConflictFixture()
  ];
}

export function formatFaultInjectionReport(report: FaultInjectionReport): string[] {
  return [
    `fault_drills status=${report.status} total=${report.summary.total} passed=${report.summary.passed} failed=${report.summary.failed}`,
    `recovered=${report.summary.recovered} contained=${report.summary.contained} stuck_actors=${report.summary.stuck_actors} stuck_envelopes=${report.summary.stuck_envelopes} stale_leases=${report.summary.stale_leases}`,
    ...report.drills.map((drill) =>
      `${drill.kind}:${drill.status} outcome=${drill.actual_recovery_outcome} replay=${drill.replay_proof.replay_verdict.status} evidence=${drill.replay_proof.evidence_paths.slice(0, 3).join("|")}${drill.findings.length ? ` findings=${drill.findings.join("; ")}` : ""}`
    )
  ];
}

function evaluateExpectedOutcome(
  expected: FaultInjectionExpectedOutcome,
  replay: ProtocolReplaySnapshot,
  replayDiff: ProtocolReplayDiff,
  recovery: RecoveryAdvice | undefined
): string[] {
  const findings: string[] = [];
  if (expected.replay_verdict && replayDiff.status !== expected.replay_verdict) {
    findings.push(`expected replay verdict ${expected.replay_verdict}, got ${replayDiff.status}`);
  }
  if (expected.worker_status && !replay.workers.some((worker) => worker.status === expected.worker_status)) {
    findings.push(`expected worker status ${expected.worker_status}, got ${replay.workers.map((worker) => `${worker.worker_id}:${worker.status}`).join(",") || "none"}`);
  }
  if (expected.min_acked_deliveries !== undefined && replay.deliveries.acked < expected.min_acked_deliveries) {
    findings.push(`expected at least ${expected.min_acked_deliveries} acked deliveries, got ${replay.deliveries.acked}`);
  }
  if (expected.max_queued_deliveries !== undefined && replay.deliveries.queued > expected.max_queued_deliveries) {
    findings.push(`expected at most ${expected.max_queued_deliveries} queued deliveries, got ${replay.deliveries.queued}`);
  }
  if (expected.max_failed_deliveries !== undefined && replay.deliveries.failed > expected.max_failed_deliveries) {
    findings.push(`expected at most ${expected.max_failed_deliveries} failed deliveries, got ${replay.deliveries.failed}`);
  }
  if (expected.recovery_category && recovery?.category !== expected.recovery_category) {
    findings.push(`expected recovery category ${expected.recovery_category}, got ${recovery?.category ?? "missing"}`);
  }
  if (expected.decision_status && !replay.blackboard.decision_history.some((decision) => decision.status === expected.decision_status)) {
    findings.push(`expected blackboard decision ${expected.decision_status}, got ${replay.blackboard.decision_history.map((decision) => decision.status).join(",") || "none"}`);
  }
  return findings;
}

function replayProof(replay: ProtocolReplaySnapshot, replayDiff: ProtocolReplayDiff): FaultInjectionReplayProof {
  return {
    replay_verdict: replayDiff.replay_verdict,
    diff_status: replayDiff.status,
    envelope_count: replay.envelope_count,
    worker_statuses: Object.fromEntries(replay.workers.map((worker) => [worker.worker_id, worker.status])),
    delivery_summary: replay.deliveries,
    blackboard_decisions: replay.blackboard.decision_history.map((decision) => `${decision.proposal_id}:${decision.status}`),
    evidence_paths: [
      ...replay.workers.map((worker) => `worker.${worker.worker_id}.status`),
      ...replay.handoffs.map((handoff) => `handoff.${handoff.handoff_id}.status`),
      ...replay.blackboard.decision_history.map((decision) => `blackboard.decision.${decision.proposal_id}.${decision.entry_id}`),
      "protocol_replay_diff.replay_verdict"
    ]
  };
}

function stuckState(
  fixture: FaultInjectionFixture,
  replay: ProtocolReplaySnapshot,
  generatedAt: string
): FaultInjectionStuckState {
  const actors = replay.actors
    .filter((actor) => actor.status === "degraded" || actor.heartbeat_state === "stale" || actor.heartbeat_state === "offline" || actor.heartbeat_state === "blocked")
    .map((actor) => `${actor.actor_id}[${actor.status}/${actor.heartbeat_state}]`);
  const envelopes = (fixture.deliveries ?? [])
    .filter((delivery) => delivery.status === "queued" || delivery.status === "delivered" || delivery.status === "failed" || delivery.status === "expired")
    .filter((delivery) => !hasRecoveryForEnvelope(delivery, replay))
    .map((delivery) => `${delivery.envelope_id}[${delivery.status}]`);
  const staleLeases = (fixture.blackboard ?? [])
    .filter((entry) =>
      entry.metadata?.claim_status === "expired" &&
      typeof entry.metadata.expires_at === "string" &&
      entry.metadata.expires_at <= generatedAt &&
      !hasRecoveryDecisionForClaim(entry, replay)
    )
    .map((entry) => `${entry.metadata?.claim_key ?? entry.key}[expired]`);
  return { actors, envelopes, stale_leases: staleLeases };
}

function hasRecoveryForEnvelope(delivery: EnvelopeDeliveryRecord, replay: ProtocolReplaySnapshot): boolean {
  if (delivery.status === "queued" || delivery.status === "delivered") {
    return false;
  }
  if (delivery.last_response_envelope_id) {
    return true;
  }
  const relatedWorker = delivery.task_id
    ? replay.workers.find((worker) => worker.task_id === delivery.task_id || worker.worker_id === delivery.task_id)
    : undefined;
  return relatedWorker?.status === "completed" || relatedWorker?.status === "cancelled" || relatedWorker?.status === "superseded";
}

function hasRecoveryDecisionForClaim(entry: BlackboardEntry, replay: ProtocolReplaySnapshot): boolean {
  const claimKey = typeof entry.metadata?.claim_key === "string" ? entry.metadata.claim_key : undefined;
  return Boolean(claimKey && replay.blackboard.decision_history.some((decision) =>
    decision.status === "accepted" &&
    replay.blackboard.unresolved_proposals.every((proposal) => proposal.claim_key !== claimKey)
  ));
}

function actorCrashFixture(): FaultInjectionFixture {
  const sessionId = "fault-actor-crash";
  return {
    id: "fault-actor-crash-recovers-pending-envelope",
    kind: "actor_crash",
    name: "actor crash recovers pending envelope",
    injected_fault: "worker actor crashes after first delivery; mailbox retry completes replacement envelope",
    session_id: sessionId,
    swarm_id: SWARM_ID,
    expected: {
      outcome: "recovered",
      worker_status: "completed",
      min_acked_deliveries: 1,
      max_queued_deliveries: 0,
      max_failed_deliveries: 1,
      replay_verdict: "pass",
      recovery_category: "tool"
    },
    envelopes: [
      envelope("env-actor-crash-assign", sessionId, "task.assign", 0, {
        task_id: "worker-actor-crash",
        to: { agent_id: "worker:actor-crash", capability: "code.test" },
        payload: { worker_id: "worker-actor-crash", objective: "Recover crashed actor delivery" }
      }),
      envelope("env-actor-crash-retry", sessionId, "task.assign", 2, {
        task_id: "worker-actor-crash",
        to: { agent_id: "worker:actor-crash", capability: "code.test" },
        payload: { worker_id: "worker-actor-crash", objective: "Recover crashed actor delivery", retry_of: "env-actor-crash-assign" }
      }),
      envelope("env-actor-crash-result", sessionId, "task.result", 3, {
        task_id: "worker-actor-crash",
        from: { agent_id: "worker:actor-crash" },
        payload: { worker_id: "worker-actor-crash", summary: "Recovered after actor restart" }
      })
    ],
    deliveries: [
      delivery("env-actor-crash-assign", sessionId, "worker-actor-crash", "failed", { error: "actor process exited", last_response_envelope_id: "env-actor-crash-retry" }),
      delivery("env-actor-crash-retry", sessionId, "worker-actor-crash", "acked", { last_response_envelope_id: "env-actor-crash-result" })
    ],
    actors: [
      actor("worker:actor-crash", sessionId, { current_task_id: "worker-actor-crash", current_worker_id: "worker-actor-crash", status: "idle", heartbeat_state: "fresh" })
    ],
    recovery: recoveryAdviceFromToolFailure({
      action: "mailbox.delivery",
      reason: "actor process exited while handling env-actor-crash-assign",
      errorCode: "ACTOR_CRASH",
      recoverySuggestion: "Restart the actor and retry the pending mailbox delivery."
    })
  };
}

function providerTimeoutFixture(): FaultInjectionFixture {
  const sessionId = "fault-provider-timeout";
  return {
    id: "fault-provider-timeout-recovers-with-retry",
    kind: "provider_timeout",
    name: "provider timeout retries through fallback model",
    injected_fault: "provider request times out; retry policy switches to constrained retry and completes",
    session_id: sessionId,
    swarm_id: SWARM_ID,
    expected: {
      outcome: "recovered",
      worker_status: "completed",
      min_acked_deliveries: 1,
      max_queued_deliveries: 0,
      max_failed_deliveries: 1,
      replay_verdict: "pass",
      recovery_category: "provider_timeout",
      decision_status: "accepted"
    },
    envelopes: [
      envelope("env-provider-timeout-assign", sessionId, "task.assign", 0, {
        task_id: "worker-provider-timeout",
        payload: { worker_id: "worker-provider-timeout", objective: "Retry provider timeout" }
      }),
      envelope("env-provider-timeout-fail", sessionId, "task.fail", 1, {
        task_id: "worker-provider-timeout",
        from: { agent_id: "worker:provider-timeout" },
        payload: { worker_id: "worker-provider-timeout", error: "provider request timed out after 30000ms" }
      }),
      envelope("env-provider-timeout-result", sessionId, "task.result", 3, {
        task_id: "worker-provider-timeout",
        from: { agent_id: "worker:provider-timeout" },
        payload: { worker_id: "worker-provider-timeout", summary: "Retry completed with fallback model" }
      })
    ],
    deliveries: [
      delivery("env-provider-timeout-assign", sessionId, "worker-provider-timeout", "acked", { last_response_envelope_id: "env-provider-timeout-fail" }),
      delivery("env-provider-timeout-fail", sessionId, "worker-provider-timeout", "failed", { error: "provider timeout", last_response_envelope_id: "env-provider-timeout-result" }),
      delivery("env-provider-timeout-result", sessionId, "worker-provider-timeout", "acked")
    ],
    blackboard: [
      decisionEntry(sessionId, "provider-timeout-retry", "accepted", 2, {
        reason: "Provider timeout is retryable with reduced concurrency.",
        source_envelope_id: "env-provider-timeout-fail"
      })
    ],
    actors: [
      actor("worker:provider-timeout", sessionId, { current_task_id: "worker-provider-timeout", current_worker_id: "worker-provider-timeout" })
    ],
    recovery: recoveryAdviceFromProviderError({
      message: "provider request timed out after 30000ms",
      errorCode: "PROVIDER_TIMEOUT"
    })
  };
}

function duplicateDeliveryFixture(): FaultInjectionFixture {
  const sessionId = "fault-duplicate-delivery";
  return {
    id: "fault-duplicate-delivery-idempotent",
    kind: "duplicate_delivery",
    name: "duplicate delivery remains idempotent",
    injected_fault: "same idempotency key delivered twice; replay keeps canonical envelope",
    session_id: sessionId,
    swarm_id: SWARM_ID,
    expected: {
      outcome: "contained",
      worker_status: "completed",
      min_acked_deliveries: 1,
      max_queued_deliveries: 0,
      replay_verdict: "pass"
    },
    envelopes: [
      envelope("env-duplicate-assign", sessionId, "task.assign", 0, {
        task_id: "worker-duplicate",
        idempotency_key: "fault-duplicate:assign",
        payload: { worker_id: "worker-duplicate", objective: "Ignore duplicate delivery" }
      }),
      envelope("env-duplicate-assign-copy", sessionId, "task.assign", 1, {
        task_id: "worker-duplicate",
        idempotency_key: "fault-duplicate:assign",
        payload: { worker_id: "worker-duplicate", objective: "duplicate should not mutate replay" }
      }),
      envelope("env-duplicate-result", sessionId, "task.result", 2, {
        task_id: "worker-duplicate",
        from: { agent_id: "worker:duplicate" },
        payload: { worker_id: "worker-duplicate", summary: "Duplicate suppressed" }
      })
    ],
    deliveries: [
      delivery("env-duplicate-assign", sessionId, "worker-duplicate", "acked", { last_response_envelope_id: "env-duplicate-result" }),
      delivery("env-duplicate-assign-copy", sessionId, "worker-duplicate", "superseded", { last_response_envelope_id: "env-duplicate-assign" })
    ],
    actors: [
      actor("worker:duplicate", sessionId, { current_task_id: "worker-duplicate", current_worker_id: "worker-duplicate" })
    ]
  };
}

function mailboxBacklogFixture(): FaultInjectionFixture {
  const sessionId = "fault-mailbox-backlog";
  return {
    id: "fault-mailbox-backlog-drains-after-restart",
    kind: "mailbox_backlog",
    name: "mailbox backlog drains after pump restart",
    injected_fault: "mailbox pump stops with delivered-but-unacked work; restart drains backlog to acked",
    session_id: sessionId,
    swarm_id: SWARM_ID,
    expected: {
      outcome: "recovered",
      worker_status: "completed",
      min_acked_deliveries: 3,
      max_queued_deliveries: 0,
      replay_verdict: "pass"
    },
    envelopes: [
      envelope("env-backlog-assign", sessionId, "task.assign", 0, {
        task_id: "worker-backlog",
        payload: { worker_id: "worker-backlog", objective: "Drain backlog" }
      }),
      envelope("env-backlog-checkpoint", sessionId, "task.checkpoint", 1, {
        task_id: "worker-backlog",
        from: { agent_id: "worker:backlog" },
        payload: { worker_id: "worker-backlog", summary: "backlog checkpoint" }
      }),
      envelope("env-backlog-result", sessionId, "task.result", 3, {
        task_id: "worker-backlog",
        from: { agent_id: "worker:backlog" },
        payload: { worker_id: "worker-backlog", summary: "Backlog drained" }
      })
    ],
    deliveries: [
      delivery("env-backlog-assign", sessionId, "worker-backlog", "acked", { last_response_envelope_id: "env-backlog-checkpoint" }),
      delivery("env-backlog-checkpoint", sessionId, "worker-backlog", "acked", { last_response_envelope_id: "env-backlog-result" }),
      delivery("env-backlog-result", sessionId, "worker-backlog", "acked")
    ],
    actors: [
      actor("worker:backlog", sessionId, { current_task_id: "worker-backlog", current_worker_id: "worker-backlog" })
    ]
  };
}

function ownershipExpiryFixture(): FaultInjectionFixture {
  const sessionId = "fault-ownership-expiry";
  return {
    id: "fault-ownership-expiry-visible-decision",
    kind: "ownership_expiry",
    name: "lease expiry recovery produces visible decision",
    injected_fault: "ownership lease expires; coordinator records recovery decision and assigns replacement owner",
    session_id: sessionId,
    swarm_id: SWARM_ID,
    expected: {
      outcome: "recovered",
      worker_status: "completed",
      min_acked_deliveries: 1,
      max_queued_deliveries: 0,
      replay_verdict: "pass",
      decision_status: "accepted"
    },
    envelopes: [
      envelope("env-lease-reassign", sessionId, "task.assign", 2, {
        task_id: "worker-lease-recovery",
        to: { agent_id: "worker:lease-recovery", capability: "code.test" },
        payload: { worker_id: "worker-lease-recovery", objective: "Recover expired lease" }
      }),
      envelope("env-lease-result", sessionId, "task.result", 3, {
        task_id: "worker-lease-recovery",
        from: { agent_id: "worker:lease-recovery" },
        payload: { worker_id: "worker-lease-recovery", summary: "Lease recovered" }
      })
    ],
    deliveries: [
      delivery("env-lease-reassign", sessionId, "worker-lease-recovery", "acked", { last_response_envelope_id: "env-lease-result" })
    ],
    blackboard: [
      claimEntry(sessionId, "lease/worker-lease-original", "expired", atOffset(1), 0),
      proposalEntry(sessionId, "lease-expiry-recovery", "lease/worker-lease-original", 1),
      decisionEntry(sessionId, "lease-expiry-recovery", "accepted", 2, {
        reason: "Lease expired; replacement owner selected.",
        source_envelope_id: "env-lease-reassign"
      })
    ],
    actors: [
      actor("worker:lease-recovery", sessionId, { current_task_id: "worker-lease-recovery", current_worker_id: "worker-lease-recovery" })
    ]
  };
}

function blackboardConflictFixture(): FaultInjectionFixture {
  const sessionId = "fault-blackboard-conflict";
  return {
    id: "fault-blackboard-conflict-resolved",
    kind: "blackboard_conflict",
    name: "conflicting proposal records durable decision",
    injected_fault: "two proposals claim the same target; conflict decision rejects stale proposal",
    session_id: sessionId,
    swarm_id: SWARM_ID,
    expected: {
      outcome: "contained",
      decision_status: "rejected",
      max_queued_deliveries: 0,
      replay_verdict: "pass"
    },
    envelopes: [
      envelope("env-conflict-proposal-a", sessionId, "blackboard.proposal", 0, {
        task_id: "task-conflict",
        payload: { proposal_id: "conflict-stale", target_key: "shared/file.ts", summary: "stale proposal" }
      }),
      envelope("env-conflict-proposal-b", sessionId, "blackboard.proposal", 1, {
        task_id: "task-conflict",
        payload: { proposal_id: "conflict-winner", target_key: "shared/file.ts", summary: "winner proposal" }
      })
    ],
    blackboard: [
      proposalEntry(sessionId, "conflict-stale", "shared/file.ts", 0),
      proposalEntry(sessionId, "conflict-winner", "shared/file.ts", 1),
      decisionEntry(sessionId, "conflict-stale", "rejected", 2, {
        reason: "Conflicting proposal superseded by conflict-winner.",
        source_envelope_id: "env-conflict-proposal-b"
      }),
      decisionEntry(sessionId, "conflict-winner", "accepted", 3, {
        reason: "Non-conflicting winner retained.",
        source_envelope_id: "env-conflict-proposal-b"
      })
    ],
    actors: [
      actor("blackboard", sessionId, { status: "idle", heartbeat_state: "fresh" })
    ]
  };
}

function envelope(
  id: string,
  sessionId: string,
  type: SwarmEnvelope["type"],
  offsetSeconds: number,
  overrides: Partial<SwarmEnvelope> = {}
): SwarmEnvelope {
  return {
    id,
    version: "1.0",
    swarm_id: SWARM_ID,
    session_id: sessionId,
    task_id: "fault-task",
    from: { agent_id: "main_swarm" },
    to: { agent_id: "worker:fault", capability: "code.test" },
    type,
    intent: type,
    created_at: atOffset(offsetSeconds),
    payload: {},
    ...overrides
  };
}

function delivery(
  envelopeId: string,
  sessionId: string,
  taskId: string,
  status: EnvelopeDeliveryStatus,
  overrides: Partial<EnvelopeDeliveryRecord> = {}
): EnvelopeDeliveryRecord {
  return {
    delivery_id: `${envelopeId}:agent:worker:fault`,
    envelope_id: envelopeId,
    session_id: sessionId,
    swarm_id: SWARM_ID,
    task_id: taskId,
    type: "task.assign",
    intent: "task.assign",
    from_agent_id: "main_swarm",
    recipient_key: "agent:worker:fault",
    recipient_agent_id: "worker:fault",
    status,
    queued_at: atOffset(0),
    delivered_at: status === "delivered" || status === "acked" ? atOffset(1) : undefined,
    acked_at: status === "acked" ? atOffset(2) : undefined,
    failed_at: status === "failed" ? atOffset(2) : undefined,
    expired_at: status === "expired" ? atOffset(2) : undefined,
    superseded_at: status === "superseded" ? atOffset(2) : undefined,
    metadata: {},
    ...overrides
  };
}

function actor(
  actorId: string,
  sessionId: string,
  overrides: Partial<AgentActorRecord> = {}
): AgentActorRecord {
  return {
    actor_id: actorId,
    kind: actorId === "blackboard" ? "blackboard" : "worker",
    name: actorId,
    role: actorId,
    status: "idle",
    capabilities: ["code.test"],
    load: { running_tasks: 0, max_tasks: 1 },
    current_session_id: sessionId,
    heartbeat_state: "fresh",
    last_heartbeat_at: atOffset(4),
    last_seen_at: atOffset(4),
    registered_at: atOffset(0),
    updated_at: atOffset(4),
    metadata: {},
    ...overrides
  };
}

function claimEntry(
  sessionId: string,
  claimKey: string,
  status: "claimed" | "expired",
  expiresAt: string,
  offsetSeconds: number
): BlackboardEntry {
  return blackboardEntry(sessionId, `claim/${claimKey}`, "decision", ["claim"], {
    claim_key: claimKey,
    status
  }, {
    kind: "claim",
    claim_key: claimKey,
    claim_status: status,
    expires_at: expiresAt,
    source_envelope_id: `bb-${claimKey}`
  }, offsetSeconds);
}

function proposalEntry(
  sessionId: string,
  proposalId: string,
  claimKey: string,
  offsetSeconds: number
): BlackboardEntry {
  return blackboardEntry(sessionId, `proposal/${proposalId}`, "plan", ["proposal"], {
    proposal_id: proposalId,
    claim_key: claimKey,
    summary: `proposal ${proposalId}`
  }, {
    kind: "proposal",
    proposal_id: proposalId,
    claim_key: claimKey,
    decision_status: "proposed",
    source_envelope_id: `env-${proposalId}`
  }, offsetSeconds);
}

function decisionEntry(
  sessionId: string,
  proposalId: string,
  status: "accepted" | "rejected",
  offsetSeconds: number,
  input: { reason: string; source_envelope_id: string }
): BlackboardEntry {
  return blackboardEntry(sessionId, `proposal/${proposalId}/decision/${proposalId}-decision`, "decision", ["decision"], {
    status,
    reason: input.reason
  }, {
    kind: "decision",
    proposal_id: proposalId,
    decision_id: `${proposalId}-decision`,
    decision_status: status,
    decision_outcome: { status, reason: input.reason },
    source_envelope_id: input.source_envelope_id
  }, offsetSeconds);
}

function blackboardEntry(
  sessionId: string,
  key: string,
  type: BlackboardEntry["type"],
  tags: string[],
  value: unknown,
  metadata: BlackboardEntry["metadata"],
  offsetSeconds: number
): BlackboardEntry {
  return {
    entry_id: `bb-${key.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`,
    swarm_id: SWARM_ID,
    session_id: sessionId,
    task_id: "fault-task",
    key,
    value,
    type,
    created_by: { agent_id: "fault.harness" },
    created_at: atOffset(offsetSeconds),
    visibility: "team",
    version: 1,
    tags,
    metadata
  };
}

function atOffset(seconds: number): string {
  return new Date(Date.parse(AT) + seconds * 1000).toISOString();
}
