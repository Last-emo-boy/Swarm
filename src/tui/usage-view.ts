/**
 * `/usage` and `/budget` in the TUI, and the notice of a reached budget above the prompt: a session's model calls as the
 * ledger counts them (each once), this device's calls today, and the budgets' state.
 */
import type { DatabaseSync } from "node:sqlite";
import { getSwarmPaths, type SwarmSettings } from "../config/settings.js";
import { budgetStatus, capSetting, type CapStatus } from "../usage/budget.js";
import { groupLedger, priceLedger, readLedger, totalOf, type LedgerTotal } from "../usage/ledger.js";
import { mergedPrices } from "../usage/prices.js";
import { budgetLines, costText, formatMoney, formatTokens, usageTable } from "../usage/report.js";

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

/** One short line per reached cap: which, how much went, and the setting that raises it. */
export function reachedBudgetNotices(settings: SwarmSettings, database: DatabaseSync | undefined, now = new Date()): string[] {
  const caps = Object.keys(settings.usage.budgets.providers).length + Object.keys(settings.usage.budgets.harnesses).length;
  if (!caps || !database) return [];
  const amount = (cap: CapStatus, value: number) => cap.unit === "tokens" ? `${formatTokens(value)} tokens` : formatMoney(value, cap.unit);
  return budgetStatus(settings, database, { now }).filter((cap) => cap.reached).map((cap) =>
    `${cap.kind} ${cap.id}: ${cap.period} budget reached (${amount(cap, cap.spent)} of ${amount(cap, cap.limit)}), new ${cap.kind === "provider" ? "calls" : "turns"} stop · raise ${capSetting(cap)}`);
}
