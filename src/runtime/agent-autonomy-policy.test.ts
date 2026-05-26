import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { decideEnvelopeAutonomy } from "./agent-autonomy-policy.js";

test("autonomy policy denies envelopes above actor level and explains recovery", () => {
  const fixture = createFixture();
  try {
    fixture.actors.registerSystemActor({
      actor_id: "observer-1",
      kind: "builtin",
      name: "Observer",
      role: "observer",
      capabilities: [],
      metadata: {
        autonomy_policy: {
          level: "observe"
        }
      }
    });
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-denied",
      from: { agent_id: "observer-1" },
      to: { agent_id: "main_swarm" },
      type: "task.assign",
      intent: "observer.assign",
      payload: {}
    });

    const decision = decideEnvelopeAutonomy(envelope, fixture.actors.get("observer-1"));
    assert.equal(decision.decision, "deny");
    assert.equal(decision.required_level, "execute");
    assert.equal(decision.actor_level, "observe");
    assert.match(decision.reason, /requires execute autonomy/);
    assert.match(decision.recoverySuggestion ?? "", /capability lease|autonomy policy/);
  } finally {
    fixture.close();
  }
});

test("capability lease allows scoped capability even when actor card lacks capability", () => {
  const fixture = createFixture();
  try {
    fixture.actors.registerSystemActor({
      actor_id: "leased-worker",
      kind: "worker",
      name: "Leased Worker",
      role: "coder",
      capabilities: [],
      metadata: {
        autonomy_policy: {
          level: "execute",
          capability_leases: [
            {
              capability: "code.implement",
              actions: ["task.accept"],
              source_envelope_id: "env-lease-1"
            }
          ]
        }
      }
    });
    const envelope = createEnvelope({
      swarm_id: "swarm-1",
      session_id: "session-1",
      task_id: "task-lease",
      from: { agent_id: "leased-worker", capability: "code.implement" },
      to: { agent_id: "main_swarm" },
      type: "task.accept",
      intent: "leased.accept",
      payload: {}
    });

    const decision = decideEnvelopeAutonomy(envelope, fixture.actors.get("leased-worker"));
    assert.equal(decision.decision, "allow");
    assert.equal(decision.lease_source_envelope_id, "env-lease-1");
  } finally {
    fixture.close();
  }
});

function createFixture(): {
  root: string;
  database: SwarmDatabase;
  actors: AgentActorStore;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-autonomy-policy-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const actors = new AgentActorStore(database);
  return {
    root,
    database,
    actors,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
