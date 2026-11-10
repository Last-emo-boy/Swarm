/**
 * Who is who on Feishu: the people and bots in each chat the agent is in, by name, as Feishu last listed them, the names
 * messages mention, and what the agent itself said in each chat. The Feishu Source keeps the lists current in the
 * background (sources/feishu-loops.ts); the router, chatter and workers read them from the store, so naming someone never
 * waits on Feishu.
 */
import { z } from "zod/v4";
import { threadKey, type ChannelRef, type Trigger } from "./core/index.js";
import { feishuUserChannel } from "./sources/feishu-trigger.js";
import { KV, type Key } from "./kv.js";
import type { Store } from "./store.js";

/** A chat's members by open_id (bots also by app id), the bots among them, and whether to read the list again soon. */
export interface Members { at: string; names: Record<string, string>; bots?: string[]; again?: boolean }
/** Something the agent said in a chat: the message it answered, if any, and whether it went in that message's topic. */
export interface Said { at: string; text: string; to?: string; topic?: boolean }

interface State { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void }

/** How long a chat's member list stays fresh; one with a stranger in it, or whose read failed, is read again after a while. */
export const MEMBERS_MS = 6 * 3_600_000, AGAIN_MS = 10 * 60_000;
/** How many chats one round of the Source's loop reads. */
const CHATS_PER_ROUND = 5;
/** How many of its own messages per chat the agent remembers. */
export const SAID_KEPT = 20;

const SOURCE = "feishu";
export const personName = (state: Pick<State, "get">, actor: { source: string; id: string }): string | undefined =>
  state.get(KV.people.person(actor.source, actor.id))?.name;
export const chatName = (state: Pick<State, "get">, chatId: string): string | undefined => state.get(KV.sources.labels(SOURCE))?.[chatId];
export const chatMembers = (state: Pick<State, "get">, chatId: string): Members | undefined => state.get(KV.people.members(chatId));

const nameIn = (trigger: Trigger): string | undefined => typeof trigger.meta.senderName === "string" ? trigger.meta.senderName : undefined;
/** A message's sender by name, from the message or the directory, else by id. */
export const senderOf = (state: Pick<State, "get">, trigger: Trigger): string =>
  nameIn(trigger) ?? personName(state, trigger.actor) ?? chatMembers(state, String(trigger.meta.chatId ?? ""))?.names[trigger.actor.id] ?? trigger.actor.id;

const mentionsOf = (trigger: Trigger): { id: string; name: string }[] =>
  Array.isArray(trigger.meta.mentions) ? trigger.meta.mentions as { id: string; name: string }[] : [];

/**
 * Takes in what a Feishu message says of people: the names it mentions, and its sender's name, which it carries from then
 * on. A sender with no name yet has their chat's member list read again soon.
 */
export function noticed(state: State, trigger: Trigger, at = new Date().toISOString()): Trigger {
  for (const { id, name } of mentionsOf(trigger)) {
    if (personName(state, { source: trigger.source, id }) !== name) state.set(KV.people.person(trigger.source, id), { name, at });
  }
  const name = personName(state, trigger.actor);
  const chatId = typeof trigger.meta.chatId === "string" ? trigger.meta.chatId : undefined;
  const members = chatId ? chatMembers(state, chatId) : undefined;
  if (!name && chatId && members && !members.again) state.set(KV.people.members(chatId), { ...members, again: true });
  return name && !nameIn(trigger) ? { ...trigger, meta: { ...trigger.meta, senderName: name } } : trigger;
}

/** The chats whose member lists the next round reads: ones never read first, then ones to read again, then stale ones. */
export function chatsToRead(state: Pick<State, "get">, now: number): string[] {
  const chats = new Set([...Object.keys(state.get(KV.sources.labels(SOURCE)) ?? {}), ...Object.keys(state.get(KV.feishu.chats) ?? {})]);
  const due = [...chats].flatMap((chatId) => {
    const members = chatMembers(state, chatId);
    if (!members) return [{ chatId, rank: 0, at: 0 }];
    const age = now - Date.parse(members.at);
    const rank = members.again && age >= AGAIN_MS ? 1 : age >= MEMBERS_MS ? 2 : undefined;
    return rank === undefined ? [] : [{ chatId, rank, at: Date.parse(members.at) }];
  });
  return due.sort((a, b) => a.rank - b.rank || a.at - b.at).slice(0, CHATS_PER_ROUND).map((item) => item.chatId);
}

const MemberSchema = z.looseObject({ member_id: z.string(), name: z.string().nullish(), app_id: z.string().nullish() });
const MembersSchema = z.looseObject({ users: z.array(MemberSchema).default([]), bots: z.array(MemberSchema).default([]) });
/**
 * Reads a chat's people and bots from Feishu into the directory. A list that cannot be read keeps the names it had and is
 * tried again after a while.
 */
export async function readMembers(lark: (args: string[]) => Promise<unknown>, state: State, chatId: string, now = Date.now()): Promise<void> {
  const at = new Date(now).toISOString();
  const previous = chatMembers(state, chatId);
  let listed: z.infer<typeof MembersSchema>;
  try {
    listed = MembersSchema.parse(await lark(["im", "+chat-members-list", "--chat-id", chatId, "--page-all", "--page-limit", "0"]));
  } catch {
    state.set(KV.people.members(chatId), { names: {}, ...previous, at: new Date(now - MEMBERS_MS + AGAIN_MS).toISOString(), again: false });
    return;
  }
  const names: Record<string, string> = {};
  const bots: string[] = [];
  for (const [member, bot] of [...listed.users.map((user) => [user, false] as const), ...listed.bots.map((item) => [item, true] as const)]) {
    if (!member.name) continue;
    const ids = [member.member_id, ...(bot && member.app_id ? [member.app_id] : [])];
    for (const id of ids) {
      names[id] = member.name;
      if (bot) bots.push(id);
      if (personName(state, { source: SOURCE, id }) !== member.name) state.set(KV.people.person(SOURCE, id), { name: member.name, at });
    }
  }
  state.set(KV.people.members(chatId), { at, names, ...(bots.length ? { bots } : {}) });
}

/** Remembers a message the agent posted in a chat, from whatever sent it (outbox.ts), so later cards show its own words. */
export function said(state: State, chatId: string, entry: Said): void {
  const current = state.get(KV.chatter.chat(chatId)) ?? { said: [] };
  state.set(KV.chatter.chat(chatId), { ...current, said: [...current.said, entry].slice(-SAID_KEPT) });
}

/** Remembers a message the agent sent to a person's direct messages by their open_id, where no chat id names the conversation. */
export function saidTo(state: State, person: string, entry: Said): void {
  state.set(KV.people.dm(person), [...(state.get(KV.people.dm(person)) ?? []), entry].slice(-SAID_KEPT));
}

/** One line of a conversation as the router and workers read it. */
export interface Line { at: string; from: string; text: string; from_id?: string; trigger_id?: string; bot?: true; you?: true }
const cut = (text: string, chars: number): string => text.length > chars ? `${text.slice(0, chars)}…` : text;

/**
 * The latest messages of a Feishu conversation, oldest first, with the senders' names and the agent's own words marked
 * `you`: in a topic, that topic's; else the chat's, without its topics' replies. `exclude` leaves out messages the reader
 * already has.
 */
interface LineOptions { since: string; limit: number; chars: number; exclude?: ReadonlySet<string>; self?: string }
export function conversation(store: Pick<Store, "get" | "read">, trigger: Trigger, options: LineOptions): Line[] {
  const chatId = String(trigger.meta.chatId ?? "");
  const topic = typeof trigger.meta.threadId === "string";
  const messages = topic ? store.read.threadTriggers(threadKey(trigger.threads[0]!), options.limit * 2)
    : store.read.chatMessages(chatId, options.since, options.limit * 2, true).filter((message) => typeof message.meta.threadId !== "string");
  const kept = messages.filter((message) => message.at >= options.since && !options.exclude?.has(message.id));
  const ids = new Set(kept.map((message) => String(message.meta.messageId ?? "")));
  // In a direct message, what it wrote to the person on its own counts too.
  const wrote = trigger.meta.direct === true ? (store.get(KV.people.dm(trigger.actor.id)) ?? []).filter((entry) => entry.at >= options.since) : [];
  return lines(store, kept, [...saidIn(store, chatId, options.since)
    .filter((entry) => topic ? !!entry.to && ids.has(entry.to) && entry.topic === true : entry.topic !== true), ...wrote], options);
}
/** A chat's latest messages, its topics' replies too, oldest first, with names and the agent's own words. */
export const chatLog = (store: Pick<Store, "get" | "read">, chatId: string, options: LineOptions): Line[] =>
  lines(store, store.read.chatMessages(chatId, options.since, options.limit, true), saidIn(store, chatId, options.since), options);
const saidIn = (state: Pick<State, "get">, chatId: string, since: string): Said[] =>
  (state.get(KV.chatter.chat(chatId))?.said ?? []).filter((entry) => entry.at >= since);
const lines = (store: Pick<Store, "get">, messages: Trigger[], own: Said[], options: LineOptions): Line[] => [
  ...messages.map((message): Line => ({ at: message.at, from: senderOf(store, message), from_id: message.actor.id, trigger_id: message.id, ...(message.human ? {} : { bot: true as const }),
    text: cut(message.text, options.chars) })),
  ...own.map((entry): Line => ({ at: entry.at, from: options.self || "you", you: true, text: cut(entry.text, options.chars) }))
].sort((a, b) => a.at.localeCompare(b.at)).slice(-options.limit);

/** The chats the agent is in, by id: their names, whether each is a direct message, and how many people and bots it has. */
export function chatsOf(state: Pick<State, "get">): { chat_id: string; name: string | null; direct?: true; people: number }[] {
  const direct = state.get(KV.feishu.chats) ?? {};
  const ids = new Set([...Object.keys(state.get(KV.sources.labels(SOURCE)) ?? {}), ...Object.keys(direct)]);
  return [...ids].map((chatId) => {
    const people = peopleIn(state, chatId, 1000);
    const name = direct[chatId] === true ? people[0]?.name ?? null : chatName(state, chatId) ?? null;
    return { chat_id: chatId, name, ...(direct[chatId] === true ? { direct: true as const } : {}), people: people.length };
  });
}

/** The people in a chat as `{id, name}`, bots marked, one entry per name (a bot's app id is not repeated). */
export function peopleIn(state: Pick<State, "get">, chatId: string, limit: number): { id: string; name: string; bot?: true }[] {
  const members = chatMembers(state, chatId);
  if (!members) return [];
  const seen = new Set<string>();
  return Object.entries(members.names).filter(([id]) => id.startsWith("ou_")).flatMap(([id, name]) => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, ...(members.bots?.includes(id) ? { bot: true as const } : {}) }];
  }).slice(0, limit);
}

/** The people in the directory whose name contains `name`, with the chats they are in. */
export function findPeople(store: Pick<Store, "get" | "keys">, name: string, limit = 20): { id: string; name: string; chats: string[] }[] {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return [];
  const chats = new Set([...Object.keys(store.get(KV.sources.labels(SOURCE)) ?? {}), ...Object.keys(store.get(KV.feishu.chats) ?? {})]);
  const prefix = `${KV.people.person.prefix}${SOURCE}:`;
  return store.keys(KV.people.person).filter((key) => key.startsWith(prefix)).flatMap((key) => {
    const id = key.slice(prefix.length);
    const person = store.get(key);
    if (!person || !id.startsWith("ou_") || !person.name.toLowerCase().includes(wanted)) return [];
    const where = [...chats].filter((chatId) => chatMembers(store, chatId)?.names[id] !== undefined).map((chatId) => chatName(store, chatId) ?? chatId);
    return [{ id, name: person.name, chats: where }];
  }).slice(0, limit);
}

/** Someone or some chat a message goes to: a person by id and name, or a chat the agent is in. */
export type Addressee = { person: { id: string; name: string } } | { chat: { id: string; name: string } };
/**
 * Who `to` names for a message: a chat the agent is in, by id or name; a person, by open_id or the one person with that
 * name; else why not, naming the people it could mean.
 */
export function addressee(store: Pick<Store, "get" | "keys">, to: string): Addressee | { problem: string } {
  const wanted = to.trim().replace(/^@/, "");
  const chats = chatsOf(store);
  const chat = chats.find((item) => item.chat_id === wanted || (!item.direct && item.name !== null && item.name.toLowerCase() === wanted.toLowerCase()));
  if (chat && !chat.direct) return { chat: { id: chat.chat_id, name: chat.name ?? chat.chat_id } };
  if (wanted.startsWith("oc_")) return { problem: `The agent is in no group ${wanted}: send to one of ${chats.filter((item) => !item.direct).map((item) => `${item.chat_id} (${item.name})`).join(", ") || "none"}` };
  if (wanted.startsWith("ou_")) {
    const name = personName(store, { source: SOURCE, id: wanted });
    return name ? { person: { id: wanted, name } } : { problem: `No one with id ${wanted} is in the chats the agent is in` };
  }
  // The closest names first: the whole name, then a name with a word that starts so, then any that contains it.
  const found = findPeople(store, wanted, 50);
  const lower = wanted.toLowerCase();
  const tiers = [found.filter((person) => person.name.toLowerCase() === lower),
    found.filter((person) => person.name.toLowerCase().split(/[\s·._-]+/).some((word) => word.startsWith(lower))), found];
  const matches = tiers.find((tier) => tier.length) ?? [];
  if (matches.length === 1) return { person: { id: matches[0]!.id, name: matches[0]!.name } };
  if (!matches.length) return { problem: `No one named ${wanted} is in the chats the agent is in; answer with chat and say so` };
  return { problem: `Several people match ${wanted}: ${matches.slice(0, 8).map((person) => `${person.id} ${person.name} (${person.chats.join(", ")})`).join("; ")}. Use the id of the one meant, or answer with chat and ask which` };
}
/** The people a message @s, by id: anyone in the directory, or all for everyone in the chat; else why not. */
export function mentionsFor(state: Pick<State, "get">, ids: readonly string[]): { id: string; name: string }[] | { problem: string } {
  const mentions: { id: string; name: string }[] = [];
  for (const id of new Set(ids)) {
    if (id === "all") { mentions.push({ id, name: "all" }); continue; }
    const name = personName(state, { source: SOURCE, id });
    if (!name) return { problem: `mentions: ${id} is no one the agent knows; use ids from the card` };
    mentions.push({ id, name });
  }
  return mentions;
}
/** The channel a message to `target` goes by: the person's direct messages, or into the chat itself. */
export const channelTo = (target: Addressee): ChannelRef => "person" in target ? feishuUserChannel(target.person.id)
  : { source: SOURCE, thread: `feishu:${target.chat.id}`, address: { chatId: target.chat.id, mode: "chat" } };
