/** Feishu source kind definition and Policy synchronization (from dsh-superagent's sources/feishu.ts, without the web panel's form fields). */
import { z } from 'zod/v4'
import { FeishuBotSchema } from '../setup.js'
import { feishuLink, sendFeishu } from './feishu-channel.js'
import { feishuThreadContext } from './feishu-read.js'
import { runFeishu } from './feishu-loops.js'
import { SOURCE, feishuChannel, feishuTriggerId, feishuUserChannel } from './feishu-trigger.js'
import { sourceContext } from './host.js'
import type { SourceKind } from './kind.js'
import { feishuChatKind } from './feishu-chat.js'
import { feishuFiles } from './feishu-files.js'
import type { SourceRegistry } from './registry.js'

export { REPLY_STYLES, SOURCE, feishuRef, feishuThreadId, feishuTime, feishuTrigger, feishuTriggerId, historyEvent, replyChannel, withMentionNames, type ReplyStyle }
  from './feishu-trigger.js'
export type { FeishuEvent } from './feishu-trigger.js'
export { backfillChat, consumerRetry, pollThreads, refreshChatNames, threadRef } from './feishu-loops.js'
export { feishuChatKind } from './feishu-chat.js'
const MembersSchema = z.looseObject({
  users: z.array(z.looseObject({ member_id: z.string(), name: z.string() })),
  has_more: z.boolean(), truncations: z.array(z.unknown()).optional(),
})
const FeishuConfigSchema = FeishuBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  /**
   * Groups not in `chats`. `mentions`: every group the bot is in is heard, and it answers when someone @s it. `all`: every message
   * there is read, so attached files are fetched even when nobody @s the bot. `none`: only the groups in `chats`.
   */
  otherChats: z.enum(['none', 'mentions', 'all']).default('mentions'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
export const feishuKind: SourceKind<FeishuConfig> = {
  kind: SOURCE,
  title: 'Feishu',
  schema: FeishuConfigSchema,
  // `feishu` and `history` belong to the watch loop; `feishu-login` to the sign-in check, so the two never overwrite each other.
  health: ['feishu', 'history', 'feishu-login'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    if (config.otherChats === 'none') return { listened: false, reason: 'chat_not_allowed' }
    return { listened: true, observed: config.otherChats === 'all', row: 'other' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      feishuKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendFeishu, link: feishuLink,
  },
  threadContext: feishuThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]),
      syncChat: z.string().regex(/^(oc_[a-zA-Z0-9]+)?$/).default(''),
      bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    explicit: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.',
    rows(stored) {
      const config = FeishuConfigSchema.parse(stored)
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? 'All' : '@ only',
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: 'Other chats', note: config.otherChats === 'all' ? 'All' : config.otherChats === 'mentions' ? '@ only' : 'Not received',
          cells: { listedUnaddressed: config.otherChats === 'all', unlistedAddressed: config.otherChats !== 'none', unlistedUnaddressed: config.otherChats === 'all' } },
        { id: 'direct', label: 'Direct messages', note: config.directMessages ? 'Received' : 'Not received',
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const commands = sourceContext(host, feishuKind).commands.withSignal(signal)
        const chat = String(part.syncChat)
        const members = ['im', '+chat-members-list', '--chat-id', chat, '--member-types', 'user', '--page-all', '--page-limit', '0']
        const result = MembersSchema.parse(await commands.lark(members))
        if (result.has_more || result.truncations?.length) throw new Error('Feishu returned an incomplete member list')
        // Keep existing member order so the Policy version stays stable; update names in place and append new members.
        const users = new Map(result.users.map(user => [user.member_id, user.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => users.has(entry.id)).map(entry => ({ ...entry, name: users.get(entry.id)! })), ...result.users.filter(user => !known.has(user.member_id)).map(user => ({ id: user.member_id, name: user.name }))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'SWARM_TICKET_FEISHU_BOT', description: 'The Feishu bot; lark-cli acts as it' },
      { key: 'SWARM_TICKET_FEISHU_CHAT', description: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu' },
    ],
    values: ({ deployment, trigger }) => ({ SWARM_TICKET_FEISHU_BOT: deployment.feishu ? deployment.feishu.name || deployment.feishu.botId : '', SWARM_TICKET_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  chat: feishuChatKind,
  files: feishuFiles,
  watch: async (ctx, signal) => { await runFeishu(ctx, signal) },
  check: {
    entry: 'feishu-login',
    async verify(commands, deployment, config) {
      await feishuChatKind.probe(commands, deployment, config)
      const bot = deployment.feishu
      if (!bot) throw new Error('The deployment has no Feishu bot')
      return `Signed in as ${bot.name || bot.botId}`
    },
  },
}

/** Returns the Feishu Source's settings, falling back to schema defaults while the Source is off. */
export const feishuSettings = (sources: SourceRegistry): FeishuConfig => sources.instance<FeishuConfig>(SOURCE)?.config ?? FeishuConfigSchema.parse({})
