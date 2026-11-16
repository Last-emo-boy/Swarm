/** SourceKind contract: configuration schema, scope, Policy part, channel, thread context and execution variables (from dsh-superagent's sources/kind.ts, without the web panel's form fields). */
import type { z } from 'zod/v4'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.js'
import type { Commands } from '../commands.js'
import type { Deployment } from '../setup.js'
import type { SourceContext, SourceHost } from './host.js'
import type { ChatKind } from './chat.js'

export interface VariableSpec { key: string; description: string }
/** A receiving scope of the admission table, and which of its cells apply there: unaddressed cells only where the Source receives every message. */
export interface AdmissionRowView { id: string; label: string; note: string; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
export interface EnvironmentInput<C> { deployment: Deployment; config: C; trigger?: Trigger }
/** Policy extension for a source kind: who may originate work in the Source's own identities, and optional roster sync. */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>
  /** What the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: string
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`). */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  sync?: { ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
export interface ChannelLink { url: string; label: string; triggerId?: string }
export type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>
/**
 * What a channel sends with: the CLIs, the kind's own validated configuration (resolved at delivery time, so it matches the
 * settings a delivery attempt starts under), and where it tells the id the conversation gave the message it posted.
 */
export type SendHost<C = Record<string, unknown>> = Pick<SourceContext, 'commands'> & {
  config: C
  posted?(remote: { messageId: string; chatId?: string }): void
}
/** Outbound messaging adapter for a source kind's threads. */
export interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: SendHost<C>, message: OutboundMessage): Promise<'sent' | 'gone'>
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** One cheap check a kind can run on demand: a CLI status read, never a poll loop. */
export interface SourceCheck<C> {
  /** One of the kind's declared `health` entries, which the registry claims; a chat loop's own entry must stay separate. */
  entry: string
  /** Resolves to a short ready detail, throws the failure text. Runs at most on the host's own slow tick. */
  verify(commands: Commands, deployment: Deployment, config: C): Promise<string>
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message never authorizes work on its own. */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** Bounded thread context reader used by assessments to inspect messages around a trigger. */
export interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
}
/** A file or image a Trigger's message names, by the platform's own key for it. */
export interface AttachmentRef { file_key: string; type: 'file' | 'image'; name?: string }
/** What a worker reads of one attachment; `base64` is for the worker's own tools to save, never for its model. */
export interface AttachmentRead extends AttachmentRef {
  name: string; format: string; bytes: number; text?: string; text_note?: string; base64?: string; note?: string
}
/**
 * A kind's attachments and the chat reads a ticket's worker may ask for: the Feishu-shaped paths the core once spelled
 * itself, behind the kind that owns them. A kind without `files` has neither; the attachment tool says so by name.
 */
export interface SourceFiles<C> {
  /** Resource word ticket reads are addressed under ('feishu'), so `read` routes by the kind's own prefix. */
  prefix: string
  /** The attachments a Trigger's message names, in the order they appear. */
  attachments(trigger: Trigger): AttachmentRef[]
  /** Downloads one attachment and reads it (text where extractable, bytes up to the host's inline limit). */
  read(commands: Commands, trigger: Trigger, ref: AttachmentRef, config: C): Promise<AttachmentRead>
  /** Answers a ticket `read` resource under `prefix/…`. */
  readResource(commands: Commands, trigger: Trigger, resource: string, config: C): Promise<unknown>
}
/** A kind's files with its configuration already bound: what the ticket tools hold at call time. */
export type BoundSourceFiles = Omit<SourceFiles<never>, 'read' | 'readResource'> & {
  read(commands: Commands, trigger: Trigger, ref: AttachmentRef): Promise<AttachmentRead>
  readResource(commands: Commands, trigger: Trigger, resource: string): Promise<unknown>
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string
  title: string
  /** Whether the instance is on when the settings do not mention it. */
  enabledByDefault?: boolean
  /** Validates stored configuration and fills defaults. */
  schema: z.ZodType<C>
  /** Health entry names owned by this kind; no other kind or core loop may report them. */
  health: string[]
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  channel?: SourceChannel<C>
  /** What the kind's chats *are*: the platform name, the agent's identity there, its directory, and the channel constructors the core must not spell itself. */
  chat?: ChatKind
  threadContext?: ThreadContext<C>
  /** Maps a search query to candidate Thread keys (such as `github:12`) and Trigger search terms. */
  find?(query: string): { threads: string[]; terms: string[] }
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
  /** The Source's polling loop, run by the host while the instance is enabled; it returns once `signal` aborts. */
  watch?(ctx: SourceContext, signal: AbortSignal): Promise<void>
  /** Account sign-in, run once in a while and reported on its own health entry; never on every pass. */
  check?: SourceCheck<C>
  /** Attachments and chat reads a ticket's worker may ask this kind for; absent when it has none. */
  files?: SourceFiles<C>
}
export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
