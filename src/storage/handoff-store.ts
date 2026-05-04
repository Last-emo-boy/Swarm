import type { AgentTaskPacket } from "../runtime/agent-specs.js";
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
  task_packet_json: string;
  result?: string | null;
  created_at: string;
  updated_at: string;
};

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
  }): HandoffSessionRecord {
    const now = new Date().toISOString();
    const record: HandoffSessionRecord = {
      ...input,
      status: "active",
      created_at: now,
      updated_at: now
    };
    this.database.db
      .prepare(
        `INSERT INTO handoff_sessions (
          handoff_id, worker_id, parent_session_id, source_agent, target_agent_spec_id,
          reason, status, task_packet_json, result, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.handoff_id,
        record.worker_id,
        record.parent_session_id,
        record.source_agent,
        record.target_agent_spec_id,
        record.reason,
        record.status,
        JSON.stringify(record.task_packet),
        record.result ?? null,
        record.created_at,
        record.updated_at
      );
    return record;
  }

  finish(input: { handoff_id: string; status: HandoffStatus; result?: string }): HandoffSessionRecord {
    const existing = this.get(input.handoff_id);
    if (!existing) {
      throw new Error(`Unknown handoff: ${input.handoff_id}`);
    }
    const next: HandoffSessionRecord = {
      ...existing,
      status: input.status,
      result: input.result ?? existing.result,
      updated_at: new Date().toISOString()
    };
    this.database.db
      .prepare("UPDATE handoff_sessions SET status = ?, result = ?, updated_at = ? WHERE handoff_id = ?")
      .run(next.status, next.result ?? null, next.updated_at, next.handoff_id);
    return next;
  }

  takeBack(handoffId: string): HandoffSessionRecord {
    return this.finish({ handoff_id: handoffId, status: "taken_back", result: "Taken back by main Swarm." });
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
}

function fromRow(row: HandoffRow): HandoffSessionRecord {
  return {
    handoff_id: row.handoff_id,
    worker_id: row.worker_id,
    parent_session_id: row.parent_session_id,
    source_agent: row.source_agent,
    target_agent_spec_id: row.target_agent_spec_id,
    reason: row.reason,
    status: row.status,
    task_packet: JSON.parse(row.task_packet_json) as AgentTaskPacket,
    result: row.result ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
