import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import type { AgentCard, SwarmEnvelope } from "../protocol/types.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { EnvelopeDeliveryStore } from "../storage/envelope-delivery-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";
import { AgentRegistry } from "./registry.js";
import { EnvelopeRouter } from "./router.js";

test("createEnvelope generates deterministic idempotency keys for idempotent message types", () => {
  const first = createEnvelope({
    swarm_id: "swarm-1",
    session_id: "session-1",
    task_id: "task-1",
    attempt: 2,
    from: { agent_id: "coder" },
    to: { agent_id: "reviewer" },
    type: "task.result",
    intent: "task.result",
    payload: { ok: true }
  });
  const second = createEnvelope({
    swarm_id: "swarm-1",
    session_id: "session-1",
    task_id: "task-1",
    attempt: 2,
    from: { agent_id: "coder" },
    to: { agent_id: "reviewer" },
    type: "task.result",
    intent: "task.result",
    payload: { ok: true }
  });
  const nonIdempotent = createEnvelope({
    swarm_id: "swarm-1",
    session_id: "session-1",
    task_id: "task-1",
    attempt: 2,
    from: { agent_id: "coder" },
    to: { agent_id: "reviewer" },
    type: "task.progress",
    intent: "task.progress",
    payload: { ok: true }
  });
  const explicit = createEnvelope({
    swarm_id: "swarm-1",
    session_id: "session-1",
    from: { agent_id: "coder" },
    to: { agent_id: "reviewer" },
    type: "artifact.create",
    intent: "artifact.create",
    idempotency_key: "manual-key",
    payload: { path: "artifact.md" }
  });

  assert.equal(first.idempotency_key, "swarm-1:session-1:task-1:2:task.result");
  assert.equal(second.idempotency_key, first.idempotency_key);
  assert.equal(nonIdempotent.idempotency_key, undefined);
  assert.equal(explicit.idempotency_key, "manual-key");
});

test("createEnvelope preserves explicit trace, routing, correlation, auth, priority, and ttl fields", () => {
  const envelope = createEnvelope({
    swarm_id: "swarm-1",
    session_id: "session-1",
    task_id: "task-1",
    subtask_id: "subtask-1",
    attempt: 3,
    from: { agent_id: "main" },
    to: { role: "coder" },
    type: "task.assign",
    intent: "task.assign",
    payload: { objective: "implement" },
    correlation_id: "corr-1",
    reply_to: "parent-env",
    ttl_ms: 10_000,
    priority: "high",
    trace: {
      trace_id: "trace-1",
      span_id: "span-1",
      parent_span_id: "parent-span"
    },
    auth: {
      actor: "user",
      scopes: ["task.write"],
      delegation_chain: ["user", "main"]
    },
    routing: {
      mode: "role",
      require_ack: true,
      retry: { max_attempts: 2, backoff_ms: 250 }
    }
  });

  assert.equal(envelope.version, "1.0");
  assert.equal(envelope.correlation_id, "corr-1");
  assert.equal(envelope.reply_to, "parent-env");
  assert.equal(envelope.ttl_ms, 10_000);
  assert.equal(envelope.priority, "high");
  assert.deepEqual(envelope.trace, {
    trace_id: "trace-1",
    span_id: "span-1",
    parent_span_id: "parent-span"
  });
  assert.deepEqual(envelope.auth, {
    actor: "user",
    scopes: ["task.write"],
    delegation_chain: ["user", "main"]
  });
  assert.deepEqual(envelope.routing, {
    mode: "role",
    require_ack: true,
    retry: { max_attempts: 2, backoff_ms: 250 }
  });
});

test("router dispatch resolves direct routes and suppresses duplicate idempotent sends", async () => {
  const fixture = createFixture();
  try {
    const coder = fixture.register(agentCard("coder-1", "coder", ["code.implement"]));
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-1",
      attempt: 1,
      from: { agent_id: "main" },
      to: { agent_id: "coder-1" },
      type: "task.result",
      intent: "task.result",
      payload: { ok: true },
      routing: { mode: "direct", require_ack: true }
    });

    const incoming = collectIncoming(fixture.router);
    await fixture.router.dispatch(envelope);
    await fixture.router.dispatch({ ...envelope, id: `${envelope.id}-duplicate` });

    assert.equal(coder.sent.length, 1);
    assert.equal(coder.sent[0].id, envelope.id);
    assert.equal(fixture.registry.get("coder-1")?.card.load.running_tasks, 1);
    assert.equal(fixture.events.some((event) => event.type === "log" && /Skipping duplicate envelope/.test(event.message)), true);
    assert.equal(incoming.some((item) => item.type === "ack" && item.intent === "router.dispatch.ack"), true);
    assert.deepEqual(
      incoming.find((item) => item.intent === "router.dispatch.ack")?.payload,
      { delivered: ["coder-1"], mode: "direct" }
    );

    const traces = fixture.traceStore.list("session-1");
    assert.equal(traces.filter((item) => item.id === envelope.id).length, 1);
    assert.equal(traces.some((item) => item.type === "ack" && item.reply_to === envelope.id), true);

    const deliveries = fixture.deliveryStore.list({ envelopeId: envelope.id });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "acked");
    assert.equal(deliveries[0]?.recipient_agent_id, "coder-1");
    assert(deliveries[0]?.delivered_at, "expected delivered_at");
    assert(deliveries[0]?.acked_at, "expected acked_at");
  } finally {
    fixture.close();
  }
});

test("router dispatch resolves broadcast to all online agents and skips offline agents", async () => {
  const fixture = createFixture();
  try {
    const coder = fixture.register(agentCard("coder-1", "coder", ["code.implement"]));
    const reviewer = fixture.register(agentCard("reviewer-1", "reviewer", ["code.review"]));
    const offline = fixture.register(agentCard("offline-1", "critic", ["code.review"], "offline"));
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      from: { agent_id: "main" },
      to: { role: "nobody" },
      type: "task.assign",
      intent: "broadcast",
      payload: {},
      routing: { mode: "broadcast", require_ack: true }
    });

    const incoming = collectIncoming(fixture.router);
    await fixture.router.dispatch(envelope);

    assert.equal(coder.sent.length, 1);
    assert.equal(reviewer.sent.length, 1);
    assert.equal(offline.sent.length, 0);
    assert.deepEqual(
      incoming.find((item) => item.intent === "router.dispatch.ack")?.payload,
      { delivered: ["coder-1", "reviewer-1"], mode: "broadcast" }
    );
    assert.deepEqual(
      fixture.deliveryStore.list({ envelopeId: envelope.id }).map((item) => `${item.recipient_agent_id}:${item.status}`).sort(),
      ["coder-1:acked", "reviewer-1:acked"]
    );
  } finally {
    fixture.close();
  }
});

test("router dispatch resolves role and capability any/all modes deterministically", async () => {
  const fixture = createFixture();
  try {
    const busyCoder = fixture.register(agentCard("coder-busy", "coder", ["code.implement"], "idle", 2, 0.99));
    const idleCoder = fixture.register(agentCard("coder-idle", "coder", ["code.implement"], "idle", 0, 0.7));
    const reviewer = fixture.register(agentCard("reviewer-1", "reviewer", ["code.review"], "idle", 0, 0.8));

    await fixture.router.dispatch(createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      from: { agent_id: "main" },
      to: { role: "coder" },
      type: "task.assign",
      intent: "role.any",
      payload: {},
      routing: { mode: "any" }
    }));
    assert.equal(idleCoder.sent.length, 1);
    assert.equal(busyCoder.sent.length, 0);
    assert.equal(reviewer.sent.length, 0);

    await fixture.router.dispatch(createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      from: { agent_id: "main" },
      to: { capability: "code.implement" },
      type: "task.assign",
      intent: "capability.all",
      payload: {},
      routing: { mode: "all" }
    }));
    assert.equal(idleCoder.sent.length, 2);
    assert.equal(busyCoder.sent.length, 1);
    assert.equal(reviewer.sent.length, 0);
  } finally {
    fixture.close();
  }
});

test("router suppresses duplicate capability-addressed envelopes before fanout", async () => {
  const fixture = createFixture();
  try {
    const firstCoder = fixture.register(agentCard("coder-1", "coder", ["code.implement"]));
    const secondCoder = fixture.register(agentCard("coder-2", "coder", ["code.implement"]));
    const incoming = collectIncoming(fixture.router);
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-capability-1",
      from: { agent_id: "main" },
      to: { capability: "code.implement" },
      type: "task.assign",
      intent: "capability.replay",
      payload: { objective: "implement" },
      idempotency_key: "capability-once",
      routing: { mode: "all", require_ack: true }
    });

    await fixture.router.dispatch(envelope);
    await fixture.router.dispatch({ ...envelope, id: `${envelope.id}-duplicate` });

    assert.equal(firstCoder.sent.length, 1);
    assert.equal(secondCoder.sent.length, 1);
    assert.deepEqual(
      latestIncoming(incoming, "router.dispatch.ack")?.payload,
      { delivered: ["coder-1", "coder-2"], mode: "all" }
    );
    assert.equal(fixture.events.some((event) => event.type === "log" && /Skipping duplicate envelope/.test(event.message)), true);
    assert.equal(fixture.traceStore.list("session-1").filter((item) => item.id === envelope.id).length, 1);
    assert.equal(fixture.traceStore.list("session-1").some((item) => item.id === `${envelope.id}-duplicate`), false);
    const duplicateDeliveries = fixture.deliveryStore.list({ envelopeId: `${envelope.id}-duplicate` });
    assert.equal(duplicateDeliveries.length, 1);
    assert.equal(duplicateDeliveries[0]?.status, "superseded");
    assert.equal(duplicateDeliveries[0]?.last_response_envelope_id, envelope.id);
  } finally {
    fixture.close();
  }
});

test("router records durable delivery failures for unroutable envelopes", async () => {
  const fixture = createFixture();
  try {
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-missing-route",
      from: { agent_id: "main" },
      to: { capability: "missing.capability" },
      type: "task.assign",
      intent: "missing.route",
      payload: {},
      correlation_id: "corr-missing-route"
    });

    await assert.rejects(() => fixture.router.dispatch(envelope), /No route for envelope/);

    const deliveries = fixture.deliveryStore.list({ envelopeId: envelope.id });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "failed");
    assert.equal(deliveries[0]?.recipient_capability, "missing.capability");
    assert.match(deliveries[0]?.error ?? "", /No route for envelope/);
  } finally {
    fixture.close();
  }
});

test("router records expired delivery state before dispatching stale envelopes", async () => {
  const fixture = createFixture();
  try {
    const coder = fixture.register(agentCard("coder-1", "coder", ["code.implement"]));
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-expired",
      from: { agent_id: "main" },
      to: { agent_id: "coder-1" },
      type: "task.assign",
      intent: "expired.task",
      payload: {},
      ttl_ms: 1
    });
    envelope.created_at = new Date(Date.now() - 60_000).toISOString();

    await fixture.router.dispatch(envelope);

    assert.equal(coder.sent.length, 0);
    const deliveries = fixture.deliveryStore.list({ envelopeId: envelope.id });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "expired");
    assert.equal(deliveries[0]?.recipient_agent_id, "coder-1");
    assert(deliveries[0]?.expired_at, "expected expired_at");
    assert.equal(fixture.traceStore.list("session-1").some((item) => item.id === envelope.id), false);
  } finally {
    fixture.close();
  }
});

test("router persists agent actor registration and status updates", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const card = agentCard("dynamic-coder", "coder", ["code.implement", "code.test"]);
    const register = envelope("agent.register", { card }, { correlationId: "corr-agent-register" });
    await fixture.router.dispatch(register);

    const actor = fixture.actorStore.get("dynamic-coder");
    assert.equal(actor?.actor_id, "dynamic-coder");
    assert.equal(actor?.kind, "builtin");
    assert.equal(actor?.status, "idle");
    assert.deepEqual(actor?.capabilities, ["code.implement", "code.test"]);
    assert.equal(actor?.current_session_id, "session-1");
    assert.equal(latestIncoming(incoming, "agent.register.ack")?.reply_to, register.id);

    const update = envelope("agent.update_status", {
      agent_id: "dynamic-coder",
      status: "degraded"
    }, { correlationId: "corr-agent-status" });
    await fixture.router.dispatch(update);

    const updated = fixture.actorStore.get("dynamic-coder");
    assert.equal(updated?.status, "degraded");
    assert.equal(updated?.metadata.updated_by_envelope, update.id);
    assert.equal(latestIncoming(incoming, "agent.update_status.ack")?.correlation_id, "corr-agent-status");
  } finally {
    fixture.close();
  }
});

test("router projects actor mailbox and current task ownership from envelopes", async () => {
  const fixture = createFixture();
  try {
    const coder = fixture.register(agentCard("coder-actor", "coder", ["code.implement"]));
    const assign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-actor-1",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "coder-actor" },
      type: "task.assign",
      intent: "assign.actor.task",
      payload: { objective: "implement actor test" },
      routing: { mode: "direct", require_ack: true }
    });

    await fixture.router.dispatch(assign);

    assert.equal(coder.sent.length, 1);
    const busyActor = fixture.actorStore.get("coder-actor");
    assert.equal(busyActor?.status, "busy");
    assert.equal(busyActor?.current_task_id, "task-actor-1");
    assert.equal(busyActor?.current_session_id, "session-1");
    assert.equal((busyActor?.current_ownership as { envelope_id?: string } | undefined)?.envelope_id, assign.id);

    const mailbox = fixture.actorStore.mailbox("coder-actor");
    assert.equal(mailbox.inbox_total, 1);
    assert.equal(mailbox.inbox_acked, 1);
    assert.equal(mailbox.current_task_id, "task-actor-1");
    assert.equal(fixture.actorStore.mailbox("main_swarm").outbox_total, 1);
    assert.deepEqual(
      fixture.actorStore.listMailboxMessages("coder-actor", "inbox").map((message) => message.envelope_id),
      [assign.id]
    );

    fixture.router.receive(createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-actor-1",
      from: { agent_id: "coder-actor" },
      to: { agent_id: "main_swarm" },
      type: "task.result",
      intent: "task.result",
      payload: { status: "completed", summary: "done" },
      correlation_id: assign.id
    }));

    const idleActor = fixture.actorStore.get("coder-actor");
    assert.equal(idleActor?.status, "idle");
    assert.equal(idleActor?.current_task_id, undefined);
    assert.equal(idleActor?.current_ownership, undefined);
  } finally {
    fixture.close();
  }
});

test("router records task.reject as ownership release and failed assignment delivery", async () => {
  const fixture = createFixture();
  try {
    fixture.register(agentCard("coder-reject", "coder", ["code.implement"]));
    const assign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-reject-1",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "coder-reject" },
      type: "task.assign",
      intent: "assign.rejectable.task",
      payload: { objective: "implement reject test" },
      routing: { mode: "direct" }
    });

    await fixture.router.dispatch(assign);
    assert.equal(fixture.actorStore.get("coder-reject")?.current_task_id, "task-reject-1");

    const reject = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-reject-1",
      from: { agent_id: "coder-reject" },
      to: { agent_id: "main_swarm" },
      type: "task.reject",
      intent: "task.rejected",
      payload: {
        status: "rejected",
        reason: "capability_mismatch",
        message: "Worker cannot safely accept this assignment."
      },
      correlation_id: assign.id,
      reply_to: assign.id
    });

    fixture.router.receive(reject);

    const actor = fixture.actorStore.get("coder-reject");
    assert.equal(actor?.status, "idle");
    assert.equal(actor?.current_task_id, undefined);
    assert.equal(actor?.current_ownership, undefined);

    const assignmentDelivery = fixture.deliveryStore.list({ envelopeId: assign.id });
    assert.equal(assignmentDelivery.length, 1);
    assert.equal(assignmentDelivery[0]?.status, "failed");
    assert.match(assignmentDelivery[0]?.error ?? "", /cannot safely accept/);
    assert.equal(assignmentDelivery[0]?.last_response_envelope_id, reject.id);

    const rejectDelivery = fixture.deliveryStore.list({ envelopeId: reject.id });
    assert.equal(rejectDelivery.length, 1);
    assert.equal(rejectDelivery[0]?.status, "delivered");
    assert.equal(rejectDelivery[0]?.from_agent_id, "coder-reject");
    assert.equal(rejectDelivery[0]?.recipient_agent_id, "main_swarm");
    assert.deepEqual(
      fixture.actorStore.listMailboxMessages("coder-reject", "outbox").map((message) => message.envelope_id),
      [reject.id]
    );
  } finally {
    fixture.close();
  }
});

test("router denies envelopes above actor autonomy policy and records failed delivery", async () => {
  const fixture = createFixture();
  try {
    fixture.actorStore.registerSystemActor({
      actor_id: "observer-router",
      kind: "builtin",
      name: "Observer Router",
      role: "observer",
      capabilities: [],
      metadata: {
        autonomy_policy: {
          level: "observe"
        }
      }
    });
    const assign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-denied-by-policy",
      from: { agent_id: "observer-router" },
      to: { agent_id: "coder-1" },
      type: "task.assign",
      intent: "policy.denied.assignment",
      payload: {}
    });

    await assert.rejects(() => fixture.router.dispatch(assign), /Envelope denied by autonomy policy/);

    const deliveries = fixture.deliveryStore.list({ envelopeId: assign.id });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "failed");
    assert.match(deliveries[0]?.error ?? "", /requires execute autonomy/);
    assert.equal(fixture.traceStore.list("session-1").some((item) => item.id === assign.id), false);
  } finally {
    fixture.close();
  }
});

test("router request timeout marks durable delivery as failed", async () => {
  const fixture = createFixture();
  try {
    fixture.register(agentCard("coder-1", "coder", ["code.implement"]));
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-timeout",
      from: { agent_id: "main" },
      to: { agent_id: "coder-1" },
      type: "task.assign",
      intent: "timeout.task",
      payload: {}
    });

    await assert.rejects(() => fixture.router.request(envelope, { expect: ["task.result"], timeout_ms: 1 }), /Timed out waiting/);

    const deliveries = fixture.deliveryStore.list({ envelopeId: envelope.id });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "failed");
    assert.match(deliveries[0]?.error ?? "", /Timed out waiting/);
    assert(deliveries[0]?.delivered_at, "expected delivered_at before timeout failure");
    assert(deliveries[0]?.failed_at, "expected failed_at after timeout");
  } finally {
    fixture.close();
  }
});

test("router blackboard handlers persist entries and preserve reply correlation", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const write = envelope("blackboard.write", {
      key: "decision/router",
      type: "decision",
      value: { selected: "coder-1" },
      tags: ["router", "test"],
      visibility: "team"
    }, { correlationId: "corr-blackboard" });
    await fixture.router.dispatch(write);

    const writeAck = latestIncoming(incoming, "blackboard.write.ack");
    assert.equal(writeAck?.reply_to, write.id);
    assert.equal(writeAck?.correlation_id, "corr-blackboard");
    assert.equal((writeAck?.payload as { entry?: { key?: string } }).entry?.key, "decision/router");
    assert.equal(fixture.blackboardStore.list("session-1").length, 1);
    const written = fixture.blackboardStore.list("session-1")[0];
    assert.equal(written?.metadata?.source_envelope_id, write.id);
    assert.deepEqual(written?.metadata?.source_envelope_ids, [write.id]);
    assert.equal(fixture.events.some((event) => event.type === "blackboard" && event.entry.key === "decision/router"), true);

    const read = envelope("blackboard.read", { key: "decision/router" });
    await fixture.router.dispatch(read);
    const readAck = latestIncoming(incoming, "blackboard.read.ack");
    assert.equal(readAck?.reply_to, read.id);
    assert.deepEqual((readAck?.payload as { entries?: Array<{ value: unknown }> }).entries?.map((entry) => entry.value), [
      { selected: "coder-1" }
    ]);

    const update = envelope("blackboard.update", {
      key: "decision/router",
      value: { selected: "coder-2" },
      tags: ["router", "updated"]
    });
    await fixture.router.dispatch(update);
    const updateAck = latestIncoming(incoming, "blackboard.update.ack");
    assert.equal(updateAck?.reply_to, update.id);
    assert.equal((updateAck?.payload as { entry?: { version?: number } }).entry?.version, 2);
    const updatedEntry = fixture.blackboardStore.read("session-1", { key: "decision/router" }).at(-1);
    assert.deepEqual(updatedEntry?.value, {
      selected: "coder-2"
    });
    assert.equal(updatedEntry?.metadata?.kind, "update");
    assert.deepEqual(updatedEntry?.metadata?.source_envelope_ids, [write.id, update.id]);

    const lock = envelope("blackboard.lock", { key: "decision/router", ttl_ms: 1_000 });
    await fixture.router.dispatch(lock);
    assert.deepEqual(latestIncoming(incoming, "blackboard.lock.ack")?.payload, {
      key: "decision/router",
      locked: true
    });

    const unlock = envelope("blackboard.unlock", { key: "decision/router" });
    await fixture.router.dispatch(unlock);
    assert.deepEqual(latestIncoming(incoming, "blackboard.unlock.ack")?.payload, {
      key: "decision/router",
      unlocked: true
    });
    assert.equal(fixture.blackboardStore.listEvents("session-1", { kind: "lock" })[0]?.source_envelope_id, lock.id);
    assert.equal(fixture.blackboardStore.listEvents("session-1", { kind: "unlock" })[0]?.source_envelope_id, unlock.id);

    const invalid = envelope("blackboard.write", { key: "missing-type" }, { correlationId: "corr-error" });
    await fixture.router.dispatch(invalid);
    const error = latestIncoming(incoming, "router.error");
    assert.equal(error?.type, "error");
    assert.equal(error?.reply_to, invalid.id);
    assert.equal(error?.correlation_id, "corr-error");
    assert.match(String((error?.payload as { message?: string }).message), /blackboard\.write requires/);
  } finally {
    fixture.close();
  }
});

test("blackboard store query filters by type, tag, key prefix, task, and agent", () => {
  const fixture = createFixture();
  try {
    seedBlackboardEntry(fixture, {
      key: "decision/router",
      type: "decision",
      taskId: "task-router-1",
      agentId: "reviewer-1",
      tags: ["router", "selected"],
      value: { selected: true }
    });
    seedBlackboardEntry(fixture, {
      key: "evidence/router/first",
      type: "evidence",
      taskId: "task-router-1",
      agentId: "coder-1",
      tags: ["router", "evidence"],
      value: { path: "first.md" }
    });
    seedBlackboardEntry(fixture, {
      key: "evidence/router/second",
      type: "evidence",
      taskId: "task-router-2",
      agentId: "coder-1",
      tags: ["runner", "evidence"],
      value: { path: "second.md" }
    });
    seedBlackboardEntry(fixture, {
      key: "observation/other",
      type: "observation",
      taskId: "task-router-2",
      agentId: "observer-1",
      tags: ["other"],
      value: { ok: true }
    });

    assert.deepEqual(fixture.blackboardStore.query("session-1", { type: "evidence" }).map((entry) => entry.key).sort(), [
      "evidence/router/first",
      "evidence/router/second"
    ]);
    assert.deepEqual(fixture.blackboardStore.query("session-1", { tag: "router" }).map((entry) => entry.key).sort(), [
      "decision/router",
      "evidence/router/first"
    ]);
    assert.deepEqual(fixture.blackboardStore.query("session-1", { keyPrefix: "evidence/router/" }).map((entry) => entry.key).sort(), [
      "evidence/router/first",
      "evidence/router/second"
    ]);
    assert.deepEqual(fixture.blackboardStore.query("session-1", { taskId: "task-router-1" }).map((entry) => entry.key).sort(), [
      "decision/router",
      "evidence/router/first"
    ]);
    assert.deepEqual(fixture.blackboardStore.query("session-1", { agentId: "coder-1" }).map((entry) => entry.key).sort(), [
      "evidence/router/first",
      "evidence/router/second"
    ]);
    assert.equal(fixture.blackboardStore.read("session-1", { limit: 2 }).length, 2);
  } finally {
    fixture.close();
  }
});

test("router blackboard read forwards query filters, limit, and invalid query errors", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    seedBlackboardEntry(fixture, {
      key: "evidence/router/first",
      type: "evidence",
      taskId: "task-router-1",
      agentId: "coder-1",
      tags: ["router", "evidence"],
      value: { path: "first.md" }
    });
    seedBlackboardEntry(fixture, {
      key: "evidence/router/second",
      type: "evidence",
      taskId: "task-router-1",
      agentId: "coder-1",
      tags: ["router", "evidence"],
      value: { path: "second.md" }
    });
    seedBlackboardEntry(fixture, {
      key: "evidence/router/other",
      type: "evidence",
      taskId: "task-router-2",
      agentId: "coder-2",
      tags: ["router"],
      value: { path: "other.md" }
    });
    seedBlackboardEntry(fixture, {
      key: "decision/router",
      type: "decision",
      taskId: "task-router-1",
      agentId: "reviewer-1",
      tags: ["router"],
      value: { selected: "coder-1" }
    });

    const read = envelope("blackboard.read", {
      type: "evidence",
      tag: "evidence",
      keyPrefix: "evidence/router/",
      taskId: "task-router-1",
      agentId: "coder-1",
      limit: 1
    }, { correlationId: "corr-blackboard-query" });
    await fixture.router.dispatch(read);

    const readAck = latestIncoming(incoming, "blackboard.read.ack");
    assert.equal(readAck?.reply_to, read.id);
    assert.equal(readAck?.correlation_id, "corr-blackboard-query");
    const entries = (readAck?.payload as { entries?: Array<{ key: string }> }).entries ?? [];
    assert.equal(entries.length, 1);
    assert(entries.every((entry) => entry.key === "evidence/router/first" || entry.key === "evidence/router/second"));

    const invalid = envelope("blackboard.read", { type: "not-a-blackboard-type" }, { correlationId: "corr-blackboard-query-error" });
    await fixture.router.dispatch(invalid);
    const error = latestIncoming(incoming, "router.error");
    assert.equal(error?.reply_to, invalid.id);
    assert.equal(error?.correlation_id, "corr-blackboard-query-error");
    assert.match(String((error?.payload as { message?: string }).message), /blackboard\.read requires a valid payload\.type/);
  } finally {
    fixture.close();
  }
});

test("router blackboard collaboration envelopes persist source causality and subscription reads", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const claim = envelope("blackboard.write", {
      kind: "claim",
      claim_key: "task/router-collab",
      value: { objective: "own router collaboration task" },
      ttl_ms: 10_000,
      tags: ["router", "claim"]
    }, { correlationId: "corr-router-collab", from: { agent_id: "worker-1" } });
    await fixture.router.dispatch(claim);
    const claimAck = latestIncoming(incoming, "blackboard.write.ack");
    const claimedEntry = (claimAck?.payload as { entry?: { metadata?: { source_envelope_id?: string; kind?: string; claim_status?: string } } }).entry;
    assert.equal(claimedEntry?.metadata?.kind, "claim");
    assert.equal(claimedEntry?.metadata?.claim_status, "claimed");
    assert.equal(claimedEntry?.metadata?.source_envelope_id, claim.id);

    const conflictingClaim = envelope("blackboard.write", {
      kind: "claim",
      claim_key: "task/router-collab",
      value: { objective: "conflicting owner" },
      tags: ["router", "claim"]
    }, { correlationId: "corr-router-collab", from: { agent_id: "worker-2" } });
    await fixture.router.dispatch(conflictingClaim);
    const conflictAck = latestIncoming(incoming, "blackboard.write.ack");
    const conflictEntry = (conflictAck?.payload as { entry?: { metadata?: { source_envelope_id?: string; kind?: string; claim_status?: string } } }).entry;
    assert.equal(conflictEntry?.metadata?.kind, "claim_conflict");
    assert.equal(conflictEntry?.metadata?.claim_status, "conflict");
    assert.equal(conflictEntry?.metadata?.source_envelope_id, conflictingClaim.id);

    const proposal = envelope("blackboard.write", {
      kind: "proposal",
      proposal_id: "proposal-router-collab",
      claim_key: "task/router-collab",
      value: { plan: "project decisions through durable blackboard metadata" },
      tags: ["router", "proposal"]
    }, { correlationId: "corr-router-collab", from: { agent_id: "planner-1" } });
    await fixture.router.dispatch(proposal);

    const review = envelope("blackboard.write", {
      kind: "review",
      proposal_id: "proposal-router-collab",
      verdict: "approve",
      value: { note: "looks consistent" },
      tags: ["router", "review"]
    }, { correlationId: "corr-router-collab", from: { agent_id: "reviewer-1" } });
    await fixture.router.dispatch(review);

    const decision = envelope("blackboard.write", {
      kind: "decision",
      proposal_id: "proposal-router-collab",
      status: "accepted",
      value: { accepted: true },
      tags: ["router", "decision"]
    }, { correlationId: "corr-router-collab", from: { agent_id: "lead-1" } });
    await fixture.router.dispatch(decision);
    const decisionAck = latestIncoming(incoming, "blackboard.write.ack");
    const decisionEntry = (decisionAck?.payload as { entry?: { metadata?: { source_envelope_id?: string; decision_status?: string } } }).entry;
    assert.equal(decisionEntry?.metadata?.decision_status, "accepted");
    assert.equal(decisionEntry?.metadata?.source_envelope_id, decision.id);

    const subscription = envelope("blackboard.write", {
      kind: "subscription",
      subscriber: { agent_id: "watcher-1" },
      filter: {
        kind: "decision",
        proposal_id: "proposal-router-collab"
      }
    }, { correlationId: "corr-router-collab", from: { agent_id: "watcher-1" } });
    await fixture.router.dispatch(subscription);
    const subscriptionAck = latestIncoming(incoming, "blackboard.write.ack");
    const subscriptionId = (subscriptionAck?.payload as { subscription?: { subscription_id?: string; source_envelope_id?: string } }).subscription?.subscription_id;
    assert(subscriptionId);
    assert.equal((subscriptionAck?.payload as { subscription?: { source_envelope_id?: string } }).subscription?.source_envelope_id, subscription.id);

    const readSubscription = envelope("blackboard.read", { subscription_id: subscriptionId }, { correlationId: "corr-router-collab" });
    await fixture.router.dispatch(readSubscription);
    const readAck = latestIncoming(incoming, "blackboard.read.ack");
    const entries = (readAck?.payload as { entries?: Array<{ metadata?: { kind?: string; proposal_id?: string; decision_status?: string } }> }).entries ?? [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.metadata?.kind, "decision");
    assert.equal(entries[0]?.metadata?.proposal_id, "proposal-router-collab");
    assert.equal(entries[0]?.metadata?.decision_status, "accepted");

    assert.equal(fixture.blackboardStore.listEvents("session-1", { kind: "claim", sourceEnvelopeId: claim.id }).length, 1);
    assert.equal(fixture.blackboardStore.listEvents("session-1", { kind: "claim_conflict", sourceEnvelopeId: conflictingClaim.id }).length, 1);
    assert.equal(fixture.blackboardStore.listEvents("session-1", { kind: "decision", sourceEnvelopeId: decision.id }).length, 1);
    assert.equal(fixture.blackboardStore.listEvents("session-1", { kind: "subscription", sourceEnvelopeId: subscription.id }).length, 1);
  } finally {
    fixture.close();
  }
});

test("router decision policies gate high risk reviewer approval proposals", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const proposal = envelope("blackboard.write", {
      kind: "proposal",
      proposal_id: "proposal-high-risk-review",
      risk_level: "r3",
      approval_mode: "reviewer_approval",
      required_reviewers: ["reviewer-1"],
      file_scope: ["src/runtime/router.ts", "src/protocol/types.ts"],
      capability_trust: "low",
      value: { plan: "touch high risk decision surface" },
      tags: ["decision-policy"]
    }, { correlationId: "corr-policy-reviewer", from: { agent_id: "low-permission-coder" } });
    await fixture.router.dispatch(proposal);

    const proposalEntry = (latestIncoming(incoming, "blackboard.write.ack")?.payload as {
      entry?: { metadata?: { decision_policy?: { mode?: string; risk_level?: string; required_reviewers?: string[] }; decision_policy_status?: string; decision_waiting_for?: string[] } };
    }).entry;
    assert.deepEqual(proposalEntry?.metadata?.decision_policy, {
      mode: "reviewer_approval",
      risk_level: "r3",
      required_reviewers: ["reviewer-1"]
    });
    assert.equal(proposalEntry?.metadata?.decision_policy_status, "waiting");
    assert.deepEqual(proposalEntry?.metadata?.decision_waiting_for, ["reviewer-1"]);

    const prematureDecision = envelope("blackboard.write", {
      kind: "decision",
      proposal_id: "proposal-high-risk-review",
      status: "accepted",
      value: { accepted: true }
    }, { correlationId: "corr-policy-reviewer", from: { agent_id: "low-permission-coder" } });
    await fixture.router.dispatch(prematureDecision);

    const rejectedEntry = (latestIncoming(incoming, "blackboard.write.ack")?.payload as {
      entry?: { metadata?: { decision_status?: string; decision_policy_status?: string; decision_waiting_for?: string[]; conflict_reason?: string } };
    }).entry;
    assert.equal(rejectedEntry?.metadata?.decision_status, "rejected");
    assert.equal(rejectedEntry?.metadata?.decision_policy_status, "waiting");
    assert.deepEqual(rejectedEntry?.metadata?.decision_waiting_for, ["reviewer-1"]);
    assert.match(rejectedEntry?.metadata?.conflict_reason ?? "", /Reviewer approval required/);

    const review = envelope("blackboard.write", {
      kind: "review",
      proposal_id: "proposal-high-risk-review",
      verdict: "approve",
      value: { verdict: "approve", confidence: 0.91, reason: "policy reviewed" }
    }, { correlationId: "corr-policy-reviewer", from: { agent_id: "reviewer-1" } });
    await fixture.router.dispatch(review);

    const acceptedDecision = envelope("blackboard.write", {
      kind: "decision",
      proposal_id: "proposal-high-risk-review",
      status: "accepted",
      value: { accepted: true }
    }, { correlationId: "corr-policy-reviewer", from: { agent_id: "lead-1" } });
    await fixture.router.dispatch(acceptedDecision);

    const acceptedEntry = (latestIncoming(incoming, "blackboard.write.ack")?.payload as {
      entry?: { metadata?: { decision_status?: string; decision_policy_status?: string; decision_waiting_for?: string[]; decision_votes?: Array<{ voter?: string; vote: string }> } };
    }).entry;
    assert.equal(acceptedEntry?.metadata?.decision_status, "accepted");
    assert.equal(acceptedEntry?.metadata?.decision_policy_status, "satisfied");
    assert.deepEqual(acceptedEntry?.metadata?.decision_waiting_for, []);
    assert.deepEqual(acceptedEntry?.metadata?.decision_votes?.map((vote) => ({ voter: vote.voter, vote: vote.vote })), [
      { voter: "reviewer-1", vote: "approve" }
    ]);
  } finally {
    fixture.close();
  }
});

test("router quorum votes produce final blackboard decision", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const proposal = envelope("blackboard.write", {
      kind: "proposal",
      proposal_id: "proposal-quorum-policy",
      approval_mode: "quorum",
      quorum: 2,
      value: { plan: "accept after quorum" }
    }, { correlationId: "corr-quorum-policy", from: { agent_id: "planner-quorum" } });
    await fixture.router.dispatch(proposal);

    const voteOne = envelope("consensus.vote", {
      proposal_id: "proposal-quorum-policy",
      vote: "approve",
      confidence: 0.8,
      mode: "quorum",
      quorum: 2
    }, { correlationId: "corr-quorum-policy", from: { agent_id: "reviewer-1" }, to: { agent_id: "main" } });
    await fixture.router.dispatch(voteOne);
    const firstVoteAck = latestIncoming(incoming, "consensus.vote.ack");
    assert.equal((firstVoteAck?.payload as { result?: { decision?: string; approvals: number; quorum?: number } }).result?.decision, undefined);
    assert.equal(fixture.blackboardStore.query("session-1", { proposalId: "proposal-quorum-policy", kind: "decision" }).length, 0);

    const voteTwo = envelope("consensus.vote", {
      proposal_id: "proposal-quorum-policy",
      vote: "approve",
      confidence: 0.86,
      mode: "quorum",
      quorum: 2
    }, { correlationId: "corr-quorum-policy", from: { agent_id: "reviewer-2" }, to: { agent_id: "main" } });
    await fixture.router.dispatch(voteTwo);

    const secondVoteAck = latestIncoming(incoming, "consensus.vote.ack");
    assert.equal((secondVoteAck?.payload as { result?: { decision?: string; approvals: number; quorum?: number } }).result?.decision, "approve");
    const decision = fixture.blackboardStore.query("session-1", { proposalId: "proposal-quorum-policy", decisionStatus: "accepted" }).at(-1);
    assert(decision);
    assert.equal(decision.metadata?.decision_policy?.mode, "quorum");
    assert.equal(decision.metadata?.decision_policy?.quorum, 2);
    assert.equal(decision.metadata?.decision_policy_status, "satisfied");
    assert.deepEqual(decision.metadata?.decision_waiting_for, []);
    assert.deepEqual(decision.metadata?.decision_votes?.map((vote) => ({ voter: vote.voter, vote: vote.vote })), [
      { voter: "reviewer-1", vote: "approve" },
      { voter: "reviewer-2", vote: "approve" }
    ]);
    assert.equal(decision.metadata?.decision_outcome?.status, "accepted");
    assert.equal(incoming.some((item) => item.type === "consensus.result" && item.reply_to === voteTwo.id), true);
  } finally {
    fixture.close();
  }
});

test("router timeout fallback persists explainable decision outcome", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const proposal = envelope("blackboard.write", {
      kind: "proposal",
      proposal_id: "proposal-timeout-policy",
      approval_mode: "timeout_fallback",
      timeout_ms: 25,
      fallback_status: "rejected",
      risk_level: "r2",
      value: { plan: "fall back if nobody approves" }
    }, { correlationId: "corr-timeout-policy", from: { agent_id: "planner-timeout" } });
    await fixture.router.dispatch(proposal);

    const waitingProposal = (latestIncoming(incoming, "blackboard.write.ack")?.payload as {
      entry?: { metadata?: { decision_policy?: { mode?: string; timeout_ms?: number; fallback_status?: string }; decision_policy_status?: string; decision_waiting_for?: string[] } };
    }).entry;
    assert.deepEqual(waitingProposal?.metadata?.decision_policy, {
      mode: "timeout_fallback",
      risk_level: "r2",
      timeout_ms: 25,
      fallback_status: "rejected"
    });
    assert.equal(waitingProposal?.metadata?.decision_policy_status, "waiting");
    assert.deepEqual(waitingProposal?.metadata?.decision_waiting_for, ["timeout:25"]);

    const fallbackDecision = envelope("blackboard.write", {
      kind: "decision",
      proposal_id: "proposal-timeout-policy",
      status: "rejected",
      timeout_elapsed: true,
      value: { reason: "review window elapsed" }
    }, { correlationId: "corr-timeout-policy", from: { agent_id: "router" } });
    await fixture.router.dispatch(fallbackDecision);

    const decision = (latestIncoming(incoming, "blackboard.write.ack")?.payload as {
      entry?: { metadata?: { decision_status?: string; decision_policy_status?: string; decision_waiting_for?: string[]; decision_outcome?: { status?: string; reason?: string; policy_status?: string } } };
    }).entry;
    assert.equal(decision?.metadata?.decision_status, "rejected");
    assert.equal(decision?.metadata?.decision_policy_status, "timeout_fallback");
    assert.deepEqual(decision?.metadata?.decision_waiting_for, []);
    assert.equal(decision?.metadata?.decision_outcome?.status, "rejected");
    assert.equal(decision?.metadata?.decision_outcome?.policy_status, "timeout_fallback");
    assert.match(decision?.metadata?.decision_outcome?.reason ?? "", /Timeout fallback resolved/);
  } finally {
    fixture.close();
  }
});

test("router suppresses replayed semantic envelopes before mutating stores", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const write = envelope("blackboard.write", {
      key: "decision/replay",
      type: "decision",
      value: { selected: "coder-1" }
    });
    write.idempotency_key = "blackboard-write-once";

    await fixture.router.dispatch(write);
    await fixture.router.dispatch({
      ...write,
      id: `${write.id}-duplicate`,
      payload: {
        key: "decision/replay",
        type: "decision",
        value: { selected: "coder-2" }
      }
    });

    assert.equal(fixture.blackboardStore.list("session-1").length, 1);
    assert.deepEqual(fixture.blackboardStore.list("session-1")[0]?.value, { selected: "coder-1" });
    assert.equal(incoming.filter((item) => item.intent === "blackboard.write.ack").length, 1);

    const taskPayload = {
      task_id: "task-replay-1",
      title: "Replay task",
      description: "Persisted once",
      objective: "Exercise task replay",
      type: "coding",
      status: "pending",
      required_capabilities: ["code.implement"],
      inputs: {},
      expected_output: { format: "markdown" }
    };
    const createTask = envelope("task.create", taskPayload);
    createTask.idempotency_key = "task-create-once";
    await fixture.router.dispatch(createTask);
    await fixture.router.dispatch({
      ...createTask,
      id: `${createTask.id}-duplicate`,
      payload: { ...taskPayload, status: "completed" }
    });

    assert.equal(fixture.taskStateStore.list("session-1").filter((task) => task.task_id === "task-replay-1").length, 1);
    assert.equal(fixture.taskStateStore.list("session-1").find((task) => task.task_id === "task-replay-1")?.status, "pending");

    const createArtifact = envelope("artifact.create", {
      artifact_id: "artifact-replay-1",
      path: "artifacts/replay.md",
      type: "markdown",
      summary: "First"
    });
    createArtifact.idempotency_key = "artifact-create-once";
    await fixture.router.dispatch(createArtifact);
    await fixture.router.dispatch({
      ...createArtifact,
      id: `${createArtifact.id}-duplicate`,
      payload: {
        artifact_id: "artifact-replay-1",
        path: "artifacts/replay-duplicate.md",
        type: "markdown",
        summary: "Duplicate"
      }
    });

    assert.equal(fixture.artifactStore.get("artifact-replay-1")?.path, "artifacts/replay.md");
    assert.equal(fixture.artifactStore.get("artifact-replay-1")?.summary, "First");
    assert.equal(fixture.events.filter((event) => event.type === "log" && /Skipping duplicate envelope/.test(event.message)).length, 3);
  } finally {
    fixture.close();
  }
});

test("router suppresses replayed consensus votes before aggregation", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const vote = envelope("consensus.vote", {
      vote: "approve",
      confidence: 0.93,
      reason: "ready",
      mode: "majority_vote"
    }, { correlationId: "corr-consensus-replay", from: { agent_id: "reviewer-1" }, to: { agent_id: "main" } });
    vote.idempotency_key = "consensus-vote-once";

    await fixture.router.dispatch(vote);
    await fixture.router.dispatch({
      ...vote,
      id: `${vote.id}-duplicate`,
      payload: {
        vote: "reject",
        confidence: 0.1,
        reason: "duplicate",
        mode: "majority_vote"
      }
    });

    const voteAcks = incoming.filter((item) => item.intent === "consensus.vote.ack");
    assert.equal(voteAcks.length, 1);
    assert.equal(voteAcks[0]?.reply_to, vote.id);
    assert.equal(voteAcks[0]?.correlation_id, "corr-consensus-replay");
    assert.deepEqual((voteAcks[0]?.payload as { result?: { mode: string; decision?: string; approvals: number; rejections: number; abstentions: number } }).result, {
      mode: "majority_vote",
      decision: "approve",
      approvals: 1,
      rejections: 0,
      abstentions: 0
    });
    assert.equal(incoming.filter((item) => item.type === "consensus.result" && item.reply_to === vote.id).length, 1);
    assert.equal(fixture.traceStore.list("session-1").some((item) => item.id === `${vote.id}-duplicate`), false);
  } finally {
    fixture.close();
  }
});

test("router task and artifact handlers persist local state and report invalid payloads", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const taskPayload = {
      task_id: "task-router-1",
      title: "Router task",
      description: "Persisted through router",
      objective: "Exercise task create",
      type: "coding",
      status: "pending",
      required_capabilities: ["code.implement"],
      inputs: { path: "src/runtime/router.ts" },
      expected_output: { format: "markdown" },
      dependencies: ["task-router-0"]
    };
    const createTask = envelope("task.create", taskPayload);
    await fixture.router.dispatch(createTask);
    assert.equal(latestIncoming(incoming, "task.create.ack")?.reply_to, createTask.id);
    assert.equal(fixture.taskStateStore.list("session-1").find((task) => task.task_id === "task-router-1")?.status, "pending");

    const cancelTask = envelope("task.cancel", {
      ...taskPayload,
      task_id: "task-router-1",
      status: "cancelled"
    });
    await fixture.router.dispatch(cancelTask);
    const cancelAck = latestIncoming(incoming, "task.cancel.ack");
    assert.equal(cancelAck?.reply_to, cancelTask.id);
    assert.equal(fixture.taskStateStore.list("session-1").find((task) => task.task_id === "task-router-1")?.status, "cancelled");

    const createArtifact = envelope("artifact.create", {
      artifact_id: "artifact-router-1",
      path: "artifacts/router.md",
      type: "markdown",
      summary: "Initial summary"
    });
    await fixture.router.dispatch(createArtifact);
    assert.equal(latestIncoming(incoming, "artifact.create.ack")?.reply_to, createArtifact.id);
    assert.equal(fixture.artifactStore.get("artifact-router-1")?.summary, "Initial summary");

    const updateArtifact = envelope("artifact.update", {
      artifact_id: "artifact-router-1",
      path: "artifacts/router-updated.md",
      type: "markdown",
      summary: "Updated summary"
    });
    await fixture.router.dispatch(updateArtifact);
    assert.equal(latestIncoming(incoming, "artifact.update.ack")?.reply_to, updateArtifact.id);
    assert.equal(fixture.artifactStore.get("artifact-router-1")?.path, "artifacts/router-updated.md");

    const invalidArtifact = envelope("artifact.update", { path: "missing-id.md" }, { correlationId: "corr-artifact-error" });
    await fixture.router.dispatch(invalidArtifact);
    const error = latestIncoming(incoming, "router.error");
    assert.equal(error?.reply_to, invalidArtifact.id);
    assert.equal(error?.correlation_id, "corr-artifact-error");
    assert.match(String((error?.payload as { message?: string }).message), /artifact\.update requires artifact_id/);
  } finally {
    fixture.close();
  }
});

test("router bid and consensus handlers preserve aggregate state and emit consensus results", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const firstBid = envelope("bid.submit", {
      task_id: "task-router-1",
      confidence: 0.82,
      estimated_time_ms: 1200,
      estimated_cost: 0.02,
      reason: "available"
    }, { correlationId: "corr-bid", from: { agent_id: "coder-1" } });
    await fixture.router.dispatch(firstBid);
    const firstBidAck = latestIncoming(incoming, "bid.submit.ack");
    assert.equal(firstBidAck?.reply_to, firstBid.id);
    assert.equal(firstBidAck?.correlation_id, "corr-bid");
    assert.equal((firstBidAck?.payload as { bids?: unknown[] }).bids?.length, 1);

    const secondBid = envelope("bid.submit", {
      task_id: "task-router-1",
      confidence: 0.91,
      reason: "faster"
    }, { correlationId: "corr-bid", from: { agent_id: "coder-2" } });
    await fixture.router.dispatch(secondBid);
    assert.equal((latestIncoming(incoming, "bid.submit.ack")?.payload as { bids?: unknown[] }).bids?.length, 2);

    const voteOne = envelope("consensus.vote", {
      vote: "approve",
      confidence: 0.8,
      reason: "passes",
      mode: "majority_vote"
    }, { correlationId: "corr-consensus", from: { agent_id: "reviewer-1" }, to: { agent_id: "main" } });
    await fixture.router.dispatch(voteOne);
    const firstVoteAck = latestIncoming(incoming, "consensus.vote.ack");
    assert.equal(firstVoteAck?.reply_to, voteOne.id);
    assert.equal(firstVoteAck?.correlation_id, "corr-consensus");
    assert.deepEqual((firstVoteAck?.payload as { result?: unknown }).result, {
      mode: "majority_vote",
      decision: "approve",
      approvals: 1,
      rejections: 0,
      abstentions: 0
    });
    assert.equal(incoming.some((item) => item.type === "consensus.result" && item.reply_to === voteOne.id), true);

    const voteTwo = envelope("consensus.vote", {
      vote: "reject",
      confidence: 0.7,
      reason: "needs work",
      mode: "majority_vote"
    }, { correlationId: "corr-consensus", from: { agent_id: "reviewer-2" }, to: { agent_id: "main" } });
    await fixture.router.dispatch(voteTwo);
    const secondVoteAck = latestIncoming(incoming, "consensus.vote.ack");
    assert.deepEqual((secondVoteAck?.payload as { result?: {
      mode: string;
      decision?: string;
      approvals: number;
      rejections: number;
      abstentions: number;
    } }).result, {
      mode: "majority_vote",
      decision: undefined,
      approvals: 1,
      rejections: 1,
      abstentions: 0
    });
  } finally {
    fixture.close();
  }
});

test("router task market awards bids and waits for task.accept before execution ownership", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const mismatch = fixture.register(agentCard("coder-market-mismatch", "writer", ["docs.write"], "idle", 0, 0.99));
    const cold = fixture.register(agentCard("coder-market-cold", "coder", ["code.implement"], "idle", 0, 0.98));
    const busy = fixture.register(agentCard("coder-market-busy", "coder", ["code.implement"], "busy", 4, 0.99));
    const warm = fixture.register(agentCard("coder-market-warm", "coder", ["code.implement"], "idle", 0, 0.95));
    grantCapabilityLease(fixture, "coder-market-busy", "code.implement", "env-lease-market-busy");
    grantCapabilityLease(fixture, "coder-market-warm", "code.implement", "env-lease-market-warm");

    const createTask = envelope("task.create", {
      task_id: "task-market-1",
      title: "Implement market task",
      description: "Use bid/award/accept before execution.",
      objective: "Implement market task",
      type: "coding",
      status: "pending",
      required_capabilities: ["code.implement"],
      expected_output: { format: "patch" }
    }, { correlationId: "corr-market" });
    await fixture.router.dispatch(createTask);

    await fixture.router.dispatch(envelope("bid.submit", {
      task_id: "task-market-1",
      confidence: 1,
      estimated_time_ms: 500,
      estimated_cost: 0.01,
      cache_score: 1,
      lease_source_envelope_id: "env-lease-market-mismatch",
      reason: "excellent bid but missing required capability"
    }, { correlationId: "corr-market", from: { agent_id: "coder-market-mismatch", role: "writer", capability: "docs.write" } }));
    await fixture.router.dispatch(envelope("bid.submit", {
      task_id: "task-market-1",
      confidence: 0.99,
      estimated_time_ms: 1200,
      estimated_cost: 0.01,
      cache_score: 0.1,
      reason: "high confidence but cold and no lease"
    }, { correlationId: "corr-market", from: { agent_id: "coder-market-cold", role: "coder", capability: "code.implement" } }));
    await fixture.router.dispatch(envelope("bid.submit", {
      task_id: "task-market-1",
      confidence: 0.98,
      estimated_time_ms: 900,
      estimated_cost: 0.02,
      cache_score: 0.8,
      lease_source_envelope_id: "env-lease-market-busy",
      reason: "warm context but already loaded"
    }, { correlationId: "corr-market", from: { agent_id: "coder-market-busy", role: "coder", capability: "code.implement" } }));
    await fixture.router.dispatch(envelope("bid.submit", {
      task_id: "task-market-1",
      confidence: 0.74,
      estimated_time_ms: 2500,
      estimated_cost: 0.03,
      cache_score: 0.8,
      lease_source_envelope_id: "env-lease-market-warm",
      reason: "warm context, active lease, and no current load"
    }, { correlationId: "corr-market", from: { agent_id: "coder-market-warm", role: "coder", capability: "code.implement" } }));

    const award = envelope("bid.award", {
      task_id: "task-market-1",
      title: "Implement market task",
      objective: "Implement market task",
      type: "coding",
      required_capabilities: ["code.implement"]
    }, { correlationId: "corr-market" });
    await fixture.router.dispatch(award);

    assert.equal(mismatch.sent.length, 0);
    assert.equal(cold.sent.length, 0);
    assert.equal(busy.sent.length, 0);
    assert.equal(warm.sent.length, 1);
    const assignment = warm.sent[0];
    assert.equal(assignment?.type, "task.assign");
    assert.equal(assignment?.intent, "task.market.assign");
    assert.equal(assignment?.reply_to, award.id);
    assert.equal((assignment?.payload as { requires_accept?: boolean }).requires_accept, true);
    assert.equal((assignment?.payload as { winning_bid?: { from?: { agent_id?: string }; cache_score?: number; lease_source_envelope_id?: string } }).winning_bid?.from?.agent_id, "coder-market-warm");
    assert.equal((assignment?.payload as { winning_bid?: { cache_score?: number } }).winning_bid?.cache_score, 0.8);
    assert.equal((assignment?.payload as { winning_bid?: { lease_source_envelope_id?: string } }).winning_bid?.lease_source_envelope_id, "env-lease-market-warm");

    const awardAck = latestIncoming(incoming, "bid.award.ack");
    assert.equal(awardAck?.reply_to, award.id);
    assert.equal((awardAck?.payload as { winner?: { agent_id?: string }; requires_accept?: boolean }).winner?.agent_id, "coder-market-warm");
    assert.equal((awardAck?.payload as { requires_accept?: boolean }).requires_accept, true);
    const candidateEvaluations = (awardAck?.payload as {
      capability_directory_candidates?: Array<{ agent_id?: string; available?: boolean; reasons?: string[] }>;
    }).capability_directory_candidates ?? [];
    assert.equal(candidateEvaluations.find((item) => item.agent_id === "coder-market-warm")?.available, true);
    assert.equal(candidateEvaluations.find((item) => item.agent_id === "coder-market-busy")?.available, false);
    assert.match(candidateEvaluations.find((item) => item.agent_id === "coder-market-busy")?.reasons?.join(" ") ?? "", /no free task capacity/);
    assert.match(candidateEvaluations.find((item) => item.agent_id === "coder-market-mismatch")?.reasons?.join(" ") ?? "", /Missing required capabilities/);

    const assigned = fixture.taskStateStore.list("session-1").find((task) => task.task_id === "task-market-1");
    assert.equal(assigned?.status, "assigned");
    assert.equal(assigned?.assigned_to?.agent_id, "coder-market-warm");
    assert.equal(fixture.actorStore.get("coder-market-warm")?.status, "idle");
    assert.equal(fixture.actorStore.get("coder-market-warm")?.current_task_id, undefined);

    const accept = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-market-1",
      from: { agent_id: "coder-market-warm", role: "coder", capability: "code.implement" },
      to: { agent_id: "main" },
      type: "task.accept",
      intent: "task.market.accept",
      payload: {
        task_id: "task-market-1",
        title: "Implement market task",
        objective: "Implement market task",
        type: "coding"
      },
      correlation_id: assignment?.correlation_id,
      reply_to: assignment?.id
    });
    fixture.router.receive(accept);

    const running = fixture.taskStateStore.list("session-1").find((task) => task.task_id === "task-market-1");
    assert.equal(running?.status, "running");
    assert.equal(running?.assigned_to?.agent_id, "coder-market-warm");
    assert.equal(fixture.actorStore.get("coder-market-warm")?.status, "busy");
    assert.equal(fixture.actorStore.get("coder-market-warm")?.current_task_id, "task-market-1");
    assert.equal(fixture.deliveryStore.list({ envelopeId: assignment?.id }).at(0)?.status, "acked");
  } finally {
    fixture.close();
  }
});

test("router task market filters expired capability leases before awarding", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const expired = fixture.register(agentCard("coder-market-expired", "coder", ["code.implement"], "idle", 0, 0.99));
    const active = fixture.register(agentCard("coder-market-active", "coder", ["code.implement"], "idle", 0, 0.9));
    grantCapabilityLease(fixture, "coder-market-expired", "code.implement", "env-lease-market-expired", "2000-01-01T00:00:00.000Z");
    grantCapabilityLease(fixture, "coder-market-active", "code.implement", "env-lease-market-active");

    await fixture.router.dispatch(envelope("task.create", {
      task_id: "task-market-lease-filter",
      title: "Filter expired lease",
      description: "Expired lease must not win.",
      objective: "Filter expired lease",
      type: "coding",
      status: "pending",
      required_capabilities: ["code.implement"],
      expected_output: { format: "patch" }
    }, { correlationId: "corr-market-lease-filter" }));

    await fixture.router.dispatch(envelope("bid.submit", {
      task_id: "task-market-lease-filter",
      confidence: 1,
      cache_score: 1,
      lease_source_envelope_id: "env-lease-market-expired",
      reason: "best score but expired lease"
    }, { correlationId: "corr-market-lease-filter", from: { agent_id: "coder-market-expired", role: "coder", capability: "code.implement" } }));
    await fixture.router.dispatch(envelope("bid.submit", {
      task_id: "task-market-lease-filter",
      confidence: 0.6,
      cache_score: 0.2,
      lease_source_envelope_id: "env-lease-market-active",
      reason: "lower score but active lease"
    }, { correlationId: "corr-market-lease-filter", from: { agent_id: "coder-market-active", role: "coder", capability: "code.implement" } }));

    const award = envelope("bid.award", {
      task_id: "task-market-lease-filter",
      title: "Filter expired lease",
      objective: "Filter expired lease",
      type: "coding",
      required_capabilities: ["code.implement"]
    }, { correlationId: "corr-market-lease-filter" });
    await fixture.router.dispatch(award);

    assert.equal(expired.sent.length, 0);
    assert.equal(active.sent.length, 1);
    const awardAck = latestIncoming(incoming, "bid.award.ack");
    assert.equal((awardAck?.payload as { winner?: { agent_id?: string } }).winner?.agent_id, "coder-market-active");
    const candidateEvaluations = (awardAck?.payload as {
      capability_directory_candidates?: Array<{ agent_id?: string; available?: boolean; reasons?: string[] }>;
    }).capability_directory_candidates ?? [];
    assert.equal(candidateEvaluations.find((item) => item.agent_id === "coder-market-expired")?.available, false);
    assert.match(candidateEvaluations.find((item) => item.agent_id === "coder-market-expired")?.reasons?.join(" ") ?? "", /expired at 2000-01-01/);
    assert.equal(candidateEvaluations.find((item) => item.agent_id === "coder-market-active")?.available, true);
  } finally {
    fixture.close();
  }
});

test("router task.accept creates ownership leases, rejects conflicts, and recovers expired claims", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const first = fixture.register(agentCard("coder-owner-1", "coder", ["code.implement"]));
    const second = fixture.register(agentCard("coder-owner-2", "coder", ["code.implement"]));
    const recovered = fixture.register(agentCard("coder-owner-recovered", "coder", ["code.implement"]));

    const createOwnedTask = envelope("task.create", {
      task_id: "task-owned-1",
      title: "Edit shared module",
      description: "Exercise ownership conflict arbitration.",
      objective: "Edit shared module",
      type: "coding",
      status: "pending",
      required_capabilities: ["code.implement"],
      expected_output: { format: "patch" },
      write_policy: "scoped_write",
      file_scope: ["src/shared.ts"]
    }, { correlationId: "corr-owned" });
    await fixture.router.dispatch(createOwnedTask);

    const firstAssign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-owned-1",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "coder-owner-1" },
      type: "task.assign",
      intent: "task.market.assign",
      payload: { requires_accept: true, protocol: "task_market_bid_award" },
      correlation_id: "corr-owned",
      routing: { mode: "direct" }
    });
    await fixture.router.dispatch(firstAssign);
    assert.equal(first.sent.length, 1);

    const firstAccept = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-owned-1",
      from: { agent_id: "coder-owner-1", role: "coder", capability: "code.implement" },
      to: { agent_id: "main_swarm" },
      type: "task.accept",
      intent: "task.accept",
      payload: {
        task_id: "task-owned-1",
        title: "Edit shared module",
        objective: "Edit shared module",
        type: "coding",
        lease_expires_at: "2999-01-01T00:00:00.000Z"
      },
      correlation_id: "corr-owned",
      reply_to: firstAssign.id
    });
    fixture.router.receive(firstAccept);

    assert.equal(fixture.actorStore.get("coder-owner-1")?.status, "busy");
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "task/task-owned-1")?.metadata?.owner_agent_id, "coder-owner-1");
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "file/src/shared.ts")?.metadata?.owner_agent_id, "coder-owner-1");
    assert.equal(fixture.deliveryStore.list({ envelopeId: firstAssign.id }).at(0)?.status, "acked");
    const running = fixture.taskStateStore.list("session-1").find((task) => task.task_id === "task-owned-1");
    assert.equal(running?.status, "running");
    assert.equal(running?.assigned_to?.agent_id, "coder-owner-1");
    assert.equal(running?.write_policy, "scoped_write");
    assert.deepEqual(running?.file_scope, ["src/shared.ts"]);

    const secondAssign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-owned-1",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "coder-owner-2" },
      type: "task.assign",
      intent: "task.market.assign",
      payload: { requires_accept: true, protocol: "task_market_bid_award" },
      correlation_id: "corr-owned-conflict",
      routing: { mode: "direct" }
    });
    await fixture.router.dispatch(secondAssign);
    assert.equal(second.sent.length, 1);

    const secondAccept = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-owned-1",
      from: { agent_id: "coder-owner-2", role: "coder", capability: "code.implement" },
      to: { agent_id: "main_swarm" },
      type: "task.accept",
      intent: "task.accept",
      payload: {
        task_id: "task-owned-1",
        title: "Edit shared module",
        objective: "Edit shared module",
        type: "coding"
      },
      correlation_id: "corr-owned-conflict",
      reply_to: secondAssign.id
    });
    fixture.router.receive(secondAccept);

    assert.equal(fixture.actorStore.get("coder-owner-2")?.status, "idle");
    assert.equal(fixture.actorStore.get("coder-owner-2")?.current_task_id, undefined);
    assert.equal(fixture.deliveryStore.list({ envelopeId: secondAssign.id }).at(0)?.status, "failed");
    assert.match(fixture.deliveryStore.list({ envelopeId: secondAssign.id }).at(0)?.error ?? "", /already owned by coder-owner-1/);
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "task/task-owned-1")?.metadata?.owner_agent_id, "coder-owner-1");
    assert.equal(fixture.blackboardStore.query("session-1", { kind: "claim_conflict", sourceEnvelopeId: secondAccept.id }).length, 1);
    const conflictDecision = fixture.blackboardStore.query("session-1", { kind: "decision", sourceEnvelopeId: secondAccept.id }).at(-1);
    assert.equal(conflictDecision?.metadata?.decision_status, "rejected");
    assert.match(String(conflictDecision?.metadata?.conflict_reason), /already owned by coder-owner-1/);
    assert.equal(incoming.some((item) => item.intent === "router.error" && item.reply_to === secondAccept.id), true);

    fixture.blackboardStore.claim({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-expired-owner",
      claim_key: "task/task-expired-owner",
      owner: { agent_id: "stale-owner" },
      expires_at: "2000-01-01T00:00:00.000Z",
      metadata: { source_envelope_id: "env-stale-task" }
    });
    fixture.blackboardStore.claim({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-expired-owner",
      claim_key: "file/src/expired.ts",
      owner: { agent_id: "stale-owner" },
      expires_at: "2000-01-01T00:00:00.000Z",
      metadata: { source_envelope_id: "env-stale-file" }
    });
    await fixture.router.dispatch(envelope("task.create", {
      task_id: "task-expired-owner",
      title: "Recover expired ownership",
      description: "Recover expired ownership",
      objective: "Recover expired ownership",
      type: "coding",
      status: "pending",
      expected_output: { format: "patch" },
      write_policy: "scoped_write",
      file_scope: ["src/expired.ts"]
    }, { correlationId: "corr-expired-owner" }));
    const recoveryAssign = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-expired-owner",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "coder-owner-recovered" },
      type: "task.assign",
      intent: "task.market.assign",
      payload: { requires_accept: true, protocol: "task_market_bid_award" },
      correlation_id: "corr-expired-owner",
      routing: { mode: "direct" }
    });
    await fixture.router.dispatch(recoveryAssign);
    assert.equal(recovered.sent.length, 1);

    const recoveryAccept = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-expired-owner",
      from: { agent_id: "coder-owner-recovered", role: "coder", capability: "code.implement" },
      to: { agent_id: "main_swarm" },
      type: "task.accept",
      intent: "task.accept",
      payload: {
        task_id: "task-expired-owner",
        title: "Recover expired ownership",
        objective: "Recover expired ownership",
        type: "coding"
      },
      correlation_id: "corr-expired-owner",
      reply_to: recoveryAssign.id
    });
    fixture.router.receive(recoveryAccept);

    assert.equal(fixture.deliveryStore.list({ envelopeId: recoveryAssign.id }).at(0)?.status, "acked");
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "task/task-expired-owner")?.metadata?.owner_agent_id, "coder-owner-recovered");
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "file/src/expired.ts")?.metadata?.owner_agent_id, "coder-owner-recovered");
    assert.equal(fixture.blackboardStore.query("session-1", { kind: "claim_release", ownerAgentId: "stale-owner" }).some((entry) => entry.metadata?.claim_status === "expired"), true);
  } finally {
    fixture.close();
  }
});

test("router peer negotiation reaches accepted contract and validates decline alternatives", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const coder = fixture.register(agentCard("worker:negotiation-coder", "coder", ["code.implement"]));
    const reviewer = fixture.register(agentCard("worker:negotiation-reviewer", "reviewer", ["code.review"]));

    const propose = envelope("negotiation.propose", {
      negotiation_id: "nego-contract-1",
      terms: {
        scope: ["src/runtime/router.ts"],
        ownership: "coder edits, reviewer reviews"
      },
      reason: "Split implementation and review ownership."
    }, {
      correlationId: "corr-nego-contract-1",
      from: { agent_id: "worker:negotiation-coder", role: "coder", capability: "code.implement" },
      to: { agent_id: "worker:negotiation-reviewer", role: "reviewer", capability: "code.review" }
    });
    await fixture.router.dispatch(propose);

    const counter = envelope("negotiation.counter", {
      negotiation_id: "nego-contract-1",
      counter_terms: {
        file_scope: ["src/runtime/router.ts", "src/runtime/router.test.ts"],
        review_responsibility: "reviewer owns final protocol replay assertion"
      },
      reason: "Tests must cover the protocol chain."
    }, {
      correlationId: "corr-nego-contract-1",
      from: { agent_id: "worker:negotiation-reviewer", role: "reviewer", capability: "code.review" },
      to: { agent_id: "worker:negotiation-coder", role: "coder", capability: "code.implement" }
    });
    await fixture.router.dispatch(counter);

    const accept = envelope("negotiation.accept", {
      negotiation_id: "nego-contract-1",
      contract: {
        file_scope: ["src/runtime/router.ts", "src/runtime/router.test.ts"],
        accepted_by: "worker:negotiation-coder"
      }
    }, {
      correlationId: "corr-nego-contract-1",
      from: { agent_id: "worker:negotiation-coder", role: "coder", capability: "code.implement" },
      to: { agent_id: "worker:negotiation-reviewer", role: "reviewer", capability: "code.review" }
    });
    await fixture.router.dispatch(accept);

    assert.equal(reviewer.sent.map((item) => item.type).filter((type) => type.startsWith("negotiation.")).length, 2);
    assert.equal(coder.sent.map((item) => item.type).filter((type) => type.startsWith("negotiation.")).length, 1);
    const proposalEntries = fixture.blackboardStore.query("session-1", { proposalId: "nego-contract-1" });
    assert.equal(proposalEntries.length, 3);
    assert(proposalEntries.some((entry) => entry.metadata?.negotiation_action === "propose"));
    assert(proposalEntries.some((entry) => entry.metadata?.negotiation_action === "counter"));
    const accepted = proposalEntries.find((entry) => entry.metadata?.kind === "decision");
    assert.equal(accepted?.metadata?.decision_status, "accepted");
    assert.equal(accepted?.metadata?.negotiation_status, "accepted");
    assert.deepEqual((accepted?.value as { contract?: { accepted_by?: string } }).contract?.accepted_by, "worker:negotiation-coder");

    const invalidDecline = envelope("negotiation.decline", {
      negotiation_id: "nego-contract-2",
      reason: "Out of scope."
    }, {
      correlationId: "corr-nego-contract-2",
      from: { agent_id: "worker:negotiation-reviewer", role: "reviewer", capability: "code.review" },
      to: { agent_id: "worker:negotiation-coder", role: "coder", capability: "code.implement" }
    });
    await fixture.router.dispatch(invalidDecline);
    const invalidError = incoming.find((item) => item.reply_to === invalidDecline.id && item.type === "error");
    assert.match((invalidError?.payload as { message?: string }).message ?? "", /suggested_alternative/);
    assert.equal(fixture.deliveryStore.list({ envelopeId: invalidDecline.id }).at(0)?.status, "failed");
  } finally {
    fixture.close();
  }
});

test("router peer negotiation delegation cycle fails closed", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const delegate = envelope("negotiation.delegate", {
      negotiation_id: "nego-cycle-1",
      delegation_chain: ["worker:delegate-a", "worker:delegate-b"],
      max_delegation_depth: 4,
      reason: "Try to delegate back to an earlier participant."
    }, {
      correlationId: "corr-nego-cycle-1",
      from: { agent_id: "worker:delegate-b", role: "coder" },
      to: { agent_id: "worker:delegate-a", role: "coder" }
    });

    await fixture.router.dispatch(delegate);

    const error = incoming.find((item) => item.reply_to === delegate.id && item.type === "error");
    assert(error, "delegation cycle should emit router error");
    assert.match((error.payload as { message?: string }).message ?? "", /Delegation cycle blocked/);
    assert.equal(fixture.deliveryStore.list({ envelopeId: delegate.id }).at(0)?.status, "failed");
    const decision = fixture.blackboardStore.query("session-1", { proposalId: "nego-cycle-1", decisionStatus: "rejected" }).at(0);
    assert(decision, "delegation cycle should persist a rejected negotiation decision");
    assert.equal(decision.metadata?.negotiation_action, "delegate");
    assert.equal(decision.metadata?.negotiation_status, "rejected");
    assert.match(decision.metadata?.conflict_reason ?? "", /Delegation cycle blocked/);
  } finally {
    fixture.close();
  }
});

test("router squad lifecycle creates membership evidence and releases ownership on dissolve", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    fixture.register(agentCard("worker:squad-lead", "lead", ["team.lead"]));
    fixture.register(agentCard("worker:squad-coder", "coder", ["code.implement"]));
    fixture.register(agentCard("worker:squad-reviewer", "reviewer", ["code.review"]));
    fixture.register(agentCard("worker:squad-aggregator", "aggregator", ["result.aggregate"]));

    const create = envelope("squad.create", {
      squad_id: "squad-router-1",
      objective: "Implement high risk protocol change.",
      risk_level: "r3",
      cache_profile: { preferred_cache: "warm" },
      ownership_lease: { claim_key: "task/task-router-1", ttl_ms: 300_000 },
      leader: { agent_id: "worker:squad-lead", role: "leader" },
      members: [
        { agent_id: "worker:squad-coder", role: "specialist", capabilities: ["code.implement"] },
        { agent_id: "worker:squad-reviewer", role: "reviewer", capabilities: ["code.review"] }
      ],
      roles: [
        { agent_id: "worker:squad-aggregator", role: "aggregator", required_capabilities: ["result.aggregate"] }
      ],
      review_gate: { required: true, reviewer: "worker:squad-reviewer" },
      final_result_aggregator: { agent_id: "worker:squad-aggregator" }
    }, {
      correlationId: "corr-squad-router-1",
      from: { agent_id: "main_swarm", role: "coordinator" }
    });
    await fixture.router.dispatch(create);

    const join = envelope("squad.join", {
      squad_id: "squad-router-1",
      member: { agent_id: "worker:squad-reviewer", role: "reviewer", capabilities: ["code.review"] },
      reason: "Reviewer joins internal review gate."
    }, {
      correlationId: "corr-squad-router-1",
      from: { agent_id: "worker:squad-reviewer", role: "reviewer", capability: "code.review" }
    });
    await fixture.router.dispatch(join);

    const assign = envelope("squad.role.assign", {
      squad_id: "squad-router-1",
      member: { agent_id: "worker:squad-aggregator", role: "aggregator" },
      role: "aggregator",
      required_capabilities: ["result.aggregate"],
      final_result_aggregator: true
    }, {
      correlationId: "corr-squad-router-1",
      from: { agent_id: "worker:squad-lead", role: "leader" }
    });
    await fixture.router.dispatch(assign);

    const leave = envelope("squad.leave", {
      squad_id: "squad-router-1",
      member: { agent_id: "worker:squad-reviewer", role: "reviewer" },
      reason: "Review gate completed."
    }, {
      correlationId: "corr-squad-router-1",
      from: { agent_id: "worker:squad-reviewer", role: "reviewer" }
    });
    await fixture.router.dispatch(leave);

    const dissolve = envelope("squad.dissolve", {
      squad_id: "squad-router-1",
      reason: "Final result aggregated."
    }, {
      correlationId: "corr-squad-router-1",
      from: { agent_id: "worker:squad-lead", role: "leader" }
    });
    await fixture.router.dispatch(dissolve);

    assert.equal(latestIncoming(incoming, "squad.create.ack")?.reply_to, create.id);
    assert.equal(latestIncoming(incoming, "squad.join.ack")?.reply_to, join.id);
    assert.equal(latestIncoming(incoming, "squad.role.assign.ack")?.reply_to, assign.id);
    assert.equal(latestIncoming(incoming, "squad.leave.ack")?.reply_to, leave.id);
    assert.equal(latestIncoming(incoming, "squad.dissolve.ack")?.reply_to, dissolve.id);
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "squad/squad-router-1"), undefined);

    const entries = fixture.blackboardStore.query("session-1", { keyPrefix: "squad/squad-router-1" });
    assert.equal(entries.filter((entry) => entry.metadata?.kind === "decision").length, 5);
    assert(entries.some((entry) => entry.metadata?.squad_action === "create" && entry.metadata.squad_status === "active"));
    assert(entries.some((entry) => entry.metadata?.squad_action === "role.assign" && entry.metadata.squad_role === "aggregator"));
    assert(entries.some((entry) => entry.metadata?.squad_action === "dissolve" && entry.metadata.squad_status === "dissolved"));
    const createDecision = entries.find((entry) => entry.metadata?.squad_action === "create");
    const createValue = createDecision?.value as { candidates?: Array<{ agent_id?: string; available?: boolean; matched_capabilities?: string[]; cache_profile?: string; risk_level?: string }> };
    assert.equal(createValue.candidates?.find((candidate) => candidate.agent_id === "worker:squad-coder")?.available, true);
    assert.deepEqual(createValue.candidates?.find((candidate) => candidate.agent_id === "worker:squad-coder")?.matched_capabilities, ["code.implement"]);
    assert.equal(createValue.candidates?.find((candidate) => candidate.agent_id === "worker:squad-reviewer")?.available, true);
    assert.equal(createValue.candidates?.find((candidate) => candidate.agent_id === "worker:squad-aggregator")?.cache_profile, "mixed");
    assert.equal(createValue.candidates?.find((candidate) => candidate.agent_id === "worker:squad-aggregator")?.risk_level, "r1");
    assert.equal(fixture.blackboardStore.query("session-1", { claimKey: "squad/squad-router-1" }).some((entry) => entry.metadata?.claim_status === "released"), true);
    assert.deepEqual(
      fixture.traceStore.list("session-1").filter((item) => item.type.startsWith("squad.")).map((item) => item.type),
      ["squad.create", "squad.join", "squad.role.assign", "squad.leave", "squad.dissolve"]
    );
  } finally {
    fixture.close();
  }
});

test("router squad role assignment respects capability policy", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    fixture.register(agentCard("worker:squad-lead-policy", "lead", ["team.lead"]));
    fixture.register(agentCard("worker:squad-docs-only", "writer", ["docs.write"]));

    const assign = envelope("squad.role.assign", {
      squad_id: "squad-policy-1",
      member: { agent_id: "worker:squad-docs-only", role: "reviewer" },
      role: "reviewer",
      required_capabilities: ["code.review"]
    }, {
      correlationId: "corr-squad-policy-1",
      from: { agent_id: "worker:squad-lead-policy", role: "leader" }
    });
    await fixture.router.dispatch(assign);

    const error = incoming.find((item) => item.reply_to === assign.id && item.type === "error");
    assert(error, "capability mismatch should emit router error");
    assert.equal((error.payload as { error_code?: string }).error_code, "SQUAD_POLICY_REJECTED");
    assert.match((error.payload as { message?: string }).message ?? "", /Missing required capabilities/);
    assert.equal(fixture.deliveryStore.list({ envelopeId: assign.id }).at(0)?.status, "failed");
    const rejected = fixture.blackboardStore.query("session-1", { keyPrefix: "squad/squad-policy-1" }).at(-1);
    assert.equal(rejected?.metadata?.squad_action, "role.assign");
    assert.equal(rejected?.metadata?.squad_status, "rejected");
    assert.equal(rejected?.metadata?.decision_status, "rejected");
  } finally {
    fixture.close();
  }
});

test("router handoff protocol envelopes create ownership-transfer contract", async () => {
  const fixture = createFixture();
  try {
    const incoming = collectIncoming(fixture.router);
    const firstWorker = fixture.register(agentCard("handoff-worker-1", "handoff_specialist", ["handoff.deep_work"]));
    const secondWorker = fixture.register(agentCard("handoff-worker-2", "handoff_specialist", ["handoff.deep_work"]));

    const request = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-1",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "handoff-worker-1" },
      type: "handoff.request",
      intent: "handoff.request",
      payload: {
        handoff_id: "handoff-1",
        objective: "Finish delegated implementation",
        reason: "Needs focused context",
        target_agent_spec_id: "handoff_specialist",
        file_scope: ["src/handoff-target.ts"],
        write_policy: "scoped_write",
        lease_expires_at: "2999-01-01T00:00:00.000Z"
      },
      correlation_id: "corr-handoff-1",
      routing: { mode: "direct" }
    });
    await fixture.router.dispatch(request);

    assert.equal(firstWorker.sent.length, 1);
    assert.equal(firstWorker.sent[0]?.id, request.id);
    assert.equal(fixture.deliveryStore.list({ envelopeId: request.id }).at(0)?.status, "delivered");
    const requested = fixture.handoffStore.get("handoff-1");
    assert.equal(requested?.protocol_status, "requested");
    assert.equal(requested?.owner_agent_id, undefined);
    assert.equal(requested?.request_envelope_id, request.id);
    assert.deepEqual(requested?.scope, ["src/handoff-target.ts"]);

    const accept = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-1",
      from: { agent_id: "handoff-worker-1", role: "handoff_specialist", capability: "handoff.deep_work" },
      to: { agent_id: "main_swarm" },
      type: "handoff.accept",
      intent: "handoff.accept",
      payload: {
        handoff_id: "handoff-1",
        lease_expires_at: "2999-01-01T00:00:00.000Z"
      },
      correlation_id: "corr-handoff-1",
      reply_to: request.id
    });
    fixture.router.receive(accept);

    const accepted = fixture.handoffStore.get("handoff-1");
    assert.equal(accepted?.protocol_status, "accepted");
    assert.equal(accepted?.owner_agent_id, "handoff-worker-1");
    assert.equal(accepted?.accept_envelope_id, accept.id);
    assert.equal(fixture.deliveryStore.list({ envelopeId: request.id }).at(0)?.status, "acked");
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "handoff/handoff-1")?.metadata?.owner_agent_id, "handoff-worker-1");
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "file/src/handoff-target.ts")?.metadata?.owner_agent_id, "handoff-worker-1");

    const competingRequest = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-1",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "handoff-worker-2" },
      type: "handoff.request",
      intent: "handoff.request",
      payload: {
        handoff_id: "handoff-1",
        objective: "Compete for delegated implementation",
        file_scope: ["src/handoff-target.ts"],
        write_policy: "scoped_write"
      },
      correlation_id: "corr-handoff-conflict",
      routing: { mode: "direct" }
    });
    await fixture.router.dispatch(competingRequest);
    assert.equal(secondWorker.sent.length, 1);

    const competingAccept = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-1",
      from: { agent_id: "handoff-worker-2", role: "handoff_specialist", capability: "handoff.deep_work" },
      to: { agent_id: "main_swarm" },
      type: "handoff.accept",
      intent: "handoff.accept",
      payload: { handoff_id: "handoff-1" },
      correlation_id: "corr-handoff-conflict",
      reply_to: competingRequest.id
    });
    fixture.router.receive(competingAccept);

    const conflicted = fixture.handoffStore.get("handoff-1");
    assert.equal(conflicted?.protocol_status, "conflict");
    assert.equal(conflicted?.owner_agent_id, "handoff-worker-1");
    assert.equal(fixture.deliveryStore.list({ envelopeId: competingRequest.id }).at(0)?.status, "failed");
    assert.match(fixture.deliveryStore.list({ envelopeId: competingRequest.id }).at(0)?.error ?? "", /already owned by handoff-worker-1/);
    assert.equal(fixture.blackboardStore.query("session-1", { kind: "claim_conflict", sourceEnvelopeId: competingAccept.id }).length, 1);
    assert.equal(fixture.blackboardStore.query("session-1", { kind: "decision", sourceEnvelopeId: competingAccept.id }).at(-1)?.metadata?.decision_status, "rejected");
    assert.equal(incoming.some((item) => item.intent === "router.error" && item.reply_to === competingAccept.id), true);

    const returnEnvelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-1",
      from: { agent_id: "handoff-worker-1", role: "handoff_specialist", capability: "handoff.deep_work" },
      to: { agent_id: "main_swarm" },
      type: "handoff.return",
      intent: "handoff.return",
      payload: {
        handoff_id: "handoff-1",
        result: "Completed delegated implementation.",
        return_contract: {
          completed_work: ["implementation"],
          remaining_risk: ["needs review"],
          artifacts: ["src/handoff-target.ts"],
          verification: ["unit tests pending"],
          next_action: "review"
        }
      },
      correlation_id: "corr-handoff-1",
      reply_to: request.id
    });
    fixture.router.receive(returnEnvelope);

    const returned = fixture.handoffStore.get("handoff-1");
    assert.equal(returned?.status, "returned");
    assert.equal(returned?.protocol_status, "returned");
    assert.equal(returned?.return_envelope_id, returnEnvelope.id);
    assert.deepEqual(returned?.return_contract, {
      completed_work: ["implementation"],
      remaining_risk: ["needs review"],
      artifacts: ["src/handoff-target.ts"],
      verification: ["unit tests pending"],
      next_action: "review"
    });
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "handoff/handoff-1"), undefined);
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "file/src/handoff-target.ts"), undefined);

    const takeBackRequest = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-2",
      from: { agent_id: "gateway.local" },
      to: { agent_id: "handoff-worker-1" },
      type: "handoff.request",
      intent: "handoff.request",
      payload: {
        handoff_id: "handoff-takeback",
        objective: "Take-back path",
        requester_agent_id: "gateway.local",
        file_scope: ["src/takeback.ts"],
        write_policy: "scoped_write",
        lease_expires_at: "2999-01-01T00:00:00.000Z"
      },
      correlation_id: "corr-handoff-takeback",
      routing: { mode: "direct" }
    });
    await fixture.router.dispatch(takeBackRequest);
    fixture.router.receive(createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-2",
      from: { agent_id: "handoff-worker-1", role: "handoff_specialist", capability: "handoff.deep_work" },
      to: { agent_id: "gateway.local" },
      type: "handoff.accept",
      intent: "handoff.accept",
      payload: {
        handoff_id: "handoff-takeback",
        lease_expires_at: "2999-01-01T00:00:00.000Z"
      },
      correlation_id: "corr-handoff-takeback",
      reply_to: takeBackRequest.id
    }));
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "handoff/handoff-takeback")?.metadata?.owner_agent_id, "handoff-worker-1");

    const takeBack = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "handoff-task-2",
      from: { agent_id: "gateway.local" },
      to: { agent_id: "handoff-worker-1" },
      type: "handoff.take_back",
      intent: "handoff.take_back",
      payload: {
        handoff_id: "handoff-takeback",
        previous_owner: "handoff-worker-1",
        requester_agent_id: "gateway.local",
        reason: "Operator took back ownership."
      },
      correlation_id: "corr-handoff-takeback"
    });
    fixture.router.receive(takeBack);

    const takenBack = fixture.handoffStore.get("handoff-takeback");
    assert.equal(takenBack?.status, "taken_back");
    assert.equal(takenBack?.protocol_status, "taken_back");
    assert.equal(takenBack?.owner_agent_id, "gateway.local");
    assert.equal(takenBack?.take_back_envelope_id, takeBack.id);
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "handoff/handoff-takeback"), undefined);
    assert.equal(fixture.blackboardStore.getActiveClaim("session-1", "file/src/takeback.ts"), undefined);
  } finally {
    fixture.close();
  }
});

type TestFixture = {
  root: string;
  database: SwarmDatabase;
  events: RuntimeEvent[];
  runtimeEvents: RuntimeEvents;
  registry: AgentRegistry;
  traceStore: TraceStore;
  blackboardStore: BlackboardStore;
  artifactStore: ArtifactStore;
  taskStateStore: TaskStateStore;
  deliveryStore: EnvelopeDeliveryStore;
  actorStore: AgentActorStore;
  handoffStore: HandoffStore;
  router: EnvelopeRouter;
  register(card: AgentCard): { sent: SwarmEnvelope[] };
  close(): void;
};

function createFixture(): TestFixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-router-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const runtimeEvents = new RuntimeEvents();
  const events: RuntimeEvent[] = [];
  runtimeEvents.onEvent((event) => {
    events.push(event);
  });
  const traceStore = new TraceStore(database);
  const blackboardStore = new BlackboardStore(database);
  const artifactStore = new ArtifactStore(database);
  const taskStateStore = new TaskStateStore(database);
  const deliveryStore = new EnvelopeDeliveryStore(database);
  const actorStore = new AgentActorStore(database);
  const handoffStore = new HandoffStore(database);
  const registry = new AgentRegistry(runtimeEvents, actorStore);
  const router = new EnvelopeRouter(registry, traceStore, runtimeEvents, blackboardStore, artifactStore, taskStateStore, deliveryStore, actorStore, handoffStore);
  return {
    root,
    database,
    events,
    runtimeEvents,
    registry,
    traceStore,
    blackboardStore,
    artifactStore,
    taskStateStore,
    deliveryStore,
    actorStore,
    handoffStore,
    router,
    register: (card) => {
      const sent: SwarmEnvelope[] = [];
      registry.register(card, {
        send: (message: SwarmEnvelope) => {
          sent.push(message);
          return true;
        }
      } as ChildProcess);
      return { sent };
    },
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function envelope(
  type: SwarmEnvelope["type"],
  payload: unknown,
  input: {
    correlationId?: string;
    from?: SwarmEnvelope["from"];
    to?: SwarmEnvelope["to"];
  } = {}
): SwarmEnvelope {
  return createEnvelope({
    swarm_id: "swarm-1",
    session_id: "session-1",
    task_id: "task-router-1",
    from: input.from ?? { agent_id: "main" },
    to: input.to ?? { agent_id: "router", role: "router" },
    type,
    intent: type,
    payload,
    correlation_id: input.correlationId
  });
}

function collectIncoming(router: EnvelopeRouter): SwarmEnvelope[] {
  const incoming: SwarmEnvelope[] = [];
  router.on("incoming", (envelope: SwarmEnvelope) => {
    incoming.push(envelope);
  });
  return incoming;
}

function latestIncoming(incoming: SwarmEnvelope[], intent: string): SwarmEnvelope | undefined {
  return incoming.filter((item) => item.intent === intent).at(-1);
}

function agentCard(
  agentId: string,
  role: string,
  capabilities: string[],
  status: AgentCard["status"] = "idle",
  runningTasks = 0,
  successRate = 0.9
): AgentCard {
  return {
    agent_id: agentId,
    name: agentId,
    role,
    capabilities,
    status,
    load: {
      running_tasks: runningTasks,
      max_tasks: 4
    },
    reliability: {
      success_rate: successRate,
      avg_latency_ms: 100
    }
  };
}

function grantCapabilityLease(
  fixture: TestFixture,
  actorId: string,
  capability: string,
  sourceEnvelopeId: string,
  expiresAt = "2999-01-01T00:00:00.000Z"
): void {
  const actor = fixture.actorStore.get(actorId);
  assert(actor, `expected actor ${actorId} to be registered`);
  const currentPolicy = actor.metadata.autonomy_policy && typeof actor.metadata.autonomy_policy === "object" && !Array.isArray(actor.metadata.autonomy_policy)
    ? actor.metadata.autonomy_policy as { level?: string; capability_leases?: unknown[] }
    : {};
  fixture.actorStore.heartbeat(actorId, {
    metadata: {
      autonomy_policy: {
        ...currentPolicy,
        level: currentPolicy.level ?? "execute",
        capability_leases: [
          ...(Array.isArray(currentPolicy.capability_leases) ? currentPolicy.capability_leases : []),
          {
            capability,
            status: "active",
            expires_at: expiresAt,
            source_envelope_id: sourceEnvelopeId
          }
        ]
      }
    }
  });
}

function seedBlackboardEntry(
  fixture: TestFixture,
  input: {
    key: string;
    type: "plan" | "observation" | "evidence" | "result" | "critique" | "decision" | "artifact";
    taskId: string;
    agentId: string;
    tags: string[];
    value: unknown;
  }
): void {
  fixture.blackboardStore.write({
    swarm_id: "swarm-1",
    session_id: "session-1",
    task_id: input.taskId,
    key: input.key,
    type: input.type,
    value: input.value,
    created_by: { agent_id: input.agentId },
    tags: input.tags
  });
}
