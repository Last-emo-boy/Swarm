/** Reliable outbound message delivery backed by persistent receipts and retried reply effects (from dsh-superagent's app/outbox.ts). */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from './core/index.js'
import type { Commands } from './commands.js'
import { checkedImText } from './text.js'
import { posted, said, saidTo } from './people.js'
import type { SourceRegistry } from './sources/registry.js'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.js'
import type { Store } from './store.js'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'get' | 'set'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
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
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => {
      if (!store.receipts.add(message)) return
      effects.enqueue('reply', message.id, {})
      // Whatever sent it, a message to a Feishu chat is what the agent said there (people.ts).
      const { chatId, messageId, mode, userId } = message.channel.address
      if (message.channel.source === 'feishu' && chatId && mode !== 'user') {
        said(store, chatId, { at: new Date().toISOString(), text: message.text, ...(messageId ? { to: messageId } : {}), ...(mode !== 'chat' ? { topic: true } : {}) })
      }
      if (message.channel.source === 'feishu' && mode === 'user' && userId) saidTo(store, userId, { at: new Date().toISOString(), text: message.text })
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
    // What it posted in a Feishu chat is its own message there, which a reply to it answers (people.ts).
    const result = await sources.send(receipt, commands, ({ messageId, chatId }) => {
      const chat = chatId ?? receipt.channel.address.chatId
      if (receipt.channel.source === 'feishu' && chat) posted(store, chat, messageId)
    })
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
