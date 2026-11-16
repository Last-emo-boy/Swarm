/**
 * The store-backed chat directory: the chats the agent is in, their people and bots by name, and the people whose name
 * matches — for any chat kind, from the records its writers keep (Feishu: people.ts and its loops). The platform's own
 * writers stay in the kind; this module only reads what they stored, so naming someone never waits on the platform.
 */
import { KV } from './kv.js'
import type { ChatDirectory, ChatEntry, ChatPerson, ChatState } from './sources/chat.js'

/** A chat's members as the kind's writer stored them (people.ts). */
interface Members { at: string; names: Record<string, string>; bots?: string[]; again?: boolean }
/** What one directory reads: whose chats it lists, where the writer records direct chats, and which ids are people and chats of the kind. */
export interface ChatDirectorySpec {
  source: string
  /** The record of which chats are direct messages, when the kind's writer keeps one. */
  direct?: (state: ChatState) => Record<string, boolean> | undefined
  personKey(id: string): boolean
  chatKey(id: string): boolean
}

/** A `ChatDirectory` over the KV records the kind's writers keep: chat labels, the direct-chat record, and each chat's member list. */
export function chatDirectory(spec: ChatDirectorySpec): ChatDirectory {
  const directOf = (state: ChatState): Record<string, boolean> => spec.direct?.(state) ?? {}
  const labels = (state: ChatState): Record<string, string> => state.get(KV.sources.labels(spec.source)) ?? {}
  const chatIds = (state: ChatState): string[] => [...new Set([...Object.keys(labels(state)), ...Object.keys(directOf(state))])]
  const members = (state: ChatState, chatId: string): Members | undefined => state.get(KV.people.members(chatId))
  return {
    chats(state) { return chatIds(state).map(chatId => entry(state, chatId)) },
    chat(state, chatId) { return chatIds(state).includes(chatId) ? entry(state, chatId) : undefined },
    people(state, chatId, limit) { return people(state, chatId, limit) },
    findPeople(state, name, limit) { return find(state, name, limit) },
    person(state, id) {
      const known = state.get(KV.people.person(spec.source, id))
      if (!known) return undefined
      const bot = chatIds(state).some((chatId) => members(state, chatId)?.bots?.includes(id) === true)
      return { id, name: known.name, ...(bot ? { bot: true as const } : {}) }
    },
    personKey: spec.personKey,
    chatKey: spec.chatKey
  }
  function entry(state: ChatState, chatId: string): ChatEntry {
    const peopleHere = people(state, chatId, 1000)
    const direct = directOf(state)[chatId] === true
    // A direct chat's name is the person's: it has no group name of its own.
    const name = direct ? peopleHere[0]?.name ?? null : labels(state)[chatId] ?? null
    return { source: spec.source, chatId, name, ...direct ? { direct: true as const } : {}, people: peopleHere.length }
  }
  /** The people in a chat as one entry per name (a bot's app id is not repeated). */
  function people(state: ChatState, chatId: string, limit: number): ChatPerson[] {
    const list = members(state, chatId)
    if (!list) return []
    const seen = new Set<string>()
    return Object.entries(list.names).filter(([id]) => spec.personKey(id)).flatMap(([id, name]) => {
      if (seen.has(id)) return []
      seen.add(id)
      return [{ id, name, ...(list.bots?.includes(id) ? { bot: true as const } : {}) }]
    }).slice(0, limit)
  }
  /** The people in the directory whose name contains `name`, with the chats of this source they are in. */
  function find(state: ChatState, name: string, limit: number): { id: string; name: string; chats: string[] }[] {
    const wanted = name.trim().toLowerCase()
    if (!wanted) return []
    const chats = chatIds(state)
    const prefix = `${KV.people.person.prefix}${spec.source}:`
    return state.keys(KV.people.person).filter((key) => key.startsWith(prefix)).flatMap((key) => {
      const id = key.slice(prefix.length)
      const person = state.get(key)
      if (!person || !spec.personKey(id) || !person.name.toLowerCase().includes(wanted)) return []
      const where = chats.filter(chatId => members(state, chatId)?.names[id] !== undefined).map(chatId => labels(state)[chatId] ?? chatId)
      return [{ id, name: person.name, chats: where }]
    }).slice(0, limit)
  }
}
