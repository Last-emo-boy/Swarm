import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { EnvelopeDeliveryStore } from "../storage/envelope-delivery-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { buildSessionSnapshot } from "../server/session-view.js";
import { buildSwarmSurfaceProjection, formatSwarmSurface } from "../tui/swarm-surface.js";
import type { SwarmPolicy } from "../protocol/types.js";
import { AgentActorRuntime, emitLegacyDirectInvokeAdapterTelemetry, formatLegacyDirectInvokeAdapterTelemetry } from "./agent-actor-runtime.js";
import { MailboxDeliveryPump } from "./mailbox-delivery-pump.js";
import { RuntimeEvents } from "./events.js";
import { AgentRegistry } from "./registry.js";
import { buildProtocolReplay } from "./protocol-replay.js";
import { SwarmRuntime } from "./runtime.js";

test("agent actor runtime registers, heartbeats, pauses, terminates, and snapshots mailbox state", () => {
  const fixture = createFixture();
  try {
    const actor = fixture.runtime.register({
      actor_id: "worker:auto-1",
      kind: "worker",
      name: "Autonomous Worker",
      role: "coder",
      capabilities: ["code.implement"],
      metadata: {
        autonomy_policy: {
          level: "execute"
        }
      },
      now: "2026-05-25T00:00:00.000Z"
    });
    assert.equal(actor.status, "idle");
    assert.equal(fixture.registry.get("worker:auto-1")?.card.role, "coder");

    const busy = fixture.runtime.heartbeat("worker:auto-1", {
      status: "busy",
      current_task_id: "task-1",
      current_session_id: "session-1",
      current_ownership: { envelope_id: "env-1" },
      now: "2026-05-25T00:00:02.000Z"
    });
    assert.equal(busy?.current_task_id, "task-1");
    assert.equal(fixture.registry.get("worker:auto-1")?.card.status, "busy");

    const paused = fixture.runtime.pause("worker:auto-1", "Waiting for ownership lease.", {
      now: "2026-05-25T00:00:03.000Z"
    });
    assert.equal(paused?.status, "draining");
    assert.equal(paused?.heartbeat_state, "blocked");

    const terminated = fixture.runtime.terminate("worker:auto-1", "Task complete.", {
      now: "2026-05-25T00:00:04.000Z"
    });
    assert.equal(terminated?.status, "offline");
    assert.equal(fixture.registry.get("worker:auto-1")?.card.status, "offline");

    const snapshot = fixture.runtime.snapshot("worker:auto-1");
    assert.equal(snapshot?.actor.actor_id, "worker:auto-1");
    assert.equal(snapshot?.mailbox.actor_id, "worker:auto-1");
  } finally {
    fixture.close();
  }
});

test("mailbox delivery pump consumes queued envelope, records ack, and updates actor ownership", async () => {
  const fixture = createFixture();
  try {
    fixture.runtime.register({
      actor_id: "worker:mailbox-1",
      kind: "worker",
      name: "Mailbox Worker",
      role: "coder",
      capabilities: ["code.implement"],
      now: "2026-05-25T00:00:00.000Z"
    });
    const assign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-mailbox",
      from: { agent_id: "main_swarm", role: "controller" },
      to: { agent_id: "worker:mailbox-1", role: "coder", capability: "code.implement" },
      type: "task.assign",
      intent: "mailbox.assign",
      payload: { objective: "Handle this from the inbox." },
      routing: { mode: "direct", require_ack: true }
    });
    fixture.traces.append(assign);
    fixture.deliveries.recordQueued(assign);

    const pump = new MailboxDeliveryPump(fixture.deliveries, fixture.traces, fixture.actors);
    const result = await pump.pumpActor("worker:mailbox-1", (envelope) =>
      createEnvelope({
        swarm_id: envelope.swarm_id,
        session_id: envelope.session_id,
        task_id: envelope.task_id,
        from: { agent_id: "worker:mailbox-1", role: "coder", capability: "code.implement" },
        to: envelope.from,
        type: "task.accept",
        intent: "mailbox.accept",
        payload: { status: "accepted" },
        reply_to: envelope.id,
        correlation_id: envelope.id
      })
    );

    assert.equal(result.delivered, 1);
    assert.equal(result.acked, 1);
    const delivery = fixture.deliveries.list({ envelopeId: assign.id })[0];
    assert.equal(delivery?.status, "acked");
    assert.equal(delivery?.recipient_agent_id, "worker:mailbox-1");
    assert(delivery?.last_response_envelope_id);
    const actor = fixture.actors.get("worker:mailbox-1");
    assert.equal(actor?.current_task_id, "task-mailbox");
    assert.equal((actor?.current_ownership as { mailbox_delivery_id?: string } | undefined)?.mailbox_delivery_id, delivery?.delivery_id);
  } finally {
    fixture.close();
  }
});

test("actor runner polls inbox, emits progress, returns task result, and acks assignment", async () => {
  const fixture = createFixture();
  try {
    fixture.runtime.register({
      actor_id: "worker:runner-1",
      kind: "worker",
      name: "Runner Worker",
      role: "coder",
      capabilities: ["code.implement"],
      now: "2026-05-25T00:00:00.000Z"
    });
    const assign = taskAssignEnvelope("worker:runner-1", "task-runner-1", {
      objective: "Implement the inbox runner path.",
      worker_id: "runner-1"
    });
    fixture.traces.append(assign);
    fixture.deliveries.recordQueued(assign);

    const pump = new MailboxDeliveryPump(fixture.deliveries, fixture.traces, fixture.actors);
    const result = await fixture.runtime.runExecutionLoop({
      actor_id: "worker:runner-1",
      pump,
      emit: (envelope) => {
        fixture.traces.append(envelope);
        fixture.deliveries.recordQueued(envelope);
        fixture.deliveries.markDelivered(envelope.id);
      },
      now: "2026-05-25T00:00:01.000Z"
    });

    assert.equal(result.lifecycle, "idle");
    assert.equal(result.handled, 1);
    assert.equal(result.terminal_results, 1);
    assert.equal(result.pump.acked, 1);
    const delivery = fixture.deliveries.list({ envelopeId: assign.id })[0];
    assert.equal(delivery?.status, "acked");
    assert(delivery?.last_response_envelope_id);
    const traceTypes = fixture.traces.list(assign.session_id).map((envelope) => envelope.type);
    assert.deepEqual(traceTypes, ["task.assign", "task.accept", "task.progress", "task.result"]);
    const actor = fixture.actors.get("worker:runner-1");
    assert.equal(actor?.status, "idle");
    assert.equal(actor?.current_task_id, undefined);
    assert.equal(actor?.metadata.runner_lifecycle, "idle");
  } finally {
    fixture.close();
  }
});

test("actor runner restart is idempotent after assignment ack", async () => {
  const fixture = createFixture();
  try {
    fixture.runtime.register({
      actor_id: "worker:runner-restart",
      kind: "worker",
      name: "Restart Worker",
      role: "coder",
      capabilities: ["code.implement"],
      now: "2026-05-25T00:00:00.000Z"
    });
    const assign = taskAssignEnvelope("worker:runner-restart", "task-runner-restart", {
      objective: "Only submit one terminal result.",
      worker_id: "runner-restart"
    });
    fixture.traces.append(assign);
    fixture.deliveries.recordQueued(assign);
    const pump = new MailboxDeliveryPump(fixture.deliveries, fixture.traces, fixture.actors);
    const emit = (envelope: ReturnType<typeof createEnvelope>) => {
      fixture.traces.append(envelope);
      fixture.deliveries.recordQueued(envelope);
      fixture.deliveries.markDelivered(envelope.id);
    };

    const first = await fixture.runtime.runExecutionLoop({
      actor_id: "worker:runner-restart",
      pump,
      emit,
      now: "2026-05-25T00:00:01.000Z"
    });
    const second = await fixture.runtime.runExecutionLoop({
      actor_id: "worker:runner-restart",
      pump,
      emit,
      now: "2026-05-25T00:00:02.000Z"
    });

    assert.equal(first.handled, 1);
    assert.equal(second.handled, 0);
    assert.equal(second.lifecycle, "sleeping");
    assert.equal(fixture.deliveries.list({ envelopeId: assign.id })[0]?.status, "acked");
    const terminalResults = fixture.traces.list(assign.session_id)
      .filter((envelope) => envelope.type === "task.result" && envelope.reply_to === assign.id);
    assert.equal(terminalResults.length, 1);
  } finally {
    fixture.close();
  }
});

test("actor runner failure is visible in session view, TUI surface, and protocol replay", async () => {
  const fixture = createRuntimeFixture();
  try {
    seedSession(fixture.runtime, fixture.workspace, "session-runner-fail");
    fixture.runtime.agentActorRuntime.register({
      actor_id: "worker:runner-fail",
      kind: "worker",
      name: "Failing Runner",
      role: "coder",
      capabilities: ["code.implement"],
      now: "2026-05-25T00:00:00.000Z"
    });
    const assign = taskAssignEnvelope("worker:runner-fail", "task-runner-fail", {
      objective: "Expose deterministic runner failure.",
      worker_id: "runner-fail",
      fail: true,
      fail_reason: "Deterministic runner blocked on missing fixture."
    }, {
      swarm_id: "swarm-session-runner-fail",
      session_id: "session-runner-fail"
    });
    fixture.runtime.traceStore.append(assign);
    fixture.runtime.envelopeDeliveryStore.recordQueued(assign);

    const loop = await fixture.runtime.agentActorRuntime.runExecutionLoop({
      actor_id: "worker:runner-fail",
      pump: fixture.runtime.mailboxDeliveryPump,
      now: "2026-05-25T00:00:01.000Z"
    });

    assert.equal(loop.lifecycle, "blocked");
    assert.equal(loop.terminal_failures, 1);
    assert.equal(fixture.runtime.envelopeDeliveryStore.list({ envelopeId: assign.id })[0]?.status, "acked");

    const sessionView = buildSessionSnapshot(fixture.runtime, "session-runner-fail") as {
      swarm_protocol: {
        actors: Array<{ actor_id: string; status: string; heartbeat_state: string; mailbox: { inbox_acked: number } }>;
      };
    };
    const sessionActor = sessionView.swarm_protocol.actors.find((actor) => actor.actor_id === "worker:runner-fail");
    assert.equal(sessionActor?.status, "degraded");
    assert.equal(sessionActor?.heartbeat_state, "blocked");
    assert.equal(sessionActor?.mailbox.inbox_acked, 1);

    const surface = buildSwarmSurfaceProjection({ runtime: fixture.runtime, now: "2026-05-25T00:00:02.000Z" });
    const surfaceActor = surface.actors.find((actor) => actor.actor_id === "worker:runner-fail");
    assert.equal(surfaceActor?.status, "degraded");
    assert.equal(surfaceActor?.heartbeat_state, "blocked");
    assert.match(formatSwarmSurface(surface), /Deterministic runner blocked on missing fixture/);

    const replay = buildProtocolReplay({
      sessionId: "session-runner-fail",
      envelopes: fixture.runtime.traceStore.list("session-runner-fail"),
      deliveries: fixture.runtime.envelopeDeliveryStore.list({ sessionId: "session-runner-fail" }),
      actors: fixture.runtime.agentActorStore.list()
    });
    const replayActor = replay.actors.find((actor) => actor.actor_id === "worker:runner-fail");
    assert.equal(replayActor?.status, "degraded");
    assert.equal(replayActor?.heartbeat_state, "blocked");
    assert.equal(replay.workers.find((worker) => worker.worker_id === "runner-fail")?.status, "failed");
    assert.equal(replay.deliveries.acked >= 1, true);
  } finally {
    fixture.close();
  }
});

test("legacy direct invoke adapter telemetry emits explicit fallback warning", () => {
  const events = new RuntimeEvents();
  const captured: string[] = [];
  const unsubscribe = events.onEvent((event) => {
    if (event.type === "log" && event.level === "warn") {
      captured.push(event.message);
    }
  });
  try {
    emitLegacyDirectInvokeAdapterTelemetry(events, {
      worker_id: "worker-legacy-1",
      worker_actor_id: "worker:worker-legacy-1",
      parent_session_id: "session-legacy-1",
      agent_spec_id: "coder",
      invocation_mode: "call_subagent",
      assignment_envelope_id: "env-legacy-assignment"
    });
  } finally {
    unsubscribe();
  }

  assert.equal(captured.length, 1);
  assert.match(captured[0] ?? "", /Legacy direct invoke adapter fallback/);
  assert.match(captured[0] ?? "", /protocol=local_worker_actor_adapter/);
  assert.match(captured[0] ?? "", /assignment_envelope_id=env-legacy-assignment/);
  assert.equal(
    formatLegacyDirectInvokeAdapterTelemetry({
      worker_id: "worker-legacy-1",
      worker_actor_id: "worker:worker-legacy-1"
    }),
    "Legacy direct invoke adapter fallback: worker:worker-legacy-1 is still executed by the main runtime after mailbox assignment. protocol=local_worker_actor_adapter worker_id=worker-legacy-1"
  );
});

function createFixture(): {
  root: string;
  database: SwarmDatabase;
  actors: AgentActorStore;
  deliveries: EnvelopeDeliveryStore;
  traces: TraceStore;
  registry: AgentRegistry;
  runtime: AgentActorRuntime;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-agent-runtime-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const actors = new AgentActorStore(database);
  const deliveries = new EnvelopeDeliveryStore(database);
  const traces = new TraceStore(database);
  const events = new RuntimeEvents();
  const registry = new AgentRegistry(events, actors);
  return {
    root,
    database,
    actors,
    deliveries,
    traces,
    registry,
    runtime: new AgentActorRuntime(actors, registry, events),
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function taskAssignEnvelope(
  actorId: string,
  taskId: string,
  payload: Record<string, unknown>,
  overrides: {
    swarm_id?: string;
    session_id?: string;
  } = {}
) {
  return createEnvelope({
    swarm_id: overrides.swarm_id ?? "swarm-runner-1",
    session_id: overrides.session_id ?? "session-runner-1",
    task_id: taskId,
    from: { agent_id: "main_swarm", role: "controller" },
    to: { agent_id: actorId, role: "coder", capability: "code.implement" },
    type: "task.assign",
    intent: "actor.runner.assign",
    payload,
    routing: { mode: "direct", require_ack: true },
    correlation_id: `corr-${taskId}`
  });
}

function createRuntimeFixture(): {
  root: string;
  workspace: string;
  runtime: SwarmRuntime;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-agent-runtime-full-"));
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

function seedSession(runtime: SwarmRuntime, workspace: string, sessionId: string): void {
  const now = "2026-05-25T00:00:00.000Z";
  const swarmId = `swarm-${sessionId}`;
  const lease = runtime.workspaceLeaseStore.create({
    lease_id: `lease-${sessionId}`,
    session_id: sessionId,
    workspace_root: workspace,
    workspace_path: workspace,
    scope: ["src/runtime/agent-actor-runtime.ts"],
    write_boundary: "workspace",
    metadata: { kind: "actor-runner-test" },
    created_at: now
  });
  runtime.sessionStore.create({
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: `request-${sessionId}`,
    workspace_lease_id: lease.lease_id,
    objective: "Validate autonomous actor runner projection",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: now,
    updated_at: now,
    policy: policy()
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
