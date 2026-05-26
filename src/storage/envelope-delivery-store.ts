import type { AgentAddress, SwarmEnvelope } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export type EnvelopeDeliveryStatus = "queued" | "delivered" | "acked" | "failed" | "expired" | "superseded";

export type EnvelopeDeliveryRecipient = Pick<AgentAddress, "agent_id" | "role" | "capability">;

export type EnvelopeDeliveryRecord = {
  delivery_id: string;
  envelope_id: string;
  session_id: string;
  swarm_id: string;
  task_id?: string;
  type: SwarmEnvelope["type"];
  intent: string;
  from_agent_id?: string;
  recipient_key: string;
  recipient_agent_id?: string;
  recipient_role?: string;
  recipient_capability?: string;
  status: EnvelopeDeliveryStatus;
  correlation_id?: string;
  reply_to?: string;
  idempotency_key?: string;
  attempt?: number;
  queued_at: string;
  delivered_at?: string;
  acked_at?: string;
  failed_at?: string;
  expired_at?: string;
  superseded_at?: string;
  error?: string;
  last_response_envelope_id?: string;
  metadata: Record<string, unknown>;
};

export class EnvelopeDeliveryStore {
  constructor(private readonly database: SwarmDatabase) {}

  recordQueued(envelope: SwarmEnvelope, recipients = recipientsFromEnvelope(envelope)): EnvelopeDeliveryRecord[] {
    const now = new Date().toISOString();
    return normalizeRecipients(recipients).map((recipient) => {
      const record = buildRecord(envelope, recipient, "queued", now);
      this.database.db
        .prepare(
          `INSERT OR IGNORE INTO envelope_deliveries (
            delivery_id, envelope_id, session_id, swarm_id, task_id, type, intent,
            from_agent_id, recipient_key, recipient_agent_id, recipient_role, recipient_capability,
            status, correlation_id, reply_to, idempotency_key, attempt,
            queued_at, delivered_at, acked_at, failed_at, expired_at, superseded_at,
            error, last_response_envelope_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.delivery_id,
          record.envelope_id,
          record.session_id,
          record.swarm_id,
          record.task_id ?? null,
          record.type,
          record.intent,
          record.from_agent_id ?? null,
          record.recipient_key,
          record.recipient_agent_id ?? null,
          record.recipient_role ?? null,
          record.recipient_capability ?? null,
          record.status,
          record.correlation_id ?? null,
          record.reply_to ?? null,
          record.idempotency_key ?? null,
          record.attempt ?? null,
          record.queued_at,
          record.delivered_at ?? null,
          record.acked_at ?? null,
          record.failed_at ?? null,
          record.expired_at ?? null,
          record.superseded_at ?? null,
          record.error ?? null,
          record.last_response_envelope_id ?? null,
          JSON.stringify(record.metadata)
        );
      return this.get(record.delivery_id) ?? record;
    });
  }

  markDelivered(envelopeId: string, recipients?: EnvelopeDeliveryRecipient[]): void {
    const now = new Date().toISOString();
    this.updateStatus(envelopeId, "delivered", "delivered_at", now, recipients);
  }

  markAcked(envelopeId: string, response: SwarmEnvelope, recipients?: EnvelopeDeliveryRecipient[]): void {
    const now = new Date().toISOString();
    this.updateStatus(envelopeId, "acked", "acked_at", now, recipients, {
      last_response_envelope_id: response.id
    });
  }

  markFailed(envelopeId: string, error: string, response?: SwarmEnvelope, recipients?: EnvelopeDeliveryRecipient[]): void {
    const now = new Date().toISOString();
    this.updateStatus(envelopeId, "failed", "failed_at", now, recipients, {
      error,
      last_response_envelope_id: response?.id
    });
  }

  recordExpired(envelope: SwarmEnvelope, recipients = recipientsFromEnvelope(envelope)): EnvelopeDeliveryRecord[] {
    const now = new Date().toISOString();
    const records = this.recordQueued(envelope, recipients);
    this.updateStatus(envelope.id, "expired", "expired_at", now, recipients, {
      error: "Envelope TTL expired before delivery."
    });
    return records.map((record) => this.get(record.delivery_id) ?? record);
  }

  recordSuperseded(envelope: SwarmEnvelope, existingEnvelopeId: string): EnvelopeDeliveryRecord[] {
    const now = new Date().toISOString();
    const records = this.recordQueued(envelope);
    this.updateStatus(envelope.id, "superseded", "superseded_at", now, undefined, {
      last_response_envelope_id: existingEnvelopeId,
      metadata: { superseded_by: existingEnvelopeId }
    });
    return records.map((record) => this.get(record.delivery_id) ?? record);
  }

  list(filter: {
    sessionId?: string;
    envelopeId?: string;
    taskId?: string;
    agentId?: string;
    status?: EnvelopeDeliveryStatus;
    correlationId?: string;
  } = {}): EnvelopeDeliveryRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.envelopeId) {
      clauses.push("envelope_id = ?");
      params.push(filter.envelopeId);
    }
    if (filter.taskId) {
      clauses.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.agentId) {
      clauses.push("(from_agent_id = ? OR recipient_agent_id = ?)");
      params.push(filter.agentId, filter.agentId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.correlationId) {
      clauses.push("correlation_id = ?");
      params.push(filter.correlationId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.db
      .prepare(`SELECT * FROM envelope_deliveries ${where} ORDER BY queued_at ASC, delivery_id ASC`)
      .all(...params) as EnvelopeDeliveryRow[];
    return rows.map(fromRow);
  }

  get(deliveryId: string): EnvelopeDeliveryRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM envelope_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as EnvelopeDeliveryRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  private updateStatus(
    envelopeId: string,
    status: EnvelopeDeliveryStatus,
    timestampColumn: "delivered_at" | "acked_at" | "failed_at" | "expired_at" | "superseded_at",
    timestamp: string,
    recipients?: EnvelopeDeliveryRecipient[],
    extra: { error?: string; last_response_envelope_id?: string; metadata?: Record<string, unknown> } = {}
  ): void {
    const recipientKeys = recipients ? normalizeRecipients(recipients).map((recipient) => recipientKey(recipient)) : undefined;
    const existing = this.list({ envelopeId }).filter((record) => !recipientKeys || recipientKeys.includes(record.recipient_key));
    for (const record of existing) {
      const metadata = { ...record.metadata, ...(extra.metadata ?? {}) };
      this.database.db
        .prepare(
          `UPDATE envelope_deliveries
           SET status = ?,
               ${timestampColumn} = ?,
               error = COALESCE(?, error),
               last_response_envelope_id = COALESCE(?, last_response_envelope_id),
               metadata_json = ?
           WHERE delivery_id = ?`
        )
        .run(
          status,
          timestamp,
          extra.error ?? null,
          extra.last_response_envelope_id ?? null,
          JSON.stringify(metadata),
          record.delivery_id
        );
    }
  }
}

type EnvelopeDeliveryRow = {
  delivery_id: string;
  envelope_id: string;
  session_id: string;
  swarm_id: string;
  task_id?: string | null;
  type: SwarmEnvelope["type"];
  intent: string;
  from_agent_id?: string | null;
  recipient_key: string;
  recipient_agent_id?: string | null;
  recipient_role?: string | null;
  recipient_capability?: string | null;
  status: EnvelopeDeliveryStatus;
  correlation_id?: string | null;
  reply_to?: string | null;
  idempotency_key?: string | null;
  attempt?: number | null;
  queued_at: string;
  delivered_at?: string | null;
  acked_at?: string | null;
  failed_at?: string | null;
  expired_at?: string | null;
  superseded_at?: string | null;
  error?: string | null;
  last_response_envelope_id?: string | null;
  metadata_json: string;
};

function buildRecord(
  envelope: SwarmEnvelope,
  recipient: EnvelopeDeliveryRecipient,
  status: EnvelopeDeliveryStatus,
  queuedAt: string
): EnvelopeDeliveryRecord {
  const key = recipientKey(recipient);
  return {
    delivery_id: `${envelope.id}:${key}`,
    envelope_id: envelope.id,
    session_id: envelope.session_id,
    swarm_id: envelope.swarm_id,
    task_id: envelope.task_id,
    type: envelope.type,
    intent: envelope.intent,
    from_agent_id: envelope.from.agent_id,
    recipient_key: key,
    recipient_agent_id: recipient.agent_id,
    recipient_role: recipient.role,
    recipient_capability: recipient.capability,
    status,
    correlation_id: envelope.correlation_id,
    reply_to: envelope.reply_to,
    idempotency_key: envelope.idempotency_key,
    attempt: envelope.attempt,
    queued_at: queuedAt,
    metadata: {
      to: envelope.to,
      routing: envelope.routing,
      priority: envelope.priority,
      ttl_ms: envelope.ttl_ms
    }
  };
}

function recipientsFromEnvelope(envelope: SwarmEnvelope): EnvelopeDeliveryRecipient[] {
  return normalizeRecipients(Array.isArray(envelope.to) ? envelope.to : [envelope.to]);
}

function normalizeRecipients(recipients: EnvelopeDeliveryRecipient[]): EnvelopeDeliveryRecipient[] {
  return recipients.length ? recipients : [{ role: "unknown" }];
}

function recipientKey(recipient: EnvelopeDeliveryRecipient): string {
  if (recipient.agent_id) return `agent:${recipient.agent_id}`;
  if (recipient.capability) return `capability:${recipient.capability}`;
  if (recipient.role) return `role:${recipient.role}`;
  return "unknown";
}

function fromRow(row: EnvelopeDeliveryRow): EnvelopeDeliveryRecord {
  return {
    delivery_id: row.delivery_id,
    envelope_id: row.envelope_id,
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    task_id: row.task_id ?? undefined,
    type: row.type,
    intent: row.intent,
    from_agent_id: row.from_agent_id ?? undefined,
    recipient_key: row.recipient_key,
    recipient_agent_id: row.recipient_agent_id ?? undefined,
    recipient_role: row.recipient_role ?? undefined,
    recipient_capability: row.recipient_capability ?? undefined,
    status: row.status,
    correlation_id: row.correlation_id ?? undefined,
    reply_to: row.reply_to ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    attempt: row.attempt ?? undefined,
    queued_at: row.queued_at,
    delivered_at: row.delivered_at ?? undefined,
    acked_at: row.acked_at ?? undefined,
    failed_at: row.failed_at ?? undefined,
    expired_at: row.expired_at ?? undefined,
    superseded_at: row.superseded_at ?? undefined,
    error: row.error ?? undefined,
    last_response_envelope_id: row.last_response_envelope_id ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}
