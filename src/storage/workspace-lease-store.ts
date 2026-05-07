import { randomUUID } from "node:crypto";
import type { WorkspaceLease } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

type WorkspaceLeaseRow = Omit<WorkspaceLease, "scope" | "metadata"> & {
  scope_json: string;
  metadata_json: string;
};

export class WorkspaceLeaseStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(input: Omit<WorkspaceLease, "lease_id" | "created_at"> & { lease_id?: string; created_at?: string }): WorkspaceLease {
    const lease: WorkspaceLease = {
      lease_id: input.lease_id ?? `lease_${randomUUID()}`,
      session_id: input.session_id,
      workspace_root: input.workspace_root,
      workspace_path: input.workspace_path,
      scope: input.scope,
      write_boundary: input.write_boundary,
      metadata: input.metadata,
      created_at: input.created_at ?? new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT OR REPLACE INTO workspace_leases (
          lease_id, session_id, workspace_root, workspace_path, scope_json, write_boundary, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        lease.lease_id,
        lease.session_id,
        lease.workspace_root,
        lease.workspace_path,
        JSON.stringify(lease.scope),
        lease.write_boundary,
        JSON.stringify(lease.metadata),
        lease.created_at
      );
    return lease;
  }

  createForLocalSession(input: { session_id: string; workspace: string; parent_session_id?: string }): WorkspaceLease {
    const existing = this.getBySession(input.session_id);
    if (existing) {
      return existing;
    }
    return this.create({
      session_id: input.session_id,
      workspace_root: input.workspace,
      workspace_path: input.workspace,
      scope: [],
      write_boundary: "workspace",
      metadata: {
        kind: "local_workspace",
        parent_session_id: input.parent_session_id
      }
    });
  }

  get(leaseId: string): WorkspaceLease | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM workspace_leases WHERE lease_id = ?")
      .get(leaseId) as WorkspaceLeaseRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getBySession(sessionId: string): WorkspaceLease | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM workspace_leases WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as WorkspaceLeaseRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listBySession(sessionId: string, limit = 20): WorkspaceLease[] {
    const rows = this.database.db
      .prepare("SELECT * FROM workspace_leases WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit) as WorkspaceLeaseRow[];
    return rows.map(fromRow);
  }

  listRecent(limit = 50): WorkspaceLease[] {
    const rows = this.database.db
      .prepare("SELECT * FROM workspace_leases ORDER BY created_at DESC LIMIT ?")
      .all(limit) as WorkspaceLeaseRow[];
    return rows.map(fromRow);
  }
}

function fromRow(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    ...row,
    scope: JSON.parse(row.scope_json) as string[],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}
