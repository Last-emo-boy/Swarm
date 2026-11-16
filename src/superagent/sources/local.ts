/**
 * The local Source: requests and messages that a person types into the Swarm TUI or CLI. Each request starts a Thread of its
 * own; a later message on that Thread reaches its ticket's worker as a follow-up. Replies go to the same Thread, where the
 * TUI shows them from the outbox. The sender is the operator's OS account, which the Policy lists by default.
 */
import { userInfo } from "node:os";
import { z } from "zod/v4";
import { key, type ChannelRef, type Trigger } from "../core/index.js";
import { KV, type Family, type Key } from "../kv.js";
import type { Store } from "../store.js";
import type { ChatKind } from "./chat.js";
import type { SourceContext } from "./host.js";
import type { SourceKind } from "./kind.js";

export const SOURCE = "local";
/** The operator's id on the local Source: the OS account the TUI runs as. */
export function localOperator(): string {
  try {
    return userInfo().username || "operator";
  } catch {
    return "operator";
  }
}
/** The local Thread a request starts; a request's own id names it. */
export const localThread = (id: string) => ({ source: SOURCE, id });
export const localChannel = (threadId: string): ChannelRef => ({ source: SOURCE, thread: `${SOURCE}:${threadId}`, address: { thread: threadId } });

/**
 * A person's local message as a Trigger: on the Thread of `threadId`, or on a Thread of its own for a new request. It always
 * addresses the agent directly, as a message typed to Swarm does.
 */
export function localTrigger(input: { id: string; text: string; threadId?: string; actor?: string; at?: string; ticketId?: string; chatId?: string }): Trigger {
  const threadId = input.threadId ?? input.id;
  return {
    id: key("local", input.id),
    source: SOURCE,
    threads: [localThread(threadId)],
    actor: { source: SOURCE, id: input.actor ?? localOperator() },
    human: true,
    addressed: "direct",
    at: input.at ?? new Date().toISOString(),
    text: input.text,
    channel: localChannel(threadId),
    meta: { requestId: input.id, ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.chatId ? { chatId: input.chatId } : {}) }
  };
}

/** The TUI's one chat: where a message typed to the agent counts as chat, beside the local Threads a request starts. */
export const TUI_CHAT = "tui";

/**
 * The terminal as a chat kind: the one chat the TUI is, the operator in it, and the channel constructors over the flat local
 * address. It is what lets the superagent treat what a person types into the TUI as a chat message — bot commands, the
 * record of what the agent said there, and memory — rather than as a bare request.
 */
const tuiPerson = () => ({ id: localOperator(), name: localOperator() });
const tuiEntry = () => ({ source: SOURCE, chatId: TUI_CHAT, name: localOperator(), direct: true as const, people: 1 });

export const localChatKind: ChatKind = {
  source: SOURCE,
  platform: "Terminal",
  agent: () => ({ id: "swarm", name: "Swarm", ownIds: ["swarm"] }),
  // The terminal's one chat holds the operator and nobody else, by definition: no member record has to exist for it.
  directory: {
    chats: () => [tuiEntry()],
    chat: (_state, chatId) => chatId === TUI_CHAT ? tuiEntry() : undefined,
    people: (_state, chatId, limit) => chatId === TUI_CHAT ? [tuiPerson()].slice(0, limit) : [],
    findPeople: (_state, name, limit) => name.trim() && localOperator().toLowerCase().includes(name.trim().toLowerCase()) ? [{ id: localOperator(), name: localOperator(), chats: [TUI_CHAT] }].slice(0, limit) : [],
    person: (_state, id) => id === localOperator() ? tuiPerson() : undefined,
    personKey: (id) => id === localOperator(),
    chatKey: (id) => id === TUI_CHAT
  },
  thread: (chatId) => localThread(chatId),
  chat: (chatId) => localChannel(chatId),
  user: localChannel,
  update: (chatId) => localChannel(chatId),
  describe(channel) {
    // Only the terminal's own chat is a chat; a ticket's local Thread is a Thread, and its replies are not chat talk.
    return { ...(channel.address.thread === TUI_CHAT ? { chatId: TUI_CHAT } : {}), direct: true, mode: "chat" };
  },
  // The terminal answers by existing: there is no account or CLI behind it to ask.
  probe: async () => undefined
};

/** How often the host looks at the terminal's inbox while its Source runs. */
const INBOX_MS = 500;

/**
 * Queues a message typed into the TUI for the host to take in as chat: a durable row, so a TUI whose host runs in another
 * process (or starts later) is served too. The host's `localKind.watch` drains it; nothing is received here.
 */
export type LocalInboxMessage = { id: string; text: string; actor: string; at: string };
export function postLocalChat(store: Pick<Store, "set">, message: LocalInboxMessage): void {
  store.set(KV.local.inbox(message.id), message);
}

/** Takes every message the TUI queued into the inbox in as chat, one at a time, and returns what it took in. */
export function takeLocalInbox(ctx: {
  state: { get<V>(key: Key<V>): V | undefined; set(key: string, value: unknown): void; keys<V>(family: Family<V, never>): Key<V>[] };
  atomic<T>(work: () => T): T;
  receive(trigger: Trigger): unknown;
}): number {
  // Oldest first, so messages reach the router in the order they were typed: keys are random ids, so arrival means `at` and
  // then the id, which the inbox row carries (two messages inside one millisecond keep their minted order by id).
  const queued = ctx.state.keys(KV.local.inbox).map((inboxKey) => ({ inboxKey, message: ctx.state.get(inboxKey) }))
    .sort((a, b) => (a.message?.at ?? "").localeCompare(b.message?.at ?? "") || (a.message?.id ?? "").localeCompare(b.message?.id ?? ""));
  let taken = 0;
  for (const { inboxKey, message } of queued) {
    if (!message) { ctx.state.set(inboxKey, undefined); continue; }
    // The take and the receive are one transaction: a crash between them must not take the message in twice, nor lose it.
    ctx.atomic(() => {
      ctx.state.set(inboxKey, undefined);
      // On the terminal chat's own Thread, so the reply comes back there and the card reads it as chat.
      ctx.receive(localTrigger({ id: message.id, text: message.text, actor: message.actor, at: message.at, threadId: TUI_CHAT, chatId: TUI_CHAT }));
    });
    taken++;
  }
  return taken;
}

export const localKind: SourceKind<Record<string, never>> = {
  kind: SOURCE,
  title: "Swarm",
  enabledByDefault: true,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  health: [],
  scope: () => ({ listened: true, observed: false, row: "terminal" }),
  // The TUI reads replies to local Threads from the outbox, so a stored reply has reached its conversation.
  channel: {
    send: async () => "sent",
    link: () => ({ url: "", label: "Terminal" })
  },
  chat: localChatKind,
  /**
   * Drains the terminal's inbox while the Source runs: a message the TUI queued is taken in as chat through the same
   * `receive` Feishu's stream uses, so bot commands and the router see it exactly as they see a chat message. Only the
   * lock holder runs watchers, so there is one consumer whether the host runs in the TUI's process or beside it.
   */
  async watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
    await ctx.ready;
    while (!signal.aborted) {
      try { takeLocalInbox(ctx) } catch (error) { if (signal.aborted) return; throw error; }
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, INBOX_MS);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  },
  // A Thread key has the local prefix and nothing a Thread id cannot hold: a shape check, not a guess at what was meant.
  find: (query) => {
    const trimmed = query.trim();
    const id = trimmed.startsWith("local:") ? trimmed.slice("local:".length) : "";
    const wellFormed = id.length > 0 && [...id].every((char) => /[\w-]/.test(char));
    return { threads: wellFormed ? [trimmed] : [], terms: [] };
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    explicit: "A message typed into the Swarm TUI or CLI by an account on the list; the operator's OS account is on it by default."
  }
};
