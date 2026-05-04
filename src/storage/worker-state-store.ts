import type { SessionOutcome } from "../runtime/events.js";
import type { AgentInvocationMode, AgentTaskPacket } from "../runtime/agent-specs.js";
import type { SwarmDatabase } from "./database.js";

export type WorkerStatus = "running" | "completed" | "failed" | "stopped";

export type WorkerRecord = {
  worker_id: string;
  parent_session_id: string;
  worker_session_id?: string;
  agent_spec_id?: string;
  invocation_mode?: AgentInvocationMode;
  handoff_id?: string;
  capability: string;
  objective: string;
  status: WorkerStatus;
  file_scope: string[];
  tool_budget: {
    max_turns: number;
    max_tool_calls: number;
  };
  persona_snapshot?: string;
  task_packet?: AgentTaskPacket;
  output_contract?: string;
  spawn_reason?: string;
  requested_by?: string;
  last_result?: string;
  outcome?: SessionOutcome;
  created_at: string;
  updated_at: string;
};

type WorkerRow = {
  worker_id: string;
  parent_session_id: string;
  worker_session_id?: string | null;
  agent_spec_id?: string | null;
  invocation_mode?: AgentInvocationMode | null;
  handoff_id?: string | null;
  capability: string;
  objective: string;
  status: WorkerStatus;
  file_scope_json: string;
  tool_budget_json: string;
  persona_snapshot_json?: string | null;
  task_packet_json?: string | null;
  output_contract_json?: string | null;
  spawn_reason?: string | null;
  requested_by?: string | null;
  last_result?: string | null;
  outcome_json?: string | null;
  created_at: string;
  updated_at: string;
};

export class WorkerStateStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(input: {
    worker_id: string;
    parent_session_id: string;
    capability: string;
    objective: string;
    agent_spec_id?: string;
    invocation_mode?: AgentInvocationMode;
    handoff_id?: string;
    file_scope?: string[];
    tool_budget: WorkerRecord["tool_budget"];
    persona_snapshot?: string;
    task_packet?: AgentTaskPacket;
    output_contract?: string;
    spawn_reason?: string;
    requested_by?: string;
  }): WorkerRecord {
    const now = new Date().toISOString();
    const record: WorkerRecord = {
      worker_id: input.worker_id,
      parent_session_id: input.parent_session_id,
      agent_spec_id: input.agent_spec_id,
      invocation_mode: input.invocation_mode,
      handoff_id: input.handoff_id,
      capability: input.capability,
      objective: input.objective,
      status: "running",
      file_scope: input.file_scope ?? [],
      tool_budget: input.tool_budget,
      persona_snapshot: input.persona_snapshot,
      task_packet: input.task_packet,
      output_contract: input.output_contract,
      spawn_reason: input.spawn_reason,
      requested_by: input.requested_by,
      created_at: now,
      updated_at: now
    };
    this.database.db
      .prepare(
        `INSERT INTO worker_states (
          worker_id, parent_session_id, worker_session_id, agent_spec_id, invocation_mode, handoff_id,
          capability, objective, status, file_scope_json, tool_budget_json, persona_snapshot_json,
          task_packet_json, output_contract_json, spawn_reason, requested_by, last_result, outcome_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.worker_id,
        record.parent_session_id,
        record.worker_session_id ?? null,
        record.agent_spec_id ?? null,
        record.invocation_mode ?? null,
        record.handoff_id ?? null,
        record.capability,
        record.objective,
        record.status,
        JSON.stringify(record.file_scope),
        JSON.stringify(record.tool_budget),
        record.persona_snapshot ? JSON.stringify(record.persona_snapshot) : null,
        record.task_packet ? JSON.stringify(record.task_packet) : null,
        record.output_contract ? JSON.stringify(record.output_contract) : null,
        record.spawn_reason ?? null,
        record.requested_by ?? null,
        record.last_result ?? null,
        record.outcome ? JSON.stringify(record.outcome) : null,
        record.created_at,
        record.updated_at
      );
    return record;
  }

  setResult(input: {
    worker_id: string;
    status: WorkerStatus;
    worker_session_id?: string;
    last_result?: string;
    outcome?: SessionOutcome;
  }): WorkerRecord {
    const existing = this.get(input.worker_id);
    if (!existing) {
      throw new Error(`Unknown worker: ${input.worker_id}`);
    }
    const next: WorkerRecord = {
      ...existing,
      status: input.status,
      worker_session_id: input.worker_session_id ?? existing.worker_session_id,
      last_result: input.last_result ?? existing.last_result,
      outcome: input.outcome ?? existing.outcome,
      updated_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `UPDATE worker_states
         SET status = ?, worker_session_id = ?, last_result = ?, outcome_json = ?, updated_at = ?
         WHERE worker_id = ?`
      )
      .run(
        next.status,
        next.worker_session_id ?? null,
        next.last_result ?? null,
        next.outcome ? JSON.stringify(next.outcome) : null,
        next.updated_at,
        next.worker_id
      );
    return next;
  }

  requestStop(workerId: string): WorkerRecord {
    return this.setResult({ worker_id: workerId, status: "stopped", last_result: "Stop requested by main Swarm." });
  }

  get(workerId: string): WorkerRecord | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM worker_states WHERE worker_id = ?")
      .get(workerId) as WorkerRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listRecent(limit = 20): WorkerRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM worker_states ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as WorkerRow[];
    return rows.map(fromRow);
  }

  listByParent(parentSessionId: string): WorkerRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM worker_states WHERE parent_session_id = ? ORDER BY updated_at DESC")
      .all(parentSessionId) as WorkerRow[];
    return rows.map(fromRow);
  }
}

function fromRow(row: WorkerRow): WorkerRecord {
    return {
      worker_id: row.worker_id,
      parent_session_id: row.parent_session_id,
      worker_session_id: row.worker_session_id ?? undefined,
      agent_spec_id: row.agent_spec_id ?? undefined,
      invocation_mode: row.invocation_mode ?? undefined,
      handoff_id: row.handoff_id ?? undefined,
      capability: row.capability,
    objective: row.objective,
    status: row.status,
      file_scope: JSON.parse(row.file_scope_json) as string[],
      tool_budget: JSON.parse(row.tool_budget_json) as WorkerRecord["tool_budget"],
      persona_snapshot: row.persona_snapshot_json ? JSON.parse(row.persona_snapshot_json) as string : undefined,
      task_packet: row.task_packet_json ? JSON.parse(row.task_packet_json) as AgentTaskPacket : undefined,
      output_contract: row.output_contract_json ? JSON.parse(row.output_contract_json) as string : undefined,
      spawn_reason: row.spawn_reason ?? undefined,
      requested_by: row.requested_by ?? undefined,
      last_result: row.last_result ?? undefined,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) as SessionOutcome : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
