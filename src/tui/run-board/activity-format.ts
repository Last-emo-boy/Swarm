// Shared mapping helpers for the Phase-1 conversation-result-first active layout.
// Map run-board phases / worker statuses onto the existing semantic badge + token
// vocabulary (statusBadge / visualTokenColor) so the new components stay
// NO_COLOR-safe and consistent with the rest of the TUI.
import type { TuiVisualToken } from "../theme.js";
import type { RunBoardPhase, WorkerBoardStatus } from "./run-board-types.js";

// Normalize a phase to a status string understood by statusBadge().
export function phaseBadgeStatus(phase: RunBoardPhase): string {
  switch (phase) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "waiting-attention":
      return "pending";
    case "idle":
      return "info";
    default:
      return "running";
  }
}

// Normalize a worker status to a status string understood by statusBadge().
export function workerBadgeStatus(status: WorkerBoardStatus): string {
  switch (status) {
    case "active":
      return "running";
    case "queued":
    case "waiting":
      return "pending";
    case "blocked":
    case "stuck":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "info";
  }
}

// Pick the semantic color token for a status string.
export function statusToken(statusString: string): TuiVisualToken {
  const s = statusString.toLowerCase();
  if (["done", "success", "ok", "passed", "completed", "complete"].includes(s)) return "status.success";
  if (["running", "active", "started", "working"].includes(s)) return "status.running";
  if (["pending", "queued", "waiting", "ask"].includes(s)) return "status.pending";
  if (["blocked", "stuck", "warn", "warning", "partial", "skipped"].includes(s)) return "status.warning";
  if (["failed", "error", "err", "denied"].includes(s)) return "status.danger";
  return "text.muted";
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
