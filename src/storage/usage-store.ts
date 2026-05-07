import { randomUUID } from "node:crypto";
import type { SwarmDatabase } from "./database.js";

export type UsageEvent = {
  event_id: string;
  session_id?: string;
  task_id?: string;
  kind: "llm_call" | "tool_call" | "worker_spawn" | "approval" | "artifact" | "wall_time";
  amount: number;
  unit: "count" | "tokens" | "usd" | "bytes" | "ms";
  metadata: Record<string, unknown>;
  created_at: string;
};

type UsageRow = Omit<UsageEvent, "metadata"> & { metadata_json: string };

export class UsageStore {
  constructor(private readonly database: SwarmDatabase) {}

  append(input: Omit<UsageEvent, "event_id" | "created_at"> & { event_id?: string; created_at?: string }): UsageEvent {
    const event: UsageEvent = {
      event_id: input.event_id ?? `usage_${randomUUID()}`,
      session_id: input.session_id,
      task_id: input.task_id,
      kind: input.kind,
      amount: input.amount,
      unit: input.unit,
      metadata: input.metadata,
      created_at: input.created_at ?? new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO usage_events (
          event_id, session_id, task_id, kind, amount, unit, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.event_id,
        event.session_id ?? null,
        event.task_id ?? null,
        event.kind,
        event.amount,
        event.unit,
        JSON.stringify(event.metadata),
        event.created_at
      );
    return event;
  }

  list(sessionId?: string, limit = 100): UsageEvent[] {
    const rows = sessionId
      ? this.database.db
          .prepare("SELECT * FROM usage_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, limit)
      : this.database.db
          .prepare("SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return (rows as UsageRow[]).map(fromRow);
  }

  summarize(sessionId?: string): Record<string, number> {
    const events = this.list(sessionId, 10_000);
    const totals: Record<string, number> = {};
    for (const event of events) {
      const key = `${event.kind}.${event.unit}`;
      totals[key] = (totals[key] ?? 0) + event.amount;
    }
    return totals;
  }
}

function fromRow(row: UsageRow): UsageEvent {
  return {
    ...row,
    session_id: row.session_id ?? undefined,
    task_id: row.task_id ?? undefined,
    metadata: JSON.parse(row.metadata_json)
  };
}
