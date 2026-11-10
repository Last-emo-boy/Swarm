/**
 * What a person hears of their ticket beyond its acknowledgement, questions and result: a short update now and then while
 * the work goes on, which its worker writes at a milestone, and a notice when the work stops, failed or blocked, with
 * nothing to ask them. Neither goes to GitHub, whose timeline shows the work.
 */
import { key, type ChannelRef, type Ticket } from "./core/index.js";
import { KV } from "./kv.js";
import type { Store } from "./store.js";
import { wording } from "./text.js";

/** A ticket's first update waits this long after it started, and each next one this long after the one before. */
export const FIRST_PROGRESS_MS = 2 * 60_000, PROGRESS_MS = 5 * 60_000;
/** How much of a report's summary a notice that the work stopped quotes. */
const REASON_CHARS = 240;

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

/** The id of the notice that a report stopped a ticket's work, shared by the worker's own words and the host's, so one goes out. */
export const stoppedId = (ticketId: string, at: string): string => key("stopped", ticketId, at);

/** The host's notice that a ticket's work stopped, with the report's reason, in the language of its request. */
export function stoppedNotice(state: "failed" | "blocked", summary: string, request: string): string {
  const say = wording(request);
  const reason = summary.length > REASON_CHARS ? `${summary.slice(0, REASON_CHARS)}…` : summary;
  return state === "failed"
    ? say(`This ticket stopped before it was done: ${reason} Reply here and I'll pick it up again.`, `这张工单没做完就停下了：${reason} 回复这条消息，我会接着做。`)
    : say(`This ticket is stuck: ${reason} Reply here to tell me how to go on.`, `这张工单卡住了：${reason} 回复这条消息，告诉我怎么继续。`);
}
