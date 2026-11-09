import { describe, it } from 'node:test'
import { expect } from '../testing/expect.js'
import type { Ticket } from '../core/index.js'
import { ticketPull } from './github-pull.js'
import { ownItem } from './github.js'

const deployment = { repository: 'owner/watched', github: { cli: 'gh', login: 'agent-bot', noreply: '' } }
const pr = (login: string, repo = 'owner/watched') => ({ user: { login }, head: { repo: { full_name: repo } } })
const ticket = (login?: string) => ({ mandate: { capability: login ? { role: 'maintainer', write: 'github', credential: { login, id: 7 }, repository: 'owner/watched' } : undefined } }) as unknown as Ticket

describe('pull requests of a ticket', () => {
  it('belong to it when the agent or the account the ticket acts as opened them in the watched repository', () => {
    expect(ticketPull(pr('agent-bot'), ticket(), deployment)).toBe(true)
    expect(ticketPull(pr('Alice-GH'), ticket('alice-gh'), deployment)).toBe(true)
    expect(ticketPull(pr('alice-gh'), ticket(), deployment)).toBe(false)
    expect(ticketPull(pr('mallory'), ticket('alice-gh'), deployment)).toBe(false)
    expect(ticketPull(pr('alice-gh', 'alice-gh/watched'), ticket('alice-gh'), deployment)).toBe(false)
  })
  it('treats what the GitHub App did on a linked person\'s behalf as the agent\'s own, and nothing else a person wrote', () => {
    const ctx = { config: () => ({ app: { clientId: 'x', slug: 'swarm-oauth' } }) } as never
    expect(ownItem(ctx, { user: { login: 'agent-bot' } }, 'agent-bot')).toBe(true)
    expect(ownItem(ctx, { user: { login: 'alice-gh' }, performed_via_github_app: { slug: 'swarm-oauth', id: 1 } }, 'agent-bot')).toBe(true)
    expect(ownItem(ctx, { user: { login: 'alice-gh' }, performed_via_github_app: { slug: 'other-app' } }, 'agent-bot')).toBe(false)
    expect(ownItem(ctx, { user: { login: 'alice-gh' }, performed_via_github_app: null }, 'agent-bot')).toBe(false)
    expect(ownItem({ config: () => ({}) } as never, { user: { login: 'alice-gh' }, performed_via_github_app: { slug: 'swarm-oauth' } }, 'agent-bot')).toBe(false)
  })
})
