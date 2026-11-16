/**
 * A replay case: a recorded scene of the agent's talking paths (a chat's messages, its own lines, the notes and the ticket
 * state it saw) with what it did then and what a good run should do. Cases live in the state directory, never in the
 * repository: they quote private chats.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { superagentStateDir } from "../settings.js";

export const CASE_VERSION = 1;

/** A message as the chat had it when the call was made. */
export interface SceneMessage {
  id: string; sender: string; senderName: string; human: boolean; at: string; text: string;
  parentId?: string; messageId?: string; mentioned?: boolean; addressed?: boolean;
}
/** One thing the agent remembered then, as memories.ts keeps it. */
export interface SceneNote {
  id: string; about: string; text: string; kind: string;
  origin: { chatId?: string; direct?: boolean; triggerId?: string; ticketId?: string };
  due?: string; done?: string; created: string; updated: string;
}
/** An ask the agent was waiting to hear back on (asks.ts). */
export interface SceneAsk {
  id: string; chatId?: string; person?: string; to: string[]; text: string; at: string;
  for: { id: string; name: string; channel: unknown };
}

export interface Scene {
  /** The call's start time: the clock the run sees. */
  at: string;
  chatId: string; chatName?: string; direct?: boolean;
  /** The agent's own name, which the prompts and `names_you` use. */
  agent?: string;
  messages: SceneMessage[];
  /** What the agent said in the chat, as `KV.chatter.chat` held it then; `from_ticket` marks the words a ticket said. */
  own: { at: string; text: string; to?: string; topic?: boolean; from_ticket?: string }[];
  /** Its own message ids there, so a reply to one reads as a reply to it (people.ts). */
  ownIds?: string[];
  notes: SceneNote[];
  asks?: SceneAsk[];
  chatterState?: { consideredAt?: string; attendedAt?: string; spoke?: string[]; answered?: { at: string; bot?: boolean }[] };
  /** reflect only: the mark the store held, from which the reflection read. */
  reflectMark?: { from: string; upTo: string; at: string };
  /** People's names, so a card names them as it did then. */
  people?: { id: string; name: string }[];
  /** The chat's tickets, as the router's recent list and a talk card's ticket list show them. */
  tickets?: { ticketId: string; title: string; state: string }[];
  /** Sanitized: every Source's config emptied, so no key or token travels with the case. */
  settings: unknown;
}

/** What the call did then. */
export interface Recorded {
  card: { systemHash: string; userHash: string; sectionHashes?: Record<string, string> };
  callAt: string; durationMs: number; model: string; provider: string;
  answer?: string;
  outcome: {
    kind: "said" | "silent" | "replied" | "relayed" | "asked_back" | "routed" | "ignored" | "ticketed" | "unavailable" | "notes";
    outboxId?: string; text?: string; decision?: { kind: string; reason?: unknown }; notes?: string[];
  };
}

export interface Expect {
  /** What a good run does: the talk outcomes, or the router's own decision kinds for a route case. */
  kind: "said" | "silent" | "replied" | "routed" | "notes"
    | "accept" | "attach" | "ignore" | "stop" | "chat" | "command" | "message";
  /** One paragraph, from the finding, on what a good run should do. */
  rubric: string;
  /** Names of deterministic checks to run. */
  checks: string[];
  forbidden?: string[];
}

export interface ReplayCase {
  version: 1;
  /** `f01-chatter-b023`: the finding, the purpose, a short anchor. */
  id: string;
  purpose: "chatter" | "attend" | "route" | "reflect";
  finding: string;
  scene: Scene;
  recorded: Recorded;
  expect: Expect;
  /** The message ids an attend call was handed, as its effect payload held them. */
  targetIds?: string[];
}

/** Where cases and run records live: the state directory, never the repository. */
export const replayRoot = (stateDir = superagentStateDir()): string => join(stateDir, "replay");

/**
 * Refuses a path inside any git work tree, so private cases and reports never land in a repository. Walks up from `path`
 * looking for `.git`; a directory that does not exist yet is checked from its nearest existing parent.
 */
export function assertPrivate(path: string): void {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Follow a symlink before walking: an --out that is or lives under a link into a checkout has no `.git` on its lexical
  // ancestors, and the guard would let private cases into the repository.
  current = realpathSync(current);
  for (;;) {
    if (existsSync(join(current, ".git"))) throw new Error(`${path} is inside the git work tree ${current}: replay cases stay out of the repository (use --out <private dir>)`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function casePath(root: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Not a case id: ${id}`);
  return join(root, "cases", `${id}.json`);
}

export function loadCase(root: string, id: string): ReplayCase {
  const path = casePath(root, id);
  if (!existsSync(path)) throw new Error(`No case ${id} in ${join(root, "cases")}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ReplayCase;
  if (parsed.version !== CASE_VERSION) throw new Error(`Case ${id} is version ${parsed.version}; this build reads ${CASE_VERSION}`);
  return parsed;
}

/** Writes a case owner-only; the root and its folders are created 0700. */
export function saveCase(root: string, kase: ReplayCase): void {
  const path = casePath(root, kase.id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(kase, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Every case id in the root, sorted. */
export function listCases(root: string): string[] {
  const dir = join(root, "cases");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
}
