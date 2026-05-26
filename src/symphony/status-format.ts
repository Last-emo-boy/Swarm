import type { SymphonyStatus } from "./status.js";
import { formatSymphonyActionStatus, summarizeSymphonyActionPolicy } from "./action-lifecycle.js";
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
      lines: [
        `${status.workflow.error.code}: ${status.workflow.error.message}`,
        liveControlLine(status)
      ]
    };
  }
  return {
    ok: true,
    lines: [
      `Workflow: ${status.workflow.workflow.path}`,
      liveControlLine(status),
      ...latestActionLines(status),
      `Sessions: ${status.totals.sessions} running=${status.totals.running} completed=${status.totals.completed} failed=${status.totals.failed} cancelled=${status.totals.cancelled} retrying=${status.totals.retrying}`,
      `Capacity: ${status.scheduler.capacity.running}/${status.scheduler.capacity.max_concurrent}`,
      workBoardLine(status),
      ...workBoardNextActionLines(status),
      ...retryingLines(status),
      ...sessionLines(status)
    ]
  };
}

function workBoardLine(status: SymphonyStatus): string {
  const summary = status.work_board.summary;
  return `Work Board: sessions=${summary.sessions} workers=${summary.workers} tasks=${summary.tasks} claims=${summary.claims} blocked=${summary.blocked} failed=${summary.failed} resumable=${summary.resumable} checks=${summary.checks} artifacts=${summary.artifacts}`;
}

function workBoardNextActionLines(status: SymphonyStatus): string[] {
  if (!status.work_board.next_actions.length) {
    return [];
  }
  return [
    "Work Board Next Actions:",
    ...status.work_board.next_actions.slice(0, 8).map((action) =>
      `  ${action.severity} ${action.source}:${action.id} ${action.action}`
    )
  ];
}

function retryingLines(status: SymphonyStatus): string[] {
  if (!status.scheduler.retrying.length) {
    return [];
  }
  return [
    "Retrying:",
    ...status.scheduler.retrying.slice(0, 10).map((retry) =>
      `  ${workItemLabel(retry.work_item)}: status=${retry.live_control.status} severity=${retry.live_control.severity} attempt=${retry.attempt} due=${retry.due_at}${retry.error ? ` error=${retry.error}` : ""}${retry.live_control.next_action ? ` next=${retry.live_control.next_action}` : ""}`
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
      const next = session.live_control.next_action ? ` next=${session.live_control.next_action}` : "";
      const action = session.latest_action ? ` action=${session.latest_action.action}/${session.latest_action.status} action_id=${session.latest_action.action_id}` : "";
      return `  ${session.session_id} [${session.status}] live=${session.live_control.status}/${session.live_control.severity} ${source}${runner}${retry}${action}${next}`;
    })
  ];
}

function latestActionLines(status: SymphonyStatus): string[] {
  if (!status.latest_action) {
    return [];
  }
  const summary = summarizeSymphonyActionPolicy(status.latest_action);
  const policy = [
    `policy_verdict=${summary.policy_verdict}`,
    `risk_level=${summary.risk_level}`,
    `audit_id=${summary.audit_id}`,
    summary.rollback_plan ? `rollback_plan=${summary.rollback_plan}` : undefined,
    summary.not_rollbackable ? `not_rollbackable=${summary.not_rollbackable}` : undefined
  ].filter((line): line is string => Boolean(line)).join(" ");
  return [
    `Latest Action: ${formatSymphonyActionStatus(status.latest_action)}`,
    `Latest Action Policy: ${policy}`
  ];
}

function liveControlLine(status: SymphonyStatus): string {
  return [
    `Live Control: status=${status.live_control.status}`,
    `severity=${status.live_control.severity}`,
    status.live_control.next_action ? `next=${status.live_control.next_action}` : undefined
  ].filter(Boolean).join(" ");
}
