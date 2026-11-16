/**
 * Running a replay case: a fresh temporary store seeded with the case's scene, one call of the recorded purpose through a
 * model port (a script for tests, the real provider on the command line), and the outcome read back from that temp store.
 * No host and no effects run, so nothing is delivered and nothing leaves the machine beyond the model call itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { key } from "../core/index.js";
import type { ModelAssessor } from "../assessor.js";
import { ChatterRoom } from "../chatter.js";
import { SuperagentClient } from "../client.js";
import { KV } from "../kv.js";
import { Memories } from "../memories.js";
import { settingsPath, writeSettings } from "../settings.js";
import { defaultMachine, type Deployment } from "../setup.js";
import { feishuTrigger } from "../sources/feishu.js";
import { feishuTriggerId } from "../sources/feishu-trigger.js";
import type { ReplayCase, Scene } from "./case.js";
import { cardHashes } from "./hash.js";

/** The bot's own id on the seeded events: any id works, as long as a mention of it is a mention of the agent. */
const BOT_ID = "ou_bot";

/** One model call's answer: what the caller's port returns, unchanged. */
export type ModelPort = (input: { purpose: string; system: string; user: string; model?: string }) => Promise<string>;

export interface RunRecord {
  caseId: string; run: number; at: string; durationMs: number;
  call: { purpose: string; system: string; user: string; systemHash: string; userHash: string; sectionHashes: Record<string, string> } | null;
  /** The model's raw answer, or null when it threw or no call was made. */
  answer: string | null;
  outcome: ReplayCase["recorded"]["outcome"];
  error?: string;
}

/** The deployment a case's run sees: the agent's name, and nothing else. */
export const kaseDeployment = (kase: ReplayCase, stateDir: string): Deployment =>
  ({ ...defaultMachine(stateDir), repository: "",
    ...(kase.scene.agent ? { feishu: { cli: "", appId: "", brand: "feishu", botId: "", name: kase.scene.agent } as never } : {}) });

/** The Feishu event a scene message was, as the Source hands it to the Engine. */
function eventOf(message: Scene["messages"][number], scene: Scene) {
  // The bot's own ids, so a mention of it reads as one and the card marks the message addressed.
  const mention = message.mentioned ? [{ id: BOT_ID, key: "@_user_1", name: scene.agent ?? "bot" }] : [];
  return {
    message_id: message.messageId ?? message.id.replace(/^feishu:/, ""),
    chat_id: scene.chatId, chat_type: scene.direct ? "p2p" : "group",
    sender_id: message.sender, sender_type: message.human ? "user" : "bot",
    // The store keeps the text with mentions already resolved (`@w33d`), so prefixing the key again would double it.
    content: message.mentioned && !message.text.includes(`@${scene.agent ?? "bot"}`) ? `@_user_1 ${message.text}` : message.text,
    create_time: String(Date.parse(message.at)), mentions: mention,
    ...(message.parentId ? { parent_id: message.parentId } : {})
  };
}

/** Seeds the scene into `client`'s store: the messages in order, then its own lines, notes, asks and marks. */
export function seedScene(client: SuperagentClient, kase: ReplayCase): { triggerId?: string; ids: string[] } {
  const { scene } = kase;
  for (const person of scene.people ?? []) client.store.set(KV.people.person("feishu", person.id), { name: person.name, at: scene.at });
  if (scene.chatName) client.store.set(KV.sources.labels("feishu"), { ...(client.store.get(KV.sources.labels("feishu")) ?? {}), [scene.chatId]: scene.chatName });
  if (scene.ownIds?.length) client.store.set(KV.people.own(scene.chatId), scene.ownIds);
  const ids: string[] = [];
  for (const message of [...scene.messages].sort((a, b) => a.at.localeCompare(b.at))) {
    const trigger = feishuTrigger(eventOf(message, scene), BOT_ID, "cli_app");
    if (!trigger) continue;
    client.engine.receive(trigger);
    ids.push(trigger.id);
  }
  const state = client.store.get(KV.chatter.chat(scene.chatId)) ?? { said: [] };
  // A scene's own line marks a ticket's words with `from_ticket`; the KV record keeps that as `ticket`.
  client.store.set(KV.chatter.chat(scene.chatId), { ...state,
    said: scene.own.map(({ from_ticket: ticket, ...line }) => ({ ...line, ...(ticket ? { ticket } : {}) })), ...scene.chatterState });
  if (scene.reflectMark) client.store.set(KV.memory.reflected(scene.chatId), scene.reflectMark);
  if (scene.asks?.length) client.store.set(KV.asks.open, scene.asks as never);
  for (const note of scene.notes) client.store.memory.save(note as never);
  // The seeding's queued effects never run in a replay: drop them so only the call under test leaves a trace.
  client.store.db.prepare("DELETE FROM effect").run();
  const last = ids.at(-1);
  return { ...(last ? { triggerId: last } : {}), ids };
}

/** The message ids an attend call is handed: the case's, or the scene's last few when it recorded none. */
const attendIds = (kase: ReplayCase, seeded: { ids: string[] }): string[] =>
  kase.targetIds?.length ? kase.targetIds : seeded.ids.slice(-5);

/**
 * What the run left in the temp store, in the shape a case records. The seeds' effects were dropped and no effect ever runs
 * here, so a new outbox row is the call's own message, held `pending`; and the call records what it did in its own KV state,
 * which tells a reply it posted from one it decided not to.
 */
function outcomeOf(client: SuperagentClient, kase: ReplayCase, before: { outbox: Set<string>; state: string; notes: Set<string> }): ReplayCase["recorded"]["outcome"] {
  if (kase.purpose === "route") {
    const decision = client.store.read.recentDecisions(0, 1)[0];
    return decision ? { kind: "routed", decision: { kind: decision.kind, ...(decision.reason ? { reason: decision.reason } : {}) } } : { kind: "ignored" };
  }
  const fresh = client.store.db.prepare("SELECT id, value FROM outbox ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { id: string; text: string; channel?: { address?: Record<string, string> } })
    .filter((row) => !before.outbox.has(row.id));
  // A reflection writes notes through the memory table, not the outbox: what it wrote is the note rows the run added.
  if (kase.purpose === "reflect") {
    const written = client.store.db.prepare("SELECT id, value FROM memory").all().map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) as { text?: string } }))
      .filter((row) => !before.notes.has(row.id));
    return { kind: "notes", notes: written.map((row) => row.value.text ?? "") };
  }
  const after = JSON.stringify(client.store.get(KV.chatter.chat(kase.scene.chatId)) ?? {});
  const changed = after !== before.state;
  if (kase.purpose === "chatter") {
    const spoke = (client.store.get(KV.chatter.chat(kase.scene.chatId))?.spoke ?? []).length > ((JSON.parse(before.state) as { spoke?: string[] }).spoke ?? []).length;
    const sent = fresh.at(-1);
    return spoke && sent ? { kind: "said", outboxId: sent.id, text: sent.text } : { kind: "silent" };
  }
  // An attend answer relays, asks someone back and/or replies. Posting nothing is not a reply: the checks and the
  // kind-match grade it as silence, which is what the run did.
  const sent = fresh.at(-1);
  return sent ? { kind: "replied", outboxId: sent.id, text: sent.text } : { kind: "silent" };
}

/** The outbox ids and note count before a run, so the run's own messages can be told apart. */
function markOf(client: SuperagentClient, kase: ReplayCase): { outbox: Set<string>; state: string; notes: Set<string> } {
  return { outbox: new Set(client.store.db.prepare("SELECT id FROM outbox").all().map((row) => String(row.id))),
    state: JSON.stringify(client.store.get(KV.chatter.chat(kase.scene.chatId)) ?? {}),
    notes: new Set(client.store.db.prepare("SELECT id FROM memory").all().map((row) => String(row.id))) };
}

/** Runs one case `runs` times, each in a fresh temporary store, and returns what each run did. */
export async function runCase(kase: ReplayCase, options: { complete: ModelPort; runs: number; root?: string }): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (let run = 1; run <= options.runs; run++) records.push(await runOnce(kase, run, options));
  return records;
}

async function runOnce(kase: ReplayCase, run: number, options: { complete: ModelPort }): Promise<RunRecord> {
  const dir = mkdtempSync(join(tmpdir(), "swarm-replay-"));
  const at = Date.parse(kase.scene.at);
  let call: RunRecord["call"] = null, answer: string | null = null, error: string | undefined;
  const startedAt = Date.now();
  const client = new SuperagentClient({ stateDir: dir, now: () => kase.scene.at, deployment: () => kaseDeployment(kase, dir) });
  try {
    writeSettings(kase.scene.settings, settingsPath(dir));
    const seeded = seedScene(client, kase);
    const before = markOf(client, kase);
    // One model call per run: the wrapper records the card it was handed and refuses a second call, so a retried parse
    // cannot double-bill the run.
    const complete: ModelPort = async (input) => {
      if (call) throw new Error("replay: a second model call in one run");
      call = { purpose: input.purpose, system: input.system, user: input.user, ...cardHashes(input.system, input.user) };
      const text = await options.complete(input);
      answer = text;
      return text;
    };
    if (kase.purpose === "chatter" || kase.purpose === "attend") {
      // A parse retry inside answerOf is the one place a second call could happen; a scripted or real port that answers
      // valid JSON on the first try keeps this at one call. A refused retry ends the run with the first answer.
      const room = new ChatterRoom({ client, now: () => at, complete });
      const seededChat = client.store.get(KV.chatter.chat(kase.scene.chatId)) ?? { said: [] };
      // Attending reads its window from the chat's messages; its chatter budget does not apply to an answer it is called for.
      if (kase.purpose === "attend") client.store.set(KV.chatter.chat(kase.scene.chatId), { ...seededChat, spoke: [], answered: [] });
      if (kase.purpose === "chatter") await room.consider(kase.scene.chatId); else await room.attend(kase.scene.chatId, attendIds(kase, seeded));
    } else if (kase.purpose === "reflect") {
      const memories = new Memories({ client, now: () => at, complete });
      await memories.reflect(kase.scene.chatId);
    } else {
      const assessor = new (await import("../assessor.js")).ModelAssessor({ client, now: () => at, complete,
        configured: () => false, devices: async () => ({ nodes: [] }) as never });
      const { triggerId } = seeded;
      if (!triggerId) throw new Error("replay: no message to route");
      client.engine.evaluateDue();
      const candidate = client.engine.candidate(triggerId);
      if (!candidate) throw new Error("replay: the router saw no Eval for the message");
      await assessor.judge(triggerId, candidate.evalId);
    }
    return { caseId: kase.id, run, at: kase.scene.at, durationMs: Date.now() - startedAt, call, answer, outcome: outcomeOf(client, kase, before), ...(error ? { error } : {}) };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    return { caseId: kase.id, run, at: kase.scene.at, durationMs: Date.now() - startedAt, call, answer, outcome: { kind: "silent" }, error };
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes run records under the private root, owner-only. */
export function saveRuns(root: string, records: readonly RunRecord[]): void {
  if (!records.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, "runs", records[0]!.caseId, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const record of records) writeFileSync(join(dir, `${record.run}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
