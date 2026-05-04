import type { SwarmEnvelope } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export class TraceStore {
  constructor(private readonly database: SwarmDatabase) {}

  append(envelope: SwarmEnvelope): void {
    this.database.db
      .prepare(
        `INSERT OR IGNORE INTO envelopes (
          id, session_id, swarm_id, task_id, subtask_id, attempt, type, intent,
          from_json, to_json, payload_json, trace_id, span_id, parent_span_id,
          idempotency_key, reply_to, correlation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        envelope.id,
        envelope.session_id,
        envelope.swarm_id,
        envelope.task_id ?? null,
        envelope.subtask_id ?? null,
        envelope.attempt ?? null,
        envelope.type,
        envelope.intent,
        JSON.stringify(envelope.from),
        JSON.stringify(envelope.to),
        JSON.stringify(envelope.payload),
        envelope.trace?.trace_id ?? null,
        envelope.trace?.span_id ?? null,
        envelope.trace?.parent_span_id ?? null,
        envelope.idempotency_key ?? null,
        envelope.reply_to ?? null,
        envelope.correlation_id ?? null,
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
      subtask_id?: string | null;
      attempt?: number | null;
      type: SwarmEnvelope["type"];
      intent: string;
      from_json: string;
      to_json: string;
      payload_json: string;
      trace_id?: string | null;
      span_id?: string | null;
      parent_span_id?: string | null;
      idempotency_key?: string | null;
      reply_to?: string | null;
      correlation_id?: string | null;
      created_at: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      version: "1.0",
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task_id: row.task_id ?? undefined,
      subtask_id: row.subtask_id ?? undefined,
      attempt: row.attempt ?? undefined,
      type: row.type,
      intent: row.intent,
      correlation_id: row.correlation_id ?? undefined,
      reply_to: row.reply_to ?? undefined,
      idempotency_key: row.idempotency_key ?? undefined,
      trace: row.trace_id && row.span_id
        ? {
            trace_id: row.trace_id,
            span_id: row.span_id,
            parent_span_id: row.parent_span_id ?? undefined
          }
        : undefined,
      from: JSON.parse(row.from_json),
      to: JSON.parse(row.to_json),
      payload: JSON.parse(row.payload_json),
      created_at: row.created_at
    }));
  }
}
