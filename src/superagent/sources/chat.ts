/** What a chat *is*, beside what `channel` does: the platform's name, the agent's identity there, its directory of chats and people, and the constructors for thread keys and channel addresses that the core must not spell itself. */
import type { ChannelRef, ThreadRef } from '../core/index.js'
import type { Commands } from '../commands.js'
import type { Deployment } from '../setup.js'
import type { Health } from '../health.js'
import type { Family, Key } from '../kv.js'

/** The agent as the platform knows it: its id, its display name (empty when the deployment gave none), and every id it may appear as (Feishu: bot id and app id). */
export interface ChatAgent { id: string; name: string; ownIds: readonly string[] }
/** A chat the agent is in, as the directory lists it. */
export interface ChatEntry { source: string; chatId: string; name: string | null; direct?: true; people?: number }
/** A person (or bot) in a chat, by the platform's own id for them. */
export interface ChatPerson { id: string; name: string; bot?: true }
/** What the directory reads from: the Store, or any in-memory stand-in with the same shape. */
export interface ChatState {
  get<V>(key: Key<V>): V | undefined
  keys<V>(family: Family<V, never>): Key<V>[]
}
/** Where a channel points: the chat, the message it answers, the person's direct messages, and whether the words go in the chat itself or into a reply. */
export interface ChannelPlace { chatId?: string; messageId?: string; userId?: string; direct: boolean; mode: 'chat' | 'user' | 'reply' }
/** The chat knowledge the core is missing: chats by id, who is in them, and which ids are people of this kind. */
/*
 * A kind's chat ids are unique among the installed kinds: the chatter's per-chat state, the outbox's record of what the
 * agent said, and memory's reflection marks are keyed by chat id alone (kv.ts), so two kinds sharing one id share them.
 */
export interface ChatDirectory {
  chats(state: ChatState): ChatEntry[]
  chat(state: ChatState, chatId: string): ChatEntry | undefined
  people(state: ChatState, chatId: string, limit: number): ChatPerson[]
  findPeople(state: ChatState, name: string, limit: number): { id: string; name: string; chats: string[] }[]
  /** The person (or bot) by this kind's own id for them, when the directory knows them. */
  person(state: ChatState, id: string): ChatPerson | undefined
  /** True for a person id this kind's directory holds (Feishu: `ou_…`). */
  personKey(id: string): boolean
  /** True for a chat id this kind's directory holds (Feishu: `oc_…`). */
  chatKey(id: string): boolean
}
/** A chat platform's knowledge and constructors. The outbound adapter stays `SourceChannel`; this is what the core asks a chat *is*. */
export interface ChatKind {
  /** The Source kind this chat belongs to: the `source` of every trigger, channel and directory entry it makes. */
  source: string
  /** The platform word prompts and cards say: 'Feishu'. */
  platform: string
  /** The agent's own identity there, once the deployment resolved it, from its configuration when the platform keeps it there. */
  agent(deployment: Deployment, config: Record<string, unknown>): ChatAgent | undefined
  directory: ChatDirectory
  /** The thread a chat's messages belong to; its key is the `thread` of every channel into that chat. */
  thread(chatId: string): ThreadRef
  /** Posts into the chat itself. */
  chat(chatId: string): ChannelRef
  /** A person's direct messages. */
  user(userId: string): ChannelRef
  /** Answers a message: in its topic, or with `inChat` into the chat itself. */
  update(chatId: string, messageId: string, direct: boolean, inChat: boolean): ChannelRef
  /** What a channel points at, whether it was built here or stored. */
  describe(channel: ChannelRef): ChannelPlace
  /**
   * Whether a reply is held to the IM word limit (100 words) before it is sent. A platform that shows a fixed-size bubble
   * needs it; a terminal, which shows what it is given, does not.
   */
  imWords?: true
  /**
   * Whether the platform's API is reachable; throws with the platform's message when it is not. Required: a kind whose watch
   * loop claims `ready` must say how to tell that the claim is stale, so an adapter cannot report ready while every call fails.
   */
  probe(commands: Commands, deployment: Deployment, config: Record<string, unknown>): Promise<void>
}

/** How often a chat kind's API is probed while its watch loop runs. */
export const PROBE_MS = 60_000
/** Consecutive failed probes before the kind's health reads `error`, so a single outage second does not flap it. */
export const PROBE_FAILURES = 3
/**
 * The health a chat kind's threads are reported with while its API is probed. A claim of `ready` turns `error` with the
 * probe's message once `PROBE_FAILURES` probes in a row have failed, and turns `ready` again only on a probe that passes,
 * so a stream that stays up while every API call fails never reads ready.
 */
export class ChatHealth {
  private failures = 0
  private failure: string | undefined
  /** Records one probe's outcome; a pass also reports the entries `ready` again through `report`. */
  record(error: string | undefined, report: (entry: Health) => void): void {
    if (error === undefined) {
      const recovered = this.failures > 0
      this.failures = 0
      this.failure = undefined
      if (recovered) report({ state: 'ready', detail: 'The platform answers again', at: new Date().toISOString() })
      return
    }
    this.failures += 1
    this.failure = error
    if (this.failures === PROBE_FAILURES) report({ state: 'error', detail: error })
  }
  /** The entry a claim of `ready` is reported as: the claim while the API answers, its failure while it does not. */
  claim(ready: Health): Health {
    return this.failures >= PROBE_FAILURES && this.failure ? { state: 'error', detail: this.failure } : ready
  }
}
