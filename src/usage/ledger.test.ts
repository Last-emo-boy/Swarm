import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ProviderUsageReport } from "../providers/openai-provider.js";
import { SwarmDatabase } from "../storage/database.js";
import { UsageStore } from "../storage/usage-store.js";
import { groupLedger, ledgerEntry, priceLedger, readLedger, readLedgerAt, totalOf } from "./ledger.js";
import { DEFAULT_PRICES } from "./prices.js";

const root = mkdtempSync(join(tmpdir(), "swarm-usage-ledger-"));
const saved = process.env.SWARM_HOME;
before(() => { process.env.SWARM_HOME = join(root, "home"); });
after(() => {
  if (saved === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

const report = (fields: Partial<ProviderUsageReport>): ProviderUsageReport => ({
  providerId: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", purpose: "main_coding_loop",
  cacheMode: "prefix-structured", promptCacheKey: "key", promptCacheScope: "scope", cacheablePrefixTokensEstimate: 3000, durationMs: 10,
  ...fields
});

test("each model call the runtime records counts once, with its tokens as the provider billed them", async () => {
  const { SwarmRuntime } = await import("../runtime/runtime.js");
  const databasePath = join(root, "runtime.db");
  const runtime = new SwarmRuntime({ databasePath, workspace: root });
  try {
    // A DeepSeek call: its prompt count includes the cache hits; a cache miss also writes a diagnostic count row.
    runtime.events.emitEvent({ type: "provider_usage", usage: report({
      sessionId: "session-1", inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cachedInputTokens: 900, providerReportedMissInputTokens: 300,
      totalInputWithCacheTokens: 1200, uncachedInputTokens: 300, cacheHitRate: 0.75,
      promptCacheDiagnostics: { scope: "scope", status: "cache_miss", changed: [], current: {} as never, minimumCacheableTokens: 1024 }
    }) });
    // An Anthropic call: input_tokens leaves out the cache reads and writes.
    runtime.events.emitEvent({ type: "provider_usage", usage: report({
      sessionId: "session-1", providerId: "anthropic", protocol: "anthropic-messages", model: "claude-haiku-4-5",
      inputTokens: 100, outputTokens: 20, cachedInputTokens: 800, cacheCreationInputTokens: 50, totalInputWithCacheTokens: 950, uncachedInputTokens: 150
    }) });
    const raw = runtime.usageStore.summarize("session-1");
    assert.equal(raw["llm_call.count"], 3, "the raw counters count the diagnostic as a call");
    assert.ok(raw["llm_call.tokens"]! > 3 * (1234 + 970), "and add up overlapping token rows");

    const entries = readLedger(runtime.database.db, "mac", { sessionId: "session-1" });
    assert.deepEqual(entries.map(({ provider, model, input, cached, cacheWrite, output, source, device }) => ({ provider, model, input, cached, cacheWrite, output, source, device })), [
      { provider: "deepseek", model: "deepseek-v4-flash", input: 1200, cached: 900, cacheWrite: 0, output: 34, source: "session", device: "mac" },
      { provider: "anthropic", model: "claude-haiku-4-5", input: 950, cached: 800, cacheWrite: 50, output: 20, source: "session", device: "mac" }
    ]);
    const total = totalOf(priceLedger(entries, DEFAULT_PRICES));
    assert.equal(total.calls, 2);
    assert.equal(total.input + total.output, 1200 + 34 + 950 + 20);
  } finally {
    runtime.dispose();
  }
});

test("rows written before the total input was recorded read the same, and other rows are left out", () => {
  const path = join(root, "old.db");
  const database = new SwarmDatabase(path);
  const store = new UsageStore(database);
  // The first runtime's rows: no total with cache, no uncached row, and the same token rows beside each count row.
  const old = (usage: Record<string, unknown>, at: string) => {
    store.append({ session_id: "old", kind: "llm_call", amount: 1, unit: "count", metadata: usage, created_at: at });
    for (const [name, amount] of [["input", usage.inputTokens], ["output", usage.outputTokens], ["cached_input", usage.cachedInputTokens],
      ["cache_creation_input", usage.cacheCreationInputTokens], ["cacheable_prefix_estimate", 4000]] as const) {
      if (typeof amount === "number" && amount > 0) store.append({ session_id: "old", kind: "llm_call", amount, unit: "tokens", metadata: { ...usage, token_type: name } });
    }
  };
  old({ providerId: "anthropic", protocol: "anthropic-messages", model: "claude-sonnet-4-5", purpose: "main_coding_loop", sessionId: "old",
    inputTokens: 100, outputTokens: 40, cachedInputTokens: 800, cacheCreationInputTokens: 50 }, "2026-05-09T10:00:00.000Z");
  old({ providerId: "openai", protocol: "openai-responses", model: "gpt-5.4", purpose: "chat", sessionId: "old", inputTokens: 500, outputTokens: 10, cachedInputTokens: 100 },
    "2026-05-09T10:01:00.000Z");
  store.append({ session_id: "old", kind: "llm_call", amount: 1, unit: "count",
    metadata: { providerId: "openai", model: "gpt-5.4", purpose: "chat", event: "prompt_cache_diagnostic", diagnostic_status: "changed" } });
  store.append({ session_id: "old", kind: "tool_call", amount: 1, unit: "count", metadata: { action: "file.read" } });
  database.close();

  const entries = readLedgerAt(path, "mac");
  assert.deepEqual(entries.map(({ model, input, cached, cacheWrite, output }) => ({ model, input, cached, cacheWrite, output })), [
    { model: "claude-sonnet-4-5", input: 950, cached: 800, cacheWrite: 50, output: 40 },
    { model: "gpt-5.4", input: 500, cached: 100, cacheWrite: 0, output: 10 }
  ]);
  assert.deepEqual(readLedgerAt(join(root, "missing.db"), "mac"), [], "a device without a database has no calls");
});

test("harness turns, the host's own calls and ticket workers' calls are told apart", () => {
  const event = (metadata: Record<string, unknown>, session?: string) => ({
    event_id: `usage_${Math.random()}`, session_id: session, kind: "llm_call" as const, amount: 1, unit: "count" as const, metadata, created_at: "2026-11-07T08:00:00.000Z"
  });
  const harness = ledgerEntry(event({ providerId: "harness:claude", protocol: "anthropic-messages", model: "claude-opus-5-5[1m]", purpose: "superagent_worker",
    sessionId: "worker-t1", ticketId: "t1", harness: "claude", event: "harness_turn", inputTokens: 10, cachedInputTokens: 4000, cacheCreationInputTokens: 350,
    outputTokens: 120, totalInputWithCacheTokens: 4360, reportedCostUsd: 0.42 }, "worker-t1"), "ovh")!;
  assert.equal(harness.source, "harness");
  assert.equal(harness.harness, "claude");
  assert.equal(harness.ticketId, "t1");
  assert.equal(harness.input, 4360);
  assert.deepEqual(priceLedger([harness], DEFAULT_PRICES)[0]!.cost, { amount: 0.42, currency: "USD", reported: true }, "the harness's own cost");

  const route = ledgerEntry(event({ ...report({ purpose: "superagent_route", inputTokens: 900, outputTokens: 60 }) }), "mac")!;
  assert.equal(route.source, "assessor");
  const worker = ledgerEntry(event({ ...report({ sessionId: "worker-abc12345", inputTokens: 10, outputTokens: 1 }) }, "worker-abc12345"), "mac")!;
  assert.deepEqual([worker.source, worker.ticketId], ["ticket", "abc12345"]);
  assert.equal(ledgerEntry(event({ ...report({}), token_type: "input" }), "mac"), undefined);

  const totals = groupLedger(priceLedger([harness, route, worker], DEFAULT_PRICES), "source");
  assert.deepEqual(totals.map((total) => [total.key, total.calls]), [["harness", 1], ["assessor", 1], ["ticket", 1]]);
});
