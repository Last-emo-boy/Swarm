import { randomUUID } from "node:crypto";
import type { SwarmDatabase } from "./database.js";

export class ArtifactStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(input: { session_id: string; path: string; type: string; summary?: string }): void {
    this.database.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, session_id, path, type, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(`artifact_${randomUUID()}`, input.session_id, input.path, input.type, input.summary ?? null, new Date().toISOString());
  }
}
