import { after, it } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from '../testing/expect.js'
import { deferred, sleep, testDeployment, waitUntil } from '../testing/fixtures.js'
import type { Thread } from '../core/index.js'
import { KV } from '../kv.js'
import type { SourceContext } from './host.js'
import type { FeishuConfig } from './feishu.js'
import { backfillChat, backfillLoop, runFeishu, sawTopic, sweepRetry, wakeup } from './feishu-loops.js'

const chat = 'oc_chat'
const config: FeishuConfig = { cli: 'lark', readPageSize: 20, linkTimeoutMs: 5000, chats: [], directMessages: true, otherChats: 'mentions' }
const ago = (hours: number): string => new Date(Date.now() - hours * 3600_000).toISOString()
type Lark = (args: string[]) => Promise<unknown>
/** A Source context with only what the Feishu loops touch, a chat the bot heard an hour ago, and `lark` for every CLI call. */
function source(lark: Lark, options: { cli?: string; threads?: Thread[] } = {}) {
  const state = new Map<string, unknown>([[KV.feishu.chats, { [chat]: false }], [KV.feishu.history(chat), ago(1)]])
  const ctx = {
    ready: Promise.resolve(), configured: () => true, problem: undefined,
    deployment: testDeployment({ feishu: { cli: options.cli ?? '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Bot' } }),
    config: () => config,
    commands: { withSignal: () => ({ lark }) },
    receive: async () => 'stored',
    state: { get: (key: string) => state.get(key), keys: () => [],
      set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    threads: { subscribed: () => options.threads ?? [], describe: () => {}, patch: () => {}, get: () => undefined },
    tickets: { get: () => undefined },
    triggers: { get: () => undefined, latest: () => undefined },
    report: () => {},
  } as unknown as SourceContext
  return { ctx, state }
}
const isHistory = (args: string[]): boolean => args[0] === 'api' && args[2] === '/open-apis/im/v1/messages'
/** The parameters of each history page `lark` was asked for, in order. */
const scans = (lark: { mock: { calls: unknown[][] } }): Record<string, string>[] =>
  lark.mock.calls.map(([args]) => args as string[]).filter(isHistory).map(args => JSON.parse(args[4]!))
const empty = { items: [], has_more: false }
/** Starts `loop`, runs `check`, then stops the loop even when `check` fails, so a failed test does not leave it running. */
async function whileRunning(loop: (signal: AbortSignal) => Promise<unknown>, check: () => Promise<void>, release = () => {}): Promise<void> {
  const stop = new AbortController()
  const running = loop(stop.signal)
  try { await check() } finally { stop.abort(); release(); await running }
}

it('keeps a wake for the next wait, merges several into one, and times out without one', async () => {
  const ready = wakeup()
  const signal = new AbortController().signal
  expect(await ready.wait(signal, 5)).toBe(false)
  ready.wake(); ready.wake()
  expect(await ready.wait(signal, 5)).toBe(true)
  expect(await ready.wait(signal, 5)).toBe(false)
  const waiting = ready.wait(signal, 5000)
  ready.wake()
  expect(await waiting).toBe(true)
})

it('reads history once each time the stream becomes ready and not again while it stays up', async () => {
  const lark = vi.fn(async (_args: string[]) => empty)
  const { ctx, state } = source(lark)
  const ready = wakeup()
  await whileRunning(signal => backfillLoop(ctx, signal, ready, 5), async () => {
    ready.wake()
    await waitUntil(() => scans(lark).length === 1)
    const cursor = state.get(KV.feishu.history(chat)) as string
    // Twenty ticks with the stream up read nothing.
    await sleep(100)
    expect(scans(lark)).toHaveLength(1)
    ready.wake()
    await waitUntil(() => scans(lark).length === 2)
    // The next sweep starts where the last one ended.
    expect(scans(lark)[1]!.start_time).toBe(String(Math.floor(Date.parse(cursor) / 1000)))
  })
})

it('sweeps again at once when the stream became ready during a sweep', async () => {
  const held = deferred()
  let calls = 0
  const lark = vi.fn(async (_args: string[]) => { if (++calls === 1) await held.promise; return empty })
  const { ctx } = source(lark)
  const ready = wakeup()
  await whileRunning(signal => backfillLoop(ctx, signal, ready, 5), async () => {
    ready.wake()
    await waitUntil(() => calls === 1)
    // The stream reconnects twice while the first sweep waits on Feishu.
    ready.wake(); ready.wake()
    held.resolve()
    await waitUntil(() => calls === 2)
    await sleep(50)
    expect(calls).toBe(2)
  }, held.resolve)
})

const dir = mkdtempSync(join(tmpdir(), 'swarm-feishu-'))
after(() => rmSync(dir, { recursive: true, force: true }))
it('sweeps when the event consumer prints its ready line, at start and after it reconnects', async () => {
  // A consumer that becomes ready and drops its connection soon after; watch() starts it again a second later.
  const cli = join(dir, 'lark-cli')
  writeFileSync(cli, "#!/bin/sh\necho '[event] ready' >&2\nexec sleep 0.3\n")
  chmodSync(cli, 0o755)
  const lark = vi.fn(async (args: string[]) => isHistory(args) ? empty : {})
  const { ctx } = source(lark, { cli })
  await whileRunning(signal => runFeishu(ctx, signal), async () => {
    await waitUntil(() => scans(lark).length === 1)
    await waitUntil(() => scans(lark).length === 2, 5000)
  })
})

it('reads only topics with a message in the last day or followed by a polled Thread', async () => {
  const followed = { key: 'feishu:followed', subscriptions: [], createdAt: ago(2), lastAt: ago(1), meta: { threadId: 'omt_followed' } }
  const lark = vi.fn(async (_args: string[]) => empty)
  const { ctx, state } = source(lark, { threads: [followed as unknown as Thread] })
  state.set(KV.feishu.topics(chat), { omt_old: ago(25), omt_recent: ago(23), omt_followed: ago(240) })
  await backfillChat(ctx, chat, false, ago(1), new Date().toISOString(), new AbortController().signal)
  expect(Object.keys(state.get(KV.feishu.topics(chat)) as object)).toEqual(['omt_recent', 'omt_followed'])
  expect(scans(lark).map(scan => scan.container_id)).toEqual([chat, 'omt_recent', 'omt_followed'])
})

it('keeps topic times the live stream records while a sweep reads history, and the later time of each', async () => {
  const [older, newer, now] = [ago(2), ago(1), new Date().toISOString()]
  const reply = { message_id: 'om_reply', chat_id: chat, create_time: String(Date.parse(older)), thread_id: 'omt_both',
    sender: { id: 'ou_user', sender_type: 'user' }, body: { content: '{"text":"hi"}' } }
  const held = deferred()
  let calls = 0
  const lark = vi.fn(async (_args: string[]) => { if (++calls > 1) return empty; await held.promise; return { items: [reply], has_more: false } })
  const { ctx, state } = source(lark)
  const sweep = backfillChat(ctx, chat, false, ago(3), now, new AbortController().signal)
  await waitUntil(() => calls === 1)
  // Live replies arrive while the chat page is read: one in another topic, and a later one in the topic it reports.
  sawTopic(ctx.state, chat, 'omt_live', now)
  sawTopic(ctx.state, chat, 'omt_both', newer)
  held.resolve(); await sweep
  expect(state.get(KV.feishu.topics(chat))).toEqual({ omt_live: now, omt_both: newer })
})

it('repeats a failed sweep after a minute, doubling up to an hour', () => {
  expect([undefined, 60_000, 120_000, 2_400_000, 3_600_000].map(sweepRetry)).toEqual([60_000, 120_000, 240_000, 3_600_000, 3_600_000])
})
