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

  listForTasks(sessionId: string, taskIds: string[]): BlackboardEntry[] {
    if (taskIds.length === 0) {
      return [];
    }

    const allEntries = this.list(sessionId);
    return allEntries.filter((entry) => entry.task_id && taskIds.includes(entry.task_id));
  }
}
