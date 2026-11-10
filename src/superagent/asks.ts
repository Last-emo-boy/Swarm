/**
 * What the agent asked people on someone else's behalf and waits to hear back on: "去问问他们进度" sends a question, and the
 * answer, whoever writes it, a person or another bot, goes back to the person who wanted to know (chatter.ts relays it).
 * An ask is open until one answer is relayed, or for `ASK_MS`; it is never a way in for work: an answer is passed on, not
 * acted on.
 */
import type { ChannelRef } from "./core/index.js";
import { KV } from "./kv.js";
import type { Store } from "./store.js";

/** How long the agent waits to hear back. */
export const ASK_MS = 12 * 3_600_000;
/** How many it keeps open at once; the oldest goes first. */
const OPEN_KEPT = 50;

export interface Ask {
  id: string;
  /** Where it asked: a group chat, or a person's direct messages. */
  chatId?: string;
  person?: string;
  /** Whom it asked in a group, by open_id: those it @-ed; none when it asked the group as a whole. */
  to: string[];
  /** What it asked. */
  text: string;
  at: string;
  /** Who wanted to know, and where the answer goes: a quote of their message. */
  for: { id: string; name: string; channel: ChannelRef };
}
type State = Pick<Store, "get" | "set">;

/** The asks still open at `now`, oldest first. */
export const openAsks = (state: Pick<Store, "get">, now: number): Ask[] =>
  (state.get(KV.asks.open) ?? []).filter((ask) => now - Date.parse(ask.at) < ASK_MS);

/** Opens an ask; one with the same id replaces it. */
export function ask(state: State, opened: Ask, now: number): void {
  state.set(KV.asks.open, [...openAsks(state, now).filter((item) => item.id !== opened.id), opened].slice(-OPEN_KEPT));
}

/** Closes asks once their answer is passed on. */
export function closeAsks(state: State, ids: readonly string[], now: number): void {
  state.set(KV.asks.open, openAsks(state, now).filter((item) => !ids.includes(item.id)));
}
