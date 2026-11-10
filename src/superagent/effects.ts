/** Durable effect queue: side effects stored in the command's transaction and run after commit (from dsh-superagent's app/effects.ts). */
/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
 */
export class Later extends Error {}
/** Consecutive failures before an effect kind reports an error, matching the Sources poll failure threshold. */
export const FAILURES_BEFORE_ERROR = 3
import type { HealthBoard, HealthEntry } from './health.js'
import type { Store } from './store.js'

export interface EffectPayloads {
  /** Route or assess an Eval's candidate with the model; the key is the Eval ID. */
  assessment: { triggerId: string }
  /** Ask the model whether a person's follow-up that reached tickets asks to stop their work; the key is the Trigger ID. */
  followup: { triggerId: string }
  /** Launch a pending Assignment; the key is the Assignment ID. */
  launch: { ticketId: string; assignmentId: string }
  /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
  delivery: { ticketId: string }
  /** Stop an Assignment's worker process; the key is the Assignment ID. */
  stop: { ticketId: string; reason: string }
  /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
  reply: Record<string, never>
  /** Ask the model whether the agent says something in a group chat after a lull; the key is the chat ID. */
  chatter: { chatId: string }
  /** Ask the model what the agent remembers from a chat's new messages or an ended ticket; the key is `chat:<id>` or `ticket:<id>`. */
  reflect: { chatId?: string; ticketId?: string }
  /** Keep a promise that fell due: write and send its message; the key is the note's ID. */
  promise: { noteId: string }
  /** Tidy a subject's notes into fewer; the key is the subject. */
  consolidate: { about: string }
}
export type EffectKind = keyof EffectPayloads
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
  limit: () => number
  /** Initial and maximum retry backoff delays, in milliseconds. */
  retry: readonly [number, number]
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
  ordered: boolean
  /** When true, repeated failures do not mark the effect kind's health entry as `error` (used when failures are already surfaced on a ticket). */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` preserves the row's queue position; `generation` increments on payload updates so a running attempt does not delete a newer payload. */
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
type Task = { kind: EffectKind; key: string; done: Promise<void> }
/** The KV key of the effect queue's position counter. */
const SEQ_KEY = 'effect-seq'

/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Any process may enqueue; only the host process that called `start` runs handlers. Queue positions come from a counter in
 * the database, so rows enqueued by different processes keep one order.
 */
export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
  private readonly broken = new Set<EffectKind>()
  private scheduled = false
  /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
  private started = false
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {
    store.db.prepare(`INSERT OR IGNORE INTO kv (key, value) VALUES ('${SEQ_KEY}', (SELECT IFNULL(MAX(seq), 0) FROM effect))`).run()
  }
  /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    // A counter that never repeats, also across processes and after a row is deleted, so a re-queued row never takes the
    // position of the attempt still running for its key.
    const seq = Number(this.store.db.prepare(`UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = '${SEQ_KEY}' RETURNING value`).get()?.value)
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), seq, this.now(), new Date(this.now()).toISOString())
    this.kick()
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  pending(kind: EffectKind, key?: string): boolean {
    return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key)
  }
  /** Whether an attempt of the effect runs now. */
  running(kind: EffectKind, key: string): boolean {
    return [...this.tasks].some(task => task.kind === kind && task.key === key)
  }
  /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
  cancel(kind: EffectKind, key: string): void {
    this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    this.store.afterCommit(() => { this.report(kind) })
  }
  start(): void { this.started = true; this.kick() }
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // Ordered kinds block behind their oldest row even when it is not yet due; limit() is queried only after ready rows exist.
        const rows = (handler.ordered
          ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
          : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
            .all(kind, this.now(), 16 + running.size)) as unknown as Row[]
        const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key))
        let room = ready.length ? handler.limit() - running.size : 0
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
  }
  private run(kind: EffectKind, handler: Handler<never>, row: Row): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    this.tasks.add(task)
  }
  private async attempt(kind: EffectKind, handler: Handler<never>, row: Row): Promise<void> {
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    // Match seq and generation so a row replaced or re-queued while running is not overwritten.
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation] as const
    if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow)
    // Leave running rows untouched on shutdown so they retry on the next start.
    else if (this.stopped) return
    else if (failure.error instanceof Later) {
      this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow)
    } else {
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
        .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow)
    }
    if (!this.stopped) this.report(kind)
  }
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
    const waiting = Number(row?.waiting ?? 0)
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting'
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${String(row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}
