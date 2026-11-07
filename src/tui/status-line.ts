/**
 * The status line under the prompt: only what needs attention or tells where things stand, most urgent first, and the
 * key that lists everything else. Model, permissions, gateway, cache, LSP and the like live in /status.
 */

export type StatusItemId = "search" | "budget" | "approvals" | "tickets" | "usage";
export type StatusItemTone = "accent" | "danger" | "warning" | "muted";
export type StatusItem = { id: StatusItemId; text: string; tone: StatusItemTone };

export function buildStatusLine(input: {
  /** Transcript search while it is open: its query and where in its matches it is, such as "1/3". */
  search?: { query: string; position?: string };
  /** Budgets that are reached, such as "deepseek daily budget reached". */
  budgetsReached?: readonly string[];
  /** Approvals other sessions wait for; this session's own shows as the approval card. */
  approvalsWaiting?: number;
  tickets?: { needYou: number; working: number };
  /** What this device spent today, such as "$0.13". */
  spentToday?: string;
  promptEmpty: boolean;
}): { items: StatusItem[]; hint: string } {
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const items: StatusItem[] = [];
  if (input.search) {
    const query = input.search.query ? ` "${input.search.query}"` : "";
    items.push({ id: "search", text: `search${query}${input.search.position ? ` ${input.search.position}` : ""}`, tone: "accent" });
  }
  for (const budget of input.budgetsReached ?? []) {
    items.push({ id: "budget", text: budget, tone: "danger" });
  }
  if (input.approvalsWaiting && input.approvalsWaiting > 0) {
    items.push({ id: "approvals", text: `${plural(input.approvalsWaiting, "approval", "approvals")} waiting`, tone: "warning" });
  }
  if (input.tickets?.needYou) {
    items.push({ id: "tickets", text: `${plural(input.tickets.needYou, "ticket needs", "tickets need")} you`, tone: "warning" });
  } else if (input.tickets?.working) {
    items.push({ id: "tickets", text: `${plural(input.tickets.working, "ticket", "tickets")} working`, tone: "muted" });
  }
  if (input.spentToday) {
    items.push({ id: "usage", text: `${input.spentToday} today`, tone: "muted" });
  }
  const hint = input.search ? "Enter jump · Esc close" : input.promptEmpty ? "? keys" : "";
  return { items, hint };
}
