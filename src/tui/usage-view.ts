/**
 * `/usage` and `/budget` in the TUI, and what the status line says about usage: a session's model calls as the
 * ledger counts them (each once), this device's calls today, and the budgets' state.
 */
import type { DatabaseSync } from "node:sqlite";
import { getSwarmPaths, type SwarmSettings } from "../config/settings.js";
import { budgetStatus } from "../usage/budget.js";
import { groupLedger, priceLedger, readLedger, totalOf, type LedgerTotal } from "../usage/ledger.js";
import { mergedPrices } from "../usage/prices.js";
import { budgetLines, costText, formatTokens, usageTable } from "../usage/report.js";

const startOfDay = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate());
const totalLine = (total: LedgerTotal): string =>
  `${total.calls} call${total.calls === 1 ? "" : "s"} · ${formatTokens(total.input)} in (${formatTokens(total.cached)} cached) · ${formatTokens(total.output)} out · ${costText(total)}`;

export function usageView(input: { database: DatabaseSync; settings: SwarmSettings; sessionId?: string; policyBudget?: string; now?: Date }): { brief: string; detail: string } {
  const now = input.now ?? new Date();
  const prices = mergedPrices(input.settings.usage.prices);
  const session = input.sessionId ? priceLedger(readLedger(input.database, "this device", { sessionId: input.sessionId }), prices) : [];
  const today = priceLedger(readLedger(input.database, "this device", { since: startOfDay(now) }), prices);
  const budgets = budgetStatus(input.settings, input.database, { now });
  const lines: string[] = [];
  if (input.sessionId) {
    lines.push(input.sessionId, "", "Model calls in this session, each counted once",
      ...(session.length ? usageTable(groupLedger(session, "model"), totalOf(session), "model") : ["  None recorded."]), "");
  }
  lines.push("This device today", ...(today.length ? usageTable(groupLedger(today, "provider"), totalOf(today), "provider") : ["  None recorded."]), "");
  lines.push(budgets.length ? "Budgets" : `Budgets: none set (usage.budgets in ${getSwarmPaths().settingsPath})`, ...budgetLines(budgets));
  if (input.policyBudget !== undefined) lines.push("", "Policy budget", input.policyBudget);
  const reached = budgets.filter((cap) => cap.reached).length;
  const brief = `${input.sessionId ? `${input.sessionId} usage` : "Usage today"}: ${totalLine(totalOf(input.sessionId ? session : today))}`
    + (reached ? ` · ${reached} budget${reached === 1 ? "" : "s"} reached` : "");
  return { brief, detail: lines.join("\n") };
}

/**
 * What the status line says about usage: each reached budget in a few words (`/usage` names the setting that raises it),
 * and what this device spent today, or how many calls it made when they have no price.
 */
export function usageStatus(settings: SwarmSettings, database: DatabaseSync | undefined, now = new Date()): { budgetsReached: string[]; spentToday?: string } {
  if (!database) return { budgetsReached: [] };
  const caps = Object.keys(settings.usage.budgets.providers).length + Object.keys(settings.usage.budgets.harnesses).length;
  const budgetsReached = caps
    ? budgetStatus(settings, database, { now }).filter((cap) => cap.reached).map((cap) => `${cap.id} ${cap.period} budget reached`)
    : [];
  const today = totalOf(priceLedger(readLedger(database, "this device", { since: startOfDay(now) }), mergedPrices(settings.usage.prices)));
  if (!today.calls) return { budgetsReached };
  const spentToday = Object.keys(today.cost).length ? costText(today) : `${today.calls} call${today.calls === 1 ? "" : "s"}`;
  return { budgetsReached, spentToday };
}
