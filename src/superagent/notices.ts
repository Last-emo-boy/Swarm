/**
 * What a person hears of their ticket beyond its acknowledgement, questions and result: a short update now and then while
 * the work goes on, which its worker writes at a milestone, a notice when the work stops, failed or blocked, with
 * nothing to ask them, and, while the ticket then waits on them, one reminder before it is closed. None goes to GitHub,
 * whose timeline shows the work.
 */
import { key, latestAssignment, latestReport, ticketStage, type ChannelRef, type Ticket } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";
import type { Store } from "./store.js";
import { IM_WORDS, wordCount, wording } from "./text.js";

/** A ticket's first update waits this long after it started, and each next one this long after the one before. */
export const FIRST_PROGRESS_MS = 2 * 60_000, PROGRESS_MS = 5 * 60_000;
/** How much of a report's summary or of a ticket's question a notice quotes at most. */
const REASON_CHARS = 240;
/** A ticket that waits on a person reminds them after this long with nothing from them, and is closed this long after the reminder. */
export const REMIND_MS = 24 * 3_600_000, CLOSE_MS = 24 * 3_600_000;
/** Why a ticket that waited on a person was closed, which its row shows in place of its outcome (views.ts). */
export const EXPIRED_REASON = "No reply in two days";

/** Where a ticket's notices go: the conversation a person asked for it in, unless that is GitHub. */
export function noticeChannel(store: Pick<Store, "triggers">, ticket: Ticket): ChannelRef | undefined {
  const origin = store.triggers.get(ticket.origin.triggerId);
  const channel = origin?.channel ?? ticket.channels[0];
  return origin?.human && channel && channel.source !== "github" ? channel : undefined;
}

/** Whether a ticket's update may go out now, which then counts as sent. */
export function progressDue(store: Pick<Store, "get" | "set">, ticket: Pick<Ticket, "id" | "createdAt">, now = Date.now()): boolean {
  const last = store.get(KV.notices.progress(ticket.id));
  const due = last ? now - Date.parse(last) >= PROGRESS_MS : now - Date.parse(ticket.createdAt) >= FIRST_PROGRESS_MS;
  if (due) store.set(KV.notices.progress(ticket.id), new Date(now).toISOString());
  return due;
}

/**
 * A notice around a quote, such as a report's reason or a ticket's question, that always fits a chat message: the quote is
 * cut to `REASON_CHARS` characters, then shorter until the whole notice has at most `IM_WORDS` words, with an ellipsis
 * where it was cut. A notice too long for its chat would not be sent at all.
 */
function fitted(quote: string, notice: (quote: string) => string): string {
  let kept = quote.slice(0, REASON_CHARS);
  const text = () => notice(kept.length < quote.length ? `${kept}…` : kept);
  while (kept && wordCount(text()) > IM_WORDS) kept = kept.slice(0, Math.floor(kept.length * 0.9));
  return text();
}

/**
 * The id of the notice that a report stopped a ticket's work, shared by the worker's own words and the host's, so one goes
 * out; with the report's state, so a failure and a block reported in the same millisecond each get theirs.
 */
export const stoppedId = (ticketId: string, at: string, state: "failed" | "blocked"): string => key("stopped", ticketId, at, state);

/** The host's notice that a ticket's work stopped, with the report's reason, in the language of its request. */
export function stoppedNotice(state: "failed" | "blocked", summary: string, request: string): string {
  const say = wording(request);
  return fitted(summary, (reason) => state === "failed"
    ? say(`This ticket stopped before it was done: ${reason} Reply here and I'll pick it up again.`, `这张工单没做完就停下了：${reason} 回复这条消息，我会接着做。`)
    : say(`This ticket is stuck: ${reason} Reply here to tell me how to go on.`, `这张工单卡住了：${reason} 回复这条消息，告诉我怎么继续。`));
}

/** The reminder that a ticket still waits on its person, with its open question when it has one, in the language of its request. */
function waitingNotice(question: string | undefined, request: string): string {
  const say = wording(request);
  const closes = say("Without a reply within a day I'll close it; a reply here after that reopens it.", "一天内没有回复的话，我会关闭它；之后回复这条消息可以重新打开。");
  return question === undefined ? say(`This ticket is still stuck and waiting for you. ${closes}`, `这张工单还卡着，在等你回复。${closes}`)
    : fitted(question, (quote) => say(`This ticket is still waiting for your answer: ${quote} ${closes}`, `这张工单还在等你的回答：${quote} ${closes}`));
}

/** The notice that a ticket nobody answered was closed, in the language of its request. */
const expiredNotice = (request: string): string => wording(request)(
  "There was no reply in two days, so I closed this ticket. Reply here and I'll pick it up again.", "两天没有收到回复，我把这张工单关闭了。回复这条消息，我会接着做。");

/**
 * An open ticket's wait on a person who has said nothing: the ticket waits for an answer or stands blocked or failed (see
 * `ticketStage`), and no person's message reached it since its latest report. It waits since that report, or since a
 * person's later retry, which starts the wait over as their message would. `working` says its worker is at work
 * meanwhile, which a turn's end ends: after a progress report, which may ask its question, on what reached it after the
 * report (the busy test of `Assignments.interrupted`), and in a new Assignment that has reported nothing yet, as after a
 * retry or a host restart.
 */
function personWait(ticket: Ticket): { since: string; working: boolean } | undefined {
  const stage = ticketStage(ticket);
  const report = latestReport(ticket);
  const latest = latestAssignment(ticket);
  if (!report || !latest || stage.stage !== "person" || !["answer", "blocked", "failed"].includes(stage.action)) return undefined;
  if (ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context && input.at >= report.at)) return undefined;
  // Since when its worker has had something to work on, if it has: no turn of it ended since.
  const begun = !latest.report ? latest.deliveredAt ?? latest.createdAt
    : latest.deliveredAt && latest.deliveredAt >= report.at ? latest.deliveredAt : report.state === "progress" ? report.at : undefined;
  const retried = ticket.assignments.filter((assignment) => assignment.endedReason === "retried").at(-1)?.endedAt;
  return { since: retried && retried > report.at ? retried : report.at, working: !!begun && !(latest.idleAt && latest.idleAt >= begun) };
}

/**
 * Since when an open ticket waits on a person who has said nothing, while its worker is not at work on it (see
 * `personWait`): the time of its latest report, or of a later retry. Undefined for any other ticket.
 */
export function waitingSince(ticket: Ticket): string | undefined {
  const wait = personWait(ticket);
  return wait && !wait.working ? wait.since : undefined;
}

/**
 * Gives every open ticket that waits on a person a clock (see `waitingSince`): after `REMIND_MS` with nothing from them it
 * reminds them once where its notices go, and `CLOSE_MS` after the reminder it closes the ticket and says so there. A
 * ticket with nowhere to say it, such as one from GitHub or from a Source that is off, is closed after both, unannounced.
 * Without the clock such a ticket stayed open forever, and kept its ticket VM's data disk and its requester's place among
 * their open tickets. A person's later message on its Thread resumes a ticket closed this way, as one that completed.
 * It runs as one transaction, so a message a person writes meanwhile comes before it or after it.
 */
export function sweepStale(client: SuperagentClient, now = Date.now()): void {
  const { store, sources, outbox, engine } = client;
  store.atomic(() => {
    // A reminder counts for the wait it was sent in: a ticket that waits no more, or waits anew, starts over. One whose
    // worker is at work meanwhile, as after a host restart, keeps it: its clock would otherwise start again, unsaid.
    for (const name of store.keys(KV.notices.nudged)) {
      const ticket = store.tickets.get(name.slice(KV.notices.nudged.prefix.length));
      if (!ticket || personWait(ticket)?.since !== store.get(name)?.since) store.delete(name);
    }
    for (const ticket of store.tickets.open()) {
      const since = waitingSince(ticket);
      if (!since) continue;
      const origin = noticeChannel(store, ticket);
      const channel = origin && sources.channelAllowed(origin) ? origin : undefined;
      const reminder = store.get(KV.notices.nudged(ticket.id));
      const request = store.triggers.get(ticket.origin.triggerId)?.text ?? "";
      const waited = now - Date.parse(since);
      if (reminder ? now - Date.parse(reminder.at) >= CLOSE_MS : !channel && waited >= REMIND_MS + CLOSE_MS) {
        engine.expireTicket(ticket.id, EXPIRED_REASON);
        if (channel) outbox.send({ id: key("expired", ticket.id, since), channel, text: expiredNotice(request), kind: "reply", ticketId: ticket.id });
        store.delete(KV.notices.nudged(ticket.id));
      } else if (channel && !reminder && waited >= REMIND_MS) {
        outbox.send({ id: key("nudge", ticket.id, since), channel, text: waitingNotice(ticket.attention?.question, request), kind: "reply", ticketId: ticket.id });
        store.set(KV.notices.nudged(ticket.id), { since, at: new Date(now).toISOString() });
      }
    }
  });
}
