/**
 * Ticket and host views shared by the CLI and the TUI: one row per ticket with the stage it waits in (docs/003 of
 * dsh-superagent: whom the ticket waits for and what it needs), and the list of what needs a person, first.
 */
import { latestReport, reasonText, threadKey, ticketOutcome, ticketStage, type Decision, type LocalWhy, type Ticket, type Trigger, type WriteLevel } from "./core/index.js";
import { unroutedRequest, type SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import { EXPIRED_REASON, expiredWhy } from "./notices.js";
import { githubApp, linkOf } from "./github-link.js";
import { localNotice } from "./policy.js";
import type { Health } from "./health.js";
import { pulledBy, workerNode } from "./placement.js";
import { pullOf } from "./sources/github-pull.js";
import { chatName, senderOf } from "./people.js";
import { feishuAttachments, type Attachment } from "./sources/feishu-attachment.js";
import type { Receipt } from "./store.js";
import { Journal, type JournalKind, type JournalRun } from "./journal.js";
import { wording } from "./text.js";
import type { LedgerEntry } from "../usage/ledger.js";
import { costText, formatTokens } from "../usage/report.js";
import { thisDevice } from "../usage/cli.js";

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
  /** A check-back the worker left: when the ticket wakes itself, with why, so a listing shows a ticket that waits on its own. */
  checkBack?: string;
  summary?: string;
  /** The paired node its worker runs on, ran on last, or is placed on to start; unset when that is the node that owns it. */
  runsOn?: string;
  /** The paired node that pulled its latest Assignment while it waited for a worker here. */
  pulledBy?: string;
  /** The agent harness profile its worker runs on; unset for Swarm's own coding loop. */
  harness?: string;
  /** How far its work may write, and why it stays local when it does. */
  write: WriteLevel;
  local?: LocalWhy;
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
  // A ticket the host closed with nothing done, such as one nobody answered, says why, in the language of its request; a
  // worker's dropped report has no reason.
  const reason = outcome === "dropped" ? ticket.ended?.reason : undefined;
  const why = reason === EXPIRED_REASON ? expiredWhy(origin?.text ?? "") : reason;
  const group: TicketGroup = stage.stage === "ended" ? "ended" : stage.stage === "person" ? "person"
    : stage.stage === "idle" ? "idle" : action === "queued" ? "queued" : "working";
  const pr = pullOf(ticket);
  const report = latestReport(ticket);
  const node = workerNode(client, ticket);
  const puller = pulledBy(client, ticket);
  const harness = ticket.execution?.harness;
  const runsOn = { ...(node ? { runsOn: node } : {}), ...(puller ? { pulledBy: puller } : {}), ...(harness ? { harness } : {}) };
  // A ticket accepted before the access model, or without it, has no capability and writes as tickets always did.
  const write = ticket.mandate.capability?.write ?? "local";
  const local = ticket.mandate.capability?.local;
  const reach = { write, ...(local ? { local } : {}) };
  // A question the person already answered waits for the worker, not for the person: it leaves "needs you".
  const answered = !!ticket.attention && !ticket.ended && ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context
    && input.at > (report?.at ?? ""));
  if (answered && group === "person" && STAGE_LABELS[key] === "Awaiting answer") {
    return { id: ticket.id, short: ticket.id.slice(0, 8), title: ticket.title, group: "working", label: "Working on your answer",
      source: origin?.source ?? "unknown", ...(origin?.url ? { url: origin.url } : {}), ...(pr ? { pr } : {}),
      ...(report?.summary ? { summary: report.summary } : {}), ...runsOn, ...reach, updatedAt: ticket.updatedAt ?? ticket.createdAt };
  }
  return {
    id: ticket.id,
    short: ticket.id.slice(0, 8),
    title: ticket.title,
    group,
    label: why ?? (outcome ? OUTCOME_LABELS[outcome] ?? outcome : STAGE_LABELS[key] ?? key),
    source: origin?.source ?? "unknown",
    ...(origin?.url ? { url: origin.url } : {}),
    ...(pr ? { pr } : {}),
    ...(ticket.attention ? { question: ticket.attention.question } : {}),
    ...(ticket.checkBack ? { checkBack: `${wording(origin?.text ?? "")("check-back", "定时唤醒")} ${ticket.checkBack.at}: ${ticket.checkBack.note}` } : {}),
    ...(report?.summary ? { summary: report.summary } : {}),
    ...runsOn,
    ...reach,
    updatedAt: ticket.updatedAt ?? ticket.createdAt
  };
}

/**
 * The reason a ticket stays local, read now: one accepted before its requester linked keeps `unlinked` in its mandate, but
 * a link since then means linking is done and only a take-over is left, so the notice must not ask for it again.
 */
export function localWhyOf(client: SuperagentClient, ticketId: string | undefined, stored: LocalWhy | undefined): { local: LocalWhy | undefined; note?: string } {
  const ticket = ticketId === undefined ? undefined : client.store.tickets.get(ticketId)
  const link = ticket ? linkOf(client.store, ticket.mandate.actor) : undefined
  const live = !!link && !link.broken
  if (stored !== "unlinked" || !ticket) return { local: stored }
  return live ? { local: undefined, note: "This ticket stays local because it was accepted before your GitHub account was linked; it is linked now, so take it over once it is ready." }
    : { local: stored }
}
/** The local notice for a ticket's row, and what is new since its mandate was written; the note replaces the notice. */
export function localNoticeOf(client: SuperagentClient, ticketId: string | undefined, stored: LocalWhy | undefined, short: string,
  place: Parameters<typeof localNotice>[1]): string | undefined {
  const { local, note } = localWhyOf(client, ticketId, stored)
  // In the language of what the person wrote: the ticket keeps the message it was asked for in.
  const ticket = ticketId ? client.store.tickets.get(ticketId) : undefined
  const written = (ticket && client.store.triggers.get(ticket.origin.triggerId)?.text) || ""
  return note ?? localNotice(local, place, short, githubApp(client.settings()), written)
}

/** Why a ticket stays local, in a few words for a list row. */
export const localPhrase = (local: LocalWhy): string => ({
  unlinked: "link needed",
  "link-broken": "link broken",
  uninstalled: "app installed nowhere to push to",
  "not-served": "not a repository the app may push to",
  inferred: "inferred, no one asked",
  ceiling: "lowered by this scope's ceiling"
})[local];

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

/** How many requests left unrouted the status lists, newest first, and how much of each request it shows. */
const UNROUTED = 50, UNROUTED_CHARS = 80;

/**
 * The Decision that left a message's request unrouted, until someone dismisses it. None for an Eval that only started
 * again, as after a Policy change: its request is with the router, and the status never listed it.
 */
function unroutedOf(client: SuperagentClient, triggerId: string): Decision | undefined {
  const id = client.store.triggers.disposition(triggerId)?.decisionId;
  const decision = id ? client.store.decisions.get(id) : undefined;
  return decision && !decision.dismissed && unroutedRequest(client.store, decision) ? decision : undefined;
}

/**
 * Sends a stored message to the router again, as `swarm superagent again` does: it is queued for a fresh Eval, and the
 * unavailable Decision its request ended with is dismissed, so it leaves the status. The messages that waited in that
 * request with it go again too, in their order, or dismissing the Decision would drop them unseen; one of them that was
 * decided again since stays as decided. `queued` is false while an Eval holds the message, which then changes nothing.
 * A message that left no such request is queued alone, as a person's replay of it, with nothing to dismiss.
 */
export function routeAgain(client: SuperagentClient, handle: string): { trigger: Trigger; queued: boolean; dismissed?: Decision } {
  const trigger = findTrigger(client, handle);
  return client.store.atomic(() => {
    if (client.engine.candidate(trigger.id)) return { trigger, queued: false };
    const decision = unroutedOf(client, trigger.id);
    const batch = decision?.triggerIds.filter((id) => unroutedOf(client, id)?.id === decision.id) ?? [trigger.id];
    for (const id of batch) client.engine.reevaluate(id);
    return { trigger, queued: true, ...(decision ? { dismissed: client.engine.dismiss(decision.id) } : {}) };
  });
}

/**
 * Dismisses a request that could not be routed, as `swarm superagent dismiss` does, without sending it again: the one the
 * message `handle` names ended with, else the Decision `handle` names by its id or the start of it. A message goes first,
 * since the status prints messages' ids. Dismissing a Decision again changes nothing. An unavailable Decision of another
 * reason is none of these: its Eval started again, so dismissing it would not keep its request from the router.
 */
export function dismissUnrouted(client: SuperagentClient, handle: string): Decision {
  const decisions = client.store.read.triggersByPrefix(handle, 1).length ? [] : client.store.read.unroutedByPrefix(handle);
  if (decisions.length > 1) throw new Error(`${handle} names several Decisions; give more of the id`);
  const decision = decisions[0] ?? unroutedOf(client, findTrigger(client, handle).id);
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
  /** Replies the host could not deliver, and replies it dropped, so a person can see what did not reach them. */
  replies: {
    failing: { id: string; ticketId?: string; attempts: number; error: string }[];
    dropped: { id: string; ticketId?: string; at: string; reason: string }[];
  };
  /**
   * Tickets whose replies wait on a Source that is switched off: nothing is retried until someone enables it. A chat that is
   * merely filtered stays out, since its Source is on and the reply is dropped rather than held.
   */
  waitingOnOff: { ticketId?: string; source: string; messages: number }[];
}
/** The requests the status lists as unrouted, newest first. */
function unrouted(client: SuperagentClient): HostStatus["unrouted"] {
  return client.store.read.unroutedDecisions(UNROUTED).flatMap((decision) => {
    const request = unroutedRequest(client.store, decision);
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
  // Only a reply that failed at least once says something about today; one never tried is not failing.
  const failing = client.store.read.failingReplies().filter((receipt) => receipt.attempts > 0)
    .map((receipt) => ({ id: receipt.id, ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}), attempts: receipt.attempts, error: receipt.error }));
  const dropped = client.store.read.droppedReplies().map((receipt) => ({ id: receipt.id, ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}),
    at: receipt.dropped.at, reason: receipt.dropped.reason }));
  const off = new Map<string, HostStatus["waitingOnOff"][number]>();
  for (const receipt of client.store.receipts.waiting()) {
    // A kind this build does not register can never deliver the message: nothing to wait for, and not "off".
    const instance = client.sources.instance(receipt.channel.source)
    if (!instance || instance.enabled) continue;
    const group = `${receipt.ticketId ?? ""} ${receipt.channel.source}`;
    const seen = off.get(group)
    if (seen) seen.messages += 1
    else off.set(group, { ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}), source: receipt.channel.source, messages: 1 })
  }
  return { running, ...(owner ? { pid: owner.pid, heartbeatAt: owner.heartbeatAt } : {}), health: health?.entries ?? {}, counts, unrouted: unrouted(client),
    replies: { failing, dropped }, waitingOnOff: [...off.values()] };
}

/** Replies the host posted to a local Thread, oldest first, which the TUI shows as the ticket's messages. */
export function localReplies(client: SuperagentClient, limit = 50): { id: string; ticketId?: string; kind: string; text: string; status: string }[] {
  return client.store.db.prepare("SELECT value FROM outbox WHERE value ->> '$.channel.source' = 'local' ORDER BY rowid DESC LIMIT ?")
    .all(limit).map((row) => JSON.parse(String(row.value)) as { id: string; ticketId?: string; kind: string; text: string; status: string }).reverse();
}

/** A message the host queued for a ticket, whatever the Source it goes to: its status, when it went out, and what it carries. */
export interface TicketMessage {
  id: string;
  kind: string;
  text: string;
  status: string;
  source: string;
  triggerId?: string;
  sentAt?: string;
  platformMessageId?: string;
  /** Where the file the message sends is kept, when it sends one. */
  attachment?: string;
  dropped?: { at: string; reason: string };
  /** How many times its delivery failed in a row, and the last error. */
  attempts: number;
  error?: string;
  at?: string;
}

/** Every message the host queued for a ticket, oldest first, whichever Source it goes to, with its delivery status. */
export function ticketMessages(client: SuperagentClient, ticketId: string, limit = 500): TicketMessage[] {
  // The newest `limit` messages are read and brought back oldest first, so a long ticket keeps its latest ones.
  return client.store.db.prepare(`SELECT o.value, IFNULL(e.attempts, 0) AS attempts, IFNULL(e.error, '') AS error FROM outbox o
    LEFT JOIN effect e ON e.kind = 'reply' AND e.key = o.id WHERE o.value ->> '$.ticketId' = ? ORDER BY o.rowid DESC LIMIT ?`)
    .all(ticketId, limit).map((row) => messageRow(row)).reverse()
}
/** One outbox row as the terminal shows it; a message that already went out shows no failed tries, whichever effect row it left. */
function messageRow(row: Record<string, unknown>): TicketMessage {
  const receipt = JSON.parse(String(row.value)) as Receipt
  const pending = receipt.status === "pending"
  return { id: receipt.id, kind: receipt.kind, text: receipt.text, status: receipt.status, source: receipt.channel.source,
    ...(receipt.triggerId ? { triggerId: receipt.triggerId } : {}),
    ...(receipt.sentAt ? { sentAt: receipt.sentAt } : {}), ...(receipt.platformMessageId ? { platformMessageId: receipt.platformMessageId } : {}),
    ...(receipt.attachment ? { attachment: receipt.attachment } : {}), ...(receipt.dropped ? { dropped: receipt.dropped } : {}),
    attempts: pending ? Number(row.attempts) : 0, ...(pending && row.error ? { error: String(row.error) } : {}) }
}

/** What a ticket's stored work says: its assignments, the latest report and the calls its worker made on paired nodes. */
export interface WhyWork {
  assignments: { id: string; state: string; harness?: string; report?: { state: string; summary: string; at: string } }[];
  calls: { at: string; node: string; tool: string; args: string; ok?: boolean; ms?: number; error?: string }[];
}
/** One routed message of a ticket: the message, the Decision it ended with, and the few around it it was read with. */
export interface WhyRouting {
  trigger: { id: string; at: string; text: string; source: string; platformMessageId?: string };
  /** Who wrote it, by name, and the chat it was written in, by name: what a person reads. */
  sender: string;
  chat?: string;
  disposition: { command?: string; filtered?: unknown; fanout: string[]; decisionId?: string };
  decision?: { id: string; kind: string; at: string; strength: string; reason: string; ticketId?: string; dismissed?: true };
  around: { id: string; at: string; text: string; actor: string }[];
}
/** One run of a talking path the journal kept: what it was, when, and what became of it. */
export interface WhyRun { at: string; kind: JournalKind; outcome?: string; reason?: string; outbox?: string[]; card?: string }

/**
 * Why a ticket or a message was handled the way it was, from what the store kept: the message and how it was routed, the
 * ticket's work, the messages the host queued for it, the talking paths' journal rows around it, and its model usage. The
 * journal rows are what no other row has: the card a consideration, an attend or a reflection sent, and its reason.
 */
export async function whyReport(client: SuperagentClient, handle: string): Promise<WhyReport> {
  const ticket = findTicket(client, handle);
  // A ticket's id and a message's cannot be mistaken for each other; a handle that names neither is neither of them.
  let trigger: Trigger | undefined;
  try { if (!ticket) trigger = findTrigger(client, handle) } catch (error) {
    if (!(error instanceof Error) || !/^No message /.test(error.message)) throw error
  }
  if (!ticket && !trigger) throw new Error(`No ticket or message ${handle}`);
  // A ticket is explained by the message it was accepted from, which also names its chat; a message by itself, though the
  // Decision that took it in can name the ticket it became.
  const origin = ticket ? client.store.triggers.get(ticket.origin.triggerId) : trigger;
  const routing = origin ? routingOf(client, origin) : undefined;
  const ticketId = ticket?.id ?? routing?.decision?.ticketId;
  const full = ticketId ? client.store.tickets.get(ticketId) : undefined;
  const chat = chatOf(origin);
  // The journal holds a run under the trigger it routed, the chat it considered or the ticket it reflected on; a chat run
  // holds the message in its card, which the key scan cannot find, so the chat's rows come whole.
  const keys: string[] = []
  const prefixes: string[] = []
  if (origin) prefixes.push(`trigger:${origin.id}`)
  if (full) keys.push(`ticket:${full.id}`)
  if (chat) keys.push(`chat:${chat}`)
  // A promise is journaled under its note, not the message that made it: the origin's own promises come along by note id.
  if (origin) keys.push(...client.store.db.prepare("SELECT id FROM memory WHERE value ->> '$.origin.triggerId' = ?").all(origin.id)
    .map((row) => `note:${String(row.id)}`))
  // The command runs in its own process, without the host's journal: the rows are in the store either way.
  const runs = (client.journal ?? new Journal(client.store)).history(keys, prefixes);
  // A message shows what was queued while answering it; a ticket every message queued for it, whatever it answers.
  const messages = trigger ? messagesOf(client, trigger.id) : full ? ticketMessages(client, full.id) : [];
  const since = new Date(Date.parse(origin?.at ?? new Date().toISOString()) - 3_600_000);
  // A message's usage is its own calls, and a ticket's its own plus its chat's from when it was asked: the chat arm has no
  // message bound, so a message handle that kept it would count every other message's calls in the hour before.
  const usage = await usageOf(client, { ...(full?.id ? { ticketId: full.id } : {}), ...(routing?.decision?.ticketId ? { ticketId: routing.decision.ticketId } : {}),
    ...(origin?.id ? { triggerId: origin.id } : {}), ...(ticket && chat ? { chatId: chat, chatSince: new Date(origin?.at ?? new Date().toISOString()) } : {}), since });
  return {
    handle: ticket ? `ticket ${ticket.id}` : `message ${trigger!.id}`,
    ...(full ? { ticketId: full.id, ticket: ticketRow(client, full) } : {}),
    ...(routing ? { routing } : {}),
    ...(full ? { work: workOf(client, full) } : {}),
    messages,
    ...(origin?.text ? { attachments: feishuAttachments(origin.text) } : {}),
    talking: runs.map((entry) => ({ at: entry.at, kind: entry.kind, ...(entry.run.outcome ? { outcome: entry.run.outcome } : {}),
      ...(entry.run.reason ? { reason: entry.run.reason } : {}), ...(entry.run.outbox?.length ? { outbox: entry.run.outbox } : {}),
      ...(entry.run.user ? { card: entry.run.user.slice(0, 2000) } : {}) })),
    usage
  };
}
/** How a time reads in `why`: the clock alone for today, its date and clock for another day. */
function clock(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString()} ${time}`
}
const oneLine = (text: string, limit = 100): string => { const flat = text.replace(/\s+/g, " ").trim(); return [...flat].length > limit ? `${[...flat].slice(0, limit - 1).join("")}…` : flat }

/**
 * The report as the terminal shows it: the message and how it was routed, the ticket's work, the messages queued for it,
 * the journal rows of the talking paths around it, and its usage. Sections with nothing to show are left out.
 */
export function whyText(client: SuperagentClient, report: WhyReport): string {
  const lines: string[] = []
  const routing = report.routing
  if (routing) {
    const where = routing.chat ? ` in "${routing.chat}"` : ""
    const platform = routing.trigger.platformMessageId ? `  ${routing.trigger.platformMessageId}` : ""
    lines.push(`  asked  ${clock(routing.trigger.at)}  ${routing.sender}${where}${platform}`)
    lines.push(`         "${oneLine(routing.trigger.text, 90)}"`)
  }
  if (routing && (routing.decision || routing.disposition.command || routing.disposition.filtered)) {
    lines.push("", "  routing")
    if (routing.disposition.filtered) lines.push(`    filtered by its Source: ${oneLine(JSON.stringify(routing.disposition.filtered), 120)}`)
    if (routing.disposition.command) lines.push(`    command  ${routing.disposition.command}`)
    const decision = routing.decision
    if (decision) {
      lines.push(`    ${clock(decision.at)}  ${decision.kind}  ${decision.strength}${decision.dismissed ? "  (dismissed)" : ""}${decision.ticketId ? `  ticket ${decision.ticketId.slice(0, 8)}` : ""}`)
      if (decision.reason) lines.push(`      ${oneLine(decision.reason, 240)}`)
    }
  }
  const ticket = report.ticket
  if (ticket) {
    lines.push("", `  ticket ${ticket.short}  ${ticket.label}  ${ticket.title}`)
    // Why it stays local, and what the person could do about it, for the ones a person can act on.
    const notice = localNoticeOf(client, report.ticketId, ticket.local, ticket.short, "terminal")
    if (notice) lines.push(`    ${notice}`)
    if (ticket.checkBack) lines.push(`    ${ticket.checkBack}`)
  }
  if (report.work?.assignments.length) {
    lines.push("", "  work")
    for (const assignment of report.work.assignments) {
      const ran = `${assignment.state}${assignment.harness ? `  ${assignment.harness}` : ""}`
      const text = assignment.report ? `${oneLine(assignment.report.summary.split("\n")[0] ?? "", 100)}` : "no report yet"
      const at = assignment.report ? `${clock(assignment.report.at)}  ` : ""
      lines.push(`    ${at}${ran}  "${text}"`)
    }
  }
  if (report.work?.calls.length) {
    for (const call of report.work.calls) {
      const went = call.ok === undefined ? "?" : call.ok ? "ok" : `failed: ${oneLine(call.error ?? "", 60)}`
      lines.push(`    mesh  ${call.node} ${call.tool}  "${oneLine(call.args, 60)}"  → ${went}`)
    }
  }
  if (report.messages.length) {
    lines.push("", "  messages")
    for (const message of report.messages) {
      const when = message.sentAt ?? message.dropped?.at
      const tried = message.attempts ? ` (${message.attempts} failed ${message.attempts === 1 ? "try" : "tries"})` : ""
      const platform = message.platformMessageId ? `  ${message.platformMessageId}` : ""
      lines.push(`    ${when ? clock(when) : "--:--:--"}  ${message.kind}  ${message.status}${tried}${platform}  "${oneLine(message.text, 80)}"`)
      if (message.attachment) lines.push(`                attachment  ${message.attachment}`)
      if (message.error) lines.push(`                ${oneLine(message.error, 120)}`)
    }
  }
  if (report.attachments?.length) {
    lines.push("", "  attachments in the ask")
    for (const attachment of report.attachments) lines.push(`    ${attachment.type}  ${attachment.file_key}${attachment.name ? `  ${attachment.name}` : ""}`)
  }
  if (report.talking.length) {
    lines.push("", "  talking")
    for (const run of report.talking) {
      const outcome = run.outcome ?? "interrupted"
      const queued = run.outbox?.length ? `  outbox ${run.outbox.map((id) => id.slice(0, 8)).join(", ")}` : ""
      lines.push(`    ${clock(run.at)}  ${run.kind.padEnd(13)} ${outcome.padEnd(11)} "${oneLine(run.reason ?? "", 90)}"${queued}`)
    }
  } else {
    lines.push("", "  talking", "    none kept for this yet; the journal starts with the next run")
  }
  const usage = report.usage
  if (usage.calls) {
    lines.push("", `  usage  ${usage.calls} call${usage.calls === 1 ? "" : "s"} · ${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out · ${costText(usage)}`)
  }
  return lines.join("\n")
}

/** The report `why` prints, as text or JSON. */
export interface WhyReport {
  handle: string;
  /** The ticket the handle names, through its routing when the handle is a message. */
  ticketId?: string;
  ticket?: TicketRow;
  routing?: WhyRouting;
  work?: WhyWork;
  messages: TicketMessage[];
  attachments?: Attachment[];
  talking: WhyRun[];
  usage: { calls: number; input: number; output: number; cost: Record<string, number>; unpriced: number };
}

/** The chat a message was written in, from its Source's own meta. */
function chatOf(trigger: Trigger | undefined): string | undefined {
  const chat = trigger?.meta.chatId;
  return typeof chat === "string" ? chat : undefined;
}

/** How one message was routed: its own row, the Decision it ended with, and the few messages it was read with. */
function routingOf(client: SuperagentClient, trigger: Trigger): WhyRouting {
  const disposition = client.store.triggers.disposition(trigger.id);
  const decision = disposition?.decisionId ? client.store.decisions.get(disposition.decisionId) : undefined;
  const thread = trigger.threads[0];
  const around = thread ? client.store.read.threadTriggers(threadKey(thread), 7) : [];
  return {
    trigger: { id: trigger.id, at: trigger.at, text: trigger.text, source: trigger.source,
      ...(typeof trigger.meta.messageId === "string" ? { platformMessageId: trigger.meta.messageId } : {}) },
    sender: senderOf(client.store, trigger),
    ...(chatOf(trigger) ? { chat: chatName(client.store, chatOf(trigger)!) ?? chatOf(trigger)! } : {}),
    disposition: { ...(disposition?.command ? { command: disposition.command } : {}), ...(disposition?.filtered ? { filtered: disposition.filtered } : {}),
      fanout: disposition?.fanout ?? [], ...(disposition?.decisionId ? { decisionId: disposition.decisionId } : {}) },
    ...(decision ? { decision: { id: decision.id, kind: decision.kind, at: decision.at, strength: decision.strength, reason: reasonText(decision.reason),
      ...(decision.ticketId ? { ticketId: decision.ticketId } : {}), ...(decision.dismissed ? { dismissed: true as const } : {}) } } : {}),
    around: around.map((item) => ({ id: item.id, at: item.at, text: [...item.text.replace(/\s+/g, " ").trim()].slice(0, 160).join(""), actor: item.actor.id }))
  };
}

/** The messages the host queued while answering one message, whichever Source they went to. */
function messagesOf(client: SuperagentClient, triggerId: string): TicketMessage[] {
  // The reply effect is joined as the ticket's messages join it, so a failed delivery reads the same under either handle.
  return client.store.db.prepare(`SELECT o.value, IFNULL(e.attempts, 0) AS attempts, IFNULL(e.error, '') AS error FROM outbox o
    LEFT JOIN effect e ON e.kind = 'reply' AND e.key = o.id WHERE o.value ->> '$.triggerId' = ? ORDER BY o.rowid DESC LIMIT 500`)
    .all(triggerId).map((row) => messageRow(row)).reverse()
}

/** A ticket's assignments and mesh calls, the calls with how each went. */
function workOf(client: SuperagentClient, ticket: Ticket): WhyWork {
  const calls = client.store.get(KV.mesh.calls(ticket.id)) ?? [];
  return {
    assignments: ticket.assignments.map((assignment) => ({ id: assignment.id, state: assignment.state,
      ...(ticket.execution?.harness ? { harness: ticket.execution.harness } : {}), ...(assignment.report ? { report: assignment.report } : {}) })),
    calls
  }
}

/** What the talking paths used for a ticket, a message or a chat: its calls, their tokens, and their cost from this device's prices. */
async function usageOf(client: SuperagentClient, about: { ticketId?: string; triggerId?: string; chatId?: string; since: Date; chatSince?: Date }): Promise<WhyReport["usage"]> {
  // The ledger lives in the whole Swarm's database, not the superagent store's, and is read without writing to it.
  const { readLedgerAt, priceLedger, totalOf } = await import("../usage/ledger.js")
  const { mergedPrices } = await import("../usage/prices.js")
  const { loadSwarmSettings } = await import("../config/settings.js")
  let entries: LedgerEntry[]
  try { entries = readLedgerAt(loadSwarmSettings().runtime.databasePath, thisDevice(), { since: about.since }) } catch { entries = [] }
  const mine = entries.filter((entry) => (about.ticketId && entry.ticketId === about.ticketId)
    || (about.triggerId && entry.triggerId === about.triggerId)
    || (about.chatId && about.chatSince && entry.chatId === about.chatId && entry.at >= about.chatSince.toISOString()))
  const total = totalOf(priceLedger(mine, mergedPrices(loadSwarmSettings().usage.prices)))
  return { calls: total.calls, input: total.input, output: total.output, cost: total.cost, unpriced: total.unpriced }
}
