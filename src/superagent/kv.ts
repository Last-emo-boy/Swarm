/**
 * Typed key-value store keys grouped by the component that owns and writes each family (from dsh-superagent's kv.ts).
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { GithubLink } from './github-link.js'
import type { Health } from './health.js'
import type { Lease, Placement } from './placement.js'
import type { Members, Said } from './people.js'
import type { Retry } from './sources/github.js'
import type { VmSlot } from './vm/vm-work.js'

/** Key of a KV record whose value has type `V`. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
export const record = <V>(key: string) => key as Key<V>
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Host: the process that holds the lock, the settings version it last applied, and its health snapshot for other processes. */
  host: {
    owner: record<{ pid: number; startedAt: string; heartbeatAt: string }>('host-owner'),
    applied: record<{ policyVersion: string; settings: unknown }>('host-applied-settings'),
    health: record<{ at: string; entries: Record<string, Health> }>('host-health'),
  },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /** Local Source: the requests a Swarm TUI or CLI queued that the host has taken in, by request id. */
  local: { taken: record<string>('local-taken-at') },
  /**
   * Mesh: where a ticket's worker runs, by ticket id or by the id of the request it was filed with, and the lease of the
   * paired node that runs it now, by ticket id. Only the node that owns the tickets writes them.
   */
  mesh: { placement: family<Placement>('mesh-placement:'), lease: family<Lease>('mesh-lease:') },
  /**
   * People's linked GitHub accounts, by the Source and id they write from (see github-link.ts), and the local tickets someone
   * wants a pull request from before they linked or before the ticket's patch is ready, by ticket id, with the message whose
   * sender wants it, which takes the ticket over once both are there (bot-commands.ts); only the host writes them.
   */
  links: { github: family<GithubLink, [source: string, actor: string]>('github-link:'),
    wanted: family<{ triggerId: string; at: string }, [ticket: string]>('github-link-wanted:') },
  /**
   * The agent in group chats (chatter.ts): by chat, when it last considered speaking, what it said there lately, from any
   * of its messages to the chat (outbox.ts), with the message it answered and whether that went in its topic, and when it
   * spoke there on its own.
   */
  chatter: { chat: family<{ consideredAt?: string; said: Said[]; spoke?: string[] }, [chat: string]>('chatter:') },
  /**
   * Who is who on Feishu (people.ts): each person's or bot's name by Source and id, and each chat's members as Feishu last
   * listed them, by chat id, which the Feishu Source keeps current.
   */
  people: { person: family<{ name: string; at: string }, [source: string, id: string]>('person:'),
    members: family<Members, [chat: string]>('chatter-members:'),
    /** When a ticket's worker sent its messages to people in the last hour, by ticket id (ticket-tools.ts). */
    sent: family<string[]>('messages-sent:') },
  /**
   * Ticket VMs (vm/vm-work.ts): the ticket each slot runs, under a lease its guest renews, by slot number; the tickets that
   * have a data disk, by ticket id, since their first boot; and of those, the ones whose disk is a volume of the cluster.
   */
  vm: { slot: family<VmSlot, [slot: string]>('vm-slot:'), disk: family<string>('vm-disk:'), cluster: family<string>('vm-cluster-disk:') },
  /** When a ticket's last update went to its person (notices.ts), by ticket id. */
  notices: { progress: family<string>('progress-sent:') },
  /** The harness profile a request was filed to run on, by the request's id, until it becomes a ticket's execution. */
  harness: { chosen: family<string>('harness-chosen:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision.
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
