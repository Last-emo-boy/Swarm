import { strict as assert } from "node:assert";
import test from "node:test";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ApprovalRecord, ApprovalStatus } from "../storage/approval-store.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import {
  buildApprovalDetailReport,
  buildApprovalListReport,
  decideApprovalLocally,
  resolveApprovalSelector
} from "./report.js";

test("approval selector distinguishes latest record from latest pending approval", () => {
  const runtime = approvalRuntime([
    approval({ id: "approval-approved-latest", status: "approved", updatedAt: "2026-05-11T00:03:00.000Z" }),
    approval({ id: "approval-pending-newer", status: "pending", updatedAt: "2026-05-11T00:02:00.000Z" }),
    approval({ id: "approval-pending-older", status: "pending", updatedAt: "2026-05-11T00:01:00.000Z" })
  ]);

  assert.deepEqual(resolveApprovalSelector(runtime, "latest"), { approvalId: "approval-approved-latest" });
  assert.deepEqual(resolveApprovalSelector(runtime, "latest", { pendingOnly: true }), { approvalId: "approval-pending-newer" });
  assert.deepEqual(resolveApprovalSelector(runtime, undefined, { pendingOnly: true }), { approvalId: "approval-pending-newer" });
});

test("approval reports include pending summary and detailed permission context", () => {
  const runtime = approvalRuntime([
    approval({
      id: "approval-pending-1",
      status: "pending",
      summary: "Write implementation file",
      target: "src/approvals/report.ts",
      permissionName: "file.write",
      permissionRule: "ask:file.write",
      updatedAt: "2026-05-11T00:02:00.000Z"
    }),
    approval({ id: "approval-denied-1", status: "denied", updatedAt: "2026-05-11T00:01:00.000Z" })
  ]);

  const list = buildApprovalListReport(runtime, { status: "pending" });
  assert.match(list.detail, /Swarm Approvals/);
  assert.match(list.detail, /summary approvals=1 pending=1 approved=0 denied=0 status_filter=pending/);
  assert.match(list.detail, /permission=file\.write rule=ask:file\.write/);
  assert.equal(list.data.workspace, "E:/Playground/Swarm");

  const detail = buildApprovalDetailReport(runtime, "pending-1");
  assert.match(detail.detail, /approval-pending-1 \[pending\] r3\/write/);
  assert.match(detail.detail, /why=Need to update the requested file now\./);
  assert.match(detail.detail, /impact=Workspace file changes/);
});

test("local approval decisions reject non-pending records before updating the store", () => {
  const runtime = approvalRuntime([
    approval({ id: "approval-approved-1", status: "approved", updatedAt: "2026-05-11T00:02:00.000Z" })
  ]);

  assert.throws(
    () => decideApprovalLocally(runtime, "approval-approved-1", { approved: false }),
    /Approval is not pending: approval-approved-1 current_status=approved/
  );
  assert.equal(runtime.approvalStore.get("approval-approved-1")?.status, "approved");
});

function approvalRuntime(records: ApprovalRecord[]): SwarmRuntime {
  const sorted = records.slice().sort(compareApprovals);
  const byId = new Map(sorted.map((record) => [record.approval_id, record]));
  return {
    getWorkspacePath: () => "E:/Playground/Swarm",
    listRecentApprovalsForWorkspace: (limit = 20) => sorted.slice(0, limit),
    listApprovalsForSessionFamily: (sessionId: string, limit = 100) =>
      sorted.filter((record) => record.session_id === sessionId).slice(0, limit),
    listSessionFamilySessionIds: (sessionId: string) => [sessionId],
    approvalStore: {
      get: (approvalId: string) => byId.get(approvalId),
      updateStatus: (approvalId: string, status: ApprovalStatus) => {
        const previous = byId.get(approvalId);
        if (!previous) {
          return undefined;
        }
        const next = { ...previous, status, updated_at: "2026-05-11T00:04:00.000Z" };
        byId.set(approvalId, next);
        return next;
      }
    }
  } as unknown as SwarmRuntime;
}

function approval(input: {
  id: string;
  status: ApprovalStatus;
  updatedAt: string;
  summary?: string;
  target?: string;
  permissionName?: string;
  permissionRule?: string;
}): ApprovalRecord {
  const request: ToolApprovalRequest = {
    id: input.id,
    session_id: "session-1",
    task_id: "task-1",
    action: "file.write",
    summary: input.summary ?? `Approval ${input.id}`,
    detail: "Needs file write access",
    risk: "write",
    risk_class: "r3",
    target: input.target ?? "src/example.ts",
    why_now: "Need to update the requested file now.",
    predicted_impact: "Workspace file changes",
    rollback_plan: "Revert the file",
    permission_decision: "ask",
    permission_reason: "write requested",
    permission_mode: "ask",
    permission_name: input.permissionName,
    permission_rule: input.permissionRule
  };
  return {
    approval_id: input.id,
    session_id: request.session_id,
    task_id: request.task_id,
    action: request.action,
    summary: request.summary,
    detail: request.detail,
    risk: request.risk,
    risk_class: request.risk_class,
    target: request.target,
    status: input.status,
    challenge: request,
    created_at: "2026-05-11T00:00:00.000Z",
    updated_at: input.updatedAt
  };
}

function compareApprovals(left: ApprovalRecord, right: ApprovalRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || right.approval_id.localeCompare(left.approval_id);
}
