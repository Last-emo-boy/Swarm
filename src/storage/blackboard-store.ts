import { randomUUID } from "node:crypto";
import type { AgentAddress, BlackboardEntry } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export class BlackboardStore {
  constructor(private readonly database: SwarmDatabase) {}

  write(input: {
    swarm_id: string;
    session_id: string;
    task_id?: string;
    key: string;
    value: unknown;
    type: BlackboardEntry["type"];
    created_by: AgentAddress;
    visibility?: BlackboardEntry["visibility"];
    tags?: string[];
  }): BlackboardEntry {
    const entry: BlackboardEntry = {
      entry_id: `bb_${randomUUID()}`,
      swarm_id: input.swarm_id,
      session_id: input.session_id,
      task_id: input.task_id,
      key: input.key,
      value: input.value,
      type: input.type,
      created_by: input.created_by,
      created_at: new Date().toISOString(),
      visibility: input.visibility ?? "team",
      version: 1,
      tags: input.tags
    };

    this.database.db
      .prepare(
        `INSERT INTO blackboard_entries (
          entry_id, session_id, swarm_id, task_id, key, type, value_json, created_by_json,
          visibility, version, tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.entry_id,
        entry.session_id,
        entry.swarm_id,
        entry.task_id ?? null,
        entry.key,
        entry.type,
        JSON.stringify(entry.value),
        JSON.stringify(entry.created_by),
        entry.visibility,
        entry.version,
        JSON.stringify(entry.tags ?? []),
        entry.created_at,
        entry.updated_at ?? null
      );

    return entry;
  }

  update(input: {
    session_id: string;
    entry_id?: string;
    key?: string;
    expected_version?: number;
    value: unknown;
    tags?: string[];
  }): BlackboardEntry {
    const existing = input.entry_id
      ? this.getByEntryId(input.session_id, input.entry_id)
      : input.key
        ? this.getLatestByKey(input.session_id, input.key)
        : undefined;
    if (!existing) {
      throw new Error("Blackboard update target not found.");
    }
    if (input.expected_version !== undefined && input.expected_version !== existing.version) {
      throw new Error(`Blackboard version conflict for ${existing.key}: expected ${input.expected_version}, found ${existing.version}`);
    }
    const next: BlackboardEntry = {
      ...existing,
      value: input.value,
      version: existing.version + 1,
      tags: input.tags ?? existing.tags,
      updated_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `UPDATE blackboard_entries
         SET value_json = ?, version = ?, tags_json = ?, updated_at = ?
         WHERE entry_id = ?`
      )
      .run(JSON.stringify(next.value), next.version, JSON.stringify(next.tags ?? []), next.updated_at ?? null, next.entry_id);
    return next;
  }

  lock(input: { session_id: string; key: string; holder: AgentAddress; ttl_ms?: number }): void {
    const now = new Date();
    const expires = input.ttl_ms ? new Date(now.getTime() + input.ttl_ms).toISOString() : null;
    const existing = this.database.db
      .prepare("SELECT key, expires_at FROM blackboard_locks WHERE session_id = ? AND key = ?")
      .get(input.session_id, input.key) as { key: string; expires_at?: string | null } | undefined;
    if (existing?.expires_at && new Date(existing.expires_at).getTime() < now.getTime()) {
      this.unlock({ session_id: input.session_id, key: input.key });
    } else if (existing) {
      throw new Error(`Blackboard key is locked: ${input.key}`);
    }
    this.database.db
      .prepare("INSERT INTO blackboard_locks (key, session_id, holder_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.key, input.session_id, JSON.stringify(input.holder), now.toISOString(), expires);
  }

  unlock(input: { session_id: string; key: string }): void {
    this.database.db
      .prepare("DELETE FROM blackboard_locks WHERE session_id = ? AND key = ?")
      .run(input.session_id, input.key);
  }

  list(sessionId: string): BlackboardEntry[] {
    const rows = this.database.db
      .prepare("SELECT * FROM blackboard_entries WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as {
      entry_id: string;
      session_id: string;
      swarm_id: string;
      task_id?: string | null;
      key: string;
      type: BlackboardEntry["type"];
      value_json: string;
      created_by_json: string;
      visibility: BlackboardEntry["visibility"];
      version: number;
      tags_json?: string | null;
      created_at: string;
      updated_at?: string | null;
    }[];

    return rows.map((row) => ({
      entry_id: row.entry_id,
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task_id: row.task_id ?? undefined,
      key: row.key,
      type: row.type,
      value: JSON.parse(row.value_json),
      created_by: JSON.parse(row.created_by_json),
      visibility: row.visibility,
      version: row.version,
      tags: row.tags_json ? JSON.parse(row.tags_json) : [],
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined
    }));
  }

  listRecent(limit = 50): BlackboardEntry[] {
    const rows = this.database.db
      .prepare("SELECT * FROM blackboard_entries ORDER BY created_at DESC LIMIT ?")
      .all(limit) as BlackboardRow[];
    return rows.map(fromRow);
  }

  listForTasks(sessionId: string, taskIds: string[]): BlackboardEntry[] {
    if (taskIds.length === 0) {
      return [];
    }

    const allEntries = this.list(sessionId);
    return allEntries.filter((entry) => entry.task_id && taskIds.includes(entry.task_id));
  }

  read(sessionId: string, input: { entryId?: string; key?: string; limit?: number }): BlackboardEntry[] {
    if (input.entryId) {
      const entry = this.getByEntryId(sessionId, input.entryId);
      return entry ? [entry] : [];
    }
    if (input.key) {
      const entries = this.list(sessionId).filter((entry) => entry.key === input.key);
      const limit = input.limit && input.limit > 0 ? input.limit : entries.length;
      return entries.slice(Math.max(0, entries.length - limit));
    }
    const limit = input.limit && input.limit > 0 ? input.limit : 50;
    return this.list(sessionId).slice(-limit);
  }

  query(sessionId: string, input: { type?: BlackboardEntry["type"]; tag?: string; keyPrefix?: string; taskId?: string; agentId?: string }): BlackboardEntry[] {
    return this.list(sessionId).filter((entry) => {
      if (input.type && entry.type !== input.type) return false;
      if (input.taskId && entry.task_id !== input.taskId) return false;
      if (input.keyPrefix && !entry.key.startsWith(input.keyPrefix)) return false;
      if (input.tag && !(entry.tags ?? []).includes(input.tag)) return false;
      if (input.agentId && entry.created_by.agent_id !== input.agentId) return false;
      return true;
    });
  }

  private getByEntryId(sessionId: string, entryId: string): BlackboardEntry | undefined {
    return this.list(sessionId).find((entry) => entry.entry_id === entryId);
  }

  private getLatestByKey(sessionId: string, key: string): BlackboardEntry | undefined {
    return [...this.list(sessionId)].reverse().find((entry) => entry.key === key);
  }
}

type BlackboardRow = {
  entry_id: string;
  session_id: string;
  swarm_id: string;
  task_id?: string | null;
  key: string;
  type: BlackboardEntry["type"];
  value_json: string;
  created_by_json: string;
  visibility: BlackboardEntry["visibility"];
  version: number;
  tags_json?: string | null;
  created_at: string;
  updated_at?: string | null;
};

function fromRow(row: BlackboardRow): BlackboardEntry {
  return {
    entry_id: row.entry_id,
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    task_id: row.task_id ?? undefined,
    key: row.key,
    type: row.type,
    value: JSON.parse(row.value_json),
    created_by: JSON.parse(row.created_by_json),
    visibility: row.visibility,
    version: row.version,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined
  };
}
