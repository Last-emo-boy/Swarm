import { randomUUID } from "node:crypto";
import type { RunAttempt, RunAttemptKind, RunAttemptStatus } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";

type RunAttemptRow = Omit<RunAttempt, "metadata"> & {
  metadata_json: string;
};

export class RunAttemptStore {
  constructor(private readonly database: SwarmDatabase) {}

  upsert(input: {
    attempt_id?: string;
    session_id: string;
    task_id?: string;
    runner_id?: string;
    kind: RunAttemptKind;
    status: RunAttemptStatus;
    attempt?: number;
    title?: string;
    terminal_reason?: string;
    workspace_path?: string;
    error_code?: string;
    recovery_suggestion?: string;
    metadata?: Record<string, unknown>;
  }): RunAttempt {
    const now = new Date().toISOString();
    const attemptId = input.attempt_id ?? stableAttemptId(input);
    const existing = this.get(attemptId);
    const attempt: RunAttempt = {
      attempt_id: attemptId,
      session_id: input.session_id,
      task_id: input.task_id,
      runner_id: input.runner_id,
      kind: input.kind,
      status: input.status,
      attempt: input.attempt ?? existing?.attempt ?? 0,
      title: input.title ?? existing?.title,
      terminal_reason: input.terminal_reason ?? existing?.terminal_reason,
      started_at: existing?.started_at ?? now,
      ended_at: isTerminal(input.status) ? now : existing?.ended_at,
      last_event_at: now,
      workspace_path: input.workspace_path ?? existing?.workspace_path,
      error_code: input.error_code ?? existing?.error_code,
      recovery_suggestion: input.recovery_suggestion ?? existing?.recovery_suggestion,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {})
      }
    };
    this.database.db
      .prepare(
        `INSERT INTO run_attempts (
          attempt_id, session_id, task_id, runner_id, kind, status, attempt, title,
          terminal_reason, started_at, ended_at, last_event_at, workspace_path,
          error_code, recovery_suggestion, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id) DO UPDATE SET
          session_id = excluded.session_id,
          task_id = excluded.task_id,
          runner_id = excluded.runner_id,
          kind = excluded.kind,
          status = excluded.status,
          attempt = excluded.attempt,
          title = excluded.title,
          terminal_reason = excluded.terminal_reason,
          ended_at = excluded.ended_at,
          last_event_at = excluded.last_event_at,
          workspace_path = excluded.workspace_path,
          error_code = excluded.error_code,
          recovery_suggestion = excluded.recovery_suggestion,
          metadata_json = excluded.metadata_json`
      )
      .run(
        attempt.attempt_id,
        attempt.session_id,
        attempt.task_id ?? null,
        attempt.runner_id ?? null,
        attempt.kind,
        attempt.status,
        attempt.attempt,
        attempt.title ?? null,
        attempt.terminal_reason ?? null,
        attempt.started_at,
        attempt.ended_at ?? null,
        attempt.last_event_at,
        attempt.workspace_path ?? null,
        attempt.error_code ?? null,
        attempt.recovery_suggestion ?? null,
        JSON.stringify(attempt.metadata)
      );
    return attempt;
  }

  get(attemptId: string): RunAttempt | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM run_attempts WHERE attempt_id = ?")
      .get(attemptId) as RunAttemptRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(sessionId: string, limit = 200): RunAttempt[] {
    const rows = this.database.db
      .prepare("SELECT * FROM run_attempts WHERE session_id = ? ORDER BY started_at ASC, last_event_at ASC LIMIT ?")
      .all(sessionId, limit) as RunAttemptRow[];
    return rows.map(fromRow);
  }

  listByTask(sessionId: string, taskId: string, limit = 80): RunAttempt[] {
    const rows = this.database.db
      .prepare("SELECT * FROM run_attempts WHERE session_id = ? AND task_id = ? ORDER BY started_at ASC, last_event_at ASC LIMIT ?")
      .all(sessionId, taskId, limit) as RunAttemptRow[];
    return rows.map(fromRow);
  }

  listByRunner(runnerId: string, limit = 500): RunAttempt[] {
    const rows = this.database.db
      .prepare("SELECT * FROM run_attempts WHERE runner_id = ? ORDER BY last_event_at DESC, started_at DESC LIMIT ?")
      .all(runnerId, limit) as RunAttemptRow[];
    return rows.map(fromRow);
  }

  listRecent(limit = 500): RunAttempt[] {
    const rows = this.database.db
      .prepare("SELECT * FROM run_attempts ORDER BY last_event_at DESC, started_at DESC LIMIT ?")
      .all(limit) as RunAttemptRow[];
    return rows.map(fromRow);
  }
}

function stableAttemptId(input: {
  session_id: string;
  task_id?: string;
  runner_id?: string;
  kind: RunAttemptKind;
  attempt?: number;
}): string {
  const task = sanitize(input.task_id ?? input.runner_id ?? input.kind);
  return `attempt_${sanitize(input.session_id)}_${task}_${input.kind}_${input.attempt ?? 0}`;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
}

function isTerminal(status: RunAttemptStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "stopped";
}

function fromRow(row: RunAttemptRow): RunAttempt {
  return {
    ...row,
    task_id: row.task_id ?? undefined,
    runner_id: row.runner_id ?? undefined,
    title: row.title ?? undefined,
    terminal_reason: row.terminal_reason ?? undefined,
    ended_at: row.ended_at ?? undefined,
    workspace_path: row.workspace_path ?? undefined,
    error_code: row.error_code ?? undefined,
    recovery_suggestion: row.recovery_suggestion ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}
