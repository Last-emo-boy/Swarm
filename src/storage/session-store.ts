import type { GeneratedPlan, SwarmSession } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export type SessionRow = {
  session_id: string;
  swarm_id: string;
  objective: string;
  status: SwarmSession["status"];
  policy_json: string;
  participants_json: string;
  plan_json?: string | null;
  final_output?: string | null;
  created_at: string;
  updated_at: string;
};

export class SessionStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(session: SwarmSession): void {
    this.database.db
      .prepare(
        `INSERT INTO sessions (
          session_id, swarm_id, objective, status, policy_json, participants_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.session_id,
        session.swarm_id,
        session.objective,
        session.status,
        JSON.stringify(session.policy),
        JSON.stringify(session.participants),
        session.created_at,
        session.updated_at
      );
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
}
