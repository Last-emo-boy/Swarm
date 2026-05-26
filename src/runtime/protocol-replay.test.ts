import { strict as assert } from "node:assert";
import test from "node:test";
import type { BlackboardEntry, SwarmEnvelope } from "../protocol/types.js";
import type { AgentActorRecord } from "../storage/agent-actor-store.js";
import type { EnvelopeDeliveryRecord, EnvelopeDeliveryStatus } from "../storage/envelope-delivery-store.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { SymphonyClaimRecord } from "../storage/symphony-claim-store.js";
import type { WorkerRecord, WorkerStatus } from "../storage/worker-state-store.js";
import {
  auditProtocolMigration,
  buildProtocolReplay,
  diffProtocolReplaySnapshots,
  formatProtocolMigrationAudit,
  SWARM_PROTOCOL_REPLAY_VERSION
} from "./protocol-replay.js";

const AT = "2026-05-24T00:00:00.000Z";
const SESSION_ID = "session-protocol-replay";
const SWARM_ID = "swarm-protocol-replay";

test("protocol replay is deterministic", () => {
  const input = {
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-deterministic-result", "task.result", {
        created_at: atOffset(4),
        from: { agent_id: "worker:worker-deterministic" },
        task_id: "worker-deterministic",
        payload: { worker_id: "worker-deterministic", summary: "done" }
      }),
      envelope("env-deterministic-assign", "task.assign", {
        created_at: atOffset(0),
        task_id: "worker-deterministic",
        payload: { worker_id: "worker-deterministic", objective: "Replay deterministically" }
      }),
      envelope("env-deterministic-start", "task.start", {
        created_at: atOffset(2),
        from: { agent_id: "worker:worker-deterministic" },
        task_id: "worker-deterministic",
        payload: { worker_id: "worker-deterministic", summary: "started" }
      })
    ],
    deliveries: [
      delivery("env-deterministic-result", "acked"),
      delivery("env-deterministic-assign", "queued")
    ],
    actors: [
      actor({
        actor_id: "worker:worker-deterministic",
        current_task_id: "worker-deterministic",
        current_worker_id: "worker-deterministic"
      })
    ],
    blackboard: [
      blackboard("bb-deterministic-decision", "proposal/deterministic/decision/1", "decision", ["decision"], { status: "accepted" }, {
        kind: "decision",
        proposal_id: "deterministic",
        decision_status: "accepted",
        source_envelope_id: "env-deterministic-result"
      }, atOffset(3))
    ]
  };

  assert.deepEqual(buildProtocolReplay(input), buildProtocolReplay({
    ...input,
    envelopes: [...input.envelopes].reverse(),
    deliveries: [...input.deliveries].reverse(),
    actors: [...input.actors].reverse(),
    blackboard: [...input.blackboard].reverse()
  }));
});

test("replay handles duplicate and out-of-order envelopes", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-replay-result-duplicate", "task.result", {
        created_at: atOffset(5),
        from: { agent_id: "worker:worker-replay" },
        task_id: "worker-replay",
        idempotency_key: "worker-replay:result",
        payload: { worker_id: "worker-replay", summary: "duplicate result should be ignored" }
      }),
      envelope("env-replay-result", "task.result", {
        created_at: atOffset(4),
        from: { agent_id: "worker:worker-replay" },
        task_id: "worker-replay",
        idempotency_key: "worker-replay:result",
        payload: { worker_id: "worker-replay", summary: "canonical result" }
      }),
      envelope("env-replay-start", "task.start", {
        created_at: atOffset(2),
        from: { agent_id: "worker:worker-replay" },
        task_id: "worker-replay",
        payload: { worker_id: "worker-replay", summary: "started" }
      }),
      envelope("env-replay-assign", "task.assign", {
        created_at: atOffset(0),
        task_id: "worker-replay",
        idempotency_key: "worker-replay:assign",
        payload: { worker_id: "worker-replay", objective: "Tolerate replay duplicates" }
      }),
      envelope("env-replay-assign", "task.assign", {
        created_at: atOffset(1),
        task_id: "worker-replay",
        idempotency_key: "worker-replay:assign",
        payload: { worker_id: "worker-replay", objective: "duplicate id should be ignored" }
      })
    ],
    deliveries: [
      delivery("env-replay-result", "superseded"),
      delivery("env-replay-assign", "expired"),
      delivery("env-replay-result", "acked")
    ]
  });

  assert.equal(replay.envelope_count, 3);
  assert.equal(replay.workers.length, 1);
  assert.equal(replay.workers[0]?.status, "completed");
  assert.equal(replay.workers[0]?.result?.summary, "canonical result");
  assert.deepEqual(replay.workers[0]?.source_envelope_ids, [
    "env-replay-assign",
    "env-replay-start",
    "env-replay-result"
  ]);
  assert.equal(replay.deliveries.total, 2);
  assert.equal(replay.deliveries.acked, 1);
  assert.equal(replay.deliveries.expired, 1);
});

test("protocol replay rebuilds worker assignment, checkpoint, ownership, and final result", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-worker-assign", "task.assign", {
        created_at: atOffset(0),
        task_id: "worker-1",
        to: { agent_id: "worker:worker-1", capability: "code.test" },
        payload: {
          worker_id: "worker-1",
          capability: "code.test",
          objective: "Write protocol replay tests"
        }
      }),
      envelope("env-worker-accept", "task.accept", {
        created_at: atOffset(1),
        from: { agent_id: "worker:worker-1" },
        task_id: "worker-1",
        payload: { worker_id: "worker-1", summary: "accepted" }
      }),
      envelope("env-worker-start", "task.start", {
        created_at: atOffset(2),
        from: { agent_id: "worker:worker-1" },
        task_id: "worker-1",
        payload: { worker_id: "worker-1", summary: "started" }
      }),
      envelope("env-worker-checkpoint", "task.checkpoint", {
        created_at: atOffset(3),
        from: { agent_id: "worker:worker-1" },
        task_id: "worker-1",
        payload: {
          worker_id: "worker-1",
          summary: "tests added",
          output_ref: "artifact://checkpoint"
        }
      }),
      envelope("env-worker-result", "task.result", {
        created_at: atOffset(4),
        from: { agent_id: "worker:worker-1" },
        task_id: "worker-1",
        payload: {
          worker_id: "worker-1",
          status: "completed",
          summary: "done",
          outputRef: "artifact://result"
        }
      })
    ],
    deliveries: [
      delivery("env-worker-assign", "queued"),
      delivery("env-worker-result", "acked")
    ],
    actors: [
      actor({
        actor_id: "worker:worker-1",
        current_task_id: "worker-1",
        current_worker_id: "worker-1",
        status: "busy"
      })
    ]
  });

  assert.equal(replay.schema_version, SWARM_PROTOCOL_REPLAY_VERSION);
  assert.equal(replay.envelope_count, 5);
  assert.equal(replay.deliveries.total, 2);
  assert.equal(replay.deliveries.queued, 1);
  assert.equal(replay.deliveries.acked, 1);
  assert.equal(replay.workers.length, 1);
  assert.deepEqual(replay.workers[0], {
    worker_id: "worker-1",
    task_id: "worker-1",
    owner_agent_id: "worker:worker-1",
    assigned_by: "main_swarm",
    capability: "code.test",
    objective: "Write protocol replay tests",
    status: "completed",
    accepted_at: "2026-05-24T00:00:01.000Z",
    started_at: "2026-05-24T00:00:02.000Z",
    completed_at: "2026-05-24T00:00:04.000Z",
    last_progress: "done",
    checkpoints: [{
      envelope_id: "env-worker-checkpoint",
      at: "2026-05-24T00:00:03.000Z",
      summary: "tests added",
      artifact: "artifact://checkpoint",
      payload: {
        worker_id: "worker-1",
        summary: "tests added",
        output_ref: "artifact://checkpoint"
      }
    }],
    result: {
      envelope_id: "env-worker-result",
      at: "2026-05-24T00:00:04.000Z",
      status: "completed",
      summary: "done",
      content: undefined,
      output_ref: "artifact://result",
      payload: {
        worker_id: "worker-1",
        status: "completed",
        summary: "done",
        outputRef: "artifact://result"
      }
    },
    source_envelope_ids: [
      "env-worker-assign",
      "env-worker-accept",
      "env-worker-start",
      "env-worker-checkpoint",
      "env-worker-result"
    ]
  });
});

test("protocol replay rebuilds handoff ownership lifecycle", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-handoff-assign", "task.assign", {
        created_at: atOffset(0),
        task_id: "handoff-1",
        to: { agent_id: "worker:handoff-worker", capability: "handoff_deep_work" },
        payload: {
          handoff_id: "handoff-1",
          worker_id: "handoff-worker",
          target_agent_spec_id: "reviewer",
          reason: "Review ownership transfer"
        }
      }),
      envelope("env-handoff-accept", "task.accept", {
        created_at: atOffset(1),
        from: { agent_id: "worker:handoff-worker" },
        task_id: "handoff-1",
        payload: {
          handoff_id: "handoff-1",
          worker_id: "handoff-worker"
        }
      }),
      envelope("env-handoff-result", "task.result", {
        created_at: atOffset(2),
        from: { agent_id: "worker:handoff-worker" },
        task_id: "handoff-1",
        payload: {
          handoff_id: "handoff-1",
          worker_id: "handoff-worker",
          result: "returned with review notes"
        }
      })
    ]
  });

  assert.equal(replay.handoffs.length, 1);
  assert.deepEqual(replay.handoffs[0], {
    handoff_id: "handoff-1",
    task_id: "handoff-1",
    worker_id: "handoff-worker",
    owner_agent_id: "worker:handoff-worker",
    source_agent: "main_swarm",
    target_agent_spec_id: "reviewer",
    reason: "Review ownership transfer",
    status: "returned",
    protocol_status: "returned",
    last_envelope_id: "env-handoff-result",
    result: "returned with review notes",
    source_envelope_ids: [
      "env-handoff-assign",
      "env-handoff-accept",
      "env-handoff-result"
    ]
  });
});

test("protocol replay rebuilds durable handoff protocol states", () => {
  const checkpoint = {
    kind: "worker_session_started",
    worker_session_id: "worker-session-1",
    summary: "session started"
  };
  const returnContract = {
    output_contract: "Return review notes",
    checkpoint,
    result: {
      status: "completed",
      summary: "review finished",
      content: "returned with review notes"
    },
    worker_session_id: "worker-session-1",
    worker_status: "completed"
  };
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-handoff-v2-request", "handoff.request", {
        created_at: atOffset(0),
        task_id: "handoff-2",
        from: { agent_id: "main_swarm" },
        to: { agent_id: "worker:handoff-worker", capability: "handoff_deep_work" },
        payload: {
          handoff_id: "handoff-2",
          worker_id: "handoff-worker",
          requester_agent_id: "main_swarm",
          target_agent_spec_id: "reviewer",
          reason: "Review ownership transfer",
          scope: ["src/runtime/runtime.ts"],
          lease_ttl_ms: 300_000,
          lease_expires_at: atOffset(300)
        }
      }),
      envelope("env-handoff-v2-accept", "handoff.accept", {
        created_at: atOffset(1),
        from: { agent_id: "worker:handoff-worker" },
        to: { agent_id: "main_swarm" },
        task_id: "handoff-2",
        reply_to: "env-handoff-v2-request",
        payload: {
          handoff_id: "handoff-2",
          worker_id: "handoff-worker",
          owner_agent_id: "worker:handoff-worker",
          lease_ttl_ms: 300_000
        }
      }),
      envelope("env-handoff-v2-renew", "handoff.renew", {
        created_at: atOffset(2),
        from: { agent_id: "worker:handoff-worker" },
        to: { agent_id: "main_swarm" },
        task_id: "handoff-2",
        payload: {
          handoff_id: "handoff-2",
          worker_id: "handoff-worker",
          lease_expires_at: atOffset(302)
        }
      }),
      envelope("env-handoff-v2-checkpoint", "handoff.checkpoint", {
        created_at: atOffset(3),
        from: { agent_id: "worker:handoff-worker" },
        to: { agent_id: "main_swarm" },
        task_id: "handoff-2",
        payload: {
          handoff_id: "handoff-2",
          worker_id: "handoff-worker",
          checkpoint
        }
      }),
      envelope("env-handoff-v2-return", "handoff.return", {
        created_at: atOffset(4),
        from: { agent_id: "worker:handoff-worker" },
        to: { agent_id: "main_swarm" },
        task_id: "handoff-2",
        payload: {
          handoff_id: "handoff-2",
          worker_id: "handoff-worker",
          status: "returned",
          summary: "review finished",
          result: "returned with review notes",
          return_contract: returnContract
        }
      })
    ]
  });

  assert.equal(replay.workers.length, 0);
  assert.equal(replay.handoffs.length, 1);
  assert.deepEqual(replay.handoffs[0], {
    handoff_id: "handoff-2",
    task_id: "handoff-2",
    status: "returned",
    source_envelope_ids: [
      "env-handoff-v2-request",
      "env-handoff-v2-accept",
      "env-handoff-v2-renew",
      "env-handoff-v2-checkpoint",
      "env-handoff-v2-return"
    ],
    worker_id: "handoff-worker",
    source_agent: "main_swarm",
    target_agent_spec_id: "reviewer",
    reason: "Review ownership transfer",
    requester_agent_id: "main_swarm",
    scope: ["src/runtime/runtime.ts"],
    lease_ttl_ms: 300_000,
    lease_expires_at: "2026-05-24T00:05:02.000Z",
    last_envelope_id: "env-handoff-v2-return",
    protocol_status: "returned",
    request_envelope_id: "env-handoff-v2-request",
    owner_agent_id: "worker:handoff-worker",
    accepted_at: "2026-05-24T00:00:01.000Z",
    accept_envelope_id: "env-handoff-v2-accept",
    last_checkpoint: checkpoint,
    return_contract: returnContract,
    return_envelope_id: "env-handoff-v2-return",
    result: "returned with review notes"
  });
});

test("protocol replay reconstructs peer negotiation chain", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-negotiation-propose-1", "negotiation.propose", {
        created_at: atOffset(0),
        task_id: "task-negotiation-1",
        correlation_id: "corr-negotiation-1",
        from: { agent_id: "worker:coder" },
        to: { agent_id: "worker:reviewer" },
        payload: {
          negotiation_id: "nego-replay-1",
          terms: { scope: ["src/runtime/router.ts"] },
          reason: "Coder proposes scoped ownership."
        }
      }),
      envelope("env-negotiation-counter-2", "negotiation.counter", {
        created_at: atOffset(1),
        task_id: "task-negotiation-1",
        correlation_id: "corr-negotiation-1",
        from: { agent_id: "worker:reviewer" },
        to: { agent_id: "worker:coder" },
        payload: {
          negotiation_id: "nego-replay-1",
          counter_terms: { review_responsibility: "reviewer owns protocol replay" },
          reason: "Add replay evidence."
        }
      }),
      envelope("env-negotiation-accept-3", "negotiation.accept", {
        created_at: atOffset(2),
        task_id: "task-negotiation-1",
        correlation_id: "corr-negotiation-1",
        from: { agent_id: "worker:coder" },
        to: { agent_id: "worker:reviewer" },
        payload: {
          negotiation_id: "nego-replay-1",
          contract: {
            scope: ["src/runtime/router.ts"],
            review_responsibility: "reviewer owns protocol replay"
          }
        }
      })
    ]
  });

  assert.equal(replay.negotiations.length, 1);
  assert.deepEqual(replay.negotiations[0], {
    negotiation_id: "nego-replay-1",
    task_id: "task-negotiation-1",
    status: "accepted",
    opened_by: "worker:coder",
    current_owner: "worker:coder",
    accepted_by: "worker:coder",
    contract: {
      scope: ["src/runtime/router.ts"],
      review_responsibility: "reviewer owns protocol replay"
    },
    events: [
      {
        envelope_id: "env-negotiation-propose-1",
        action: "propose",
        at: "2026-05-24T00:00:00.000Z",
        from: "worker:coder",
        to: "worker:reviewer",
        reason: "Coder proposes scoped ownership.",
        suggested_alternative: undefined,
        terms: { scope: ["src/runtime/router.ts"] }
      },
      {
        envelope_id: "env-negotiation-counter-2",
        action: "counter",
        at: "2026-05-24T00:00:01.000Z",
        from: "worker:reviewer",
        to: "worker:coder",
        reason: "Add replay evidence.",
        suggested_alternative: undefined,
        terms: { review_responsibility: "reviewer owns protocol replay" }
      },
      {
        envelope_id: "env-negotiation-accept-3",
        action: "accept",
        at: "2026-05-24T00:00:02.000Z",
        from: "worker:coder",
        to: "worker:reviewer",
        reason: undefined,
        suggested_alternative: undefined,
        terms: {
          scope: ["src/runtime/router.ts"],
          review_responsibility: "reviewer owns protocol replay"
        }
      }
    ],
    source_envelope_ids: [
      "env-negotiation-propose-1",
      "env-negotiation-counter-2",
      "env-negotiation-accept-3"
    ]
  });
});

test("protocol replay reconstructs squad lifecycle", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-squad-create-1", "squad.create", {
        created_at: atOffset(0),
        task_id: "task-squad-1",
        correlation_id: "corr-squad-1",
        from: { agent_id: "main_swarm" },
        payload: {
          squad_id: "squad-replay-1",
          objective: "Implement risky protocol work.",
          risk_level: "r3",
          cache_profile: { preferred_cache: "warm" },
          ownership_lease: { claim_key: "task/task-squad-1", ttl_ms: 300_000 },
          leader: { agent_id: "worker:squad-lead", role: "leader" },
          members: [
            { agent_id: "worker:squad-coder", role: "specialist", capabilities: ["code.implement"] },
            { agent_id: "worker:squad-reviewer", role: "reviewer", capabilities: ["code.review"] }
          ],
          roles: [
            { agent_id: "worker:squad-aggregator", role: "aggregator", required_capabilities: ["result.aggregate"] }
          ],
          review_gate: { required: true, reviewer: "worker:squad-reviewer" },
          final_result_aggregator: { agent_id: "worker:squad-aggregator" },
          candidates: [
            { agent_id: "worker:squad-coder", available: true, cache_profile: "mixed", risk_level: "r1" },
            { agent_id: "worker:squad-reviewer", available: true, cache_profile: "stable", risk_level: "r1" }
          ]
        }
      }),
      envelope("env-squad-join-2", "squad.join", {
        created_at: atOffset(1),
        task_id: "task-squad-1",
        correlation_id: "corr-squad-1",
        from: { agent_id: "worker:squad-reviewer" },
        payload: {
          squad_id: "squad-replay-1",
          member: { agent_id: "worker:squad-reviewer", role: "reviewer", capabilities: ["code.review"] },
          reason: "Join review gate."
        }
      }),
      envelope("env-squad-role-3", "squad.role.assign", {
        created_at: atOffset(2),
        task_id: "task-squad-1",
        correlation_id: "corr-squad-1",
        from: { agent_id: "worker:squad-lead" },
        payload: {
          squad_id: "squad-replay-1",
          member: { agent_id: "worker:squad-aggregator", role: "aggregator" },
          role: "aggregator",
          required_capabilities: ["result.aggregate"]
        }
      }),
      envelope("env-squad-leave-4", "squad.leave", {
        created_at: atOffset(3),
        task_id: "task-squad-1",
        correlation_id: "corr-squad-1",
        from: { agent_id: "worker:squad-reviewer" },
        payload: {
          squad_id: "squad-replay-1",
          member: { agent_id: "worker:squad-reviewer", role: "reviewer" },
          reason: "Review gate completed."
        }
      }),
      envelope("env-squad-dissolve-5", "squad.dissolve", {
        created_at: atOffset(4),
        task_id: "task-squad-1",
        correlation_id: "corr-squad-1",
        from: { agent_id: "worker:squad-lead" },
        payload: {
          squad_id: "squad-replay-1",
          reason: "Final result aggregated."
        }
      })
    ]
  });

  assert.equal(replay.squads.length, 1);
  const squad = replay.squads[0];
  assert.equal(squad?.squad_id, "squad-replay-1");
  assert.equal(squad?.task_id, "task-squad-1");
  assert.equal(squad?.status, "dissolved");
  assert.equal(squad?.leader_agent_id, "worker:squad-lead");
  assert.equal(squad?.risk_level, "r3");
  assert.deepEqual(squad?.cache_profile, { preferred_cache: "warm" });
  assert.deepEqual(squad?.ownership_lease, { claim_key: "task/task-squad-1", ttl_ms: 300_000 });
  assert.deepEqual(squad?.review_gate, { required: true, reviewer: "worker:squad-reviewer" });
  assert.deepEqual(squad?.final_result_aggregator, { agent_id: "worker:squad-aggregator" });
  assert.equal(squad?.candidates?.some((candidate) =>
    Boolean(candidate && typeof candidate === "object" && "agent_id" in candidate && candidate.agent_id === "worker:squad-coder")
  ), true);
  assert.deepEqual(squad?.events.map((event) => event.action), ["create", "join", "role.assign", "leave", "dissolve"]);
  assert.deepEqual(squad?.source_envelope_ids, [
    "env-squad-create-1",
    "env-squad-join-2",
    "env-squad-role-3",
    "env-squad-leave-4",
    "env-squad-dissolve-5"
  ]);
  const members = new Map(squad?.members.map((member) => [member.agent_id, member]));
  assert.equal(members.get("worker:squad-coder")?.role, "specialist");
  assert.deepEqual(members.get("worker:squad-coder")?.capabilities, ["code.implement"]);
  assert.equal(members.get("worker:squad-reviewer")?.role, "reviewer");
  assert.equal(members.get("worker:squad-reviewer")?.status, "left");
  assert.equal(members.get("worker:squad-aggregator")?.role, "aggregator");
  assert.deepEqual(members.get("worker:squad-aggregator")?.capabilities, ["result.aggregate"]);
  assert(squad?.members.every((member) => member.status === "left"));
});

test("protocol replay rebuilds handoff take back, conflict, timeout, and reject states", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-handoff-take-request", "handoff.request", {
        created_at: atOffset(0),
        task_id: "handoff-take",
        payload: {
          handoff_id: "handoff-take",
          worker_id: "handoff-worker",
          requester_agent_id: "main_swarm",
          target_agent_spec_id: "reviewer"
        }
      }),
      envelope("env-handoff-take-accept", "handoff.accept", {
        created_at: atOffset(1),
        from: { agent_id: "worker:handoff-worker" },
        task_id: "handoff-take",
        payload: {
          handoff_id: "handoff-take",
          worker_id: "handoff-worker"
        }
      }),
      envelope("env-handoff-take-back", "handoff.take_back", {
        created_at: atOffset(2),
        task_id: "handoff-take",
        payload: {
          handoff_id: "handoff-take",
          worker_id: "handoff-worker",
          requester_agent_id: "main_swarm",
          previous_owner: "worker:handoff-worker",
          resulting_owner: "main_swarm",
          reason: "operator reclaimed ownership"
        }
      }),
      envelope("env-handoff-conflict", "handoff.conflict", {
        created_at: atOffset(3),
        task_id: "handoff-conflict",
        payload: {
          handoff_id: "handoff-conflict",
          worker_id: "handoff-worker",
          reason: "owner heartbeat disagrees with lease"
        }
      }),
      envelope("env-handoff-timeout", "handoff.timeout", {
        created_at: atOffset(4),
        task_id: "handoff-timeout",
        payload: {
          handoff_id: "handoff-timeout",
          worker_id: "handoff-worker",
          reason: "lease expired"
        }
      }),
      envelope("env-handoff-reject", "handoff.reject", {
        created_at: atOffset(5),
        from: { agent_id: "worker:handoff-worker" },
        task_id: "handoff-reject",
        payload: {
          handoff_id: "handoff-reject",
          worker_id: "handoff-worker",
          reason: "scope is read only"
        }
      })
    ]
  });

  const byId = new Map(replay.handoffs.map((handoff) => [handoff.handoff_id, handoff]));
  assert.equal(byId.get("handoff-take")?.status, "taken_back");
  assert.equal(byId.get("handoff-take")?.protocol_status, "taken_back");
  assert.equal(byId.get("handoff-take")?.requester_agent_id, "main_swarm");
  assert.equal(byId.get("handoff-take")?.owner_agent_id, "main_swarm");
  assert.equal(byId.get("handoff-take")?.take_back_envelope_id, "env-handoff-take-back");
  assert.equal(byId.get("handoff-take")?.result, "operator reclaimed ownership");
  assert.equal(byId.get("handoff-conflict")?.status, "active");
  assert.equal(byId.get("handoff-conflict")?.protocol_status, "conflict");
  assert.equal(byId.get("handoff-conflict")?.conflict_reason, "owner heartbeat disagrees with lease");
  assert.equal(byId.get("handoff-timeout")?.status, "active");
  assert.equal(byId.get("handoff-timeout")?.protocol_status, "timeout");
  assert.equal(byId.get("handoff-timeout")?.conflict_reason, "lease expired");
  assert.equal(byId.get("handoff-reject")?.status, "failed");
  assert.equal(byId.get("handoff-reject")?.protocol_status, "rejected");
  assert.equal(byId.get("handoff-reject")?.conflict_reason, "scope is read only");
});

test("protocol replay summarizes blackboard claims, proposals, decisions, results, and evidence", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    blackboard: [
      blackboard("bb-claim", "claim:worker-1", "observation", ["claim"]),
      blackboard("bb-proposal", "proposal:worker-1", "observation", ["proposal"]),
      blackboard("bb-decision", "decision:worker-1", "decision", ["decision"]),
      blackboard("bb-result", "result:worker-1", "result", ["result"]),
      blackboard("bb-evidence", "evidence:worker-1", "evidence", ["evidence"])
    ]
  });

  assert.equal(replay.blackboard.total, 5);
  assert.equal(replay.blackboard.claims, 1);
  assert.equal(replay.blackboard.proposals, 1);
  assert.equal(replay.blackboard.decisions, 1);
  assert.equal(replay.blackboard.results, 1);
  assert.equal(replay.blackboard.evidence, 1);
  assert.deepEqual(replay.blackboard.entries.map((entry) => entry.key), [
    "claim:worker-1",
    "proposal:worker-1",
    "decision:worker-1",
    "result:worker-1",
    "evidence:worker-1"
  ]);
});

test("protocol replay rebuilds blackboard decision history and unresolved proposals", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    blackboard: [
      blackboard("bb-proposal-open", "proposal/proposal-open", "plan", ["proposal"], { plan: "needs review" }, {
        kind: "proposal",
        proposal_id: "proposal-open",
        claim_key: "task/open",
        decision_status: "proposed",
        source_envelope_id: "env-proposal-open"
      }, atOffset(0), { agent_id: "planner-1" }),
      blackboard("bb-review-open", "proposal/proposal-open/review/review-1", "critique", ["review"], { verdict: "approve" }, {
        kind: "review",
        proposal_id: "proposal-open",
        review_id: "review-1",
        decision_status: "reviewed",
        source_envelope_id: "env-review-open"
      }, atOffset(1), { agent_id: "reviewer-1" }),
      blackboard("bb-proposal-accepted", "proposal/proposal-accepted", "plan", ["proposal"], { plan: "ready" }, {
        kind: "proposal",
        proposal_id: "proposal-accepted",
        decision_status: "proposed",
        source_envelope_id: "env-proposal-accepted"
      }, atOffset(2), { agent_id: "planner-2" }),
      blackboard("bb-decision-accepted", "proposal/proposal-accepted/decision/decision-1", "decision", ["decision"], { status: "accepted" }, {
        kind: "decision",
        proposal_id: "proposal-accepted",
        decision_id: "decision-1",
        decision_status: "accepted",
        source_envelope_id: "env-decision-accepted"
      }, atOffset(3), { agent_id: "lead-1" }),
      blackboard("bb-result-accepted", "result/result-accepted", "result", ["result"], { summary: "done" }, {
        kind: "result",
        proposal_id: "proposal-accepted",
        result_id: "result-accepted",
        source_envelope_id: "env-result-accepted"
      }, atOffset(4), { agent_id: "worker-1" })
    ]
  });

  assert.deepEqual(replay.blackboard.decision_history.map((decision) => ({
    proposal_id: decision.proposal_id,
    status: decision.status,
    decider: decision.decider,
    source_envelope_ids: decision.source_envelope_ids
  })), [{
    proposal_id: "proposal-accepted",
    status: "accepted",
    decider: "lead-1",
    source_envelope_ids: ["env-decision-accepted"]
  }]);
  assert.deepEqual(replay.blackboard.unresolved_proposals.map((proposal) => ({
    proposal_id: proposal.proposal_id,
    status: proposal.status,
    reviews: proposal.reviews.map((review) => review.verdict),
    source_envelope_ids: proposal.source_envelope_ids
  })), [{
    proposal_id: "proposal-open",
    status: "reviewed",
    reviews: ["approve"],
    source_envelope_ids: ["env-proposal-open", "env-review-open"]
  }]);
});

test("protocol replay projects decision policy, votes, waiting state, outcome, and superseded chain", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    blackboard: [
      blackboard("bb-policy-proposal", "proposal/policy-proposal", "plan", ["proposal"], {
        plan: "needs quorum",
        decision_policy: { mode: "quorum", quorum: 2, risk_level: "r2" },
        decision_policy_status: "waiting",
        decision_waiting_for: ["quorum:1/2"],
        decision_votes: [
          { voter: "reviewer-1", vote: "approve", confidence: 0.88, source_envelope_id: "env-vote-1" }
        ]
      }, {
        kind: "proposal",
        proposal_id: "policy-proposal",
        decision_status: "proposed",
        decision_policy: { mode: "quorum", quorum: 2, risk_level: "r2" },
        decision_policy_status: "waiting",
        decision_waiting_for: ["quorum:1/2"],
        decision_votes: [
          { voter: "reviewer-1", vote: "approve", confidence: 0.88, source_envelope_id: "env-vote-1" }
        ],
        source_envelope_id: "env-policy-proposal"
      }, atOffset(0), { agent_id: "planner-policy" }),
      blackboard("bb-policy-decision", "proposal/policy-proposal/decision/decision-2", "decision", ["decision"], {
        status: "accepted",
        decision_outcome: {
          status: "accepted",
          reason: "Quorum reached.",
          policy_status: "satisfied",
          supersedes_decision_id: "decision-1",
          votes: [
            { voter: "reviewer-1", vote: "approve", source_envelope_id: "env-vote-1" },
            { voter: "reviewer-2", vote: "approve", source_envelope_id: "env-vote-2" }
          ]
        }
      }, {
        kind: "decision",
        proposal_id: "policy-proposal",
        decision_id: "decision-2",
        decision_status: "accepted",
        decision_policy: { mode: "quorum", quorum: 2, risk_level: "r2" },
        decision_policy_status: "satisfied",
        decision_waiting_for: [],
        decision_votes: [
          { voter: "reviewer-1", vote: "approve", source_envelope_id: "env-vote-1" },
          { voter: "reviewer-2", vote: "approve", source_envelope_id: "env-vote-2" }
        ],
        decision_outcome: {
          status: "accepted",
          reason: "Quorum reached.",
          policy_status: "satisfied",
          supersedes_decision_id: "decision-1",
          votes: [
            { voter: "reviewer-1", vote: "approve", source_envelope_id: "env-vote-1" },
            { voter: "reviewer-2", vote: "approve", source_envelope_id: "env-vote-2" }
          ]
        },
        source_envelope_id: "env-policy-decision"
      }, atOffset(1), { agent_id: "router" })
    ]
  });

  const decision = replay.blackboard.decision_history[0];
  assert.equal(decision?.proposal_id, "policy-proposal");
  assert.deepEqual(decision?.policy, { mode: "quorum", risk_level: "r2", quorum: 2 });
  assert.equal(decision?.policy_status, "satisfied");
  assert.deepEqual(decision?.waiting_for, []);
  assert.deepEqual(decision?.votes?.map((vote) => ({ voter: vote.voter, vote: vote.vote })), [
    { voter: "reviewer-1", vote: "approve" },
    { voter: "reviewer-2", vote: "approve" }
  ]);
  assert.equal(decision?.outcome?.status, "accepted");
  assert.equal(decision?.outcome?.policy_status, "satisfied");
  assert.equal(decision?.supersedes_decision_id, "decision-1");
});

test("protocol replay rebuilds Symphony participant claim and result flow", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-symphony-assign", "task.assign", {
        created_at: atOffset(0),
        from: { agent_id: "symphony.scheduler" },
        task_id: "symphony-work-1",
        payload: {
          claim_key: "workflow.plan:WK-101",
          work_item_key: "WK-101",
          workflow_path: ".workflow/scratch/plan",
          source: "symphony",
          owner_id: "symphony.scheduler"
        }
      }),
      envelope("env-symphony-start", "task.start", {
        created_at: atOffset(1),
        from: { agent_id: "worker:symphony-worker" },
        task_id: "symphony-work-1",
        payload: {
          claim_key: "workflow.plan:WK-101",
          work_item_key: "WK-101",
          workflow_path: ".workflow/scratch/plan",
          owner_id: "symphony.scheduler"
        }
      }),
      envelope("env-symphony-result", "task.result", {
        created_at: atOffset(2),
        from: { agent_id: "worker:symphony-worker" },
        task_id: "symphony-work-1",
        payload: {
          claim_key: "workflow.plan:WK-101",
          work_item_key: "WK-101",
          workflow_path: ".workflow/scratch/plan",
          owner_id: "symphony.scheduler",
          summary: "run-once completed"
        }
      })
    ],
    blackboard: [
      blackboard("bb-symphony-claim", "symphony:claim:WK-101", "decision", ["symphony", "claim"], {
        claim_key: "workflow.plan:WK-101",
        work_item_key: "WK-101",
        status: "completed",
        owner_id: "symphony.scheduler"
      })
    ]
  });

  assert.equal(replay.symphony.length, 1);
  assert.deepEqual(replay.symphony[0], {
    claim_key: "workflow.plan:WK-101",
    work_item_key: "WK-101",
    workflow_path: ".workflow/scratch/plan",
    session_id: SESSION_ID,
    owner_id: "symphony.scheduler",
    status: "completed",
    result: "run-once completed",
    source_envelope_ids: [
      "env-symphony-assign",
      "env-symphony-start",
      "env-symphony-result"
    ]
  });
});

test("migration audit reports direct store/protocol divergence and delivery warnings", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-worker-assign", "task.assign", {
        created_at: atOffset(0),
        task_id: "worker-1",
        payload: { worker_id: "worker-1", objective: "Audit divergence" }
      }),
      envelope("env-worker-result", "task.result", {
        created_at: atOffset(1),
        from: { agent_id: "worker:worker-1" },
        task_id: "worker-1",
        payload: { worker_id: "worker-1", summary: "completed in protocol" }
      }),
      envelope("env-handoff-result", "task.result", {
        created_at: atOffset(2),
        from: { agent_id: "worker:handoff-worker" },
        task_id: "handoff-1",
        payload: {
          handoff_id: "handoff-1",
          worker_id: "handoff-worker",
          result: "returned in protocol"
        }
      }),
      envelope("env-symphony-result", "task.result", {
        created_at: atOffset(3),
        from: { agent_id: "symphony.scheduler" },
        task_id: "symphony-work-1",
        payload: {
          claim_key: "workflow.plan:WK-101",
          work_item_key: "WK-101",
          source: "symphony",
          summary: "completed in protocol"
        }
      })
    ],
    deliveries: [
      delivery("env-worker-result", "failed"),
      delivery("env-symphony-result", "expired")
    ]
  });
  const audit = auditProtocolMigration({
    sessionId: SESSION_ID,
    generatedAt: AT,
    replay,
    workers: [
      worker("worker-1", "running"),
      worker("legacy-only-worker", "running")
    ],
    handoffs: [
      handoff("handoff-1", "active")
    ],
    symphonyClaims: [
      symphonyClaim("workflow.plan:WK-101", "running")
    ]
  });

  assert.equal(audit.status, "fail");
  assert.equal(audit.summary.errors, 3);
  assert.equal(audit.summary.warnings, 2);
  assert(audit.issues.some((issue) => issue.code === "worker_status_divergence" && issue.id === "worker-1"));
  assert(audit.issues.some((issue) => issue.code === "legacy_direct_without_protocol" && issue.id === "legacy-only-worker"));
  assert(audit.issues.some((issue) => issue.code === "handoff_status_divergence" && issue.id === "handoff-1"));
  assert(audit.issues.some((issue) => issue.code === "symphony_status_divergence" && issue.id === "workflow.plan:WK-101"));
  assert(audit.issues.some((issue) => issue.code === "delivery_failures_present"));
  assert(formatProtocolMigrationAudit(audit).some((line) => line.includes("protocol_replay status=fail")));
});

test("protocol replay diff locates live snapshot divergence", () => {
  const replay = buildProtocolReplay({
    sessionId: SESSION_ID,
    generatedAt: AT,
    envelopes: [
      envelope("env-diff-assign", "task.assign", {
        created_at: atOffset(0),
        task_id: "worker-diff",
        payload: { worker_id: "worker-diff", objective: "Diff snapshots" }
      }),
      envelope("env-diff-result", "task.result", {
        created_at: atOffset(1),
        from: { agent_id: "worker:worker-diff" },
        task_id: "worker-diff",
        payload: { worker_id: "worker-diff", summary: "completed in replay" }
      })
    ]
  });
  const live = {
    ...replay,
    workers: replay.workers.map((worker) => worker.worker_id === "worker-diff"
      ? { ...worker, status: "running" as const }
      : worker)
  };
  const diff = diffProtocolReplaySnapshots({ live, replay, generatedAt: AT });

  assert.equal(diff.schema_version, "swarm.protocol_replay.diff.v1");
  assert.equal(diff.status, "fail");
  assert.equal(diff.replay_verdict.forced, true);
  assert.equal(diff.replay_verdict.status, "fail");
  assert(diff.issues.some((issue) =>
    issue.path === "worker.worker-diff.status" &&
    issue.code === "value_mismatch" &&
    issue.live === "running" &&
    issue.replay === "completed"
  ));
});

function envelope(
  id: string,
  type: SwarmEnvelope["type"],
  overrides: Partial<SwarmEnvelope> = {}
): SwarmEnvelope {
  const offset = Number(id.match(/(\d+)$/)?.[1] ?? 0);
  return {
    id,
    version: "1.0",
    swarm_id: SWARM_ID,
    session_id: SESSION_ID,
    task_id: "task-1",
    from: { agent_id: "main_swarm" },
    to: { agent_id: "worker:worker-1", capability: "code.test" },
    type,
    intent: type,
    created_at: new Date(Date.parse(AT) + offset * 1000).toISOString(),
    payload: {},
    ...overrides
  };
}

function atOffset(seconds: number): string {
  return new Date(Date.parse(AT) + seconds * 1000).toISOString();
}

function delivery(envelopeId: string, status: EnvelopeDeliveryStatus): EnvelopeDeliveryRecord {
  return {
    delivery_id: `${envelopeId}:worker-1`,
    envelope_id: envelopeId,
    session_id: SESSION_ID,
    swarm_id: SWARM_ID,
    task_id: "task-1",
    type: "task.result",
    intent: "task.result",
    from_agent_id: "main_swarm",
    recipient_key: "agent:worker:worker-1",
    recipient_agent_id: "worker:worker-1",
    status,
    queued_at: AT,
    delivered_at: status === "delivered" || status === "acked" ? AT : undefined,
    acked_at: status === "acked" ? AT : undefined,
    failed_at: status === "failed" ? AT : undefined,
    expired_at: status === "expired" ? AT : undefined,
    superseded_at: status === "superseded" ? AT : undefined,
    metadata: {}
  };
}

function actor(overrides: Partial<AgentActorRecord> = {}): AgentActorRecord {
  return {
    actor_id: "worker:worker-1",
    kind: "worker",
    name: "Ada",
    role: "Coder",
    status: "busy",
    capabilities: ["code.test"],
    load: { running_tasks: 1, max_tasks: 1 },
    heartbeat_state: "fresh",
    last_heartbeat_at: AT,
    last_seen_at: AT,
    registered_at: AT,
    updated_at: AT,
    metadata: {},
    ...overrides
  };
}

function blackboard(
  entryId: string,
  key: string,
  type: BlackboardEntry["type"],
  tags: string[],
  value: unknown = { summary: key },
  metadata?: BlackboardEntry["metadata"],
  createdAt = AT,
  createdBy: BlackboardEntry["created_by"] = { agent_id: "main_swarm" }
): BlackboardEntry {
  return {
    entry_id: entryId,
    swarm_id: SWARM_ID,
    session_id: SESSION_ID,
    task_id: "task-1",
    key,
    value,
    type,
    created_by: createdBy,
    created_at: createdAt,
    visibility: "team",
    version: 1,
    tags,
    metadata
  };
}

function worker(workerId: string, status: WorkerStatus): WorkerRecord {
  return {
    worker_id: workerId,
    display_name: "Ada",
    parent_session_id: SESSION_ID,
    capability: "code.test",
    objective: "Audit protocol replay",
    status,
    file_scope: ["src/runtime/protocol-replay.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 10 },
    created_at: AT,
    updated_at: AT
  };
}

function handoff(handoffId: string, status: HandoffSessionRecord["status"]): HandoffSessionRecord {
  return {
    handoff_id: handoffId,
    worker_id: "handoff-worker",
    parent_session_id: SESSION_ID,
    source_agent: "main_swarm",
    target_agent_spec_id: "reviewer",
    reason: "Review handoff",
    status,
    task_packet: {
      objective: "Review",
      agent_spec_id: "reviewer",
      invocation_mode: "handoff",
      persona_snapshot: "Reviewer",
      file_scope: ["src/runtime/protocol-replay.ts"],
      allowed_tools: ["file.read"],
      write_policy: "read_only",
      permission_context: {
        default_mode: "ask",
        allow: [],
        ask: [],
        deny: [],
        additional_directories: []
      },
      budget: { max_turns: 4, max_tool_calls: 10 },
      expected_output: "Review notes",
      return_conditions: ["done"]
    },
    created_at: AT,
    updated_at: AT
  };
}

function symphonyClaim(claimKey: string, status: SymphonyClaimRecord["status"]): SymphonyClaimRecord {
  return {
    claim_key: claimKey,
    work_item_key: "WK-101",
    source_identity: "symphony:local",
    workflow_path: ".workflow/scratch/plan",
    session_id: SESSION_ID,
    status,
    attempt: 1,
    owner_id: "symphony.scheduler",
    claimed_at: AT,
    updated_at: AT,
    metadata: {}
  };
}
