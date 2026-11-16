/**
 * The acceptance suite a chat kind passes before it is trusted with people's work: one case for each path the core takes a
 * chat through (a ticket and its acknowledgement, memory, chatter, bot commands, the record of what the agent posted, the
 * sign-in check and attachments, the `allowed` gate a delivery passes and the link a channel offers), driven only through
 * the kind's contract. Feishu and the fake kind run the same suite;
 * a platform adapter added later imports `chatAcceptance` in its own test file and supplies its fixture.
 *
 * Nothing here starts a watch loop or a Host: the tests build a `SuperagentClient` with the kind under test and call the
 * paths directly, so a watched kind's CLI is only reached through what the paths themselves ask for.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import type { ChannelRef, Trigger } from '../core/index.js'
import type { SourceKind } from '../sources/kind.js'
import { SuperagentClient } from '../client.js'
import type { Deployment } from '../setup.js'
import { settingsPath, writeSettings } from '../settings.js'
import { threadKey } from '../core/index.js'
import { BotCommands } from '../bot-commands.js'
import { ChatterRoom } from '../chatter.js'
import { Memories, notesCard, personSubject } from '../memories.js'
import { KV } from '../kv.js'
import { ticketTools } from '../ticket-tools.js'

/** The kinds every client registers already; a fixture naming one of them must not have it added twice. */
const builtIn = new Set(['local', 'github', 'feishu'])
import { expect, vi } from './expect.js'

/** Everything the suite needs of one chat kind: how it is configured, how a message of its arrives, and what it delivered. */
export interface ChatKindUnderTest {
  /** The kind under test, registered beside the built-in ones (which the settings switch off). */
  kind: SourceKind
  /** Settings with only this kind on, and a policy that admits `sender`. */
  settings(): object
  /** The deployment the kind's account resolved to; its CLI must answer only in the test, never a real one. */
  deployment(stateDir: string): Deployment
  /** A message of this kind as its live consumer would store it, not yet received. */
  trigger(text: string, options?: { from?: string; at?: string; direct?: boolean; mention?: boolean }): Trigger
  /** A sender the kind's policy admits, to trigger with and to expect notes about. */
  sender: { id: string; name: string }
  /**
   * The members of the chat `trigger` writes in, as the kind's live directory read would have recorded them; without it
   * the suite records the sender. A group the directory has not recorded is one the chatter does not consider; this is
   * the record, not the path — the paths the suite checks are the kind's own.
   */
  members?: { id: string; name: string; bot?: true }[]
  /** Makes the kind's directory list the chat the fixture's triggers are written in, as a live Source's own pass would. */
  known?: boolean
  /** Everything the kind delivered through its channel, in order, with the id the platform gave each message, when it gave one. */
  sent(): { channel: ChannelRef; text: string; messageId?: string }[]
  /** How many times the fixture has seen the platform asked whether it answers: the sign-in check must move it. */
  probed(): number
  /**
   * Settings in which the kind refuses an address `settings()` accepts, and that address: the `allowed` gate is the same one
   * `scope` is, and the suite must see it refuse — a kind whose gate never says no passes while ignoring every reply.
   */
  refused(): { settings: object; channel: ChannelRef }
  /**
   * Makes the platform refuse every answer from now on (Feishu: the CLI is signed out), returning its message. Without it
   * the suite cannot show that a failing check reaches the entry; a kind with no account may leave it out.
   */
  signOut?(message: string): void
  /** Present for a kind that declares `files`: the code-level half of an attachment test the platform's CLI cannot answer. */
  files?: {
    /** A message whose stored text names one attachment, and the file the platform would return for it. */
    fixture(): { trigger: Trigger; file_key: string; name: string; data: Buffer }
  }
}

/** Runs the suite under `describe(name, …)`, one case per file: a failure names the case and the kind together. */
export function chatAcceptance(name: string, fixture: (stateDir: string) => ChatKindUnderTest): void {
  describe(`${name} chat acceptance`, () => {
    let stateDir: string
    let under: ChatKindUnderTest
    let client: SuperagentClient
    const open = (): void => {
      stateDir = mkdtempSync(join(tmpdir(), `swarm-chat-acceptance-${name}-`))
      under = fixture(stateDir)
      writeSettings(under.settings(), settingsPath(stateDir))
      // A built-in kind (Feishu) is registered by the client itself; only a test's own kind is added beside them.
      client = new SuperagentClient({ stateDir, ...builtIn.has(under.kind.kind) ? {} : { kinds: [under.kind] }, deployment: () => under.deployment(stateDir) })
      // The chat a message was written in is one its kind's directory knows, as a live Source's own pass leaves it.
      const chatId = String((under.trigger('').meta as { chatId?: unknown }).chatId)
      const members = under.members ?? [{ id: under.sender.id, name: under.sender.name }]
      client.store.set(KV.people.members(chatId), { at: new Date().toISOString(), names: Object.fromEntries(members.map((member) => [member.id, member.name])),
        ...members.some((member) => member.bot) ? { bots: members.filter((member) => member.bot).map((member) => member.id) } : {} })
      // A group's entry comes from its label (a direct chat's from the direct-chat record, which is Feishu's own).
      if (under.known) client.store.set(KV.sources.labels(under.kind.kind), { ...client.store.get(KV.sources.labels(under.kind.kind)) ?? {}, [chatId]: 'Team' })
    }
    afterEach(() => {
      vi.restoreAllMocks()
      client.close()
      rmSync(stateDir, { recursive: true, force: true })
    })
    /** Opens a case's client and fixture, torn down after it; each case gets its own state directory and delivery record. */
    const start = (): void => open()
    /** Files a request from the kind and accepts it: the ticket a worker would run for it. */
    const accepted = (trigger: Trigger): { ticketId: string; acknowledgement: string } => {
      client.engine.receive(trigger)
      client.engine.evaluateDue()
      const candidate = client.engine.candidate(trigger.id)
      assert.ok(candidate, `${name}: a message a person sent to the agent is a candidate`)
      const acknowledgement = 'On it: I have this.'
      const decision = client.engine.decide(trigger.id, { kind: 'accept', title: 'Do the thing', scope: 'Do the thing', reason: 'asked', acknowledgement, name: 'do-the-thing', evalId: candidate.evalId })
      assert.equal(decision.kind, 'accept')
      return { ticketId: decision.ticketId!, acknowledgement }
    }
    /** What the ticket's worker may do to the ticket's own trigger, as the ticket tools see it. */
    const tool = (ticketId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> =>
      ticketTools(client, ticketId).find((item) => item.name === toolName)!.run(args)

    test('a request becomes a ticket on the kind\'s own thread, and its acknowledgement arrives through the kind', async () => {
      start()
      const trigger = under.trigger('please fix the flaky test', { mention: true })
      assert.equal(trigger.source, under.kind.kind, 'the trigger is of the kind under test')
      const { ticketId, acknowledgement } = accepted(trigger)
      const ticket = client.store.tickets.get(ticketId)!
      assert.equal(ticket.mandate.actor.id, under.sender.id)
      // The thread is the kind's own: its constructors made it, and the ticket answers where the message was written.
      const chatId = String((trigger.meta as { chatId?: unknown }).chatId)
      const chat = under.kind.chat!.chat(chatId)
      assert.ok(ticket.channels.some((channel) => channel.source === under.kind.kind && channel.thread === chat.thread), 'the ticket answers on the kind\'s own thread for that chat')
      assert.ok(ticket.origin.triggerIds.includes(trigger.id) || ticket.origin.triggerId === trigger.id, 'the message is the ticket\'s origin')
      client.effects.start()
      await client.effects.idle()
      const sent = under.sent()
      assert.ok(sent.some((item) => item.text === acknowledgement && item.channel.source === under.kind.kind),
        `${name}: the acknowledgement went out through the kind: ${JSON.stringify(sent.map((item) => item.text))}`)
      assert.ok(sent.every((item) => item.channel.source === under.kind.kind), `${name}: nothing was delivered through another kind`)
    })

    test('the memory keeps what a finished ticket says about its requester, under the kind\'s own person', async () => {
      start()
      const { ticketId } = accepted(under.trigger('the deploy badge shows the old date', { mention: true }))
      client.engine.stopTicket(ticketId, 'done')
      const memories = new Memories({ client, complete: async () => JSON.stringify({ notes: [{ op: 'add', about: under.sender.id, kind: 'event', text: 'Cares about the deploy badge' }] }) })
      await memories.reflectTicket(ticketId)
      const notes = client.store.memory.about(personSubject(under.sender.id, under.kind.kind))
      assert.deepEqual(notes.map((note) => note.text), ['Cares about the deploy badge'])
      // Another chat kind's person with the same raw id is someone else. Feishu's own subject is the unqualified one, so
      // only the kinds added beside it have a second, distinct subject to compare against.
      if (under.kind.kind !== 'feishu') assert.deepEqual(client.store.memory.about(personSubject(under.sender.id)), [])
      const card = notesCard(client.store, [personSubject(under.sender.id, under.kind.kind)])
      assert.deepEqual(card.map((line) => line.text), ['Cares about the deploy badge'])
    })

    test('the chatter posts into the kind\'s chat and remembers what it said there', async () => {
      start()
      // Well past any kind's lull and inside the chatter's window; one clock, so no boundary lands between two calls to now().
      const now = Date.now()
      const trigger = under.trigger('the release notes are finally out', { at: new Date(now - 10 * 60_000).toISOString() })
      client.engine.receive(trigger)
      const room = new ChatterRoom({ client, now: () => now,
        complete: async () => JSON.stringify({ say: 'About time: they were starting to feel like a rumour.', reply_to: null, mention: null, reason: 'a lull after good news' }) })
      const chatId = String((trigger.meta as { chatId?: unknown }).chatId)
      await room.consider(chatId, under.kind.kind)
      client.effects.start()
      await client.effects.idle()
      const posted = under.sent().at(-1)!
      assert.equal(posted.channel.source, under.kind.kind)
      assert.equal(posted.text, 'About time: they were starting to feel like a rumour.')
      const said = client.store.get<{ said?: { text: string }[] }>(KV.chatter.chat(chatId))
      assert.deepEqual(said?.said?.map((line) => line.text), [posted.text])
    })

    test('a bot command from the kind answers in the conversation it came from', async () => {
      start()
      const trigger = under.trigger('/me', { mention: true })
      const commands = new BotCommands(client)
      assert.equal(commands.receive(trigger), 'stored')
      client.effects.start()
      await client.effects.idle()
      const answer = under.sent().at(-1)
      assert.ok(answer, `${name}: /me was answered through the kind`)
      assert.equal(answer!.channel.source, under.kind.kind)
      assert.ok(answer!.text.length > 0)
    })

    test('the id the platform gave a posted message is remembered as the agent\'s own, so a reply to it answers it', async () => {
      start()
      const trigger = under.trigger('hello there', { mention: true })
      const chatId = String((trigger.meta as { chatId?: unknown }).chatId)
      accepted(trigger)
      client.effects.start()
      await client.effects.idle()
      const posted = under.sent().find((item) => item.channel.address.chatId === chatId && item.messageId)
      assert.ok(posted?.messageId, `${name}: the kind told the host the id of a message it posted`)
      assert.ok(client.store.get<string[]>(KV.people.own(chatId))?.includes(posted!.messageId!), 'the posted id is kept as the agent\'s own')
    })

    test('the sign-in check reports ready on the entry the kind declared', async () => {
      start()
      const check = under.kind.check
      assert.ok(check, `${name}: the kind declares a sign-in check`)
      assert.ok(under.kind.health.includes(check!.entry), 'the check entry is one the kind declares')
      const before = under.probed()
      const health = await client.sources.check(under.kind.kind, client.commands, under.deployment(stateDir))
      assert.equal(health?.state, 'ready')
      assert.equal(client.health.all[check!.entry]?.state, 'ready')
      // A fixture whose verify returns 'ready' without asking anything proves nothing about the platform.
      assert.ok(under.probed() > before, `${name}: the check asked the platform`)
      if (!under.signOut) return
      under.signOut('The platform says the app is not installed')
      const refused = await client.sources.check(under.kind.kind, client.commands, under.deployment(stateDir))
      assert.equal(refused?.state, 'error', `${name}: a platform that refuses the check is not ready`)
      assert.match(String(refused?.detail), /not installed/)
      assert.equal(client.health.all[check!.entry]?.state, 'error')
    })

    test('a reply into an address the kind still listens to is delivered, and one it refuses settles ignored before send', async () => {
      start()
      const trigger = under.trigger('please fix the flaky test', { mention: true })
      const chatId = String((trigger.meta as { chatId?: unknown }).chatId)
      const message = (id: string, chatId: string) => ({ id, channel: under.kind.chat!.chat(chatId), text: 'hello', kind: 'reply' as const })
      const delivered = `${name}-accepted`
      client.outbox.send(message(delivered, chatId))
      client.effects.start()
      await client.outbox.sent()
      assert.equal(client.outbox.status(delivered), 'sent', `${name}: an address the kind accepts takes the reply`)
      // The kind's `allowed` gate refuses an address its own scope would refuse: the ordinary settings take it, the
      // refusing ones do not, and a reply dropped for that reason reads channelIgnored, never channelGone.
      const { settings: refusing, channel } = under.refused()
      assert.equal(client.sources.channelAllowed(channel), true, `${name}: the ordinary settings take this address`)
      assert.equal(client.sources.channelAllowed(channel, refusing as Parameters<typeof client.sources.channelAllowed>[1]), false,
        `${name}: an address the kind no longer listens to is refused`)
      // The settings file is read per call, so this is the same gate the Outbox asks before every delivery.
      writeSettings(refusing, settingsPath(stateDir))
      assert.equal(client.sources.channelAllowed(channel), false)
      const ignored = `${name}-ignored`
      const refusedText = 'this must not leave'
      client.outbox.send({ ...message(ignored, String((channel.address as { chatId?: string }).chatId)), channel, text: refusedText })
      // One delivering pass: the gate is asked, and the refusal settles the receipt rather than sending.
      await client.outbox.sent()
      assert.equal(client.outbox.status(ignored), 'dropped')
      assert.equal(client.store.receipts.get(ignored)?.dropped?.reason, 'channelIgnored')
      assert.equal(under.sent().some((item) => item.text === refusedText), false, `${name}: the refused reply never reached the platform`)
    })

    test('the link a channel offers is a non-empty page under the kind\'s own platform name', () => {
      start()
      const chatId = String((under.trigger('').meta as { chatId?: unknown }).chatId)
      const link = client.sources.link(under.kind.chat!.chat(chatId), {})
      assert.ok(link.url.length > 0, `${name}: the channel links to a page`)
      // The label is the page's own wording, which must name the platform ("Feishu message", "FakeChat").
      assert.ok(link.label.includes(client.sources.chatKind(under.kind.kind)!.platform), `${name}: the link is named for its platform: ${link.label}`)
    })

    test('a message without readable files is refused by the platform\'s name', async () => {
      start()
      const trigger = under.trigger('see the log I pasted', { mention: true })
      const { ticketId } = accepted(trigger)
      if (!under.files) {
        await expect(tool(ticketId, 'attachment', { trigger_id: trigger.id })).rejects.toThrow('have no attachments this worker can read')
        return
      }
      const { trigger: posted, file_key, name, data } = under.files.fixture()
      const { ticketId: holder } = accepted(posted)
      const listed = await tool(holder, 'attachment', { trigger_id: posted.id }) as { attachments: { file_key: string }[] }
      assert.deepEqual(listed.attachments.map((item) => item.file_key), [file_key])
      const read = await tool(holder, 'attachment', { trigger_id: posted.id, file_key }) as { name: string; bytes: number; base64?: string }
      assert.equal(read.name, name)
      assert.equal(read.bytes, data.length)
      assert.ok(Buffer.from(String(read.base64), 'base64').equals(data), 'the bytes the platform gave come back whole')
    })
  })
}
