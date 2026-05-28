import type { RunBoardSurfaceView } from "./run-board-types.js";

export function summarizeRunBoardViewCounts(view: RunBoardSurfaceView): {
  workers: number;
  blocked: number;
  stuck: number;
  files: number;
  checks: number;
  passedChecks: number;
  approvals: number;
} {
  return {
    workers: view.workers.length,
    blocked: view.workers.filter((worker) => worker.status === "blocked" || worker.status === "waiting").length,
    stuck: view.workers.filter((worker) => worker.status === "stuck").length + view.attention.filter((item) => item.kind === "slow").length,
    files: view.resultPreview.changedFiles.length,
    checks: view.resultPreview.checks.length,
    passedChecks: view.resultPreview.checks.filter((check) => check.status === "passed").length,
    approvals: view.attention.filter((item) => item.kind === "approval").length
  };
}
