/** The accessor for what a chat Trigger says about its message: fields the kind stored in `meta` win, and a missing one is read from the channel address, so the core never reads either shape raw. */
import type { ChannelRef, Trigger } from '../core/index.js'

/** The chat fields of a message, as the core reads them. */
export interface MessageMeta {
  chatId?: string
  messageId?: string
  parentId?: string
  rootId?: string
  threadId?: string
  direct: boolean
  topic: boolean
  mentioned: boolean
  senderName?: string
  mentions?: { id: string; name: string }[]
}

const field = (meta: Record<string, unknown>, address: Record<string, string> | undefined, name: string): string | undefined =>
  typeof meta[name] === 'string' ? meta[name] : address?.[name]

/**
 * The chat fields of `trigger`'s message. A `meta` field wins; a missing one is read from the channel address. `direct`
 * holds when either says so, and a message is `topic` when it has a thread, wherever the kind stored it.
 */
export function metaOf(trigger: Pick<Trigger, 'meta' | 'channel'>): MessageMeta {
  const { meta } = trigger
  const address = trigger.channel ? trigger.channel.address : undefined
  const mentions = Array.isArray(meta.mentions) ? meta.mentions as { id: string; name: string }[] : undefined
  return {
    chatId: field(meta, address, 'chatId'),
    messageId: field(meta, address, 'messageId'),
    parentId: field(meta, address, 'parentId'),
    rootId: field(meta, address, 'rootId'),
    threadId: field(meta, address, 'threadId'),
    direct: meta.direct === true || address?.direct === 'true',
    topic: typeof meta.threadId === 'string' || !!address?.threadId,
    mentioned: meta.mentioned === true,
    ...(typeof meta.senderName === 'string' ? { senderName: meta.senderName } : {}),
    ...(mentions ? { mentions } : {})
  }
}

/**
 * The channel `trigger`'s message would answer through, when the kind stored none. The core builds no channel itself, so
 * this is the kind's constructors' place once a kind exists that stores no channel; Feishu always stores one.
 */
export const channelOf = (trigger: Pick<Trigger, 'channel'>): ChannelRef | undefined => trigger.channel
