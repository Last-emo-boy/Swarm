import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentActorStore } from "./agent-actor-store.js";
import { SwarmDatabase } from "./database.js";
import { WorkerStateStore } from "./worker-state-store.js";

test("agent actor heartbeat transitions fresh, stale, offline, and blocked", () => {
  const fixture = createFixture();
  try {
    fixture.actors.registerSystemActor({
      actor_id: "agent-heartbeat",
      kind: "builtin",
      name: "Heartbeat Agent",
      role: "coder",
      capabilities: ["code.implement"],
      now: "2026-05-25T00:00:00.000Z"
    });

    assert.equal(fixture.actors.get("agent-heartbeat", {
      now: "2026-05-25T00:01:00.000Z"
    })?.heartbeat_state, "fresh");
    assert.equal(fixture.actors.get("agent-heartbeat", {
      now: "2026-05-25T00:06:00.000Z"
    })?.heartbeat_state, "stale");
    assert.equal(fixture.actors.get("agent-heartbeat", {
      now: "2026-05-25T00:31:00.000Z"
    })?.heartbeat_state, "offline");

    fixture.actors.heartbeat("agent-heartbeat", {
      metadata: { blocked_reason: "Waiting for review." },
      now: "2026-05-25T00:32:00.000Z"
    });
    assert.equal(fixture.actors.get("agent-heartbeat", {
      now: "2026-05-25T00:33:00.000Z"
    })?.heartbeat_state, "blocked");

    fixture.actors.updateStatus("agent-heartbeat", "offline", {
      now: "2026-05-25T00:34:00.000Z"
    });
    assert.equal(fixture.actors.get("agent-heartbeat", {
      now: "2026-05-25T00:34:01.000Z"
    })?.heartbeat_state, "offline");
  } finally {
    fixture.close();
  }
});

test("worker state projects to a distinct actor without changing worker record shape", () => {
  const fixture = createFixture();
  try {
    const worker = fixture.workers.create({
      worker_id: "worker-test-1",
      display_name: "Ada",
      role_title: "Coder",
      parent_session_id: "session-parent-1",
      capability: "code.implement",
      objective: "Implement actor projection",
      status: "running",
      agent_spec_id: "coder",
      invocation_mode: "parallel",
      file_scope: ["src/runtime/router.ts"],
      tool_budget: { max_turns: 4, max_tool_calls: 12 },
      requested_by: "main_swarm"
    });

    assert.equal(fixture.workers.get(worker.worker_id)?.worker_id, "worker-test-1");
    assert.equal(fixture.workers.get(worker.worker_id)?.display_name, "Ada");

    const actor = fixture.actors.get("worker:worker-test-1");
    assert.equal(actor?.kind, "worker");
    assert.equal(actor?.status, "busy");
    assert.equal(actor?.current_worker_id, "worker-test-1");
    assert.equal(actor?.current_task_id, "worker-test-1");
    assert.equal(actor?.current_session_id, "session-parent-1");
    assert.equal((actor?.current_ownership as { requested_by?: string } | undefined)?.requested_by, "main_swarm");
    assert.deepEqual(actor?.capabilities, ["code.implement", "coder"]);

    const completed = fixture.workers.setResult({
      worker_id: "worker-test-1",
      status: "completed",
      last_result: "Done."
    });
    assert.equal(completed.last_result, "Done.");
    assert.equal(fixture.workers.get(worker.worker_id)?.status, "completed");

    const completedActor = fixture.actors.get("worker:worker-test-1");
    assert.equal(completedActor?.status, "offline");
    assert.equal(completedActor?.current_task_id, undefined);
    assert.equal(completedActor?.current_worker_id, undefined);
    assert.equal(completedActor?.current_ownership, undefined);
    assert.equal(completedActor?.metadata.worker_status, "completed");
  } finally {
    fixture.close();
  }
});

function createFixture(): {
  root: string;
  database: SwarmDatabase;
  actors: AgentActorStore;
  workers: WorkerStateStore;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "swarm-agent-actors-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  const actors = new AgentActorStore(database);
  const workers = new WorkerStateStore(database, actors);
  return {
    root,
    database,
    actors,
    workers,
    close: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
