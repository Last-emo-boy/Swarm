/**
 * Policy gate evaluation, assessment validation and Policy-change effects (from dsh-superagent's policy.ts).
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { z } from "zod/v4";
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell } from "./admission.js";
import type { AssessmentOutcome, Capability, LocalWhy, Mandate, Policy, PolicyEffect, Role, SourceScope, Strength, Thread, Ticket, Trigger, ActorRef,
  GateResult, WriteLevel } from "./core/index.js";
import { installUrl, type GithubApp, type LinkView } from "./github-link.js";
import { sameActor, sameName, inChinese, sayIn, type Say } from "./text.js";
import { AllowedSchema, RuleIdSchema, policyVersion, type Settings } from "./settings.js";

export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}) }
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  // Each entry on its own: one malformed entry must not take the whole list down with it.
  const listed = settings.policy.sources[actor.source]?.bots
  const bots = (Array.isArray(listed) ? listed : []).flatMap((entry) => { const bot = AllowedSchema.safeParse(entry); return bot.success ? [bot.data] : [] })
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources)
  .some(part => part.allowed.length > 0 || Object.keys(part.roles ?? {}).length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** The id `roles` gives `actor` a role under, if any. */
const roleEntry = (settings: Settings, actor: ActorRef): string | undefined =>
  Object.keys(settings.policy.sources[actor.source]?.roles ?? {}).find(id => sameName(id, actor.id))
/** A sender on their Source's list, which the gate admits as a listed sender: one on `allowed`, or one with a role. */
export function listedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const allowed = allowedSender(settings, actor)
  if (allowed) return allowed
  const id = roleEntry(settings, actor)
  return id === undefined ? undefined : { id }
}
/** A sender's role: the one their Source's `roles` gives them, else `maintainer` for a sender on `allowed`, else `everyone`. */
export function roleOf(settings: Settings, actor: ActorRef): Role {
  const id = roleEntry(settings, actor)
  if (id !== undefined) return settings.policy.sources[actor.source]!.roles![id]!
  return allowedSender(settings, actor) ? 'maintainer' : 'everyone'
}
const RANK: Readonly<Record<Role, number>> = { everyone: 0, maintainer: 1, owner: 2 }
export const atLeast = (role: Role, wanted: Role): boolean => RANK[role] >= RANK[wanted]
/** The admission row of chats nobody listed, such as Feishu's `other`: work accepted there writes locally at most by default. */
export const UNLISTED_ROW = 'other'
/** How far work accepted in a receiving scope may write: its `ceilings` entry, else local in the unlisted row and GitHub elsewhere. */
export function ceilingOf(settings: Settings, source: string, row: string | undefined): WriteLevel {
  const set = row === undefined ? undefined : settings.policy.sources[source]?.ceilings?.[row]
  return set ?? (row === UNLISTED_ROW ? 'local' : 'github')
}
const WRITE: Readonly<Record<WriteLevel, number>> = { 'read-only': 0, local: 1, github: 2 }
type LimitName = 'openTickets' | 'requestsPerHour'
/** Each role's limits while the access model is on and its settings name none; an absent limit is none. */
export const ACCESS_LIMITS: Readonly<Record<Role, Partial<Record<LimitName, number>>>> = {
  owner: { openTickets: 8 },
  maintainer: { openTickets: 4, requestsPerHour: 60 },
  everyone: { openTickets: 1, requestsPerHour: 10 }
}
/** A role's limit while the access model is on: the settings', else `ACCESS_LIMITS`; undefined for none. */
export function limitOf(settings: Settings, role: Role, name: LimitName): number | undefined {
  if (!settings.access) return undefined
  return settings.access.limits[role]?.[name] ?? ACCESS_LIMITS[role][name]
}
/** The repository the GitHub Source watches (owner/name), where local tickets work and whose pull requests the host follows. */
export const watchedRepository = (settings: Pick<Settings, 'sources'>): string => String(settings.sources.github?.config.repository ?? '')
/**
 * The repository a linked person's work writes to: the one the request names, else their default, else the watched one,
 * else the only one they have; each only while they may push there. A request on GitHub is about the watched repository.
 */
export function repositoryFor(link: Pick<LinkView, 'repos' | 'defaultRepo'>, watched: string, requested?: string): string | undefined {
  const usable = (repo: string | undefined) => repo ? link.repos.find(item => sameName(item, repo)) : undefined
  return usable(requested) ?? usable(link.defaultRepo) ?? usable(watched) ?? (link.repos.length === 1 ? link.repos[0] : undefined)
}
/**
 * How far work about to be accepted may write before its requester's GitHub link counts: work nobody asked for (inferred, a
 * bot's or a paired node's) stays local, a person's request may write to GitHub, and the receiving scope's ceiling lowers
 * either. A peer's request stays local because the peer's machine holds no credential of a person on this node, however far
 * its surfaces reach.
 */
export function allowedWrite(settings: Settings, mandate: Pick<Mandate, 'strength' | 'basis' | 'actor'>): WriteLevel {
  const wanted: WriteLevel = mandate.strength === 'inferred' || mandate.basis.via === 'bot' || mandate.basis.via === 'peer' ? 'local' : 'github'
  const ceiling = ceilingOf(settings, mandate.basis.source ?? mandate.actor.source, mandate.basis.row)
  return WRITE[wanted] <= WRITE[ceiling] ? wanted : ceiling
}
/**
 * The capability of work about to be accepted, while the access model is on: what `allowedWrite` allows, where work that may
 * write to GitHub does so as its requester's linked account on one of their repositories, and stays local without one, saying
 * why. Work nobody asked for or a scope's ceiling lowered is local by the policy, without a person to tell.
 */
export function capabilityOf(settings: Settings, mandate: Pick<Mandate, 'strength' | 'basis' | 'actor'>, link?: LinkView,
  requested: { repository?: string } = {}): Capability | undefined {
  // A paired node's work is held local whether or not the access model is on: without a capability its worker would act
  // with the agent's own accounts, which no peer is.
  if (mandate.basis.via === 'peer') return { role: roleOf(settings, mandate.actor), write: allowedWrite(settings, mandate), local: 'ceiling' }
  if (!settings.access) return undefined
  const role = roleOf(settings, mandate.actor)
  const write = allowedWrite(settings, mandate)
  // `allowedWrite` already decided how far work may write; only the reason it stopped short is added here.
  if (write !== 'github') return { role, write, local: mandate.strength === 'inferred' || mandate.basis.via === 'bot' ? 'inferred' : 'ceiling' }
  const watched = watchedRepository(settings)
  const repository = link && !link.broken
    ? repositoryFor(link, watched, mandate.basis.source === 'github' ? watched : requested.repository) : undefined
  if (!link) return { role, write: 'local', local: 'unlinked' }
  if (link.broken) return { role, write: 'local', local: 'link-broken' }
  // Two different things: an app installed nowhere, and one installed on repositories that do not include the one this work is about.
  if (!repository) return { role, write: 'local', local: link.repos.length ? 'not-served' : 'uninstalled' }
  return { role, write, credential: { login: link.login, id: link.id }, repository }
}
/**
 * Where the person who reads a local notice wrote: in this chat, at this terminal, or elsewhere, which is a GitHub issue
 * comment: the two commands a notice names run in a chat or a terminal, and nowhere a GitHub commenter can reach them.
 */
export type NoticePlace = 'chat' | 'terminal' | 'elsewhere'
/** How a notice names the way out when its reader is not in a chat: the command to run, or where to run it. */
const wayOut = (place: NoticePlace, chat: string, terminal: string, elsewhere = 'from a chat or the host terminal'): string =>
  place === 'chat' ? chat : place === 'terminal' ? terminal : elsewhere
/**
 * What a person can do to let their work act on GitHub, where they wrote it, in the language they wrote in; undefined when
 * no person can. A ticket that works locally for a person is the same message to a Chinese speaker as to an English one,
 * so both wordings live here, side by side, and never drift apart.
 */
export function localNotice(local: LocalWhy | undefined, place: NoticePlace, short: string, app?: GithubApp, written = ""): string | undefined {
  const say: Say = sayIn(inChinese(written))
  const link = wayOut(place, 'send /link here', 'run swarm superagent link', 'link it from a chat or the host terminal')
  const linkZh = wayOut(place, '在这里发 /link', '运行 swarm superagent link', '在聊天里或主机终端绑定')
  const takeover = wayOut(place, `/takeover ${short}`, `swarm superagent takeover ${short}`, 'take it over from a chat or the host terminal')
  const takeoverZh = wayOut(place, `/takeover ${short}`, `swarm superagent takeover ${short}`, '在聊天里或主机终端接手')
  const again = wayOut(place, '(send /link)', '(run swarm superagent link)')
  const againZh = wayOut(place, '（发 /link）', '（运行 swarm superagent link）')
  const repo = wayOut(place, '(/repo)', '(swarm superagent repo)')
  const repoZh = wayOut(place, '（/repo）', '（swarm superagent repo）')
  switch (local) {
    case 'unlinked':
      // The short id is the ticket this accept makes, so the person can name it to take it over once it is ready.
      return say(`Your GitHub account isn't linked yet, so this stays local: ${link}, then ${takeover} once it is ready.`,
        `你的 GitHub 账号还没绑定，所以这项工作先留在本地：${linkZh}，完成后发 ${takeoverZh}。`)
    case 'link-broken':
      return say(`Your GitHub link stopped working, so this stays local: link again ${again}, then take it over once it is ready.`,
        `你的 GitHub 绑定失效了，所以这项工作先留在本地：重新绑定 ${againZh}，完成后在聊天里或终端接手。`)
    case 'uninstalled':
      return app
        ? say(`Your GitHub account is linked, but the app is not installed on a repository you can push to, so this stays local: install it at ${installUrl(app)}, set one ${repo}, then take it over once it is ready.`,
          `你的 GitHub 账号已绑定，但这个应用没有安装在你可推送的仓库上，所以这项工作先留在本地：在 ${installUrl(app)} 安装，设置一个仓库 ${repoZh}，完成后在聊天里或终端接手。`)
        : say(`Your GitHub account is linked, but no repository you can push to is set, so this stays local: set one ${repo}, then take it over once it is ready.`,
          `你的 GitHub 账号已绑定，但还没设置你可推送的仓库，所以这项工作先留在本地：设置一个仓库 ${repoZh}，完成后在聊天里或终端接手。`)
    case 'not-served':
      return say(`Your GitHub account is linked, but the repository this work is about is not one you can push to through the app, so this stays local${app ? `: install it there at ${installUrl(app)}` : ''}, then take it over once it is ready.`,
        `你的 GitHub 账号已绑定，但这项工作涉及的仓库不在应用的可推送范围里，所以这项工作先留在本地${app ? `：在 ${installUrl(app)} 安装该仓库` : ''}，完成后在聊天里或终端接手。`)
    default:
      // Work nobody asked for, or a receiving scope's ceiling: there is no person to tell, and linking would change nothing.
      return undefined
  }
}
/**
 * Whether `actor` may choose the agent harness their work runs on, which the owner's harness accounts pay for: anyone
 * without the access model, else maintainers and owners.
 */
export const choosesHarness = (settings: Settings, actor: ActorRef): boolean => !settings.access || atLeast(roleOf(settings, actor), 'maintainer')
/**
 * Whether `actor` learns which nodes the agent runs work on and what each runs (devices.ts): anyone without the access
 * model, else maintainers and owners. Everyone else learns how many there are and how many workers are free.
 */
export const seesNodes = (settings: Settings, actor: ActorRef): boolean => !settings.access || atLeast(roleOf(settings, actor), 'maintainer')
/** Whether `actor` steers a ticket under `mandate`: always without the access model, else its requester and maintainers do. */
export function steers(settings: Settings, mandate: Pick<Mandate, 'actor'>, actor: ActorRef): boolean {
  // A paired node steers only the work it asked for: its stop and its messages to others' tickets have their own surfaces,
  // which the mesh server checks, so a request it files never reaches another's ticket.
  if (actor.source === PEER_SOURCE) return sameActor(mandate.actor, actor)
  if (!settings.access) return true
  // Both sides' account numbers when they carry one, so a freed login does not steer its old holder's ticket.
  const requester = sameActor(mandate.actor, actor)
  return requester || atLeast(roleOf(settings, actor), 'maintainer')
}

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/**
 * Whether the gate takes an addressed message from this sender at all: they are on the list, or the receiving scope's row lets
 * senders off the list address the agent. Bot commands and the request limits answer only such senders.
 */
export function addressable(settings: Settings, sources: SourceScope, trigger: Pick<Trigger, 'source' | 'actor' | 'meta'>): boolean {
  if (listedSender(settings, trigger.actor)) return true
  const scope = listened(sources, trigger.source, trigger.meta)
  return scope.listened && admissionOf(settings, trigger.source, scope.row, 'unlistedAddressed') !== 'ignore'
}
/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Where the Policy finds a sender's linked GitHub account. */
export interface Links { of(actor: ActorRef): LinkView | undefined }
/** Where the Policy reads what a paired node may do now: the mesh grants of the node that serves its requests. */
export interface PeerGrants { reaches(peerId: string, surface: string): boolean }
/** The Source a paired node's requests come by: the mesh server files them under the peer principal (src/mesh/tickets.ts). */
export const PEER_SOURCE = 'mesh'
const PeerMetaSchema = z.object({ id: z.string().min(1), name: z.string().min(1) })
/**
 * A request a paired node filed: the mesh server has already checked the surface its grant reaches, so the gate takes it as
 * explicit. The peer principal is what limits count against and what receipts name; its row pins its work's writes to local.
 */
function peerGate(trigger: Trigger): GateResult {
  const peer = PeerMetaSchema.safeParse(trigger.meta.peer)
  if (!peer.success) return { admissible: false, reason: 'not_a_member' }
  return { admissible: true, strength: 'explicit',
    basis: { source: PEER_SOURCE, row: 'ticket', via: 'peer', peer: { id: peer.data.id, name: peer.data.name } } }
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope, links?: Links, peers?: PeerGrants): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (trigger.source === PEER_SOURCE) return peerGate(trigger)
      if (!trigger.human) return machineGate(trigger)
      const allowed = listedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      // A paired node's Mandate holds while that node is still paired and may still file work here; where no mesh is served,
      // nothing says so, and it does not hold.
      if (basis.via === 'peer') return !!peers?.reaches(basis.peer.id, 'tickets.submit')
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!listedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !listedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
    capability: (mandate, requested) => capabilityOf(settings, mandate, links?.of(mandate.actor), requested),
    steers: (mandate, actor) => steers(settings, mandate, actor),
    openLimit: actor => limitOf(settings, roleOf(settings, actor), 'openTickets'),
  }
}
