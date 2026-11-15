/**
 * The ticket-VM model proxy on its own, with no VM and no gateway: a local server hands each request to `proxyModel`, whose
 * provider is a fake `fetch` that takes its time.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderUsageReport } from "../../providers/openai-provider.js";
import { writeFakeModelHome } from "../testing/fake-model.js";
import { proxyError, proxyModel } from "./model-proxy.js";

/** How long the fake provider takes before it answers, and again before its answer ends. */
const WAIT_MS = 60;
const swarmHome = mkdtempSync(join(tmpdir(), "swarm-proxy-home-"));
const savedHome = process.env.SWARM_HOME;
const reports: ProviderUsageReport[] = [];
let server: Server;

const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
const event = (data: unknown): Uint8Array => new TextEncoder().encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const answer = { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "pong" } }], usage };
/**
 * A provider that answers after `WAIT_MS` with the start of its answer, and sends the rest `WAIT_MS` later: the second
 * half of a plain answer, or a streamed one's last events, with its usage.
 */
const provider: typeof fetch = async (_url, init) => {
  const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { stream?: boolean };
  const plain = JSON.stringify(answer);
  const [first, ...rest] = body.stream
    ? [event({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] }), event({ choices: [], usage }), event("[DONE]")]
    : [plain.slice(0, 20), plain.slice(20)].map((part) => new TextEncoder().encode(part));
  await sleep(WAIT_MS);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first!);
      setTimeout(() => {
        for (const chunk of rest) controller.enqueue(chunk);
        controller.close();
      }, WAIT_MS);
    }
  }), { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } });
};

before(async () => {
  process.env.SWARM_HOME = swarmHome;
  writeFakeModelHome(swarmHome, "http://provider.invalid/v1");
  server = createServer((request, response) => {
    void proxyModel({ providerId: "local-test", rest: "/chat/completions", query: new URLSearchParams(), ticketId: "ticket-1",
      onUsage: (report) => { reports.push(report); }, fetch: provider }, request, response).catch((error: unknown) => { proxyError(response, error); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  if (savedHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = savedHome;
  rmSync(swarmHome, { recursive: true, force: true });
});

test("the model proxy records how long the provider took over a call: until its answer was read, and for a streamed one until its stream ended", async () => {
  const ask = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "ping" }], ...body }) });
  const plain = await ask({});
  assert.equal(plain.status, 200);
  assert.equal(((await plain.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content, "pong");
  const streamed = await ask({ stream: true });
  assert.equal(streamed.status, 200);
  assert.match(await streamed.text(), /"content":"pong"[\s\S]*data: \[DONE\]/);
  assert.deepEqual(reports.map((report) => [report.sessionId, report.totalTokens]), [["worker-ticket-1", 20], ["worker-ticket-1", 20]]);
  const [plainMs, streamedMs] = reports.map((report) => report.durationMs);
  // Both waits count: one timed only until the provider answered, or only from then on, records about `WAIT_MS`, and one
  // not timed records 0. The timers are not exact, so the floor is a little below the two waits.
  const floor = 2 * WAIT_MS - 20;
  assert.ok(plainMs! >= floor && plainMs! < 5000, `the plain call took ${plainMs} ms`);
  assert.ok(streamedMs! >= floor && streamedMs! < 5000, `the streamed call took ${streamedMs} ms`);
});
