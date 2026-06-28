import { strict as assert } from "node:assert";
import test from "node:test";
import { RuntimeEvents } from "./events.js";
import {
  emitLegacyDirectInvokeAdapterTelemetry,
  formatLegacyDirectInvokeAdapterTelemetry
} from "./legacy-direct-invoke-telemetry.js";

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
