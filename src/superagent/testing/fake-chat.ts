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
export const fakeAgent = { id: 'fake_bot', name: 'Fake Bot', ownIds: ['fake_bot'] as const }

/** The messages sent through the kind, in order, with whether each went in the chat or into a reply. */
export interface FakeSink { sent: OutboundMessage[] }
export const fakeSink = (): FakeSink => ({ sent: [] })

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
  agent: (_deployment: Deployment) => fakeAgent,
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
  probe: async () => {},
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
export function fakeChatSource(sink: FakeSink, members?: Record<string, Room>): SourceKind<{ rooms: string[] }> {
  return {
    kind: FAKE_SOURCE,
    title: 'Fake chat',
    enabledByDefault: true,
    schema: z.object({ rooms: z.array(z.string()).default([]) }).strict(),
    health: [],
    scope: ({ meta }) => ({ listened: true, observed: false }),
    channel: {
      send: async (_host, message) => { sink.sent.push(message); return 'sent' },
      link: (address) => ({ url: `https://fakechat.invalid/${address.chatId ?? ''}`, label: 'FakeChat' }),
    },
    find: query => ({ threads: [], terms: [query] }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).default([]) }).strict(),
      explicit: 'A direct message or a mention is an explicit request.',
    },
    chat: fakeChatKind(sink, members),
  }
}
