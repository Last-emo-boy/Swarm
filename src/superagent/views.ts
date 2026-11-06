/**
 * Ticket and host views shared by the CLI and the TUI: one row per ticket with the stage it waits in (docs/003 of
 * dsh-superagent: whom the ticket waits for and what it needs), and the list of what needs a person, first.
 */
import { latestReport, ticketOutcome, ticketStage, type Ticket } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import type { Health } from "./health.js";
import { pulledBy, workerNode } from "./placement.js";
import { pullOf } from "./sources/github-pull.js";

export type TicketGroup = "person" | "working" | "queued" | "idle" | "ended";
export interface TicketRow {
  id: string;
  /** A short handle for commands: the first eight characters of the id, after `<device>:` for another node's ticket. */
  short: string;
  /** The paired node that owns the ticket; unset for this node's own. */
  device?: string;
  title: string;
  group: TicketGroup;
  /** Whom the ticket waits for and what it needs, such as "Awaiting review". */
  label: string;
  source: string;
  url?: string;
  pr?: number;
  question?: string;
  summary?: string;
  /** The paired node its worker runs on, ran on last, or is placed on to start; unset when that is the node that owns it. */
  runsOn?: string;
  /** The paired node that pulled its latest Assignment while it waited for a worker here. */
  pulledBy?: string;
  updatedAt: string;
}

const STAGE_LABELS: Record<string, string> = {
  "person/delivery": "Input undelivered",
  "person/answer": "Awaiting answer",
  "person/review": "Awaiting review",
  "person/blocked": "Blocked",
  "person/failed": "Failed",
  "working/queued": "Queued",
  idle: "Waiting for a Trigger",
  working: "Working"
};
const OUTCOME_LABELS: Record<string, string> = {
  completed: "Completed",
  merged: "Pull request merged",
  closed: "Pull request closed",
  dropped: "Nothing to do",
  stopped: "Stopped by a person"
};

export function ticketRow(client: SuperagentClient, ticket: Ticket): TicketRow {
  const origin = client.store.triggers.get(ticket.origin.triggerId);
  const stage = ticketStage(ticket);
  const action = "action" in stage ? stage.action : undefined;
  const key = stage.stage === "ended" ? "" : action ? `${stage.stage}/${action}` : stage.stage;
  const outcome = ticket.ended ? ticketOutcome(ticket) ?? ticket.ended.outcome : undefined;
  const group: TicketGroup = stage.stage === "ended" ? "ended" : stage.stage === "person" ? "person"
    : stage.stage === "idle" ? "idle" : action === "queued" ? "queued" : "working";
  const pr = pullOf(ticket);
  const report = latestReport(ticket);
  const node = workerNode(client, ticket);
  const puller = pulledBy(client, ticket);
  const runsOn = { ...(node ? { runsOn: node } : {}), ...(puller ? { pulledBy: puller } : {}) };
  // A question the person already answered waits for the worker, not for the person: it leaves "needs you".
  const answered = !!ticket.attention && !ticket.ended && ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context
    && input.at >= (report?.at ?? ""));
  if (answered && group === "person" && STAGE_LABELS[key] === "Awaiting answer") {
    return { id: ticket.id, short: ticket.id.slice(0, 8), title: ticket.title, group: "working", label: "Working on your answer",
      source: origin?.source ?? "unknown", ...(origin?.url ? { url: origin.url } : {}), ...(pr ? { pr } : {}),
      ...(report?.summary ? { summary: report.summary } : {}), ...runsOn, updatedAt: ticket.updatedAt ?? ticket.createdAt };
  }
  return {
    id: ticket.id,
    short: ticket.id.slice(0, 8),
    title: ticket.title,
    group,
    label: outcome ? OUTCOME_LABELS[outcome] ?? outcome : STAGE_LABELS[key] ?? key,
    source: origin?.source ?? "unknown",
    ...(origin?.url ? { url: origin.url } : {}),
    ...(pr ? { pr } : {}),
    ...(ticket.attention ? { question: ticket.attention.question } : {}),
    ...(report?.summary ? { summary: report.summary } : {}),
    ...runsOn,
    updatedAt: ticket.updatedAt ?? ticket.createdAt
  };
}

const ORDER: Record<TicketGroup, number> = { person: 0, working: 1, queued: 2, idle: 3, ended: 4 };
/** Every ticket as a row, what waits for a person first, then working, queued, idle and ended, newest first within each. */
export function ticketRows(client: SuperagentClient, options: { ended?: boolean; limit?: number } = {}): TicketRow[] {
  const rows = client.store.tickets.list().map((ticket) => ticketRow(client, ticket))
    .filter((row) => options.ended || row.group !== "ended");
  return rows.sort((a, b) => ORDER[a.group] - ORDER[b.group] || b.updatedAt.localeCompare(a.updatedAt)).slice(0, options.limit ?? 200);
}

/** Finds a ticket by its id or the start of it. */
export function findTicket(client: SuperagentClient, handle: string): Ticket | undefined {
  const exact = client.store.tickets.get(handle);
  if (exact) return exact;
  const matches = client.store.tickets.list().filter((ticket) => ticket.id.startsWith(handle));
  if (matches.length > 1) throw new Error(`${handle} names ${matches.length} tickets; give more of the id`);
  return matches[0];
}

export interface HostStatus {
  running: boolean;
  pid?: number;
  heartbeatAt?: string;
  health: Record<string, Health>;
  counts: Record<TicketGroup, number>;
}
/** Whether a host runs, as its heartbeat says, the health it last reported, and how many tickets wait in each group. */
export function hostStatus(client: SuperagentClient, now = Date.now()): HostStatus {
  const owner = client.store.get(KV.host.owner);
  const health = client.store.get(KV.host.health);
  const running = !!owner && now - Date.parse(owner.heartbeatAt) < 15_000;
  const counts: Record<TicketGroup, number> = { person: 0, working: 0, queued: 0, idle: 0, ended: 0 };
  for (const ticket of client.store.tickets.open()) counts[ticketRow(client, ticket).group] += 1;
  return { running, ...(owner ? { pid: owner.pid, heartbeatAt: owner.heartbeatAt } : {}), health: health?.entries ?? {}, counts };
}

/** Replies the host posted to a local Thread, oldest first, which the TUI shows as the ticket's messages. */
export function localReplies(client: SuperagentClient, limit = 50): { id: string; ticketId?: string; kind: string; text: string; status: string }[] {
  return client.store.db.prepare("SELECT value FROM outbox WHERE value ->> '$.channel.source' = 'local' ORDER BY rowid DESC LIMIT ?")
    .all(limit).map((row) => JSON.parse(String(row.value)) as { id: string; ticketId?: string; kind: string; text: string; status: string }).reverse();
}
