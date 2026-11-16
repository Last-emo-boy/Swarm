/**
 * A chat kind that exists only in tests: a second chat adapter under its own source name, which proves the core's chat
 * seam works without Feishu. Its channel sends into an in-memory sink and never spawns anything; it has no watch loop, so
 * triggers are injected by the test through `client.store`/`Engine` the way a Source's `receive` would store them.
 */
import { z } from 'zod/v4'
import { key, type ChannelRef, type Trigger } from '../core/index.js'
import type { OutboundMessage } from '../core/index.js'
import type { ChatDirectory, ChatEntry, ChatPerson, ChatState, ChatKind } from '../sources/chat.js'
import type { SourceKind } from '../sources/kind.js'
import type { Deployment } from '../setup.js'

export const FAKE_SOURCE = 'fakechat'
/** How many times the fake platform has been asked whether it answers; a fixture reports it so the suite sees the ask. */
let probes = 0
export const fakeProbes = (): number => probes

/** The fake platform's default identity, used when the configuration names none. */
export const fakeAgent = { id: 'fake_bot', name: 'Fake Bot', ownIds: ['fake_bot'] as const }
/** The validated configuration the fake kind reads: the rooms a send may enter, and its own identity when a test sets one. */
export interface FakeChatConfig extends Record<string, unknown> { rooms: string[]; botId: string; botName: string }

/** The messages sent through the kind, in order, with whether each went in the chat or into a reply. */
export interface FakeSink { sent: OutboundMessage[]; posted: string[] }
export const fakeSink = (): FakeSink => ({ sent: [], posted: [] })

/** A room and its people, as the in-memory directory holds them. */
interface Room { people: ChatPerson[] }
const rooms = (records: Record<string, Room>): ChatDirectory => {
  const holds = (_state: ChatState): Record<string, Room> => records
  return {
    chats(state): ChatEntry[] { return Object.entries(holds(state)).map(([chatId, room]) => ({ source: FAKE_SOURCE, chatId, name: chatId, people: room.people.length })) },
    chat(state, chatId) { const room = holds(state)[chatId]; return room ? { source: FAKE_SOURCE, chatId, name: chatId, people: room.people.length } : undefined },
    people(state, chatId, limit) { return (holds(state)[chatId]?.people ?? []).slice(0, limit) },
    findPeople(state, name, limit) {
      const wanted = name.trim().toLowerCase()
      return Object.entries(holds(state)).flatMap(([chatId, room]) => room.people.filter((person) => person.name.toLowerCase().includes(wanted)).map((person) => ({ ...person, chats: [chatId] }))).slice(0, limit)
    },
    person(state, id) { return Object.values(holds(state)).flatMap((room) => room.people).find((person) => person.id === id) },
    personKey: id => id.startsWith('fk_'),
    chatKey: id => records[id] !== undefined,
  }
}

/** The fake kind's chat knowledge: plain constructors over the same flat address shape, and a directory the test fills. */
export const fakeChatKind = (sink: FakeSink, members: Record<string, Room> = {}): ChatKind => ({
  source: FAKE_SOURCE,
  platform: 'FakeChat',
  // The identity lives in the configuration, as a Slack bot id would: the seam must hand it to `agent`, not the deployment.
  agent: (_deployment, config) => {
    const { botId = fakeAgent.id, botName = fakeAgent.name } = config as Partial<FakeChatConfig>
    return { id: botId, name: botName, ownIds: [botId] }
  },
  directory: rooms(members),
  thread: chatId => ({ source: FAKE_SOURCE, id: chatId }),
  chat: chatId => ({ source: FAKE_SOURCE, thread: `fakechat:${chatId}`, address: { chatId, mode: 'chat' } }),
  user: userId => ({ source: FAKE_SOURCE, thread: `fakechat:user:${userId}`, address: { userId, mode: 'user', direct: 'true' } }),
  update: (chatId, messageId, direct, inChat) => ({ source: FAKE_SOURCE, thread: `fakechat:${chatId}`,
    address: { chatId, messageId, ...direct ? { direct: 'true' } : {}, ...inChat ? { mode: 'chat' } : {} } }),
  describe: (channel: ChannelRef) => {
    const { chatId, messageId, userId, direct, mode } = channel.address
    return { ...chatId ? { chatId } : {}, ...messageId ? { messageId } : {}, ...userId ? { userId } : {},
      direct: direct === 'true', mode: mode === 'user' ? 'user' : mode === 'chat' ? 'chat' : 'reply' }
  },
  // The fake platform "answers" through the channel's own configuration: a room list means the API is signed in.
  probe: async (_commands, _deployment, _config) => { probes += 1 },
})

/** Builds a Trigger as the fake kind's live consumer would: its own ids, a `fk_` sender, and the message in `meta`. */
export function fakeTrigger(room: string, sender: string, text: string, options: { direct?: boolean; mention?: boolean; at?: string } = {}): Trigger {
  const messageId = `fm_${key('fake', room, sender, text, options.at ?? '')}`.slice(0, 24)
  const direct = options.direct === true
  return { id: key('fakechat', messageId), source: FAKE_SOURCE, threads: [{ source: FAKE_SOURCE, id: room }],
    actor: { source: FAKE_SOURCE, id: sender }, human: true, ...(direct ? { addressed: 'direct' as const } : options.mention ? { addressed: 'mention' as const } : {}),
    at: options.at ?? new Date().toISOString(), text, channel: fakeChatKind(fakeSink()).update(room, messageId, direct, false),
    meta: { chatId: room, messageId, direct, mentioned: options.mention === true } }
}

/** The Source kind a test registers beside the built-in ones: a fake chat with an in-memory sink and no watch loop. */
export function fakeChatSource(sink: FakeSink, members?: Record<string, Room>): SourceKind<FakeChatConfig> {
  return {
    kind: FAKE_SOURCE,
    title: 'Fake chat',
    enabledByDefault: true,
    schema: z.object({ rooms: z.array(z.string()).default([]), botId: z.string().default(fakeAgent.id), botName: z.string().default(fakeAgent.name) }).strict(),
    health: ['fakechat-login'],
    scope: ({ meta }) => ({ listened: true, observed: false }),
    channel: {
      // The channel sees its kind's own configuration, as a real platform's would: an unlisted room is refused before
      // delivery, and `send` alone would call it gone.
      allowed: (address, config) => !config.rooms.length || (address.chatId !== undefined && config.rooms.includes(address.chatId)),
      send: async (host, message) => {
        const chatId = message.channel.address.chatId;
        if (host.config.rooms.length && (!chatId || !host.config.rooms.includes(chatId))) return 'gone';
        sink.sent.push(message);
        // The id it reports back stands in for the platform's own, as Feishu's CLI answer does.
        const messageId = `fm_sent_${sink.sent.length}`;
        sink.posted.push(messageId);
        host.posted?.({ messageId, ...chatId ? { chatId } : {} });
        return 'sent';
      },
      link: (address) => ({ url: `https://fakechat.invalid/${address.chatId ?? ''}`, label: 'FakeChat' }),
    },
    // The check asks the platform, then names the configuration's bot: a check-only kind must not report ready unasked.
    check: { entry: 'fakechat-login', verify: async (commands, deployment, config) => {
      await fakeChatKind(sink, members).probe(commands, deployment, config)
      return `${(config as FakeChatConfig).botName} ready`
    } },
    find: query => ({ threads: [], terms: [query] }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).default([]) }).strict(),
      explicit: 'A direct message or a mention is an explicit request.',
    },
    chat: fakeChatKind(sink, members),
  }
}
