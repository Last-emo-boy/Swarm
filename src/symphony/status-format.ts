import type { SymphonyStatus } from "./status.js";
import { workItemLabel } from "./work-item.js";

export type SymphonyStatusFormatResult = {
  ok: boolean;
  lines: string[];
  exitCode?: number;
};

export function formatSymphonyCliStatus(status: SymphonyStatus): SymphonyStatusFormatResult {
  if (!status.workflow.ok) {
    return {
      ok: false,
      exitCode: 1,
      lines: [`${status.workflow.error.code}: ${status.workflow.error.message}`]
    };
  }
  return {
    ok: true,
    lines: [
      `Workflow: ${status.workflow.workflow.path}`,
      `Sessions: ${status.totals.sessions} running=${status.totals.running} completed=${status.totals.completed} failed=${status.totals.failed} cancelled=${status.totals.cancelled} retrying=${status.totals.retrying}`,
      `Capacity: ${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent}`,
      ...retryingLines(status),
      ...sessionLines(status)
    ]
  };
}

function retryingLines(status: SymphonyStatus): string[] {
  if (!status.scheduler.retrying.length) {
    return [];
  }
  return [
    "Retrying:",
    ...status.scheduler.retrying.slice(0, 10).map((retry) =>
      `  ${workItemLabel(retry.work_item)}: attempt=${retry.attempt} due=${retry.due_at}${retry.error ? ` error=${retry.error}` : ""}`
    )
  ];
}

function sessionLines(status: SymphonyStatus): string[] {
  if (!status.sessions.length) {
    return [];
  }
  return [
    "Sessions:",
    ...status.sessions.slice(0, 20).map((session) => {
      const source = workItemLabel(session.work_item);
      const runner = session.runner_attempt ? ` runner=${session.runner_attempt.status}` : "";
      const retry = session.next_retry_at ? ` retry=${session.next_retry_at}` : "";
      return `  ${session.session_id} [${session.status}] ${source}${runner}${retry}`;
    })
  ];
}
