import type { SessionOutcome } from "../runtime/events.js";
import type { AgentInvocationMode, AgentTaskPacket } from "../runtime/agent-specs.js";
import type { SwarmDatabase } from "./database.js";

export type WorkerStatus = "running" | "completed" | "failed" | "stopped";

export type WorkerRecord = {
  worker_id: string;
  display_name: string;
  role_title?: string;
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
  blocked_reason?: string;
  last_review?: unknown;
  last_verification?: unknown;
  change_refs?: string[];
  last_result?: string;
  outcome?: SessionOutcome;
  created_at: string;
  updated_at: string;
};

type WorkerRow = {
  worker_id: string;
  display_name?: string | null;
  role_title?: string | null;
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
  blocked_reason?: string | null;
  last_review_json?: string | null;
  last_verification_json?: string | null;
  change_refs_json?: string | null;
  last_result?: string | null;
  outcome_json?: string | null;
  created_at: string;
  updated_at: string;
};

export class WorkerStateStore {
  constructor(private readonly database: SwarmDatabase) {}

  create(input: {
    worker_id: string;
    display_name?: string;
    role_title?: string;
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
    blocked_reason?: string;
    last_review?: unknown;
    last_verification?: unknown;
    change_refs?: string[];
  }): WorkerRecord {
    const now = new Date().toISOString();
    const fallbackIdentity = makeWorkerIdentity({
      worker_id: input.worker_id,
      agent_spec_id: input.agent_spec_id,
      capability: input.capability
    });
    const record: WorkerRecord = {
      worker_id: input.worker_id,
      display_name: input.display_name ?? fallbackIdentity.display_name,
      role_title: input.role_title ?? fallbackIdentity.role_title,
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
      blocked_reason: input.blocked_reason,
      last_review: input.last_review,
      last_verification: input.last_verification,
      change_refs: input.change_refs,
      created_at: now,
      updated_at: now
    };
    this.database.db
      .prepare(
        `INSERT INTO worker_states (
          worker_id, display_name, role_title, parent_session_id, worker_session_id, agent_spec_id, invocation_mode, handoff_id,
          capability, objective, status, file_scope_json, tool_budget_json, persona_snapshot_json,
          task_packet_json, output_contract_json, spawn_reason, requested_by, blocked_reason,
          last_review_json, last_verification_json, change_refs_json, last_result, outcome_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.worker_id,
        record.display_name,
        record.role_title ?? null,
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
        record.blocked_reason ?? null,
        record.last_review ? JSON.stringify(record.last_review) : null,
        record.last_verification ? JSON.stringify(record.last_verification) : null,
        record.change_refs ? JSON.stringify(record.change_refs) : null,
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
    blocked_reason?: string;
    last_review?: unknown;
    last_verification?: unknown;
    change_refs?: string[];
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
      blocked_reason: input.blocked_reason ?? existing.blocked_reason,
      last_review: input.last_review ?? existing.last_review,
      last_verification: input.last_verification ?? existing.last_verification,
      change_refs: input.change_refs ?? existing.change_refs,
      updated_at: new Date().toISOString()
    };
    this.database.db
      .prepare(
        `UPDATE worker_states
         SET status = ?, worker_session_id = ?, last_result = ?, outcome_json = ?, updated_at = ?
         , blocked_reason = ?, last_review_json = ?, last_verification_json = ?, change_refs_json = ?
         WHERE worker_id = ?`
      )
      .run(
        next.status,
        next.worker_session_id ?? null,
        next.last_result ?? null,
        next.outcome ? JSON.stringify(next.outcome) : null,
        next.updated_at,
        next.blocked_reason ?? null,
        next.last_review ? JSON.stringify(next.last_review) : null,
        next.last_verification ? JSON.stringify(next.last_verification) : null,
        next.change_refs ? JSON.stringify(next.change_refs) : null,
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
  const fallbackIdentity = makeWorkerIdentity(row);
  const displayName = row.display_name ?? fallbackIdentity.display_name;
  const legacyRoleTitle = !row.role_title && displayName.includes("/")
    ? undefined
    : fallbackIdentity.role_title;
  return {
    worker_id: row.worker_id,
    display_name: displayName,
    role_title: row.role_title ?? legacyRoleTitle,
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
    blocked_reason: row.blocked_reason ?? undefined,
    last_review: row.last_review_json ? JSON.parse(row.last_review_json) : undefined,
    last_verification: row.last_verification_json ? JSON.parse(row.last_verification_json) : undefined,
    change_refs: row.change_refs_json ? JSON.parse(row.change_refs_json) as string[] : undefined,
    last_result: row.last_result ?? undefined,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) as SessionOutcome : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function makeWorkerDisplayName(input: {
  worker_id: string;
  agent_spec_id?: string | null;
  capability?: string | null;
}): string {
  return workerDisplayLabel(makeWorkerIdentity(input));
}

export function makeWorkerIdentity(input: {
  worker_id: string;
  agent_spec_id?: string | null;
  capability?: string | null;
}): { display_name: string; role_title: string } {
  const roleTitle = fallbackRoleTitle(input.agent_spec_id || input.capability || "agent");
  const name = WORKER_NAME_POOL[stableNameIndex(`${input.worker_id}:${roleTitle}`, WORKER_NAME_POOL.length)] ?? "Nova";
  return { display_name: name, role_title: roleTitle };
}

export function workerDisplayLabel(worker: Pick<WorkerRecord, "display_name" | "role_title">): string {
  if (worker.role_title) {
    return `${worker.display_name} / ${worker.role_title}`;
  }
  return worker.display_name;
}

const WORKER_NAME_POOL = [
  "Ada",
  "Aiko",
  "Akira",
  "Asa",
  "Aya",
  "Bea",
  "Cora",
  "Dax",
  "Eli",
  "Emi",
  "Faye",
  "Hana",
  "Haru",
  "Iris",
  "Juno",
  "Kai",
  "Kira",
  "Koh",
  "Lena",
  "Lin",
  "Luca",
  "Mika",
  "Mira",
  "Niko",
  "Noa",
  "Noor",
  "Nova",
  "Orion",
  "Rae",
  "Ren",
  "Rin",
  "Sage",
  "Saki",
  "Sena",
  "Sora",
  "Tao",
  "Tara",
  "Theo",
  "Uma",
  "Vega",
  "Yuki",
  "Yuna",
  "Zara"
];

function fallbackRoleTitle(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  switch (normalized) {
    case "researcher":
    case "code_research":
    case "file_search":
    case "log_analysis":
    case "docs_summarize":
      return "Researcher";
    case "coder":
    case "code_edit":
    case "code_implement":
    case "project_create":
    case "bug_fix":
      return "Coder";
    case "reviewer":
    case "code_review":
    case "diff_review":
    case "test_review":
      return "Reviewer";
    case "critic":
    case "risk_analysis":
    case "architecture_critique":
    case "security_review":
      return "Critic";
    case "verifier":
    case "verify":
    case "test_run":
    case "lint_run":
      return "Verifier";
    case "architect":
    case "architecture_design":
    case "refactor_plan":
    case "protocol_design":
      return "Architect";
    case "self_improver":
    case "self_review":
    case "self_improve":
    case "eval_design":
    case "prompt_improve":
      return "Self Improver";
    case "handoff_specialist":
    case "handoff_deep_work":
    case "focused_execution":
      return "Handoff";
    default:
      return titleCase(normalized || "agent");
  }
}

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Agent";
}

function stableNameIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
  }
  return modulo > 0 ? hash % modulo : 0;
}
