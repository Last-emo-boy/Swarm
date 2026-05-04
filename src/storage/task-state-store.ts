import type { AgentAddress, SwarmTask, TaskStateSnapshot } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

export class TaskStateStore {
  constructor(private readonly database: SwarmDatabase) {}

  upsert(input: {
    session_id: string;
    swarm_id: string;
    task: SwarmTask;
    status: SwarmTask["status"];
    attempt?: number;
    assigned_to?: AgentAddress;
    last_error?: string;
  }): TaskStateSnapshot {
    const snapshot: TaskStateSnapshot = {
      session_id: input.session_id,
      swarm_id: input.swarm_id,
      task_id: input.task.task_id,
      parent_task_id: input.task.parent_task_id,
      subtask_id: undefined,
      title: input.task.title,
      status: input.status,
      attempt: input.attempt ?? 0,
      required_capabilities: input.task.required_capabilities,
      dependencies: input.task.dependencies ?? [],
      assigned_to: input.assigned_to ?? input.task.assigned_to,
      last_error: input.last_error,
      updated_at: new Date().toISOString()
    };

    this.database.db
      .prepare(
        `INSERT INTO task_states (
          session_id, task_id, swarm_id, parent_task_id, subtask_id, title, status, attempt,
          required_capabilities_json, dependencies_json, assigned_to_json, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, task_id) DO UPDATE SET
          swarm_id = excluded.swarm_id,
          parent_task_id = excluded.parent_task_id,
          subtask_id = excluded.subtask_id,
          title = excluded.title,
          status = excluded.status,
          attempt = excluded.attempt,
          required_capabilities_json = excluded.required_capabilities_json,
          dependencies_json = excluded.dependencies_json,
          assigned_to_json = excluded.assigned_to_json,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`
      )
      .run(
        snapshot.session_id,
        snapshot.task_id,
        snapshot.swarm_id,
        snapshot.parent_task_id ?? null,
        snapshot.subtask_id ?? null,
        snapshot.title,
        snapshot.status,
        snapshot.attempt,
        JSON.stringify(snapshot.required_capabilities),
        JSON.stringify(snapshot.dependencies),
        snapshot.assigned_to ? JSON.stringify(snapshot.assigned_to) : null,
        snapshot.last_error ?? null,
        snapshot.updated_at
      );

    return snapshot;
  }

  list(sessionId: string): TaskStateSnapshot[] {
    const rows = this.database.db
      .prepare("SELECT * FROM task_states WHERE session_id = ? ORDER BY updated_at ASC")
      .all(sessionId) as {
      session_id: string;
      task_id: string;
      swarm_id: string;
      parent_task_id?: string | null;
      subtask_id?: string | null;
      title: string;
      status: SwarmTask["status"];
      attempt: number;
      required_capabilities_json: string;
      dependencies_json: string;
      assigned_to_json?: string | null;
      last_error?: string | null;
      updated_at: string;
    }[];

    return rows.map((row) => ({
      session_id: row.session_id,
      task_id: row.task_id,
      swarm_id: row.swarm_id,
      parent_task_id: row.parent_task_id ?? undefined,
      subtask_id: row.subtask_id ?? undefined,
      title: row.title,
      status: row.status,
      attempt: row.attempt,
      required_capabilities: JSON.parse(row.required_capabilities_json),
      dependencies: JSON.parse(row.dependencies_json),
      assigned_to: row.assigned_to_json ? JSON.parse(row.assigned_to_json) : undefined,
      last_error: row.last_error ?? undefined,
      updated_at: row.updated_at
    }));
  }
}
