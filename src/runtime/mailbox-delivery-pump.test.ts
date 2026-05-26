import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { EnvelopeDeliveryStore } from "../storage/envelope-delivery-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { SwarmBudgetGovernor } from "./budget-governor.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";
import { MailboxDeliveryPump } from "./mailbox-delivery-pump.js";

test("provider retry after applies mailbox backpressure", async () => {
  const fixture = createFixture();
  try {
    fixture.actors.registerSystemActor({
      actor_id: "worker:budget",
      kind: "worker",
      name: "Budget Worker",
      role: "coder",
      now: "2026-05-26T00:00:00.000Z"
    });
    const envelope = createEnvelope({
      swarm_id: "swarm-budget",
      session_id: "session-budget",
      task_id: "task-accepted",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "worker:budget", capability: "code.test" },
      type: "task.assign",
      intent: "budgeted assign",
      priority: "normal",
      payload: { worker_id: "task-accepted", provider_id: "openai" }
    });
    fixture.traces.append(envelope);
    fixture.deliveries.recordQueued(envelope);
    const governor = new SwarmBudgetGovernor({
      now: "2026-05-26T00:00:00.000Z",
      accepted_task_ids: ["task-accepted"],
      provider: { openai: { retry_after_ms: 45_000 } }
    });
    const pump = new MailboxDeliveryPump(
      fixture.deliveries,
      fixture.traces,
      fixture.actors,
      fixture.events,
      undefined,
      governor
    );

    const result = await pump.pumpActor("worker:budget", () => {
      throw new Error("handler should not run under backpressure");
    });
    const actor = fixture.actors.get("worker:budget");
    const budgetEvent = fixture.captured.find((event) => event.type === "budget");

    assert.equal(result.delivered, 0);
    assert.equal(result.acked, 0);
    assert.equal(result.sleeping, 1);
    assert.equal(result.failed, 0);
    assert.equal(fixture.deliveries.list({ envelopeId: envelope.id })[0]?.status, "queued");
    assert.equal(actor?.status, "draining");
    assert.equal(actor?.current_task_id, "task-accepted");
    assert.equal(actor?.metadata.runner_lifecycle, "sleeping");
    assert.equal(actor?.metadata.budget_action, "sleep");
    assert.equal((budgetEvent as Extract<RuntimeEvent, { type: "budget" }> | undefined)?.decision.action, "sleep");
  } finally {
    fixture.close();
  }
});

test("budget exhausted rejects non accepted normal priority delivery", async () => {
  const fixture = createFixture();
  try {
    fixture.actors.registerSystemActor({
      actor_id: "worker:budget-low",
      kind: "worker",
      name: "Budget Low Worker",
      role: "coder",
      now: "2026-05-26T00:00:00.000Z"
    });
    const envelope = createEnvelope({
      swarm_id: "swarm-budget",
      session_id: "session-budget",
      task_id: "task-low",
      from: { agent_id: "main_swarm" },
      to: { agent_id: "worker:budget-low", capability: "code.test" },
      type: "task.assign",
      intent: "budgeted assign",
      priority: "normal",
      payload: { worker_id: "task-low" }
    });
    fixture.traces.append(envelope);
    fixture.deliveries.recordQueued(envelope);
    const governor = new SwarmBudgetGovernor({
      now: "2026-05-26T00:00:00.000Z",
      session: { used_tokens: 10_000, max_tokens: 10_000 }
    });
    const pump = new MailboxDeliveryPump(fixture.deliveries, fixture.traces, fixture.actors, fixture.events, undefined, governor);

    const result = await pump.pumpActor("worker:budget-low", () => {
      throw new Error("handler should not run under exhausted budget");
    });

    assert.equal(result.rejected, 1);
    assert.equal(result.failed, 1);
    assert.equal(fixture.deliveries.list({ envelopeId: envelope.id })[0]?.status, "failed");
    assert.equal(fixture.actors.get("worker:budget-low")?.status, "degraded");
    assert.equal(fixture.actors.get("worker:budget-low")?.current_task_id, undefined);
  } finally {
    fixture.close();
  }
});

function createFixture(): {
  root: string;
  database: SwarmDatabase;
  traces: TraceStore;
  deliveries: EnvelopeDeliveryStore;
  actors: AgentActorStore;
  events: RuntimeEvents;
  captured: RuntimeEvent[];
  close: () => void;
} {
  const root = join(tmpdir(), `swarm-mailbox-pump-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const traces = new TraceStore(database);
  const deliveries = new EnvelopeDeliveryStore(database);
  const actors = new AgentActorStore(database);
  const events = new RuntimeEvents();
  const captured: RuntimeEvent[] = [];
  events.onEvent((event) => captured.push(event));
  return {
    root,
    database,
    traces,
    deliveries,
    actors,
    events,
    captured,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
