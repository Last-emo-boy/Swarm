import { strict as assert } from "node:assert";
import test from "node:test";
import {
  defaultFaultInjectionFixtures,
  evaluateFaultInjectionFixture,
  formatFaultInjectionReport,
  runFaultInjectionDrills
} from "./fault-injection.js";

test("fault injection actor crash recovers pending envelope", () => {
  const fixture = defaultFaultInjectionFixtures().find((item) => item.kind === "actor_crash");
  assert(fixture);

  const result = evaluateFaultInjectionFixture(fixture, { generatedAt: "2026-05-24T00:02:00.000Z" });

  assert.equal(result.status, "pass");
  assert.equal(result.actual_recovery_outcome, "recovered");
  assert.equal(result.replay.workers[0]?.status, "completed");
  assert.equal(result.replay.deliveries.acked, 1);
  assert.equal(result.replay.deliveries.failed, 1);
  assert.equal(result.replay_proof.replay_verdict.forced, true);
  assert.deepEqual(result.stuck, { actors: [], envelopes: [], stale_leases: [] });
});

test("duplicate delivery remains idempotent", () => {
  const fixture = defaultFaultInjectionFixtures().find((item) => item.kind === "duplicate_delivery");
  assert(fixture);

  const result = evaluateFaultInjectionFixture(fixture, { generatedAt: "2026-05-24T00:02:00.000Z" });

  assert.equal(result.status, "pass");
  assert.equal(result.actual_recovery_outcome, "contained");
  assert.equal(result.replay.envelope_count, 2);
  assert.equal(result.replay.workers.length, 1);
  assert.deepEqual(result.replay.workers[0]?.source_envelope_ids, [
    "env-duplicate-assign",
    "env-duplicate-result"
  ]);
  assert.equal(result.replay.deliveries.superseded, 1);
});

test("lease expiry recovery produces visible decision", () => {
  const fixture = defaultFaultInjectionFixtures().find((item) => item.kind === "ownership_expiry");
  assert(fixture);

  const result = evaluateFaultInjectionFixture(fixture, { generatedAt: "2026-05-24T00:02:00.000Z" });

  assert.equal(result.status, "pass");
  assert.equal(result.replay.blackboard.decision_history.some((decision) =>
    decision.proposal_id === "lease-expiry-recovery" && decision.status === "accepted"
  ), true);
  assert(result.replay_proof.evidence_paths.some((path) => path.startsWith("blackboard.decision.lease-expiry-recovery")));
  assert.deepEqual(result.stuck.stale_leases, []);
});

test("fault drill report covers six deterministic recovery scenarios", () => {
  const report = runFaultInjectionDrills({ generatedAt: "2026-05-24T00:02:00.000Z" });
  const formatted = formatFaultInjectionReport(report).join("\n");

  assert.equal(report.schema_version, "swarm.fault_injection.v1");
  assert.equal(report.status, "pass");
  assert.equal(report.summary.total, 6);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.stuck_actors, 0);
  assert.equal(report.summary.stuck_envelopes, 0);
  assert.equal(report.summary.stale_leases, 0);
  assert.deepEqual(new Set(report.drills.map((drill) => drill.kind)), new Set([
    "actor_crash",
    "provider_timeout",
    "duplicate_delivery",
    "mailbox_backlog",
    "ownership_expiry",
    "blackboard_conflict"
  ]));
  assert(report.drills.every((drill) => drill.replay_proof.replay_verdict.forced));
  assert.match(formatted, /fault_drills status=pass total=6/);
});

test("fault drill report identifies stuck actor envelope and stale lease on failed recovery", () => {
  const fixture = {
    ...defaultFaultInjectionFixtures().find((item) => item.kind === "mailbox_backlog")!,
    id: "fault-mailbox-backlog-stuck",
    deliveries: [
      {
        ...defaultFaultInjectionFixtures().find((item) => item.kind === "mailbox_backlog")!.deliveries![0]!,
        status: "queued" as const,
        acked_at: undefined
      }
    ],
    actors: [
      {
        ...defaultFaultInjectionFixtures().find((item) => item.kind === "mailbox_backlog")!.actors![0]!,
        status: "degraded" as const,
        heartbeat_state: "blocked" as const
      }
    ],
    blackboard: [
      {
        ...defaultFaultInjectionFixtures().find((item) => item.kind === "ownership_expiry")!.blackboard![0]!,
        session_id: "fault-mailbox-backlog",
        metadata: {
          ...defaultFaultInjectionFixtures().find((item) => item.kind === "ownership_expiry")!.blackboard![0]!.metadata,
          claim_key: "lease/stuck",
          claim_status: "expired" as const,
          expires_at: "2026-05-24T00:00:01.000Z"
        }
      }
    ]
  };

  const result = evaluateFaultInjectionFixture(fixture, { generatedAt: "2026-05-24T00:02:00.000Z" });

  assert.equal(result.status, "fail");
  assert(result.stuck.actors.some((item) => item.includes("worker:backlog")));
  assert(result.stuck.envelopes.some((item) => item.includes("env-backlog-assign")));
  assert(result.stuck.stale_leases.some((item) => item.includes("lease/stuck")));
  assert(result.findings.some((item) => item.includes("stuck actor")));
  assert(result.findings.some((item) => item.includes("stuck envelope")));
  assert(result.findings.some((item) => item.includes("stale lease")));
});
