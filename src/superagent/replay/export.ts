/**
 * Exporting replay cases from a private copy of the live store: for each named finding, the call it is about, the scene
 * that call saw, and what it did then. Reads the copies read-only and writes only under a private root (assertPrivate).
 */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { key } from "../core/index.js";
import { callOf } from "../chatter.js";
import { feishuTriggerId } from "../sources/feishu-trigger.js";
import { assertPrivate, saveCase, type ReplayCase, type Scene } from "./case.js";

/** Which call of a finding the case replays. Its anchors and rubric are private: they live under the replay root, not here. */
interface FindingCase {
  finding: string;
  /** The case id: finding, purpose, a short anchor. */
  suffix: string;
  purpose: ReplayCase["purpose"];
  /** A distinctive piece of the message the finding is about: the call is the first of its purpose after it. */
  anchor?: string;
  /** A distinctive piece of what the agent wrote then, when the finding is about its own line rather than a message. */
  said?: string;
  expect: ReplayCase["expect"];
}

/**
 * The first cases: the seven failure scenes, and three where it behaved well so a change that makes the agent go mute
 * fails instead of passing every check. Each anchor, `said` line and rubric quotes a private chat, so they live in the
 * anchors file under the replay root (`--anchors`), never in this source; an export with no file for a finding skips it.
 */
export const FINDING_CASES: readonly FindingCase[] = [
  { finding: "F01", suffix: "chatter-b023", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["no-commit", "no-tool-invention", "no-ticket-claims"], forbidden: ["commit"] } },
  { finding: "F04", suffix: "chatter-carbon", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["no-commit", "no-tool-invention"], forbidden: ["claim_test"] } },
  { finding: "F05", suffix: "attend-claim", purpose: "attend", expect: { kind: "replied", rubric: "", checks: ["no-commit", "no-tool-invention"], forbidden: ["commit", "claim_task"] } },
  { finding: "F12", suffix: "attend-empty-at", purpose: "attend", expect: { kind: "replied", rubric: "", checks: ["no-tool-invention", "answers-addressed"], forbidden: ["claim_empty"] } },
  { finding: "F15", suffix: "chatter-guess", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["no-tool-invention"], forbidden: ["assert_unknown"] } },
  { finding: "F19", suffix: "chatter-screenshot", purpose: "chatter", expect: { kind: "said", rubric: "", checks: [], forbidden: ["describe_image"] } },
  { finding: "F20", suffix: "chatter-token", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["no-token-ask"], forbidden: ["ask_credential"] } },
  // Where it behaved well: B002 declined to decide a refund, B013 asked what the image showed instead of guessing, and
  // B024 said plainly that the test had not run. A run that answers none of these has gone mute, not better.
  { finding: "G01", suffix: "chatter-refund-decline", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["spoke"] } },
  { finding: "G02", suffix: "chatter-image-question", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["spoke"] } },
  { finding: "G03", suffix: "chatter-honest-no-result", purpose: "chatter", expect: { kind: "said", rubric: "", checks: ["spoke"] } }
];

/** A finding's private anchors and rubric, as `--anchors` reads them: finding id -> what only the owner's copy holds. */
export type PrivateAnchors = Record<string, { anchor?: string; said?: string; after?: string; before?: string; chat?: string; rubric?: string }>;

export interface ExportOptions {
  storePath: string;
  usagePath: string;
  settingsPath: string;
  /** Where the cases go: a private root, never a repository. */
  out: string;
  /** Which findings to export; every one in FINDING_CASES by default. */
  findings?: string[];
  /** The agent's own name on the cards; `w33d` when the deployment is unknown. */
  agent?: string;
  /** A finding's private anchors and rubrics (message text, `said` lines): read from here, never from source. */
  anchors?: PrivateAnchors;
}

export interface ExportResult {
  cases: string[];
  skipped: { finding: string; why: string }[];
}

/** One model call as the usage copy recorded it: when, which purpose, and the hashes of the card it sent. */
export interface UsageCall {
  at: string; purpose: string; model: string; provider: string; ms: number;
  systemHash: string; userHash: string; sectionHashes?: Record<string, string>;
}

/** A trigger row as the store holds it, cut to what a scene needs. */
interface Row { id: string; at: string; text: string; actorId: string; human: boolean; addressed?: string; meta: Record<string, unknown> }

const rowOf = (value: Record<string, unknown>): Row => ({ id: String(value.id), at: String(value.at), text: String(value.text ?? ""),
  actorId: String((value.actor as { id: string }).id), human: value.human === true,
  ...(typeof value.addressed === "string" ? { addressed: value.addressed } : {}), meta: (value.meta ?? {}) as Record<string, unknown> });

const openDb = (path: string): DatabaseSync => {
  if (!existsSync(path)) throw new Error(`No store copy at ${path}`);
  return new DatabaseSync(path, { readOnly: true });
};

/** The model calls the usage copy recorded, oldest first, one per call. */
export function usageCalls(path: string): UsageCall[] {
  const db = openDb(path);
  try {
    return db.prepare("SELECT created_at, metadata_json FROM usage_events WHERE kind = 'llm_call' AND unit = 'count' ORDER BY created_at").all()
      .flatMap((row) => {
        let metadata: Record<string, unknown>;
        try { metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>; } catch { return []; }
        if (!String(metadata.purpose ?? "").startsWith("superagent_")) return [];
        const current = ((metadata.promptCacheDiagnostics ?? {}) as { current?: Record<string, unknown> }).current ?? {};
        return [{ at: String(row.created_at), purpose: String(metadata.purpose), model: String(metadata.model ?? ""),
          provider: String(metadata.providerId ?? ""), ms: Number(metadata.durationMs ?? 0),
          systemHash: String(current.systemHash ?? ""), userHash: String(current.userHash ?? ""),
          ...(current.sectionHashes ? { sectionHashes: current.sectionHashes as Record<string, string> } : {}) }];
      });
  } finally { db.close(); }
}

/** The store's Feishu messages in one chat, oldest first. */
function chatRows(db: DatabaseSync, chatId: string): Row[] {
  return db.prepare("SELECT value FROM trigger WHERE value ->> '$.source' = 'feishu' AND value ->> '$.meta.chatId' = ? ORDER BY at, rowid")
    .all(chatId).map((row) => rowOf(JSON.parse(String(row.value)) as Record<string, unknown>));
}

/**
 * The messages whose text holds `anchor`, at or after `after` when the finding's evidence names a day. Each message's chat
 * is where the finding happened: an anchor that matches in more than one chat without a day is ambiguous, and the export
 * says so rather than taking the first match anywhere in the store (the F05 anchor once matched a plan breakdown from
 * another chat two days earlier).
 */
function anchorRows(db: DatabaseSync, anchor: string, bounds: { after?: string; before?: string; chat?: string } = {}): Row[] {
  if (!anchor) return [];
  return db.prepare("SELECT value FROM trigger WHERE value ->> '$.source' = 'feishu' AND value ->> '$.text' LIKE ? ORDER BY at").all(`%${anchor}%`)
    .map((row) => rowOf(JSON.parse(String(row.value)) as Record<string, unknown>))
    .filter((row) => typeof row.meta.chatId === "string" && (!bounds.after || row.at >= bounds.after) && (!bounds.before || row.at <= bounds.before)
      && (!bounds.chat || row.meta.chatId === bounds.chat));
}

/** The one chat an anchor's matches name; undefined when they disagree, which the export reports instead of guessing. */
function anchorChat(rows: readonly Row[]): { chatId?: string; ambiguous: boolean } {
  const chats = new Set(rows.map((row) => String(row.meta.chatId)));
  return chats.size === 1 ? { chatId: [...chats][0], ambiguous: false } : { ambiguous: chats.size > 1 };
}

/** The settings a case pins, with every Source's config emptied: no key, token or CLI travels with it. */
export function sanitizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const sources = (settings.sources ?? {}) as Record<string, Record<string, unknown>>;
  return {
    ...(settings.chatter ? { chatter: settings.chatter } : {}),
    ...(settings.memory ? { memory: settings.memory } : {}),
    ...(settings.eval ? { eval: settings.eval } : {}),
    policy: settings.policy ?? { rules: [], sources: {} },
    sources: Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, { ...source, config: {} }]))
  };
}

/**
 * The agent's own lines in a chat in the 12 hours before `at`, as chatter's card holds them: the said lines the store kept
 * (only the 20 newest per chat survive, so an older call loses them) plus each outbox row the agent posted there. The
 * outbox carries no time, so a row is dated by the message it answered, which is when it went out to the minute.
 */
function ownLines(db: DatabaseSync, chatId: string, at: string): Scene["own"] {
  const cutoff = Date.parse(at), since = cutoff - 12 * 3_600_000;
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(`chatter:${chatId}`) as { value?: string } | undefined;
  const said: Scene["own"] = row ? (JSON.parse(String(row.value)) as { said?: Scene["own"] }).said ?? [] : [];
  const times = new Map(chatRows(db, chatId).map((message) => [String(message.meta.messageId ?? ""), message.at]));
  const kept = new Set(said.map((line) => `${line.at}|${line.text}`));
  const sentIds = new Set(said.map((line) => line.to).filter((to): to is string => typeof to === "string"));
  const sent = db.prepare("SELECT value FROM outbox").all()
    .map((item) => JSON.parse(String(item.value)) as { text: string; channel?: { address?: Record<string, string> } })
    .flatMap((item): Scene["own"] => {
      const address = item.channel?.address;
      if (address?.chatId !== chatId || address.mode === "user") return [];
      const answered = String(address.messageId ?? "");
      const posted = times.get(answered);
      return posted && !sentIds.has(answered) && !kept.has(`${posted}|${item.text}`) ? [{ at: posted, text: item.text }] : [];
    });
  return [...said, ...sent].filter((line) => Date.parse(line.at) >= since && Date.parse(line.at) <= cutoff)
    .sort((a, b) => a.at.localeCompare(b.at));
}

const kv = (db: DatabaseSync, name: string): Record<string, unknown> | undefined => {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(name) as { value?: string } | undefined;
  return row ? JSON.parse(String(row.value)) as Record<string, unknown> : undefined;
};

/** The people's names the store had, by id, so a rebuilt card names them as the recorded one did. */
function peopleOf(db: DatabaseSync): Map<string, string> {
  const people = new Map<string, string>();
  for (const row of db.prepare("SELECT key, value FROM kv WHERE key LIKE 'person:feishu:%'").all()) {
    const value = JSON.parse(String(row.value)) as { name?: unknown };
    if (typeof value.name === "string") people.set(String(row.key).slice("person:feishu:".length), value.name);
  }
  return people;
}

/** The messages and notes one call saw, as the case pins them: the 12-hour window, its own lines, its own state. */
export function sceneFromStore(db: DatabaseSync, options: { chatId: string; at: string; settings: unknown; agent: string }): Scene {
  const { chatId, at, agent } = options;
  const cutoff = Date.parse(at);
  const people = peopleOf(db);
  const messages = chatRows(db, chatId).filter((row) => Date.parse(row.at) <= cutoff)
    .map((row) => ({
      id: row.id, sender: row.actorId, senderName: people.get(row.actorId) ?? row.actorId,
      human: row.human, at: row.at, text: row.text,
      ...(typeof row.meta.parentId === "string" ? { parentId: row.meta.parentId } : {}),
      ...(typeof row.meta.messageId === "string" ? { messageId: row.meta.messageId } : {}),
      ...(row.meta.mentioned === true ? { mentioned: true } : {}),
      ...(row.meta.direct === true ? { direct: true } : {}),
      ...(row.addressed ? { addressed: true } : {})
    }));
  // The 12-hour window chatter and attend read (chatter.ts WINDOW_MS).
  const since = cutoff - 12 * 3_600_000;
  const windowed = messages.filter((message) => Date.parse(message.at) >= since);
  const notes = db.prepare("SELECT value FROM memory ORDER BY updated DESC").all()
    .map((row) => JSON.parse(String(row.value)) as Scene["notes"][number])
    .filter((note) => note.created < at && (note.about === `chat:${chatId}` || note.about.startsWith("person:")));
  const state = kv(db, `chatter:${chatId}`) as { consideredAt?: string; attendedAt?: string; spoke?: string[]; answered?: { at: string; bot?: boolean }[] } | undefined;
  const name = (kv(db, "source-labels:feishu") ?? {})[chatId];
  const mark = kv(db, `memory-reflected:${chatId}`) as { from: string; upTo: string; at: string } | undefined;
  const asks = ((kv(db, "asks-open") as unknown as Scene["asks"] | undefined) ?? [])
    .filter((ask) => ask.chatId === chatId && Date.parse(ask.at) < cutoff);
  const tickets = db.prepare("SELECT value FROM ticket ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { id: string; title: string; ended?: unknown })
    .map((ticket) => ({ ticketId: ticket.id, title: ticket.title, state: ticket.ended ? "ended" : "open" }));
  return {
    at, chatId, ...(typeof name === "string" ? { chatName: name } : {}), agent,
    messages: windowed.slice(-30),
    // Every name the store had, so a rebuilt card names a sender as the recorded one did (people.ts `senderOf`).
    people: [...people].map(([id, name]) => ({ id, name })),
    own: ownLines(db, chatId, at),
    ...(() => { const own = kv(db, `own-messages:${chatId}`); return Array.isArray(own) ? { ownIds: own as string[] } : {}; })(),
    notes,
    ...(asks.length ? { asks } : {}),
    ...(state ? { chatterState: { ...(state.consideredAt ? { consideredAt: state.consideredAt } : {}), ...(state.attendedAt ? { attendedAt: state.attendedAt } : {}),
      ...(state.spoke ? { spoke: state.spoke.filter((line) => Date.parse(line) < cutoff) } : {}),
      ...(state.answered ? { answered: state.answered.filter((item) => Date.parse(item.at) < cutoff) } : {}) } } : {}),
    ...(mark && Date.parse(mark.at) <= cutoff ? { reflectMark: mark } : {}),
    ...(tickets.length ? { tickets } : {}),
    settings: options.settings
  };
}

/**
 * What the call did then. The outbox keeps no time, so a row is found by the id its sender gave it: chatter names the
 * message its card ended on (`key("chatter", chatId, triggerId)`), and attend the message it answered
 * (`key("attend", chatId, triggerId)`) — both recomputed from the scene's own messages. A call whose row is not among
 * them (a chat used again later does not matter) leaves `silent`: a baseline is what the call did, never the chat's
 * latest post on some other day.
 */
export function outcomeFromStore(db: DatabaseSync, chatId: string, at: string, purpose: ReplayCase["purpose"],
  messages: readonly { id: string; at: string }[] = []): ReplayCase["recorded"]["outcome"] {
  if (purpose === "reflect") {
    const after = Date.parse(at);
    const note = db.prepare("SELECT value FROM memory").all().map((row) => JSON.parse(String(row.value)) as { created: string; text: string })
      .find((item) => Date.parse(item.created) >= after && Date.parse(item.created) < after + 10 * 60_000);
    return { kind: "notes", notes: note ? [note.text] : [] };
  }
  const keys = new Set(messages.filter((message) => Date.parse(message.at) <= Date.parse(at))
    .flatMap((message) => [key(purpose === "chatter" ? "chatter" : "attend", chatId, message.id)]));
  const reply = db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { id: string; text: string; channel: { address: Record<string, string> } })
    .filter((row) => row.channel.address.chatId === chatId && row.channel.address.mode !== "user" && keys.has(row.id)).at(-1);
  if (!reply) return { kind: "silent" };
  return { kind: purpose === "chatter" ? "said" : "replied", outboxId: reply.id, text: reply.text };
}

/** The purpose a usage call records for a case's work. */
const purposeOf = (purpose: ReplayCase["purpose"]): string =>
  `superagent_${purpose === "reflect" ? "memory" : purpose}`;

/** How far from an anchor a call may sit and still be the one that answered it. */
const CALL_WINDOW_MS = 15 * 60_000;

/**
 * The usage call a finding's case replays: the first of its purpose within a few minutes of `at`, which is the anchor
 * message's time or the message the agent's own said line answered. Without one the call cannot be located, and the case
 * is skipped rather than pinned to the first call of that purpose in the whole copy.
 */
function callFor(calls: readonly UsageCall[], item: FindingCase, at?: string): UsageCall | undefined {
  if (!at) return undefined;
  const time = Date.parse(at);
  return calls.find((call) => call.purpose === purposeOf(item.purpose) && Date.parse(call.at) >= time && Date.parse(call.at) - time <= CALL_WINDOW_MS);
}

/** Where the agent said `said`, and when: the said lines the KV state kept across every chat. */
function saidLine(db: DatabaseSync, said: string, bounds: { after?: string; before?: string } = {}): { chatId: string; at: string } | undefined {
  for (const row of db.prepare("SELECT key, value FROM kv WHERE key LIKE 'chatter:%'").all()) {
    const chatId = String(row.key).slice("chatter:".length);
    const state = JSON.parse(String(row.value)) as { said?: Scene["own"] };
    const line = (state.said ?? []).find((item) => item.text.includes(said));
    if (line) return { chatId, at: line.at };
  }
  // The KV state keeps only the 20 newest said lines per chat; the outbox keeps every post, and the message each one
  // answered dates it (the outbox itself carries no time).
  const sent = db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { text: string; channel: { address: Record<string, string> } })
    .find((row) => row.text.includes(said) && row.channel.address.chatId);
  if (!sent) return undefined;
  const chatId = sent.channel.address.chatId;
  const answered = String(sent.channel.address.messageId ?? "");
  const message = answered ? db.prepare("SELECT at FROM trigger WHERE id = ?").get(feishuTriggerId(answered)) as { at?: string } | undefined : undefined;
  if (message?.at) return { chatId, at: message.at };
  // The message it answered may be the agent's own (no trigger row): the line went out just after the newest message the
  // chat holds at that point, which is the best time the copy can give. The outbox's row order is the only ordering there
  // is, so the bound is the newest message before this row's chat — never the chat's last message weeks later.
  const last = chatRows(db, chatId).filter((row) => !bounds.before || row.at <= bounds.before).at(-1);
  return last ? { chatId, at: last.at } : undefined;
}

export function exportCases(options: ExportOptions): ExportResult {
  assertPrivate(options.out);
  const calls = usageCalls(options.usagePath);
  const settings = sanitizeSettings(JSON.parse(readFileSync(options.settingsPath, "utf8")) as Record<string, unknown>);
  const agent = options.agent ?? "w33d";
  const wanted = options.findings?.length ? FINDING_CASES.filter((item) => options.findings!.includes(item.finding)) : FINDING_CASES;
  const cases: string[] = [], skipped: ExportResult["skipped"] = [];
  const db = openDb(options.storePath);
  try {
    for (const item of wanted) {
      // The finding's private anchors name the message, or the agent's own line, the case is about; neither lives in source.
      const privateAnchors = options.anchors?.[item.finding];
      if (!privateAnchors?.anchor && !privateAnchors?.said) { skipped.push({ finding: item.finding, why: "no private anchor for this finding (--anchors <file>)" }); continue; }
      let chatId: string | undefined, after: string | undefined;
      if (privateAnchors.anchor) {
        const rows = anchorRows(db, privateAnchors.anchor, privateAnchors);
        const found = anchorChat(rows);
        if (found.ambiguous) { skipped.push({ finding: item.finding, why: `"${privateAnchors.anchor}" matches messages in more than one chat; name the day (after/before) or the chat in the anchors file` }); continue; }
        chatId = found.chatId; after = rows[0]?.at;
      } else {
        const said = saidLine(db, privateAnchors.said!, privateAnchors);
        if (!said) { skipped.push({ finding: item.finding, why: `no message of the agent says "${privateAnchors.said}"` }); continue; }
        chatId = said.chatId; after = said.at;
      }
      if (!chatId) { skipped.push({ finding: item.finding, why: privateAnchors.anchor ? `no message holds "${privateAnchors.anchor}"` : "the said line names no chat" }); continue; }
      const call = callFor(calls, item, after);
      if (!call) { skipped.push({ finding: item.finding, why: `no superagent call of purpose ${item.purpose} at or after ${after ?? "the anchor"}` }); continue; }
      const started = new Date(Date.parse(call.at) - call.ms).toISOString();
      const scene = sceneFromStore(db, { chatId, at: started, settings, agent });
      const outcome = outcomeFromStore(db, chatId, call.at, item.purpose, scene.messages);
      // Attend is handed the ids callOf names for the messages after its last look (attention() in chatter.ts), not the
      // newest few: a guess there lets the run answer messages the recorded call was never given.
      const targetIds = item.purpose === "attend" ? attendTargets(scene, chatId, started) : undefined;
      const kase: ReplayCase = {
        version: 1, id: `${item.finding.toLowerCase()}-${item.purpose}-${item.suffix.split("-").at(-1)}`, purpose: item.purpose, finding: item.finding,
        scene,
        recorded: { card: { systemHash: call.systemHash, userHash: call.userHash, ...(call.sectionHashes ? { sectionHashes: call.sectionHashes } : {}) },
          callAt: call.at, durationMs: call.ms, model: call.model, provider: call.provider, ...(outcome.text ? { answer: outcome.text } : {}), outcome },
        expect: { ...item.expect, rubric: privateAnchors.rubric ?? item.expect.rubric },
        ...(targetIds?.length ? { targetIds } : {})
      };
      saveCase(options.out, kase);
      cases.push(kase.id);
    }
  } finally { db.close(); }
  return { cases, skipped };
}

/**
 * The ids production's `attention()` hands an attend call (chatter.ts): every message after the chat's last look that
 * `callOf` names for the agent. Computed the same way, so a run reasons about the messages the recorded call did.
 */
function attendTargets(scene: Scene, chatId: string, at: string): string[] {
  // Its first look covers the 12-hour window the model reads when the store keeps no mark for the chat.
  const since = scene.chatterState?.attendedAt ?? new Date(Date.parse(at) - 12 * 3_600_000).toISOString();
  const store = { get: (name: string) => name === `own-messages:${chatId}` ? scene.ownIds : undefined };
  return scene.messages.filter((message) => message.at > since)
    .map((message) => ({ message, trigger: {
      id: message.id, at: message.at, text: message.text, human: message.human, actor: { source: "feishu", id: message.sender },
      meta: { chatId, ...(message.mentioned ? { mentioned: true } : {}), ...(message.parentId ? { parentId: message.parentId } : {}) }
    } }))
    .filter(({ trigger }) => callOf(store as never, trigger as never, scene.agent ?? "", (scene.asks ?? []) as never))
    .map(({ message }) => message.id);
}
