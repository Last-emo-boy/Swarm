import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { expect } from '../testing/expect.js'
import { CliError, type Commands } from '../commands.js'
import { sendFeishu } from './feishu-channel.js'
import { sendGithub } from './github-channel.js'
import type { OutboundMessage } from '../core/index.js'

const message = (attachment?: string): OutboundMessage => ({ id: 'm1', kind: 'reply', text: 'The patch is ready.', channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
  ...attachment ? { attachment } : {} })
function withPatch(run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-attachment-'))
  const path = join(dir, 'fix-typo-abc.patch')
  writeFileSync(path, 'From 1 Mon Sep 17 00:00:00 2001\n+Notice\n')
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('attachments', () => {
  it('replies on Feishu with the text, then the attachment as a file from its directory', () => withPatch(async (path) => {
    const calls: [string[], string | undefined][] = []
    const commands = { lark: async (args: string[], cwd?: string) => { calls.push([args, cwd]); return {} } } as unknown as Commands
    expect(await sendFeishu({ commands }, message(path))).toBe('sent')
    expect(calls.map(([args, cwd]) => [args.slice(4, 6), args.at(-1), cwd])).toEqual([
      [['--markdown', 'The patch is ready.'], 'm1', undefined],
      [['--file', 'fix-typo-abc.patch'], 'm1-file', join(path, '..')]
    ])
  }))
  it('says that an attachment Feishu refuses for good could not be attached, and retries one that fails for a while', () => withPatch(async (path) => {
    const calls: string[][] = []
    const refuse = (error: Error) => ({ lark: async (args: string[]) => { calls.push(args); if (args.includes('--file')) throw error; return {} } }) as unknown as Commands
    expect(await sendFeishu({ commands: refuse(new CliError('No permission to upload (99991672)', 99991672)) }, message(path))).toBe('sent')
    expect(calls.at(-1)).toContain('m1-nofile')
    await expect(sendFeishu({ commands: refuse(new CliError('lark-cli timed out')) }, message(path))).rejects.toThrow('timed out')
  }))
  it('folds an attachment into the end of a GitHub comment', () => withPatch(async (path) => {
    const posted: string[] = []
    const commands = { deployment: { repository: 'o/r', github: { cli: 'gh', login: 'agent' } }, pages: async () => [],
      api: async (_schema: unknown, _path: string, ...flags: string[]) => { posted.push(flags.at(-1)!); return {} } } as unknown as Commands
    await sendGithub({ commands }, { ...message(path), channel: { source: 'github', thread: 'github:7', address: { number: '7' } } })
    expect(posted[0]).toContain('<details><summary>fix-typo-abc.patch</summary>')
    expect(posted[0]).toContain('```diff\nFrom 1 Mon Sep 17')
  }))
})
