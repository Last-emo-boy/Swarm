/**
 * The local Source: requests and messages that a person types into the Swarm TUI or CLI. Each request starts a Thread of its
 * own; a later message on that Thread reaches its ticket's worker as a follow-up. Replies go to the same Thread, where the
 * TUI shows them from the outbox. The sender is the operator's OS account, which the Policy lists by default.
 */
import { userInfo } from "node:os";
import { z } from "zod/v4";
import { key, type ChannelRef, type Trigger } from "../core/index.js";
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
export function localTrigger(input: { id: string; text: string; threadId?: string; actor?: string; at?: string; ticketId?: string }): Trigger {
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
    meta: { requestId: input.id, ...(input.ticketId ? { ticketId: input.ticketId } : {}) }
  };
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
    link: () => ({ url: "", label: "Swarm" })
  },
  find: (query) => ({ threads: /^local:[\w-]+$/.test(query.trim()) ? [query.trim()] : [], terms: [] }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    explicit: "A message typed into the Swarm TUI or CLI by an account on the list; the operator's OS account is on it by default."
  }
};
