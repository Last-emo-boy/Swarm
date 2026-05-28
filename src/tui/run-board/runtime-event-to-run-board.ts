import type { RuntimeEvent } from "../../runtime/events.js";
import type { ResultCard } from "../../runtime/result-card.js";
import type { RunBoardAction, RunBoardEvidence, RunBoardRisk, WorkerBoardRole, WorkerBoardStatus } from "./run-board-types.js";

export type RunBoardMappingContext = {
  now?: string;
  latestResultCard?: ResultCard;
};

export function runBoardActionsFromRuntimeEvent(
  event: RuntimeEvent,
  context: RunBoardMappingContext = {}
): RunBoardAction[] {
  const at = context.now ?? eventTimestamp(event) ?? new Date().toISOString();
  switch (event.type) {
    case "session":
      return [
        { type: "run/identity", runId: event.session_id, objective: event.objective, at },
        { type: "run/phase", phase: sessionPhase(event.status), at },
        mainWorkerAction(event.objective ?? sessionStatusAction(event.status), at, event.session_id)
      ];
    case "plan":
      return [
        { type: "run/identity", runId: event.session_id, at },
        mainWorkerAction("planning next steps", at, event.session_id)
      ];
    case "worker":
      return workerRecordActions(event.worker, event.status, at, event.message);
    case "agent_run_started":
      return workerRecordActions(event.worker, "running", at, event.task_packet.objective);
    case "agent_run_completed":
      return [
        ...workerRecordActions(event.worker, "completed", at, event.result),
        evidenceAction({
          id: evidenceId("worker", event.worker.worker_id, at),
          kind: "worker",
          summary: compactSummary(event.result, "worker completed"),
          at,
          workerId: event.worker.worker_id,
          workerLabel: roleLabel(event.worker.agent_spec_id ?? event.worker.role_title ?? event.worker.capability, event.worker.display_name),
          status: "success"
        })
      ];
    case "handoff_started":
      return [
        {
          type: "worker/upsert",
          at,
          worker: {
            id: workerIdFor(event.handoff.worker_id),
            label: roleLabel(event.handoff.target_agent_spec_id, event.handoff.target_agent_spec_id),
            role: roleFromText(event.handoff.target_agent_spec_id),
            status: "waiting",
            currentAction: event.handoff.reason || event.handoff.task_packet.objective,
            waitingOn: event.handoff.target_agent_spec_id,
            canTakeBack: true,
            risk: "medium",
            sourceIds: {
              workerId: event.handoff.worker_id,
              handoffId: event.handoff.handoff_id,
              sessionId: event.handoff.parent_session_id,
              agentSpecId: event.handoff.target_agent_spec_id
            }
          }
        },
        evidenceAction({
          id: evidenceId("handoff", event.handoff.handoff_id, at),
          kind: "handoff",
          summary: `handoff started: ${event.handoff.reason}`,
          at,
          workerId: event.handoff.worker_id,
          workerLabel: roleLabel(event.handoff.target_agent_spec_id, event.handoff.target_agent_spec_id),
          status: "pending"
        })
      ];
    case "handoff_message":
      return [
        evidenceAction({
          id: evidenceId("handoff-message", event.handoff_id, at),
          kind: "handoff",
          summary: compactSummary(event.message, "handoff update"),
          at,
          workerId: event.worker_id,
          status: "pending"
        })
      ];
    case "handoff_returned":
      return [
        {
          type: "worker/upsert",
          at,
          worker: {
            id: workerIdFor(event.handoff.worker_id),
            status: "done",
            currentAction: compactSummary(event.result, "returned handoff"),
            canTakeBack: false,
            sourceIds: {
              workerId: event.handoff.worker_id,
              handoffId: event.handoff.handoff_id,
              sessionId: event.handoff.parent_session_id
            }
          }
        },
        evidenceAction({
          id: evidenceId("handoff-returned", event.handoff.handoff_id, at),
          kind: "handoff",
          summary: compactSummary(event.result, "handoff returned"),
          at,
          workerId: event.handoff.worker_id,
          workerLabel: roleLabel(event.handoff.target_agent_spec_id, event.handoff.target_agent_spec_id),
          status: "success"
        })
      ];
    case "handoff_taken_back":
      return [
        {
          type: "worker/upsert",
          at,
          worker: {
            id: workerIdFor(event.handoff.worker_id),
            status: "blocked",
            currentAction: "handoff taken back",
            canTakeBack: false,
            risk: "medium",
            sourceIds: {
              workerId: event.handoff.worker_id,
              handoffId: event.handoff.handoff_id,
              sessionId: event.handoff.parent_session_id
            }
          }
        },
        attentionAction({
          id: `handoff:${event.handoff.handoff_id}:taken-back`,
          kind: "blocked",
          severity: "warning",
          title: "Handoff taken back",
          summary: `${roleLabel(event.handoff.target_agent_spec_id, event.handoff.target_agent_spec_id)} was taken back by Main Swarm.`,
          recommendation: "Review the latest handoff evidence, then continue from Main Swarm.",
          subjectWorkerId: workerIdFor(event.handoff.worker_id),
          at
        })
      ];
    case "task":
      return [
        {
          type: "worker/upsert",
          at,
          worker: {
            id: taskWorkerId(event.task_id),
            label: roleLabel(event.capability, event.title),
            role: roleFromText(event.capability ?? event.title),
            status: taskStatus(event.status),
            currentAction: event.title,
            owns: event.file_scope ?? [],
            risk: riskFromWritePolicy(event.write_policy),
            sourceIds: {
              taskId: event.task_id,
              sessionId: event.session_id
            }
          }
        }
      ];
    case "task_attempt":
      return [
        {
          type: "worker/upsert",
          at,
          worker: {
            id: taskWorkerId(event.task_id),
            label: roleLabel(undefined, event.title),
            status: attemptStatus(event.status),
            currentAction: `${event.title} attempt ${event.attempt}`,
            sourceIds: {
              taskId: event.task_id,
              sessionId: event.session_id
            }
          }
        }
      ];
    case "approval":
      return [
        attentionAction({
          id: `approval:${event.request.id}`,
          kind: "approval",
          severity: event.status === "pending" ? "blocking" : "info",
          title: event.status === "pending" ? "Approval needed" : `Approval ${event.status}`,
          summary: approvalSummary(event),
          recommendation: event.status === "pending"
            ? "Approve only if the requested action and scope match the objective."
            : "Continue after recording the approval decision.",
          at,
          resolvedAt: event.status === "pending" ? undefined : at,
          resolution: event.status === "pending" ? undefined : event.status,
          actions: event.status === "pending"
            ? [
                { key: "y", label: "approve", enabled: true },
                { key: "n", label: "deny", enabled: true },
                { key: "d", label: "details", enabled: true }
              ]
            : []
        })
      ];
    case "loop_activity":
      return loopActivityActions(event, at);
    case "tool_result":
      return toolResultActions(event, at);
    case "review_started":
      return [
        { type: "run/phase", phase: "reviewing", at },
        mainWorkerAction(`reviewing: ${event.objective}`, at, event.session_id)
      ];
    case "review_completed":
      return [
        evidenceAction({
          id: evidenceId("review", event.session_id, at),
          kind: "review",
          summary: event.result.summary,
          at,
          status: event.result.verdict === "approve" ? "success" : "partial"
        })
      ];
    case "verification_started":
      return [
        { type: "run/phase", phase: "verifying", at },
        mainWorkerAction(`verifying: ${event.objective}`, at, event.session_id)
      ];
    case "verification_completed":
      return [
        evidenceAction({
          id: evidenceId("verification", event.session_id, at),
          kind: "check",
          summary: event.result.summary,
          at,
          workerId: event.result.worker_id,
          status: event.result.status === "success" ? "success" : event.result.status === "failed" ? "failed" : "partial"
        }),
        ...(event.result.status === "failed"
          ? [attentionAction({
              id: `verification:${event.session_id}:failed`,
              kind: "failed",
              severity: "failed",
              title: "Verification failed",
              summary: event.result.summary,
              recommendation: "Inspect the failed check output, patch the cause, then rerun verification.",
              at
            })]
          : [])
      ];
    case "workspace_change":
      return [
        evidenceAction({
          id: evidenceId("workspace-change", `${event.session_id}:${event.change.path}`, at),
          kind: "file",
          summary: `${event.change.operation} ${event.change.path}`,
          file: event.change.path,
          at,
          status: "success"
        })
      ];
    case "final":
      return [
        {
          type: "run/identity",
          runId: event.session_id,
          at
        },
        {
          type: "result/preview",
          at,
          preview: {
            status: event.status === "failed" || event.status === "stopped" ? "failed" : "ready",
            summary: firstLine(event.outcome?.final_summary ?? event.content),
            changedFiles: event.outcome?.changed_files ?? [],
            checks: (event.outcome?.tests_run ?? []).map((command) => ({ command, status: "unknown" })),
            artifacts: event.outcome?.intermediate_artifacts?.length
              ? event.outcome.intermediate_artifacts
              : event.artifact_path ? [event.artifact_path] : [],
            confidence: event.status === "failed" ? "medium" : "high",
            nextActions: event.status === "failed" ? ["/output", "/continue"] : ["/diff", "/commit"]
          }
        },
        ...(context.latestResultCard ? [{ type: "result/final", card: context.latestResultCard, at } satisfies RunBoardAction] : []),
        { type: "run/phase", phase: event.status === "failed" || event.status === "stopped" ? "failed" : "done", at }
      ];
    case "queue":
      return [
        mainWorkerAction(event.message ?? `${event.queue} ${event.operation} size=${event.size}`, at, event.session_id)
      ];
    case "progress":
      return [
        mainWorkerAction(`progress ${event.completed}/${event.total}`, at)
      ];
    default:
      return [];
  }
}

function workerRecordActions(
  worker: Extract<RuntimeEvent, { type: "worker" }>["worker"],
  status: string,
  at: string,
  message?: string
): RunBoardAction[] {
  const normalized = workerStatus(status, worker.blocked_reason);
  const label = roleLabel(worker.agent_spec_id ?? worker.role_title ?? worker.capability, worker.display_name);
  const evidence: RunBoardEvidence = {
    id: evidenceId("worker", `${worker.worker_id}:${status}`, at),
    kind: "worker",
    summary: compactSummary(message ?? worker.last_result ?? worker.objective, worker.objective),
    at,
    workerId: worker.worker_id,
    workerLabel: label,
    status: normalized === "failed" ? "failed" : normalized === "done" ? "success" : "running"
  };
  return [
    evidenceAction(evidence),
    {
      type: "worker/upsert",
      at,
      worker: {
        id: workerIdFor(worker.worker_id),
        label,
        role: roleFromText(`${worker.agent_spec_id ?? ""} ${worker.role_title ?? ""} ${worker.capability}`),
        status: normalized,
        currentAction: worker.blocked_reason ?? compactSummary(message ?? worker.objective, "working"),
        lastEvidenceId: evidence.id,
        owns: worker.file_scope,
        risk: worker.blocked_reason ? "medium" : normalized === "failed" ? "high" : "low",
        canStop: normalized === "active" || normalized === "waiting",
        canRetry: normalized === "failed",
        canTakeBack: Boolean(worker.handoff_id && normalized !== "done"),
        sourceIds: {
          workerId: worker.worker_id,
          handoffId: worker.handoff_id,
          sessionId: worker.parent_session_id,
          agentSpecId: worker.agent_spec_id
        }
      }
    },
    ...(worker.blocked_reason
      ? [attentionAction({
          id: `worker:${worker.worker_id}:blocked`,
          kind: "blocked",
          severity: "blocking",
          title: `${roleLabel(worker.agent_spec_id ?? worker.role_title ?? worker.capability, worker.display_name)} blocked`,
          summary: worker.blocked_reason,
          recommendation: "Inspect the worker evidence, then continue, retry, or take back the work.",
          subjectWorkerId: workerIdFor(worker.worker_id),
          evidenceIds: [evidence.id],
          at
        })]
      : [])
  ];
}

function loopActivityActions(event: Extract<RuntimeEvent, { type: "loop_activity" }>, at: string): RunBoardAction[] {
  const workerId = event.agent?.worker_id ? workerIdFor(event.agent.worker_id) : "main";
  const status = loopStatus(event.phase);
  const label = event.agent ? roleLabel(event.agent.agent_spec_id ?? event.agent.role_title ?? event.agent.capability ?? event.agent.role, event.agent.display_name) : "Main Swarm";
  const evidence = {
    id: evidenceId("loop", `${event.session_id}:${event.phase}:${event.task_id ?? ""}`, at),
    kind: event.tool ? "command" : "action",
    summary: event.summary ?? event.message,
    command: event.tool,
    at,
    workerId: event.agent?.worker_id,
    workerLabel: label,
    taskId: event.task_id,
    status: status === "failed" ? "failed" : status === "done" ? "success" : status === "blocked" ? "pending" : "running"
  } satisfies RunBoardEvidence;
  const actions: RunBoardAction[] = [
    evidenceAction(evidence),
    {
      type: "worker/upsert",
      at,
      worker: {
        id: workerId,
        label,
        role: event.agent ? roleFromText(`${event.agent.agent_spec_id ?? ""} ${event.agent.capability ?? ""} ${event.agent.role ?? ""}`) : "main",
        status,
        currentAction: event.summary ?? event.message,
        lastEvidenceId: evidence.id,
        canStop: status === "active",
        canRetry: status === "failed",
        risk: status === "failed" ? "high" : status === "blocked" ? "medium" : "low",
        sourceIds: {
          workerId: event.agent?.worker_id,
          taskId: event.task_id,
          sessionId: event.session_id,
          agentSpecId: event.agent?.agent_spec_id
        }
      }
    }
  ];
  if (event.phase === "waiting_approval") {
    actions.push(attentionAction({
      id: `loop:${event.session_id}:waiting-approval`,
      kind: "approval",
      severity: "blocking",
      title: "Approval needed",
      summary: event.summary ?? event.message,
      recommendation: "Review the approval request before allowing the run to continue.",
      subjectWorkerId: workerId,
      evidenceIds: [evidence.id],
      at
    }));
  } else if (event.phase === "failed") {
    actions.push(attentionAction({
      id: `loop:${event.session_id}:failed`,
      kind: "failed",
      severity: "failed",
      title: "Run step failed",
      summary: event.summary ?? event.message,
      recommendation: event.recoverySuggestion ?? "Inspect the failure output, patch the cause, then retry.",
      subjectWorkerId: workerId,
      evidenceIds: [evidence.id],
      at
    }));
  }
  return actions;
}

function toolResultActions(event: Extract<RuntimeEvent, { type: "tool_result" }>, at: string): RunBoardAction[] {
  const workerId = event.agent?.worker_id ? workerIdFor(event.agent.worker_id) : "main";
  const label = event.agent ? roleLabel(event.agent.agent_spec_id ?? event.agent.role_title ?? event.agent.capability ?? event.agent.role, event.agent.display_name) : "Main Swarm";
  const evidence = {
    id: evidenceId("tool", `${event.task_id}:${event.action}:${event.attempt ?? ""}`, at),
    kind: event.action === "shell" || event.title.toLowerCase().includes("command") ? "command" : "tool",
    summary: event.summary || event.title,
    command: event.action,
    at,
    workerId: event.agent?.worker_id,
    workerLabel: label,
    taskId: event.task_id,
    status: event.status === "failed" ? "failed" : event.status === "partial" ? "partial" : "success"
  } satisfies RunBoardEvidence;
  const actions: RunBoardAction[] = [
    evidenceAction(evidence),
    {
      type: "worker/upsert",
      at,
      worker: {
        id: workerId,
        label,
        role: event.agent ? roleFromText(`${event.agent.agent_spec_id ?? ""} ${event.agent.capability ?? ""} ${event.agent.role ?? ""}`) : "main",
        status: event.status === "failed" ? "failed" : "active",
        currentAction: event.summary || event.title,
        lastEvidenceId: evidence.id,
        risk: event.status === "failed" ? "high" : "low",
        canRetry: event.status === "failed",
        sourceIds: {
          workerId: event.agent?.worker_id,
          taskId: event.task_id,
          sessionId: event.session_id,
          agentSpecId: event.agent?.agent_spec_id
        }
      }
    }
  ];
  if (event.status === "failed") {
    actions.push(attentionAction({
      id: `tool:${event.task_id}:failed`,
      kind: "failed",
      severity: "failed",
      title: "Tool failed",
      summary: event.summary || event.title,
      recommendation: event.recoverySuggestion ?? "Open the tool output, fix the cause, then retry the step.",
      subjectWorkerId: workerId,
      evidenceIds: [evidence.id],
      at,
      actions: [
        { key: "v", label: "view output", enabled: true },
        { key: "r", label: "retry", enabled: true }
      ]
    }));
  }
  return actions;
}

function mainWorkerAction(currentAction: string, at: string, sessionId?: string): RunBoardAction {
  return {
    type: "worker/upsert",
    at,
    worker: {
      id: "main",
      label: "Main Swarm",
      role: "main",
      status: "active",
      currentAction,
      sourceIds: { sessionId }
    }
  };
}

function evidenceAction(evidence: RunBoardEvidence): RunBoardAction {
  return { type: "evidence/append", evidence };
}

function attentionAction(input: {
  id: string;
  kind: RunBoardAction extends never ? never : Parameters<typeof attentionKindIdentity>[0];
  severity: "info" | "warning" | "blocking" | "failed";
  title: string;
  summary: string;
  recommendation: string;
  at: string;
  subjectWorkerId?: string;
  evidenceIds?: string[];
  actions?: Array<{ key: string; label: string; command?: string; enabled?: boolean }>;
  resolvedAt?: string;
  resolution?: string;
}): RunBoardAction {
  return {
    type: "attention/upsert",
    at: input.at,
    item: {
      id: input.id,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      subjectWorkerId: input.subjectWorkerId,
      summary: input.summary,
      evidenceIds: input.evidenceIds,
      recommendation: input.recommendation,
      actions: input.actions,
      resolvedAt: input.resolvedAt,
      resolution: input.resolution
    }
  };
}

function attentionKindIdentity(kind: "slow" | "blocked" | "conflicted" | "uncertain" | "failed" | "approval"): typeof kind {
  return kind;
}

function eventTimestamp(event: RuntimeEvent): string | undefined {
  if (event.type === "worker") return event.worker.updated_at;
  if (event.type === "agent_run_started" || event.type === "agent_run_completed") return event.worker.updated_at;
  if (event.type === "handoff_started" || event.type === "handoff_returned" || event.type === "handoff_taken_back") return event.handoff.updated_at;
  return undefined;
}

function sessionPhase(status: Extract<RuntimeEvent, { type: "session" }>["status"]): RunBoardAction extends never ? never : "planning" | "working" | "reviewing" | "done" | "failed" {
  if (status === "planning") return "planning";
  if (status === "reviewing") return "reviewing";
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled") return "failed";
  return "working";
}

function sessionStatusAction(status: Extract<RuntimeEvent, { type: "session" }>["status"]): string {
  switch (status) {
    case "planning": return "planning next steps";
    case "reviewing": return "reviewing result";
    case "completed": return "run completed";
    case "failed": return "run failed";
    case "cancelled": return "run stopped";
    default: return "coordinating run";
  }
}

function workerStatus(status: string, blockedReason?: string): WorkerBoardStatus {
  if (blockedReason) return "blocked";
  if (status === "pending") return "queued";
  if (status === "running") return "active";
  if (status === "completed") return "done";
  if (status === "failed" || status === "stopped") return "failed";
  return "active";
}

function taskStatus(status: string): WorkerBoardStatus {
  const normalized = status.toLowerCase();
  if (normalized.includes("block")) return "blocked";
  if (normalized.includes("fail") || normalized.includes("cancel")) return "failed";
  if (normalized.includes("complete") || normalized.includes("done")) return "done";
  if (normalized.includes("pending") || normalized.includes("queue")) return "queued";
  if (normalized.includes("wait")) return "waiting";
  return "active";
}

function attemptStatus(status: "started" | "completed" | "failed"): WorkerBoardStatus {
  if (status === "started") return "active";
  if (status === "completed") return "done";
  return "failed";
}

function loopStatus(phase: Extract<RuntimeEvent, { type: "loop_activity" }>["phase"]): WorkerBoardStatus {
  if (phase === "waiting_approval") return "blocked";
  if (phase === "turn_complete" || phase === "completed") return "done";
  if (phase === "failed" || phase === "stopped") return "failed";
  return "active";
}

function riskFromWritePolicy(policy: "read_only" | "scoped_write" | "workspace_write" | undefined): RunBoardRisk {
  if (policy === "workspace_write") return "medium";
  if (policy === "scoped_write") return "medium";
  return "low";
}

function roleFromText(value: string | undefined): WorkerBoardRole {
  const normalized = (value ?? "").toLowerCase();
  if (/\b(test|verify|verification|runner)\b/u.test(normalized)) return "test";
  if (/\b(review|critic|quality)\b/u.test(normalized)) return "review";
  if (/\b(research|search)\b/u.test(normalized)) return "research";
  if (/\b(memory|freshness|context)\b/u.test(normalized)) return "memory";
  if (/\b(code|coder|coding|implement|edit|patch)\b/u.test(normalized)) return "code";
  return "custom";
}

function roleLabel(source: string | undefined, fallback: string | undefined): string {
  const role = roleFromText(`${source ?? ""} ${fallback ?? ""}`);
  switch (role) {
    case "test": return "Test Runner";
    case "review": return "Reviewer";
    case "research": return "Researcher";
    case "memory": return "Memory Checker";
    case "code": return "Code Worker";
    default: return sanitizeLabel(fallback ?? source ?? "Worker");
  }
}

function sanitizeLabel(value: string): string {
  const compact = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return "Worker";
  if (/^(worker|agent|task)\b/i.test(compact)) return "Worker";
  return compact
    .split(" ")
    .slice(0, 3)
    .map((part) => part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : "")
    .join(" ");
}

function approvalSummary(event: Extract<RuntimeEvent, { type: "approval" }>): string {
  const request = event.request as { action?: string; tool?: string; command?: string; risk?: string; summary?: string };
  return request.summary ?? request.command ?? request.action ?? request.tool ?? `Approval ${event.status}`;
}

function workerIdFor(workerId: string): string {
  return `worker:${workerId}`;
}

function taskWorkerId(taskId: string): string {
  return `task:${taskId}`;
}

function evidenceId(kind: string, key: string, at: string): string {
  return `${kind}:${key}:${at}`.replace(/\s+/g, "-");
}

function compactSummary(value: string | undefined, fallback: string): string {
  return firstLine(value ?? fallback) || fallback;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
}
