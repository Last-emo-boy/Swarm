import type { ToolApprovalRequest } from "../tools/types.js";
import type { SwarmDatabase } from "./database.js";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRecord = {
  approval_id: string;
  session_id?: string;
  task_id?: string;
  action: string;
  summary: string;
  detail: string;
  risk: ToolApprovalRequest["risk"];
  risk_class: ToolApprovalRequest["risk_class"];
  target: string;
  status: ApprovalStatus;
  challenge: ToolApprovalRequest;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = Omit<ApprovalRecord, "challenge"> & { challenge_json: string };

export class ApprovalStore {
  constructor(private readonly database: SwarmDatabase) {}

  upsert(request: ToolApprovalRequest, status: ApprovalStatus): ApprovalRecord {
    const now = new Date().toISOString();
    const existing = this.get(request.id);
    const createdAt = existing?.created_at ?? now;
    this.database.db
      .prepare(
        `INSERT INTO approvals (
          approval_id, session_id, task_id, action, summary, detail, risk, risk_class,
          target, status, challenge_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          session_id = excluded.session_id,
          task_id = excluded.task_id,
          action = excluded.action,
          summary = excluded.summary,
          detail = excluded.detail,
          risk = excluded.risk,
          risk_class = excluded.risk_class,
          target = excluded.target,
          status = excluded.status,
          challenge_json = excluded.challenge_json,
          updated_at = excluded.updated_at`
      )
      .run(
        request.id,
        request.session_id ?? null,
        request.task_id ?? null,
        request.action,
        request.summary,
        request.detail,
        request.risk,
        request.risk_class,
        request.target,
        status,
        JSON.stringify(request),
        createdAt,
        now
      );
    return this.get(request.id)!;
  }

  get(approvalId: string): ApprovalRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM approvals WHERE approval_id = ?")
      .get(approvalId) as ApprovalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(sessionId?: string, limit = 50): ApprovalRecord[] {
    const rows = sessionId
      ? this.database.db
          .prepare("SELECT * FROM approvals WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?")
          .all(sessionId, limit)
      : this.database.db
          .prepare("SELECT * FROM approvals ORDER BY updated_at DESC LIMIT ?")
          .all(limit);
    return (rows as ApprovalRow[]).map(fromRow);
  }
}

function fromRow(row: ApprovalRow): ApprovalRecord {
  return {
    ...row,
    session_id: row.session_id ?? undefined,
    task_id: row.task_id ?? undefined,
    challenge: JSON.parse(row.challenge_json) as ToolApprovalRequest
  };
}
