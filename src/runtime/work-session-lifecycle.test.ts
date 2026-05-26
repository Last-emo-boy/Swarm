import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentInvocationRequest, AgentTaskPacket } from "./agent-specs.js";
import type { RuntimeEvent } from "./events.js";
import { buildResultCardFromSnapshot } from "./result-card.js";
import { postChangeExecutionStatus, SwarmRuntime } from "./runtime.js";
import { createEnvelope } from "../protocol/envelope.js";
import { buildSessionSnapshot, buildWorkspaceSnapshot } from "../server/session-view.js";
import type { ReviewResult, SwarmPolicy, WorkItem } from "../protocol/types.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";

test("WorkSession facts project into WorkSnapshot and session view contracts", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const seeded = seedWorkSession(runtime, fixture);
    runtime.agentActorRuntime.register({
      actor_id: "worker:policy-lifecycle",
      kind: "worker",
      name: "Policy Lifecycle Worker",
      role: "reviewer",
      capabilities: [],
      status: "idle",
      metadata: {
        autonomy_policy: {
          level: "execute",
          capability_leases: [
            {
              capability: "code.review",
              actions: ["task.accept"],
              source_envelope_id: "env-policy-lease-lifecycle"
            }
          ]
        }
      },
      now: AT
    });
    runtime.agentActorRuntime.heartbeat("worker:policy-lifecycle", {
      current_session_id: seeded.sessionId,
      current_task_id: "task-write-test",
      now: AT
    });
    runtime.agentMemoryStore.append({
      actor_id: "worker:policy-lifecycle",
      session_id: seeded.sessionId,
      task_id: "task-write-test",
      kind: "task_experience",
      content: "Raw lifecycle memory content should stay out of protocol actor projection.",
      summary: "Lifecycle worker learned session projection coverage.",
      retention_policy: "long_term",
      source_envelope_id: "env-session-view-agent-memory",
      created_at: "2026-05-25T00:00:01.000Z"
    });
    runtime.agentActorRuntime.register({
      actor_id: "worker:capability-unavailable-lifecycle",
      kind: "worker",
      name: "Capability Unavailable Worker",
      role: "reviewer",
      capabilities: ["code.review"],
      status: "idle",
      metadata: {
        blocked_reason: "Provider unavailable for code.review."
      },
      now: AT
    });
    runtime.blackboardStore.write({
      swarm_id: "swarm-session-lifecycle-1",
      session_id: seeded.sessionId,
      task_id: "task-write-test",
      key: "proposal/session-view-collaboration",
      type: "plan",
      value: { plan: "project blackboard collaboration through session view" },
      created_by: { agent_id: "planner-lifecycle" },
      tags: ["proposal", "blackboard"],
      metadata: {
        kind: "proposal",
        proposal_id: "session-view-collaboration",
        decision_status: "proposed",
        decision_policy: { mode: "reviewer_approval", required_reviewers: ["worker:policy-lifecycle"] },
        decision_policy_status: "waiting",
        decision_waiting_for: ["worker:policy-lifecycle"],
        source_envelope_id: "env-session-view-proposal"
      }
    });
    runtime.blackboardStore.write({
      swarm_id: "swarm-session-lifecycle-1",
      session_id: seeded.sessionId,
      task_id: "task-write-test",
      key: "proposal/session-view-collaboration/decision/decision-1",
      type: "decision",
      value: { status: "accepted" },
      created_by: { agent_id: "lead-lifecycle" },
      tags: ["decision", "blackboard"],
      metadata: {
        kind: "decision",
        proposal_id: "session-view-collaboration",
        decision_id: "decision-1",
        decision_status: "accepted",
        decision_policy: { mode: "reviewer_approval", required_reviewers: ["worker:policy-lifecycle"] },
        decision_policy_status: "satisfied",
        decision_waiting_for: [],
        decision_votes: [{ voter: "worker:policy-lifecycle", vote: "approve", source_envelope_id: "env-session-view-review" }],
        decision_outcome: {
          status: "accepted",
          reason: "Required reviewer approved.",
          policy_status: "satisfied",
          votes: [{ voter: "worker:policy-lifecycle", vote: "approve", source_envelope_id: "env-session-view-review" }]
        },
        source_envelope_id: "env-session-view-decision"
      }
    });

    const snapshot = runtime.getWorkSnapshot(seeded.sessionId);
    assert.equal(snapshot.session.session_id, seeded.sessionId);
    assert.equal(snapshot.session.source?.source, "gateway");
    assert.equal(snapshot.session.source?.source_id, "run-42");
    assert.equal(snapshot.session.workspace_lease_id, seeded.leaseId);
    assert.equal(snapshot.workspace?.workspace_path, fixture.workspace);

    assert.deepEqual(snapshot.changed_files, ["src/runtime/work-session-lifecycle.test.ts"]);
    assert.deepEqual(snapshot.checks, ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"]);
    assert.equal(snapshot.final_outcome?.final_summary, "seeded lifecycle complete");

    assert.equal(snapshot.attempts.length, 2);
    assert.deepEqual(snapshot.attempts.map((attempt) => attempt.kind), ["tool_call", "verification"]);
    assert.equal(snapshot.graph.tasks.length, 1);
    assert.equal(snapshot.task_contracts.summary.total, 1);
    assert.equal(snapshot.task_contracts.summary.completed, 1);
    assert.equal(snapshot.task_contracts.summary.scoped_write, 1);
    assert.deepEqual(snapshot.task_contracts.summary.scoped_targets, ["src/runtime/work-session-lifecycle.test.ts"]);

    assert.equal(snapshot.workers.length, 1);
    assert.equal(snapshot.work_contracts.summary.active_workers, 1);
    assert.equal(snapshot.work_contracts.summary.active_handoffs, 1);
    assert.equal(snapshot.work_contracts.summary.scoped_write, 1);
    assert.deepEqual(snapshot.work_contracts.summary.scoped_targets, [
      "src/runtime/work-session-lifecycle.test.ts",
      "docs/WORK_KERNEL.md"
    ]);

    assert.equal(snapshot.blackboard_counts.evidence, 2);
    assert.equal(snapshot.blackboard_counts.critique, 1);
    assert.equal(snapshot.review?.verdict, "approve");
    assert.equal(snapshot.verification && typeof snapshot.verification === "object" && "status" in snapshot.verification
      ? snapshot.verification.status
      : undefined, "success");
    assert.equal(snapshot.usage_summary["tool_call.count"], 2);
    assert.equal(snapshot.context_summary?.entries, 2);
    assert.equal(snapshot.context_summary?.compactions, 1);
    assert.equal(snapshot.context_summary?.health, "compacted");
    assert.equal(snapshot.context_summary?.last_learned?.kind, "final");
    assert.equal(snapshot.context_summary?.last_learned?.role, "assistant");
    assert.equal(snapshot.context_summary?.last_learned?.created_at, AT);
    assert.equal(snapshot.context_summary?.last_compacted_at, snapshot.context_summary?.latest_compaction?.created_at);

    const sessionView = buildSessionSnapshot(runtime, seeded.sessionId);
    assert.deepEqual(normalizeLeaseAges(sessionView.work_snapshot), normalizeLeaseAges(snapshot));
    assert.deepEqual(sessionView.task_contracts, snapshot.task_contracts);
    assert.deepEqual(normalizeLeaseAges(sessionView.work_contracts), normalizeLeaseAges(snapshot.work_contracts));
    const sessionProtocol = sessionView.swarm_protocol as {
      schema_version: string;
      actors: Array<{
        actor_id: string;
        kind: string;
        mailbox: { actor_id: string };
        memory: { health: string; entries: number; cache_stable_summary_hash: string; last_learned_at?: string; last_source_envelope_id?: string };
        autonomy_policy: { attached: boolean; level: string; capability_leases: number; active_capability_leases: number };
      }>;
      summary: {
        actors: number;
        legacy_audit_status: string;
        legacy_direct_path_exceptions: number;
        autonomy_policy_attached: number;
        agent_memory_ready: number;
        agent_memory_frozen: number;
        blackboard_decisions: number;
        blackboard_unresolved_proposals: number;
      };
      blackboard: {
        decision_history: Array<{
          proposal_id: string;
          status: string;
          decider?: string;
          policy?: { mode: string; required_reviewers?: string[] };
          policy_status?: string;
          waiting_for?: string[];
          outcome?: { status: string; policy_status?: string };
        }>;
        unresolved_proposals: Array<{ proposal_id: string }>;
      };
    };
    assert.equal(sessionProtocol.schema_version, "swarm.protocol_projection.v1");
    assert(sessionProtocol.actors.some((actor) => actor.actor_id === "main_swarm" && actor.kind === "main"));
    assert(sessionProtocol.actors.some((actor) => actor.actor_id === "router" && actor.kind === "router"));
    assert(sessionProtocol.actors.some((actor) => actor.actor_id === "blackboard" && actor.kind === "blackboard"));
    assert(sessionProtocol.actors.some((actor) => actor.actor_id === "symphony.scheduler" && actor.kind === "symphony"));
    const policyActor = sessionProtocol.actors.find((actor) => actor.actor_id === "worker:policy-lifecycle");
    assert(policyActor, "session protocol should project worker actor autonomy policy");
    assert.equal(policyActor.autonomy_policy.attached, true);
    assert.equal(policyActor.autonomy_policy.level, "execute");
    assert.equal(policyActor.autonomy_policy.capability_leases, 1);
    assert.equal(policyActor.autonomy_policy.active_capability_leases, 1);
    assert.equal(policyActor.mailbox.actor_id, "worker:policy-lifecycle");
    assert.equal(policyActor.memory.health, "active");
    assert.equal(policyActor.memory.entries, 1);
    assert.equal(policyActor.memory.last_learned_at, "2026-05-25T00:00:01.000Z");
    assert.equal(policyActor.memory.last_source_envelope_id, "env-session-view-agent-memory");
    assert.match(policyActor.memory.cache_stable_summary_hash, /^amx:/);
    assert.equal(JSON.stringify(policyActor).includes("Raw lifecycle memory content"), false);
    assert.equal(sessionProtocol.summary.legacy_audit_status, "pass");
    assert(sessionProtocol.summary.legacy_direct_path_exceptions > 0);
    assert(sessionProtocol.summary.autonomy_policy_attached >= 1);
    assert.equal(sessionProtocol.summary.agent_memory_ready, 1);
    assert.equal(sessionProtocol.summary.agent_memory_frozen, 0);
    assert.equal(sessionProtocol.summary.blackboard_decisions, 1);
    assert.equal(sessionProtocol.summary.blackboard_unresolved_proposals, 0);
    assert.deepEqual(sessionProtocol.blackboard.decision_history.map((decision) => ({
      proposal_id: decision.proposal_id,
      status: decision.status,
      decider: decision.decider,
      policy_mode: decision.policy?.mode,
      policy_status: decision.policy_status,
      waiting_for: decision.waiting_for,
      outcome_status: decision.outcome?.status,
      outcome_policy_status: decision.outcome?.policy_status
    })), [{
      proposal_id: "session-view-collaboration",
      status: "accepted",
      decider: "lead-lifecycle",
      policy_mode: "reviewer_approval",
      policy_status: "satisfied",
      waiting_for: [],
      outcome_status: "accepted",
      outcome_policy_status: "satisfied"
    }]);
    assert.deepEqual(sessionProtocol.blackboard.unresolved_proposals, []);
    const sessionExtensions = sessionView.extensions as {
      capability_participants: {
        schema_version: string;
        participants: Array<{ participant_id: string; kind: string; lease: { required: boolean } }>;
        summary: { total: number; by_kind: { skill: number } };
      };
      capability_directory: {
        schema_version: string;
        cards: Array<{
          participant_id: string;
          kind: string;
          capability_ids: string[];
          health: { available: boolean; reason?: string; recoverySuggestion?: string };
          leases: { active: Array<{ capability: string; source_envelope_id?: string }>; expired: unknown[]; revoked: unknown[] };
        }>;
        summary: { total: number; unavailable: number; by_kind: { actor: number; skill: number } };
      };
      skills: { skills: unknown[] };
    };
    assert.equal(sessionExtensions.capability_participants.schema_version, "swarm.capability_participants.v1");
    assert.equal(sessionExtensions.capability_participants.summary.total, sessionExtensions.capability_participants.participants.length);
    assert.equal(sessionExtensions.capability_participants.summary.by_kind.skill, sessionExtensions.skills.skills.length);
    assert(sessionExtensions.capability_participants.participants.some((participant) =>
      participant.participant_id.startsWith("capability:skill:") &&
      participant.kind === "skill" &&
      participant.lease.required
    ));
    assert.equal(sessionExtensions.capability_directory.schema_version, "swarm.capability_directory.v1");
    assert.equal(sessionExtensions.capability_directory.summary.total, sessionExtensions.capability_directory.cards.length);
    const policyCapabilityCard = sessionExtensions.capability_directory.cards.find((card) => card.participant_id === "worker:policy-lifecycle");
    assert(policyCapabilityCard, "session extensions should expose worker capability card");
    assert.equal(policyCapabilityCard.kind, "actor");
    assert(policyCapabilityCard.capability_ids.includes("code.review"));
    assert.equal(policyCapabilityCard.leases.active[0]?.source_envelope_id, "env-policy-lease-lifecycle");
    const blockedCapabilityCard = sessionExtensions.capability_directory.cards.find((card) => card.participant_id === "worker:capability-unavailable-lifecycle");
    assert(blockedCapabilityCard, "session extensions should expose unavailable actor capability card");
    assert.equal(blockedCapabilityCard.health.available, false);
    assert.match(blockedCapabilityCard.health.reason ?? "", /Provider unavailable/);
    assert.match(blockedCapabilityCard.health.recoverySuggestion ?? "", /capability lease/);

    const workspaceView = buildWorkspaceSnapshot(runtime, { limit: 10 });
    assert.equal((workspaceView.summary as Record<string, unknown>).sessions, 1);
    assert.equal((workspaceView.summary as Record<string, unknown>).active_sessions, 1);
    assert.equal((workspaceView.summary as Record<string, unknown>).total_workers, 1);
    assert.equal((workspaceView.summary as Record<string, unknown>).active_handoffs, 1);
    const workspaceProtocol = workspaceView.swarm_protocol as { summary: { legacy_audit_status: string; legacy_direct_path_exceptions: number; actors: number; blackboard_decisions: number } };
    assert.equal(workspaceProtocol.summary.legacy_audit_status, "pass");
    assert(workspaceProtocol.summary.legacy_direct_path_exceptions > 0);
    assert(workspaceProtocol.summary.actors >= sessionProtocol.summary.actors);
    assert(workspaceProtocol.summary.blackboard_decisions >= 1);
    const workspaceExtensions = workspaceView.extensions as typeof sessionExtensions;
    assert.equal(workspaceExtensions.capability_participants.schema_version, "swarm.capability_participants.v1");
    assert.equal(workspaceExtensions.capability_participants.summary.by_kind.skill, workspaceExtensions.skills.skills.length);
    assert.equal(workspaceExtensions.capability_directory.schema_version, "swarm.capability_directory.v1");
    assert(workspaceExtensions.capability_directory.cards.some((card) =>
      card.participant_id === "worker:policy-lifecycle" &&
      card.capability_ids.includes("code.review") &&
      card.leases.active[0]?.source_envelope_id === "env-policy-lease-lifecycle"
    ));
    assert(workspaceExtensions.capability_directory.cards.some((card) =>
      card.participant_id === "worker:capability-unavailable-lifecycle" &&
      card.health.available === false &&
      /Provider unavailable/.test(card.health.reason ?? "")
    ));
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("session view projects squad topology from protocol replay", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const seeded = seedWorkSession(runtime, fixture);
    runtime.agentActorRuntime.register({
      actor_id: "worker:squad-session-lead",
      kind: "worker",
      name: "Squad Session Lead",
      role: "leader",
      capabilities: ["team.lead"],
      now: AT
    });
    runtime.agentActorRuntime.register({
      actor_id: "worker:squad-session-coder",
      kind: "worker",
      name: "Squad Session Coder",
      role: "specialist",
      capabilities: ["code.implement"],
      now: AT
    });
    runtime.agentActorRuntime.register({
      actor_id: "worker:squad-session-reviewer",
      kind: "worker",
      name: "Squad Session Reviewer",
      role: "reviewer",
      capabilities: ["code.review"],
      now: AT
    });
    runtime.agentActorRuntime.register({
      actor_id: "worker:squad-session-aggregator",
      kind: "worker",
      name: "Squad Session Aggregator",
      role: "aggregator",
      capabilities: ["result.aggregate"],
      now: AT
    });

    await runtime.router.dispatch(createEnvelope({
      swarm_id: "swarm-session-lifecycle-1",
      session_id: seeded.sessionId,
      task_id: "task-squad-session",
      from: { agent_id: "main_swarm", role: "coordinator" },
      to: { agent_id: "router", role: "router" },
      type: "squad.create",
      intent: "squad.create",
      correlation_id: "corr-squad-session",
      payload: {
        squad_id: "squad-session-view-1",
        objective: "Coordinate a risky multi-actor change.",
        risk_level: "r3",
        cache_profile: { preferred_cache: "warm" },
        ownership_lease: { claim_key: "task/task-squad-session" },
        leader: { agent_id: "worker:squad-session-lead", role: "leader" },
        members: [
          { agent_id: "worker:squad-session-coder", role: "specialist", capabilities: ["code.implement"] },
          { agent_id: "worker:squad-session-reviewer", role: "reviewer", capabilities: ["code.review"] }
        ],
        roles: [
          { agent_id: "worker:squad-session-aggregator", role: "aggregator", required_capabilities: ["result.aggregate"] }
        ],
        review_gate: { required: true, reviewer: "worker:squad-session-reviewer" },
        final_result_aggregator: { agent_id: "worker:squad-session-aggregator" }
      }
    }));
    await runtime.router.dispatch(createEnvelope({
      swarm_id: "swarm-session-lifecycle-1",
      session_id: seeded.sessionId,
      task_id: "task-squad-session",
      from: { agent_id: "worker:squad-session-lead", role: "leader" },
      to: { agent_id: "router", role: "router" },
      type: "squad.role.assign",
      intent: "squad.role.assign",
      correlation_id: "corr-squad-session",
      payload: {
        squad_id: "squad-session-view-1",
        member: { agent_id: "worker:squad-session-aggregator", role: "aggregator" },
        role: "aggregator",
        required_capabilities: ["result.aggregate"]
      }
    }));
    await runtime.router.dispatch(createEnvelope({
      swarm_id: "swarm-session-lifecycle-1",
      session_id: seeded.sessionId,
      task_id: "task-squad-session",
      from: { agent_id: "worker:squad-session-lead", role: "leader" },
      to: { agent_id: "router", role: "router" },
      type: "squad.dissolve",
      intent: "squad.dissolve",
      correlation_id: "corr-squad-session",
      payload: {
        squad_id: "squad-session-view-1",
        reason: "Final result aggregated."
      }
    }));

    const sessionView = buildSessionSnapshot(runtime, seeded.sessionId);
    const protocol = sessionView.swarm_protocol as {
      squads: Array<{
        squad_id: string;
        status: string;
        leader_agent_id?: string;
        risk_level?: string;
        cache_profile?: unknown;
        ownership_lease?: unknown;
        review_gate?: unknown;
        final_result_aggregator?: unknown;
        candidates?: Array<{ agent_id?: string; available?: boolean; matched_capabilities?: string[] }>;
        members: Array<{ agent_id: string; role?: string; status: string }>;
        events: Array<{ action: string; envelope_id: string }>;
      }>;
      summary: { squads: number; active_squads: number };
    };

    assert.equal(protocol.summary.squads, 1);
    assert.equal(protocol.summary.active_squads, 0);
    assert.equal(protocol.squads[0]?.squad_id, "squad-session-view-1");
    assert.equal(protocol.squads[0]?.status, "dissolved");
    assert.equal(protocol.squads[0]?.leader_agent_id, "worker:squad-session-lead");
    assert.equal(protocol.squads[0]?.risk_level, "r3");
    assert.deepEqual(protocol.squads[0]?.cache_profile, { preferred_cache: "warm" });
    assert.deepEqual(protocol.squads[0]?.ownership_lease, { claim_key: "task/task-squad-session" });
    assert.deepEqual(protocol.squads[0]?.review_gate, { required: true, reviewer: "worker:squad-session-reviewer" });
    assert.deepEqual(protocol.squads[0]?.final_result_aggregator, { agent_id: "worker:squad-session-aggregator" });
    assert.deepEqual(
      protocol.squads[0]?.candidates?.find((candidate) => candidate.agent_id === "worker:squad-session-coder")?.matched_capabilities,
      ["code.implement"]
    );
    assert.deepEqual(protocol.squads[0]?.events.map((event) => event.action), ["create", "role.assign", "dissolve"]);
    assert(protocol.squads[0]?.members.some((member) =>
      member.agent_id === "worker:squad-session-aggregator" &&
      member.role === "aggregator" &&
      member.status === "left"
    ));
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("persisted approvals and trace envelopes project through WorkSession replay and task detail", () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    const seeded = seedWorkSession(runtime, fixture);
    runtime.approvalStore.upsert(approvalRequest({
      id: "approval_lifecycle_approved",
      sessionId: seeded.sessionId,
      taskId: "task-write-test",
      summary: "Approve lifecycle fixture write",
      detail: "Write deterministic approval projection evidence.",
      riskClass: "r1",
      target: "src/runtime/work-session-lifecycle.test.ts"
    }), "approved");
    runtime.approvalStore.upsert(approvalRequest({
      id: "approval_lifecycle_denied",
      sessionId: seeded.sessionId,
      taskId: "task-write-test",
      summary: "Deny lifecycle shell escalation",
      detail: "Reject an out-of-scope shell escalation fixture.",
      risk: "shell",
      riskClass: "r4",
      target: "shell: rm -rf fixture"
    }), "denied");

    const taskTrace = {
      ...createEnvelope({
        swarm_id: "swarm-session-lifecycle-1",
        session_id: seeded.sessionId,
        task_id: "task-write-test",
        attempt: 1,
        from: { agent_id: "main_swarm" },
        to: { role: "coder" },
        type: "task.assign",
        intent: "lifecycle.trace.task_assign",
        payload: { objective: "Persist trace projection evidence" },
        correlation_id: "corr-lifecycle-trace",
        trace: {
          trace_id: "trace-lifecycle",
          span_id: "span-task-assign"
        }
      }),
      id: "env_lifecycle_task_assign",
      created_at: "2026-05-12T00:00:10.000Z"
    };
    const ackTrace = {
      ...createEnvelope({
        swarm_id: "swarm-session-lifecycle-1",
        session_id: seeded.sessionId,
        from: { agent_id: "coder" },
        to: { agent_id: "main_swarm" },
        type: "ack",
        intent: "lifecycle.trace.ack",
        payload: { delivered: ["coder"] },
        correlation_id: "corr-lifecycle-trace",
        reply_to: taskTrace.id,
        trace: {
          trace_id: "trace-lifecycle",
          span_id: "span-ack",
          parent_span_id: "span-task-assign"
        }
      }),
      id: "env_lifecycle_ack",
      created_at: "2026-05-12T00:00:11.000Z"
    };
    runtime.traceStore.append(taskTrace);
    runtime.traceStore.append(ackTrace);

    const replay = runtime.replaySession(seeded.sessionId);
    assert.match(replay, /Swarm Protocol Actors: \d+/);
    assert.match(replay, /main_swarm \[idle\/fresh\] kind=main/);
    assert.match(replay, /router \[idle\/fresh\] kind=router/);
    assert.match(replay, /blackboard \[idle\/fresh\] kind=blackboard/);
    assert.match(replay, /symphony\.scheduler \[idle\/fresh\] kind=symphony/);
    assert.match(replay, /worker:worker-lifecycle \[busy\/fresh\] kind=worker/);
    assert.match(replay, /Swarm Protocol Mailbox Messages: \d+/);
    assert.match(replay, /Swarm Protocol Legacy Audit: pass exceptions=/);
    assert.match(replay, /Approvals: 2/);
    assert.match(replay, /approval_lifecycle_approved \[approved\/r1\] Approve lifecycle fixture write/);
    assert.match(replay, /approval_lifecycle_denied \[denied\/r4\] Deny lifecycle shell escalation/);
    assert.match(replay, /Trace envelopes: 2/);
    assert.match(replay, /task\.assign task-write-test lifecycle\.trace\.task_assign/);
    assert.match(replay, /ack\s+lifecycle\.trace\.ack/);

    const detail = runtime.getTaskDetail(seeded.sessionId, "task-write-test");
    assert.deepEqual(detail.trace.map((envelope) => envelope.id), ["env_lifecycle_task_assign"]);
    assert.equal(detail.trace[0]?.intent, "lifecycle.trace.task_assign");
    assert.equal(detail.trace[0]?.trace?.trace_id, "trace-lifecycle");

    const snapshot = runtime.getWorkSnapshot(seeded.sessionId);
    const sessionView = buildSessionSnapshot(runtime, seeded.sessionId);
    assert.deepEqual(normalizeLeaseAges(sessionView.work_snapshot), normalizeLeaseAges(snapshot));
    assert.deepEqual(sessionView.task_contracts, snapshot.task_contracts);
    assert.deepEqual(normalizeLeaseAges(sessionView.work_contracts), normalizeLeaseAges(snapshot.work_contracts));
    assert.equal("approvals" in (snapshot as Record<string, unknown>), false);
    assert.equal("trace" in (snapshot as Record<string, unknown>), false);

    const workspaceView = buildWorkspaceSnapshot(runtime, { limit: 10 });
    const approvals = workspaceView.approvals as {
      approvals: Array<{ approval_id: string; status: string; risk_class: string }>;
      summary: { approved: number; denied: number; persisted_pending: number };
    };
    assert.equal(approvals.summary.approved, 1);
    assert.equal(approvals.summary.denied, 1);
    assert(approvals.approvals.some((approval) =>
      approval.approval_id === "approval_lifecycle_approved" &&
      approval.status === "approved" &&
      approval.risk_class === "r1"
    ));
    assert(approvals.approvals.some((approval) =>
      approval.approval_id === "approval_lifecycle_denied" &&
      approval.status === "denied" &&
      approval.risk_class === "r4"
    ));
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("runtime coding loop creates WorkSession attempts and WorkSnapshot through the entrypoint", async () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.workspace, "README.md"), "runtime-created session fixture\n");
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const calls: Array<{ purpose?: string }> = [];
  const events: RuntimeEvent[] = [];
  const unsubscribe = runtime.events.onEvent((event) => {
    if (event.type === "final") {
      events.push(event);
    }
  });
  const provider = runtimeProvider(runtime);
  provider.generateText = async (request) => {
    calls.push({ purpose: request.usage?.purpose });
    return JSON.stringify({
      status: "completed",
      summary: "runtime-created session complete",
      message: "runtime-created session complete",
      tool_calls: [],
      files_touched: [],
      next_actions: []
    });
  };

  try {
    const result = await runtime.run("Prove runtime-created WorkSession evidence", {
      mode: "coding_loop",
      maxTurns: 1,
      maxToolCalls: 0
    });

    assert.equal(result.status, "completed");
    assert.match(result.session_id, /^loop_/);
    assert.equal(result.content, "runtime-created session complete");
    assert.deepEqual(calls.map((call) => call.purpose), ["main_coding_loop"]);
    const finalEvent = events[events.length - 1];
    assert.equal(finalEvent?.type, "final");
    assert.equal(finalEvent?.checkpoint?.name, "Prove runtime-created WorkSession evidence");
    assert.equal(finalEvent?.checkpoint?.revertAvailable, true);

    const row = runtime.sessionStore.get(result.session_id);
    assert(row, "runtime entrypoint should persist a WorkSession row");
    assert.equal(row.status, "completed");
    assert.equal(row.objective, "Prove runtime-created WorkSession evidence");
    assert.equal(row.final_output, "runtime-created session complete");
    assert(row.workspace_lease_id, "runtime-created WorkSession should own a workspace lease");

    const source = parseJson(row.source_json) as WorkItem;
    assert.equal(source.source, "user");
    assert.equal(source.human_id, result.session_id);
    assert.equal(source.title, "Prove runtime-created WorkSession evidence");
    assert.equal(source.description, "Prove runtime-created WorkSession evidence");
    assert.equal(source.metadata?.mode, "coding_loop");

    const lease = runtime.workspaceLeaseStore.get(row.workspace_lease_id);
    assert(lease, "workspace lease should be persisted for runtime-created session");
    assert.equal(lease.session_id, result.session_id);
    assert.equal(lease.workspace_path, fixture.workspace);
    assert.equal(runtime.workspaceLeaseStore.getBySession(result.session_id)?.lease_id, lease.lease_id);

    const attempts = runtime.runAttemptStore.list(result.session_id);
    const codingTurn = attempts.find((attempt) => attempt.task_id === "coding_turn_1");
    assert(codingTurn, "coding loop should persist a coding_turn_1 RunAttempt");
    assert.equal(codingTurn.kind, "coding_turn");
    assert.equal(codingTurn.status, "completed");
    assert.equal(codingTurn.attempt, 1);
    assert.equal(codingTurn.title, "Coding loop turn");
    assert.equal(codingTurn.workspace_path, fixture.workspace);

    const snapshot = runtime.getWorkSnapshot(result.session_id);
    assert.equal(snapshot.session.session_id, result.session_id);
    assert.equal(snapshot.session.status, "completed");
    assert.equal(snapshot.session.workspace_lease_id, lease.lease_id);
    assert.equal(snapshot.session.source?.source, "user");
    assert.equal(snapshot.session.source?.metadata?.mode, "coding_loop");
    assert.equal(snapshot.workspace?.workspace_path, fixture.workspace);
    assert.deepEqual(snapshot.changed_files, []);
    assert.deepEqual(snapshot.checks, []);
    assert.equal(snapshot.final_outcome?.final_summary, "runtime-created session complete");
    assert.deepEqual(snapshot.final_outcome?.changed_files, []);
    assert(snapshot.attempts.some((attempt) => attempt.task_id === "coding_turn_1" && attempt.status === "completed"));
    assert(snapshot.attempts.some((attempt) => attempt.task_id === "final" && attempt.status === "completed"));
    assert((snapshot.context_summary?.entries ?? 0) > 0);

    const sessionView = buildSessionSnapshot(runtime, result.session_id);
    assert.deepEqual(normalizeLeaseAges(sessionView.work_snapshot), normalizeLeaseAges(snapshot));
    assert.deepEqual(sessionView.task_contracts, snapshot.task_contracts);
    assert.deepEqual(normalizeLeaseAges(sessionView.work_contracts), normalizeLeaseAges(snapshot.work_contracts));
  } finally {
    unsubscribe();
    runtime.dispose();
    fixture.close();
  }
});

test("MCP resource materialization records cache policy and context-impact evidence", async () => {
  const fixture = createFixture();
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });

  try {
    runtime.ensureTuiChatSession("mcp_material_policy_session");
    const result = await runtimeAccess(runtime).recordMcpMaterial({
      kind: "resource",
      serverId: "demo",
      nameOrUri: "demo://readme",
      sessionId: "mcp_material_policy_session",
      result: {
        contents: [{ uri: "demo://readme", text: "hello from mcp" }]
      }
    });

    const artifact = result._swarm_artifact;
    assert(artifact, "materialized MCP result should include artifact metadata");
    assert.equal(artifact.source, "mcp");
    assert.equal(artifact.server_id, "demo");
    assert.equal(artifact.read_only, true);
    assert.equal(artifact.risk_class, "r0");
    assert.equal(artifact.cache_policy.cachePolicy, "stable_summary");
    assert.equal(artifact.cache_policy.ttlSeconds, 3600);
    assert.equal(artifact.cache_policy.stablePrefixEligible, true);
    assert.equal(artifact.context_impact.segment, "stable_prefix");
    assert.equal(artifact.context_impact.promptCacheImpact, "low");
    assert.match(artifact.activation_reason, /read-only r0 artifact/);

    const evidence = runtime.blackboardStore.query("mcp_material_policy_session", { tag: "mcp" });
    const material = evidence.find((entry) => {
      const value = entry.value as { server_id?: string; name_or_uri?: string };
      return value.server_id === "demo" && value.name_or_uri === "demo://readme";
    });
    assert(material, "MCP materialization should write blackboard evidence");
    const value = material.value as {
      source?: string;
      read_only?: boolean;
      risk_class?: string;
      cache_policy?: { cachePolicy?: string; ttlSeconds?: number };
      context_impact?: { segment?: string; promptCacheImpact?: string };
    };
    assert.equal(value.source, "mcp");
    assert.equal(value.read_only, true);
    assert.equal(value.risk_class, "r0");
    assert.equal(value.cache_policy?.cachePolicy, "stable_summary");
    assert.equal(value.cache_policy?.ttlSeconds, 3600);
    assert.equal(value.context_impact?.segment, "stable_prefix");

    const audit = runtime.auditStore.list("mcp_material_policy_session").find((entry) => entry.action === "mcp.resource");
    assert(audit, "MCP materialization should write an audit record");
    assert.equal(audit.risk_class, "r0");
    assert.match(audit.reason ?? "", /cache policy/);
    assert.equal((audit.resource as { read_only?: boolean }).read_only, true);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("TUI chat session memory carries coding loop final output into the next chat prompt", async () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.workspace, "README.md"), "tui memory fixture\n");
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const provider = runtimeProvider(runtime);
  const providerCalls: Array<{ purpose?: string; user?: unknown }> = [];
  provider.generateText = async (request) => {
    providerCalls.push({ purpose: request.usage?.purpose, user: request.user });
    if (request.usage?.purpose === "chat") {
      return "The previous result is remembered.";
    }
    return JSON.stringify({
      status: "completed",
      summary: "remembered coding loop summary",
      message: "remembered coding loop final output",
      tool_calls: [],
      files_touched: [],
      next_actions: []
    });
  };

  try {
    const chatSessionId = "chat_tui_memory_regression";
    runtime.ensureTuiChatSession(chatSessionId);

    const first = await runtime.run("Create a remembered result", {
      mode: "coding_loop",
      tuiChatSessionId: chatSessionId,
      maxTurns: 1,
      maxToolCalls: 0
    });
    assert.equal(first.content, "remembered coding loop final output");

    const second = await runtime.run("What did you just finish?", {
      mode: "chat",
      tuiChatSessionId: chatSessionId
    });
    assert.equal(second.session_id, chatSessionId);

    const chatCall = providerCalls.find((call) => call.purpose === "chat");
    assert(chatCall, "second TUI turn should use the chat route");
    assert.match(renderPromptForAssert(chatCall.user), /Previous TUI conversation memory/);
    assert.match(renderPromptForAssert(chatCall.user), /Create a remembered result/);
    assert.match(renderPromptForAssert(chatCall.user), /remembered coding loop final output/);
    assert.match(runtime.sessionContextStore.renderForSession(chatSessionId), /The previous result is remembered/);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("runtime post-change review and verification records deterministic execution evidence", async () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.workspace, "src", "runtime", "work-session-lifecycle.test.ts"), "runtime-created change\n");
  const runtime = new SwarmRuntime({
    workspace: fixture.workspace,
    databasePath: fixture.databasePath,
    approvalHandler: async () => true
  });
  const sessionId = "session-post-change-review-verify";
  const objective = "Prove post-change Review / Verification execution evidence";
  seedPostChangeSession(runtime, fixture, sessionId, objective);
  runtime.blackboardStore.write({
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    key: "workspace/src/runtime/work-session-lifecycle.test.ts",
    type: "evidence",
    value: {
      path: "src/runtime/work-session-lifecycle.test.ts",
      operation: "write",
      taskId: "coding_loop"
    },
    created_by: { agent_id: "tool.file", role: "tool" },
    tags: ["workspace-change", "write", "src/runtime/work-session-lifecycle.test.ts"]
  });

  const providerCalls: Array<{ purpose?: string; user?: unknown }> = [];
  const provider = runtimeProvider(runtime);
  provider.generateText = async (request) => {
    providerCalls.push({ purpose: request.usage?.purpose, user: request.user });
    assert.equal(request.usage?.purpose, "review_normalization");
    assert.equal(request.responseFormat, "json_object");
    return JSON.stringify({
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "needs_revision",
      score: 82,
      issues: [{
        severity: "medium",
        message: "Verifier needs to prove the runtime-created review context is persisted.",
        evidence: "src/runtime/work-session-lifecycle.test.ts",
        suggested_fix: "Assert the verifier context and WorkSnapshot projection."
      }],
      summary: "Post-change review found a deterministic verification gap."
    });
  };

  const invocations: AgentInvocationRequest[] = [];
  let verifierContext = "";
  runtimeAccess(runtime).invokeAgent = async (request) => {
    invocations.push(request);
    if (request.capability === "code.review") {
      assert.equal(request.preferred_agent_spec_id, "reviewer");
      assert.equal(request.preferred_mode, "call_subagent");
      assert(request.context?.includes(objective));
      assert(request.context?.includes("src/runtime/work-session-lifecycle.test.ts"));
      assert(request.context?.includes("node --import tsx --test src/runtime/work-session-lifecycle.test.ts"));
      assert(request.context?.includes("review-notes.md"));
      assert(request.context?.includes("recent_changes"));
      return {
        action: "agent.delegate",
        status: "success",
        summary: "Review Agent completed: deterministic issue found",
        content: "Medium: verifier must receive normalized review JSON.",
        data: { worker_id: "worker_review_runtime" }
      };
    }
    assert.equal(request.capability, "verify");
    assert.equal(invocations[0]?.capability, "code.review");
    assert.equal(request.preferred_agent_spec_id, "verifier");
    assert.equal(request.preferred_mode, "call_subagent");
    verifierContext = request.context ?? "";
    return {
      action: "agent.delegate",
      status: "success",
      summary: "Verification Agent completed: manual verification required",
      content: "Verification gap: reviewer context was inspected; manual verification required for model-backed quality.",
      data: { worker_id: "worker_verify_runtime" }
    };
  };

  try {
    const postCheck = await runtimeAccess(runtime).runPostChangeChecks(sessionId, objective, {
      changed_files: ["src/runtime/work-session-lifecycle.test.ts"],
      tests_run: ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"],
      intermediate_artifacts: ["review-notes.md"],
      final_summary: "post-change done"
    });

    assert(postCheck);
    assert.equal(postCheck.review.verdict, "needs_revision");
    assert.equal(postCheck.review.score, 82);
    assert.equal(postCheck.review.summary, "Review Agent completed: deterministic issue found");
    assert.equal(postCheck.review.issues?.[0]?.message, "Verifier needs to prove the runtime-created review context is persisted.");
    assert.equal(postCheck.verification.status, "partial");
    assert.equal(postCheck.verification.worker_id, "worker_verify_runtime");
    assert.equal(postCheck.verification.summary, "Verification Agent completed: manual verification required");

    assert.deepEqual(invocations.map((request) => request.capability), ["code.review", "verify"]);
    assert.deepEqual(invocations.map((request) => request.preferred_mode), ["call_subagent", "call_subagent"]);
    assert.deepEqual(invocations.map((request) => request.preferred_agent_spec_id), ["reviewer", "verifier"]);
    assert.deepEqual(providerCalls.map((call) => call.purpose), ["review_normalization"]);
    assert(verifierContext.includes("Review result:"));
    assert(verifierContext.includes('"verdict": "needs_revision"'));
    assert(verifierContext.includes('"score": 82'));
    assert(verifierContext.includes('"Verifier needs to prove the runtime-created review context is persisted."'));
    assert(verifierContext.includes('"changed_files"'));
    assert(verifierContext.includes('"tests_run"'));
    assert(verifierContext.includes('"intermediate_artifacts"'));
    assert(verifierContext.includes('"recent_changes"'));

    const attempts = runtime.runAttemptStore.list(sessionId);
    const reviewAttempt = attempts.find((attempt) => attempt.task_id === "review.coding_loop");
    const verificationAttempt = attempts.find((attempt) => attempt.task_id === "verification.coding_loop");
    assert(reviewAttempt);
    assert.equal(reviewAttempt.kind, "review");
    assert.equal(reviewAttempt.runner_id, "reviewer");
    assert.equal(reviewAttempt.status, "completed");
    assert.equal(reviewAttempt.title, "Post-change review");
    assert.equal(reviewAttempt.workspace_path, fixture.workspace);
    assert.equal(reviewAttempt.terminal_reason, "Review Agent completed: deterministic issue found");
    assert.deepEqual((reviewAttempt.metadata.result as ReviewResult).verdict, "needs_revision");
    assert(verificationAttempt);
    assert.equal(verificationAttempt.kind, "verification");
    assert.equal(verificationAttempt.runner_id, "verifier");
    assert.equal(verificationAttempt.status, "completed");
    assert.equal(verificationAttempt.title, "Post-change verification");
    assert.equal(verificationAttempt.workspace_path, fixture.workspace);
    assert.equal(verificationAttempt.terminal_reason, "Verification Agent completed: manual verification required");

    const reviewEntries = runtime.blackboardStore.query(sessionId, { tag: "review" });
    const verificationEntries = runtime.blackboardStore.query(sessionId, { tag: "verify" });
    assert.equal(reviewEntries.length, 1);
    assert.equal(reviewEntries[0]?.type, "critique");
    assert.equal((reviewEntries[0]?.value as ReviewResult).verdict, "needs_revision");
    assert(reviewEntries[0]?.tags?.includes("needs_revision"));
    assert.equal(verificationEntries.length, 1);
    assert.equal(verificationEntries[0]?.type, "evidence");
    assert.equal((verificationEntries[0]?.value as { status?: string }).status, "partial");
    assert(verificationEntries[0]?.tags?.includes("partial"));

    runtime.sessionStore.setFinalOutcome(sessionId, {
      changed_files: ["src/runtime/work-session-lifecycle.test.ts"],
      tests_run: ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"],
      intermediate_artifacts: ["review-notes.md"],
      final_summary: "post-change done"
    });
    const snapshot = runtime.getWorkSnapshot(sessionId);
    assert.equal(snapshot.review?.verdict, "needs_revision");
    assert.equal(snapshot.verification && typeof snapshot.verification === "object" && "worker_id" in snapshot.verification
      ? snapshot.verification.worker_id
      : undefined, "worker_verify_runtime");
    assert.deepEqual(snapshot.changed_files, ["src/runtime/work-session-lifecycle.test.ts"]);
    assert.deepEqual(snapshot.checks, ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"]);

    const card = buildResultCardFromSnapshot(snapshot, "work");
    assert.equal(card.review.status, "warning");
    assert(card.risks.some((risk) => risk.level === "medium" && risk.message.includes("Reviewer reported findings")));
    assert.deepEqual(card.artifacts, ["worker_verify_runtime", "review-notes.md"]);
  } finally {
    runtime.dispose();
    fixture.close();
  }
});

test("post-change partial verification remains a completed run with warning evidence", () => {
  assert.equal(postChangeExecutionStatus({
    review: {
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "needs_revision",
      score: 60,
      issues: [{
        severity: "low",
        message: "Additional edge-case tests would improve confidence."
      }],
      summary: "Review approved the change with low-priority test coverage suggestions."
    },
    verification: {
      status: "partial",
      summary: "Verifier ran npm test successfully but noted non-blocking coverage gaps."
    }
  }), "completed");

  assert.equal(postChangeExecutionStatus({
    review: {
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "needs_revision",
      score: 80,
      issues: [{
        severity: "low",
        message: "LOW missing test for discountPct=0."
      }],
      summary: "Review found a low-priority edge-case coverage warning."
    },
    verification: {
      status: "success",
      summary: "All tests pass."
    }
  }), "completed");

  assert.equal(postChangeExecutionStatus({
    review: {
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "approve",
      score: 95,
      summary: "Review passed."
    },
    verification: {
      status: "failed",
      summary: "npm test failed."
    }
  }), "failed");

  assert.equal(postChangeExecutionStatus({
    review: {
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "reject",
      score: 0,
      issues: [{
        severity: "high",
        message: "Review Agent failed: budget exhausted after spawn powershell.exe ENOENT while collecting review evidence."
      }],
      summary: "Review Agent failed: Budget exhausted before completion."
    },
    verification: {
      status: "success",
      summary: "Verifier Agent completed: npm test passed."
    }
  }), "completed");

  assert.equal(postChangeExecutionStatus({
    review: {
      target_task_id: "coding_loop",
      reviewer: { agent_id: "reviewer", role: "reviewer" },
      verdict: "reject",
      score: 20,
      issues: [{
        severity: "high",
        message: "Implementation returns the wrong result for discounted items."
      }],
      summary: "Reject: incorrect cart total."
    },
    verification: {
      status: "success",
      summary: "Verifier command passed only existing tests."
    }
  }), "failed");
});

function seedWorkSession(runtime: SwarmRuntime, fixture: Fixture): {
  sessionId: string;
  leaseId: string;
} {
  const sessionId = "session-lifecycle-1";
  const swarmId = "swarm-session-lifecycle-1";
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: "lease-session-lifecycle-1",
    session_id: sessionId,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/work-session-lifecycle.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
  });
  const source: WorkItem = {
    source: "gateway",
    source_id: "run-42",
    human_id: "GW-42",
    title: "Gateway lifecycle evidence",
    description: "Seeded WorkSession lifecycle projection",
    labels: ["test", "lifecycle"],
    state: "active",
    metadata: { route: "work" }
  };
  runtime.sessionStore.create({
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: "user-42",
    source,
    workspace_lease_id: lease.lease_id,
    objective: "Prove WorkSession projection",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  });

  runtime.taskGraphStore.upsertSyntheticTool({
    session_id: sessionId,
    swarm_id: swarmId,
    task_id: "task-write-test",
    title: "Write focused lifecycle test",
    action: "file.write",
    status: "completed",
    attempt: 1,
    write_policy: "scoped_write",
    file_scope: ["src/runtime/work-session-lifecycle.test.ts"]
  });
  runtime.runAttemptStore.upsert({
    attempt_id: "attempt-task-write-test",
    session_id: sessionId,
    task_id: "task-write-test",
    kind: "tool_call",
    status: "completed",
    attempt: 1,
    title: "Write focused lifecycle test",
    workspace_path: fixture.workspace,
    metadata: { summary: "file.write src/runtime/work-session-lifecycle.test.ts" }
  });
  runtime.runAttemptStore.upsert({
    attempt_id: "attempt-verify-test",
    session_id: sessionId,
    task_id: "task-write-test",
    kind: "verification",
    status: "completed",
    attempt: 1,
    title: "Verify focused lifecycle test",
    workspace_path: fixture.workspace,
    metadata: { summary: "node --import tsx --test src/runtime/work-session-lifecycle.test.ts" }
  });

  runtime.workerStateStore.create({
    worker_id: "worker-lifecycle",
    display_name: "Lifecycle Worker",
    parent_session_id: sessionId,
    capability: "code.test",
    objective: "Write lifecycle projection test",
    status: "running",
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    file_scope: ["src/runtime/work-session-lifecycle.test.ts"],
    tool_budget: { max_turns: 4, max_tool_calls: 12 },
    task_packet: taskPacket({
      objective: "Write lifecycle projection test",
      fileScope: ["src/runtime/work-session-lifecycle.test.ts"]
    }),
    requested_by: "main_swarm"
  });
  runtime.handoffStore.create({
    handoff_id: "handoff-lifecycle",
    worker_id: "worker-lifecycle",
    parent_session_id: sessionId,
    source_agent: "main_swarm",
    target_agent_spec_id: "reviewer",
    reason: "Review lifecycle evidence",
    task_packet: taskPacket({
      objective: "Review lifecycle docs boundary",
      writePolicy: "read_only",
      fileScope: ["docs/WORK_KERNEL.md"]
    })
  });

  runtime.blackboardStore.write({
    swarm_id: swarmId,
    session_id: sessionId,
    task_id: "task-write-test",
    key: "workspace/src/runtime/work-session-lifecycle.test.ts",
    type: "evidence",
    value: { path: "src/runtime/work-session-lifecycle.test.ts" },
    created_by: { agent_id: "main_swarm" },
    tags: ["workspace-change"]
  });
  runtime.blackboardStore.write({
    swarm_id: swarmId,
    session_id: sessionId,
    task_id: "task-write-test",
    key: "verification/lifecycle",
    type: "evidence",
    value: {
      status: "success",
      summary: "node --import tsx --test src/runtime/work-session-lifecycle.test.ts"
    },
    created_by: { agent_id: "verifier" },
    tags: ["verify", "code.test"]
  });
  runtime.blackboardStore.write({
    swarm_id: swarmId,
    session_id: sessionId,
    task_id: "task-write-test",
    key: "review/lifecycle",
    type: "critique",
    value: {
      target_task_id: "task-write-test",
      reviewer: { agent_id: "reviewer" },
      verdict: "approve",
      score: 0.94,
      summary: "focused lifecycle projection is covered"
    } satisfies ReviewResult,
    created_by: { agent_id: "reviewer" },
    tags: ["review"]
  });
  runtime.usageStore.append({
    session_id: sessionId,
    task_id: "task-write-test",
    kind: "tool_call",
    amount: 2,
    unit: "count",
    metadata: { source: "test" },
    created_at: AT
  });
  runtime.sessionContextStore.append({
    session_id: sessionId,
    kind: "objective",
    role: "user",
    content: "Prove WorkSession projection",
    created_at: AT
  });
  runtime.sessionContextStore.append({
    session_id: sessionId,
    kind: "final",
    role: "assistant",
    content: "seeded lifecycle complete",
    created_at: AT
  });
  runtime.sessionContextStore.compact(sessionId, { maxTokens: 1, keepRecentEntries: 1, summaryMaxTokens: 64 });
  runtime.sessionStore.setFinalOutcome(sessionId, {
    changed_files: ["src/runtime/work-session-lifecycle.test.ts"],
    intermediate_artifacts: ["artifacts/lifecycle.md"],
    tests_run: ["node --import tsx --test src/runtime/work-session-lifecycle.test.ts"],
    final_summary: "seeded lifecycle complete"
  });

  return { sessionId, leaseId: lease.lease_id };
}

function seedPostChangeSession(runtime: SwarmRuntime, fixture: Fixture, sessionId: string, objective: string): void {
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: "lease-post-change-review-verify",
    session_id: sessionId,
    workspace_root: fixture.workspace,
    workspace_path: fixture.workspace,
    scope: ["src/runtime/work-session-lifecycle.test.ts"],
    write_boundary: "workspace",
    metadata: { kind: "test" },
    created_at: AT
  });
  runtime.sessionStore.create({
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    user_request_id: "user-post-change-review-verify",
    source: {
      source: "user",
      human_id: sessionId,
      title: objective,
      description: objective,
      labels: ["test", "review-verification"],
      state: "active",
      metadata: { mode: "coding_loop" }
    },
    workspace_lease_id: lease.lease_id,
    objective,
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: AT,
    updated_at: AT,
    policy: policy()
  });
}

function approvalRequest(input: {
  id: string;
  sessionId: string;
  taskId: string;
  summary: string;
  detail: string;
  risk?: ToolApprovalRequest["risk"];
  riskClass: ToolApprovalRequest["risk_class"];
  target: string;
}): ToolApprovalRequest {
  return {
    id: input.id,
    session_id: input.sessionId,
    task_id: input.taskId,
    action: input.risk === "shell" ? "shell.exec" : "file.write",
    summary: input.summary,
    detail: input.detail,
    risk: input.risk ?? "write",
    risk_class: input.riskClass,
    target: input.target,
    why_now: "CAND-PROD-025 deterministic approval projection evidence.",
    predicted_impact: input.detail,
    rollback_plan: "Fixture only; remove the seeded approval record.",
    permission_decision: "ask",
    permission_reason: "Approval required by deterministic test fixture.",
    permission_mode: "ask",
    permission_name: input.risk === "shell" ? "Bash" : "Write",
    permission_rule: input.risk === "shell" ? "Bash(*)" : "Write(**)"
  };
}

function taskPacket(input: {
  objective: string;
  writePolicy?: AgentTaskPacket["write_policy"];
  fileScope: string[];
}): AgentTaskPacket {
  return {
    objective: input.objective,
    agent_spec_id: "coder",
    invocation_mode: "call_subagent",
    persona_snapshot: "Coder",
    file_scope: input.fileScope,
    allowed_tools: ["file.read", "file.write"],
    write_policy: input.writePolicy ?? "scoped_write",
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: { max_turns: 4, max_tool_calls: 12 },
    expected_output: "Summary",
    return_conditions: ["done"]
  };
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 10_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: "on-request",
    network_access: "deny",
    allow_domains: [],
    human_approval_for: [],
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: [],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    }
  };
}

type Fixture = {
  root: string;
  workspace: string;
  databasePath: string;
  close(): void;
};

function createFixture(): Fixture {
  const root = join(tmpdir(), `swarm-work-session-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src", "runtime"), { recursive: true });
  return {
    root,
    workspace,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function runtimeProvider(runtime: SwarmRuntime): {
  generateText: (request: {
    usage?: { purpose?: string };
    user?: unknown;
    responseFormat?: string;
  }) => Promise<string>;
} {
  return (runtime as unknown as {
    provider: {
      generateText: (request: {
        usage?: { purpose?: string };
        user?: unknown;
        responseFormat?: string;
      }) => Promise<string>;
    };
  }).provider;
}

function renderPromptForAssert(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    return prompt.map((block) => typeof block?.text === "string" ? block.text : JSON.stringify(block)).join("\n\n");
  }
  return JSON.stringify(prompt);
}

function runtimeAccess(runtime: SwarmRuntime): {
  invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult>;
  recordMcpMaterial: <T>(input: {
    kind: "resource" | "prompt";
    serverId: string;
    nameOrUri: string;
    result: T;
    sessionId?: string;
    args?: Record<string, string>;
  }) => Promise<T & {
    _swarm_artifact?: {
      path: string;
      bytes: number;
      lines: number;
      source: "mcp";
      server_id: string;
      kind: "resource" | "prompt";
      name_or_uri: string;
      read_only: true;
      risk_class: "r0";
      cache_policy: {
        cachePolicy: "stable_summary" | "dynamic_context";
        ttlSeconds: number;
        stablePrefixEligible: boolean;
        reason: string;
      };
      context_impact: {
        segment: "stable_prefix" | "dynamic_context";
        bytes: number;
        lines: number;
        promptCacheImpact: "low" | "medium";
        recommendation: string;
      };
      activation_reason: string;
    };
  }>;
  runPostChangeChecks: (
    sessionId: string,
    objective: string,
    outcome?: {
      changed_files: string[];
      tests_run: string[];
      intermediate_artifacts: string[];
      final_summary?: string;
    }
  ) => Promise<{
    review: ReviewResult;
    verification: {
      status: "success" | "partial" | "failed";
      summary: string;
      content?: string;
      worker_id?: string;
    };
  } | undefined>;
} {
  return runtime as unknown as {
    invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult>;
    recordMcpMaterial: <T>(input: {
      kind: "resource" | "prompt";
      serverId: string;
      nameOrUri: string;
      result: T;
      sessionId?: string;
      args?: Record<string, string>;
    }) => Promise<T & {
      _swarm_artifact?: {
        path: string;
        bytes: number;
        lines: number;
        source: "mcp";
        server_id: string;
        kind: "resource" | "prompt";
        name_or_uri: string;
        read_only: true;
        risk_class: "r0";
        cache_policy: {
          cachePolicy: "stable_summary" | "dynamic_context";
          ttlSeconds: number;
          stablePrefixEligible: boolean;
          reason: string;
        };
        context_impact: {
          segment: "stable_prefix" | "dynamic_context";
          bytes: number;
          lines: number;
          promptCacheImpact: "low" | "medium";
          recommendation: string;
        };
        activation_reason: string;
      };
    }>;
    runPostChangeChecks: (
      sessionId: string,
      objective: string,
      outcome?: {
        changed_files: string[];
        tests_run: string[];
        intermediate_artifacts: string[];
        final_summary?: string;
      }
    ) => Promise<{
      review: ReviewResult;
      verification: {
        status: "success" | "partial" | "failed";
        summary: string;
        content?: string;
        worker_id?: string;
      };
    } | undefined>;
  };
}

function parseJson(value: string | null | undefined): unknown {
  assert(value, "Expected JSON text");
  return JSON.parse(value);
}

function normalizeLeaseAges<T>(value: T): T {
  return normalize(value) as T;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = key === "age_ms" && typeof nested === "number" ? 0 : normalize(nested);
    }
    return output;
  }
  return value;
}

const AT = "2026-05-12T00:00:00.000Z";
