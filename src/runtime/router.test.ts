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
import { SwarmDatabase } from "../storage/database.js";
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
    assert.deepEqual(fixture.blackboardStore.read("session-1", { key: "decision/router" }).at(-1)?.value, {
      selected: "coder-2"
    });

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
  const registry = new AgentRegistry(runtimeEvents);
  const traceStore = new TraceStore(database);
  const blackboardStore = new BlackboardStore(database);
  const artifactStore = new ArtifactStore(database);
  const taskStateStore = new TaskStateStore(database);
  const router = new EnvelopeRouter(registry, traceStore, runtimeEvents, blackboardStore, artifactStore, taskStateStore);
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
