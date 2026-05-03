import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SwarmDatabase {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = ".swarm/swarm.db") {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        swarm_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        plan_json TEXT,
        final_output TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS envelopes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        swarm_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        intent TEXT NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blackboard_entries (
        entry_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        swarm_id TEXT NOT NULL,
        task_id TEXT,
        key TEXT NOT NULL,
        type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_by_json TEXT NOT NULL,
        visibility TEXT NOT NULL,
        version INTEGER NOT NULL,
        tags_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }
}
