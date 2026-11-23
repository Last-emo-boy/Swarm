import { describe, it } from 'node:test'
import { each, expect } from './testing/expect.js'
import { addressable, allowedWrite, assessmentOutcome, capabilityOf, ceilingOf, limitOf, listedSender, localNotice, policyEffects, repositoryFor, roleOf, settingsPolicy, allowedSender,
  anyoneAllowed, steers } from './policy.js'
import { SettingsSchema, policyVersion, type Settings } from './settings.js'
import type { MandateBasis } from './core/index.js'
import { SourceRegistry } from './sources/registry.js'
import { feishuKind } from './sources/feishu.js'
import { githubKind } from './sources/github.js'
import type { Thread, Ticket, Trigger } from './core/index.js'

const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
const OBSERVED = 'oc_1111111111111111111111111111'
const feishuSource = (config: { chats: { chatId: string; listen: 'mentions' | 'all' }[]; directMessages: boolean; otherChats?: 'none' | 'mentions' | 'all' }, enabled = true) => ({ enabled, config })
const base = SettingsSchema.parse({
  policy: { sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'Alice' }] } } },
  eval: { mode: 'auto' },
  sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: true }) },
})
function setup(settings: Settings = base) {
  const sources = new SourceRegistry(() => settings)
  sources.register(feishuKind); sources.register(githubKind)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}
const { sources, policy } = setup()
const thread = (subscriptions: string[] = []): Thread => ({ key: 'feishu:x', ref: { source: 'feishu', id: 'x' }, createdAt: '', subscriptions, correlated: [], pending: [], meta: {} })
const feishu = (overrides: Partial<Trigger> & { meta?: Record<string, unknown> } = {}): Trigger => ({ id: 't', source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '', text: 'hi', addressed: 'mention', meta: { chatId: CHAT, direct: false, mentioned: true }, ...overrides })
const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => { const { addressed: _addressed, ...rest } = feishu(overrides); return rest }
const github = (login: string, addressed?: 'mention'): Trigger => ({ id: 'g', source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: login }, human: true, at: '', text: 'x', ...addressed ? { addressed } : {}, meta: { number: 1, isPr: true } })
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } as Ticket

describe('source scope', () => {
  it('listens to configured chats, reads every message only where configured, and follows the direct-message switch', () => {
    expect(sources.scope(feishu())).toEqual({ listened: true, observed: false, row: CHAT })
    expect(sources.scope(feishu({ meta: { chatId: OBSERVED, direct: false, mentioned: false } }))).toEqual({ listened: true, observed: true, row: OBSERVED })
    expect(sources.scope(feishu({ meta: { chatId: 'oc_other', direct: false, mentioned: true } }))).toEqual({ listened: true, observed: false, row: 'other' })
    expect(sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    // In Swarm the GitHub Source stays off until it is set up, so it listens to nothing; upstream turned it on by default.
    expect(sources.scope(github('anyone'))).toEqual({ listened: false, reason: 'source_disabled' })
  })
  it('listens to nothing from a configured Source whose plugin is not loaded, and keeps an invalid stored configuration disabled', () => {
    const bare = new SourceRegistry(() => base)
    expect(bare.scope(feishu())).toEqual({ listened: false, reason: 'source_not_installed' })
    expect(bare.scope(github('anyone'))).toEqual({ listened: true, observed: false })
    const broken = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: 'oops' } } } }))
    broken.register(feishuKind)
    expect(broken.instance('feishu')).toMatchObject({ enabled: false })
    expect(broken.scope(feishu())).toEqual({ listened: false, reason: 'source_disabled' })
  })
  it('filters everything from a disabled Source', () => {
    expect(setup({ ...base, sources: { ...base.sources, github: { enabled: false, config: {} } } }).sources.scope(github('anyone'))).toEqual({ listened: false, reason: 'source_disabled' })
  })
})
describe('gate', () => {
  it('grants explicit strength when the sender is allowed in its Source\'s part and the Source marked the Trigger addressed', () => {
    expect(policy.gate(feishu(), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } } })
    expect(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { addressed: 'direct' } })
    // GitHub logins compare without case; the entry's id names the sender when it has no display name.
    expect(policy.gate(github('alice', 'mention'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { source: 'github', sender: 'Alice' } })
  })
  it('checks each Source\'s own list: a Feishu id allows nothing on GitHub', () => {
    expect(policy.gate(github(MEMBER, 'mention'), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(allowedSender(base, { source: 'github', id: 'ALICE' })).toEqual({ id: 'Alice' })
    expect(allowedSender(base, { source: 'feishu', id: 'Alice' })).toBeUndefined()
    expect(anyoneAllowed(base)).toBe(true)
    expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false)
  })
  it('assesses follow-ups on Threads with Tickets, explicit from an allowed sender and inferred from anyone else', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    expect(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    expect(policy.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup', sender: 'Alice' } })
    expect(policy.gate(github('someone'), thread(), [ticket])).toMatchObject({ admissible: true, strength: 'inferred' })
    // A Thread a ticket follows only for context lends no follow-up: the admission table decides, as on any Thread.
    const context = { ...thread(['ticket']), context: ['ticket'] }
    expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false })
  })
  it('infers strength for allowed senders\' messages the Source observes, unless Eval is off', () => {
    const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(policy.gate(observed, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', observation: { mode: 'auto' } } })
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
  it('admits no direct message from a sender the Source\'s part does not allow, not even as a follow-up', () => {
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(['ticket']), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('rejects automated messages, unknown senders without a Thread, and allowed senders who did not address the agent', () => {
    expect(policy.gate(feishu({ human: false }), thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
})
describe('admission table', () => {
  const STRANGER = 'ou_stranger'
  const withTable = (admission: Record<string, Record<string, string>>, config: Record<string, unknown> = {}, mode: 'off' | 'observe' | 'auto' = 'auto') => SettingsSchema.parse({ ...base,
    eval: { ...base.eval, mode },
    sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu!.config, ...config } } },
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, admission } } } })
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  it('reproduces the behaviour before the table with every cell unset', () => {
    expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } } })
    expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    // A listed sender who addresses the agent makes an explicit request whatever the table says.
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } })).policy.gate(inChat(CHAT), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit' })
  })
  it('makes an unlisted sender\'s mention explicit or inferred as the row says, and an inferred one waits for a mode that assesses', () => {
    const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    expect(explicit).toEqual({ admissible: true, strength: 'explicit', basis: { source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: true }, row: CHAT, via: 'admission', cell: 'unlistedAddressed', addressed: 'mention' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off')).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(setup(withTable({ direct: { unlistedAddressed: 'explicit' } })).policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('ignores a listed sender\'s unaddressed message where the row says so, and never reads the table for messages the chat does not receive', () => {
    expect(setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } })).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'admission_ignored' })
    // An @-only chat receives no unaddressed message, so even an inferred cell does not admit one.
    expect(setup(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
    expect(setup(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER, false), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('reads every message in every group it is in when other chats are all, so a file sent without an @ is admitted', () => {
    const all = setup(withTable({ other: { listedUnaddressed: 'explicit', unlistedUnaddressed: 'explicit' } }, { otherChats: 'all' }))
    expect(all.sources.scope(inChat('oc_elsewhere', STRANGER, false))).toEqual({ listened: true, observed: true, row: 'other' })
    expect(all.policy.gate(inChat('oc_elsewhere', STRANGER, false), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { row: 'other', cell: 'unlistedUnaddressed' } })
    expect(all.policy.gate(inChat('oc_elsewhere', MEMBER, false), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { row: 'other', cell: 'listedUnaddressed' } })
    // Without a cell that says so, an unaddressed message from someone off the list is still ignored.
    expect(setup({ ...base, sources: { feishu: { enabled: true, config: { chats: [], directMessages: true, otherChats: 'all' } } } })
      .policy.gate(inChat('oc_elsewhere', STRANGER, false), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('hears every group it is in, as the row other, unless other chats are set to none', () => {
    expect(sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: true, observed: false, row: 'other' })
    const none = setup({ ...base, sources: { feishu: { enabled: true, config: { chats: [], directMessages: true, otherChats: 'none' } } } })
    expect(none.sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    const others = setup(withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' }))
    expect(others.sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: true, observed: false, row: 'other' })
    expect(others.policy.gate(inChat('oc_elsewhere'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other' } })
    expect(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other', cell: 'unlistedAddressed' } })
  })
  it('admits no inferred follow-up while Eval is off, as no other inferred candidate, and still a listed sender\'s', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
    expect(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
    expect(off.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })
  it('makes an explicit request of an unlisted sender\'s message whose cell is explicit, also on a Thread with Tickets, in every mode', () => {
    for (const mode of ['auto', 'observe', 'off'] as const) {
      const open = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode))
      expect(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit',
        basis: { via: 'admission', cell: 'unlistedAddressed' } })
      // A cell that is not explicit leaves the follow-up inferred, while Eval is on.
      const strict = setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode))
      expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject(mode === 'off'
        ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    }
  })
  it('keeps follow-ups on a Thread with Tickets outside the table', () => {
    const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } }))
    expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
    expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  })
  it('invalidates a Mandate once its cell gives less than the strength it was accepted with, and keeps it while the cell holds', () => {
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
    const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    if (!gate.admissible) throw new Error('expected admission')
    const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
    expect(setup(open).policy.revalidate(mandate)).toBe(true)
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.revalidate(mandate)).toBe(false)
    expect(setup(withTable({})).policy.revalidate(mandate)).toBe(false)
  })
  it('changes the Policy version when a cell changes', () => {
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).version).not.toBe(setup().version)
    expect(setup(withTable({})).version).toBe(setup().version)
  })
})
describe('revalidating a Mandate from the admission table', () => {
  type Cell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
  const cells: Cell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
  const SENDER = 'ou_sender'
  const origins: { cell: Cell; strength: 'explicit' | 'inferred' }[] = [
    { cell: 'listedUnaddressed', strength: 'inferred' }, { cell: 'unlistedAddressed', strength: 'explicit' },
    { cell: 'unlistedAddressed', strength: 'inferred' }, { cell: 'unlistedUnaddressed', strength: 'inferred' },
  ]
  const cases = origins.flatMap(origin => [true, false].flatMap(listed => (['off', 'observe', 'auto'] as const).flatMap(mode => [true, false].flatMap(rule =>
    (['all', 'mentions', 'none'] as const).flatMap(scope => [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })))))))
  /** docs/002: the Thread must still be received; a listed sender who addresses the agent is explicit; a sender listed since takes the listed cell. */
  function expected({ cell, strength, listed, mode, rule, scope, holds }: typeof cases[number]): boolean {
    if (scope === 'none') return false
    if (cell === 'unlistedAddressed' && listed) return true
    const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
    if ((now === 'listedUnaddressed' && !listed) || !holds) return false
    return strength === 'explicit' || (mode === 'auto' && rule)
  }
  each(cases)('$cell ($strength), listed now $listed, mode $mode, rule on $rule, chat receives $scope, cell holds $holds', item => {
    // The row gives each cell the strength the Mandate was accepted with, or, when it no longer holds, ignore.
    const grant = (cell: Cell) => !item.holds ? 'ignore' : cell === 'unlistedAddressed' ? item.strength : 'inferred'
    const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
    const settings = SettingsSchema.parse({
      eval: { mode: item.mode },
      sources: { feishu: feishuSource({ chats, directMessages: true, ...item.scope === 'none' ? { otherChats: 'none' as const } : {} }) },
      policy: {
        rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
        sources: { feishu: { allowed: item.listed ? [{ id: SENDER }] : [], admission: { [CHAT]: Object.fromEntries(cells.map(cell => [cell, grant(cell)])) } } },
      },
    })
    const addressed = item.cell === 'unlistedAddressed'
    const observed = item.strength === 'inferred' ? { observation: { mode: 'auto' as const }, rules: ['copy'] } : {}
    const basis: MandateBasis = { via: 'admission', source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: addressed }, row: CHAT, cell: item.cell,
      ...addressed ? { addressed: 'mention' as const } : {}, ...observed }
    const mandate = { strength: item.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    expect(setup(settings).policy.revalidate(mandate)).toBe(expected(item))
  })
})
describe('revalidate and version', () => {
  it('keeps explicit Mandates while the sender stays allowed and the Source still listens, and rule Mandates only while auto mode and the rules hold', () => {
    const basis: MandateBasis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
    const mandate = { strength: 'explicit' as const, policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
    expect(policy.revalidate(mandate)).toBe(true)
    const nobody = { ...base, policy: { ...base.policy, sources: {} } }
    expect(setup(nobody).policy.revalidate(mandate)).toBe(false)
    const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true, otherChats: 'none' }) } }
    expect(setup(silent).policy.revalidate(mandate)).toBe(false)
    // A Mandate from before the gate recorded how it admitted a Trigger holds while its sender is listed and the Source listens.
    const listed: MandateBasis = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
    expect(setup(silent).policy.revalidate({ ...mandate, basis: listed })).toBe(false)
    expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true)
    const inferred = { ...mandate, strength: 'inferred' as const, basis: { via: 'listed', observation: {}, rules: ['copy'] } satisfies MandateBasis }
    expect(policy.revalidate(inferred)).toBe(true)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred)).toBe(false)
    expect(setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }).policy.revalidate(inferred)).toBe(false)
    expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } })).toBe(true)
  })
  it('changes the Policy version for rules, accept mode and the Sources\' parts, not for pause, concurrency, models or Source configuration', () => {
    const version = setup().version
    expect(setup({ ...base, paused: true, executor: { ...base.executor, maxWorkers: 9 }, eval: { ...base.eval, timeoutSeconds: 300 }, sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } } }).version).toBe(version)
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version).toBe(version)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version).not.toBe(version)
    expect(setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version).not.toBe(version)
  })
})

describe('assessment outcomes', () => {
  const settings = (mode: 'auto' | 'observe') => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, eval: { ...parsed.eval, mode } }
  }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current: ReturnType<typeof settings>, matched: boolean) =>
    current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current: ReturnType<typeof settings>, matched = true) => ({ decision: 'accept' as const, rule_assessments: judged(current, matched),
    direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote', worktree_name: 'fix-copy' })
  it('accepts an inferred candidate on its matched rules in auto mode only, and the Policy admits only enabled matched rules', () => {
    const auto = settings('auto')
    const outcome = assessmentOutcome(accept(auto), auto, 'inferred')
    expect(outcome).toMatchObject({ kind: 'accept', rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id), name: 'fix-copy' })
    expect(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred'))
      .toMatchObject({ kind: 'ignore', reason: { code: 'observed', values: { text: 'asked' } }, audit: { would_accept: true } })
    expect(assessmentOutcome(accept(auto, false), auto, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred')).toThrow('Acceptance requires intent_evidence')
    const scope = { scope: () => ({ listened: true as const, observed: true }) }
    const enabled = auto.policy.rules.find(rule => rule.enabled)!.id
    expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true)
    expect(settingsPolicy(auto, scope).admitsInferred(['unknown'])).toBe(false)
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
    expect(settingsPolicy(settings('observe'), scope).admitsInferred([enabled])).toBe(false)
  })
})

describe('admission table settings', () => {
  it('takes an explicit cell in every column, so a chat read without @ mentions can admit its messages as requests', () => {
    // A chat set to read every message admits an unaddressed one as the request it plainly is; a settings editor may say so.
    for (const cell of ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']) {
      const part = { allowed: [], admission: { [CHAT]: { [cell]: 'explicit' } } }
      expect(SettingsSchema.parse({ policy: { sources: { feishu: part } } }).policy.sources.feishu!.admission).toMatchObject({ [CHAT]: { [cell]: 'explicit' } })
      expect(sources.validatePolicy({ feishu: part }).feishu).toMatchObject({ admission: { [CHAT]: { [cell]: 'explicit' } } })
    }
    // The cell counts only where the chat reads every message: an @-only chat receives no unaddressed message to admit.
    const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { sources: { feishu: { allowed: [{ id: MEMBER }], admission: { [CHAT]: { listedUnaddressed: 'explicit' } } } } },
      sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: true }) } })
    const quiet = (sender: string): Trigger => { const { addressed: _addressed, ...rest } = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId: CHAT, direct: false, mentioned: false } }); return rest }
    expect(setup(settings).policy.gate(quiet(MEMBER), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
  it('accepts an explicit candidate whatever the accept mode, which bears only on inferred ones', () => {
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled)
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })) }
    for (const mode of ['observe', 'off'] as const) {
      const settings = SettingsSchema.parse({ eval: { mode } })
      expect(assessmentOutcome(assessment, settings, 'explicit')).toMatchObject({ kind: 'accept', title: 'Fix' })
      expect(assessmentOutcome(assessment, settings, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'observed' } })
    }
  })
  it('admits a listed bot that mentions the agent where the Source does not observe its messages, as a listed person\'s mention needs none', () => {
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } } })
    const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
    expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention', row: CHAT } })
  })
})
describe('rule judgements', () => {
  it('refuses an assessment that judges one enabled rule twice and leaves another unjudged', () => {
    const parsed = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
      { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }] } })
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'typo' }, { rule_id: 'copy', matched: false, reason: 'again' }] }
    expect(() => assessmentOutcome(assessment, parsed, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    const once = { ...assessment, rule_assessments: [assessment.rule_assessments[0]!, { rule_id: 'visual', matched: false, reason: 'no colors' }] }
    expect(assessmentOutcome(once, parsed, 'inferred')).toMatchObject({ kind: 'accept', rules: ['copy'] })
  })
})
describe('policy effects', () => {
  const scope = () => ({ scope: () => ({ listened: true as const, observed: true }) })
  const base = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const ticket = (id: string, mandate: object) => ({ id, mandate } as unknown as Ticket)
  const inferred = ticket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = ticket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  it('tells a ticket how a change bears on it, and leaves the others alone', () => {
    const rules = (copy: object, visual: object = {}) => ({ ...base, policy: { ...base.policy, rules: [{ ...base.policy.rules[0]!, ...copy }, { ...base.policy.rules[1]!, ...visual }] } })
    // A rule the ticket was not accepted under changes nothing for it.
    expect(policyEffects([inferred, explicit], base, rules({}, { enabled: false }), scope).size).toBe(0)
    expect(policyEffects([inferred], base, rules({ instruction: 'Fix typos only.' }), scope).get('t1'))
      .toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }] })
    expect(policyEffects([inferred], base, rules({ enabled: false }), scope).get('t1')).toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }] })
    // Another sender on the list, as a member sync adds, bears on no ticket; taking the requester off it does.
    const allowed = (list: { id: string }[]) => ({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: list } } } })
    expect(policyEffects([inferred, explicit], base, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), scope).size).toBe(0)
    expect(policyEffects([explicit], base, allowed([]), scope).get('t2')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_alice' } })
  })
  it('tells an inferred ticket that inferred work is no longer accepted when the accept mode leaves auto, and names a bot it is for', () => {
    const auto = { ...base, eval: { ...base.eval, mode: 'auto' as const } }
    const observe = { ...base, eval: { ...base.eval, mode: 'observe' as const } }
    const rule = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} } })
    const effects = policyEffects([rule, explicit], auto, observe, scope)
    // Not a sender's removal: the person who wrote it may still start work.
    expect(effects.get('t3')).toEqual({ proactive: false })
    expect(effects.has('t2')).toBe(false)
    const bot = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
    const listed = { ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: [{ id: 'cli_ci_bot' }] } } } }
    expect(policyEffects([bot], listed, base, scope).get('t4')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'cli_ci_bot' } })
  })
  it('keeps an inferred follow-up\'s Mandate only while candidates become work and its rules are on, as any inferred one', () => {
    const followup = ticket('t5', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'followup', source: 'feishu', scope: { chatId: 'oc_team' }, rules: ['copy'] } })
    const mode = (value: 'auto' | 'observe' | 'off') => ({ ...base, eval: { ...base.eval, mode: value } })
    const disabled = { ...mode('auto'), policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }
    expect(settingsPolicy(mode('auto'), scope()).revalidate(followup.mandate)).toBe(true)
    for (const settings of [mode('observe'), mode('off'), disabled]) expect(settingsPolicy(settings, scope()).revalidate(followup.mandate)).toBe(false)
    expect(policyEffects([followup], mode('auto'), mode('observe'), scope).get('t5')).toEqual({ proactive: false })
    // An explicit follow-up holds whatever the mode.
    const explicitFollowup = ticket('t6', { ...followup.mandate, strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' } })
    expect(settingsPolicy(mode('off'), scope()).revalidate(explicitFollowup.mandate)).toBe(true)
  })
  it('revokes an inferred ticket whose cell weakens or whose candidates no longer become work, and reports a deleted rule disabled', () => {
    const chat = 'oc_1111111111111111111111111111'
    const table = (cell: 'inferred' | 'ignore', mode: 'auto' | 'observe' = 'auto') => SettingsSchema.parse({ ...base, eval: { ...base.eval, mode },
      policy: { ...base.policy, sources: { feishu: { ...base.policy.sources.feishu!, admission: { [chat]: { unlistedUnaddressed: cell } } } } } })
    const observed = () => ({ scope: () => ({ listened: true as const, observed: true, row: chat }) })
    const proactive = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', source: 'feishu', scope: { chatId: chat }, row: chat, rules: ['copy'],
        observation: { mode: 'auto' } } })
    expect(policyEffects([proactive], table('inferred'), table('inferred'), observed).size).toBe(0)
    // A weaker cell takes the work from its sender, whom the effect names; a mode change only stops inferred work.
    expect(policyEffects([proactive], table('inferred'), table('ignore'), observed).get('t3'))
      .toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_guest' } })
    expect(policyEffects([proactive], table('inferred'), table('inferred', 'observe'), observed).get('t3')).toEqual({ proactive: false })
    const deleted = { ...base, policy: { ...base.policy, rules: base.policy.rules.filter(rule => rule.id !== 'visual') } }
    const visual = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['visual'] } })
    expect(policyEffects([visual], base, deleted, scope).get('t4')).toEqual({ rules: [{ id: 'visual', name: 'Visual', change: 'disabled' }] })
  })
})
describe('bots and events without a sender', () => {
  const observing = (config: Record<string, unknown>, part: Record<string, unknown> = {},
    mode: 'auto' | 'off' = 'auto') => SettingsSchema.parse({
    policy: { sources: { github: { allowed: [{ id: 'Alice' }], bots: [{ id: 'dependabot[bot]' }], ...part } } }, eval: { mode },
    sources: { github: { enabled: true, config } } })
  const comment: Trigger = { id: 'b', source: 'github', threads: [{ source: 'github', id: '1' }],
    actor: { source: 'github', id: 'dependabot[bot]' }, human: false, at: '', text: 'Bump lodash',
    meta: { number: 1, isPr: true, kind: 'conversation' } }
  const ci = (meta: Record<string, unknown>): Trigger => ({ id: 'ci', source: 'github', threads: [{ source: 'github', id: 'ci:main' }],
    actor: { source: 'github', id: '' }, human: false, at: '', text: 'CI failed 1/9 on main', meta: { ci: true, ...meta } })
  it('admits a bot on its Source\'s list as an inferred candidate where the Source observes its scope, and no other bot', () => {
    const { policy } = setup(observing({ observeComments: true }))
    expect(policy.gate(comment, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', source: 'github', sender: 'dependabot[bot]', row: 'comments', observation: { mode: 'auto' } } })
    // A bot that addresses the agent still makes no explicit request; on a Thread with tickets it is no follow-up either.
    expect(policy.gate({ ...comment, addressed: 'mention' }, thread(['ticket']), [ticket])).toMatchObject({ strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention' } })
    expect(policy.gate({ ...comment, actor: { source: 'github', id: 'renovate[bot]' } }, thread(), [])).toEqual({ admissible: false,
      reason: 'not_human' })
    expect(setup(observing({})).policy.gate(comment, thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(setup(observing({ observeComments: true }, {}, 'off')).policy.gate(comment, thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
  })
  it('keeps a bot candidate\'s Mandate while the bot stays on its list and candidates may become work', () => {
    const settings = observing({ observeComments: true })
    const mandate = { strength: 'inferred' as const, policyVersion: '', actor: comment.actor, scope: '',
      basis: { via: 'bot' as const, source: 'github', scope: comment.meta, row: 'comments', sender: 'dependabot[bot]',
        observation: { mode: 'auto' as const } } }
    expect(setup(settings).policy.revalidate(mandate)).toBe(true)
    expect(setup(observing({ observeComments: true }, { bots: [] })).policy.revalidate(mandate)).toBe(false)
    expect(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate)).toBe(false)
  })
  it('admits the default branch\'s CI through its row once observed and set, and never a PR\'s CI', () => {
    const admission = { ci: { unlistedUnaddressed: 'inferred' } }
    const branch = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ branch: 'main' }), thread(), [])
    expect(branch).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'ci', observation: { mode: 'auto' } } })
    // The cell defaults to ignore, so observing the CI changes nothing until the table says so.
    expect(setup(observing({ observeCi: true })).policy.gate(ci({ branch: 'main' }), thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
    const pull = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ number: 9, isPr: true }), thread(), [])
    expect(pull).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('admits a Feishu bot on its list in a chat the Source observes', () => {
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts', name: 'Alerts' }] } } } })
    const alert = unaddressed({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false,
      meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(setup(settings).policy.gate(alert, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'bot', sender: 'Alerts', row: OBSERVED } })
    // In a chat the Source receives only mentions in, a bot's message that does not address the agent is not received.
    const unobserved = setup(settings).policy.gate({ ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } }, thread(), [])
    expect(unobserved).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('names a GitHub Trigger\'s receiving scope, which the Source observes where its switch is on', () => {
    const { sources } = setup(observing({ observeIssues: true }))
    const github = (meta: Record<string, unknown>) => ({ source: 'github', meta })
    expect(sources.scope(github({ kind: 'issue', number: 3 }))).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(sources.scope(github({ kind: 'pull', number: 4, isPr: true }))).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(sources.scope(github({ kind: 'inline', number: 4 }))).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(sources.scope(github({ ci: true, branch: 'main' }))).toEqual({ listened: true, observed: false, row: 'ci' })
    expect(sources.scope(github({ ci: true, number: 4 }))).toEqual({ listened: true, observed: false })
    const rows = githubKind.policy!.rows!({ observeIssues: true })
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      ['issues', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
      ['pulls', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['comments', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['ci', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }]])
  })
})

describe('access model', () => {
  const GUEST = 'ou_guest', BOSS = 'ou_boss', READER = 'ou_reader'
  const withAccess = (feishuPart: Record<string, unknown> = {}, access: Record<string, unknown> = {}) => SettingsSchema.parse({ ...base, access,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, ...feishuPart } } } })
  const roles = withAccess({ roles: { [BOSS]: 'owner', [READER]: 'everyone' } })
  const person = (id: string) => ({ source: 'feishu', id })
  const explicit = (id: string, row: string = CHAT) => ({ strength: 'explicit' as const, actor: person(id),
    basis: { via: 'addressed', addressed: 'mention', source: 'feishu', row } satisfies MandateBasis })
  it('leaves every ticket as it was without the access model: no capability, everyone steers, no limits', () => {
    const { policy: plain } = setup()
    expect(plain.capability?.(explicit(MEMBER) as never)).toBeUndefined()
    expect(plain.steers?.({ actor: person(MEMBER) } as never, person(GUEST))).toBe(true)
    expect(plain.openLimit?.(person(GUEST))).toBeUndefined()
    expect(limitOf(base, 'everyone', 'requestsPerHour')).toBeUndefined()
    expect(policyVersion(base)).toBe(setup(SettingsSchema.parse({ ...base, policy: base.policy })).version)
  })
  it('gives each sender a role: the roles entry, else maintainer on the list, else everyone; a role puts a sender on the list', () => {
    expect(roleOf(roles, person(BOSS))).toBe('owner')
    expect(roleOf(roles, person(MEMBER))).toBe('maintainer')
    expect(roleOf(roles, person(GUEST))).toBe('everyone')
    // Someone on the list whose role is everyone stays on it, with that role.
    expect(roleOf(withAccess({ roles: { [MEMBER]: 'everyone' } }), person(MEMBER))).toBe('everyone')
    expect(listedSender(roles, person(READER))).toEqual({ id: READER })
    expect(listedSender(roles, person(GUEST))).toBeUndefined()
    expect(setup(roles).policy.gate(feishu({ actor: person(READER) }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { sender: READER } })
    expect(setup(roles).policy.gate(feishu({ actor: person(GUEST) }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  const WATCHED = 'owner/watched'
  const linked = { login: 'alice-gh', id: 7, repos: [WATCHED, 'alice-gh/tool'], reposAt: '', linkedAt: '' }
  const links = (link: typeof linked | undefined = linked) => ({ of: (actor: { id: string }) => actor.id === MEMBER || actor.id === BOSS ? link : undefined })
  const watching = (settings: Settings) => SettingsSchema.parse({ ...settings, sources: { ...settings.sources, github: { enabled: false, config: { repository: WATCHED } } } })
  it('lets a person\'s explicit work write to GitHub as their linked account, whatever their role, keeps the rest local, and lowers either to the ceiling', () => {
    const gated = settingsPolicy(watching(roles), sources, links())
    expect(gated.capability?.(explicit(MEMBER) as never)).toEqual({ role: 'maintainer', write: 'github', credential: { login: 'alice-gh', id: 7 }, repository: WATCHED })
    expect(gated.capability?.(explicit(READER) as never)).toEqual({ role: 'everyone', write: 'local', local: 'unlinked' })
    expect(capabilityOf(watching(roles), explicit(READER), linked)).toEqual({ role: 'everyone', write: 'github', credential: { login: 'alice-gh', id: 7 }, repository: WATCHED })
    expect(gated.capability?.({ ...explicit(BOSS), strength: 'inferred' } as never)).toEqual({ role: 'owner', write: 'local', local: 'inferred' })
    // How far work may write before a link counts, which tells whether linking would let it write to GitHub.
    expect([allowedWrite(roles, explicit(READER)), allowedWrite(roles, { ...explicit(BOSS), strength: 'inferred' }), allowedWrite(roles, explicit(BOSS, 'other'))])
      .toEqual(['github', 'local', 'local'])
    // Without a working link, work that could write to GitHub stays local.
    expect(settingsPolicy(watching(roles), sources).capability?.(explicit(MEMBER) as never)).toEqual({ role: 'maintainer', write: 'local', local: 'unlinked' })
    expect(capabilityOf(watching(roles), explicit(MEMBER), { ...linked, broken: 'refused' })).toEqual({ role: 'maintainer', write: 'local', local: 'link-broken' })
    // Chats nobody listed write locally unless their ceiling says otherwise; a ceiling can also make a chat read-only.
    expect(capabilityOf(roles, explicit(BOSS, 'other'), linked)).toEqual({ role: 'owner', write: 'local', local: 'ceiling' })
    expect(capabilityOf(watching(withAccess({ ceilings: { other: 'github' } })), explicit(MEMBER, 'other'), linked)).toMatchObject({ write: 'github' })
    expect(capabilityOf(withAccess({ ceilings: { [CHAT]: 'read-only' } }), explicit(MEMBER), linked)).toEqual({ role: 'maintainer', write: 'read-only', local: 'ceiling' })
    // The ceiling /ceiling writes: local, a level the read-only case does not reach, with its own reason.
    expect(capabilityOf(withAccess({ ceilings: { [CHAT]: 'local' } }), explicit(MEMBER), linked)).toEqual({ role: 'maintainer', write: 'local', local: 'ceiling' })
    expect(ceilingOf(roles, 'feishu', 'direct')).toBe('github')
  })
  it('tells a person how to let work that stays local act on GitHub, differently in a chat and in a terminal, and never for work nobody asked for', () => {
    const app = { clientId: 'Iv23client', slug: 'swarm-oauth' }
    // Work nobody asked for, or a lowered ceiling, has no person to tell: linking would change nothing.
    expect([localNotice('inferred', 'chat', 'a1b2c3d4'), localNotice('ceiling', 'terminal', 'a1b2c3d4'), localNotice(undefined, 'chat', 'a1b2c3d4')])
      .toEqual([undefined, undefined, undefined])
    expect(localNotice('unlinked', 'chat', 'a1b2c3d4')).toBe(
      "Your GitHub account isn't linked yet, so this stays local: send /link here, then /takeover a1b2c3d4 once it is ready.")
    expect(localNotice('unlinked', 'terminal', 'a1b2c3d4')).toBe(
      "Your GitHub account isn't linked yet, so this stays local: run swarm superagent link, then swarm superagent takeover a1b2c3d4 once it is ready.")
    // A GitHub commenter runs neither command where they wrote: the notice names the chat or the host terminal instead.
    expect(localNotice('unlinked', 'elsewhere', 'a1b2c3d4')).toBe(
      "Your GitHub account isn't linked yet, so this stays local: link it from a chat or the host terminal, then take it over from a chat or the host terminal once it is ready.")
    expect(localNotice('link-broken', 'chat', 'a1b2c3d4')).toBe(
      "Your GitHub link stopped working, so this stays local: link again (send /link), then take it over once it is ready.")
    expect(localNotice('link-broken', 'terminal', 'a1b2c3d4')).toBe(
      "Your GitHub link stopped working, so this stays local: link again (run swarm superagent link), then take it over once it is ready.")
    expect(localNotice('uninstalled', 'chat', 'a1b2c3d4', app)).toBe(
      "Your GitHub account is linked, but the app is not installed on a repository you can push to, so this stays local: install it at https://github.com/apps/swarm-oauth/installations/new, set one (/repo), then take it over once it is ready.")
    expect(localNotice('uninstalled', 'terminal', 'a1b2c3d4', app)).toBe(
      "Your GitHub account is linked, but the app is not installed on a repository you can push to, so this stays local: install it at https://github.com/apps/swarm-oauth/installations/new, set one (swarm superagent repo), then take it over once it is ready.")
    // A host with no app has no install page to name.
    expect(localNotice('uninstalled', 'terminal', 'a1b2c3d4')).toBe(
      "Your GitHub account is linked, but no repository you can push to is set, so this stays local: set one (swarm superagent repo), then take it over once it is ready.")
    // An app installed on other repositories than this work's says so, rather than claiming it is installed nowhere.
    expect(localNotice('not-served', 'chat', 'a1b2c3d4', app)).toBe(
      "Your GitHub account is linked, but the repository this work is about is not one you can push to through the app, so this stays local: install it there at https://github.com/apps/swarm-oauth/installations/new, then take it over once it is ready.")
    // In the language the person wrote in: a Chinese request gets the Chinese notice, naming the same ticket.
    expect(localNotice('unlinked', 'chat', 'a1b2c3d4', undefined, '修一下 README 的错别字')).toBe(
      '你的 GitHub 账号还没绑定，所以这项工作先留在本地：在这里发 /link，完成后发 /takeover a1b2c3d4。')
    expect(localNotice('unlinked', 'terminal', 'a1b2c3d4', undefined, '修一下 README 的错别字')).toBe(
      '你的 GitHub 账号还没绑定，所以这项工作先留在本地：运行 swarm superagent link，完成后发 swarm superagent takeover a1b2c3d4。')
    expect(localNotice('link-broken', 'chat', 'a1b2c3d4', undefined, '把日期格式改一下')).toContain('你的 GitHub 绑定失效了')
    expect(localNotice('uninstalled', 'chat', 'a1b2c3d4', app, '把日期格式改一下')).toContain('https://github.com/apps/swarm-oauth/installations/new')
    // A bot's candidate is work nobody asked for, as an inferred one is.
    const bot = { strength: 'inferred' as const, actor: { source: 'feishu', id: 'cli_alerts' }, basis: { via: 'bot' as const, source: 'feishu', observation: { mode: 'auto' as const } } }
    expect(capabilityOf(withAccess({ bots: [{ id: 'cli_alerts' }] }), bot, linked)).toEqual({ role: 'everyone', write: 'local', local: 'inferred' })
    // A bot's mandate stays work nobody asked for even should the gate ever stamp it explicit: the via, not the strength, decides.
    expect(capabilityOf(withAccess({ bots: [{ id: 'cli_alerts' }] }), { ...bot, strength: 'explicit' }, linked)).toEqual({ role: 'everyone', write: 'local', local: 'inferred' })
  })
  it('writes to the repository the request names, else the default, else the watched one, else the only one, and on GitHub to the watched one', () => {
    const settings = watching(roles)
    expect(capabilityOf(settings, explicit(MEMBER), linked, { repository: 'ALICE-GH/tool' })?.repository).toBe('alice-gh/tool')
    expect(capabilityOf(settings, explicit(MEMBER), { ...linked, defaultRepo: 'alice-gh/tool' })?.repository).toBe('alice-gh/tool')
    // A repository the person cannot push to does not count; the next choice applies.
    expect(capabilityOf(settings, explicit(MEMBER), linked, { repository: 'someone/else' })?.repository).toBe(WATCHED)
    expect(capabilityOf(roles, explicit(MEMBER), { ...linked, repos: ['alice-gh/tool'] })?.repository).toBe('alice-gh/tool')
    expect(capabilityOf(roles, explicit(MEMBER), { ...linked, repos: ['a/b', 'c/d'] })).toEqual({ role: 'maintainer', write: 'local', local: 'not-served' })
    expect(capabilityOf(roles, explicit(MEMBER), { ...linked, repos: [] })).toEqual({ role: 'maintainer', write: 'local', local: 'uninstalled' })
    const onGithub = { ...explicit(MEMBER), basis: { ...explicit(MEMBER).basis, source: 'github' } }
    expect(capabilityOf(settings, onGithub, { ...linked, defaultRepo: 'alice-gh/tool' }, { repository: 'alice-gh/tool' })?.repository).toBe(WATCHED)
    expect(repositoryFor(linked, '', undefined)).toBeUndefined()
  })
  it('keeps a paired node\'s work local whatever role its principal gets here or the access model is, and holds its Mandate while the mesh lets it', () => {
    const peer = (id = 'peer-1', name = 'netcup') => ({ source: 'mesh', id, name })
    const request = (who = peer()): Trigger => ({ id: 'r', source: 'mesh', threads: [{ source: 'mesh', id: 'r' }], actor: who, human: true,
      addressed: 'direct', at: '', text: 'tidy the readme', meta: { requestId: 'r', peer: { id: who.id, name: who.name } } })
    const settings = SettingsSchema.parse({ ...base, access: {},
      policy: { ...base.policy, sources: { ...base.policy.sources, mesh: { roles: { 'peer-1': 'maintainer' } } } } })
    // The mesh server already checked the surface the peer's grant reaches, so the request enters as explicit, under the peer.
    const gate = setup(settings).policy.gate(request(), thread(), [])
    expect(gate).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { via: 'peer', source: 'mesh', row: 'ticket', peer: { id: 'peer-1', name: 'netcup' } } })
    const mandate = { strength: 'explicit' as const, policyVersion: '', basis: (gate as { basis: MandateBasis }).basis, actor: peer(), scope: '' }
    // The role here is this node's to give; the write level is not: the peer's machine holds no credential of a person here.
    expect(roleOf(settings, peer())).toBe('maintainer')
    expect(allowedWrite(settings, mandate)).toBe('local')
    expect(capabilityOf(settings, mandate)).toMatchObject({ role: 'maintainer', write: 'local' })
    // The Mandate holds while the mesh still lets that node file work here: unpaired or narrowed, it does not; with no mesh
    // served, nothing vouches for it and it does not either.
    const mesh = (reaches: boolean) => settingsPolicy(settings, setup(settings).sources, undefined, { reaches: (id, surface) => reaches && id === 'peer-1' && surface === 'tickets.submit' })
    expect(mesh(true).revalidate(mandate)).toBe(true)
    expect(mesh(false).revalidate(mandate)).toBe(false)
    expect(setup(settings).policy.revalidate(mandate)).toBe(false)
    // The access model off, the peer's work is still held local: its capability seals the worker's accounts.
    const open = SettingsSchema.parse({ ...base })
    expect(capabilityOf(open, mandate)).toMatchObject({ write: 'local', local: 'ceiling' })
    // A peer steers only its own work, with the access model on or off; a person on the list steers it as before.
    const theirs = { actor: peer() }, others = { actor: { source: 'feishu', id: MEMBER } }
    for (const current of [settings, open]) {
      expect(steers(current, theirs, peer())).toBe(true)
      expect(steers(current, others, peer())).toBe(false)
      expect(steers(current, theirs, peer('peer-2', 'gpu'))).toBe(false)
    }
    // A trigger with no peer in its meta is refused rather than filed under an unnamed principal.
    expect(setup(settings).policy.gate({ ...request(), meta: {} }, thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('lets a ticket\'s requester and maintainers steer it, and nobody else', () => {
    const { policy: gated } = setup(roles)
    const mandate = { actor: person(READER) } as never
    expect(gated.steers?.(mandate, person(READER))).toBe(true)
    expect(gated.steers?.(mandate, person(MEMBER))).toBe(true)
    expect(gated.steers?.(mandate, person(BOSS))).toBe(true)
    expect(gated.steers?.({ actor: person(MEMBER) } as never, person(READER))).toBe(false)
    expect(gated.steers?.({ actor: person(MEMBER) } as never, person(GUEST))).toBe(false)
    // A GitHub actor is its account's number where both sides carry one: a freed login steers nothing its holder had.
    const holder = { source: 'github', id: 'alice-gh', accountId: 7 }
    const freed = { source: 'github', id: 'alice-gh', accountId: 99 }
    expect(steers(roles, { actor: holder }, holder)).toBe(true)
    expect(steers(roles, { actor: holder }, freed)).toBe(false)
    // A mandate stored before the number was carried compares its login, as it always did.
    expect(steers(roles, { actor: { source: 'github', id: 'Alice-GH' } }, freed)).toBe(true)
  })
  it('limits each role by default and by the settings', () => {
    expect(setup(roles).policy.openLimit?.(person(GUEST))).toBe(1)
    expect(setup(roles).policy.openLimit?.(person(MEMBER))).toBe(4)
    expect(limitOf(roles, 'owner', 'requestsPerHour')).toBeUndefined()
    const raised = withAccess({}, { limits: { everyone: { openTickets: 3 } } })
    expect(limitOf(raised, 'everyone', 'openTickets')).toBe(3)
    expect(limitOf(raised, 'everyone', 'requestsPerHour')).toBe(10)
  })
  it('changes the Policy version when the access model turns on, or roles and ceilings change, not when limits do', () => {
    const on = setup(withAccess()).version
    expect(on).not.toBe(setup().version)
    expect(setup(withAccess({}, { limits: { everyone: { openTickets: 5 } } })).version).toBe(on)
    expect(setup(roles).version).not.toBe(on)
    expect(setup(withAccess({ ceilings: { [CHAT]: 'local' } })).version).not.toBe(on)
  })
  it('validates roles and ceilings beside the Source\'s own part, and finds who may address the agent', () => {
    expect(sources.validatePolicy({ feishu: { allowed: [], roles: { [BOSS]: 'owner' }, ceilings: { other: 'local' } } }).feishu)
      .toMatchObject({ roles: { [BOSS]: 'owner' }, ceilings: { other: 'local' } })
    expect(() => sources.validatePolicy({ feishu: { allowed: [], roles: { [BOSS]: 'king' } } })).toThrow()
    expect(addressable(roles, setup(roles).sources, feishu({ actor: person(READER) }))).toBe(true)
    expect(addressable(roles, setup(roles).sources, feishu({ actor: person(GUEST) }))).toBe(false)
    const open = withAccess({ admission: { [CHAT]: { unlistedAddressed: 'explicit' } } })
    expect(addressable(open, setup(open).sources, feishu({ actor: person(GUEST) }))).toBe(true)
  })
})
