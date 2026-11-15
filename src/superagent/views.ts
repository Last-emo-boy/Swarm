/**
 * Ticket and host views shared by the CLI and the TUI: one row per ticket with the stage it waits in (docs/003 of
 * dsh-superagent: whom the ticket waits for and what it needs), and the list of what needs a person, first.
 */
import { latestReport, ticketOutcome, ticketStage, type Decision, type Ticket, type Trigger } from "./core/index.js";
import { unroutedRequest, type SuperagentClient } from "./client.js";
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
  /** The agent harness profile its worker runs on; unset for Swarm's own coding loop. */
  harness?: string;
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
  const harness = ticket.execution?.harness;
  const runsOn = { ...(node ? { runsOn: node } : {}), ...(puller ? { pulledBy: puller } : {}), ...(harness ? { harness } : {}) };
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

/** Finds a stored message by its id or the start of it. */
export function findTrigger(client: SuperagentClient, handle: string): Trigger {
  const exact = client.store.triggers.get(handle);
  if (exact) return exact;
  const matches = client.store.read.triggersByPrefix(handle);
  if (matches.length > 1) throw new Error(`${handle} names several messages; give more of the id`);
  if (!matches[0]) throw new Error(`No message ${handle}`);
  return matches[0];
}

/** How many of the newest unavailable Decisions the status reads for requests left unrouted, and how much of each request it shows. */
const UNROUTED = 50, UNROUTED_CHARS = 80;

/** The unavailable Decision a message's request ended with, until someone dismisses it. */
function unavailableOf(client: SuperagentClient, triggerId: string): Decision | undefined {
  const id = client.store.triggers.disposition(triggerId)?.decisionId;
  const decision = id ? client.store.decisions.get(id) : undefined;
  return decision?.kind === "unavailable" && !decision.dismissed ? decision : undefined;
}

/**
 * Sends a stored message to the router again, as `swarm superagent again` does: it is queued for a fresh Eval, and the
 * unavailable Decision its request ended with is dismissed, so it leaves the status. The messages that waited in that
 * request with it go again too, in their order, or dismissing the Decision would drop them unseen. `queued` is false
 * while an Eval holds the message, which then changes nothing.
 */
export function routeAgain(client: SuperagentClient, handle: string): { trigger: Trigger; queued: boolean; dismissed?: Decision } {
  const trigger = findTrigger(client, handle);
  return client.store.atomic(() => {
    const decision = unavailableOf(client, trigger.id);
    const batch = decision?.triggerIds.filter((id) => unavailableOf(client, id)?.id === decision.id) ?? [trigger.id];
    const queued = batch.filter((id) => client.engine.reevaluate(id)).includes(trigger.id);
    return { trigger, queued, ...(queued && decision ? { dismissed: client.engine.dismiss(decision.id) } : {}) };
  });
}

/**
 * Dismisses a request that could not be routed, as `swarm superagent dismiss` does, without sending it again: the
 * unavailable Decision `handle` names by its id or the start of it, else the one the message `handle` names ended with.
 * Dismissing a Decision again changes nothing.
 */
export function dismissUnrouted(client: SuperagentClient, handle: string): Decision {
  const decisions = client.store.read.unavailableByPrefix(handle);
  if (decisions.length > 1) throw new Error(`${handle} names several Decisions; give more of the id`);
  const decision = decisions[0] ?? unavailableOf(client, findTrigger(client, handle).id);
  if (!decision) throw new Error(`Message ${handle} has no request that could not be routed`);
  return client.engine.dismiss(decision.id);
}

export interface HostStatus {
  running: boolean;
  pid?: number;
  heartbeatAt?: string;
  health: Record<string, Health>;
  counts: Record<TicketGroup, number>;
  /**
   * The newest requests that were not routed because the model did not answer in time, until each is sent again or
   * dismissed: the message to send again, the Decision that gave up on it and when, and how the message starts. A paired
   * node on an older version sends a status without it.
   */
  unrouted: { triggerId: string; decisionId: string; at: string; text: string }[];
}
/** The requests the status lists as unrouted, newest first. */
function unrouted(client: SuperagentClient): HostStatus["unrouted"] {
  return client.store.read.decisionsOfKinds(["unavailable"], UNROUTED).flatMap((decision) => {
    const request = decision.dismissed ? undefined : unroutedRequest(client.store, decision);
    return request ? [{ triggerId: request.id, decisionId: decision.id, at: decision.at, text: [...request.text.replace(/\s+/g, " ").trim()].slice(0, UNROUTED_CHARS).join("") }] : [];
  });
}
/**
 * Whether a host runs, as its heartbeat says, the health it last reported, how many tickets wait in each group, and the
 * requests that could not be routed.
 */
export function hostStatus(client: SuperagentClient, now = Date.now()): HostStatus {
  const owner = client.store.get(KV.host.owner);
  const health = client.store.get(KV.host.health);
  const running = !!owner && now - Date.parse(owner.heartbeatAt) < 15_000;
  const counts: Record<TicketGroup, number> = { person: 0, working: 0, queued: 0, idle: 0, ended: 0 };
  for (const ticket of client.store.tickets.open()) counts[ticketRow(client, ticket).group] += 1;
  return { running, ...(owner ? { pid: owner.pid, heartbeatAt: owner.heartbeatAt } : {}), health: health?.entries ?? {}, counts, unrouted: unrouted(client) };
}

/** Replies the host posted to a local Thread, oldest first, which the TUI shows as the ticket's messages. */
export function localReplies(client: SuperagentClient, limit = 50): { id: string; ticketId?: string; kind: string; text: string; status: string }[] {
  return client.store.db.prepare("SELECT value FROM outbox WHERE value ->> '$.channel.source' = 'local' ORDER BY rowid DESC LIMIT ?")
    .all(limit).map((row) => JSON.parse(String(row.value)) as { id: string; ticketId?: string; kind: string; text: string; status: string }).reverse();
}
