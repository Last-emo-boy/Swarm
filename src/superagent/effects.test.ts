/** The durable effect queue: coalescing, per-kind limits, retries with backoff, health and shutdown. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { expect, vi } from './testing/expect.js'
import { Effects, GIVE_UP_ATTEMPTS, Later } from './effects.js'
import { ChatterRoom } from './chatter.js'
import { ModelAssessor } from './assessor.js'
import { key as keyOf } from './core/index.js'
import type { SuperagentClient } from './client.js'
import { Journal } from './journal.js'
import { Store } from './store.js'
import { HealthBoard } from './health.js'
import { deferred } from './testing/fixtures.js'

let directory: string
let store: Store
let clock: number
let board: HealthBoard
let health: Readonly<Record<string, unknown>>
let effects: Effects
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'effects-'))
  store = new Store(join(directory, 'db.sqlite'))
  clock = Date.parse('2026-09-09T00:00:00Z')
  board = new HealthBoard()
  health = board.all
  effects = new Effects(store, board, () => clock)
  effects.start()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
// Upstream's relay and notice effects belong to its main Session; these specs exercise the queue through Swarm's followup and stop kinds.
const relay = (text: string) => ({ triggerId: text })

it('runs an effect queued inside a transaction once it commits, and none from a transaction that rolled back', async () => {
  const run = vi.fn(async () => {})
  effects.handle('followup', run)
  store.atomic(() => { effects.enqueue('followup', 'kept', relay('a')) })
  expect(() => store.atomic(() => { effects.enqueue('followup', 'dropped', relay('b')); throw new Error('rolled back') })).toThrow('rolled back')
  await effects.idle()
  expect(run.mock.calls).toEqual([[relay('a'), 'kept']])
  expect(effects.pending('followup')).toBe(false)
})

it('keeps one effect per key with the latest payload, and runs it again when a new payload arrives while it runs', async () => {
  const hold = deferred()
  const run = vi.fn(async (payload: { triggerId: string }) => { if (payload.triggerId === 'first') await hold.promise })
  effects.handle('followup', run)
  effects.enqueue('followup', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  effects.enqueue('followup', 'k', relay('second')); effects.enqueue('followup', 'k', relay('third'))
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.triggerId)).toEqual(['first', 'third'])
})

it('runs a kind oldest first, as many at once as its limit allows, and holds it while the limit is 0', async () => {
  const holds = new Map<string, ReturnType<typeof deferred<void>>>()
  let limit = 2
  const run = vi.fn(async (_payload: unknown, key: string) => { const hold = deferred(); holds.set(key, hold); await hold.promise })
  effects.handle('launch', run, { limit: () => limit })
  for (const key of ['a', 'b', 'c']) effects.enqueue('launch', key, { ticketId: key, assignmentId: key })
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b']))
  limit = 0
  holds.get('a')!.resolve()
  await vi.waitFor(() => expect(effects.pending('launch', 'a')).toBe(false))
  effects.kick(); await Promise.resolve()
  expect(run).toHaveBeenCalledTimes(2)
  limit = 2
  holds.get('b')!.resolve()
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b', 'c']))
  holds.get('c')!.resolve()
  await effects.idle()
})

it('keeps an effect\'s place in its queue when it is queued again with a new payload', async () => {
  const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
  let room = 0
  effects.handle('launch', run, { limit: () => room })
  store.atomic(() => {
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
    effects.enqueue('launch', 'second', { ticketId: 't2', assignmentId: 'a2' })
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
  })
  await effects.idle()
  room = 1
  await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second'])
})

it('retries a failed effect after a delay that doubles up to its maximum, and reports the kind in error after three failures', async () => {
  let fail = true
  const run = vi.fn(async () => { if (fail) throw new Error('session busy') })
  effects.handle('stop', run, { retry: [1000, 3000] })
  effects.enqueue('stop', 'prompts', { ticketId: 't', reason: 'Prompt configuration saved' })
  await effects.idle()
  expect(health.stop).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  for (const wait of [1000, 2000, 3000, 3000]) {
    clock += wait - 1; await effects.idle()
    const calls = run.mock.calls.length
    clock += 1; await effects.idle()
    expect(run).toHaveBeenCalledTimes(calls + 1)
    if (wait === 2000) expect(health.stop).toMatchObject({ state: 'error', detail: expect.stringContaining('1 waiting since 2026-09-09T00:00:00.000Z; the last failure: Error: session busy') })
  }
  fail = false
  clock += 3000; await effects.idle()
  expect(health.stop).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  expect(effects.pending('stop')).toBe(false)
})

it('starts nothing once drained, keeps what waits and what shutdown cut short, and runs it after the next start', async () => {
  const hold = deferred()
  effects.handle('followup', async () => { await hold.promise; throw new Error('aborted') })
  effects.enqueue('followup', 'cut', relay('a'))
  await vi.waitFor(() => expect(effects.pending('followup', 'cut')).toBe(true))
  await Promise.resolve()
  const drained = effects.drain()
  effects.enqueue('followup', 'later', relay('b'))
  hold.resolve(); await drained
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.start()
  const run = vi.fn(async (_payload: { triggerId: string }, _key: string) => {})
  next.handle('followup', run)
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['cut', 'later'])
})

it('lets a handler defer an effect without a failure, until a later dispatch after its first delay', async () => {
  let later = true
  const run = vi.fn(async () => { if (later) throw new Later('paused') })
  effects.handle('launch', run, { retry: [5000, 60_000] })
  effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' })
  await effects.idle()
  expect(health.launch).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  later = false
  clock += 4999; await effects.idle()
  expect(run).toHaveBeenCalledOnce()
  clock += 1; await effects.idle()
  expect(run).toHaveBeenCalledTimes(2)
  expect(effects.pending('launch')).toBe(false)
})

it('runs an ordered kind one at a time in the order queued, and holds the later effects while an earlier one fails', async () => {
  const failing = new Set(['first'])
  const run = vi.fn(async (_payload: { triggerId: string }, key: string) => { if (failing.has(key)) throw new Error('offline') })
  effects.handle('followup', run, { ordered: true, limit: () => 4, retry: [1000, 1000] })
  effects.enqueue('followup', 'first', relay('a')); effects.enqueue('followup', 'second', relay('b'))
  await effects.idle()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first'])
  failing.clear()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first', 'first', 'second'])
})

it('keeps a quiet kind\'s failures out of its health, and asks no limit while nothing is due', async () => {
  const limit = vi.fn(() => 4)
  effects.handle('delivery', async () => { throw new Error('Session gone') }, { quiet: true, limit, retry: [1000, 1000] })
  effects.kick(); await effects.idle()
  expect(limit).not.toHaveBeenCalled()
  effects.enqueue('delivery', 't', { ticketId: 't' })
  for (let attempt = 0; attempt < 4; attempt++) { await effects.idle(); clock += 1000 }
  expect(health.delivery).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
})

it('keeps an effect cancelled and queued again while its first run goes on, which the first run does not end', async () => {
  const hold = deferred<void>()
  const run = vi.fn(async (_payload: { triggerId: string }, _key: string) => { if (run.mock.calls.length === 1) await hold.promise })
  effects.handle('followup', run)
  effects.enqueue('followup', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  effects.cancel('followup', 'k')
  effects.enqueue('followup', 'k', relay('second'))
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.triggerId)).toEqual(['first', 'second'])
  expect(effects.pending('followup')).toBe(false)
})

it('queues an effect after a restart behind the ones that waited, for a kind that keeps its order', async () => {
  const hold = deferred<void>()
  effects.handle('followup', async () => { await hold.promise; throw new Error('aborted') }, { ordered: true })
  effects.enqueue('followup', 'first', relay('a'))
  effects.enqueue('followup', 'second', relay('b'))
  await vi.waitFor(() => expect(effects.pending('followup', 'first')).toBe(true))
  const drained = effects.drain()
  hold.resolve(); await drained
  // Sequence numbers continue across restarts so newly queued effects run after existing pending ones.
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.enqueue('followup', 'third', relay('c'))
  next.start()
  const run = vi.fn(async (_payload: { triggerId: string }, _key: string) => {})
  next.handle('followup', run, { ordered: true })
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second', 'third'])
})

it('reports a failure of the queue itself under its kind, until a dispatch of that kind succeeds again', async () => {
  let broken = true
  effects.handle('followup', async () => {}, { limit: () => { if (broken) throw new Error('database is locked'); return 1 } })
  effects.enqueue('followup', 'k', relay('a'))
  await effects.idle()
  expect(health.followup).toMatchObject({ state: 'error', detail: 'The effect queue failed: Error: database is locked' })
  broken = false
  effects.kick()
  await effects.idle()
  expect(health.followup).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
})

it('refuses a second handler for a kind', () => {
  effects.handle('followup', async () => {})
  expect(() => effects.handle('followup', async () => {})).toThrow('The followup effects already have a handler')
})

it('gives up on an effect that keeps throwing after its cap, journals why, and leaves nothing waiting', async () => {
  const journal = new Journal(store, () => new Date(clock))
  let throws = true
  const run = vi.fn(async () => { if (throws) throw new Error('the provider is down') })
  // The talking paths' retry: the first wait, then doubling, with GIVE_UP_ATTEMPTS tries in all.
  const waits = [240_000, 480_000, 960_000, 1_920_000]
  effects.handle('chatter', run, { retry: [240_000, 3_600_000], giveUp: GIVE_UP_ATTEMPTS,
    onGiveUp: (chatId, _payload, error) => journal.outcome('chatter', `chat:${chatId}`, 'dropped', { reason: `gave up: ${String(error)}` }) })
  effects.enqueue('chatter', 'c1', { chatId: 'c1' })
  await effects.idle()
  for (const wait of waits) {
    expect(run).not.toHaveBeenCalledTimes(GIVE_UP_ATTEMPTS)
    clock += wait - 1; await effects.idle()
    clock += 1; await effects.idle()
  }
  expect(run).toHaveBeenCalledTimes(GIVE_UP_ATTEMPTS)
  expect(effects.pending('chatter')).toBe(false)
  expect(health.chatter).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  expect(journal.byKey('chat:c1').at(-1)).toMatchObject({ outcome: 'dropped', reason: expect.stringContaining('gave up: Error: the provider is down') })
  // Nothing is billed after the cap, even long after.
  clock += 24 * 3_600_000; await effects.idle()
  expect(run).toHaveBeenCalledTimes(GIVE_UP_ATTEMPTS)
  // A later payload starts a fresh count.
  throws = false
  effects.enqueue('chatter', 'c1', { chatId: 'c1' })
  await effects.idle()
  expect(run).toHaveBeenCalledTimes(GIVE_UP_ATTEMPTS + 1)
})

/** Installs a handler and returns the options it registered for a kind, which the class keeps private. */
function installedOptions(effects: Effects, kind: string, install: () => void): { onGiveUp?: (key: string, payload: unknown, error: unknown) => void } {
  let found: { onGiveUp?: (key: string, payload: unknown, error: unknown) => void } = {}
  const handle = effects.handle.bind(effects)
  const capture = (name: string, run: unknown, options?: unknown) => {
    if (name === kind) found = (options ?? {}) as typeof found
    return handle(name as never, run as never, options as never)
  }
  effects.handle = capture as typeof effects.handle
  install()
  return found
}

it('journals a dropped attend under its chat id, not the composite key its row is queued under', () => {
  const journal = new Journal(store, () => new Date(clock))
  const settings = { paused: false, chatter: { chats: ['room1'] } }
  const client = { journal, effects, settings: () => settings } as unknown as SuperagentClient
  const options = installedOptions(effects, 'attend', () => new ChatterRoom({ client, now: () => clock, complete: async () => '{}' }).install())
  // The production key attend is queued under: a hash of the chat and the time read, never the chat id itself.
  const rowKey = keyOf('attend', 'room1', new Date(clock).toISOString())
  options.onGiveUp?.(rowKey, { chatId: 'room1', ids: ['m1'] }, new Error('the provider is down'))
  expect(journal.byKey('chat:room1').at(-1)).toMatchObject({ outcome: 'dropped', reason: expect.stringContaining('the provider is down') })
  expect(journal.byKey(`chat:${rowKey}`)).toEqual([])
})

it('journals a dropped assessment under its trigger id, not the Eval id its row is queued under', () => {
  const journal = new Journal(store, () => new Date(clock))
  const settings = { paused: false }
  const client = { journal, effects, settings: () => settings } as unknown as SuperagentClient
  const options = installedOptions(effects, 'assessment', () =>
    new ModelAssessor({ client, configured: () => false, complete: async () => '{}' }).install())
  const evalId = 'e0a1'.repeat(8)
  options.onGiveUp?.(evalId, { triggerId: 'om_1' }, new Error('the provider is down'))
  expect(journal.byKey('trigger:om_1').at(-1)).toMatchObject({ outcome: 'dropped', reason: expect.stringContaining('the provider is down') })
  expect(journal.byKey(`trigger:${evalId}`)).toEqual([])
})

it('does not count a deferral toward the cap: Later may repeat without end', async () => {
  let later = true
  const run = vi.fn(async () => { if (later) throw new Later('paused') })
  effects.handle('chatter', run, { retry: [1000, 60_000], giveUp: 2 })
  effects.enqueue('chatter', 'c1', { chatId: 'c1' })
  for (let round = 0; round < 5; round++) { await effects.idle(); clock += 1000 }
  await effects.idle()
  expect(run).toHaveBeenCalledTimes(6)
  expect(effects.pending('chatter')).toBe(true)
  later = false
  clock += 1000; await effects.idle()
  expect(effects.pending('chatter')).toBe(false)
})
