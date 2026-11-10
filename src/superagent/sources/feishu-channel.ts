/** Feishu outbound channel: posts bot replies in topics or the chat itself, and constructs chat deep links (from dsh-superagent's sources/feishu-channel.ts). */
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { OutboundMessage } from '../core/index.js'
import { CliError } from '../commands.js'
import { checkedImText } from '../text.js'
import type { SourceContext } from './host.js'
import type { ChannelLink, ChannelLinks } from './kind.js'
import { feishuTriggerId } from './feishu-trigger.js'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/**
 * The value of a text flag for lark-cli, which reads a file when a value starts with `@` and takes `@@` for a literal one:
 * a message such as "@小王 好的" is sent as written, never read from a file.
 */
export const cliText = (text: string): string => text.startsWith('@') ? `@${text}` : text
/** Ids a Feishu mention may name: a person's or bot's open_id, or everyone in the chat. */
const MENTIONABLE = /^(ou_[A-Za-z0-9_-]+|all)$/
/**
 * The text with real Feishu mentions: the first `@name` of each person it @s becomes Feishu's at tag, and one the text does not
 * name is put in front. Ids that name no one Feishu can mention are left out; names lose what would break the tag.
 */
export function withMentions(text: string, mentions: readonly { id: string; name: string }[] = []): string {
  let result = text
  const front: string[] = []
  for (const { id, name } of mentions) {
    if (!MENTIONABLE.test(id)) continue
    const tag = `<at user_id="${id}">${name.replace(/[<>"&]/g, '').trim() || id}</at>`
    if (name && result.includes(`@${name}`)) result = result.replace(`@${name}`, tag)
    else front.push(tag)
  }
  return [...front, result].join(' ')
}
/**
 * Replies in the topic of the target message, or with mode `chat` into the chat itself, as a member writes there: a reply that
 * quotes the target message, or a plain message without one. Then it posts the attachment as a file the same way; Feishu
 * keeps at most one message per idempotency key (the outgoing message's `message.id`, and that with `-file` for its file).
 * An attachment Feishu refuses for good, such as without the permission to upload files, is replaced by a line that says it
 * could not be attached, and why.
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { messageId, chatId, mode, userId } = message.channel.address
  if (mode === 'user') return sendToUser(host, message, userId)
  const inChat = mode === 'chat'
  if (inChat && !messageId && !chatId) throw new Error('Missing Feishu chat')
  if (!inChat && !messageId) throw new Error('Missing Feishu reply target')
  const target = messageId ? ['im', '+messages-reply', '--message-id', messageId] : ['im', '+messages-send', '--chat-id', chatId!]
  const text = withMentions(checkedImText(message.text), message.mentions)
  const post = (content: string[], key: string, cwd?: string) => host.commands.lark([...target, ...content,
    ...inChat ? [] : ['--reply-in-thread'], '--idempotency-key', key], cwd)
  try {
    if (text.trim()) await post(['--markdown', cliText(text)], message.id)
    if (message.attachment && existsSync(message.attachment)) {
      await post(['--file', basename(message.attachment)], `${message.id}-file`, dirname(message.attachment)).catch(async (error: unknown) => {
        if (!(error instanceof CliError) || error.code === undefined || gone(error)) throw error
        await post(['--markdown', `(${basename(message.attachment!)} could not be attached: ${error.message.slice(0, 200)})`], `${message.id}-nofile`)
      })
    }
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Feishu refuses for good to start a direct message with someone outside the app's availability. */
const NO_AVAILABILITY = 230013
/**
 * Sends a direct message to a person by their open_id, which needs no chat with them yet: what must not be said in a group,
 * such as the code that links their GitHub account. One Feishu refuses for good, such as to someone outside the app's
 * availability, settles as gone.
 */
async function sendToUser(host: Pick<SourceContext, 'commands'>, message: OutboundMessage, userId?: string): Promise<'sent' | 'gone'> {
  if (!userId) throw new Error('Missing Feishu user')
  try {
    await host.commands.lark(['im', '+messages-send', '--user-id', userId, '--text', cliText(withMentions(checkedImText(message.text), message.mentions)), '--idempotency-key', message.id])
  } catch (error) {
    if (gone(error) || (error instanceof CliError && error.code === NO_AVAILABILITY)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: 'Feishu message',
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
