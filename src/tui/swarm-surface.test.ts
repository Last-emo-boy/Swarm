import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import type { AgentTaskPacket } from "../runtime/agent-specs.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import type { SwarmPolicy } from "../protocol/types.js";
import { Box } from "./ui.js";
import { InspectorPane } from "./components/InspectorPane.js";
import { displayWidth } from "./display-width.js";
import { frameLines, renderTuiToFrame } from "./renderer/testing.js";
import {
  buildSwarmSurfaceProjection,
  formatSwarmSurface,
  formatSwarmTopologySummary,
  formatSwarmWorkbench
} from "./swarm-surface.js";

const NOW = "2026-05-25T00:10:00.000Z";

test("swarm surface renders active topology and mailbox from durable actor state", async () => {
  const fixture = createFixture();
  try {
    const runtime = fixture.runtime;
    seedSession(runtime, fixture.workspace);
    runtime.agentActorStore.registerSystemActor({
      actor_id: "worker:surface-1",
      kind: "worker",
      name: "Surface Worker",
      role: "coder",
      capabilities: ["code.implement"],
      now: "2026-05-25T00:09:00.000Z"
    });
    runtime.registry.register({
      agent_id: "worker:surface-1",
      name: "Surface Worker",
      role: "worker",
      capabilities: ["code.implement"],
      status: "idle",
      load: { running_tasks: 0, max_tasks: 1 }
    });
    const assign = createEnvelope({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-surface-1",
      from: { agent_id: "main_swarm", role: "coordinator" },
      to: { agent_id: "worker:surface-1", role: "worker" },
      type: "task.assign",
      intent: "surface.assign",
      payload: { objective: "Render topology" },
      correlation_id: "corr-surface-1"
    });
    await runtime.router.dispatch(assign);
    const accept = createEnvelope({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-surface-1",
      from: { agent_id: "worker:surface-1", role: "worker" },
      to: { agent_id: "main_swarm", role: "coordinator" },
      type: "task.accept",
      intent: "surface.accept",
      payload: { accepted: true },
      reply_to: assign.id,
      correlation_id: "corr-surface-1"
    });
    runtime.router.receive(accept);
    runtime.agentActorStore.heartbeat("worker:surface-1", {
      status: "busy",
      current_task_id: "task-surface-1",
      current_session_id: "session-surface-1",
      now: "2026-05-25T00:09:30.000Z"
    });
    runtime.agentMemoryStore.append({
      actor_id: "worker:surface-1",
      session_id: "session-surface-1",
      task_id: "task-surface-1",
      kind: "task_experience",
      content: "Rendered swarm surface memory health without leaking raw prompt history.",
      summary: "Rendered swarm surface memory health.",
      retention_policy: "long_term",
      source_envelope_id: accept.id,
      created_at: "2026-05-25T00:09:45.000Z"
    });

    const surface = buildSwarmSurfaceProjection({ runtime, now: NOW, limit: 20 });
    const detail = formatSwarmSurface(surface, { limit: 20 });
    const agent = formatSwarmSurface(surface, { mode: "agent", actorId: "worker:surface-1" });
    const mailbox = formatSwarmSurface(surface, { mode: "mailbox", actorId: "worker:surface-1" });

    assert.match(formatSwarmTopologySummary(surface), /participants=/);
    assert.match(detail, /worker:surface-1 \[worker\/busy\/fresh\]/);
    assert.match(detail, /memory=active/);
    assert.match(detail, /learned=2026-05-25T00:09:45.000Z/);
    assert.match(detail, /compacted=2026-05-25T00:09:45.000Z/);
    assert.match(agent, /memory entries=1 health=active hash=amx:/);
    assert.match(detail, /task=task-surface-1/);
    assert.match(detail, /actor_task:task-surface-1/);
    assert.match(mailbox, /Mailbox worker:surface-1/);
    assert.match(mailbox, /inbox:task.assign \[acked\]/);
    assert.match(mailbox, /outbox:task.accept \[delivered\]/);
  } finally {
    fixture.close();
  }
});

test("swarm surface marks stale worker heartbeat as a visible conflict", () => {
  const fixture = createFixture();
  try {
    const runtime = fixture.runtime;
    seedSession(runtime, fixture.workspace);
    runtime.agentActorStore.registerSystemActor({
      actor_id: "worker:stale-1",
      kind: "worker",
      name: "Stale Worker",
      role: "reviewer",
      capabilities: ["code.review"],
      now: "2026-05-25T00:00:00.000Z"
    });
    runtime.agentActorStore.markCurrentTask("worker:stale-1", {
      task_id: "task-stale-1",
      session_id: "session-surface-1",
      now: "2026-05-25T00:00:00.000Z"
    });

    const surface = buildSwarmSurfaceProjection({ runtime, now: NOW });
    const detail = formatSwarmSurface(surface);

    assert.equal(surface.summary.stale_participants >= 1, true);
    assert.match(detail, /worker:stale-1 \[worker\/busy\/stale\]/);
    assert.match(detail, /\[WARN\] heartbeat:worker:stale-1/);
    assert.match(detail, /stale heartbeat/);
  } finally {
    fixture.close();
  }
});

test("swarm surface renders handoff ownership and blackboard claim conflict", () => {
  const fixture = createFixture();
  try {
    const runtime = fixture.runtime;
    seedSession(runtime, fixture.workspace);
    const taskPacket = handoffTaskPacket();
    runtime.workerStateStore.create({
      worker_id: "worker-handoff-surface-1",
      parent_session_id: "session-surface-1",
      capability: "handoff.deep_work",
      objective: "Own TUI handoff surface",
      agent_spec_id: "handoff_specialist",
      invocation_mode: "handoff",
      handoff_id: "handoff-surface-1",
      file_scope: ["src/tui/swarm-surface.ts"],
      tool_budget: taskPacket.budget,
      task_packet: taskPacket,
      requested_by: "main_swarm"
    });
    runtime.handoffStore.create({
      handoff_id: "handoff-surface-1",
      worker_id: "worker-handoff-surface-1",
      parent_session_id: "session-surface-1",
      source_agent: "main_swarm",
      target_agent_spec_id: "handoff_specialist",
      reason: "Surface ownership",
      task_packet: taskPacket,
      requester_agent_id: "main_swarm",
      owner_agent_id: "worker:worker-handoff-surface-1",
      request_envelope_id: "env_handoff_request_surface"
    });
    runtime.handoffStore.markConflict({
      handoff_id: "handoff-surface-1",
      reason: "Two owners claimed the same handoff.",
      envelope_id: "env_handoff_conflict_surface"
    });
    runtime.blackboardStore.claim({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-claim-surface",
      claim_key: "task/claim-surface",
      owner: { agent_id: "worker:claim-owner" },
      metadata: { source_envelope_id: "env_claim_surface_1", correlation_id: "corr-claim-surface" }
    });
    runtime.blackboardStore.claim({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-claim-surface",
      claim_key: "task/claim-surface",
      owner: { agent_id: "worker:claim-conflict" },
      metadata: { source_envelope_id: "env_claim_surface_2", correlation_id: "corr-claim-surface" }
    });

    const surface = buildSwarmSurfaceProjection({ runtime, now: NOW, limit: 30 });
    const detail = formatSwarmSurface(surface, { mode: "ownership", limit: 30 });

    assert.match(detail, /handoff:handoff-surface-1 \[conflict\]/);
    assert.match(detail, /owner=worker:worker-handoff-surface-1/);
    assert.match(detail, /env=env_handoff_conflict_surface/);
    assert.match(detail, /blackboard_claim:task\/claim-surface \[claimed\]/);
    assert.match(detail, /blackboard_claim:task\/claim-surface \[conflict\]/);
    assert.match(formatSwarmSurface(surface), /\[ERR\] handoff:handoff-surface-1/);
    assert.match(formatSwarmSurface(surface), /\[WARN\] blackboard:task\/claim-surface/);
  } finally {
    fixture.close();
  }
});

test("swarm surface renders peer negotiation summary without flooding default chat", () => {
  const fixture = createFixture();
  try {
    const runtime = fixture.runtime;
    seedSession(runtime, fixture.workspace);
    runtime.blackboardStore.propose({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-negotiation-surface",
      proposal_id: "nego-surface-1",
      proposer: { agent_id: "worker:surface-coder" },
      target_key: "negotiation/nego-surface-1",
      value: {
        negotiation_id: "nego-surface-1",
        action: "counter",
        status: "counter",
        terms: { scope: ["src/tui/swarm-surface.ts"] }
      },
      tags: ["negotiation", "counter"],
      metadata: {
        source_envelope_id: "env_negotiation_counter_surface",
        source_agent_id: "worker:surface-coder",
        negotiation_id: "nego-surface-1",
        negotiation_action: "counter",
        negotiation_status: "counter",
        delegated_to: "worker:surface-reviewer"
      }
    });

    const surface = buildSwarmSurfaceProjection({ runtime, now: NOW, limit: 30 });
    const detail = formatSwarmSurface(surface, { limit: 30 });
    const workbench = formatSwarmWorkbench(surface, { columns: 120, rows: 40, limit: 30 });

    assert.equal(surface.summary.negotiations, 1);
    assert.match(detail, /Negotiations/);
    assert.match(detail, /negotiation:nego-surface-1 \[counter\]/);
    assert.match(detail, /action=counter/);
    assert.match(detail, /env=env_negotiation_counter_surface/);
    assert.match(workbench, /Negotiations/);
    assert.match(workbench, /worker:surface-reviewer/);
  } finally {
    fixture.close();
  }
});

test("swarm surface renders squad topology summary", () => {
  const fixture = createFixture();
  try {
    const runtime = fixture.runtime;
    seedSession(runtime, fixture.workspace);
    runtime.blackboardStore.claim({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-squad-surface",
      claim_key: "squad/squad-surface-1",
      owner: { agent_id: "worker:surface-lead" },
      value: {
        squad_id: "squad-surface-1",
        action: "create",
        status: "active",
        leader: { agent_id: "worker:surface-lead", role: "leader" },
        members: [
          { agent_id: "worker:surface-coder", role: "specialist", capabilities: ["code.implement"] },
          { agent_id: "worker:surface-reviewer", role: "reviewer", capabilities: ["code.review"] }
        ],
        roles: [
          { agent_id: "worker:surface-aggregator", role: "aggregator", required_capabilities: ["result.aggregate"] }
        ],
        review_gate: { required: true, reviewer: "worker:surface-reviewer" },
        final_result_aggregator: { agent_id: "worker:surface-aggregator" }
      },
      tags: ["squad", "ownership"],
      metadata: {
        source_envelope_id: "env_squad_create_surface",
        source_agent_id: "main_swarm",
        claim_key: "squad/squad-surface-1",
        squad_id: "squad-surface-1",
        squad_action: "create",
        squad_status: "active",
        owner_agent_id: "worker:surface-lead"
      }
    });
    runtime.blackboardStore.write({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-squad-surface",
      key: "squad/squad-surface-1/role.assign/env_squad_role_surface",
      type: "decision",
      value: {
        squad_id: "squad-surface-1",
        action: "role.assign",
        status: "active",
        member: { agent_id: "worker:surface-aggregator", role: "aggregator" },
        role: "aggregator",
        required_capabilities: ["result.aggregate"]
      },
      created_by: { agent_id: "worker:surface-lead" },
      tags: ["squad", "role.assign", "active"],
      metadata: {
        kind: "decision",
        source_envelope_id: "env_squad_role_surface",
        squad_id: "squad-surface-1",
        squad_action: "role.assign",
        squad_status: "active",
        squad_role: "aggregator",
        squad_member_id: "worker:surface-aggregator",
        decision_status: "accepted"
      }
    });

    const surface = buildSwarmSurfaceProjection({ runtime, now: NOW, limit: 30 });
    const detail = formatSwarmSurface(surface, { limit: 30 });
    const workbench = formatSwarmWorkbench(surface, { columns: 120, rows: 40, limit: 30 });

    assert.equal(surface.summary.squads, 1);
    assert.match(formatSwarmTopologySummary(surface), /squads=1/);
    assert.match(detail, /Squads/);
    assert.match(detail, /squad:squad-surface-1 \[active\]/);
    assert.match(detail, /leader=worker:surface-lead/);
    assert.match(detail, /worker:surface-aggregator:aggregator/);
    assert.match(detail, /env=env_squad_role_surface/);
    assert.match(workbench, /Squads/);
    assert.match(workbench, /members=4\/4/);
  } finally {
    fixture.close();
  }
});

test("swarm workbench renders protocol topology ownership mailbox decisions and width snapshots", async () => {
  const fixture = createFixture();
  const previousNoColor = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    const runtime = fixture.runtime;
    seedSession(runtime, fixture.workspace);
    runtime.agentActorStore.registerSystemActor({
      actor_id: "worker:workbench-1",
      kind: "worker",
      name: "Workbench Worker",
      role: "coder",
      capabilities: ["code.implement", "code.review"],
      now: "2026-05-25T00:09:00.000Z"
    });
    runtime.registry.register({
      agent_id: "worker:workbench-1",
      name: "Workbench Worker",
      role: "worker",
      capabilities: ["code.implement", "code.review"],
      status: "idle",
      load: { running_tasks: 0, max_tasks: 1 }
    });
    const assign = createEnvelope({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-workbench-1",
      from: { agent_id: "main_swarm", role: "coordinator" },
      to: { agent_id: "worker:workbench-1", role: "worker" },
      type: "task.assign",
      intent: "workbench.assign",
      payload: { objective: "Render Swarm Workbench" },
      correlation_id: "corr-workbench-1"
    });
    await runtime.router.dispatch(assign);
    runtime.router.receive(createEnvelope({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-workbench-1",
      from: { agent_id: "worker:workbench-1", role: "worker" },
      to: { agent_id: "main_swarm", role: "coordinator" },
      type: "task.accept",
      intent: "workbench.accept",
      payload: { accepted: true },
      reply_to: assign.id,
      correlation_id: "corr-workbench-1"
    }));
    runtime.agentActorStore.heartbeat("worker:workbench-1", {
      status: "busy",
      current_task_id: "task-workbench-1",
      current_session_id: "session-surface-1",
      current_ownership: {
        kind: "task",
        source_envelope_id: assign.id,
        note: "中文宽度"
      },
      now: "2026-05-25T00:09:30.000Z"
    });
    seedHandoffConflict(runtime);
    runtime.blackboardStore.write({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-workbench-1",
      key: "proposal/中文宽度",
      type: "plan",
      value: { summary: "workbench decision proposal" },
      created_by: { agent_id: "planner-workbench" },
      tags: ["proposal", "blackboard"],
      metadata: {
        kind: "proposal",
        proposal_id: "proposal-workbench",
        decision_status: "proposed",
        decision_policy: { mode: "reviewer_approval", required_reviewers: ["worker:workbench-reviewer"] },
        decision_policy_status: "waiting",
        decision_waiting_for: ["worker:workbench-reviewer"],
        source_envelope_id: "env_workbench_proposal"
      }
    });
    runtime.blackboardStore.write({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-workbench-1",
      key: "proposal/中文宽度/decision",
      type: "decision",
      value: { status: "accepted" },
      created_by: { agent_id: "lead-workbench" },
      tags: ["decision", "blackboard"],
      metadata: {
        kind: "decision",
        proposal_id: "proposal-workbench",
        decision_id: "decision-workbench",
        decision_status: "accepted",
        decision_policy: { mode: "reviewer_approval", required_reviewers: ["worker:workbench-reviewer"] },
        decision_policy_status: "satisfied",
        decision_waiting_for: [],
        source_envelope_id: "env_workbench_decision"
      }
    });
    runtime.blackboardStore.claim({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-workbench-1",
      claim_key: "task/workbench-claim",
      owner: { agent_id: "worker:claim-owner" },
      metadata: { source_envelope_id: "env_workbench_claim_1", correlation_id: "corr-workbench-claim" }
    });
    runtime.blackboardStore.claim({
      swarm_id: "swarm-surface-1",
      session_id: "session-surface-1",
      task_id: "task-workbench-1",
      claim_key: "task/workbench-claim",
      owner: { agent_id: "worker:claim-conflict" },
      metadata: { source_envelope_id: "env_workbench_claim_2", correlation_id: "corr-workbench-claim" }
    });

    const surface = buildSwarmSurfaceProjection({ runtime, now: NOW, limit: 40 });
    const summary = formatSwarmWorkbench(surface, { columns: 120, rows: 60, limit: 20 });
    const mailbox = formatSwarmWorkbench(surface, { mode: "mailbox", actorId: "worker:workbench-1", columns: 120, rows: 40 });
    const ownership = formatSwarmWorkbench(surface, { mode: "ownership", columns: 120, rows: 50, limit: 30 });

    assert.match(summary, /Swarm Workbench/);
    assert.match(summary, /Topology/);
    assert.match(summary, /worker:workbench-1 \[worker\/busy\/fresh\]/);
    assert.match(summary, /Mailbox/);
    assert.match(summary, /Ownership/);
    assert.match(summary, /Blackboard/);
    assert.match(summary, /proposal\/中文宽度\/decision/);
    assert.match(summary, /decision=accepted/);
    assert.match(summary, /policy=reviewer_approval/);
    assert.match(summary, /waiting=worker:workbench-reviewer/);
    assert.match(summary, /Conflicts/);
    assert.match(mailbox, /inbox:task.assign \[acked\]/);
    assert.match(mailbox, /outbox:task.accept \[delivered\]/);
    assert.match(ownership, /handoff:handoff-surface-1 \[conflict\]/);
    assert.match(ownership, /blackboard_claim:task\/workbench-claim \[conflict\]/);
    assert.match(ownership, /policy=reviewer_approval/);
    assert.match(ownership, /waiting=worker:workbench-reviewer/);
    assert.match(ownership, /env=env_handoff_conflict_surface/);

    for (const columns of [80, 120, 160]) {
      const frame = formatSwarmWorkbench(surface, { columns, rows: 60, limit: 30 });
      const lines = frame.split(/\r?\n/);
      assert(lines.every((line) => displayWidth(line) <= columns), `line exceeded ${columns} columns:\n${frame}`);
      assert.doesNotMatch(frame, /\u001B\[/);
      const rendered = renderTuiToFrame(React.createElement(Box, { width: columns, height: 60, flexDirection: "column", overflow: "hidden" },
        React.createElement(InspectorPane, {
          title: "Swarm Workbench",
          sessionId: "session-surface-1",
          route: "swarm",
          selected: `${columns} columns`,
          density: columns === 80 ? "compact" : "comfortable",
          content: frame
        })
      ), { columns, rows: 60 });
      const renderedLines = frameLines(rendered);
      const renderedText = renderedLines.join("\n");
      assert.equal(rendered.metadata.invalidLayout, false);
      assert(renderedLines.every((line) => displayWidth(line) <= columns), `rendered line exceeded ${columns} columns:\n${renderedText}`);
      assert.match(renderedText, /SWARM WORKBENCH|Swarm Workbench/);
      assert.match(renderedText, /Topology/);
      assert.match(renderedText, /Ownership/);
      assert.doesNotMatch(renderedText, /\u001B\[/);
    }
  } finally {
    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
    fixture.close();
  }
});

function seedSession(runtime: SwarmRuntime, workspace: string): void {
  const now = "2026-05-25T00:00:00.000Z";
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: "lease-surface-1",
    session_id: "session-surface-1",
    workspace_root: workspace,
    workspace_path: workspace,
    scope: ["src/tui/swarm-surface.ts"],
    write_boundary: "workspace",
    metadata: { kind: "swarm-surface-test" },
    created_at: now
  });
  runtime.sessionStore.create({
    swarm_id: "swarm-surface-1",
    session_id: "session-surface-1",
    user_request_id: "swarm-surface-test",
    workspace_lease_id: lease.lease_id,
    objective: "Validate Swarm surface",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
  });
}

function handoffTaskPacket(): AgentTaskPacket {
  return {
    objective: "Own TUI handoff surface",
    agent_spec_id: "handoff_specialist",
    invocation_mode: "handoff",
    persona_snapshot: "Surface handoff fixture.",
    role_title: "Handoff Specialist",
    persona_brief: "Owns a focused handoff.",
    relevant_context: "TUI surface test.",
    file_scope: ["src/tui/swarm-surface.ts"],
    allowed_tools: ["file.read"],
    write_policy: "scoped_write",
    permission_context: {
      default_mode: "ask",
      allow: [],
      ask: [],
      deny: [],
      additional_directories: []
    },
    budget: {
      max_turns: 3,
      max_tool_calls: 9
    },
    expected_output: "Return evidence.",
    return_conditions: ["done", "blocked"]
  };
}

function seedHandoffConflict(runtime: SwarmRuntime): void {
  const taskPacket = handoffTaskPacket();
  runtime.workerStateStore.create({
    worker_id: "worker-handoff-surface-1",
    parent_session_id: "session-surface-1",
    capability: "handoff.deep_work",
    objective: "Own TUI handoff surface",
    agent_spec_id: "handoff_specialist",
    invocation_mode: "handoff",
    handoff_id: "handoff-surface-1",
    file_scope: ["src/tui/swarm-surface.ts"],
    tool_budget: taskPacket.budget,
    task_packet: taskPacket,
    requested_by: "main_swarm"
  });
  runtime.handoffStore.create({
    handoff_id: "handoff-surface-1",
    worker_id: "worker-handoff-surface-1",
    parent_session_id: "session-surface-1",
    source_agent: "main_swarm",
    target_agent_spec_id: "handoff_specialist",
    reason: "Surface ownership",
    task_packet: taskPacket,
    requester_agent_id: "main_swarm",
    owner_agent_id: "worker:worker-handoff-surface-1",
    request_envelope_id: "env_handoff_request_surface"
  });
  runtime.handoffStore.markConflict({
    handoff_id: "handoff-surface-1",
    reason: "Two owners claimed the same handoff.",
    envelope_id: "env_handoff_conflict_surface"
  });
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4,
    max_parallel_tasks: 2,
    timeout_ms: 60_000,
    retry: { max_attempts: 1, backoff_ms: 100 },
    require_review: false,
    consensus: "coordinator_decision",
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

function createFixture(): {
  root: string;
  workspace: string;
  runtime: SwarmRuntime;
  close(): void;
} {
  const root = join(tmpdir(), `swarm-tui-surface-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const runtime = new SwarmRuntime({
    workspace,
    databasePath: join(root, "swarm.db"),
    approvalHandler: async () => true
  });
  return {
    root,
    workspace,
    runtime,
    close: () => {
      runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
