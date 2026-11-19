/**
 * The acceptance suite run over both chat kinds: the fake kind with its in-memory sink, and Feishu with its CLI stubbed.
 * A platform adapter added later runs `chatAcceptance` in a file of its own; what Feishu and the fake kind share here is
 * the fixture shape, not the paths — the suite drives only the kind's own contract.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Commands } from '../commands.js'
import type { ChannelRef, Trigger } from '../core/index.js'
import { feishuKind, feishuTrigger } from '../sources/feishu.js'
import type { Deployment } from '../setup.js'
import { fakeChatKind, fakeChatSource, fakeProbes, fakeSink, fakeTrigger } from './fake-chat.js'
import { testDeployment } from './fixtures.js'
import { vi } from './expect.js'
import { chatAcceptance, type ChatKindUnderTest } from './chat-acceptance.js'

const CHAT = 'oc_team'

chatAcceptance('fakechat', (): ChatKindUnderTest => {
  const sink = fakeSink()
  return {
    // The directory is what the kind's live member reads leave behind; the suite never runs that loop.
    kind: fakeChatSource(sink, { room1: { people: [{ id: 'fk_ann', name: 'Ann' }] } }),
    settings: () => ({ sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} }, fakechat: { enabled: true, config: { rooms: ['room1', 'room2'] } } },
      policy: { sources: { fakechat: { allowed: [{ id: 'fk_ann', name: 'Ann' }] } } },
      memory: { enabled: true, lullSeconds: 10, minMessages: 1 }, chatter: { everywhere: true } }),
    // The fake kind needs no account; the deployment only says it has none.
    deployment: () => testDeployment({ repository: '', github: undefined, feishu: undefined }),
    trigger: (text, options = {}) => fakeTrigger('room1', options.from ?? 'fk_ann', text,
      { ...options.direct !== undefined ? { direct: options.direct } : {}, ...options.mention !== undefined ? { mention: options.mention } : {}, ...options.at ? { at: options.at } : {} }),
    sender: { id: 'fk_ann', name: 'Ann' },
    sent: () => sink.sent.map((message, index) => ({ channel: message.channel, text: message.text, ...sink.posted[index] ? { messageId: sink.posted[index]! } : {} })),
    probed: fakeProbes,
    // A room list without room1: the settings' own `allowed` refuses the chat the triggers are written in.
    refused: () => ({ settings: { sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} },
      fakechat: { enabled: true, config: { rooms: ['room2'] } } }, policy: { sources: { fakechat: { allowed: [{ id: 'fk_ann', name: 'Ann' }] } } },
      memory: { enabled: true, lullSeconds: 10, minMessages: 1 }, chatter: { everywhere: true } },
    channel: fakeChatKind(fakeSink()).chat('room1') }),
  }
})

/**
 * Feishu's fixture: the bot's CLI is a spy, so every call the kind makes is answered here and nothing reaches a real one
 * (env.ts would refuse anyway). What it answers is what lark-cli answers: a reply's id on `im +messages-reply`, the
 * download path lark-cli saves under, and the bot status `auth status` reads.
 */
chatAcceptance('feishu', (stateDir): ChatKindUnderTest => {
  const lark = vi.spyOn(Commands.prototype, 'lark')
  const sent: { channel: ChannelRef; text: string; messageId?: string }[] = []
  let downloads = 0
  let statusReads = 0
  let signedOut: string | undefined
  lark.mockImplementation(async (args: string[], cwd?: string) => {
    // The sign-in check and the health probe both ask the bot's own identity; a signed-out CLI answers with an error.
    if (args[0] === 'api' && args[2] === '/open-apis/bot/v3/info') {
      if (signedOut) throw new Error(signedOut)
      statusReads += 1
      return { app_name: 'Widgets Bot', activate_status: 2 }
    }
    if (args[0] === 'auth') throw new Error(`unexpected lark ${args.join(' ')}`)
    const markdown = args.indexOf('--markdown')
    const text = markdown === -1 ? args[args.indexOf('--text') + 1] ?? '' : args[markdown + 1] ?? ''
    const file = args.indexOf('--file')
    if (file !== -1) throw new Error(`unexpected lark ${args.join(' ')}`)
    if (args[1] === '+messages-resources-download') {
      downloads += 1
      const key = args[args.indexOf('--file-key') + 1]!
      const name = `${key}.log`
      if (!cwd) throw new Error('a download needs a working directory')
      writeFileSync(join(cwd, name), 'the build failed on step 3')
      return { saved_path: name, size_bytes: 28 }
    }
    if (args[1] !== '+messages-reply' && args[1] !== '+messages-send') throw new Error(`unexpected lark ${args.join(' ')}`)
    const messageId = `om_sent_${sent.length + 1}`
    const chatId = args.indexOf('--chat-id') === -1 ? CHAT : args[args.indexOf('--chat-id') + 1]!
    sent.push({ channel: { source: 'feishu', thread: `feishu:${chatId}`, address: { chatId } }, text, messageId })
    return { message_id: messageId, chat_id: chatId }
  })
  const deployment = (dir: string): Deployment => testDeployment({ stateDir: dir, repository: '', github: undefined,
    feishu: { cli: 'lark-cli', appId: 'cli_app', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' } })
  let n = 0
  const trigger = (text: string, options: { from?: string; at?: string; direct?: boolean; mention?: boolean } = {}): Trigger => {
    n += 1
    const direct = options.direct === true
    const messageId = `om_${n}`
    return feishuTrigger({ message_id: messageId, chat_id: CHAT, chat_type: direct ? 'p2p' : 'group', sender_id: options.from ?? 'ou_ann', sender_type: 'user',
      content: text, create_time: String(options.at ? Date.parse(options.at) : Date.now() - 5 * 60_000),
      mentions: direct || options.mention === false ? [] : [{ id: 'ou_bot', key: '@_user_1', name: 'Widgets Bot' }] }, 'ou_bot', 'cli_app')!
  }
  return {
    kind: feishuKind,
    settings: () => ({ sources: { feishu: { enabled: true, config: { cli: 'lark-cli', chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: true } },
      github: { enabled: false, config: {} }, fakechat: { enabled: false, config: {} } },
      policy: { sources: { feishu: { allowed: [{ id: 'ou_ann', name: 'Ann' }] } } },
      memory: { enabled: true, lullSeconds: 10, minMessages: 1 }, chatter: { everywhere: true } }),
    deployment,
    trigger: (text, options) => trigger(text, options),
    sender: { id: 'ou_ann', name: 'Ann' },
    members: [{ id: 'ou_ann', name: 'Ann' }, { id: 'ou_bot', name: 'Widgets Bot', bot: true }],
    // Feishu's directory lists the group chats whose reads its loop recorded; the fixture says which one that is.
    known: true,
    sent: () => sent,
    probed: () => statusReads,
    signOut: (message) => { signedOut = message },
    // Direct messages off: the settings' own `scope` refuses a direct chat, and `allowed` must say the same.
    refused: () => ({ settings: { sources: { feishu: { enabled: true, config: { cli: 'lark-cli', chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: false } },
      github: { enabled: false, config: {} }, fakechat: { enabled: false, config: {} } },
      policy: { sources: { feishu: { allowed: [{ id: 'ou_ann', name: 'Ann' }] } } },
      memory: { enabled: true, lullSeconds: 10, minMessages: 1 }, chatter: { everywhere: true } },
    channel: { source: 'feishu', thread: `feishu:${CHAT}`, address: { chatId: CHAT, direct: 'true' } } }),
    files: {
      fixture: () => {
        const posted = trigger('<file key="file_v3_log" name="build.log"/>')
        assert.equal(downloads, 0, 'the fixture builds the trigger; the read itself downloads later')
        return { trigger: posted, file_key: 'file_v3_log', name: 'build.log', data: Buffer.from('the build failed on step 3') }
      },
    },
  }
})
