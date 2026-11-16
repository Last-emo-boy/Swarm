import { describe, it } from 'node:test'
import { expect } from '../testing/expect.js'
import { feishuChannel, feishuTrigger, feishuUserChannel, SOURCE } from './feishu-trigger.js'
import { feishuChatKind } from './feishu.js'
import { channelOf, metaOf } from './meta.js'

const event = (overrides: Record<string, unknown> = {}) => ({ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_a',
  sender_type: 'user', content: 'hello', create_time: '1700000000000', mentions: [], ...overrides })

describe('the chat meta accessor', () => {
  it('reads a Feishu trigger\'s message as the kind stored it: chat, message, topic, direct and mentions', () => {
    const trigger = feishuTrigger(event({ chat_type: 'p2p', mentions: [{ id: 'ou_b', name: 'Bea' }], thread_id: 'omt_1' }), 'ou_bot', 'cli_bot')!
    expect(metaOf(trigger)).toEqual({ chatId: 'oc_1', messageId: 'om_1', threadId: 'omt_1', direct: true, topic: true, mentioned: false,
      mentions: [{ id: 'ou_b', name: 'Bea' }] })
  })
  it('is the same for a reply the kind built, and reads a message with no topic as one', () => {
    const trigger = feishuTrigger(event(), 'ou_bot', 'cli_bot')!
    expect(metaOf(trigger).topic).toBe(false)
    expect(metaOf(trigger).direct).toBe(false)
    expect(metaOf({ meta: {}, channel: feishuChannel('oc_1', 'om_2', true, true) }).direct).toBe(true)
  })
  it('falls back to the channel address for a field the kind stored only there, and lets meta win', () => {
    const address = { chatId: 'oc_9', messageId: 'om_9', ...{ mention: 'x' } }
    expect(metaOf({ meta: {}, channel: { source: SOURCE, thread: 'feishu:oc_9', address } })).toMatchObject({ chatId: 'oc_9', messageId: 'om_9', direct: false, topic: false })
    expect(metaOf({ meta: { chatId: 'oc_meta', direct: 'yes' }, channel: { source: SOURCE, thread: 'feishu:oc_9', address } })).toMatchObject({ chatId: 'oc_meta', direct: false })
  })
  it('finds the channel a kind stored, and none when it stored none', () => {
    const trigger = feishuTrigger(event(), 'ou_bot', 'cli_bot')!
    expect(channelOf(trigger)).toBe(trigger.channel)
    expect(channelOf({ channel: undefined })).toBeUndefined()
  })
  it('describes every channel the Feishu kind builds, the way it was built', () => {
    const kind = feishuChatKind
    expect(kind.describe(kind.chat('oc_1'))).toEqual({ chatId: 'oc_1', direct: false, mode: 'chat' })
    expect(kind.describe(kind.user('ou_a'))).toEqual({ userId: 'ou_a', direct: true, mode: 'user' })
    expect(kind.describe(kind.update('oc_1', 'om_1', false, true))).toEqual({ chatId: 'oc_1', messageId: 'om_1', direct: false, mode: 'chat' })
    expect(kind.describe(kind.update('oc_1', 'om_1', true, false))).toEqual({ chatId: 'oc_1', messageId: 'om_1', direct: true, mode: 'reply' })
    // What it builds is byte for byte what the Feishu helpers built before the seam.
    expect(kind.chat('oc_1')).toEqual({ source: SOURCE, thread: 'feishu:oc_1', address: { chatId: 'oc_1', mode: 'chat' } })
    expect(kind.user('ou_a')).toEqual(feishuUserChannel('ou_a'))
    expect(kind.update('oc_1', 'om_1', true, true)).toEqual(feishuChannel('oc_1', 'om_1', true, true))
    // Its thread names the chat the way a channel's `thread` does, so threadKey(thread(id)) is that string.
    expect(`${kind.thread('oc_1').source}:${kind.thread('oc_1').id}`).toBe(kind.chat('oc_1').thread)
  })
})
