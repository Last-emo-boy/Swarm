/**
 * What a model call costs: the price of its model per million tokens, from the defaults below or the settings'
 * `usage.prices`, applied to the call's input, cached input, cache writes and output. A model with no price stays unpriced;
 * a harness turn that reports its own cost (Claude Code does) keeps that cost.
 */
import type { ModelPrice } from "../config/settings.js";

/**
 * Prices of the models Swarm ships or names whose providers' pricing pages confirm them, as read on 2026-11-07. A model
 * missing here is unpriced until `usage.prices` gives it a price, which also replaces any of these.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  // https://api-docs.deepseek.com/quick_start/pricing (2026-11-07): the off-peak rates; peak hours, 01:00-04:00 and
  // 06:00-10:00 UTC Monday to Friday, cost twice as much (the page's exception for Chinese public holidays is not modelled).
  // deepseek-v4-flash and deepseek-v4-flash-vision-exp are retired names that Flash now serves at the Flash price.
  ...Object.fromEntries(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].map((model) => [`deepseek/${model}`,
    { input: 0.15, cachedInput: 0.003, output: 0.6, currency: "USD", peak: { hoursUtc: [[1, 4], [6, 10]], factor: 2 } } satisfies ModelPrice])),
  "deepseek/deepseek-v4-pro": { input: 0.66, cachedInput: 0.022, output: 1.98, currency: "USD", peak: { hoursUtc: [[1, 4], [6, 10]], factor: 2 } },
  // https://platform.kimi.ai/docs/pricing/chat (2026-11-07), the provider "moonshot" (api.moonshot.ai); a cache write
  // costs the 5-minute rate, the default TTL.
  "moonshot/kimi-k3.1-pro": { input: 2, cachedInput: 0.2, cacheWrite: 2, output: 10, currency: "USD" },
  "moonshot/kimi-k3.1-pro-highspeed": { input: 4, cachedInput: 0.2, cacheWrite: 4, output: 20, currency: "USD" },
  "moonshot/kimi-k3": { input: 3, cachedInput: 0.3, cacheWrite: 3, output: 15, currency: "USD" },
  "moonshot/kimi-k2.7-code": { input: 0.95, cachedInput: 0.19, output: 4, currency: "USD" },
  "moonshot/kimi-k2.7-code-highspeed": { input: 1.9, cachedInput: 0.38, output: 8, currency: "USD" },
  "moonshot/kimi-k2.6": { input: 0.95, cachedInput: 0.16, output: 4, currency: "USD" },
  // https://developers.openai.com/api/docs/pricing (2026-11-07), standard tier; a prompt over 272K tokens is long context.
  "openai/gpt-5.5": { input: 5, cachedInput: 0.5, output: 30, currency: "USD", long: { above: 272_000, input: 10, cachedInput: 1, output: 45 } },
  "openai/gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15, currency: "USD", long: { above: 272_000, input: 5, cachedInput: 0.5, output: 22.5 } },
  "openai/gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5, currency: "USD" },
  // https://platform.claude.com/docs/en/about-claude/pricing (2026-11-07); a cache write costs the 5-minute rate, Swarm's
  // default (SWARM_PROMPT_CACHE_TTL=1h writes cost more).
  "anthropic/claude-sonnet-4-5": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15, currency: "USD" },
  "anthropic/claude-haiku-4-5": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5, currency: "USD" },
  // https://aistudio.google.com/docs/pricing (2026-11-07), paid tier, text input; context-cache storage per hour is not counted.
  "gemini/gemini-2.5-pro": { input: 1.25, cachedInput: 0.125, output: 10, currency: "USD", long: { above: 200_000, input: 2.5, cachedInput: 0.25, output: 15 } },
  "gemini/gemini-2.5-flash": { input: 0.3, cachedInput: 0.03, output: 2.5, currency: "USD" }
};

/** The tokens of one call that set its price. `input` counts every input token, cached and cache-written ones included. */
export interface CallTokens { input: number; cached: number; cacheWrite: number; output: number }

export const mergedPrices = (overrides: Readonly<Record<string, ModelPrice>> = {}): Record<string, ModelPrice> => ({ ...DEFAULT_PRICES, ...overrides });

/** The price of `model` on `provider`: its own entry, else its provider's `<provider>/*` entry. */
export function priceOf(prices: Readonly<Record<string, ModelPrice>>, provider: string, model: string): ModelPrice | undefined {
  return prices[`${provider}/${model}`] ?? prices[`${provider}/*`];
}

/** What a call made at `at` costs at `price`, in the price's currency. */
export function callCost(price: ModelPrice, tokens: CallTokens, at: Date): number {
  const rates = price.long && tokens.input > price.long.above ? price.long : price;
  const cached = Math.min(tokens.cached, tokens.input);
  const written = Math.min(tokens.cacheWrite, tokens.input - cached);
  const fresh = tokens.input - cached - written;
  const cost = fresh * rates.input + cached * (rates.cachedInput ?? rates.input) + written * (rates.cacheWrite ?? rates.input)
    + tokens.output * rates.output;
  return (cost / 1_000_000) * (inPeak(price, at) ? price.peak!.factor : 1);
}

function inPeak(price: ModelPrice, at: Date): boolean {
  if (!price.peak) return false;
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return price.peak.hoursUtc.some(([start, end]) => hour >= start && hour < end);
}
