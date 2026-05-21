import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import type { AgentCard, SwarmEnvelope } from "../protocol/types.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { TraceStore } from "../storage/trace-store.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";
import { AgentRegistry } from "./registry.js";
import { EnvelopeRouter } from "./router.js";
import { handleRuntimeChildTransportMessage } from "./runtime.js";

test("runtime child transport forwards child runtime envelopes into the router", async () => {
  const fixture = createFixture();
  try {
    const child = fixture.register(agentCard("worker-1", "coder", ["code.implement"]));
    const blackboardWrite = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-1",
      from: { agent_id: "worker-1", role: "coder" },
      to: { agent_id: "blackboard", role: "blackboard" },
      type: "blackboard.write",
      intent: "blackboard.write",
      payload: {
        key: "worker/result",
        type: "result",
        value: { ok: true }
      },
      correlation_id: "corr-child-blackboard"
    });

    const result = handleRuntimeChildTransportMessage({
      disposed: false,
      message: blackboardWrite,
      child: child.process,
      router: fixture.router,
      events: fixture.runtimeEvents,
      forwardToAddressedAgent: (envelope) => fixture.forwarded.push(envelope)
    });

    await waitForMicrotasks();

    assert.deepEqual(result, { handled: true, kind: "runtime_envelope" });
    assert.equal(fixture.blackboardStore.list("session-1").length, 1);
    assert.equal(fixture.blackboardStore.list("session-1")[0]?.key, "worker/result");
    assert.equal(child.sent.length, 0);
    assert.equal(fixture.forwarded.length, 0);
    assert.equal(
      fixture.traceStore.list("session-1").some((envelope) =>
        envelope.type === "blackboard.write" && envelope.correlation_id === "corr-child-blackboard"
      ),
      true
    );
    assert.equal(
      fixture.traceStore.list("session-1").some((envelope) =>
        envelope.type === "ack" && envelope.intent === "blackboard.write.ack" && envelope.reply_to === blackboardWrite.id
      ),
      true
    );
  } finally {
    fixture.close();
  }
});

test("runtime child transport routes addressed replies back to child agents", () => {
  const fixture = createFixture();
  try {
    const child = fixture.register(agentCard("worker-1", "coder", ["code.implement"]));
    const reply = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-1",
      from: { agent_id: "router", role: "router" },
      to: { agent_id: "worker-1", role: "coder" },
      type: "ack",
      intent: "router.dispatch.ack",
      payload: { delivered: ["worker-1"] },
      correlation_id: "corr-reply",
      reply_to: "env-original"
    });

    const result = handleRuntimeChildTransportMessage({
      disposed: false,
      message: reply,
      child: child.process,
      router: fixture.router,
      events: fixture.runtimeEvents,
      forwardToAddressedAgent: (envelope) => fixture.forwarded.push(envelope)
    });

    assert.deepEqual(result, { handled: true, kind: "reply" });
    assert.equal(fixture.forwarded.length, 1);
    assert.equal(fixture.forwarded[0]?.id, reply.id);
    assert.equal(
      fixture.traceStore.list("session-1").some((envelope) =>
        envelope.id === reply.id && envelope.intent === "router.dispatch.ack"
      ),
      true
    );
  } finally {
    fixture.close();
  }
});

test("runtime child transport converts task progress into loop activity", () => {
  const fixture = createFixture();
  try {
    const child = fixture.register(agentCard("worker-1", "coder", ["code.implement"]));
    const progress = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-1",
      from: { agent_id: "worker-1", role: "coder" },
      to: { agent_id: "runtime", role: "runtime" },
      type: "task.progress",
      intent: "task.progress",
      payload: {
        action: "file.read",
        status: "success",
        summary: "Read package.json",
        remainingToolCalls: 10
      },
      correlation_id: "corr-progress"
    });

    const result = handleRuntimeChildTransportMessage({
      disposed: false,
      message: progress,
      child: child.process,
      router: fixture.router,
      events: fixture.runtimeEvents,
      forwardToAddressedAgent: (envelope) => fixture.forwarded.push(envelope)
    });

    assert.deepEqual(result, { handled: true, kind: "task_progress" });
    const activity = fixture.events.find((event): event is Extract<RuntimeEvent, { type: "loop_activity" }> =>
      event.type === "loop_activity"
    );
    assert(activity, "expected a loop_activity event");
    assert.equal(activity.session_id, "session-1");
    assert.equal(activity.task_id, "task-1");
    assert.equal(activity.phase, "running_tool");
    assert.equal(activity.tool, "file.read");
    assert.equal(activity.status, "success");
    assert.equal(activity.summary, "Read package.json");
    assert.match(activity.message, /Worker tool file\.read success: Read package\.json/);
    assert.equal(fixture.forwarded.length, 0);
    assert.equal(
      fixture.traceStore.list("session-1").some((envelope) =>
        envelope.id === progress.id && envelope.type === "task.progress"
      ),
      true
    );
  } finally {
    fixture.close();
  }
});

test("runtime child transport reports router dispatch failures to the source child", async () => {
  const fixture = createFixture();
  try {
    const child = fixture.register(agentCard("worker-1", "coder", ["code.implement"]));
    const unrouteable = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-1",
      from: { agent_id: "worker-1", role: "coder" },
      to: { capability: "missing.capability" },
      type: "task.assign",
      intent: "delegate.missing",
      payload: {},
      correlation_id: "corr-missing"
    });

    const result = handleRuntimeChildTransportMessage({
      disposed: false,
      message: unrouteable,
      child: child.process,
      router: fixture.router,
      events: fixture.runtimeEvents,
      forwardToAddressedAgent: (envelope) => fixture.forwarded.push(envelope)
    });

    await waitForMicrotasks();

    assert.deepEqual(result, { handled: true, kind: "runtime_envelope" });
    assert.equal(child.sent.length, 1);
    assert.equal(child.sent[0]?.type, "error");
    assert.equal(child.sent[0]?.intent, "router.dispatch_failed");
    assert.equal(addressedAgentId(child.sent[0]?.to), "worker-1");
    assert.equal(child.sent[0]?.reply_to, unrouteable.id);
    assert.equal(child.sent[0]?.correlation_id, "corr-missing");
    assert.equal(fixture.events.some((event) => event.type === "error" && /No route/.test(event.message)), true);
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
  router: EnvelopeRouter;
  forwarded: SwarmEnvelope[];
  register(card: AgentCard): { process: Pick<ChildProcess, "send">; sent: SwarmEnvelope[] };
  close(): void;
};

function createFixture(): TestFixture {
  const root = mkdtempSync(join(tmpdir(), "swarm-distributed-transport-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const runtimeEvents = new RuntimeEvents();
  const events: RuntimeEvent[] = [];
  runtimeEvents.onEvent((event) => {
    events.push(event);
  });
  const registry = new AgentRegistry(runtimeEvents);
  const traceStore = new TraceStore(database);
  const blackboardStore = new BlackboardStore(database);
  const router = new EnvelopeRouter(registry, traceStore, runtimeEvents, blackboardStore);
  return {
    root,
    database,
    events,
    runtimeEvents,
    registry,
    traceStore,
    blackboardStore,
    router,
    forwarded: [],
    register: (card) => {
      const sent: SwarmEnvelope[] = [];
      const process = {
        send: (message: SwarmEnvelope) => {
          sent.push(message);
          return true;
        }
      } as Pick<ChildProcess, "send">;
      registry.register(card, process as ChildProcess);
      return { process, sent };
    },
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function agentCard(
  agentId: string,
  role: string,
  capabilities: string[],
  status: AgentCard["status"] = "idle"
): AgentCard {
  return {
    agent_id: agentId,
    name: agentId,
    role,
    capabilities,
    status,
    load: {
      running_tasks: 0,
      max_tasks: 4
    },
    reliability: {
      success_rate: 0.9,
      avg_latency_ms: 100
    }
  };
}

function addressedAgentId(address: SwarmEnvelope["to"] | undefined): string | undefined {
  return Array.isArray(address) ? address[0]?.agent_id : address?.agent_id;
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
