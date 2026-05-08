import { randomUUID } from "node:crypto";
import type { SwarmDatabase } from "./database.js";

export type ArtifactRecord = {
  artifact_id: string;
  session_id: string;
  path: string;
  type: string;
  summary?: string;
  created_at: string;
};

export class ArtifactStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(input: { artifact_id?: string; session_id: string; path: string; type: string; summary?: string }): ArtifactRecord {
    const record: ArtifactRecord = {
      artifact_id: input.artifact_id ?? `artifact_${randomUUID()}`,
      session_id: input.session_id,
      path: input.path,
      type: input.type,
      summary: input.summary,
      created_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, session_id, path, type, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
          path = excluded.path,
          type = excluded.type,
          summary = excluded.summary`
      )
      .run(record.artifact_id, record.session_id, record.path, record.type, record.summary ?? null, record.created_at);
    return record;
  }

  update(input: { artifact_id: string; path?: string; type?: string; summary?: string }): ArtifactRecord {
    const existing = this.get(input.artifact_id);
    if (!existing) {
      throw new Error(`Artifact not found: ${input.artifact_id}`);
    }
    const next: ArtifactRecord = {
      ...existing,
      path: input.path ?? existing.path,
      type: input.type ?? existing.type,
      summary: input.summary ?? existing.summary
    };
    this.database.db
      .prepare("UPDATE artifacts SET path = ?, type = ?, summary = ? WHERE artifact_id = ?")
      .run(next.path, next.type, next.summary ?? null, next.artifact_id);
    return next;
  }

  get(artifactId: string): ArtifactRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM artifacts WHERE artifact_id = ?")
      .get(artifactId) as ArtifactRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(sessionId: string): ArtifactRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as ArtifactRow[];
    return rows.map(fromRow);
  }
}

type ArtifactRow = {
  artifact_id: string;
  session_id: string;
  path: string;
  type: string;
  summary?: string | null;
  created_at: string;
};

function fromRow(row: ArtifactRow): ArtifactRecord {
  return {
    artifact_id: row.artifact_id,
    session_id: row.session_id,
    path: row.path,
    type: row.type,
    summary: row.summary ?? undefined,
    created_at: row.created_at
  };
}
