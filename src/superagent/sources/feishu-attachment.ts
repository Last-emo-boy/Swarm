/**
 * The files and images people attach to Feishu messages: which ones a message holds, as its stored text shows them, and one
 * of them downloaded with the bot's CLI and read on this host, for a ticket's worker wherever it runs (ticket-tools.ts).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { z } from 'zod/v4'
import { CliError, type Commands } from '../commands.js'

export interface Attachment { file_key: string; type: 'file' | 'image'; name?: string }
/** What a worker reads of one attachment; `base64` is for the worker's own tools to save, never for its model. */
export interface AttachmentRead extends Attachment {
  name: string; format: string; bytes: number; text?: string; text_note?: string; base64?: string; note?: string
}

/** The largest attachment the host downloads, and the largest whose bytes it passes on to the worker. */
export const ATTACHMENT_BYTES = 20 * 1024 * 1024, INLINE_BYTES = 4 * 1024 * 1024
/** How much of an attachment's text a read returns. */
export const TEXT_CHARS = 20_000
/** How long a download and a PDF's text extraction may take, together within a ticket tool's 110 seconds. */
const DOWNLOAD_MS = 60_000, PDF_MS = 30_000
const exec = promisify(execFile)

const KEY = /^(img|file)_[A-Za-z0-9_-]+$/
/** A file, voice or video message as lark-cli renders it: `<file key="file_v3_…" name="a.docx"/>`, `<audio key=… />`, `<video key=… name=…/>`. */
const TAG = /<(?:file|audio|video|media)\s([^<>]*?)\/?>/g
const ATTRIBUTE = /\b(key|name)="([^"]*)"/g
/** An image as lark-cli renders it, alone or in a post: `![Image](img_…)` or `[Image: img_…]`. */
const IMAGE = /!\[Image\]\((img_[A-Za-z0-9_-]+)\)|\[Image: (img_[A-Za-z0-9_-]+)\]/g

/** The files and images a message's stored text names, each once, in the order they appear. */
export function feishuAttachments(text: string): Attachment[] {
  const found = new Map<string, Attachment>()
  const add = (item: Attachment) => { if (KEY.test(item.file_key) && !found.has(item.file_key)) found.set(item.file_key, item) }
  for (const [, attributes] of text.matchAll(TAG)) {
    const values = Object.fromEntries([...attributes!.matchAll(ATTRIBUTE)].map(([, name, value]) => [name!, value!]))
    if (values.key) add({ file_key: values.key, type: 'file', ...values.name ? { name: values.name } : {} })
  }
  for (const [, inPost, alone] of text.matchAll(IMAGE)) add({ file_key: (inPost ?? alone)!, type: 'image' })
  // A message read from the chat's history keeps Feishu's own content: `{"file_key", "file_name"}`, `{"image_key"}` or a post's elements.
  let content: unknown
  try { content = JSON.parse(text) } catch { /* Rendered text, read above. */ }
  fromContent(content, add)
  return [...found.values()]
}
function fromContent(value: unknown, add: (item: Attachment) => void): void {
  if (Array.isArray(value)) { for (const item of value) fromContent(item, add); return }
  if (!value || typeof value !== 'object') return
  const item = value as Record<string, unknown>
  // A video's `image_key` is its cover, not an attachment of its own.
  if (typeof item.file_key === 'string') add({ file_key: item.file_key, type: 'file', ...typeof item.file_name === 'string' ? { name: item.file_name } : {} })
  else if (typeof item.image_key === 'string') add({ file_key: item.image_key, type: 'image' })
  for (const child of Object.values(item)) fromContent(child, add)
}

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
/**
 * Downloads one attachment of message `messageId` with the bot's CLI into a temporary directory and reads it: its size and
 * format, its text where it can be extracted (cut to `TEXT_CHARS`), and its bytes up to `INLINE_BYTES`. The file is deleted after.
 */
export async function readAttachment(commands: Commands, messageId: string, attachment: Attachment): Promise<AttachmentRead> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-attachment-')))
  try {
    const saved = await commands.withSignal(AbortSignal.timeout(DOWNLOAD_MS))
      .lark<unknown>(['im', '+messages-resources-download', '--message-id', messageId, '--file-key', attachment.file_key, '--type', attachment.type], dir)
      .catch((error: unknown) => { throw downloadError(error) })
    const path = savedIn(dir, saved)
    const bytes = statSync(path).size
    if (bytes > ATTACHMENT_BYTES) throw new Error(`This attachment is ${megabytes(bytes)}, more than the ${megabytes(ATTACHMENT_BYTES)} the host downloads: ask its sender for a smaller file or a link`)
    const name = attachment.name ?? basename(path)
    const format = (extname(name) || extname(path)).slice(1).toLowerCase() || 'unknown'
    const data = readFileSync(path)
    const notes: string[] = []
    const text = attachment.type === 'image' ? {} : await textOf(data, format, path)
    if (text.note) notes.push(text.note)
    if (attachment.type === 'image') notes.push('An image: you see it only if your model takes images; otherwise ask its sender what it shows, or work on the file with tools.')
    if (bytes > INLINE_BYTES) notes.push(`At ${megabytes(bytes)} it is larger than the ${megabytes(INLINE_BYTES)} the host passes on, so the file itself is not saved for you.`)
    return { file_key: attachment.file_key, type: attachment.type, name, format, bytes, ...text.text === undefined ? {} : cut(text.text),
      ...bytes <= INLINE_BYTES ? { base64: data.toString('base64') } : {}, ...notes.length ? { note: notes.join(' ') } : {} }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
function downloadError(error: unknown): Error {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return new Error(`Downloading this attachment took longer than ${DOWNLOAD_MS / 1000} s`)
  if (!(error instanceof CliError)) return error instanceof Error ? error : new Error(String(error))
  return new CliError(`Feishu refused the download: ${error.message}. If it is a permission error, the Feishu app needs the permission to read messages' resources (im:message:readonly), which an admin grants in its developer console.`, error.code, error.exitCode)
}
/** The file the CLI saved in `dir`, as its `saved_path` names it, else the one file there. */
function savedIn(dir: string, result: unknown): string {
  const reported = z.looseObject({ saved_path: z.string().min(1) }).safeParse(result)
  const path = reported.success ? resolve(dir, reported.data.saved_path) : join(dir, readdirSync(dir)[0] ?? '')
  const inside = relative(dir, path)
  if (!inside || inside.startsWith('..') || !existsSync(path)) throw new Error('The bot CLI saved no attachment where the host looks for it')
  return path
}

function cut(text: string): { text: string; text_note?: string } {
  if (text.length <= TEXT_CHARS) return { text }
  return { text: text.slice(0, TEXT_CHARS), text_note: `The first ${TEXT_CHARS} of ${text.length} characters: ${text.length - TEXT_CHARS} were left out.` }
}
/** Text files that may be in GB18030 rather than UTF-8, as files saved on Chinese Windows often are. */
const LOCAL_TEXT = new Set(['txt', 'csv', 'tsv', 'md', 'log'])
async function textOf(data: Buffer, format: string, path: string): Promise<{ text?: string; note?: string }> {
  if (format === 'docx') {
    try {
      const xml = zipEntry(data, 'word/document.xml')
      return xml ? { text: docxText(xml.toString('utf8')) } : { note: 'This .docx holds no word/document.xml, so its text was not extracted.' }
    } catch { return { note: 'This .docx could not be read as a zip archive, so its text was not extracted.' } }
  }
  if (format === 'pdf') return pdfText(path)
  if (data.includes(0)) return { note: `The text of a .${format} file is not extracted here: work on the file itself.` }
  try { return { text: plain(new TextDecoder('utf-8', { fatal: true }).decode(data), format) } }
  catch {
    if (LOCAL_TEXT.has(format)) return { text: plain(new TextDecoder('gb18030').decode(data), format), note: 'It is not UTF-8, so it was read as GB18030.' }
    return { note: `The text of a .${format} file is not extracted here: work on the file itself.` }
  }
}
const plain = (text: string, format: string): string => format === 'html' || format === 'htm' ? htmlText(text) : text
async function pdfText(path: string): Promise<{ text?: string; note?: string }> {
  try { return { text: (await exec('pdftotext', ['-enc', 'UTF-8', path, '-'], { timeout: PDF_MS, maxBuffer: 32 * 1024 * 1024 })).stdout } }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { note: 'pdftotext is not installed on the host, so this PDF\'s text was not extracted: work on the file itself.' }
    return { note: 'pdftotext could not read this PDF, so its text was not extracted: work on the file itself.' }
  }
}
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const character = (code: number, whole: string): string => code <= 0x10ffff ? String.fromCodePoint(code) : whole
const decoded = (text: string): string => text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (whole, hex?: string, decimal?: string, name?: string) =>
  hex ? character(Number.parseInt(hex, 16), whole) : decimal ? character(Number(decimal), whole) : entities[name!.toLowerCase()] ?? whole)
const tidy = (text: string): string => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
/** A Word document's text: one line per paragraph, tabs and line breaks kept. */
const docxText = (xml: string): string => tidy(decoded(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
  .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')))
const htmlText = (html: string): string => tidy(decoded(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')))
/** One file of a zip archive, such as a .docx's `word/document.xml`, or undefined when the archive holds none. */
function zipEntry(zip: Buffer, name: string): Buffer | undefined {
  // The end of central directory record is in the last 22 bytes, after a comment of at most 64 KB.
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) if (zip.readUInt32LE(at) === 0x06054b50) { end = at; break }
  if (end < 0) throw new Error('Not a zip archive')
  let at = zip.readUInt32LE(end + 16)
  for (let index = zip.readUInt16LE(end + 10); index > 0; index--) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Broken zip directory')
    const length = zip.readUInt16LE(at + 28)
    if (zip.toString('utf8', at + 46, at + 46 + length) === name) {
      const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), local = zip.readUInt32LE(at + 42)
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 })
      throw new Error('Unsupported zip compression')
    }
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return undefined
}
