/** Fixtures for the replay tests: a tiny synthetic store, a usage copy, and a settings file, all in a temp directory. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SuperagentClient } from "../client.js";
import { KV } from "../kv.js";
import { settingsPath, writeSettings } from "../settings.js";
import type { Deployment } from "../setup.js";
import { feishuTrigger } from "../sources/feishu.js";
import type { Scene } from "./case.js";

export const CHAT = "oc_team", BOT = "ou_bot";
export const AT = "2026-11-11T10:45:24.000Z";

export interface Fixture { dir: string; client: SuperagentClient; deployment: () => Deployment; close(): void }

/** A state directory with settings, a client, and a deployment naming the agent `w33d`. */
export function state(dir: string, extra: Record<string, unknown> = {}): Fixture {
  writeSettings({
    sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "all" }], directMessages: true } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } },
    chatter: { chats: [CHAT], persona: "Dry humour." },
    memory: { enabled: true },
    ...extra
  }, settingsPath(dir));
  const deployment = () => ({ stateDir: dir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: BOT, name: "w33d" } }) as unknown as Deployment;
  const client = new SuperagentClient({ stateDir: dir, deployment });
  return { dir, client, deployment, close: () => client.close() };
}

/** Seeds one Feishu message into the client's store. */
export function message(client: SuperagentClient, input: { id: string; sender: string; text: string; at: string; human?: boolean; mention?: boolean; parentId?: string }): void {
  const trigger = feishuTrigger({ message_id: input.id, chat_id: CHAT, chat_type: "group", sender_id: input.sender,
    sender_type: input.human === false ? "bot" : "user", content: input.mention ? `@_user_1 ${input.text}` : input.text,
    create_time: String(Date.parse(input.at)), mentions: input.mention ? [{ id: BOT, key: "@_user_1", name: "w33d" }] : [],
    ...(input.parentId ? { parent_id: input.parentId } : {}) }, BOT, "cli_app")!;
  client.engine.receive(trigger);
}

/** The scene the tests pin: two people, the agent's own earlier line, a note. */
export function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    at: AT, chatId: CHAT, chatName: "团队", agent: "w33d",
    messages: [
      // Invented text: the fixtures exercise the code paths, never a real chat's lines.
      { id: "feishu:om_1", sender: "ou_alice", senderName: "Alice", human: true, at: "2026-11-11T10:40:02.000Z", text: "staging 那版应该没上吧" },
      { id: "feishu:om_2", sender: "ou_bob", senderName: "Bob", human: true, at: "2026-11-11T10:44:00.000Z", text: "我这边看不到" }
    ],
    own: [{ at: "2026-11-11T09:40:42.000Z", text: "那个最小验证我这边没跑出来，别当成已经验过了" }],
    notes: [{ id: "n1", about: `chat:${CHAT}`, text: "有人让我发个最小验证", kind: "event", origin: { chatId: CHAT },
      created: "2026-11-11T09:05:41.000Z", updated: "2026-11-11T09:05:41.000Z" }],
    people: [{ id: "ou_alice", name: "Alice" }, { id: "ou_bob", name: "Bob" }],
    settings: { sources: { feishu: { enabled: true, config: {} } }, chatter: { chats: [CHAT], persona: "Dry humour." }, memory: { enabled: true },
      policy: { rules: [], sources: {} } },
    ...overrides
  };
}

/** Writes a usage copy with one `llm_call` count row per call, as provider.ts records them. */
export function usageDb(path: string, calls: { at: string; purpose: string; systemHash: string; userHash: string; ms?: number; model?: string }[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE usage_events (event_id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, kind TEXT NOT NULL, amount REAL NOT NULL, unit TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO usage_events VALUES (?, NULL, NULL, 'llm_call', 1, 'count', ?, ?)");
  calls.forEach((call, index) => insert.run(`usage_${index}`, JSON.stringify({ providerId: "deepseek", protocol: "openai-chat-completions",
    model: call.model ?? "deepseek-flash", purpose: call.purpose, durationMs: call.ms ?? 1000, promptCacheDiagnostics: { current: {
      systemHash: call.systemHash, userHash: call.userHash, sectionHashes: { system: call.systemHash, task: call.userHash } } } }), call.at));
  db.close();
}

export { writeFileSync, join, writeSettings };
