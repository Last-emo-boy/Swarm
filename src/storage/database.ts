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
        subtask_id TEXT,
        attempt INTEGER,
        type TEXT NOT NULL,
        intent TEXT NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        trace_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        idempotency_key TEXT,
        reply_to TEXT,
        correlation_id TEXT,
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

      CREATE TABLE IF NOT EXISTS blackboard_locks (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        holder_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_states (
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        swarm_id TEXT NOT NULL,
        parent_task_id TEXT,
        subtask_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        required_capabilities_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        assigned_to_json TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, task_id)
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
    this.addColumnIfMissing("envelopes", "subtask_id", "TEXT");
    this.addColumnIfMissing("envelopes", "attempt", "INTEGER");
    this.addColumnIfMissing("envelopes", "trace_id", "TEXT");
    this.addColumnIfMissing("envelopes", "span_id", "TEXT");
    this.addColumnIfMissing("envelopes", "parent_span_id", "TEXT");
    this.addColumnIfMissing("envelopes", "idempotency_key", "TEXT");
    this.addColumnIfMissing("envelopes", "reply_to", "TEXT");
    this.addColumnIfMissing("envelopes", "correlation_id", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}
