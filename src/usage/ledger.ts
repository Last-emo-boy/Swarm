/**
 * The usage ledger: one entry per model call or harness turn, read from `usage_events`. Each call wrote one `llm_call`
 * count row whose metadata is its whole usage report, beside token rows that overlap (input, cached, uncached, total with
 * cache, a prefix estimate...), so summing token rows counts a call's tokens several times. The ledger reads the count rows
 * only and takes the tokens from their metadata, in one shape for every protocol: `input` is every input token, cached and
 * cache-written ones included, whatever the provider reported them as.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ModelPrice } from "../config/settings.js";
import type { UsageEvent } from "../storage/usage-store.js";
import { callCost, priceOf } from "./prices.js";

export type LedgerSource = "session" | "ticket" | "assessor" | "harness";

export interface LedgerEntry {
  id: string;
  at: string;
  device: string;
  source: LedgerSource;
  provider: string;
  model: string;
  purpose: string;
  harness?: string;
  sessionId?: string;
  ticketId?: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  /** The cost the harness reported for its turn, in USD. */
  reportedCost?: number;
}

export interface Cost { amount: number; currency: string; reported?: boolean }
export type PricedEntry = LedgerEntry & { cost?: Cost };

export interface LedgerFilter {
  since?: Date;
  sessionId?: string;
  /** The provider id the calls were recorded under; a harness's turns are under `harness:<id>`. */
  provider?: string;
}

const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** The ledger entry of a usage row: a model call's or harness turn's count row; undefined for every other row. */
export function ledgerEntry(event: UsageEvent, device: string): LedgerEntry | undefined {
  if (event.kind !== "llm_call" || event.unit !== "count") return undefined;
  const usage = event.metadata;
  // A prompt cache diagnostic repeats its call's count row; token rows carry a token_type.
  if ((usage.event !== undefined && usage.event !== "harness_turn") || usage.token_type !== undefined) return undefined;
  const reported = number(usage.inputTokens) ?? 0;
  const cached = number(usage.cachedInputTokens) ?? 0;
  const cacheWrite = number(usage.cacheCreationInputTokens) ?? 0;
  // Anthropic's input_tokens leaves out cache reads and writes; OpenAI-style and Gemini prompt counts include them. Rows
  // from before the total was recorded get it from the protocol the same way.
  const input = number(usage.totalInputWithCacheTokens)
    ?? (usage.protocol === "anthropic-messages" ? reported + cached + cacheWrite : reported);
  const sessionId = text(usage.sessionId) ?? event.session_id;
  const purpose = text(usage.purpose) ?? "unknown";
  const harness = text(usage.harness);
  const ticketId = text(usage.ticketId) ?? (sessionId?.startsWith("worker-") ? sessionId.slice("worker-".length) : undefined);
  const source: LedgerSource = usage.event === "harness_turn" ? "harness"
    : purpose.startsWith("superagent_") ? "assessor"
      : ticketId ? "ticket" : "session";
  const reportedCost = number(usage.reportedCostUsd);
  return {
    id: event.event_id, at: event.created_at, device, source,
    provider: text(usage.providerId) ?? "unknown", model: text(usage.model) ?? "unknown", purpose,
    ...(harness ? { harness } : {}), ...(sessionId ? { sessionId } : {}), ...(ticketId ? { ticketId } : {}),
    input: Math.max(input, cached + cacheWrite), cached, cacheWrite, output: number(usage.outputTokens) ?? 0,
    ...(reportedCost === undefined ? {} : { reportedCost })
  };
}

/** Opens a usage database for reading only; undefined when there is none yet. */
export function openUsageDatabase(path: string): DatabaseSync | undefined {
  return existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : undefined;
}

/** The ledger of `database`, oldest first. */
export function readLedger(database: DatabaseSync, device: string, filter: LedgerFilter = {}): LedgerEntry[] {
  const where = ["kind = 'llm_call'", "unit = 'count'"];
  const values: string[] = [];
  if (filter.since) { where.push("created_at >= ?"); values.push(filter.since.toISOString()); }
  if (filter.sessionId) { where.push("session_id = ?"); values.push(filter.sessionId); }
  if (filter.provider) { where.push("json_extract(metadata_json, '$.providerId') = ?"); values.push(filter.provider); }
  const rows = database.prepare(`SELECT * FROM usage_events WHERE ${where.join(" AND ")} ORDER BY created_at, rowid`).all(...values) as
    Array<Omit<UsageEvent, "metadata"> & { metadata_json: string; session_id: string | null; task_id: string | null }>;
  return rows.flatMap((row) => {
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { return []; }
    const entry = ledgerEntry({ ...row, session_id: row.session_id ?? undefined, task_id: row.task_id ?? undefined, metadata }, device);
    return entry ? [entry] : [];
  });
}

/** The ledger of the database at `path`, read without writing to it; empty when it does not exist. */
export function readLedgerAt(path: string, device: string, filter: LedgerFilter = {}): LedgerEntry[] {
  const database = openUsageDatabase(path);
  if (!database) return [];
  try { return readLedger(database, device, filter); } finally { database.close(); }
}

/** What an entry cost: what its harness reported, else its model's price; undefined when it has neither. */
export function entryCost(entry: LedgerEntry, prices: Readonly<Record<string, ModelPrice>>): Cost | undefined {
  if (entry.reportedCost !== undefined) return { amount: entry.reportedCost, currency: "USD", reported: true };
  const price = priceOf(prices, entry.provider, entry.model);
  return price ? { amount: callCost(price, entry, new Date(entry.at)), currency: price.currency } : undefined;
}

export const priceLedger = (entries: readonly LedgerEntry[], prices: Readonly<Record<string, ModelPrice>>): PricedEntry[] =>
  entries.map((entry) => {
    const cost = entryCost(entry, prices);
    return cost ? { ...entry, cost } : { ...entry };
  });

export type LedgerGrouping = "model" | "provider" | "harness" | "device" | "ticket" | "day" | "source";
export const LEDGER_GROUPINGS: readonly LedgerGrouping[] = ["model", "provider", "harness", "device", "ticket", "day", "source"];

/** Calls added up: tokens, cost by currency, and how many calls had no price. */
export interface LedgerTotal { key: string; calls: number; input: number; cached: number; output: number; cost: Record<string, number>; unpriced: number }

const localDay = (at: string): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export function groupKey(entry: LedgerEntry, by: LedgerGrouping): string {
  if (by === "model") return `${entry.provider}/${entry.model}`;
  if (by === "provider") return entry.provider;
  if (by === "harness") return entry.harness ?? "-";
  if (by === "device") return entry.device;
  if (by === "ticket") return entry.ticketId?.slice(0, 8) ?? "-";
  if (by === "source") return entry.source;
  return localDay(entry.at);
}

export function totalOf(entries: readonly PricedEntry[], key = "total"): LedgerTotal {
  const total: LedgerTotal = { key, calls: 0, input: 0, cached: 0, output: 0, cost: {}, unpriced: 0 };
  for (const entry of entries) {
    total.calls += 1;
    total.input += entry.input;
    total.cached += entry.cached;
    total.output += entry.output;
    if (entry.cost) total.cost[entry.cost.currency] = (total.cost[entry.cost.currency] ?? 0) + entry.cost.amount;
    else total.unpriced += 1;
  }
  return total;
}

/** Totals by `by`, largest first: by cost, then by tokens; by day, in date order. */
export function groupLedger(entries: readonly PricedEntry[], by: LedgerGrouping): LedgerTotal[] {
  const groups = new Map<string, PricedEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry, by);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const totals = [...groups].map(([key, items]) => totalOf(items, key));
  const spent = (total: LedgerTotal) => Object.values(total.cost).reduce((sum, value) => sum + value, 0);
  return by === "day"
    ? totals.sort((a, b) => a.key.localeCompare(b.key))
    : totals.sort((a, b) => spent(b) - spent(a) || (b.input + b.output) - (a.input + a.output) || a.key.localeCompare(b.key));
}
