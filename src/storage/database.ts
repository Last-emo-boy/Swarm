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
    // Wait briefly for a contended write lock instead of failing immediately
    // with SQLITE_BUSY ("database is locked"); WAL allows concurrent readers
    // but writers still serialize, so a short busy timeout absorbs the transient
    // contention seen under concurrent gateway/TUI access and parallel tests.
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
        auth_json TEXT,
        routing_json TEXT,
        priority TEXT,
        ttl_ms INTEGER,
        trace_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        idempotency_key TEXT,
        reply_to TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS envelope_deliveries (
        delivery_id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        swarm_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        intent TEXT NOT NULL,
        from_agent_id TEXT,
        recipient_key TEXT NOT NULL,
        recipient_agent_id TEXT,
        recipient_role TEXT,
        recipient_capability TEXT,
        status TEXT NOT NULL,
        correlation_id TEXT,
        reply_to TEXT,
        idempotency_key TEXT,
        attempt INTEGER,
        queued_at TEXT NOT NULL,
        delivered_at TEXT,
        acked_at TEXT,
        failed_at TEXT,
        expired_at TEXT,
        superseded_at TEXT,
        error TEXT,
        last_response_envelope_id TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_actors (
        actor_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        load_json TEXT NOT NULL,
        reliability_json TEXT,
        current_task_id TEXT,
        current_worker_id TEXT,
        current_session_id TEXT,
        current_ownership_json TEXT,
        heartbeat_state TEXT NOT NULL,
        last_heartbeat_at TEXT,
        last_seen_at TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_memory_entries (
        memory_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        trusted_tools_json TEXT NOT NULL,
        source_envelope_id TEXT NOT NULL,
        correlation_id TEXT,
        retention_policy TEXT NOT NULL,
        pinned INTEGER NOT NULL,
        frozen INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_memory_state (
        actor_id TEXT PRIMARY KEY,
        profile_summary TEXT NOT NULL,
        cache_stable_summary TEXT NOT NULL,
        cache_stable_summary_hash TEXT NOT NULL,
        frozen INTEGER NOT NULL,
        cleared_at TEXT,
        last_learned_at TEXT,
        last_compacted_at TEXT,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
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
        metadata_json TEXT,
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

      CREATE TABLE IF NOT EXISTS blackboard_events (
        event_id TEXT PRIMARY KEY,
        swarm_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        source_envelope_id TEXT,
        correlation_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blackboard_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        subscriber_json TEXT NOT NULL,
        filter_json TEXT NOT NULL,
        source_envelope_id TEXT,
        correlation_id TEXT,
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
        capability TEXT,
        write_policy TEXT,
        file_scope_json TEXT,
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

      CREATE TABLE IF NOT EXISTS session_context_entries (
        entry_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_compactions (
        compaction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        from_entry_id TEXT,
        to_entry_id TEXT,
        pre_tokens INTEGER NOT NULL,
        post_tokens INTEGER NOT NULL,
        kept_entries_json TEXT NOT NULL,
        strategy TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_content_replacements (
        replacement_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        tool_result_id TEXT NOT NULL,
        action TEXT,
        original_bytes INTEGER NOT NULL,
        replacement_content TEXT NOT NULL,
        output_ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scope_kind, scope_id, tool_result_id)
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
        display_name TEXT,
        role_title TEXT,
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
        protocol_status TEXT NOT NULL DEFAULT 'requested',
        requester_agent_id TEXT,
        owner_agent_id TEXT,
        scope_json TEXT,
        lease_ttl_ms INTEGER,
        lease_expires_at TEXT,
        deadline_at TEXT,
        accepted_at TEXT,
        last_checkpoint_json TEXT,
        return_contract_json TEXT,
        conflict_reason TEXT,
        request_envelope_id TEXT,
        accept_envelope_id TEXT,
        return_envelope_id TEXT,
        take_back_envelope_id TEXT,
        last_envelope_id TEXT,
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

      CREATE INDEX IF NOT EXISTS idx_envelope_deliveries_session
        ON envelope_deliveries(session_id, queued_at);
      CREATE INDEX IF NOT EXISTS idx_envelope_deliveries_envelope
        ON envelope_deliveries(envelope_id);
      CREATE INDEX IF NOT EXISTS idx_envelope_deliveries_status
        ON envelope_deliveries(status, queued_at);
      CREATE INDEX IF NOT EXISTS idx_envelope_deliveries_agent
        ON envelope_deliveries(recipient_agent_id, from_agent_id);

      CREATE INDEX IF NOT EXISTS idx_agent_actors_kind_status
        ON agent_actors(kind, status);
      CREATE INDEX IF NOT EXISTS idx_agent_actors_heartbeat
        ON agent_actors(heartbeat_state, last_heartbeat_at);
      CREATE INDEX IF NOT EXISTS idx_agent_actors_current
        ON agent_actors(current_session_id, current_task_id, current_worker_id);

      CREATE INDEX IF NOT EXISTS idx_agent_memory_entries_actor_created
        ON agent_memory_entries(actor_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_entries_source
        ON agent_memory_entries(source_envelope_id);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_entries_session
        ON agent_memory_entries(session_id, task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_state_updated
        ON agent_memory_state(updated_at);

      CREATE INDEX IF NOT EXISTS idx_blackboard_entries_session_key
        ON blackboard_entries(session_id, key, created_at);
      CREATE INDEX IF NOT EXISTS idx_blackboard_events_session_key
        ON blackboard_events(session_id, key, created_at);
      CREATE INDEX IF NOT EXISTS idx_blackboard_events_source
        ON blackboard_events(source_envelope_id);
      CREATE INDEX IF NOT EXISTS idx_blackboard_subscriptions_session
        ON blackboard_subscriptions(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_session_context_entries_session
        ON session_context_entries(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_compactions_session
        ON session_compactions(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_content_replacements_scope
        ON tool_content_replacements(scope_kind, scope_id, created_at);
    `);
    this.addColumnIfMissing("envelopes", "subtask_id", "TEXT");
    this.addColumnIfMissing("envelopes", "attempt", "INTEGER");
    this.addColumnIfMissing("envelopes", "trace_id", "TEXT");
    this.addColumnIfMissing("envelopes", "span_id", "TEXT");
    this.addColumnIfMissing("envelopes", "parent_span_id", "TEXT");
    this.addColumnIfMissing("envelopes", "auth_json", "TEXT");
    this.addColumnIfMissing("envelopes", "routing_json", "TEXT");
    this.addColumnIfMissing("envelopes", "priority", "TEXT");
    this.addColumnIfMissing("envelopes", "ttl_ms", "INTEGER");
    this.addColumnIfMissing("envelopes", "idempotency_key", "TEXT");
    this.addColumnIfMissing("envelopes", "reply_to", "TEXT");
    this.addColumnIfMissing("envelopes", "correlation_id", "TEXT");
    this.addColumnIfMissing("blackboard_entries", "metadata_json", "TEXT");
    this.addColumnIfMissing("sessions", "source_json", "TEXT");
    this.addColumnIfMissing("sessions", "parent_session_id", "TEXT");
    this.addColumnIfMissing("sessions", "workspace_lease_id", "TEXT");
    this.addColumnIfMissing("sessions", "final_outcome_json", "TEXT");
    this.addColumnIfMissing("task_states", "capability", "TEXT");
    this.addColumnIfMissing("task_states", "write_policy", "TEXT");
    this.addColumnIfMissing("task_states", "file_scope_json", "TEXT");
    this.addColumnIfMissing("worker_states", "display_name", "TEXT");
    this.addColumnIfMissing("worker_states", "role_title", "TEXT");
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
    this.addColumnIfMissing("handoff_sessions", "protocol_status", "TEXT NOT NULL DEFAULT 'requested'");
    this.addColumnIfMissing("handoff_sessions", "requester_agent_id", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "owner_agent_id", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "scope_json", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "lease_ttl_ms", "INTEGER");
    this.addColumnIfMissing("handoff_sessions", "lease_expires_at", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "deadline_at", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "accepted_at", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "last_checkpoint_json", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "return_contract_json", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "conflict_reason", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "request_envelope_id", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "accept_envelope_id", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "return_envelope_id", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "take_back_envelope_id", "TEXT");
    this.addColumnIfMissing("handoff_sessions", "last_envelope_id", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}
