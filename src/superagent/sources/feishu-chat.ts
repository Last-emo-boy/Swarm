/** Feishu through the chat seam: the platform's name, the bot's own identity, the directory its writers keep, and the channel constructors, apart from the Source kind so the Feishu loops need not import it. */
import { feishuChannel, feishuUserChannel, SOURCE } from './feishu-trigger.js'
import { chatDirectory } from '../directory.js'
import { KV } from '../kv.js'
import type { ChatKind } from './chat.js'

/**
 * What a Feishu chat is, for the core: the platform's name, the bot's own identity, the directory its writers keep, and the
 * channel constructors. Every address stays the flat `{ chatId, messageId, direct, mode }` Feishu already stored, byte for byte.
 * It lives here, apart from feishu.ts, so the Feishu loops can read it without importing the kind that imports them.
 */
export const feishuChatKind: ChatKind = {
  source: SOURCE,
  platform: 'Feishu',
  // The name as the deployment read it, empty when the app has none: a caller that treats an empty name as "no name" (as the
  // chatter's name matching always did) must not start matching the bot's id instead.
  // Feishu keeps the bot in the deployment; the configuration adds nothing, so it is taken and unused.
  agent: deployment => deployment.feishu
    ? { id: deployment.feishu.botId, name: deployment.feishu.name, ownIds: [deployment.feishu.botId, deployment.feishu.appId] }
    : undefined,
  directory: chatDirectory({
    source: SOURCE,
    direct: state => state.get(KV.feishu.chats),
    // The prefix test people.ts always made: a member's id is a person's open_id, a bot's own id or its app id.
    personKey: id => id.startsWith('ou_'),
    chatKey: id => id.startsWith('oc_'),
  }),
  // A chat's thread carries the chat id alone: `threadKey` of it is `feishu:<chatId>`, the same as a channel's `thread`.
  thread: chatId => ({ source: SOURCE, id: chatId }),
  chat: chatId => ({ source: SOURCE, thread: `feishu:${chatId}`, address: { chatId, mode: 'chat' } }),
  user: feishuUserChannel,
  update: (chatId, messageId, direct, inChat) => feishuChannel(chatId, messageId, direct, inChat),
  describe(channel) {
    const { chatId, messageId, userId, direct, mode } = channel.address
    return { ...chatId ? { chatId } : {}, ...messageId ? { messageId } : {}, ...userId ? { userId } : {},
      direct: direct === 'true', mode: mode === 'user' ? 'user' : mode === 'chat' ? 'chat' : 'reply' }
  },
  // A Feishu message is one bubble: a reply longer than the limit is rewritten, then cut.
  imWords: true,
  // One cheap authenticated call that takes the CLI's own flags: an app not installed, a bot outside its availability or a
  // signed-out CLI fails it. `auth status` is not it: the CLI's status command takes neither `--as` nor `--format`.
  probe: async commands => { await commands.lark(['api', 'GET', '/open-apis/bot/v3/info']) },
}

