/**
 * Budgets: daily and monthly caps per provider and per harness (settings `usage.budgets`), in money for priced calls or in
 * tokens. Once a cap is reached, new model calls on that provider and new turns of that harness stop with a message that
 * names the cap and the setting that raises it; the calls already made are what the ledger says they cost.
 */
import type { DatabaseSync } from "node:sqlite";
import { getSwarmPaths, loadSwarmSettings, type BudgetCap, type SwarmSettings } from "../config/settings.js";
import { entryCost, openUsageDatabase, readLedger, type LedgerEntry } from "./ledger.js";
import { mergedPrices } from "./prices.js";
import { formatMoney, formatTokens } from "./report.js";

export type BudgetScope = { provider: string } | { harness: string };

export interface CapStatus {
  kind: "provider" | "harness";
  id: string;
  period: "daily" | "monthly";
  /** The cap's field in its provider's or harness's budget (see `capSetting`). */
  field: keyof Omit<BudgetCap, "currency">;
  limit: number;
  /** The cap's currency, or `tokens`. */
  unit: string;
  spent: number;
  /** Calls a money cap could not count: no price, or a price in another currency. */
  unpriced: number;
  reached: boolean;
}

/** A model call or harness turn refused because a budget is reached; its message says which and how to raise it. */
export class BudgetReached extends Error {
  override readonly name = "BudgetReached";
  constructor(readonly cap: CapStatus) {
    super(capMessage(cap));
  }
}

const startOfDay = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate());
const startOfMonth = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), 1);

/** Every cap in the settings, or only `scope`'s, against what its calls spent today and this month in `database`. */
export function budgetStatus(settings: SwarmSettings, database: DatabaseSync | undefined, options: { now?: Date; scope?: BudgetScope } = {}): CapStatus[] {
  const now = options.now ?? new Date();
  const prices = mergedPrices(settings.usage.prices);
  const statuses: CapStatus[] = [];
  const groups = [["provider", settings.usage.budgets.providers], ["harness", settings.usage.budgets.harnesses]] as const;
  for (const [kind, caps] of groups) {
    for (const [id, cap] of Object.entries(caps)) {
      const scope = options.scope;
      if (scope && ("provider" in scope ? kind !== "provider" || scope.provider !== id : kind !== "harness" || scope.harness !== id)) continue;
      const monthly = cap.monthly !== undefined || cap.monthlyTokens !== undefined;
      const entries = database ? readLedger(database, "", { since: monthly ? startOfMonth(now) : startOfDay(now), provider: kind === "provider" ? id : `harness:${id}` }) : [];
      for (const period of ["daily", "monthly"] as const) {
        const since = period === "daily" ? startOfDay(now) : startOfMonth(now);
        const within = entries.filter((entry) => new Date(entry.at) >= since);
        const money = cap[period];
        if (money !== undefined) {
          const currency = cap.currency ?? "USD";
          const costs = within.map((entry) => entryCost(entry, prices));
          const spent = costs.reduce((sum, cost) => sum + (cost?.currency === currency ? cost.amount : 0), 0);
          const unpriced = costs.filter((cost) => cost?.currency !== currency).length;
          statuses.push({ kind, id, period, field: period, limit: money, unit: currency, spent, unpriced, reached: spent >= money });
        }
        const tokens = cap[`${period}Tokens`];
        if (tokens !== undefined) {
          const spent = within.reduce((sum, entry: LedgerEntry) => sum + entry.input + entry.output, 0);
          statuses.push({ kind, id, period, field: `${period}Tokens`, limit: tokens, unit: "tokens", spent, unpriced: 0, reached: spent >= tokens });
        }
      }
    }
  }
  return statuses;
}

const amountText = (value: number, unit: string): string => unit === "tokens" ? `${formatTokens(value)} tokens` : formatMoney(value, unit);

/** The setting that holds a cap, such as `usage.budgets.providers.deepseek.daily`. */
export const capSetting = (cap: Pick<CapStatus, "kind" | "id" | "field">): string =>
  `usage.budgets.${cap.kind === "provider" ? "providers" : "harnesses"}.${cap.id}.${cap.field}`;

/** What a reached cap tells the caller: which cap, how much went, until when calls stop, and the setting that raises it. */
export function capMessage(cap: CapStatus): string {
  const today = cap.period === "daily";
  const what = cap.kind === "provider" ? `calls on ${cap.id}` : `${cap.id} turns`;
  return `The ${cap.period} budget for ${cap.kind} ${cap.id} is reached: ${amountText(cap.spent, cap.unit)} ${cap.unit === "tokens" ? "used" : "spent"} `
    + `of ${amountText(cap.limit, cap.unit)} ${today ? "today" : "this month"}. New ${what} stop until it resets ${today ? "at midnight" : "on the 1st"}; `
    + `to raise it, set ${capSetting(cap)} in ${getSwarmPaths().settingsPath}.`;
}

/** The first reached cap for `scope` under the settings of `workspace`, read afresh so a raised cap applies at once. */
export function reachedCap(scope: BudgetScope, workspace = process.cwd(), now = new Date()): CapStatus | undefined {
  const settings = loadSwarmSettings(workspace);
  const caps = "provider" in scope ? settings.usage.budgets.providers[scope.provider] : settings.usage.budgets.harnesses[scope.harness];
  if (!caps) return undefined;
  const database = openUsageDatabase(settings.runtime.databasePath);
  try {
    return budgetStatus(settings, database, { now, scope }).find((status) => status.reached);
  } finally {
    database?.close();
  }
}

/** Throws `BudgetReached` when a cap for `scope` is reached. */
export function assertBudget(scope: BudgetScope, workspace = process.cwd()): void {
  const cap = reachedCap(scope, workspace);
  if (cap) throw new BudgetReached(cap);
}
