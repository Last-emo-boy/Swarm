import { createHash, randomUUID } from "node:crypto";
import type { RiskClass } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export type AuditDecision = "requested" | "approved" | "denied" | "executed" | "failed" | "blocked";

export type AuditRecord = {
  audit_id: string;
  session_id?: string;
  task_id?: string;
  trace_id?: string;
  actor_type: "user" | "agent" | "tool" | "runtime" | "policy";
  actor_id: string;
  action: string;
  resource: unknown;
  risk_class: RiskClass;
  decision: AuditDecision;
  reason?: string;
  checksum: string;
  created_at: string;
};

type AuditRow = Omit<AuditRecord, "resource"> & { resource_json: string };

export class AuditStore {
  constructor(private readonly database: SwarmDatabase) {}

  append(input: Omit<AuditRecord, "audit_id" | "checksum" | "created_at"> & { audit_id?: string; created_at?: string }): AuditRecord {
    const resourceJson = JSON.stringify(input.resource ?? {});
    const record: AuditRecord = {
      audit_id: input.audit_id ?? `audit_${randomUUID()}`,
      session_id: input.session_id,
      task_id: input.task_id,
      trace_id: input.trace_id,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      action: input.action,
      resource: input.resource ?? {},
      risk_class: input.risk_class,
      decision: input.decision,
      reason: input.reason,
      checksum: createHash("sha256").update(`${input.action}:${resourceJson}:${input.decision}`).digest("hex"),
      created_at: input.created_at ?? new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO audit_logs (
          audit_id, session_id, task_id, trace_id, actor_type, actor_id, action,
          resource_json, risk_class, decision, reason, checksum, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.audit_id,
        record.session_id ?? null,
        record.task_id ?? null,
        record.trace_id ?? null,
        record.actor_type,
        record.actor_id,
        record.action,
        resourceJson,
        record.risk_class,
        record.decision,
        record.reason ?? null,
        record.checksum,
        record.created_at
      );
    return record;
  }

  get(auditId: string): AuditRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM audit_logs WHERE audit_id = ?")
      .get(auditId) as AuditRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(sessionId?: string, limit = 80): AuditRecord[] {
    const rows = sessionId
      ? this.database.db
          .prepare("SELECT * FROM audit_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, limit)
      : this.database.db
          .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return (rows as AuditRow[]).map(fromRow);
  }

  listByTrace(traceOrSpanId: string, limit = 80): AuditRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM audit_logs WHERE trace_id = ? OR audit_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(traceOrSpanId, traceOrSpanId, limit) as AuditRow[];
    return rows.map(fromRow);
  }
}

function fromRow(row: AuditRow): AuditRecord {
  return {
    ...row,
    session_id: row.session_id ?? undefined,
    task_id: row.task_id ?? undefined,
    trace_id: row.trace_id ?? undefined,
    reason: row.reason ?? undefined,
    resource: JSON.parse(row.resource_json)
  };
}
