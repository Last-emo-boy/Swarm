import { strict as assert } from "node:assert";
import test from "node:test";
import type { RuntimeEvent } from "./events.js";
import type { WorkProtocolRecord } from "./work-protocol.js";
import {
  eventTimestamp,
  formatGatewayRuntimeWatchLine,
  formatGatewayWorkWatchLine,
  gatewayPayloadRuntimeEvent,
  gatewayPayloadWorkRecord,
  gatewayTerminalStatus,
  parseGatewayWatchProtocol
} from "./gateway-event-stream.js";

const AT = "2026-05-11T00:00:00.000Z";

test("gateway stream helpers format runtime protocol payloads", () => {
  const event: RuntimeEvent = {
    type: "final",
    session_id: "session-1",
    content: "Done",
    status: "failed",
    outcome: { changed_files: ["src/runtime/gateway-event-stream.ts"], tests_run: ["npm test"], intermediate_artifacts: [], final_summary: "Done" },
    checkpoint: {
      id: "cp_gateway_event_stream",
      name: "Gateway stream checkpoint",
      mode: "snapshot",
      status: "available",
      revertAvailable: false
    }
  };
  const work: WorkProtocolRecord = {
    schema_version: "swarm.work.v1",
    kind: "runtime_event",
    at: AT,
    event_type: "final",
    session_id: "session-1",
    summary: "Done",
    event
  };
  const payload = { at: AT, event, work };

  assert.equal(formatGatewayRuntimeWatchLine("final", payload), `${AT} final: failed, 1 changed, 1 checks`);
  assert.equal(gatewayTerminalStatus("runtime", payload), "failed");
  assert.equal(gatewayPayloadRuntimeEvent(payload), event);
  assert.equal(gatewayPayloadWorkRecord("runtime", payload), work);
  assert.equal(eventTimestamp(payload), AT);
});

test("gateway stream helpers preserve checkpoint-bearing final runtime projections", () => {
  const event: RuntimeEvent = {
    type: "final",
    session_id: "session-2",
    content: "Checkpoint projection complete.",
    status: "completed",
    outcome: {
      changed_files: ["src/runtime/gateway-event-stream.test.ts"],
      tests_run: ["node --import tsx --test src/runtime/gateway-event-stream.test.ts"],
      intermediate_artifacts: ["checkpoint-projection.json"],
      final_summary: "Checkpoint projection complete."
    },
    checkpoint: {
      id: "cp_gateway_projection",
      name: "Gateway projection checkpoint",
      mode: "git",
      status: "available",
      revertAvailable: true
    }
  };
  const work: WorkProtocolRecord = {
    schema_version: "swarm.work.v1",
    kind: "runtime_event",
    at: AT,
    event_type: "final",
    session_id: "session-2",
    summary: "Checkpoint projection complete.",
    event
  };
  const payload = { at: AT, event, work };

  assert.equal(formatGatewayRuntimeWatchLine("final", payload), `${AT} final: completed, 1 changed, 1 checks`);
  assert.equal(gatewayTerminalStatus("runtime", payload), "completed");
  const runtimeEvent = gatewayPayloadRuntimeEvent(payload);
  assert.equal(runtimeEvent, event);
  assert(runtimeEvent, "Expected runtime event payload");
  assert.equal(runtimeEvent.type, "final");
  assert.equal(runtimeEvent.checkpoint?.name, "Gateway projection checkpoint");
  const runtimeRecord = gatewayPayloadWorkRecord("runtime", payload);
  assert.equal(runtimeRecord, work);
  assert(runtimeRecord, "Expected runtime work record payload");
  assert.equal(runtimeRecord.kind, "runtime_event");
  assert.equal(runtimeRecord.event.type, "final");
  assert.equal(runtimeRecord.event.checkpoint?.revertAvailable, true);
  assert.equal(eventTimestamp(payload), AT);
});

test("gateway stream helpers format work protocol records", () => {
  const payload: WorkProtocolRecord = {
    schema_version: "swarm.work.v1",
    kind: "task",
    at: AT,
    session_id: "session-1",
    task_id: "task-1",
    phase: "completed",
    title: "Run tests",
    action: "code.test",
    result_status: "success",
    summary: "node --test passed",
    write_policy: "read_only",
    file_scope: ["src/runtime/gateway-event-stream.ts"]
  };

  assert.equal(
    formatGatewayWorkWatchLine(payload),
    `${AT} task:completed code.test [success] node --test passed policy=read_only scope=src/runtime/gateway-event-stream.ts`
  );
  assert.equal(gatewayPayloadWorkRecord("work", payload), payload);
  assert.equal(gatewayTerminalStatus("work", payload), undefined);
});

test("gateway terminal status is extracted from runtime and work session payloads", () => {
  assert.equal(
    gatewayTerminalStatus("runtime", { event: { type: "session", session_id: "session-1", status: "completed" } }),
    "completed"
  );
  assert.equal(
    gatewayTerminalStatus("work", { schema_version: "swarm.work.v1", kind: "session", at: AT, session_id: "session-1", status: "cancelled" }),
    "cancelled"
  );
  assert.equal(
    gatewayTerminalStatus("work", {
      schema_version: "swarm.work.v1",
      kind: "runtime_event",
      at: AT,
      event_type: "final",
      summary: "Done",
      event: { type: "final", session_id: "session-1", content: "Done" }
    }),
    "completed"
  );
});

test("gateway watch protocol parser defaults to work and rejects unknown protocols", () => {
  assert.equal(parseGatewayWatchProtocol(), "work");
  assert.equal(parseGatewayWatchProtocol("work"), "work");
  assert.equal(parseGatewayWatchProtocol("runtime"), "runtime");
  assert.throws(() => parseGatewayWatchProtocol("jsonl"), /Expected runtime or work/);
});
