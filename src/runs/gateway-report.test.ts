import { strict as assert } from "node:assert";
import test from "node:test";
import {
  listGatewayRunRecords,
  listRunsViaGateway,
  readGatewayRunRecord,
  showRunViaGateway,
  type GatewayRunRecord
} from "./gateway-report.js";
import { resolveGatewayUrl } from "../server/gateway-client-utils.js";

const GATEWAY_URL = "http://127.0.0.1:38171";

test("runs gateway report lists sorted runs and summary counts", async () => {
  await withMockFetch(async (requests) => {
    requests.set(`${GATEWAY_URL}/v1/runs`, {
      runs: [
        run({ run_id: "run_old", status: "completed", updated_at: "2026-05-11T00:00:00.000Z" }),
        run({ run_id: "run_new", status: "running", updated_at: "2026-05-11T00:01:00.000Z" }),
        run({ run_id: "run_failed", status: "failed", updated_at: "2026-05-11T00:00:30.000Z", error: "boom" })
      ]
    });

    const report = await listRunsViaGateway({ gatewayUrl: GATEWAY_URL });
    const data = report.data as { summary: { total: number; running: number; completed: number; failed: number }; runs: GatewayRunRecord[] };

    assert.deepEqual(data.summary, { total: 3, running: 1, completed: 1, failed: 1 });
    assert.deepEqual(data.runs.map((item) => item.run_id), ["run_new", "run_failed", "run_old"]);
    assert.match(report.detail, /summary total=3 running=1 completed=1 failed=1/);
    assert.match(report.detail, /run_failed/);
    assert.match(report.detail, /error=boom/);
  });
});

test("runs gateway report resolves latest, prefix, and fuzzy selectors", async () => {
  await withMockFetch(async (requests) => {
    requests.set(`${GATEWAY_URL}/v1/runs`, {
      runs: [
        run({ run_id: "run_alpha", session_id: "sess_alpha", objective: "Fix tests", updated_at: "2026-05-11T00:01:00.000Z" }),
        run({ run_id: "run_beta", session_id: "sess_beta", objective: "Update docs", updated_at: "2026-05-11T00:00:00.000Z" })
      ]
    });
    requests.set(`${GATEWAY_URL}/v1/runs/run_alpha`, run({ run_id: "run_alpha", session_id: "sess_alpha", objective: "Fix tests" }));
    requests.set(`${GATEWAY_URL}/v1/runs/run_beta`, run({ run_id: "run_beta", session_id: "sess_beta", objective: "Update docs" }));

    assert.equal(runFromReport(await showRunViaGateway({ gatewayUrl: GATEWAY_URL, selector: "latest" })).run_id, "run_alpha");
    assert.equal(runFromReport(await showRunViaGateway({ gatewayUrl: GATEWAY_URL, selector: "run_b" })).run_id, "run_beta");
    assert.equal(runFromReport(await showRunViaGateway({ gatewayUrl: GATEWAY_URL, selector: "update docs" })).run_id, "run_beta");
  });
});

test("runs gateway report rejects malformed gateway payloads and invalid urls", async () => {
  await withMockFetch(async (requests) => {
    requests.set(`${GATEWAY_URL}/v1/runs`, { unexpected: [] });

    await assert.rejects(
      () => listGatewayRunRecords(GATEWAY_URL),
      /Unexpected Swarm Gateway response/
    );
  });

  assert.throws(() => resolveGatewayUrl("localhost:38171"), /Invalid gateway URL/);
});

test("runs gateway report surfaces gateway HTTP errors", async () => {
  await withMockFetch(async (requests) => {
    requests.set(`${GATEWAY_URL}/v1/runs/run_missing`, {
      status: 404,
      body: { error: { message: "run not found" } }
    });

    await assert.rejects(
      () => readGatewayRunRecord(GATEWAY_URL, "run_missing"),
      /run not found/
    );
  });
});

async function withMockFetch(runTest: (requests: Map<string, unknown>) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests = new Map<string, unknown>();
  globalThis.fetch = (async (url: string | URL | Request) => {
    const key = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (!requests.has(key)) {
      return response({ error: { message: `unexpected request: ${key}` } }, 404);
    }
    const entry = requests.get(key) as { status?: number; body?: unknown } | unknown;
    if (isMockResponse(entry)) {
      return response(entry.body, entry.status);
    }
    return response(entry, 200);
  }) as typeof fetch;
  try {
    await runTest(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
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
    status: "completed",
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: "2026-05-11T00:00:00.000Z",
    ...overrides
  };
}

function runFromReport(report: { data: Record<string, unknown> }): GatewayRunRecord {
  return report.data.run as GatewayRunRecord;
}
