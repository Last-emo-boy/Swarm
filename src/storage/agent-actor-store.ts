import type { AgentCard, AgentStatus, SwarmEnvelope } from "../protocol/types.js";
import type { WorkerRecord } from "./worker-state-store.js";
import type { SwarmDatabase } from "./database.js";

export type AgentActorKind = "main" | "router" | "worker" | "symphony" | "gateway" | "source_adapter" | "blackboard" | "builtin" | "unknown";
export type AgentActorStatus = AgentStatus | "draining";
export type AgentActorHeartbeatState = "fresh" | "stale" | "offline" | "blocked" | "missing";

export type AgentActorRecord = {
  actor_id: string;
  kind: AgentActorKind;
  name: string;
  role: string;
  status: AgentActorStatus;
  capabilities: string[];
  load: AgentCard["load"];
  reliability?: AgentCard["reliability"];
  current_task_id?: string;
  current_worker_id?: string;
  current_session_id?: string;
  current_ownership?: Record<string, unknown>;
  heartbeat_state: AgentActorHeartbeatState;
  last_heartbeat_at?: string;
  last_seen_at: string;
  registered_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type AgentMailboxMessage = {
  delivery_id: string;
  envelope_id: string;
  direction: "inbox" | "outbox";
  session_id: string;
  swarm_id: string;
  task_id?: string;
  type: SwarmEnvelope["type"];
  intent: string;
  status: string;
  from_agent_id?: string;
  recipient_agent_id?: string;
  queued_at: string;
  delivered_at?: string;
  acked_at?: string;
  failed_at?: string;
  error?: string;
};

export type AgentMailboxProjection = {
  actor_id: string;
  inbox_total: number;
  inbox_pending: number;
  inbox_delivered: number;
  inbox_acked: number;
  inbox_failed: number;
  outbox_total: number;
  outbox_pending: number;
  outbox_delivered: number;
  outbox_acked: number;
  outbox_failed: number;
  current_task_id?: string;
  current_worker_id?: string;
  current_session_id?: string;
};

export class AgentActorStore {
  constructor(private readonly database: SwarmDatabase) {}

  upsertFromCard(
    card: AgentCard,
    input: {
      kind?: AgentActorKind;
      current_task_id?: string;
      current_worker_id?: string;
      current_session_id?: string;
      current_ownership?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      now?: string;
    } = {}
  ): AgentActorRecord {
    return this.upsert({
      actor_id: card.agent_id,
      kind: input.kind ?? inferActorKind(card),
      name: card.name,
      role: card.role,
      status: card.status,
      capabilities: card.capabilities,
      load: card.load,
      reliability: card.reliability,
      current_task_id: input.current_task_id,
      current_worker_id: input.current_worker_id,
      current_session_id: input.current_session_id,
      current_ownership: input.current_ownership,
      metadata: { ...(card.metadata ?? {}), ...(input.metadata ?? {}) },
      last_heartbeat_at: input.now,
      now: input.now
    });
  }

  registerSystemActor(input: {
    actor_id: string;
    kind: AgentActorKind;
    name: string;
    role: string;
    capabilities?: string[];
    status?: AgentActorStatus;
    metadata?: Record<string, unknown>;
    now?: string;
  }): AgentActorRecord {
    return this.upsert({
      actor_id: input.actor_id,
      kind: input.kind,
      name: input.name,
      role: input.role,
      status: input.status ?? "idle",
      capabilities: input.capabilities ?? [],
      load: { running_tasks: 0, max_tasks: 1 },
      metadata: input.metadata,
      last_heartbeat_at: input.now,
      now: input.now
    });
  }

  projectWorker(worker: WorkerRecord, input: { now?: string } = {}): AgentActorRecord {
    return this.upsert(workerActorInput(worker, input.now));
  }

  heartbeat(
    actorId: string,
    input: {
      status?: AgentActorStatus;
      current_task_id?: string | null;
      current_worker_id?: string | null;
      current_session_id?: string | null;
      current_ownership?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
      now?: string;
    } = {}
  ): AgentActorRecord | undefined {
    const existing = this.get(actorId, { now: input.now });
    if (!existing) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const next = this.mergeRecord(existing, {
      status: input.status ?? existing.status,
      current_task_id: input.current_task_id === null ? undefined : input.current_task_id ?? existing.current_task_id,
      current_worker_id: input.current_worker_id === null ? undefined : input.current_worker_id ?? existing.current_worker_id,
      current_session_id: input.current_session_id === null ? undefined : input.current_session_id ?? existing.current_session_id,
      current_ownership: input.current_ownership === null ? undefined : input.current_ownership ?? existing.current_ownership,
      metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
      last_heartbeat_at: now,
      last_seen_at: now,
      updated_at: now
    });
    this.write(next);
    return this.get(actorId, { now });
  }

  updateStatus(actorId: string, status: AgentActorStatus, input: { now?: string; metadata?: Record<string, unknown> } = {}): AgentActorRecord | undefined {
    const existing = this.get(actorId, { now: input.now });
    if (!existing) {
      return undefined;
    }
    const now = input.now ?? new Date().toISOString();
    const next = this.mergeRecord(existing, {
      status,
      metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
      last_seen_at: now,
      updated_at: now
    });
    this.write(next);
    return this.get(actorId, { now });
  }

  markCurrentTask(
    actorId: string,
    input: {
      task_id?: string;
      session_id?: string;
      worker_id?: string;
      ownership?: Record<string, unknown>;
      now?: string;
    }
  ): AgentActorRecord | undefined {
    return this.heartbeat(actorId, {
      status: "busy",
      current_task_id: input.task_id ?? null,
      current_session_id: input.session_id ?? null,
      current_worker_id: input.worker_id,
      current_ownership: input.ownership ?? null,
      now: input.now
    });
  }

  clearCurrentTask(actorId: string, input: { status?: AgentActorStatus; now?: string } = {}): AgentActorRecord | undefined {
    return this.heartbeat(actorId, {
      status: input.status ?? "idle",
      current_task_id: null,
      current_worker_id: null,
      current_session_id: null,
      current_ownership: null,
      now: input.now
    });
  }

  get(
    actorId: string,
    options: {
      now?: string;
      staleAfterMs?: number;
      offlineAfterMs?: number;
    } = {}
  ): AgentActorRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM agent_actors WHERE actor_id = ?")
      .get(actorId) as AgentActorRow | undefined;
    return row ? fromRow(row, options) : undefined;
  }

  list(
    filter: {
      kind?: AgentActorKind;
      status?: AgentActorStatus;
      now?: string;
      staleAfterMs?: number;
      offlineAfterMs?: number;
    } = {}
  ): AgentActorRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.db
      .prepare(`SELECT * FROM agent_actors ${where} ORDER BY updated_at DESC, actor_id ASC`)
      .all(...params) as AgentActorRow[];
    return rows.map((row) => fromRow(row, filter));
  }

  mailbox(actorId: string): AgentMailboxProjection {
    const inbox = this.countMailbox(actorId, "inbox");
    const outbox = this.countMailbox(actorId, "outbox");
    const actor = this.get(actorId);
    return {
      actor_id: actorId,
      inbox_total: inbox.total,
      inbox_pending: inbox.pending,
      inbox_delivered: inbox.delivered,
      inbox_acked: inbox.acked,
      inbox_failed: inbox.failed,
      outbox_total: outbox.total,
      outbox_pending: outbox.pending,
      outbox_delivered: outbox.delivered,
      outbox_acked: outbox.acked,
      outbox_failed: outbox.failed,
      current_task_id: actor?.current_task_id,
      current_worker_id: actor?.current_worker_id,
      current_session_id: actor?.current_session_id
    };
  }

  listMailboxMessages(
    actorId: string,
    direction: "inbox" | "outbox",
    options: { limit?: number } = {}
  ): AgentMailboxMessage[] {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const predicate = direction === "inbox" ? "recipient_agent_id = ?" : "from_agent_id = ?";
    const rows = this.database.db
      .prepare(
        `SELECT delivery_id, envelope_id, session_id, swarm_id, task_id, type, intent, status,
                from_agent_id, recipient_agent_id, queued_at, delivered_at, acked_at, failed_at, error
         FROM envelope_deliveries
         WHERE ${predicate}
         ORDER BY queued_at ASC, delivery_id ASC
         LIMIT ?`
      )
      .all(actorId, limit) as AgentMailboxRow[];
    return rows.map((row) => ({
      delivery_id: row.delivery_id,
      envelope_id: row.envelope_id,
      direction,
      session_id: row.session_id,
      swarm_id: row.swarm_id,
      task_id: row.task_id ?? undefined,
      type: row.type,
      intent: row.intent,
      status: row.status,
      from_agent_id: row.from_agent_id ?? undefined,
      recipient_agent_id: row.recipient_agent_id ?? undefined,
      queued_at: row.queued_at,
      delivered_at: row.delivered_at ?? undefined,
      acked_at: row.acked_at ?? undefined,
      failed_at: row.failed_at ?? undefined,
      error: row.error ?? undefined
    }));
  }

  private upsert(input: AgentActorUpsertInput): AgentActorRecord {
    const now = input.now ?? new Date().toISOString();
    const existing = this.get(input.actor_id, { now });
    const record: AgentActorRecord = {
      actor_id: input.actor_id,
      kind: input.kind,
      name: input.name,
      role: input.role,
      status: input.status,
      capabilities: input.capabilities,
      load: input.load,
      reliability: input.reliability,
      current_task_id: currentProjectionValue(input.current_task_id, existing?.current_task_id),
      current_worker_id: currentProjectionValue(input.current_worker_id, existing?.current_worker_id),
      current_session_id: currentProjectionValue(input.current_session_id, existing?.current_session_id),
      current_ownership: currentProjectionValue(input.current_ownership, existing?.current_ownership),
      heartbeat_state: "fresh",
      last_heartbeat_at: input.last_heartbeat_at ?? existing?.last_heartbeat_at ?? now,
      last_seen_at: now,
      registered_at: existing?.registered_at ?? now,
      updated_at: now,
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) }
    };
    this.write(record);
    return this.get(record.actor_id, { now }) ?? record;
  }

  private mergeRecord(existing: AgentActorRecord, patch: Partial<AgentActorRecord>): AgentActorRecord {
    return {
      ...existing,
      ...patch,
      capabilities: patch.capabilities ?? existing.capabilities,
      load: patch.load ?? existing.load,
      metadata: patch.metadata ?? existing.metadata
    };
  }

  private write(record: AgentActorRecord): void {
    this.database.db
      .prepare(
        `INSERT INTO agent_actors (
          actor_id, kind, name, role, status, capabilities_json, load_json, reliability_json,
          current_task_id, current_worker_id, current_session_id, current_ownership_json,
          heartbeat_state, last_heartbeat_at, last_seen_at, registered_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(actor_id) DO UPDATE SET
          kind = excluded.kind,
          name = excluded.name,
          role = excluded.role,
          status = excluded.status,
          capabilities_json = excluded.capabilities_json,
          load_json = excluded.load_json,
          reliability_json = excluded.reliability_json,
          current_task_id = excluded.current_task_id,
          current_worker_id = excluded.current_worker_id,
          current_session_id = excluded.current_session_id,
          current_ownership_json = excluded.current_ownership_json,
          heartbeat_state = excluded.heartbeat_state,
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json`
      )
      .run(
        record.actor_id,
        record.kind,
        record.name,
        record.role,
        record.status,
        JSON.stringify(record.capabilities),
        JSON.stringify(record.load),
        record.reliability ? JSON.stringify(record.reliability) : null,
        record.current_task_id ?? null,
        record.current_worker_id ?? null,
        record.current_session_id ?? null,
        record.current_ownership ? JSON.stringify(record.current_ownership) : null,
        classifyHeartbeat(record),
        record.last_heartbeat_at ?? null,
        record.last_seen_at,
        record.registered_at,
        record.updated_at,
        JSON.stringify(record.metadata)
      );
  }

  private countMailbox(actorId: string, direction: "inbox" | "outbox"): MailboxCounts {
    const predicate = direction === "inbox" ? "recipient_agent_id = ?" : "from_agent_id = ?";
    const rows = this.database.db
      .prepare(`SELECT status, COUNT(*) AS count FROM envelope_deliveries WHERE ${predicate} GROUP BY status`)
      .all(actorId) as Array<{ status: string; count: number }>;
    const counts: MailboxCounts = { total: 0, pending: 0, delivered: 0, acked: 0, failed: 0 };
    for (const row of rows) {
      counts.total += row.count;
      if (row.status === "queued") counts.pending += row.count;
      if (row.status === "delivered") counts.delivered += row.count;
      if (row.status === "acked") counts.acked += row.count;
      if (row.status === "failed" || row.status === "expired") counts.failed += row.count;
    }
    return counts;
  }
}

type AgentActorUpsertInput = {
  actor_id: string;
  kind: AgentActorKind;
  name: string;
  role: string;
  status: AgentActorStatus;
  capabilities: string[];
  load: AgentCard["load"];
  reliability?: AgentCard["reliability"];
  current_task_id?: string | null;
  current_worker_id?: string | null;
  current_session_id?: string | null;
  current_ownership?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  last_heartbeat_at?: string;
  now?: string;
};

type AgentActorRow = {
  actor_id: string;
  kind: AgentActorKind;
  name: string;
  role: string;
  status: AgentActorStatus;
  capabilities_json: string;
  load_json: string;
  reliability_json?: string | null;
  current_task_id?: string | null;
  current_worker_id?: string | null;
  current_session_id?: string | null;
  current_ownership_json?: string | null;
  heartbeat_state: AgentActorHeartbeatState;
  last_heartbeat_at?: string | null;
  last_seen_at: string;
  registered_at: string;
  updated_at: string;
  metadata_json: string;
};

type AgentMailboxRow = {
  delivery_id: string;
  envelope_id: string;
  session_id: string;
  swarm_id: string;
  task_id?: string | null;
  type: SwarmEnvelope["type"];
  intent: string;
  status: string;
  from_agent_id?: string | null;
  recipient_agent_id?: string | null;
  queued_at: string;
  delivered_at?: string | null;
  acked_at?: string | null;
  failed_at?: string | null;
  error?: string | null;
};

type MailboxCounts = {
  total: number;
  pending: number;
  delivered: number;
  acked: number;
  failed: number;
};

function fromRow(
  row: AgentActorRow,
  options: {
    now?: string;
    staleAfterMs?: number;
    offlineAfterMs?: number;
  } = {}
): AgentActorRecord {
  const record: AgentActorRecord = {
    actor_id: row.actor_id,
    kind: row.kind,
    name: row.name,
    role: row.role,
    status: row.status,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    load: JSON.parse(row.load_json) as AgentCard["load"],
    reliability: row.reliability_json ? JSON.parse(row.reliability_json) as AgentCard["reliability"] : undefined,
    current_task_id: row.current_task_id ?? undefined,
    current_worker_id: row.current_worker_id ?? undefined,
    current_session_id: row.current_session_id ?? undefined,
    current_ownership: row.current_ownership_json ? JSON.parse(row.current_ownership_json) as Record<string, unknown> : undefined,
    heartbeat_state: row.heartbeat_state,
    last_heartbeat_at: row.last_heartbeat_at ?? undefined,
    last_seen_at: row.last_seen_at,
    registered_at: row.registered_at,
    updated_at: row.updated_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
  return {
    ...record,
    heartbeat_state: classifyHeartbeat(record, options)
  };
}

function workerActorInput(worker: WorkerRecord, now?: string): AgentActorUpsertInput {
  const timestamp = now ?? worker.updated_at;
  const workerStatus = workerActorStatus(worker.status);
  const active = worker.status === "pending" || worker.status === "running";
  return {
    actor_id: `worker:${worker.worker_id}`,
    kind: "worker",
    name: worker.display_name,
    role: worker.role_title ?? worker.agent_spec_id ?? worker.capability,
    status: workerStatus,
    capabilities: uniqueStrings([worker.capability, worker.agent_spec_id]),
    load: {
      running_tasks: worker.status === "pending" || worker.status === "running" ? 1 : 0,
      max_tasks: 1
    },
    current_task_id: active ? worker.worker_id : null,
    current_worker_id: active ? worker.worker_id : null,
    current_session_id: active ? worker.worker_session_id ?? worker.parent_session_id : null,
    current_ownership: active
      ? {
          kind: "worker",
          worker_id: worker.worker_id,
          parent_session_id: worker.parent_session_id,
          worker_session_id: worker.worker_session_id,
          handoff_id: worker.handoff_id,
          invocation_mode: worker.invocation_mode,
          write_policy: worker.task_packet?.write_policy,
          file_scope: worker.file_scope,
          requested_by: worker.requested_by,
          blocked_reason: worker.blocked_reason
        }
      : null,
    metadata: {
      worker_status: worker.status,
      objective: worker.objective,
      blocked_reason: worker.blocked_reason,
      output_contract: worker.output_contract
    },
    last_heartbeat_at: timestamp,
    now: timestamp
  };
}

function workerActorStatus(status: WorkerRecord["status"]): AgentActorStatus {
  if (status === "failed") return "degraded";
  if (status === "completed" || status === "stopped") return "offline";
  return "busy";
}

function currentProjectionValue<T>(value: T | null | undefined, fallback: T | undefined): T | undefined {
  if (value === null) {
    return undefined;
  }
  return value ?? fallback;
}

function inferActorKind(card: AgentCard): AgentActorKind {
  if (card.agent_id === "main_swarm") return "main";
  if (card.agent_id === "router") return "router";
  if (card.agent_id.startsWith("worker:") || card.agent_id.startsWith("worker_")) return "worker";
  if (card.agent_id.startsWith("symphony")) return "symphony";
  if (card.agent_id.startsWith("gateway")) return "gateway";
  if (card.agent_id.startsWith("source.") || card.role === "source_adapter") return "source_adapter";
  if (card.agent_id.includes("blackboard")) return "blackboard";
  return "builtin";
}

function classifyHeartbeat(
  record: Pick<AgentActorRecord, "status" | "last_heartbeat_at" | "last_seen_at" | "metadata">,
  options: {
    now?: string;
    staleAfterMs?: number;
    offlineAfterMs?: number;
  } = {}
): AgentActorHeartbeatState {
  if (record.status === "offline") {
    return "offline";
  }
  if (typeof record.metadata.blocked_reason === "string" && record.metadata.blocked_reason.trim()) {
    return "blocked";
  }
  if (!record.last_heartbeat_at) {
    return "missing";
  }
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const heartbeatMs = Date.parse(record.last_heartbeat_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(heartbeatMs)) {
    return "missing";
  }
  const ageMs = Math.max(0, nowMs - heartbeatMs);
  const offlineAfterMs = options.offlineAfterMs ?? 30 * 60 * 1000;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  if (ageMs > offlineAfterMs) {
    return "offline";
  }
  if (ageMs > staleAfterMs || record.status === "degraded") {
    return "stale";
  }
  return "fresh";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}
