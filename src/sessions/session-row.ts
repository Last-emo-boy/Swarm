import type { SwarmPolicy, SwarmSession, WorkItem } from "../protocol/types.js";
import type { SessionRow } from "../storage/session-store.js";

export function restoreSessionFromRow(row: SessionRow): SwarmSession {
  return {
    swarm_id: row.swarm_id,
    session_id: row.session_id,
    user_request_id: row.session_id,
    source: parseJson(row.source_json, undefined as WorkItem | undefined),
    parent_session_id: row.parent_session_id ?? undefined,
    workspace_lease_id: row.workspace_lease_id ?? undefined,
    objective: row.objective,
    status: row.status,
    coordinator: { agent_id: "orchestrator", role: "coordinator" },
    participants: parseJson(row.participants_json, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    policy: parseJson(row.policy_json, { max_agents: 1 } as SwarmPolicy)
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
