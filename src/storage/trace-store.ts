import type { SwarmEnvelope } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export class TraceStore {
  constructor(private readonly database: SwarmDatabase) {}

  append(envelope: SwarmEnvelope): void {
    this.database.db
      .prepare(
        `INSERT OR IGNORE INTO envelopes (
          id, session_id, swarm_id, task_id, type, intent, from_json, to_json, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        envelope.id,
        envelope.session_id,
        envelope.swarm_id,
        envelope.task_id ?? null,
        envelope.type,
        envelope.intent,
        JSON.stringify(envelope.from),
        JSON.stringify(envelope.to),
        JSON.stringify(envelope.payload),
        envelope.created_at
      );
  }

  list(sessionId: string): SwarmEnvelope[] {
    const rows = this.database.db
      .prepare("SELECT * FROM envelopes WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as {
      id: string;
      session_id: string;
      swarm_id: string;
      task_id?: string | null;
      type: SwarmEnvelope["type"];
      intent: string;
      from_json: string;
      to_json: string;
      payload_json: string;
      created_at: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      version: "1.0",
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task_id: row.task_id ?? undefined,
      type: row.type,
      intent: row.intent,
      from: JSON.parse(row.from_json),
      to: JSON.parse(row.to_json),
      payload: JSON.parse(row.payload_json),
      created_at: row.created_at
    }));
  }
}
