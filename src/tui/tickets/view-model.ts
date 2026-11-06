/**
 * What the TUI shows of superagent tickets: the "needs you" items above the prompt, the tickets pane grouped by what each
 * ticket waits for, and one ticket's detail. Pure functions over the ticket rows, so every state renders in tests.
 */
import type { HostStatus, TicketGroup, TicketRow } from "../../superagent/views.js";
import type { TuiColorRef } from "../theme.js";

export interface NeedsYouItem {
  id: string;
  short: string;
  /** `?` a question, `!` a result to review or an undelivered message, `×` a blocked or failed ticket. */
  marker: "?" | "!" | "×";
  tone: TuiColorRef;
  title: string;
  /** What the ticket needs, such as "Awaiting review · PR #31" or the question it asks. */
  need: string;
  /** The command that answers it. */
  action: string;
}

const markerFor = (row: TicketRow): NeedsYouItem["marker"] =>
  row.label === "Awaiting answer" ? "?" : row.label === "Blocked" || row.label === "Failed" ? "×" : "!";
const toneFor = (marker: NeedsYouItem["marker"]): TuiColorRef =>
  marker === "×" ? "status.danger" : marker === "?" ? "status.pending" : "status.warning";

/** The tickets that wait for a person, as the strip above the prompt lists them, newest first. */
export function needsYouItems(rows: readonly TicketRow[]): NeedsYouItem[] {
  return rows.filter((row) => row.group === "person").map((row) => {
    const marker = markerFor(row);
    const need = marker === "?" && row.question ? `asks: ${row.question}` : row.pr ? `${row.label.toLowerCase()} · PR #${row.pr}` : row.label.toLowerCase();
    const action = marker === "?" ? `/ticket say ${row.short} <answer>`
      : marker === "×" ? `/ticket retry ${row.short}`
        : `/ticket ${row.short}`;
    return { id: row.id, short: row.short, marker, tone: toneFor(marker), title: row.title, need, action };
  });
}

/** How many rows the strip takes: a heading and up to `limit` items, then "+N more"; none when nothing waits. */
export function needsYouRows(items: readonly NeedsYouItem[], limit = 3): number {
  if (!items.length) return 0;
  return 1 + Math.min(items.length, limit) + (items.length > limit ? 1 : 0);
}

/** The footer pill's value: who waits on whom, such as "1 need you · 2 working". */
export function ticketsPillValue(status: Pick<HostStatus, "counts" | "running"> | undefined): string {
  if (!status) return "off";
  const { person, working, queued } = status.counts;
  const parts = [person ? `${person} need you` : "", working ? `${working} working` : "", queued ? `${queued} queued` : ""].filter(Boolean);
  if (!parts.length) return status.running ? "idle" : "no host";
  return parts.join(" · ");
}

/** The footer pill's short value: the most urgent count only, so the pill fits beside the others. */
export function ticketsFooterValue(status: Pick<HostStatus, "counts" | "running">): string {
  const { person, working, queued } = status.counts;
  if (person) return `${person} need you`;
  if (working) return `${working} working`;
  if (queued) return `${queued} queued`;
  return status.running ? "idle" : "no host";
}

export const GROUP_TITLES: Record<TicketGroup, string> = {
  person: "Needs you",
  working: "Working",
  queued: "Queued",
  idle: "Waiting for a message",
  ended: "Ended"
};
const GROUP_ORDER: TicketGroup[] = ["person", "working", "queued", "idle", "ended"];

export type TicketsPaneLine =
  | { kind: "group"; text: string; group: TicketGroup }
  | { kind: "ticket"; row: TicketRow; selected: boolean; index: number }
  | { kind: "empty"; text: string };

/** The tickets pane: each group with its count, then its tickets; `selected` indexes the ticket rows in this order. */
export function ticketsPaneLines(rows: readonly TicketRow[], selected: number): TicketsPaneLine[] {
  if (!rows.length) return [{ kind: "empty", text: "No tickets. File one with /ticket <request>, or mention the agent on GitHub or Feishu." }];
  const lines: TicketsPaneLine[] = [];
  let index = 0;
  for (const group of GROUP_ORDER) {
    const members = rows.filter((row) => row.group === group);
    if (!members.length) continue;
    lines.push({ kind: "group", group, text: `${GROUP_TITLES[group]} (${members.length})` });
    for (const row of members) {
      lines.push({ kind: "ticket", row, selected: index === selected, index });
      index += 1;
    }
  }
  return lines;
}

/** The order in which the pane lists tickets, which its selection indexes. */
/** The exact handle of a row's ticket for commands: its whole id, after `<device>:` for a paired device's ticket. */
export const rowHandle = (row: TicketRow): string => row.device ? `${row.device}:${row.id}` : row.id;

export function paneOrder(rows: readonly TicketRow[]): TicketRow[] {
  return GROUP_ORDER.flatMap((group) => rows.filter((row) => row.group === group));
}

/** One ticket as the detail view shows it: what it waits for, its question, its latest report and the messages posted. */
export function ticketDetailText(row: TicketRow, messages: readonly { kind: string; text: string }[]): string {
  return [
    `${row.title}`,
    `${row.label} · ${row.source}${row.pr ? ` · PR #${row.pr}` : ""}${row.pulledBy ? ` · pulled by ${row.pulledBy}` : row.runsOn ? ` · worker on ${row.runsOn}` : ""} · ticket ${row.id}`,
    row.url ? row.url : undefined,
    row.question ? `\nQuestion: ${row.question}\nAnswer with: /ticket say ${row.short} <answer>` : undefined,
    row.summary ? `\nLatest report:\n${row.summary}` : undefined,
    messages.length ? `\nMessages:\n${messages.map((message) => `- [${message.kind}] ${message.text}`).join("\n")}` : undefined,
    `\nCommands: /ticket say ${row.short} <text> · /ticket stop ${row.short} · /ticket retry ${row.short}`
  ].filter((line) => line !== undefined).join("\n");
}
