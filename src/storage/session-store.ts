import type { GeneratedPlan, SwarmSession, WorkItem, WorkSessionOutcome } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export type SessionRow = {
  session_id: string;
  swarm_id: string;
  objective: string;
  status: SwarmSession["status"];
  source_json?: string | null;
  parent_session_id?: string | null;
  workspace_lease_id?: string | null;
  policy_json: string;
  participants_json: string;
  plan_json?: string | null;
  final_output?: string | null;
  final_outcome_json?: string | null;
  created_at: string;
  updated_at: string;
};

export class SessionStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(session: SwarmSession): void {
    this.database.db
      .prepare(
        `INSERT INTO sessions (
          session_id, swarm_id, objective, status, source_json, parent_session_id, workspace_lease_id,
          policy_json, participants_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.session_id,
        session.swarm_id,
        session.objective,
        session.status,
        session.source ? JSON.stringify(session.source) : null,
        session.parent_session_id ?? null,
        session.workspace_lease_id ?? null,
        JSON.stringify(session.policy),
        JSON.stringify(session.participants),
        session.created_at,
        session.updated_at
      );
  }

  updateMetadata(sessionId: string, input: { source?: WorkItem; parent_session_id?: string; workspace_lease_id?: string }): void {
    this.database.db
      .prepare(
        `UPDATE sessions
         SET source_json = COALESCE(?, source_json),
             parent_session_id = COALESCE(?, parent_session_id),
             workspace_lease_id = COALESCE(?, workspace_lease_id),
             updated_at = ?
         WHERE session_id = ?`
      )
      .run(
        input.source ? JSON.stringify(input.source) : null,
        input.parent_session_id ?? null,
        input.workspace_lease_id ?? null,
        new Date().toISOString(),
        sessionId
      );
  }

  createIfMissing(session: SwarmSession): void {
    if (this.get(session.session_id)) {
      return;
    }
    this.create(session);
  }

  setStatus(sessionId: string, status: SwarmSession["status"]): void {
    this.database.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?")
      .run(status, new Date().toISOString(), sessionId);
  }

  setPlan(sessionId: string, plan: GeneratedPlan): void {
    this.database.db
      .prepare("UPDATE sessions SET plan_json = ?, updated_at = ? WHERE session_id = ?")
      .run(JSON.stringify(plan), new Date().toISOString(), sessionId);
  }

  setFinalOutput(sessionId: string, finalOutput: string): void {
    this.database.db
      .prepare("UPDATE sessions SET final_output = ?, status = ?, updated_at = ? WHERE session_id = ?")
      .run(finalOutput, "completed", new Date().toISOString(), sessionId);
  }

  setFinalOutcome(sessionId: string, outcome: WorkSessionOutcome): void {
    this.database.db
      .prepare("UPDATE sessions SET final_outcome_json = ?, updated_at = ? WHERE session_id = ?")
      .run(JSON.stringify(outcome), new Date().toISOString(), sessionId);
  }

  get(sessionId: string): SessionRow | undefined {
    return this.database.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
  }

  listRecent(limit = 10): SessionRow[] {
    return this.database.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
  }

  listBySource(source: string, limit = 500): SessionRow[] {
    const rows = this.database.db
      .prepare("SELECT * FROM sessions WHERE source_json IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
      .all(Math.max(limit * 2, limit)) as SessionRow[];
    return rows
      .filter((row) => {
        try {
          const parsed = row.source_json ? JSON.parse(row.source_json) as { source?: unknown } : undefined;
          return parsed?.source === source;
        } catch {
          return false;
        }
      })
      .slice(0, limit);
  }

  listBySources(sources: string[], limit = 500): SessionRow[] {
    const sourceSet = new Set(sources);
    const rows = this.database.db
      .prepare("SELECT * FROM sessions WHERE source_json IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
      .all(Math.max(limit * 3, limit)) as SessionRow[];
    return rows
      .filter((row) => {
        try {
          const parsed = row.source_json ? JSON.parse(row.source_json) as { source?: unknown } : undefined;
          return typeof parsed?.source === "string" && sourceSet.has(parsed.source);
        } catch {
          return false;
        }
      })
      .slice(0, limit);
  }
}
