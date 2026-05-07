import type { RunAttemptStatus, SwarmSession } from "../protocol/types.js";
import type { ToolResult } from "../tools/types.js";
import type { WorkerStatus } from "../storage/worker-state-store.js";

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

export function workerStatusFromExecutionStatus(
  status: LocalExecutionStatus | undefined,
  stopRequested: boolean
): WorkerStatus {
  if (stopRequested || status === "stopped") {
    return "stopped";
  }
  if (status === "failed") {
    return "failed";
  }
  return "completed";
}

export function delegatedToolStatus(workerStatus: WorkerStatus): NonNullable<ToolResult["status"]> {
  if (workerStatus === "failed") {
    return "failed";
  }
  if (workerStatus === "stopped") {
    return "partial";
  }
  return "success";
}
