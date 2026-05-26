import type { AgentTaskPacket } from "../runtime/agent-specs.js";
import type { HandoffProtocolStatus } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export type HandoffStatus = "active" | "returned" | "taken_back" | "failed";

export type HandoffSessionRecord = {
  handoff_id: string;
  worker_id: string;
  parent_session_id: string;
  source_agent: string;
  target_agent_spec_id: string;
  reason: string;
  status: HandoffStatus;
  protocol_status?: HandoffProtocolStatus;
  requester_agent_id?: string;
  owner_agent_id?: string;
  scope?: string[];
  lease_ttl_ms?: number;
  lease_expires_at?: string;
  deadline_at?: string;
  accepted_at?: string;
  last_checkpoint?: unknown;
  return_contract?: unknown;
  conflict_reason?: string;
  request_envelope_id?: string;
  accept_envelope_id?: string;
  return_envelope_id?: string;
  take_back_envelope_id?: string;
  last_envelope_id?: string;
  task_packet: AgentTaskPacket;
  result?: string;
  created_at: string;
  updated_at: string;
};

type HandoffRow = {
  handoff_id: string;
  worker_id: string;
  parent_session_id: string;
  source_agent: string;
  target_agent_spec_id: string;
  reason: string;
  status: HandoffStatus;
  protocol_status?: HandoffProtocolStatus | null;
  requester_agent_id?: string | null;
  owner_agent_id?: string | null;
  scope_json?: string | null;
  lease_ttl_ms?: number | null;
  lease_expires_at?: string | null;
  deadline_at?: string | null;
  accepted_at?: string | null;
  last_checkpoint_json?: string | null;
  return_contract_json?: string | null;
  conflict_reason?: string | null;
  request_envelope_id?: string | null;
  accept_envelope_id?: string | null;
  return_envelope_id?: string | null;
  take_back_envelope_id?: string | null;
  last_envelope_id?: string | null;
  task_packet_json: string;
  result?: string | null;
  created_at: string;
  updated_at: string;
};

const DEFAULT_HANDOFF_LEASE_TTL_MS = 5 * 60 * 1000;

export class HandoffStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(input: {
    handoff_id: string;
    worker_id: string;
    parent_session_id: string;
    source_agent: string;
    target_agent_spec_id: string;
    reason: string;
    task_packet: AgentTaskPacket;
    requester_agent_id?: string;
    owner_agent_id?: string;
    scope?: string[];
    lease_ttl_ms?: number;
    lease_expires_at?: string;
    deadline_at?: string;
    request_envelope_id?: string;
  }): HandoffSessionRecord {
    const existing = this.get(input.handoff_id);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const leaseTtlMs = input.lease_ttl_ms ?? DEFAULT_HANDOFF_LEASE_TTL_MS;
    const record: HandoffSessionRecord = {
      handoff_id: input.handoff_id,
      worker_id: input.worker_id,
      parent_session_id: input.parent_session_id,
      source_agent: input.source_agent,
      target_agent_spec_id: input.target_agent_spec_id,
      reason: input.reason,
      status: "active",
      protocol_status: "requested",
      requester_agent_id: input.requester_agent_id ?? input.source_agent,
      owner_agent_id: input.owner_agent_id,
      scope: input.scope ?? input.task_packet.file_scope,
      lease_ttl_ms: leaseTtlMs,
      lease_expires_at: input.lease_expires_at ?? addMsIso(now, leaseTtlMs),
      deadline_at: input.deadline_at,
      request_envelope_id: input.request_envelope_id,
      last_envelope_id: input.request_envelope_id,
      task_packet: input.task_packet,
      created_at: now,
      updated_at: now
    };
    this.database.db
      .prepare(
        `INSERT INTO handoff_sessions (
          handoff_id, worker_id, parent_session_id, source_agent, target_agent_spec_id,
          reason, status, protocol_status, requester_agent_id, owner_agent_id, scope_json,
          lease_ttl_ms, lease_expires_at, deadline_at, accepted_at, last_checkpoint_json,
          return_contract_json, conflict_reason, request_envelope_id, accept_envelope_id,
          return_envelope_id, take_back_envelope_id, last_envelope_id, task_packet_json,
          result, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.handoff_id,
        record.worker_id,
        record.parent_session_id,
        record.source_agent,
        record.target_agent_spec_id,
        record.reason,
        record.status,
        record.protocol_status ?? "requested",
        record.requester_agent_id ?? null,
        record.owner_agent_id ?? null,
        JSON.stringify(record.scope ?? record.task_packet.file_scope),
        record.lease_ttl_ms ?? null,
        record.lease_expires_at ?? null,
        record.deadline_at ?? null,
        record.accepted_at ?? null,
        record.last_checkpoint === undefined ? null : JSON.stringify(record.last_checkpoint),
        record.return_contract === undefined ? null : JSON.stringify(record.return_contract),
        record.conflict_reason ?? null,
        record.request_envelope_id ?? null,
        record.accept_envelope_id ?? null,
        record.return_envelope_id ?? null,
        record.take_back_envelope_id ?? null,
        record.last_envelope_id ?? null,
        JSON.stringify(record.task_packet),
        record.result ?? null,
        record.created_at,
        record.updated_at
      );
    return record;
  }

  markAccepted(input: {
    handoff_id: string;
    owner_agent_id: string;
    envelope_id?: string;
    accepted_at?: string;
    lease_ttl_ms?: number;
    lease_expires_at?: string;
  }): HandoffSessionRecord {
    const existing = this.require(input.handoff_id);
    const acceptedAt = input.accepted_at ?? new Date().toISOString();
    const ttlMs = input.lease_ttl_ms ?? existing.lease_ttl_ms ?? DEFAULT_HANDOFF_LEASE_TTL_MS;
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      protocol_status: "accepted",
      status: "active",
      owner_agent_id: input.owner_agent_id,
      accepted_at: acceptedAt,
      lease_ttl_ms: ttlMs,
      lease_expires_at: input.lease_expires_at ?? addMsIso(acceptedAt, ttlMs),
      accept_envelope_id: input.envelope_id,
      last_envelope_id: input.envelope_id
    });
  }

  markRejected(input: { handoff_id: string; reason: string; envelope_id?: string }): HandoffSessionRecord {
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: "failed",
      protocol_status: "rejected",
      result: input.reason,
      conflict_reason: input.reason,
      last_envelope_id: input.envelope_id
    });
  }

  renew(input: {
    handoff_id: string;
    owner_agent_id?: string;
    envelope_id?: string;
    lease_ttl_ms?: number;
    lease_expires_at?: string;
  }): HandoffSessionRecord {
    const existing = this.require(input.handoff_id);
    const now = new Date().toISOString();
    const ttlMs = input.lease_ttl_ms ?? existing.lease_ttl_ms ?? DEFAULT_HANDOFF_LEASE_TTL_MS;
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: "active",
      protocol_status: "renewed",
      owner_agent_id: input.owner_agent_id ?? existing.owner_agent_id,
      lease_ttl_ms: ttlMs,
      lease_expires_at: input.lease_expires_at ?? addMsIso(now, ttlMs),
      last_envelope_id: input.envelope_id
    });
  }

  checkpoint(input: {
    handoff_id: string;
    checkpoint: unknown;
    owner_agent_id?: string;
    envelope_id?: string;
    lease_ttl_ms?: number;
    lease_expires_at?: string;
  }): HandoffSessionRecord {
    const existing = this.require(input.handoff_id);
    const now = new Date().toISOString();
    const ttlMs = input.lease_ttl_ms ?? existing.lease_ttl_ms ?? DEFAULT_HANDOFF_LEASE_TTL_MS;
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: "active",
      protocol_status: "checkpointed",
      owner_agent_id: input.owner_agent_id ?? existing.owner_agent_id,
      lease_ttl_ms: ttlMs,
      lease_expires_at: input.lease_expires_at ?? addMsIso(now, ttlMs),
      last_checkpoint: input.checkpoint,
      last_envelope_id: input.envelope_id
    });
  }

  markConflict(input: { handoff_id: string; reason: string; envelope_id?: string }): HandoffSessionRecord {
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: "active",
      protocol_status: "conflict",
      conflict_reason: input.reason,
      last_envelope_id: input.envelope_id
    });
  }

  markTimeout(input: { handoff_id: string; reason: string; envelope_id?: string }): HandoffSessionRecord {
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: "active",
      protocol_status: "timeout",
      conflict_reason: input.reason,
      last_envelope_id: input.envelope_id
    });
  }

  markStale(input: { handoff_id: string; reason: string; envelope_id?: string }): HandoffSessionRecord {
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: "active",
      protocol_status: "stale",
      conflict_reason: input.reason,
      last_envelope_id: input.envelope_id
    });
  }

  finish(input: {
    handoff_id: string;
    status: HandoffStatus;
    result?: string;
    envelope_id?: string;
    return_contract?: unknown;
  }): HandoffSessionRecord {
    const existing = this.get(input.handoff_id);
    if (!existing) {
      throw new Error(`Unknown handoff: ${input.handoff_id}`);
    }
    return this.updateProtocol({
      handoff_id: input.handoff_id,
      status: input.status,
      protocol_status: legacyProtocolStatus(input.status),
      result: input.result ?? existing.result,
      return_contract: input.return_contract,
      return_envelope_id: input.status === "returned" || input.status === "failed" ? input.envelope_id : undefined,
      last_envelope_id: input.envelope_id
    });
  }

  takeBack(
    handoffId: string,
    input: {
      requester_agent_id?: string;
      reason?: string;
      envelope_id?: string;
    } = {}
  ): HandoffSessionRecord {
    return this.updateProtocol({
      handoff_id: handoffId,
      status: "taken_back",
      protocol_status: "taken_back",
      requester_agent_id: input.requester_agent_id,
      owner_agent_id: input.requester_agent_id ?? "main_swarm",
      result: input.reason ?? "Taken back by main Swarm.",
      take_back_envelope_id: input.envelope_id,
      last_envelope_id: input.envelope_id
    });
  }

  get(handoffId: string): HandoffSessionRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM handoff_sessions WHERE handoff_id = ?")
      .get(handoffId) as HandoffRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listRecent(limit = 20): HandoffSessionRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM handoff_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as HandoffRow[];
    return rows.map(fromRow);
  }

  listByParent(parentSessionId: string): HandoffSessionRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM handoff_sessions WHERE parent_session_id = ? ORDER BY updated_at DESC")
      .all(parentSessionId) as HandoffRow[];
    return rows.map(fromRow);
  }

  private require(handoffId: string): HandoffSessionRecord {
    const existing = this.get(handoffId);
    if (!existing) {
      throw new Error(`Unknown handoff: ${handoffId}`);
    }
    return existing;
  }

  private updateProtocol(input: {
    handoff_id: string;
    status?: HandoffStatus;
    protocol_status?: HandoffProtocolStatus;
    requester_agent_id?: string;
    owner_agent_id?: string;
    scope?: string[];
    lease_ttl_ms?: number;
    lease_expires_at?: string;
    deadline_at?: string;
    accepted_at?: string;
    last_checkpoint?: unknown;
    return_contract?: unknown;
    conflict_reason?: string;
    request_envelope_id?: string;
    accept_envelope_id?: string;
    return_envelope_id?: string;
    take_back_envelope_id?: string;
    last_envelope_id?: string;
    result?: string;
  }): HandoffSessionRecord {
    const existing = this.require(input.handoff_id);
    const next: HandoffSessionRecord = {
      ...existing,
      status: input.status ?? existing.status,
      protocol_status: input.protocol_status ?? existing.protocol_status ?? legacyProtocolStatus(existing.status),
      requester_agent_id: input.requester_agent_id ?? existing.requester_agent_id,
      owner_agent_id: input.owner_agent_id ?? existing.owner_agent_id,
      scope: input.scope ?? existing.scope ?? existing.task_packet.file_scope,
      lease_ttl_ms: input.lease_ttl_ms ?? existing.lease_ttl_ms,
      lease_expires_at: input.lease_expires_at ?? existing.lease_expires_at,
      deadline_at: input.deadline_at ?? existing.deadline_at,
      accepted_at: input.accepted_at ?? existing.accepted_at,
      last_checkpoint: input.last_checkpoint ?? existing.last_checkpoint,
      return_contract: input.return_contract ?? existing.return_contract,
      conflict_reason: input.conflict_reason ?? existing.conflict_reason,
      request_envelope_id: input.request_envelope_id ?? existing.request_envelope_id,
      accept_envelope_id: input.accept_envelope_id ?? existing.accept_envelope_id,
      return_envelope_id: input.return_envelope_id ?? existing.return_envelope_id,
      take_back_envelope_id: input.take_back_envelope_id ?? existing.take_back_envelope_id,
      last_envelope_id: input.last_envelope_id ?? existing.last_envelope_id,
      result: input.result ?? existing.result,
      updated_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `UPDATE handoff_sessions
         SET status = ?,
             protocol_status = ?,
             requester_agent_id = ?,
             owner_agent_id = ?,
             scope_json = ?,
             lease_ttl_ms = ?,
             lease_expires_at = ?,
             deadline_at = ?,
             accepted_at = ?,
             last_checkpoint_json = ?,
             return_contract_json = ?,
             conflict_reason = ?,
             request_envelope_id = ?,
             accept_envelope_id = ?,
             return_envelope_id = ?,
             take_back_envelope_id = ?,
             last_envelope_id = ?,
             result = ?,
             updated_at = ?
         WHERE handoff_id = ?`
      )
      .run(
        next.status,
        next.protocol_status ?? legacyProtocolStatus(next.status),
        next.requester_agent_id ?? null,
        next.owner_agent_id ?? null,
        JSON.stringify(next.scope ?? next.task_packet.file_scope),
        next.lease_ttl_ms ?? null,
        next.lease_expires_at ?? null,
        next.deadline_at ?? null,
        next.accepted_at ?? null,
        next.last_checkpoint === undefined ? null : JSON.stringify(next.last_checkpoint),
        next.return_contract === undefined ? null : JSON.stringify(next.return_contract),
        next.conflict_reason ?? null,
        next.request_envelope_id ?? null,
        next.accept_envelope_id ?? null,
        next.return_envelope_id ?? null,
        next.take_back_envelope_id ?? null,
        next.last_envelope_id ?? null,
        next.result ?? null,
        next.updated_at,
        next.handoff_id
      );
    return this.get(next.handoff_id) ?? next;
  }
}

function fromRow(row: HandoffRow): HandoffSessionRecord {
  const taskPacket = JSON.parse(row.task_packet_json) as AgentTaskPacket;
  return {
    handoff_id: row.handoff_id,
    worker_id: row.worker_id,
    parent_session_id: row.parent_session_id,
    source_agent: row.source_agent,
    target_agent_spec_id: row.target_agent_spec_id,
    reason: row.reason,
    status: row.status,
    protocol_status: row.protocol_status ?? legacyProtocolStatus(row.status),
    requester_agent_id: row.requester_agent_id ?? undefined,
    owner_agent_id: row.owner_agent_id ?? undefined,
    scope: parseJsonField<string[]>(row.scope_json, taskPacket.file_scope),
    lease_ttl_ms: row.lease_ttl_ms ?? undefined,
    lease_expires_at: row.lease_expires_at ?? undefined,
    deadline_at: row.deadline_at ?? undefined,
    accepted_at: row.accepted_at ?? undefined,
    last_checkpoint: parseJsonField(row.last_checkpoint_json, undefined),
    return_contract: parseJsonField(row.return_contract_json, undefined),
    conflict_reason: row.conflict_reason ?? undefined,
    request_envelope_id: row.request_envelope_id ?? undefined,
    accept_envelope_id: row.accept_envelope_id ?? undefined,
    return_envelope_id: row.return_envelope_id ?? undefined,
    take_back_envelope_id: row.take_back_envelope_id ?? undefined,
    last_envelope_id: row.last_envelope_id ?? undefined,
    task_packet: taskPacket,
    result: row.result ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function addMsIso(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + Math.max(0, ms)).toISOString();
}

function legacyProtocolStatus(status: HandoffStatus): HandoffProtocolStatus {
  if (status === "active") {
    return "accepted";
  }
  if (status === "returned") {
    return "returned";
  }
  if (status === "taken_back") {
    return "taken_back";
  }
  return "failed";
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
