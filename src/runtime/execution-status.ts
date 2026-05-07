import type { RunAttemptStatus, SwarmSession } from "../protocol/types.js";

export type LocalExecutionStatus = "completed" | "failed" | "stopped";

export function finalAttemptStatus(status: LocalExecutionStatus | undefined): RunAttemptStatus {
  if (status === "failed") {
    return "failed";
  }
  if (status === "stopped") {
    return "stopped";
  }
  return "completed";
}

export function sessionStatusFromExecutionStatus(status: LocalExecutionStatus | undefined): SwarmSession["status"] {
  if (status === "failed") {
    return "failed";
  }
  if (status === "stopped") {
    return "cancelled";
  }
  return "completed";
}
