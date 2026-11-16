/** Read-only Store queries for views, tools, and Source polling (from dsh-superagent's app/store-read.ts). */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Decision, Thread, Trigger } from './core/index.js'
import type { SourceRegistry } from './sources/registry.js'
import type { Dropped, Receipt, TimelinePlace } from './store.js'

/** The chat a message read is of: its Source, and the platform's id for the chat. */
export interface ChatRef { source: string; chatId: string }

/**
 * Builds the read queries over `db`. `sources` resolves the Source of a chat or person id for queries a caller gives only an
 * id to; it is looked up on each call because the registry is built after the Store that holds these reads.
 */
export function storeReads(db: DatabaseSync, sources: () => Pick<SourceRegistry, 'sourceOfPerson' | 'sourceOfChat'> | undefined = () => undefined) {
  const values = <T>(sql: string, ...parameters: SQLInputValue[]): T[] => db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  /** In SQL, a Decision that gave up on an explicit request because the model did not answer in time, as `unroutedRequest` tells one (client.ts). */
  const unrouted = "value ->> '$.kind' = 'unavailable' AND value ->> '$.reason[0].code' = 'timeout' AND value ->> '$.strength' = 'explicit'"
  return {
  /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
  recentTriggers: (offset = 0, limit = 50): Trigger[] => db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Trigger),
  /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
  triggerStats: (since: string): Record<string, { received: number; filtered: number; lastAt: string }> => {
    const result: Record<string, { received: number; filtered: number; lastAt: string }> = {}
    for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since))
      result[String(row.source)] = { received: Number(row.received ?? 0), filtered: Number(row.filtered ?? 0), lastAt: String(row.last ?? '') }
    return result
  },
  /**
   * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
   * and how many accept/reopen decisions those same arrivals produced.
   */
  flow: (since: string): { judged: number; accepted: number } => {
    const passed = "t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '$.filtered') IS NOT NULL)"
    const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE ${passed}`).get(since)
    const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since)
    return { judged: Number(judged?.n ?? 0), accepted: Number(accepted?.n ?? 0) }
  },
  triggers: (options: { source?: string; filtered?: boolean }, offset = 0, limit = 50): { items: Trigger[]; more: boolean } => {
    const where = [...(options.source ? ["json_extract(t.value, '$.source') = ?"] : []), ...(options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : [])]
    const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...(options.source ? [options.source] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Trigger), more: rows.length > limit }
  },
  /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
  threadTriggers: (threadKeyValue: string, limit = 50, before?: TimelinePlace, through = false): Trigger[] => {
    const place = before ? `AND (x.at, x.id) ${through ? '<=' : '<'} (?, ?)` : ''
    return values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${place}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse()
  },
  threadPage: (threadKeyValue: string, offset: number, limit: number): Trigger[] => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
  /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
  neighbours: (threadKeyValue: string, at: string, id: string): { before?: Trigger; after?: Trigger } => {
    const nearest = (side: '<' | '>') => values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === '<' ? 'DESC' : 'ASC'}, x.id ${side === '<' ? 'DESC' : 'ASC'} LIMIT 1`, threadKeyValue, at, id)[0]
    const before = nearest('<'), after = nearest('>')
    return { ...before ? { before } : {}, ...after ? { after } : {} }
  },
  /** Oldest trigger on a thread, used to title the thread in listings. */
  firstTrigger: (threadKeyValue: string, humanOnly = false): Trigger | undefined => {
    const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? 'AND x.human = 1' : ''} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue)
    return row ? JSON.parse(String(row.value)) as Trigger : undefined
  },
  search: (query: string, limit = 20): Trigger[] => {
    const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`, query, pattern, limit).map(row => JSON.parse(String(row.value)) as Trigger)
  },
  /** The Triggers whose id starts with `prefix`, up to `limit`: two are enough to tell a short id that names one message from one that names several. */
  triggersByPrefix: (prefix: string, limit = 2): Trigger[] => values('SELECT value FROM trigger WHERE substr(id, 1, length(?)) = ? LIMIT ?', prefix, prefix, limit),
  /** The Decisions that gave up on an explicit request because the model did not answer in time, dismissed or not, whose id starts with `prefix`, up to `limit`. */
  unroutedByPrefix: (prefix: string, limit = 2): Decision[] => values(`SELECT value FROM decision WHERE substr(id, 1, length(?)) = ? AND ${unrouted} LIMIT ?`, prefix, prefix, limit),
  /**
   * The newest of those Decisions that nobody dismissed. They are chosen here, before `limit` cuts the list: an Eval that
   * only starts again records an unavailable Decision too, and a dismissed one stays stored, so neither may take the place
   * of a request nobody has seen to yet.
   */
  unroutedDecisions: (limit = 50): Decision[] => values('SELECT value FROM decision INDEXED BY decision_unrouted WHERE unrouted = 1 ORDER BY rowid DESC LIMIT ?', limit),
  recentDecisions: (offset = 0, limit = 50): Decision[] => db.prepare('SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Decision),
  /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
  decisions: (options: { kinds: string[]; since: string }, offset: number, limit: number): { items: Decision[]; more: boolean } => {
    const where = [...(options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => '?').join(',')})`] : []),
      ...(options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : [])]
    const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`)
      .all(...options.kinds, ...(options.since ? [options.since] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Decision), more: rows.length > limit }
  },
  /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
  decisionsOfKinds: (kinds: string[], limit = 30): Decision[] => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map(row => JSON.parse(String(row.value)) as Decision),
  /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
  failingReplies: (): (Receipt & { attempts: number; error: string })[] => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 AND o.value ->> '$.status' = 'pending' ORDER BY e.seq`).all()
    .map(row => ({ ...JSON.parse(String(row.value)) as Receipt, attempts: Number(row.attempts), error: String(row.error) })),
  droppedReplies: (limit = 20): Dropped[] =>
    values('SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?', limit),
  droppedSince: (since: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?').get(since)?.n ?? 0),
  /**
   * How many messages a sender addressed to the agent in the window [`from`, `to`): those it took in, and its bot commands,
   * but not the ones its Source filtered or that the request limit held back.
   */
  requests: (actor: { source: string; id: string }, from: string, to: string): number => Number(db.prepare(`SELECT COUNT(*) AS n FROM trigger t
    LEFT JOIN disposition d ON d.id = t.id WHERE t.at >= ? AND t.at < ? AND t.value ->> '$.actor.source' = ? AND t.value ->> '$.actor.id' = ?
    AND t.value ->> '$.addressed' IS NOT NULL AND d.value ->> '$.filtered' IS NULL AND IFNULL(d.value ->> '$.command', '') <> 'limit'`)
    .get(from, to, actor.source, actor.id)?.n ?? 0),
  /**
   * The latest `limit` messages people (and with `bots`, other bots too) wrote in a chat of `chat`'s Source at or after `since`,
   * newest first; with `oldest`, the earliest `limit` of them instead, which a reflection pages through a long backlog with.
   */
  chatMessages: (chat: ChatRef, since: string, limit: number, bots = false, oldest = false): Trigger[] => values<Trigger>(`SELECT value FROM trigger WHERE at >= ?
    AND value ->> '$.source' = ? AND value ->> '$.meta.chatId' = ? AND (? OR value ->> '$.human' = 1) ORDER BY at ${oldest ? 'ASC, rowid ASC' : 'DESC, rowid DESC'} LIMIT ?`,
    since, chat.source, chat.chatId, bots ? 1 : 0, limit),
  /**
   * The chat of a person's latest direct message to the agent, if they ever wrote one. Without a Source named, the one whose
   * directory holds the id as a person is used; a person no installed kind knows has none.
   */
  directChat: (person: string, source = sources()?.sourceOfPerson(person)): string | undefined => source === undefined ? undefined
    : (db.prepare(`SELECT value ->> '$.meta.chatId' AS chat FROM trigger WHERE value ->> '$.source' = ?
      AND value ->> '$.actor.id' = ? AND value ->> '$.meta.direct' = 1 ORDER BY at DESC LIMIT 1`).get(source, person) as { chat?: string } | undefined)?.chat ?? undefined,
  /** The Source whose chat kind's directory holds `chatId` as a chat, when one does; for a read given only an id. */
  sourceOfChat: (chatId: string): string | undefined => sources()?.sourceOfChat(chatId),
  subscribedThreads: (source?: string): Thread[] => source
    ? values('SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid', source)
    // Force the partial index so SQLite does not scan the entire table in rowid order.
    : values('SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid'),
  }
}
