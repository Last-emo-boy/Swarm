/**
 * The journal of the agent's talking paths (PLAN §B2): one row per model run of a consideration, an attend, a reflection,
 * a promise, a tidy or a router call, holding the card as it was sent, the raw answer, and the outcome the host took from
 * it. The agent's speech decisions are otherwise parsed and dropped: this is what lets an owner ask, for any past decision,
 * why the agent spoke or stayed silent. Rows are kept 14 days, pruned by the host, and live in the state directory only.
 */
import { key } from './core/index.js'
import type { Store } from './store.js'

/** What a run was: the paths that talk, and the router's calls. */
export type JournalKind = 'chatter' | 'attend' | 'reflect' | 'ticket_reflect' | 'promise' | 'reach_out' | 'tidy' | 'route' | 'assess' | 'followup'
/** What became of a run: it posted something, it stayed silent, its answer was dropped, it never asked the model, it failed, or the router decided. */
export type JournalOutcome = 'sent' | 'silent' | 'dropped' | 'skipped' | 'failed' | 'accept' | 'attach' | 'stop' | 'ignore' | 'command' | 'chat'
  | 'message' | 'accepted' | 'ignored' | 'unavailable'
/** Why an answer that asked for no model call was skipped, and what a run left behind: the notes it kept, the messages it queued. */
export interface JournalRun {
  /** `superagent_chatter`, `superagent_attend`, `superagent_memory`, `superagent_promise`, `superagent_route`, ... */
  purpose: string
  model?: string
  /** Exactly the strings handed to `complete`, and the card as sent. */
  system: string
  user: string
  outcome?: JournalOutcome
  /** The model's own reason, or why the host took the outcome it did. */
  reason?: string
  ticketId?: string
  /** The outbox message ids the run queued. */
  outbox?: string[]
  /** What the run kept in the agent's memory, as the notes it wrote. */
  notes?: string[]
  /** The raw answer, kept when the run's answer could not be used, or the router needed it again. */
  answer?: string
}
/** A run's place in the journal: what it was about, and which chain of attempts it belongs to. */
export interface JournalPlace { kind: JournalKind; key: string; purpose: string }
/** What a model call is about: the chat, the message, the ticket, the note, the subject or the person it serves. */
export interface JournalTarget { chat?: string; message?: string; ticket?: string; note?: string; subject?: string; person?: string }

/** How long the journal keeps a row. */
export const JOURNAL_DAYS = 14
/** How much of a raw answer or a failure message a row keeps. */
const TEXT_CHARS = 4000, REASON_CHARS = 500

const set = (values: readonly string[]) => [...new Set(values)]
/** The place of a model call in the journal, from its purpose and what it is about; undefined for a call the journal does not keep. */
export function journalPlace(purpose: string, target: JournalTarget | undefined): JournalPlace | undefined {
  if (!target) return undefined
  if (purpose === 'superagent_chatter' && target.chat) return { kind: 'chatter', key: `chat:${target.chat}`, purpose }
  if (purpose === 'superagent_attend' && target.chat) return { kind: 'attend', key: `chat:${target.chat}`, purpose }
  if (purpose === 'superagent_memory' && target.ticket) return { kind: 'ticket_reflect', key: `ticket:${target.ticket}`, purpose }
  if (purpose === 'superagent_memory' && target.chat) return { kind: 'reflect', key: `chat:${target.chat}`, purpose }
  if (purpose === 'superagent_memory' && target.subject) return { kind: 'tidy', key: `subject:${target.subject}`, purpose }
  if (purpose === 'superagent_promise' && target.note) return { kind: 'promise', key: `note:${target.note}`, purpose }
  if (purpose === 'superagent_route' && target.message) return { kind: 'route', key: `trigger:${target.message}`, purpose }
  if (purpose === 'superagent_assessment' && target.message) return { kind: 'assess', key: `trigger:${target.message}`, purpose }
  if (purpose === 'superagent_followup' && target.message) return { kind: 'followup', key: `trigger:${target.message}`, purpose }
  return undefined
}
/** `set` for a list of ids a run queued, if any. */
const queued = (ids: readonly string[] | undefined): { outbox?: string[] } => ids?.length ? { outbox: set(ids) } : {}

/**
 * The journal's rows: one per run, keyed by kind, subject and attempt, whose value gains its outcome after the run.
 * A run's start is one insert; its outcome one JSON patch of that row, so a run that crashes between them keeps its card
 * and reads as interrupted rather than losing it.
 */
export class Journal {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>, private readonly now = () => new Date()) {}
  /**
   * The number of the next run of a key: one past the newest attempt still stored, never a count, because the prune deletes
   * old rows and a count would then hand out a number a kept row already has.
   */
  private nextAttempt(kind: JournalKind, keyValue: string): number {
    return Number(this.store.db.prepare('SELECT IFNULL(MAX(attempt), -1) + 1 AS n FROM journal WHERE kind = ? AND key = ?').get(kind, keyValue)?.n ?? 0)
  }
  /**
   * Closes the runs of a key still open, as a retry: a second model call for one decision starts a new row, and the first
   * would otherwise read as a crash. A run that died between its start and its outcome is closed the same way.
   */
  private closeOpen(kind: JournalKind, keyValue: string, reason: string): void {
    this.store.db.prepare(`UPDATE journal SET value = json_patch(value, ?) WHERE kind = ? AND key = ?
      AND json_extract(value, '$.outcome') IS NULL`)
      .run(JSON.stringify({ outcome: 'dropped', reason }), kind, keyValue)
  }
  /** Records a run's start, with the card as sent, and returns its row id; the attempt follows the newest one of its key. */
  start(run: { kind: JournalKind; key: string; purpose: string; model?: string; system: string; user: string }): string {
    return this.store.atomic(() => {
      this.closeOpen(run.kind, run.key, 'retried')
      const attempt = this.nextAttempt(run.kind, run.key)
      const id = key('journal', run.kind, run.key, String(attempt))
      const value: JournalRun = { purpose: run.purpose, ...(run.model ? { model: run.model } : {}), system: run.system, user: run.user }
      this.store.db.prepare('INSERT INTO journal (id, at, kind, key, attempt, value) VALUES (?,?,?,?,?,?)')
        .run(id, this.now().toISOString(), run.kind, run.key, attempt, JSON.stringify(value))
      return id
    })
  }
  /** Records a run that never asked the model, such as a consideration in quiet hours: one insert, no card. */
  skip(kind: JournalKind, keyValue: string, outcome: JournalOutcome, reason: string, extra: { ticketId?: string } = {}): void {
    this.store.atomic(() => {
      const attempt = this.nextAttempt(kind, keyValue)
      const id = key('journal', kind, keyValue, String(attempt))
      const value: JournalRun = { purpose: '', system: '', user: '', outcome, reason: [...reason].slice(0, REASON_CHARS).join(''), ...extra }
      this.store.db.prepare('INSERT INTO journal (id, at, kind, key, attempt, value) VALUES (?,?,?,?,?,?)')
        .run(id, this.now().toISOString(), kind, keyValue, attempt, JSON.stringify(value))
    })
  }
  /** Keeps a run's raw answer, so a later question about it sees what the model wrote. */
  answer(id: string, answer: string): void {
    const value = JSON.stringify({ answer: [...answer].slice(0, TEXT_CHARS).join('') })
    this.store.db.prepare('UPDATE journal SET value = json_patch(value, ?) WHERE id = ?').run(value, id)
  }
  /**
   * Records what became of the newest run of `kind` under `key` that has no outcome yet: the same row `start` inserted,
   * patched, so a run the host could not finish keeps its card. One that found no such row, such as after a restart,
   * records itself as a row of its own rather than losing the outcome.
   */
  outcome(kind: JournalKind, keyValue: string, outcome: JournalOutcome, extra: { reason?: string; ticketId?: string; outbox?: readonly string[]; answer?: string; notes?: readonly string[] } = {}): void {
    const patch = JSON.stringify({ outcome, ...(extra.reason ? { reason: [...extra.reason].slice(0, REASON_CHARS).join('') } : {}),
      ...(extra.ticketId ? { ticketId: extra.ticketId } : {}), ...queued(extra.outbox), ...(extra.notes?.length ? { notes: extra.notes } : {}),
      ...(extra.answer ? { answer: [...extra.answer].slice(0, TEXT_CHARS).join('') } : {}) })
    this.store.atomic(() => {
      const row = this.store.db.prepare(`SELECT id FROM journal WHERE kind = ? AND key = ?
        AND json_extract(value, '$.outcome') IS NULL ORDER BY rowid DESC LIMIT 1`).get(kind, keyValue)
      if (row) { this.store.db.prepare('UPDATE journal SET value = json_patch(value, ?) WHERE id = ?').run(patch, String(row.id)); return }
      // No open run to patch: the outcome becomes a row of its own, with what it carries.
      const attempt = this.nextAttempt(kind, keyValue)
      const patched = JSON.parse(patch) as Partial<JournalRun>
      const value: JournalRun = { ...patched, purpose: patched.purpose ?? '', system: patched.system ?? '', user: patched.user ?? '' }
      this.store.db.prepare('INSERT INTO journal (id, at, kind, key, attempt, value) VALUES (?,?,?,?,?,?)')
        .run(key('journal', kind, keyValue, String(attempt)), this.now().toISOString(), kind, keyValue, attempt, JSON.stringify(value))
    })
  }
  /** The runs under `key`, oldest first; a limit keeps the newest of them. */
  byKey(keyValue: string, limit = 100): JournalRun[] {
    return this.store.db.prepare('SELECT value FROM journal WHERE key = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(keyValue, limit)
      .map((row) => JSON.parse(String(row.value)) as JournalRun).reverse()
  }
  /** The runs under any key starting with `prefix`, such as a short trigger id, oldest first; a limit keeps the newest. */
  byKeyPrefix(prefix: string, limit = 200): JournalRun[] {
    const pattern = `${prefix.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    return this.store.db.prepare("SELECT value FROM journal WHERE key LIKE ? ESCAPE '\\' ORDER BY at DESC, rowid DESC LIMIT ?").all(pattern, limit)
      .map((row) => JSON.parse(String(row.value)) as JournalRun).reverse()
  }
  /**
   * The runs under any of `keys` or starting with any of `prefixes`, oldest first, each with when it ran: what `why` shows
   * of the talking paths a ticket or a message touched. A row reachable by two keys (a chat run whose card held the message)
   * comes back once. The newest `limit` rows are read and returned oldest first, so a busy chat keeps the runs asked about.
   */
  history(keys: readonly string[], prefixes: readonly string[] = [], limit = 300): { at: string; kind: JournalKind; run: JournalRun }[] {
    const conditions: string[] = [], values: string[] = []
    if (keys.length) { conditions.push(`key IN (${keys.map(() => "?").join(",")})`); values.push(...keys) }
    for (const prefix of prefixes) {
      conditions.push("key LIKE ? ESCAPE '\\'")
      values.push(`${prefix.replace(/[\\%_]/g, (match) => `\\${match}`)}%`)
    }
    if (!conditions.length) return []
    const seen = new Set<string>()
    return this.store.db.prepare(`SELECT id, at, kind, value FROM journal WHERE ${conditions.join(" OR ")} ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(...values, limit).flatMap((row) => {
        const id = String(row.id)
        if (seen.has(id)) return []
        seen.add(id)
        return [{ at: String(row.at), kind: String(row.kind) as JournalKind, run: JSON.parse(String(row.value)) as JournalRun }]
      }).reverse()
  }
  /** The newest runs of a kind, oldest first: what status shows of the talking paths. */
  latestByKind(kind: JournalKind, limit = 5): JournalRun[] {
    return this.store.db.prepare('SELECT value FROM journal WHERE kind = ? ORDER BY rowid DESC LIMIT ?').all(kind, limit)
      .map((row) => JSON.parse(String(row.value)) as JournalRun).reverse()
  }
  /** Deletes the rows older than `days`; returns how many went. */
  prune(days = JOURNAL_DAYS): number {
    const before = new Date(this.now().getTime() - days * 86_400_000).toISOString()
    return Number(this.store.db.prepare('DELETE FROM journal WHERE at < ?').run(before).changes)
  }
}

/** The journal of a process that records the talking paths the host runs, if it has one. */
export interface JournalHost { readonly journal?: Journal }
/** A model call as the journal sees it: what it is about, and the strings it sends. */
export interface JournaledInput { purpose: string; system: string; user: string; model?: string; target?: JournalTarget }
/**
 * The one wrapper around `complete` (host.ts): it records each run's start and its failure, and the raw answer. What became
 * of an answer is semantic, so each talking path records its own outcome at its exit.
 */
export function journaled(journal: Journal | undefined, complete: (input: JournaledInput) => Promise<string>): (input: JournaledInput) => Promise<string> {
  if (!journal) return complete
  return async (input) => {
    const place = journalPlace(input.purpose, input.target)
    const id = place ? journal.start({ ...place, ...input }) : undefined
    let answer: string
    try {
      answer = await complete(input)
    } catch (error) {
      if (place) journal.outcome(place.kind, place.key, 'failed', { reason: error instanceof Error ? error.message : String(error), ...(input.target?.ticket ? { ticketId: input.target.ticket } : {}) })
      throw error
    }
    if (id) journal.answer(id, answer)
    return answer
  }
}
