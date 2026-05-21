import { strict as assert } from "node:assert";
import test from "node:test";
import { isRunWatchError, watchRunViaGateway } from "./gateway-watch.js";
import type { GatewayRunRecord } from "./gateway-report.js";

const GATEWAY_URL = "http://127.0.0.1:38172";
const AT = "2026-05-11T00:00:00.000Z";

test("runs watch attaches to a session, streams JSONL events, and polls final status", async () => {
  await withMockFetch(async (requests, callCount) => {
    requests.set(`${GATEWAY_URL}/v1/runs`, {
      runs: [run({ session_id: undefined, status: "starting" })]
    });
    requests.set(`${GATEWAY_URL}/v1/runs/run_123`, [
      run({ session_id: undefined, status: "starting" }),
      run({ session_id: "sess_123", status: "running" }),
      run({ session_id: "sess_123", status: "completed" })
    ]);
    requests.set(
      `${GATEWAY_URL}/v1/sessions/sess_123/work-events`,
      streamResponse([
        sseBlock("ready", { ok: true }),
        sseBlock("message", {
          schema_version: "swarm.work.v1",
          kind: "task",
          at: AT,
          session_id: "sess_123",
          task_id: "task_1",
          phase: "completed",
          action: "code.test",
          result_status: "success",
          summary: "tests passed"
        }),
        sseBlock("message", {
          schema_version: "swarm.work.v1",
          kind: "session",
          at: AT,
          session_id: "sess_123",
          status: "completed"
        })
      ].join(""))
    );

    const lines: string[] = [];
    const summary = await watchRunViaGateway({
      gatewayUrl: GATEWAY_URL,
      selector: "latest",
      protocol: "work",
      jsonl: true,
      pollIntervalMs: 0,
      writeLine: (line) => lines.push(line)
    });

    assert.equal(summary.gatewayUrl, GATEWAY_URL);
    assert.equal(summary.attachedSessionId, "sess_123");
    assert.equal(summary.finalStatus, "completed");
    assert.equal(summary.events, 2);
    assert.equal(summary.interrupted, false);
    assert(callCount.get(`${GATEWAY_URL}/v1/runs/run_123`)! >= 3);

    const records = lines.map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
    assert.deepEqual(records.map((record) => record.type), [
      "watch_start",
      "watch_waiting",
      "watch_attach",
      "watch_event",
      "watch_event",
      "watch_end"
    ]);
    assert.equal(records[1].reason, "waiting_for_session");
    assert.equal(records[2].session_id, "sess_123");
    assert.equal(records[3].at, AT);
    assert.equal(records[5].status, "completed");
    assert.equal(records[5].events, 2);
  });
});

test("runs watch reports terminal runs without a session stream", async () => {
  await withMockFetch(async (requests) => {
    requests.set(`${GATEWAY_URL}/v1/runs`, {
      runs: [run({ session_id: undefined, status: "failed", error: "session failed before attach" })]
    });
    requests.set(`${GATEWAY_URL}/v1/runs/run_123`, run({ session_id: undefined, status: "failed", error: "session failed before attach" }));

    const lines: string[] = [];
    const summary = await watchRunViaGateway({
      gatewayUrl: GATEWAY_URL,
      selector: "latest",
      jsonl: true,
      pollIntervalMs: 0,
      writeLine: (line) => lines.push(line)
    });

    assert.equal(summary.events, 0);
    assert.equal(summary.attachedSessionId, undefined);
    assert.equal(summary.finalStatus, "failed");
    const records = lines.map((line) => JSON.parse(line) as { type: string; reason?: string; status?: string });
    assert.deepEqual(records.map((record) => record.type), ["watch_start", "watch_unavailable", "watch_end"]);
    assert.equal(records[1].reason, "session_unavailable");
    assert.equal(records[2].status, "failed");
  });
});

test("runs watch maps Gateway stream HTTP errors to RunWatchError", async () => {
  await withMockFetch(async (requests) => {
    requests.set(`${GATEWAY_URL}/v1/runs`, {
      runs: [run({ session_id: "sess_123", status: "running" })]
    });
    requests.set(`${GATEWAY_URL}/v1/runs/run_123`, run({ session_id: "sess_123", status: "running" }));
    requests.set(`${GATEWAY_URL}/v1/sessions/sess_123/work-events`, {
      status: 503,
      body: { error: { message: "stream unavailable" } }
    });

    await assert.rejects(
      () => watchRunViaGateway({
        gatewayUrl: GATEWAY_URL,
        selector: "latest",
        pollIntervalMs: 0,
        writeLine: () => undefined
      }),
      (error: unknown) => {
        assert(isRunWatchError(error));
        assert.equal(error.status, 503);
        assert.equal(error.runId, "run_123");
        assert.match(error.message, /stream unavailable/);
        return true;
      }
    );
  });
});

async function withMockFetch(
  runTest: (requests: Map<string, unknown>, callCount: Map<string, number>) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests = new Map<string, unknown>();
  const callCount = new Map<string, number>();
  globalThis.fetch = (async (url: string | URL | Request) => {
    const key = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    callCount.set(key, (callCount.get(key) ?? 0) + 1);
    if (!requests.has(key)) {
      return jsonResponse({ error: { message: `unexpected request: ${key}` } }, 404);
    }
    const entry = nextMockEntry(requests.get(key), callCount.get(key)!);
    if (entry instanceof Response) {
      return entry;
    }
    if (isMockResponse(entry)) {
      return jsonResponse(entry.body, entry.status);
    }
    return jsonResponse(entry, 200);
  }) as typeof fetch;
  try {
    await runTest(requests, callCount);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function nextMockEntry(entry: unknown, calls: number): unknown {
  if (!Array.isArray(entry)) {
    return entry;
  }
  return entry[Math.min(calls - 1, entry.length - 1)];
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function streamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function sseBlock(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isMockResponse(value: unknown): value is { status: number; body: unknown } {
  return typeof value === "object"
    && value !== null
    && "status" in value
    && typeof (value as { status?: unknown }).status === "number";
}

function run(overrides: Partial<GatewayRunRecord> = {}): GatewayRunRecord {
  return {
    run_id: "run_123",
    session_id: "sess_123",
    objective: "Test objective",
    mode: "coding_loop",
    status: "running",
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: "2026-05-11T00:00:00.000Z",
    ...overrides
  };
}
