import { describe, it } from 'node:test'
import { Commands } from '../commands.js'
import { expect, vi } from '../testing/expect.js'
import { SettingsSchema } from '../settings.js'
import { KV, type Key } from '../kv.js'
import type { ChannelRef } from '../core/index.js'
import { HealthBoard, type Health } from '../health.js'
import { testDeployment } from '../testing/fixtures.js'
import { waitUntil } from '../testing/fixtures.js'
import { ChatHealth, PROBE_FAILURES, type ChatState } from './chat.js'
import { feishuKind } from './feishu.js'
import { feishuChatKind } from './feishu-chat.js'
import { probeLoop, runFeishu } from './feishu-loops.js'
import type { SourceContext } from './host.js'
import { SourceRegistry } from './registry.js'
import * as chatterModule from '../chatter.js'

const deployment = testDeployment()

describe('the chat health rule', () => {
  it('lets a ready claim stand while the API answers', () => {
    const health = new ChatHealth()
    const ready: Health = { state: 'ready', detail: 'Listening' }
    health.record(undefined, () => {})
    expect(health.claim(ready)).toEqual(ready)
  })
  it('reports the failure once it reaches the threshold, and claims of ready read error from then on', () => {
    const health = new ChatHealth()
    const reports: Health[] = []
    for (let attempt = 1; attempt < PROBE_FAILURES; attempt++) health.record('20009 The specified app is not installed', (entry) => reports.push(entry))
    expect(reports).toEqual([])
    // Below the threshold a claim still stands: one outage second does not flap it.
    expect(health.claim({ state: 'ready', detail: 'Listening' }).state).toBe('ready')
    health.record('20009 The specified app is not installed', (entry) => reports.push(entry))
    expect(reports).toEqual([{ state: 'error', detail: '20009 The specified app is not installed' }])
    expect(health.claim({ state: 'ready', detail: 'Listening' })).toEqual({ state: 'error', detail: '20009 The specified app is not installed' })
  })
  it('claims ready again only after a probe passes', () => {
    const health = new ChatHealth()
    const reports: Health[] = []
    for (let attempt = 0; attempt < PROBE_FAILURES; attempt++) health.record('down', (entry) => reports.push(entry))
    expect(health.claim({ state: 'ready', detail: 'Listening' }).state).toBe('error')
    health.record(undefined, (entry) => reports.push(entry))
    expect(reports.at(-1)?.state).toBe('ready')
    expect(health.claim({ state: 'ready', detail: 'Listening' })).toMatchObject({ state: 'ready' })
  })
})

describe('a chat kind', () => {
  it('is reachable through the registry by source, with its own identity and directory', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: {} } } }))
    sources.register(feishuKind)
    expect(sources.chatKind('feishu')).toBe(feishuChatKind)
    expect(sources.chatKinds()).toEqual([feishuChatKind])
    expect(sources.chatKind('github')).toBeUndefined()
    expect(sources.agent('feishu', deployment)).toEqual({ id: 'ou_bot', name: 'Widgets Bot', ownIds: ['ou_bot', 'cli_bot'] })
    expect(sources.agent('feishu', undefined)).toBeUndefined()
    expect(sources.agent('github', deployment)).toBeUndefined()
  })
  it('lists chats, their people and a person by name from the records its writers keep, carrying the source', () => {
    const state = new Map<string, unknown>([
      [KV.sources.labels('feishu'), { oc_g: 'Team', oc_dm: 'ignored' }],
      [KV.feishu.chats, { oc_g: false, oc_dm: true }],
      [KV.people.members('oc_g'), { at: '', names: { ou_a: 'Ann', ou_bot: 'Bot', cli_bot: 'Bot' }, bots: ['ou_bot', 'cli_bot'] }],
      [KV.people.members('oc_dm'), { at: '', names: { ou_c: 'Cid' } }],
      [KV.people.person('feishu', 'ou_a'), { name: 'Ann', at: '' }],
    ])
    const reads: ChatState = { get: <V>(key: string) => state.get(key) as V | undefined, keys: <V>() => [KV.people.person('feishu', 'ou_a')] as Key<V>[] }
    const directory = feishuChatKind.directory
    expect(directory.chats(reads)).toEqual([
      { source: 'feishu', chatId: 'oc_g', name: 'Team', people: 2 },
      { source: 'feishu', chatId: 'oc_dm', name: 'Cid', direct: true, people: 1 },
    ])
    expect(directory.chat(reads, 'oc_g')).toMatchObject({ source: 'feishu', chatId: 'oc_g', name: 'Team' })
    expect(directory.chat(reads, 'oc_none')).toBeUndefined()
    expect(directory.people(reads, 'oc_g', 10)).toEqual([{ id: 'ou_a', name: 'Ann' }, { id: 'ou_bot', name: 'Bot', bot: true }])
    expect(directory.findPeople(reads, 'an', 10)).toEqual([{ id: 'ou_a', name: 'Ann', chats: ['Team'] }])
    expect(directory.personKey('ou_a')).toBe(true)
    expect(directory.personKey('cli_bot')).toBe(false)
    expect(directory.chatKey('oc_g')).toBe(true)
    expect(directory.chatKey('ou_a')).toBe(false)
  })
  it('keeps a stored channel answerable through the kind that stored it', () => {
    const channel: ChannelRef = feishuChatKind.update('oc_1', 'om_1', false, false)
    expect(feishuChatKind.describe(channel)).toMatchObject({ chatId: 'oc_1', messageId: 'om_1', mode: 'reply' })
  })
  it('keeps an unnamed app\'s bot nameless instead of naming it by its id', () => {
    // Setup defaults an app without a name to ""; the chatter treats "" as no name, so the bot id must not take its place.
    const unnamed = { ...deployment, feishu: { ...deployment.feishu!, name: '' } }
    expect(feishuChatKind.agent(unnamed, {})?.name).toBe('')
    expect(feishuChatKind.agent(unnamed, {})?.id).toBe('ou_bot')
    const { namesAgent } = chatterModule
    expect(namesAgent('ou_bot hi there', feishuChatKind.agent(unnamed, {})!.name)).toBe(false)
  })
  it('says a deployment with no Feishu bot cannot sign in, with the reason a caller can act on', async () => {
    // Setup never publishes such a deployment, so the only caller that can reach the guard is one that built it by hand.
    vi.spyOn(Commands.prototype, 'lark').mockImplementation(async () => ({ status: 'ready' }))
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: {} } } }))
    sources.register(feishuKind)
    expect(await sources.check('feishu', new Commands(() => testDeployment(), {}, new AbortController().signal), testDeployment({ feishu: undefined })))
      .toMatchObject({ state: 'error', detail: 'The deployment has no Feishu bot' })
  })
  it('is probed with one API call the CLI takes with --as and --format, which throws the platform\'s own message', async () => {
    const lark = vi.fn(async () => { throw new Error('20009 The specified app is not installed') })
    await expect(feishuChatKind.probe!({ lark } as never, deployment, {})).rejects.toThrow('20009')
    expect(lark.mock.calls[0]).toEqual([['api', 'GET', '/open-apis/bot/v3/info']])
  })
})

describe('the health of a source whose API calls all fail', () => {
  it('never reads ready from the probe loop, and reads error once the threshold is passed', async () => {
    const board = new HealthBoard()
    const feishu = board.claim('feishu', { state: 'starting', detail: '' })
    const reported: Health[] = []
    const ctx = {
      ready: Promise.resolve(), configured: () => true, deployment,
      config: () => ({ cli: 'lark', readPageSize: 20, linkTimeoutMs: 5000, chats: [], directMessages: true, otherChats: 'mentions' }),
      commands: { lark: vi.fn(async () => { throw new Error('20009 The specified app is not installed') }) },
      report: (_entry: string, value: Health) => { reported.push(value); feishu.set(value) },
    } as unknown as SourceContext
    const stop = new AbortController()
    const chatHealth = new ChatHealth()
    const loop = probeLoop(ctx, stop.signal, chatHealth, 5)
    await waitUntil(() => reported.length === 1)
    expect(reported).toEqual([{ state: 'error', detail: 'Error: 20009 The specified app is not installed' }])
    // The stream's own claim of ready now reads error, so the entry is never ready while the API fails.
    expect(chatHealth.claim({ state: 'ready', detail: 'Listening for bot events' }).state).toBe('error')
    feishu.set(chatHealth.claim({ state: 'ready', detail: 'Listening for bot events' }))
    expect(feishu.get()?.state).toBe('error')
    stop.abort()
    await loop
  })
  it('is wired into the Feishu Source itself: running it against a failing lark never reports the entry ready', async () => {
    // The whole Source runs: every loop. The deployment has no bot, so only the probe calls out, and its lark always throws.
    const reports: { entry: string; value: Health }[] = []
    const ctx = {
      ready: Promise.resolve(), configured: () => false, deployment: { ...deployment, feishu: undefined },
      config: () => ({ cli: 'lark', readPageSize: 20, linkTimeoutMs: 5000, chats: [], directMessages: true, otherChats: 'mentions' }),
      commands: { lark: vi.fn(async () => { throw new Error('20009 The specified app is not installed') }) },
      report: (entry: string, value: Health) => { reports.push({ entry, value }) },
      state: { get: () => undefined, set: () => {}, keys: () => [] },
    } as unknown as SourceContext
    const stop = new AbortController()
    const running = runFeishu(ctx, stop.signal, 2)
    await waitUntil(() => reports.some((item) => item.entry === 'feishu' && item.value.state === 'error'))
    stop.abort()
    await running
    // Only the probe speaks for `feishu` here; nothing may ever claim ready while its calls fail.
    expect(reports.filter((item) => item.entry === 'feishu').map((item) => item.value.state)).not.toContain('ready')
    expect(reports.some((item) => item.entry === 'feishu' && item.value.state === 'error')).toBe(true)
  })
})

describe('the platform name reaching prompts', () => {
  it('is the kind\'s own word, and stays "Feishu" when none is given', async () => {
    const { routerPrompt } = await import('../prompts.js')
    const { chatterPrompt } = await import('../chatter.js')
    expect(routerPrompt()).toContain('On Feishu the card says who is who')
    expect(routerPrompt('', false, 'FakeChat')).toContain('On FakeChat the card says who is who')
    expect(routerPrompt('', false, 'FakeChat')).not.toContain('for a Feishu message outside a topic')
    expect(chatterPrompt('bot', '', 'FakeChat')).toContain('a member of a group chat on FakeChat')
    expect(chatterPrompt('bot', '')).toContain('a member of a group chat on Feishu')
  })
})
