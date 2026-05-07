import type { SwarmDatabase } from "./database.js";

export type SymphonyClaimStatus = "claimed" | "running" | "completed" | "failed" | "cancelled" | "released" | "retrying";

export type SymphonyClaimRecord = {
  claim_key: string;
  work_item_key: string;
  source_identity: string;
  workflow_path: string;
  session_id?: string;
  status: SymphonyClaimStatus;
  attempt: number;
  owner_id: string;
  claimed_at: string;
  updated_at: string;
  expires_at?: string;
  metadata: Record<string, unknown>;
};

type ClaimRow = Omit<SymphonyClaimRecord, "metadata" | "session_id" | "expires_at"> & {
  session_id?: string | null;
  expires_at?: string | null;
  metadata_json: string;
};

export class SymphonyClaimStore {
  constructor(private readonly database: SwarmDatabase) {}

  tryClaim(input: {
    work_item_key: string;
    source_identity: string;
    workflow_path: string;
    owner_id: string;
    ttl_ms: number;
    attempt?: number;
    metadata?: Record<string, unknown>;
  }): { claimed: true; record: SymphonyClaimRecord } | { claimed: false; record: SymphonyClaimRecord; reason: string } {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + Math.max(1, input.ttl_ms)).toISOString();
    const claimKey = claimKeyFor(input.workflow_path, input.work_item_key);
    const requestedMetadata = input.metadata ?? {};
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.db
        .prepare(
          `INSERT OR IGNORE INTO symphony_claims (
            claim_key, work_item_key, source_identity, workflow_path, session_id, status, attempt,
            owner_id, claimed_at, updated_at, expires_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          claimKey,
          input.work_item_key,
          input.source_identity,
          input.workflow_path,
          null,
          "claimed",
          input.attempt ?? 0,
          input.owner_id,
          now,
          now,
          expiresAt,
          JSON.stringify(requestedMetadata)
        );
      if (inserted.changes > 0) {
        const record = this.require(claimKey);
        this.database.db.exec("COMMIT");
        return { claimed: true, record };
      }

      const existing = this.require(claimKey);
      if (!claimCanBeReplaced(existing, nowMs)) {
        this.database.db.exec("COMMIT");
        return { claimed: false, record: existing, reason: `already_${existing.status}` };
      }

      const metadata = {
        ...existing.metadata,
        ...requestedMetadata,
        previous_owner_id: existing.owner_id,
        previous_status: existing.status
      };
      const updated = this.database.db
        .prepare(
          `UPDATE symphony_claims
           SET source_identity = ?,
               session_id = NULL,
               status = 'claimed',
               attempt = ?,
               owner_id = ?,
               claimed_at = ?,
               updated_at = ?,
               expires_at = ?,
               metadata_json = ?
           WHERE claim_key = ?
             AND (
               status IN ('failed', 'released')
               OR (
                 status NOT IN ('completed', 'cancelled')
                 AND expires_at IS NOT NULL
                 AND expires_at <= ?
               )
             )`
        )
        .run(
          input.source_identity,
          input.attempt ?? Math.max(0, existing.attempt),
          input.owner_id,
          now,
          now,
          expiresAt,
          JSON.stringify(metadata),
          claimKey,
          now
        );
      const record = this.require(claimKey);
      this.database.db.exec("COMMIT");
      return updated.changes > 0
        ? { claimed: true, record }
        : { claimed: false, record, reason: `already_${record.status}` };
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  mark(input: {
    claim_key?: string;
    work_item_key?: string;
    workflow_path?: string;
    status: SymphonyClaimStatus;
    session_id?: string;
    owner_id?: string;
    allow_owner_takeover?: boolean;
    expires_at?: string;
    metadata?: Record<string, unknown>;
  }): SymphonyClaimRecord | undefined {
    const claimKey = input.claim_key ?? (input.workflow_path && input.work_item_key ? claimKeyFor(input.workflow_path, input.work_item_key) : undefined);
    if (!claimKey) {
      return undefined;
    }
    const existing = this.get(claimKey);
    if (!existing) {
      return undefined;
    }
    const metadata = {
      ...existing.metadata,
      ...(input.metadata ?? {})
    };
    this.database.db
      .prepare(
        `UPDATE symphony_claims
         SET status = ?,
             session_id = COALESCE(?, session_id),
             owner_id = COALESCE(?, owner_id),
             updated_at = ?,
             expires_at = ?,
             metadata_json = ?
         WHERE claim_key = ?
           AND (? IS NULL OR owner_id = ? OR ? = 1)`
      )
      .run(
        input.status,
        input.session_id ?? null,
        input.owner_id ?? null,
        new Date().toISOString(),
        input.expires_at ?? existing.expires_at ?? null,
        JSON.stringify(metadata),
        claimKey,
        input.owner_id ?? null,
        input.owner_id ?? null,
        input.allow_owner_takeover ? 1 : 0
      );
    return this.get(claimKey);
  }

  release(input: { work_item_key: string; workflow_path: string; owner_id?: string; reason?: string }): void {
    this.mark({
      work_item_key: input.work_item_key,
      workflow_path: input.workflow_path,
      status: "released",
      owner_id: input.owner_id,
      expires_at: new Date().toISOString(),
      metadata: { release_reason: input.reason }
    });
  }

  get(claimKey: string): SymphonyClaimRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM symphony_claims WHERE claim_key = ?")
      .get(claimKey) as ClaimRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listActive(workflowPath: string, limit = 500): SymphonyClaimRecord[] {
    const rows = this.database.db
      .prepare(
        `SELECT * FROM symphony_claims
         WHERE workflow_path = ?
           AND status IN ('claimed', 'running', 'retrying')
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(workflowPath, limit) as ClaimRow[];
    return rows.map(fromRow);
  }

  private require(claimKey: string): SymphonyClaimRecord {
    const record = this.get(claimKey);
    if (!record) {
      throw new Error(`Missing Symphony claim after write: ${claimKey}`);
    }
    return record;
  }
}

export function symphonyClaimKey(workflowPath: string, workItemKey: string): string {
  return claimKeyFor(workflowPath, workItemKey);
}

function claimKeyFor(workflowPath: string, workItemKey: string): string {
  return `${sanitize(workflowPath)}:${sanitize(workItemKey)}`;
}

function claimCanBeReplaced(record: SymphonyClaimRecord, nowMs: number): boolean {
  if (record.status === "completed" || record.status === "cancelled") {
    return false;
  }
  if (record.status === "failed" || record.status === "released") {
    return true;
  }
  const expiresAt = record.expires_at ? Date.parse(record.expires_at) : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function fromRow(row: ClaimRow): SymphonyClaimRecord {
  return {
    ...row,
    session_id: row.session_id ?? undefined,
    expires_at: row.expires_at ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}

function sanitize(value: string): string {
  return value.replace(/\\/g, "/").replace(/[^A-Za-z0-9._/-]+/g, "_").replace(/\//g, ".").slice(0, 180);
}
