/** Reliable outbound message delivery backed by persistent receipts and retried reply effects (from dsh-superagent's app/outbox.ts). */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from './core/index.js'
import type { Commands } from './commands.js'
import { checkedImText } from './text.js'
import { posted, said, saidTo } from './people.js'
import type { ChatKind } from './sources/chat.js'
import type { SourceRegistry } from './sources/registry.js'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.js'
import type { Store } from './store.js'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'get' | 'set'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send' | 'chatKind'>
  readonly commands: Commands
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here for a chat kind's conversation; acknowledgements are already validated when decided.
    const kind = this.host.sources.chatKind(message.channel.source)
    if (message.kind === 'reply' && kind) checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => {
      if (!store.receipts.add(message)) return
      effects.enqueue('reply', message.id, {})
      // Whatever sent it, a message into a chat is what the agent said there (people.ts).
      if (!kind) return
      const { chatId, messageId, userId, mode } = kind.describe(message.channel)
      // A message a ticket sent is a ticket's words, marked as such; one from chatter or a memory is the agent's own talk.
      const ticket = message.ticketId ? { ticket: message.ticketId } : {}
      if (chatId && mode !== 'user') {
        said(store, chatId, { at: new Date().toISOString(), text: message.text, ...(messageId ? { to: messageId } : {}), ...(mode !== 'chat' ? { topic: true } : {}), ...ticket })
      }
      if (mode === 'user' && userId) saidTo(store, userId, { at: new Date().toISOString(), text: message.text, ...ticket })
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    // What it posted in a chat is its own message there, which a reply to it answers (people.ts), and its id is kept for
    // `ticket` and `why` to show.
    let platformId: string | undefined
    // A Source without a chat keeps the platform's id too; only a chat records the agent's own line there (people.ts).
    const speaksInChat = !!this.host.sources.chatKind(receipt.channel.source)?.chat
    const postedIn = ({ messageId, chatId }: { messageId: string; chatId?: string }) => {
      platformId = messageId
      const chat = chatId ?? receipt.channel.address.chatId
      if (speaksInChat && chat) posted(store, chat, messageId)
    }
    const result = await sources.send(receipt, commands, postedIn)
    if (result === 'waiting') throw new Later('The Source is not installed')
    // The receipt keeps when the platform took the message and under which id, for `ticket` and `why` to show.
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent',
      result === 'sent' ? { at: new Date().toISOString(), ...(platformId ? { messageId: platformId } : {}) } : undefined)
  }
}
