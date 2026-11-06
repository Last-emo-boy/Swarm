import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSwarmSettings, type ModelPrice } from "../config/settings.js";
import { callCost, DEFAULT_PRICES, mergedPrices, priceOf } from "./prices.js";

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-12, message ?? `${actual} is not ${expected}`);
// A Sunday, and a Wednesday at 02:30 UTC, inside DeepSeek's peak hours.
const sunday = new Date("2026-11-08T02:30:00.000Z");
const peak = new Date("2026-11-04T02:30:00.000Z");

test("a call costs its uncached input, cache reads, cache writes and output at their rates", () => {
  const price: ModelPrice = { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15, currency: "USD" };
  // 1M input of which 600K were cache hits and 100K were written to the cache, and 200K output.
  close(callCost(price, { input: 1_000_000, cached: 600_000, cacheWrite: 100_000, output: 200_000 }, sunday), 0.3 * 3 + 0.6 * 0.3 + 0.1 * 3.75 + 0.2 * 15);
  // Without cache rates, cached and written tokens cost the input rate.
  close(callCost({ input: 2, output: 8, currency: "USD" }, { input: 500_000, cached: 500_000, cacheWrite: 0, output: 0 }, sunday), 1);
});

test("long prompts use the long-context rates and peak hours cost the factor", () => {
  const gpt = DEFAULT_PRICES["openai/gpt-5.5"]!;
  close(callCost(gpt, { input: 272_000, cached: 0, cacheWrite: 0, output: 0 }, sunday), 0.272 * 5);
  close(callCost(gpt, { input: 300_000, cached: 100_000, cacheWrite: 0, output: 10_000 }, sunday), 0.2 * 10 + 0.1 * 1 + 0.01 * 45);
  const flash = DEFAULT_PRICES["deepseek/deepseek-v4-flash"]!;
  const tokens = { input: 1_000_000, cached: 800_000, cacheWrite: 0, output: 100_000 };
  const offPeak = 0.2 * 0.15 + 0.8 * 0.003 + 0.1 * 0.6;
  close(callCost(flash, tokens, sunday), offPeak);
  close(callCost(flash, tokens, peak), offPeak * 2);
  close(callCost(flash, tokens, new Date("2026-11-04T04:00:00.000Z")), offPeak, "04:00 is between the peaks");
});

test("a model's own price comes before its provider's wildcard, and settings replace or add prices", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-usage-prices-"));
  const saved = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ usage: {
      prices: {
        "deepseek/deepseek-v4-flash": { input: 0.3, cachedInput: 0.006, output: 1.2 },
        "ollama/*": { input: 0, output: 0 },
        "dashscope/qwen-plus": { input: 0.8, output: 2, currency: "cny", peak: { hoursUtc: [[25, 1]], factor: 2 } },
        "broken/model": { input: -1, output: 2 },
        "nokey": { input: 1, output: 1 }
      },
      budgets: { providers: { deepseek: { daily: 2, monthly: 30 }, ollama: { dailyTokens: 5_000_000 }, empty: {} }, harnesses: { claude: { monthly: 100, currency: "usd" } } }
    } }));
    const settings = loadSwarmSettings(home);
    const prices = mergedPrices(settings.usage.prices);
    assert.deepEqual(priceOf(prices, "deepseek", "deepseek-v4-flash"), { input: 0.3, cachedInput: 0.006, output: 1.2, currency: "USD" }, "the setting replaces the default");
    assert.equal(priceOf(prices, "deepseek", "deepseek-v4-pro"), DEFAULT_PRICES["deepseek/deepseek-v4-pro"], "the other defaults stay");
    assert.deepEqual(priceOf(prices, "ollama", "llama3"), { input: 0, output: 0, currency: "USD" });
    assert.deepEqual(priceOf(prices, "dashscope", "qwen-plus"), { input: 0.8, output: 2, currency: "CNY" }, "an invalid peak is left out");
    assert.equal(priceOf(prices, "broken", "model"), undefined, "a negative price is left out rather than guessed");
    assert.equal(priceOf(prices, "xai", "grok-4"), undefined, "a model no pricing page confirmed stays unpriced");
    assert.deepEqual(settings.usage.budgets, {
      providers: { deepseek: { daily: 2, monthly: 30, currency: "USD" }, ollama: { dailyTokens: 5_000_000 } },
      harnesses: { claude: { monthly: 100, currency: "USD" } }
    });
  } finally {
    if (saved === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
