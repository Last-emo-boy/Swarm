import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import type { AgentCard, SwarmEnvelope } from "../protocol/types.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { EnvelopeDeliveryStore } from "../storage/envelope-delivery-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";
import { AgentRegistry } from "./registry.js";
import { EnvelopeRouter } from "./router.js";
import { createSourceUserMessageEnvelope, workItemSourceAdapterMetadata } from "./source-adapter.js";

test("source adapter normalizes CLI and Gateway user messages as homogeneous envelopes", () => {
  const cli = createSourceUserMessageEnvelope({
    source: "cli",
    sourceId: "headless",
    content: "Fix the failing test.",
    swarmId: "swarm-cli",
    sessionId: "session-cli",
    route: "run",
    mode: "coding_loop",
    requestId: "cli-req-1"
  });
  const gateway = createSourceUserMessageEnvelope({
    source: "gateway",
    sourceId: "http",
    trustLevel: "trusted",
    content: "Fix the failing test.",
    swarmId: "swarm-gateway",
    sessionId: "session-gateway",
    route: "/v1/live/messages",
    mode: "live",
    requestId: "gateway-req-1",
    from: { agent_id: "gateway.local", role: "http_gateway" }
  });

  assert.equal(cli.type, "user.message");
  assert.equal(gateway.type, "user.message");
  assert.equal(cli.intent, gateway.intent);
  assert.equal(cli.payload.schema_version, "swarm.source_adapter.user_message.v1");
  assert.equal(gateway.payload.schema_version, "swarm.source_adapter.user_message.v1");
  assert.equal(cli.payload.content, gateway.payload.content);
  assert.equal(cli.payload.source, "cli");
  assert.equal(gateway.payload.source, "gateway");
  assert.equal(cli.from.role, "source_adapter");
  assert.equal(gateway.from.agent_id, "gateway.local");
  assert(cli.idempotency_key?.includes("cli"));
  assert(gateway.idempotency_key?.includes("gateway"));
});

test("source adapter dedupe key is stable for repeated source events", () => {
  const first = createSourceUserMessageEnvelope({
    source: "gateway",
    sourceId: "http",
    content: "same content",
    swarmId: "swarm-1",
    sessionId: "session-1",
    requestId: "request-1"
  });
  const second = createSourceUserMessageEnvelope({
    source: "gateway",
    sourceId: "http",
    content: "different body should not matter when request id is stable",
    swarmId: "swarm-1",
    sessionId: "session-1",
    requestId: "request-1"
  });
  const third = createSourceUserMessageEnvelope({
    source: "gateway",
    sourceId: "http",
    content: "same content",
    swarmId: "swarm-1",
    sessionId: "session-1"
  });

  assert.equal(first.idempotency_key, second.idempotency_key);
  assert.notEqual(first.idempotency_key, third.idempotency_key);
  assert.equal(first.correlation_id, "request-1");
});

test("source event dedupe prevents duplicate task create", async () => {
  const fixture = createRouterFixture();
  try {
    const task = {
      task_id: "task-source-dedupe",
      title: "Source dedupe task",
      description: "Created from a source adapter event.",
      objective: "Prove source event dedupe.",
      type: "coding" as const,
      status: "pending" as const,
      required_capabilities: [],
      inputs: {},
      expected_output: { format: "markdown" as const }
    };
    const first = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: task.task_id,
      from: { agent_id: "source.gateway", role: "source_adapter" },
      to: { agent_id: "router", role: "router" },
      type: "task.create",
      intent: "source.task.create",
      idempotency_key: "source:gateway:task.create:request-1",
      payload: {
        task,
        source: "gateway",
        source_id: "http",
        trust_level: "trusted",
        dedupe_key: "request-1"
      }
    });
    const second = {
      ...createEnvelope({
        swarm_id: "swarm-1",
        session_id: "session-1",
        task_id: task.task_id,
        from: { agent_id: "source.gateway", role: "source_adapter" },
        to: { agent_id: "router", role: "router" },
        type: "task.create",
        intent: "source.task.create",
        idempotency_key: "source:gateway:task.create:request-1",
        payload: {
          task: { ...task, title: "Duplicate source dedupe task" },
          source: "gateway",
          source_id: "http",
          trust_level: "trusted",
          dedupe_key: "request-1"
        }
      }),
      id: "env-source-duplicate"
    };

    await fixture.router.dispatch(first);
    await fixture.router.dispatch(second);

    assert.equal(fixture.traceStore.list("session-1").filter((item) => item.type === "task.create").length, 1);
    assert.equal(fixture.taskStateStore.list("session-1").filter((item) => item.task_id === task.task_id).length, 1);
    assert.equal(fixture.events.some((event) => event.type === "log" && /Skipping duplicate envelope/.test(event.message)), true);
    assert.equal(fixture.deliveryStore.list({ envelopeId: "env-source-duplicate" }).at(0)?.status, "superseded");
  } finally {
    fixture.close();
  }
});

test("source adapter failure is reported without direct runtime mutation", async () => {
  const fixture = createRouterFixture();
  try {
    fixture.register(agentCard("main_swarm", "controller", ["swarm.coordinate"]));
    fixture.actorStore.registerSystemActor({
      actor_id: "gateway.local",
      kind: "source_adapter",
      name: "Gateway Source Adapter",
      role: "source_adapter",
      capabilities: ["source.normalize"],
      metadata: {
        autonomy_policy: {
          level: "observe",
          denied_envelope_types: ["user.message"]
        }
      }
    });
    const envelope = createSourceUserMessageEnvelope({
      source: "gateway",
      sourceId: "http",
      content: "denied source event",
      swarmId: "swarm-1",
      sessionId: "session-1",
      requestId: "request-denied",
      from: { agent_id: "gateway.local", role: "source_adapter" }
    });

    await assert.rejects(() => fixture.router.dispatch(envelope), /Envelope denied by autonomy policy/);

    assert.equal(fixture.traceStore.list("session-1").length, 0);
    assert.equal(fixture.taskStateStore.list("session-1").length, 0);
    assert.equal(fixture.deliveryStore.list({ envelopeId: envelope.id }).at(0)?.status, "failed");
  } finally {
    fixture.close();
  }
});

test("work item source metadata keeps adapter identity compact", () => {
  const metadata = workItemSourceAdapterMetadata({
    source: "symphony",
    source_id: "WF-1",
    human_id: "TASK-1",
    title: "Task 1",
    labels: ["bug"],
    state: "todo",
    metadata: { large: "ignored" }
  });

  assert.deepEqual(metadata, {
    source: "symphony",
    source_id: "WF-1",
    human_id: "TASK-1",
    title: "Task 1",
    state: "todo",
    labels: ["bug"]
  });
});

function createRouterFixture(): {
  root: string;
  database: SwarmDatabase;
  events: RuntimeEvent[];
  traceStore: TraceStore;
  taskStateStore: TaskStateStore;
  deliveryStore: EnvelopeDeliveryStore;
  actorStore: AgentActorStore;
  router: EnvelopeRouter;
  register(card: AgentCard): { sent: SwarmEnvelope[] };
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-source-adapter-"));
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
    traceStore,
    taskStateStore,
    deliveryStore,
    actorStore,
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

function agentCard(agentId: string, role: string, capabilities: string[]): AgentCard {
  return {
    agent_id: agentId,
    name: agentId,
    role,
    capabilities,
    status: "idle",
    load: { running_tasks: 0, max_tasks: 1 },
    reliability: { success_rate: 1, avg_latency_ms: 0 }
  };
}
