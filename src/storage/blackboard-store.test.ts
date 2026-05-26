import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BlackboardStore } from "./blackboard-store.js";
import { SwarmDatabase } from "./database.js";

test("blackboard claim lifecycle separates claims from locks and records conflicts", () => {
  const fixture = createFixture();
  try {
    const first = fixture.blackboard.claim({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-claim",
      claim_key: "task/one",
      owner: { agent_id: "worker-1" },
      ttl_ms: 10_000,
      metadata: {
        source_envelope_id: "env-claim-1",
        correlation_id: "corr-claim"
      }
    });

    assert.equal(first.status, "claimed");
    assert.equal(first.entry.metadata?.kind, "claim");
    assert.equal(first.entry.metadata?.claim_status, "claimed");
    assert.equal(first.entry.metadata?.source_envelope_id, "env-claim-1");
    assert.equal(fixture.blackboard.getActiveClaim("session-1", "task/one")?.metadata?.owner_agent_id, "worker-1");

    const lock = fixture.blackboard.lock({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-claim",
      key: "task/one",
      holder: { agent_id: "worker-2" },
      metadata: {
        source_envelope_id: "env-lock-1",
        correlation_id: "corr-lock"
      }
    });
    assert.equal(lock.kind, "lock");
    assert.equal(lock.source_envelope_id, "env-lock-1");
    assert.equal(fixture.blackboard.getActiveClaim("session-1", "task/one")?.metadata?.owner_agent_id, "worker-1");

    const conflict = fixture.blackboard.claim({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-claim",
      claim_key: "task/one",
      owner: { agent_id: "worker-2" },
      metadata: {
        source_envelope_id: "env-claim-2",
        correlation_id: "corr-claim"
      }
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.entry.metadata?.kind, "claim_conflict");
    assert.equal(conflict.entry.metadata?.claim_status, "conflict");
    assert.equal(conflict.entry.metadata?.conflict_with_entry_id, first.entry.entry_id);
    assert.equal(fixture.blackboard.query("session-1", { kind: "claim_conflict" }).length, 1);
    assert.equal(fixture.blackboard.getActiveClaim("session-1", "task/one")?.metadata?.owner_agent_id, "worker-1");

    const released = fixture.blackboard.releaseClaim({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-claim",
      claim_key: "task/one",
      owner: { agent_id: "worker-1" },
      status: "released",
      metadata: {
        source_envelope_id: "env-release-1"
      }
    });
    assert.equal(released.metadata?.kind, "claim_release");
    assert.equal(released.metadata?.claim_status, "released");
    assert.equal(fixture.blackboard.getActiveClaim("session-1", "task/one"), undefined);

    fixture.blackboard.claim({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-expired",
      claim_key: "task/expired",
      owner: { agent_id: "worker-3" },
      expires_at: "2026-05-25T00:00:00.000Z",
      metadata: {
        source_envelope_id: "env-expiring-claim"
      }
    });
    const expired = fixture.blackboard.expireClaims("session-1", {
      now: "2026-05-25T00:01:00.000Z",
      swarm_id: "swarm-1"
    });
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.metadata?.claim_status, "expired");

    const events = fixture.blackboard.listEvents("session-1");
    assert.equal(events.some((event) => event.kind === "claim" && event.source_envelope_id === "env-claim-1"), true);
    assert.equal(events.some((event) => event.kind === "lock" && event.source_envelope_id === "env-lock-1"), true);
    assert.equal(events.some((event) => event.kind === "claim_conflict" && event.source_envelope_id === "env-claim-2"), true);
  } finally {
    fixture.close();
  }
});

test("blackboard proposals reviews decisions and results are queryable by collaboration metadata", () => {
  const fixture = createFixture();
  try {
    const proposal = fixture.blackboard.propose({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-proposal",
      proposal_id: "proposal-1",
      proposer: { agent_id: "planner-1" },
      value: { plan: "Use the mailbox projection." },
      claim_key: "task/proposal",
      target_key: "decision/proposal",
      tags: ["design", "router"],
      metadata: {
        source_envelope_id: "env-proposal-1"
      }
    });
    const review = fixture.blackboard.reviewProposal({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-proposal",
      proposal_id: "proposal-1",
      reviewer: { agent_id: "reviewer-1" },
      verdict: "approve",
      tags: ["design"],
      metadata: {
        source_envelope_id: "env-review-1"
      }
    });
    const decision = fixture.blackboard.decideProposal({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-proposal",
      proposal_id: "proposal-1",
      decider: { agent_id: "lead-1" },
      status: "accepted",
      tags: ["design"],
      metadata: {
        source_envelope_id: "env-decision-1"
      }
    });
    const result = fixture.blackboard.recordResult({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-proposal",
      result_id: "result-1",
      actor: { agent_id: "worker-1" },
      proposal_id: "proposal-1",
      claim_key: "task/proposal",
      value: { ok: true },
      tags: ["design"],
      metadata: {
        source_envelope_id: "env-result-1"
      }
    });

    assert.equal(proposal.metadata?.decision_status, "proposed");
    assert.equal(review.metadata?.decision_status, "reviewed");
    assert.equal(decision.metadata?.decision_status, "accepted");
    assert.equal(result.metadata?.kind, "result");
    const proposalEntries = fixture.blackboard.query("session-1", { proposalId: "proposal-1" });
    assert.equal(proposalEntries.length, 4);
    assert.equal(proposalEntries.some((entry) => entry.metadata?.kind === "proposal" && entry.key === "proposal/proposal-1"), true);
    assert.equal(proposalEntries.some((entry) => entry.metadata?.kind === "review" && entry.key.startsWith("proposal/proposal-1/review/")), true);
    assert.equal(proposalEntries.some((entry) => entry.metadata?.kind === "decision" && entry.key.startsWith("proposal/proposal-1/decision/")), true);
    assert.equal(proposalEntries.some((entry) => entry.metadata?.kind === "result" && entry.key === "result/result-1"), true);
    assert.deepEqual(fixture.blackboard.query("session-1", { decisionStatus: "accepted" }).map((entry) => entry.entry_id), [
      decision.entry_id
    ]);
    assert.deepEqual(fixture.blackboard.query("session-1", { ownerAgentId: "planner-1" }).map((entry) => entry.entry_id), [
      proposal.entry_id
    ]);
    assert.deepEqual(fixture.blackboard.query("session-1", { sourceEnvelopeId: "env-result-1" }).map((entry) => entry.entry_id), [
      result.entry_id
    ]);
  } finally {
    fixture.close();
  }
});

test("blackboard subscription returns matching collaboration entries", () => {
  const fixture = createFixture();
  try {
    const subscription = fixture.blackboard.subscribe({
      session_id: "session-1",
      subscriber: { agent_id: "watcher-1" },
      filter: {
        tag: "watched",
        kind: "proposal"
      },
      source_envelope_id: "env-subscription-1",
      correlation_id: "corr-subscription"
    });

    fixture.blackboard.write({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-watch",
      key: "observation/watched",
      type: "observation",
      value: { ignored: true },
      created_by: { agent_id: "observer-1" },
      tags: ["watched"],
      metadata: {
        source_envelope_id: "env-observation-1"
      }
    });
    const proposal = fixture.blackboard.propose({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-watch",
      proposal_id: "proposal-watch",
      proposer: { agent_id: "planner-1" },
      value: { watched: true },
      tags: ["watched"],
      metadata: {
        source_envelope_id: "env-proposal-watch"
      }
    });

    assert.equal(subscription.source_envelope_id, "env-subscription-1");
    assert.deepEqual(fixture.blackboard.entriesForSubscription(subscription.subscription_id).map((entry) => entry.entry_id), [
      proposal.entry_id
    ]);
    assert.deepEqual(fixture.blackboard.read("session-1", { subscriptionId: subscription.subscription_id }).map((entry) => entry.key), [
      "proposal/proposal-watch"
    ]);
    assert.equal(fixture.blackboard.listSubscriptions("session-1").length, 1);
    assert.equal(fixture.blackboard.listEvents("session-1", { kind: "subscription" })[0]?.source_envelope_id, "env-subscription-1");
  } finally {
    fixture.close();
  }
});

function createFixture(): {
  root: string;
  database: SwarmDatabase;
  blackboard: BlackboardStore;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-blackboard-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const blackboard = new BlackboardStore(database);
  return {
    root,
    database,
    blackboard,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
