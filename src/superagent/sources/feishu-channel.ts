/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links (from dsh-superagent's sources/feishu-channel.ts). */
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
 * Replies in the topic of the target message, then with its attachment as a file; Feishu keeps at most one reply per
 * idempotency key (the outgoing message's `message.id`, and that with `-file` for its file). An attachment Feishu refuses for
 * good, such as without the permission to upload files, is replaced by a line that says it could not be attached, and why.
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  const reply = (content: string[], key: string, cwd?: string) => host.commands.lark(['im', '+messages-reply', '--message-id', messageId, ...content,
    '--reply-in-thread', '--idempotency-key', key], cwd)
  try {
    if (text.trim()) await reply(['--markdown', text], message.id)
    if (message.attachment && existsSync(message.attachment)) {
      await reply(['--file', basename(message.attachment)], `${message.id}-file`, dirname(message.attachment)).catch(async (error: unknown) => {
        if (!(error instanceof CliError) || error.code === undefined || gone(error)) throw error
        await reply(['--markdown', `(${basename(message.attachment!)} could not be attached: ${error.message.slice(0, 200)})`], `${message.id}-nofile`)
      })
    }
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: 'Feishu message',
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
