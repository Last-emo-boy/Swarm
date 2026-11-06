/** How the ledger reads as text: token counts, money, a table of totals, and the budgets' state. */
import type { CapStatus } from "./budget.js";
import type { LedgerTotal } from "./ledger.js";

export function formatTokens(value: number): string {
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value < size) continue;
    const scaled = value / size;
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${unit}`;
  }
  return String(Math.round(value));
}

/** Money in its currency: dollars as `$1.23`, others as `1.23 CNY`; amounts under one keep four decimals. */
export function formatMoney(amount: number, currency: string): string {
  const value = amount.toFixed(amount >= 1 || amount === 0 ? 2 : 4);
  return currency === "USD" ? `$${value}` : `${value} ${currency}`;
}

/** A total's cost: its money by currency, and its calls without a price. */
export function costText(total: Pick<LedgerTotal, "cost" | "unpriced" | "calls">): string {
  const money = Object.entries(total.cost).map(([currency, amount]) => formatMoney(amount, currency));
  if (!money.length) return total.calls ? "unpriced" : formatMoney(0, "USD");
  return total.unpriced ? `${money.join(" + ")} + ${total.unpriced} unpriced` : money.join(" + ");
}

/** Totals as an aligned table under a header naming what they are grouped by, with the overall total last. */
export function usageTable(groups: readonly LedgerTotal[], total: LedgerTotal, by: string): string[] {
  const rows = [[by, "calls", "input", "cached", "output", "cost"],
    ...[...groups, total].map((item) => [item.key, String(item.calls), formatTokens(item.input), formatTokens(item.cached), formatTokens(item.output), costText(item)])];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => `  ${row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)).join("  ")}`.trimEnd());
}

/** One line per cap: what was spent of it, and whether it is reached. */
export function budgetLines(statuses: readonly CapStatus[]): string[] {
  return statuses.map((cap) => {
    const amount = (value: number) => cap.unit === "tokens" ? `${formatTokens(value)} tokens` : formatMoney(value, cap.unit);
    const unpriced = cap.unpriced ? ` (${cap.unpriced} unpriced call${cap.unpriced === 1 ? "" : "s"} not counted)` : "";
    return `  ${cap.kind} ${cap.id}, ${cap.period}: ${amount(cap.spent)} of ${amount(cap.limit)}${cap.reached ? " — reached" : ""}${unpriced}`;
  });
}
