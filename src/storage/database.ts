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
        source_json TEXT,
        parent_session_id TEXT,
        workspace_lease_id TEXT,
        policy_json TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        plan_json TEXT,
        final_output TEXT,
        final_outcome_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_leases (
        lease_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        write_boundary TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_attempts (
        attempt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        runner_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        title TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_event_at TEXT NOT NULL,
        workspace_path TEXT,
        error_code TEXT,
        recovery_suggestion TEXT,
        metadata_json TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS task_graph_edges (
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, task_id, depends_on_task_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        session_id TEXT,
        task_id TEXT,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT NOT NULL,
        risk TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        challenge_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        audit_id TEXT PRIMARY KEY,
        session_id TEXT,
        task_id TEXT,
        trace_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        unit TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_states (
        worker_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        worker_session_id TEXT,
        agent_spec_id TEXT,
        invocation_mode TEXT,
        handoff_id TEXT,
        capability TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        file_scope_json TEXT NOT NULL,
        tool_budget_json TEXT NOT NULL,
        persona_snapshot_json TEXT,
        task_packet_json TEXT,
        output_contract_json TEXT,
        spawn_reason TEXT,
        requested_by TEXT,
        blocked_reason TEXT,
        last_review_json TEXT,
        last_verification_json TEXT,
        change_refs_json TEXT,
        last_result TEXT,
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoff_sessions (
        handoff_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        target_agent_spec_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        task_packet_json TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symphony_claims (
        claim_key TEXT PRIMARY KEY,
        work_item_key TEXT NOT NULL,
        source_identity TEXT NOT NULL,
        workflow_path TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_symphony_claims_work_item
        ON symphony_claims(work_item_key, workflow_path);
    `);
    this.addColumnIfMissing("envelopes", "subtask_id", "TEXT");
    this.addColumnIfMissing("envelopes", "attempt", "INTEGER");
    this.addColumnIfMissing("envelopes", "trace_id", "TEXT");
    this.addColumnIfMissing("envelopes", "span_id", "TEXT");
    this.addColumnIfMissing("envelopes", "parent_span_id", "TEXT");
    this.addColumnIfMissing("envelopes", "idempotency_key", "TEXT");
    this.addColumnIfMissing("envelopes", "reply_to", "TEXT");
    this.addColumnIfMissing("envelopes", "correlation_id", "TEXT");
    this.addColumnIfMissing("sessions", "source_json", "TEXT");
    this.addColumnIfMissing("sessions", "parent_session_id", "TEXT");
    this.addColumnIfMissing("sessions", "workspace_lease_id", "TEXT");
    this.addColumnIfMissing("sessions", "final_outcome_json", "TEXT");
    this.addColumnIfMissing("worker_states", "agent_spec_id", "TEXT");
    this.addColumnIfMissing("worker_states", "invocation_mode", "TEXT");
    this.addColumnIfMissing("worker_states", "handoff_id", "TEXT");
    this.addColumnIfMissing("worker_states", "persona_snapshot_json", "TEXT");
    this.addColumnIfMissing("worker_states", "task_packet_json", "TEXT");
    this.addColumnIfMissing("worker_states", "output_contract_json", "TEXT");
    this.addColumnIfMissing("worker_states", "spawn_reason", "TEXT");
    this.addColumnIfMissing("worker_states", "requested_by", "TEXT");
    this.addColumnIfMissing("worker_states", "blocked_reason", "TEXT");
    this.addColumnIfMissing("worker_states", "last_review_json", "TEXT");
    this.addColumnIfMissing("worker_states", "last_verification_json", "TEXT");
    this.addColumnIfMissing("worker_states", "change_refs_json", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}
