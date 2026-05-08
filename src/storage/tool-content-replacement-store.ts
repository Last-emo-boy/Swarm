import { randomUUID } from "node:crypto";
import type { SwarmDatabase } from "./database.js";

export type ToolContentReplacementScopeKind = "session" | "worker" | "child";

export type ToolContentReplacementRecord = {
  replacement_id: string;
  session_id: string;
  scope_kind: ToolContentReplacementScopeKind;
  scope_id: string;
  tool_result_id: string;
  action?: string;
  original_bytes: number;
  replacement_content: string;
  output_ref?: Record<string, unknown>;
  created_at: string;
};

type ToolContentReplacementRow = Omit<ToolContentReplacementRecord, "output_ref"> & {
  output_ref_json: string;
};

export class ToolContentReplacementStore {
  constructor(private readonly database: SwarmDatabase) {}

  upsert(input: {
    session_id: string;
    scope_kind: ToolContentReplacementScopeKind;
    scope_id: string;
    tool_result_id: string;
    action?: string;
    original_bytes: number;
    replacement_content: string;
    output_ref?: Record<string, unknown>;
    replacement_id?: string;
    created_at?: string;
  }): ToolContentReplacementRecord {
    const existing = this.get(input.scope_kind, input.scope_id, input.tool_result_id);
    const record: ToolContentReplacementRecord = {
      replacement_id: existing?.replacement_id ?? input.replacement_id ?? `replacement_${randomUUID()}`,
      session_id: input.session_id,
      scope_kind: input.scope_kind,
      scope_id: input.scope_id,
      tool_result_id: input.tool_result_id,
      action: input.action ?? existing?.action,
      original_bytes: input.original_bytes,
      replacement_content: input.replacement_content,
      output_ref: input.output_ref ?? existing?.output_ref,
      created_at: existing?.created_at ?? input.created_at ?? new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO tool_content_replacements (
          replacement_id, session_id, scope_kind, scope_id, tool_result_id,
          action, original_bytes, replacement_content, output_ref_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_kind, scope_id, tool_result_id) DO UPDATE SET
          session_id = excluded.session_id,
          action = excluded.action,
          original_bytes = excluded.original_bytes,
          replacement_content = excluded.replacement_content,
          output_ref_json = excluded.output_ref_json`
      )
      .run(
        record.replacement_id,
        record.session_id,
        record.scope_kind,
        record.scope_id,
        record.tool_result_id,
        record.action ?? null,
        record.original_bytes,
        record.replacement_content,
        JSON.stringify(record.output_ref ?? {}),
        record.created_at
      );
    return record;
  }

  get(
    scopeKind: ToolContentReplacementScopeKind,
    scopeId: string,
    toolResultId: string
  ): ToolContentReplacementRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM tool_content_replacements WHERE scope_kind = ? AND scope_id = ? AND tool_result_id = ?")
      .get(scopeKind, scopeId, toolResultId) as ToolContentReplacementRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listForScope(scopeKind: ToolContentReplacementScopeKind, scopeId: string, limit = 5_000): ToolContentReplacementRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM tool_content_replacements WHERE scope_kind = ? AND scope_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(scopeKind, scopeId, limit) as ToolContentReplacementRow[];
    return rows.map(fromRow);
  }
}

function fromRow(row: ToolContentReplacementRow): ToolContentReplacementRecord {
  const outputRef = parseJsonObject(row.output_ref_json);
  return {
    ...row,
    action: row.action ?? undefined,
    output_ref: Object.keys(outputRef).length ? outputRef : undefined
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
