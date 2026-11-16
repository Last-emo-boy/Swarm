/**
 * The acceptance test for the chat seam: a chat kind under another source name goes through intake, policy, the chat
 * accessor and the channel constructors without any Feishu code being consulted. Feishu is off in these settings, and the
 * fake kind's channel sends into an in-memory sink, so nothing here can reach the platform.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { SuperagentClient } from '../client.js'
import { threadKey } from '../core/index.js'
import { ModelAssessor } from '../assessor.js'
import { BotCommands, commandOf } from '../bot-commands.js'
import { ChatterRoom } from '../chatter.js'
import { ticketTools } from '../ticket-tools.js'
import { Memories, chatSubject, notesCard, personSubject } from '../memories.js'
import { KV } from '../kv.js'
import { writeSettings, settingsPath } from '../settings.js'
import { metaOf } from '../sources/meta.js'
import { fakeChatKind, fakeChatSource, fakeSink, fakeTrigger, FAKE_SOURCE } from './fake-chat.js'
import { testDeployment } from './fixtures.js'
import { expect } from './expect.js'

let stateDir: string
let client: SuperagentClient
let sink: ReturnType<typeof fakeSink>
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'swarm-fake-chat-'))
  sink = fakeSink()
  // Every Source but the fake one is off: nothing Feishu-shaped may be needed for a ticket from this chat.
  writeSettings({ sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} }, [FAKE_SOURCE]: { enabled: true, config: {} } },
    policy: { sources: { [FAKE_SOURCE]: { allowed: [{ id: 'fk_ann', name: 'Ann' }] } } },
    // The memory and chatter are on, since the acceptance cases below are theirs.
    // Lulls short, and few messages needed, so a test's own few messages qualify.
    memory: { enabled: true, lullSeconds: 10, minMessages: 1 }, chatter: { everywhere: true } }, settingsPath(stateDir))
  client = new SuperagentClient({ stateDir, kinds: [fakeChatSource(sink, { room1: { people: [{ id: 'fk_ann', name: 'Ann' }, { id: 'fk_bo', name: 'Bo' }] } })],
    deployment: () => testDeployment({ repository: "", github: undefined, feishu: undefined }) })
})
afterEach(() => {
  client.close()
  rmSync(stateDir, { recursive: true, force: true })
})

test('a message in a fake chat becomes a ticket whose acknowledgement the fake chat\'s channel carries, with Feishu off', async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'please fix the flaky test', { mention: true })
  assert.equal(trigger.source, FAKE_SOURCE)
  // The accessor reads the message the kind built, and the kind describes its channel back.
  const meta = metaOf(trigger)
  assert.equal(meta.chatId, 'room1')
  assert.equal(meta.messageId, trigger.meta.messageId)
  assert.equal(meta.direct, false)

  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const candidate = client.engine.candidate(trigger.id)
  assert.ok(candidate, 'the explicit fake-chat message is a candidate')
  assert.equal(candidate.strength, 'explicit')

  const decision = client.engine.decide(trigger.id, {
    kind: 'accept', title: 'Fix the flaky test', scope: 'Fix the flaky test', reason: 'requested',
    acknowledgement: 'On it: fixing the flaky test.', name: 'fix-flaky-test', evalId: candidate.evalId,
  })
  assert.equal(decision.kind, 'accept')
  const ticket = client.store.tickets.get(decision.ticketId!)!
  assert.ok(ticket, 'the fake-chat request became a ticket')

  // The ticket's threads are the fake kind's own thread, and the agent's identity there comes from the kind.
  assert.equal(ticket.id, decision.ticketId)
  assert.equal(threadKey(trigger.threads[0]!), 'fakechat:room1')
  assert.deepEqual(client.sources.agent(FAKE_SOURCE, client.resolvedDeployment()), { id: 'fake_bot', name: 'Fake Bot', ownIds: ['fake_bot'] })
  assert.equal(client.sources.chatKind(FAKE_SOURCE)?.platform, 'FakeChat')
  assert.deepEqual(client.sources.chatKind(FAKE_SOURCE)?.directory.chats(client.store).map((chat) => chat.source), ['fakechat'])

  // A reply through the kind's constructors goes into the fake chat's sink and nowhere else.
  const channel = client.sources.chatKind(FAKE_SOURCE)!.update('room1', String(trigger.meta.messageId), false, true)
  assert.deepEqual(client.sources.chatKind(FAKE_SOURCE)!.describe(channel), { chatId: 'room1', messageId: String(trigger.meta.messageId), direct: false, mode: 'chat' })
  assert.equal(await client.sources.send({ id: 'r1', channel, text: 'On it: fixing the flaky test.', kind: 'reply' }, client.commands), 'sent')
  assert.equal(sink.sent.length, 1)
  assert.equal(sink.sent[0]?.text, 'On it: fixing the flaky test.')
  assert.equal(sink.sent[0]?.channel.source, FAKE_SOURCE)
})

test('the chat reads take their source from the caller: a fake-chat message is found under its own source and never as Feishu', () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'is anyone free to look at the deploy?', { mention: true })
  client.engine.receive(trigger)
  const since = new Date(Date.parse(trigger.at) - 60_000).toISOString()
  assert.deepEqual(client.store.read.chatMessages({ source: FAKE_SOURCE, chatId: 'room1' }, since, 10).map((item) => item.id), [trigger.id])
  // The same chat id under Feishu finds nothing: the read is of the source named, not of a platform spelled into the query.
  assert.deepEqual(client.store.read.chatMessages({ source: 'feishu', chatId: 'room1' }, since, 10), [])
  assert.equal(client.store.read.sourceOfChat('room1'), FAKE_SOURCE)
  // A person id resolves to the kind whose directory holds it, and their direct chat is looked for under that kind alone;
  // this message is in a group, so there is none yet.
  assert.equal(client.store.read.directChat('fk_ann'), undefined)
  client.engine.receive(fakeTrigger('room1', 'fk_ann', 'one more thing', { direct: true }))
  assert.equal(client.store.read.directChat('fk_ann'), 'room1')
})

test('a directory entry carries its source, and every constructor it offers stays in that source', () => {
  const kind = client.sources.chatKind(FAKE_SOURCE)!
  assert.deepEqual(kind.directory.chat(client.store, 'room1'), { source: FAKE_SOURCE, chatId: 'room1', name: 'room1', people: 2 })
  assert.deepEqual(kind.directory.chats(client.store), [{ source: FAKE_SOURCE, chatId: 'room1', name: 'room1', people: 2 }])
  expect(kind.thread('room1')).toEqual({ source: FAKE_SOURCE, id: 'room1' })
  expect(kind.chat('room1').source).toBe(FAKE_SOURCE)
  expect(kind.update('room1', 'fm_1', false, false).source).toBe(FAKE_SOURCE)
  expect(kind.user('fk_ann').source).toBe(FAKE_SOURCE)
  expect(client.sources.sourceOfPerson('fk_ann')).toBe(FAKE_SOURCE)
  expect(client.sources.sourceOfChat('room1')).toBe(FAKE_SOURCE)
})

/** A model that answers from a script, one call per attempt; each answer is read in order. */
const script = (answers: string[]): ((input: { purpose: string }) => Promise<string>) => async () => {
  const next = answers.shift()
  if (next === undefined) throw new Error('no scripted answer left')
  return next
}

test("memory keeps what a fake-chat ticket's reflection says about its requester, and shows it on the card", async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'the deploy badge shows the old date', { mention: true })
  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const candidate = client.engine.candidate(trigger.id)!
  const decision = client.engine.decide(trigger.id, { kind: 'accept', title: 'Fix the deploy badge', scope: 'Fix the deploy badge', reason: 'asked', name: 'fix-deploy-badge', evalId: candidate.evalId })
  client.engine.stopTicket(decision.ticketId!, 'done')
  const memories = new Memories({ client, complete: script([JSON.stringify({ notes: [{ op: 'add', about: 'fk_ann', kind: 'event', text: 'Ann cares about the deploy badge' }] })]) })
  await memories.reflectTicket(decision.ticketId!)
  // The note hangs off the fake kind's own subject, and the ticket's chat is the kind's, not Feishu's.
  const notes = client.store.memory.about(personSubject('fk_ann', FAKE_SOURCE))
  expect(notes.map((note) => note.text)).toEqual(['Ann cares about the deploy badge'])
  expect(notes[0]!.origin).toMatchObject({ chatId: trigger.meta.chatId, ticketId: decision.ticketId })
  const card = notesCard(client.store, [personSubject('fk_ann', FAKE_SOURCE), chatSubject('room1'), 'self'])
  expect(card.map((line) => line.text)).toEqual(['Ann cares about the deploy badge'])
})

test("a chatter line in a fake chat posts into its sink through the kind, and is remembered as said", async () => {
  client.engine.receive(fakeTrigger('room1', 'fk_ann', 'the release notes are finally out', { mention: false, at: new Date(Date.now() - 10 * 60_000).toISOString() }))
  const room = new ChatterRoom({ client, now: () => Date.now(),
    complete: script([JSON.stringify({ say: 'About time: I was starting to think they were a rumour.', reply_to: null, mention: null, reason: 'a lull after good news' })]) })
  await room.consider('room1', FAKE_SOURCE)
  client.effects.start()
  await client.effects.idle()
  const posted = sink.sent.at(-1)!
  expect(posted.channel.source).toBe(FAKE_SOURCE)
  expect(posted.text).toBe('About time: I was starting to think they were a rumour.')
  // The outbox remembers what the agent said there, through the kind's describe: the chat's own record, not Feishu's.
  const said = client.store.get<{ said?: { text: string }[] }>(KV.chatter.chat('room1'))
  expect(said?.said?.map((line) => line.text)).toEqual(['About time: I was starting to think they were a rumour.'])
})

test("the consider card's memory is the fake chat's own, not a Feishu person who shares the id", async () => {
  client.engine.receive(fakeTrigger('room1', 'fk_ann', 'the release notes are finally out', { mention: false, at: new Date(Date.now() - 10 * 60_000).toISOString() }))
  const now = new Date().toISOString()
  client.store.memory.save({ id: 'fake-ann', about: personSubject('fk_ann', FAKE_SOURCE), text: 'Ann here owns the release train', kind: 'fact', origin: { chatId: 'room1', source: FAKE_SOURCE }, created: now, updated: now })
  client.store.memory.save({ id: 'feishu-ann', about: personSubject('fk_ann'), text: 'Someone else on another platform', kind: 'fact', origin: { chatId: 'oc_elsewhere' }, created: now, updated: now })
  const users: string[] = []
  const room = new ChatterRoom({ client, now: () => Date.now(),
    complete: async (input) => { users.push(input.user); return JSON.stringify({ say: 'Neither has anything new to say.', reply_to: null, mention: null, reason: 'a lull' }) } })
  await room.consider('room1', FAKE_SOURCE)
  // Ann's notes under this kind reach the card, and the Feishu person with the same raw id is someone else.
  const card = JSON.parse(users[0]!) as { memory?: { text: string }[] }
  expect(card.memory?.map((item) => item.text)).toEqual(['Ann here owns the release train'])
})

test("a bot command from a fake chat answers in the conversation, and the router runs one for a person the same way", async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', '/me', { mention: true })
  const commands = new BotCommands(client)
  expect(commandOf(trigger, (source) => client.sources.chatKind(source) !== undefined)).toMatchObject({ name: 'me' })
  expect(commands.receive(trigger)).toBe('stored')
  client.effects.start()
  await client.effects.idle()
  const answer = sink.sent.at(-1)!
  expect(answer.channel.source).toBe(FAKE_SOURCE)
  expect(answer.channel.address).toMatchObject({ chatId: 'room1' })
  // A typed command carries no language, so its answer follows the deployment's brand wording (/me's own text below);
  // the point here is where it went, which is the fake chat's sink, not a platform CLI.
  expect(answer.text.length).toBeGreaterThan(0)
  expect(commandOf(trigger, () => false)).toBeUndefined()
})

test("the router accepts a fake-chat request with an acknowledgement that goes into the fake chat, and its answer lands in the conversation", async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'please rename the build script', { mention: true })
  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const assessor = new ModelAssessor({ client, configured: () => false, complete: script([JSON.stringify({
    kind: 'accept', title: 'Rename the build script', worktree_name: 'rename-build-script', acknowledgement: 'On it: renaming the build script.' })]) })
  const candidate = client.engine.candidate(trigger.id)!
  await assessor.judge(trigger.id, candidate.evalId)
  client.effects.start()
  await client.effects.idle()
  const decision = client.store.decisions.get(client.store.triggers.disposition(trigger.id)!.decisionId!)!
  expect(decision.kind).toBe('accept')
  const acknowledgement = sink.sent.find((message) => message.text === 'On it: renaming the build script.')
  expect(acknowledgement?.channel.source).toBe(FAKE_SOURCE)
  expect(acknowledgement?.channel.address).toMatchObject({ chatId: 'room1' })
})

test("the router remembering about the chat on a fake-chat request writes the fake kind's subject, not Feishu's", async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'the release is Friday, remember that', { mention: true })
  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const assessor = new ModelAssessor({ client, configured: () => false, complete: script([JSON.stringify({
    kind: 'chat', reply: 'Noted.', remember: [{ about: 'chat', kind: 'event', text: 'The release is Friday' }] })]) })
  const candidate = client.engine.candidate(trigger.id)!
  await assessor.judge(trigger.id, candidate.evalId)
  client.effects.start()
  await client.effects.idle()
  // The chat's own subject, where its reflection reads it; the plain id a Feishu chat would use stays empty.
  expect(client.store.memory.about(chatSubject('room1', FAKE_SOURCE)).map((note) => note.text)).toEqual(['The release is Friday'])
  expect(client.store.memory.about(chatSubject('room1'))).toEqual([])
})

test('a person is addressed by id and by name through the ticket\'s own kind, with Feishu off', async () => {
  // A ticket with no chat origin: a GitHub-style request whose source has no chat kind.
  const { triggerId } = client.request('tell Ann the deploy badge is fixed')
  client.engine.evaluateDue()
  const candidate = client.engine.candidate(triggerId)!
  const { ticketId } = client.engine.decide(triggerId, { kind: 'accept', title: 'Tell Ann', scope: 'x', reason: 'asked', name: 'tell-ann', evalId: candidate.evalId })
  const run = (name: string, args: Record<string, unknown>) => ticketTools(client, ticketId!).find((tool) => tool.name === name)!.run(args)
  // The first chat kind that is on carries the message, and its directory resolves the person both ways.
  expect(await run('message', { to: 'fk_ann', text: 'The deploy badge is fixed.' })).toEqual({ sent: true, to: 'Ann' })
  client.effects.start()
  await client.effects.idle()
  expect(sink.sent.at(-1)?.channel.source).toBe(FAKE_SOURCE)
  expect(sink.sent.at(-1)?.channel.address).toMatchObject({ userId: 'fk_ann', mode: 'user' })
  expect(await run('message', { to: 'Ann', text: 'And the date is right now.' })).toEqual({ sent: true, to: 'Ann' })
  await client.effects.idle()
  // The people tool reads the fake chat's directory too.
  expect(await run('people', { name: 'ann' })).toEqual({ people: [{ id: 'fk_ann', name: 'Ann', chats: ['room1'] }] })
  // Two chat kinds are installed, so each chat says which kind it is: the fake one's, while Feishu's records are empty.
  expect(await run('people', {})).toEqual({ chats: [{ source: FAKE_SOURCE, chat_id: 'room1', name: 'room1', people: 2 }] })
})

test("a promise made in a fake-chat ticket is kept through that chat's own kind", async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'ping me when the badge is fixed', { mention: true })
  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const candidate = client.engine.candidate(trigger.id)!
  const decision = client.engine.decide(trigger.id, { kind: 'accept', title: 'Fix the badge', scope: 'x', reason: 'asked', name: 'fix-badge', evalId: candidate.evalId })
  const memories = new Memories({ client, complete: script([JSON.stringify({ say: 'The badge is fixed now.' })]) })
  // A promise due now, learned on this ticket: its origin carries the fake source.
  const { applyOps } = await import('../memories.js')
  const problem = applyOps(client.store, [{ op: 'add', about: 'self', kind: 'promise', text: 'Tell Ann the badge is fixed', due: new Date(Date.now() - 1000).toISOString() }],
    { subjects: () => 'self', shown: new Set() }, { ticketId: decision.ticketId!, chatId: 'room1', source: FAKE_SOURCE })
  expect(problem).toBeUndefined()
  const note = client.store.memory.about('self', 10).find((item) => item.kind === 'promise')!
  await memories.keep(note.id)
  client.effects.start()
  await client.effects.idle()
  expect(sink.sent.map((message) => [message.channel.source, message.channel.address.chatId, message.text])).toEqual([[FAKE_SOURCE, 'room1', 'The badge is fixed now.']])
  expect(client.store.memory.get(note.id)?.done).toBeTruthy()
})

test("a ticket's worker remembering about its chat writes the fake kind's subject, and reads a Feishu chat id the same way", async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'remember what we decided about the release', { mention: true })
  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const candidate = client.engine.candidate(trigger.id)!
  const { ticketId } = client.engine.decide(trigger.id, { kind: 'accept', title: 'Remember the release', scope: 'x', reason: 'asked', name: 'remember-release', evalId: candidate.evalId })
  const run = (name: string, args: Record<string, unknown>) => ticketTools(client, ticketId!).find((tool) => tool.name === name)!.run(args)
  expect(await run('remember', { about: 'chat', kind: 'event', text: 'The release is Friday' })).toEqual({ remembered: true })
  // The note hangs off the fake kind's own chat, where that chat's reflection reads it, not Feishu's plain chat id.
  expect(client.store.memory.about(chatSubject('room1', FAKE_SOURCE)).map((note) => note.text)).toEqual(['The release is Friday'])
  expect(client.store.memory.about(chatSubject('room1'))).toEqual([])
  // Naming the chat by its id resolves through the kind that holds it, to the same subject.
  expect(await run('remember', { about: 'room1', kind: 'event', text: 'The release moved to Monday' })).toEqual({ remembered: true })
  expect(client.store.memory.about(chatSubject('room1', FAKE_SOURCE)).map((note) => note.text).sort()).toEqual(['The release is Friday', 'The release moved to Monday'].sort())
})

test("the periodic reflection pass sees a fake chat's conversations, and its reflection keeps a note", async () => {
  const say = fakeTrigger('room1', 'fk_ann', 'we settled on the new release date: Friday', { mention: false, at: new Date(Date.now() - 10 * 60_000).toISOString() })
  client.engine.receive(say)
  const memories = new Memories({ client, complete: script([JSON.stringify({ notes: [{ op: 'add', about: 'fk_ann', kind: 'event', text: 'The release is Friday' }] })]) })
  memories.install()
  // The chat is quiet and has a message since its first window: pass() queues its reflection with the fake source.
  memories.pass()
  const queued = client.store.db.prepare("SELECT key, value FROM effect WHERE kind = 'reflect'").all().map((row) => ({ key: String(row.key), value: JSON.stringify(row.value) }))
  expect(queued.find((item) => item.key === 'chat:room1')?.value).toContain(FAKE_SOURCE)
  client.effects.start()
  await client.effects.idle()
  expect(client.store.memory.about(personSubject('fk_ann', FAKE_SOURCE)).map((note) => note.text)).toEqual(['The release is Friday'])
})

test("a room message naming the bot in a fake chat is attended to, under the fake kind's name and platform", async () => {
  const named = fakeTrigger('room1', 'fk_ann', 'Fake Bot, what do you think of Friday?', { mention: false, at: new Date(Date.now() - 60_000).toISOString() })
  client.engine.receive(named)
  // What it remembers of Ann as this chat kind's person, and a note about a same-id person on Feishu that must not be hers.
  const { personSubject: subject } = await import('../memories.js')
  client.store.memory.save({ id: 'fake-ann', about: subject('fk_ann', FAKE_SOURCE), text: 'Ann here owns the release train', kind: 'fact', origin: { chatId: 'room1', source: FAKE_SOURCE },
    created: new Date().toISOString(), updated: new Date().toISOString() })
  client.store.memory.save({ id: 'feishu-ann', about: subject('fk_ann'), text: 'Someone else on another platform', kind: 'fact', origin: { chatId: 'oc_elsewhere' },
    created: new Date().toISOString(), updated: new Date().toISOString() })
  const prompts: string[] = []
  const users: string[] = []
  const room = new ChatterRoom({ client, now: () => Date.now(),
    complete: async (input) => { prompts.push(input.system); users.push(input.user); return JSON.stringify({ reply: { text: 'Friday works.', reply_to: null }, relay: [], ask_back: [], reason: 'someone put a question to me' }) } })
  await room.attend('room1', [named.id], FAKE_SOURCE)
  // The card's memory is the fake chat's own: the source it attends under reaches the subjects it reads.
  const card = JSON.parse(users[0]!) as { memory?: { text: string }[] }
  expect(card.memory?.map((item) => item.text)).toEqual(['Ann here owns the release train'])
  client.effects.start()
  await client.effects.idle()
  // The persona says where it is: the kind's own platform, not Feishu's.
  expect(prompts[0]).toContain('a member of a group chat on FakeChat')
  const posted = sink.sent.at(-1)!
  expect(posted.channel.source).toBe(FAKE_SOURCE)
  expect(posted.text).toBe('Friday works.')
  // The id on the card is the platform's message id, so the model's reply_to names a message that exists here.
  expect(posted.channel.address.messageId).toBe(named.meta.messageId)
})

test("the router's message route records the fake source on the ask it opens", async () => {
  const { openAsks } = await import('../asks.js')
  const asked = fakeTrigger('room1', 'fk_ann', 'ask Bo whether the release shipped, and tell me', { mention: true })
  client.engine.receive(asked)
  client.engine.evaluateDue()
  const assessor = new ModelAssessor({ client, configured: () => false, complete: script([JSON.stringify({
    kind: 'message', to: 'Bo', text: 'Did the release ship?', await_answer: true, reply: 'Asking Bo now.' })]) })
  const candidate = client.engine.candidate(asked.id)!
  await assessor.judge(asked.id, candidate.evalId)
  // Without the source the chatter would hunt for the answer in a Feishu chat called room1, which does not exist.
  expect(openAsks(client.store, Date.now()).map((item) => [item.person, item.source])).toEqual([['fk_bo', FAKE_SOURCE]])
})

test("an ask made from a fake chat is looked up there, and its answer is relayed back through the fake kind", async () => {
  const { ask, openAsks } = await import('../asks.js')
  const asked = fakeTrigger('room1', 'fk_ann', 'ask Bo whether the release shipped, and tell me', { mention: true })
  client.engine.receive(asked)
  // What the router's message route stores: the ask names its source, so its answer is hunted for in the fake chat.
  const at = new Date(Date.now()).toISOString()
  ask(client.store, { id: 'ask-1', source: FAKE_SOURCE, person: 'fk_bo', to: ['fk_bo'], text: 'Did the release ship?', at,
    for: { id: 'fk_ann', name: 'Ann', channel: client.sources.chatKind(FAKE_SOURCE)!.update('room1', String(asked.meta.messageId), false, false) } }, Date.now())
  // Bo answers in his direct messages, where the question went.
  const answer = fakeTrigger('room1', 'fk_bo', 'Shipped this morning.', { direct: true, at: new Date(Date.now() + 1000).toISOString() })
  client.engine.receive(answer)
  // Later than the answer by more than the settle window, so the attention pass acts on it at once.
  const later = Date.now() + 60_000
  const room = new ChatterRoom({ client, now: () => later, complete: script([JSON.stringify({
    reply: { text: 'Bo says it shipped this morning.', reply_to: answer.meta.messageId }, relay: [{ question: 'ask-1', text: 'Bo says it shipped this morning.' }] })]) })
  room.install()
  // The attention pass finds the ask's chat through the fake kind's directory, with no source passed by the caller.
  // The first look starts its clock at the question; the next one reads what came after it.
  room.pass()
  room.pass()
  client.effects.start()
  await client.effects.idle()
  const relayed = sink.sent.find((message) => message.text === 'Bo says it shipped this morning.')
  expect(relayed?.channel.source).toBe(FAKE_SOURCE)
  expect(relayed?.channel.address).toMatchObject({ chatId: 'room1' })
  expect(openAsks(client.store, Date.now())).toEqual([])
})

test('a message whose fields are only in the channel address, not in meta, is still read by callOf', async () => {
  const { callOf } = await import('../chatter.js')
  const { posted } = await import('../people.js')
  // The agent posted fm_own in the room; a message replying to it answers the agent.
  posted(client.store, 'room1', 'fm_own')
  // A kind that stores the chat and message fields in the address rather than meta, as the accessor allows.
  const base = { source: FAKE_SOURCE, threads: [{ source: FAKE_SOURCE, id: 'room1' }], actor: { source: FAKE_SOURCE, id: 'fk_ann' },
    human: true, at: new Date(Date.now() - 60_000).toISOString(), text: 'agreed', meta: {} }
  const reply = { ...base, id: 'bare_1', channel: { source: FAKE_SOURCE, thread: 'fakechat:room1', address: { chatId: 'room1', messageId: 'fm_addr_only', parentId: 'fm_own' } } }
  // The reply is recognised from the address alone; with the fields read raw it would look like a message to no one.
  expect(callOf(client.store, reply as never, 'Fake Bot', [])?.why).toBe('replies_to_you')
  const named = { ...base, id: 'bare_2', text: 'Fake Bot, what do you think?', channel: { source: FAKE_SOURCE, thread: 'fakechat:room1', address: { chatId: 'room1', messageId: 'fm_addr_only' } } }
  expect(callOf(client.store, named as never, 'Fake Bot', [])?.why).toBe('names_you')
})

test("a room message naming the bot makes the attention pass attend to it, under the fake kind's own name", async () => {
  // This deployment has no Feishu bot, so only the kind's own agent name can make 'Fake Bot' a name.
  client.engine.receive(fakeTrigger('room1', 'fk_ann', 'Fake Bot, what do you think of Friday?', { mention: false, at: new Date(Date.now() - 120_000).toISOString() }))
  const room = new ChatterRoom({ client, now: () => Date.now(), complete: async () => JSON.stringify({ reply: { text: 'Friday works.', reply_to: null }, relay: [], reason: 'asked directly' }) })
  room.install()
  // It has been looking at the room for a while: the message came after it started.
  client.store.set(KV.chatter.chat('room1'), { said: [], attendedAt: new Date(Date.now() - 300_000).toISOString() })
  room.pass()
  const attend = client.store.db.prepare("SELECT value FROM effect WHERE kind = 'attend'").all().map((row) => JSON.parse(String((row as { value: string }).value)))
  expect(attend.map((item) => [item.chatId, item.source])).toEqual([['room1', FAKE_SOURCE]])
  client.effects.start()
  await client.effects.idle()
  const posted = sink.sent.at(-1)!
  expect(posted.channel.source).toBe(FAKE_SOURCE)
  expect(posted.text).toBe('Friday works.')
})

test('a fake-chat kind without files says so by its platform name instead of reading a Feishu path', async () => {
  const trigger = fakeTrigger('room1', 'fk_ann', 'see the log I pasted', { mention: true })
  client.engine.receive(trigger)
  client.engine.evaluateDue()
  const candidate = client.engine.candidate(trigger.id)!
  const { ticketId } = client.engine.decide(trigger.id, { kind: 'accept', title: 'Read the log', scope: 'x', reason: 'asked', name: 'read-log', evalId: candidate.evalId })
  const run = (name: string, args: Record<string, unknown>) => ticketTools(client, ticketId!).find((tool) => tool.name === name)!.run(args)
  // The attachment tool serves any kind that declares files; this one declares none, and the refusal names its platform.
  await expect(run('attachment', { trigger_id: trigger.id })).rejects.toThrow('FakeChat messages have no attachments')
  // `read` routes nothing to it: a feishu/ resource is unknown here, never a Feishu read under a fake kind.
  await expect(run('read', { resource: `feishu/${trigger.id}/thread` })).rejects.toThrow('Unknown resource')
})

test("a fake kind's channel sees its own configuration: with a room list, a send into an unlisted room is gone", async () => {
  // The channel alone, with the configuration the registry would hand it: no client, so nothing else can send.
  const channel = fakeChatSource(sink).channel!
  const message = (chatId: string) => ({ id: `r-${chatId}`, channel: fakeChatKind(fakeSink()).chat(chatId), text: 'hello', kind: 'reply' as const })
  expect(await channel.send({ commands: {} as never, config: { rooms: [], botId: 'fake_bot', botName: 'Fake Bot' } }, message('room1'))).toBe('sent')
  expect(await channel.send({ commands: {} as never, config: { rooms: ['room1'], botId: 'fake_bot', botName: 'Fake Bot' } }, message('room2'))).toBe('gone')
  expect(await channel.send({ commands: {} as never, config: { rooms: ['room1'], botId: 'fake_bot', botName: 'Fake Bot' } }, message('room1'))).toBe('sent')
  expect(sink.sent.map((sent) => sent.channel.address.chatId)).toEqual(['room1', 'room1'])
})

test("an attend remembers a fact it learns, under the fake kind's own subject and only while memory is on", async () => {
  const named = fakeTrigger('room1', 'fk_ann', 'Fake Bot, I run the release train; ping me before you ship', { mention: false, at: new Date(Date.now() - 60_000).toISOString() })
  client.engine.receive(named)
  const room = new ChatterRoom({ client, now: () => Date.now(), complete: script([JSON.stringify({ reply: { text: 'Noted: pinging you first.', reply_to: named.meta.messageId },
    remember: [{ about: 'fk_ann', kind: 'fact', text: 'Ann runs the release train' }], reason: 'learned who runs the release' })]) })
  await room.attend('room1', [named.id], FAKE_SOURCE)
  client.effects.start()
  await client.effects.idle()
  // The note is Ann's on the fake chat, never the same-id person on another chat kind, and its origin names the source it came from.
  const notes = client.store.memory.about(personSubject('fk_ann', FAKE_SOURCE))
  expect(notes.map((note) => [note.kind, note.text])).toEqual([['fact', 'Ann runs the release train']])
  expect(notes[0]!.origin).toMatchObject({ chatId: 'room1', source: FAKE_SOURCE, triggerId: named.id })
  expect(client.store.memory.about(personSubject('fk_ann'))).toEqual([])
  expect(sink.sent.at(-1)!.text).toBe('Noted: pinging you first.')

  // Memory off means no note, whatever the answer asks for.
  writeSettings({ sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} }, [FAKE_SOURCE]: { enabled: true, config: {} } },
    policy: { sources: { [FAKE_SOURCE]: { allowed: [{ id: 'fk_ann', name: 'Ann' }] } } },
    memory: { enabled: false }, chatter: { everywhere: true } }, settingsPath(stateDir))
  const after = fakeTrigger('room1', 'fk_ann', 'Fake Bot, I also maintain the docs site', { mention: false, at: new Date(Date.now() - 30_000).toISOString() })
  client.engine.receive(after)
  const off = new ChatterRoom({ client, now: () => Date.now(), complete: script([JSON.stringify({ reply: { text: 'Good to know.', reply_to: after.meta.messageId },
    remember: [{ about: 'fk_ann', kind: 'fact', text: 'Ann maintains the docs site' }], reason: 'learned more' })]) })
  await off.attend('room1', [after.id], FAKE_SOURCE)
  client.effects.start()
  await client.effects.idle()
  expect(client.store.memory.about(personSubject('fk_ann', FAKE_SOURCE)).map((note) => note.text)).toEqual(['Ann runs the release train'])
  expect(sink.sent.at(-1)!.text).toBe('Good to know.')
})

test("an attend may not change a note it was not shown: the id is refused and the reply still goes out", async () => {
  const named = fakeTrigger('room1', 'fk_ann', 'Fake Bot, we moved the release to Monday', { mention: false, at: new Date(Date.now() - 60_000).toISOString() })
  client.engine.receive(named)
  const room = new ChatterRoom({ client, now: () => Date.now(), complete: script([JSON.stringify({ reply: { text: 'Monday then.', reply_to: named.meta.messageId },
    remember: [{ id: 'note_not_shown', text: 'The release is Monday' }], reason: 'the date changed' })]) })
  await room.attend('room1', [named.id], FAKE_SOURCE)
  client.effects.start()
  await client.effects.idle()
  expect(client.store.memory.about('self')).toEqual([])
  expect(client.store.memory.about(personSubject('fk_ann', FAKE_SOURCE))).toEqual([])
  expect(sink.sent.at(-1)!.text).toBe('Monday then.')
})

test("two messages that call for the bot in one settle window are each answered, with one outbox message apiece", async () => {
  // A person's @ is the router's (the card would leave it alone); naming the bot is attend's own call, two senders at once.
  const ann = fakeTrigger('room1', 'fk_ann', 'Fake Bot, is Friday fine for the release?', { mention: false, at: new Date(Date.now() - 20_000).toISOString() })
  const bo = fakeTrigger('room1', 'fk_bo', 'Fake Bot, or would Thursday be better?', { mention: false, at: new Date(Date.now() - 10_000).toISOString() })
  client.engine.receive(ann)
  client.engine.receive(bo)
  const room = new ChatterRoom({ client, now: () => Date.now(), complete: script([JSON.stringify({ reply: [
    { text: 'Friday works.', reply_to: ann.meta.messageId, mention: 'fk_ann' },
    { text: 'Thursday is tighter.', reply_to: bo.meta.messageId }], relay: [], reason: 'two questions put to me' })]) })
  room.install()
  client.store.set(KV.chatter.chat('room1'), { said: [], attendedAt: new Date(Date.now() - 60_000).toISOString() })
  room.pass()
  client.effects.start()
  await client.effects.idle()
  // One message per answer, each quoting the message it answers; neither sender is left silent.
  expect(sink.sent.map((sent) => [sent.text, sent.channel.address.messageId])).toEqual([
    ['Friday works.', ann.meta.messageId], ['Thursday is tighter.', bo.meta.messageId]])
  expect(sink.sent.map((sent) => sent.mentions?.map((mention) => mention.id) ?? [])).toEqual([['fk_ann'], []])
  // Both calls were answered, so the mark passes both: neither is asked again next settle.
  expect(client.store.get(KV.chatter.chat('room1'))?.attendedAt).toBe(bo.at)
})

test("a declined call is marked seen while an undirected message after it is read again next settle", async () => {
  const declined = fakeTrigger('room1', 'fk_ann', 'Fake Bot, does anyone still use the old dashboard?', { mention: false, at: new Date(Date.now() - 30_000).toISOString() })
  const aside = fakeTrigger('room1', 'fk_bo', 'no rush on that, whenever', { mention: false, at: new Date(Date.now() - 29_000).toISOString() })
  client.engine.receive(declined)
  client.engine.receive(aside)
  const room = new ChatterRoom({ client, now: () => Date.now(), complete: script([JSON.stringify({ reply: [
    { text: null, reply_to: declined.meta.messageId }], relay: [], reason: 'talk between others' })]) })
  room.install()
  client.store.set(KV.chatter.chat('room1'), { said: [], attendedAt: new Date(Date.now() - 60_000).toISOString() })
  room.pass()
  client.effects.start()
  await client.effects.idle()
  // Declined: nothing posted, and the mark stops at the declined message, so what came after it is still to be read.
  expect(sink.sent).toEqual([])
  expect(client.store.get(KV.chatter.chat('room1'))?.attendedAt).toBe(declined.at)
  // The next settle reads the message after it; it calls for nobody, and the mark then passes it too.
  room.pass()
  expect(client.store.get(KV.chatter.chat('room1'))?.attendedAt).toBe(aside.at)
  expect(client.store.db.prepare("SELECT 1 FROM effect WHERE kind = 'attend'").all()).toEqual([])
})
