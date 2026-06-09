import type { AgentTaskPacket } from "./agent-specs.js";
import { finalAttemptStatus } from "./execution-status.js";
import type { RuntimeEvent } from "./events.js";
import { approvalEnvelopeForGovernance, approvalEnvelopeForRequest } from "./safety-governance.js";
import type { AuditStore } from "../storage/audit-store.js";
import type { ApprovalStore } from "../storage/approval-store.js";
import type { RunAttemptStore } from "../storage/run-attempt-store.js";
import type { SessionContextStore } from "../storage/session-context-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { TaskGraphStore } from "../storage/task-graph-store.js";
import type { UsageStore } from "../storage/usage-store.js";
import { normalizeToolAction } from "../tools/local-tools.js";
import { riskClassForAction } from "../tools/permissions.js";
import type { RiskClass, RunAttemptStatus, SwarmEnvelope } from "../protocol/types.js";
import type { ProviderUsageReport } from "../providers/openai-provider.js";

export type RuntimeEventPersisterInput = {
  taskGraphStore: Pick<TaskGraphStore, "storePlan" | "upsertSyntheticTool">;
  approvalStore: Pick<ApprovalStore, "upsert">;
  sessionStore: Pick<SessionStore, "get" | "updateMetadata" | "setFinalOutcome">;
  usageStore: Pick<UsageStore, "append">;
  auditStore: Pick<AuditStore, "append">;
  sessionContextStore: Pick<SessionContextStore, "append" | "compact">;
  runAttemptStore: Pick<RunAttemptStore, "upsert">;
  router: { receive(envelope: SwarmEnvelope): void };
  workspaceForSession: (sessionId: string) => string;
  activeSessionId: () => string | undefined;
  recordProviderUsage: (usage: ProviderUsageReport) => void;
  isDisposed?: () => boolean;
  logger?: { warn(section: string, message: string): void };
};

export class RuntimeEventPersister {
  constructor(private readonly input: RuntimeEventPersisterInput) {}

  record(event: RuntimeEvent): void {
    if (this.input.isDisposed?.()) {
      return;
    }
    try {
      this.recordUnsafe(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.input.logger?.warn("runtime", `failed to persist runtime event ${event.type}: ${message}`);
    }
  }

  private recordUnsafe(event: RuntimeEvent): void {
    if (event.type === "plan") {
      this.input.taskGraphStore.storePlan(event.session_id, event.plan);
      return;
    }
    if (event.type === "approval") {
      this.input.approvalStore.upsert(event.request, event.status);
      const approvalEnvelope = approvalEnvelopeForRequest(event.request, event.status, {
        actor_id: event.status === "pending" ? "policy_engine" : "local_user",
        actor_role: event.status === "pending" ? "policy" : "operator",
        decision_source: event.status === "pending" ? "runtime.approval.request" : "runtime.approval.decision",
        swarm_id: event.request.session_id ? this.input.sessionStore.get(event.request.session_id)?.swarm_id : undefined
      });
      if (approvalEnvelope) {
        this.input.router.receive(approvalEnvelope);
      }
      this.input.usageStore.append({
        session_id: event.request.session_id,
        task_id: event.request.task_id,
        kind: "approval",
        amount: 1,
        unit: "count",
        metadata: {
          status: event.status,
          action: event.request.action,
          risk_class: event.request.risk_class,
          governance: event.request.governance,
          approval_envelope_id: approvalEnvelope?.id
        }
      });
      this.input.auditStore.append({
        session_id: event.request.session_id,
        task_id: event.request.task_id,
        actor_type: event.status === "pending" ? "policy" : "user",
        actor_id: event.status === "pending" ? "policy_engine" : "local_user",
        action: event.request.action,
        resource: event.request,
        risk_class: event.request.risk_class,
        decision: event.status === "pending" ? "requested" : event.status,
        reason: event.request.why_now
      });
      return;
    }
    if (event.type === "governance") {
      const governanceEnvelope = event.envelope ?? approvalEnvelopeForGovernance(event.governance);
      if (governanceEnvelope) {
        this.input.router.receive(governanceEnvelope);
      }
      this.input.auditStore.append({
        session_id: event.governance.actor_binding.session_id,
        task_id: event.governance.actor_binding.task_id,
        actor_type: "policy",
        actor_id: event.governance.actor_id,
        action: event.governance.action,
        resource: { governance: event.governance, envelope_id: governanceEnvelope?.id },
        risk_class: event.governance.risk_class,
        decision: governanceAuditDecision(event.governance.status),
        reason: event.governance.policy_evidence.join("; ")
      });
      return;
    }
    if (event.type === "session") {
      if (event.parent_session_id) {
        this.input.sessionStore.updateMetadata(event.session_id, { parent_session_id: event.parent_session_id });
      }
      if (event.objective) {
        this.recordSessionContext(event.session_id, "objective", "user", event.objective, {
          status: event.status,
          parent_session_id: event.parent_session_id
        });
      }
      return;
    }
    if (event.type === "queue" && event.session_id) {
      this.recordSessionContext(event.session_id, "loop_activity", "system", `${event.queue} queue ${event.operation}: ${event.message ?? event.id ?? `size=${event.size}`}`, {
        queue: event.queue,
        operation: event.operation,
        id: event.id,
        size: event.size,
        priority: event.priority
      });
      return;
    }
    if (event.type === "task_attempt" && event.session_id) {
      this.recordSessionContext(event.session_id, "loop_activity", "system", `${event.status}: ${event.title}`, {
        task_id: event.task_id,
        attempt: event.attempt
      });
      this.input.runAttemptStore.upsert({
        session_id: event.session_id,
        task_id: event.task_id,
        runner_id: event.task_id.startsWith("worker_loop_") ? "worker" : event.task_id.startsWith("coding_turn") ? "main_swarm" : undefined,
        kind: event.task_id.startsWith("coding_turn") || event.task_id.includes("_turn_") ? "coding_turn" : "swarm_task",
        status: normalizeAttemptStatus(event.status),
        attempt: event.attempt,
        title: event.title,
        terminal_reason: event.status === "failed" ? event.title : undefined,
        workspace_path: this.input.workspaceForSession(event.session_id)
      });
      return;
    }
    if (event.type === "tool_result") {
      this.recordToolResult(event);
      return;
    }
    if (event.type === "provider_usage") {
      this.input.recordProviderUsage(event.usage);
      return;
    }
    if (event.type === "workspace_change") {
      this.recordSessionContext(event.session_id, "workspace_change", "tool", `${event.change.operation} ${event.change.path}`, {
        task_id: event.change.taskId,
        beforeHash: event.change.beforeHash,
        afterHash: event.change.afterHash
      });
      this.input.auditStore.append({
        session_id: event.session_id,
        task_id: event.change.taskId,
        trace_id: event.session_id,
        actor_type: "tool",
        actor_id: "tool.file",
        action: `file.${event.change.operation}`,
        resource: event.change,
        risk_class: "r1",
        decision: "executed",
        reason: `${event.change.operation} ${event.change.path}`
      });
      return;
    }
    if (event.type === "live_message" && event.session_id && event.status === "received") {
      this.recordSessionContext(event.session_id, "user", "user", event.content, {
        message_id: event.id
      });
      return;
    }
    if (event.type === "control") {
      const sessionId = this.input.activeSessionId();
      if (sessionId) {
        this.recordSessionContext(sessionId, "loop_activity", "system", `${event.action}: ${event.instruction}`, {
          message_id: event.message_id,
          reason: event.reason
        });
      }
      return;
    }
    if (event.type === "loop_activity") {
      this.recordSessionContext(event.session_id, "loop_activity", "system", event.message, {
        phase: event.phase,
        turn: event.turn,
        tool: event.tool,
        task_id: event.task_id,
        status: event.status,
        summary: event.summary,
        errorCode: event.errorCode,
        recoverySuggestion: event.recoverySuggestion
      });
      return;
    }
    if (event.type === "agent_run_started") {
      this.recordAgentRunStarted(event);
      return;
    }
    if (event.type === "agent_run_completed") {
      this.recordAgentRunCompleted(event);
      return;
    }
    if (event.type === "review_started" || event.type === "verification_started") {
      this.input.runAttemptStore.upsert({
        session_id: event.session_id,
        task_id: event.type === "review_started" ? "review.coding_loop" : "verification.coding_loop",
        runner_id: event.type === "review_started" ? "reviewer" : "verifier",
        kind: event.type === "review_started" ? "review" : "verification",
        status: "started",
        attempt: 1,
        title: event.objective,
        workspace_path: this.input.workspaceForSession(event.session_id)
      });
      return;
    }
    if (event.type === "review_completed") {
      this.recordSessionContext(event.session_id, "summary", "system", `Review: ${event.result.verdict} ${event.result.score} - ${event.result.summary}`, {
        target_task_id: event.result.target_task_id
      });
      this.input.runAttemptStore.upsert({
        session_id: event.session_id,
        task_id: "review.coding_loop",
        runner_id: "reviewer",
        kind: "review",
        status: event.result.verdict === "reject" ? "failed" : "completed",
        attempt: 1,
        title: "Post-change review",
        terminal_reason: event.result.summary,
        workspace_path: this.input.workspaceForSession(event.session_id),
        metadata: { result: event.result }
      });
      return;
    }
    if (event.type === "verification_completed") {
      this.recordSessionContext(event.session_id, "summary", "system", `Verification: ${event.result.status} - ${event.result.summary}`);
      this.input.runAttemptStore.upsert({
        session_id: event.session_id,
        task_id: "verification.coding_loop",
        runner_id: "verifier",
        kind: "verification",
        status: event.result.status === "failed" ? "failed" : "completed",
        attempt: 1,
        title: "Post-change verification",
        terminal_reason: event.result.summary,
        workspace_path: this.input.workspaceForSession(event.session_id),
        metadata: { result: event.result }
      });
      return;
    }
    if (event.type === "final") {
      this.recordSessionContext(event.session_id, "final", "assistant", event.content, {
        status: event.status ?? "completed",
        artifact_path: event.artifact_path,
        outcome: event.outcome
      });
      if (event.outcome) {
        this.input.sessionStore.setFinalOutcome(event.session_id, event.outcome);
      }
      this.input.runAttemptStore.upsert({
        session_id: event.session_id,
        task_id: "final",
        runner_id: "main_swarm",
        kind: event.session_id.startsWith("chat_") ? "chat_response" : "coding_turn",
        status: finalAttemptStatus(event.status),
        attempt: 0,
        title: "Final response",
        terminal_reason: event.outcome?.final_summary ?? firstLine(event.content),
        workspace_path: this.input.workspaceForSession(event.session_id),
        metadata: {
          artifact_path: event.artifact_path,
          outcome: event.outcome
        }
      });
    }
  }

  private recordToolResult(event: Extract<RuntimeEvent, { type: "tool_result" }>): void {
    if (event.session_id) {
      this.recordSessionContext(event.session_id, "tool_result", "tool", [
        `${event.action}: ${event.summary}`,
        event.content
      ].filter(Boolean).join("\n"), {
        task_id: event.task_id,
        status: event.status ?? "success",
        outputRef: event.outputRef,
        errorCode: event.errorCode,
        recoverySuggestion: event.recoverySuggestion,
        recovery: event.recovery
      });
      const row = this.input.sessionStore.get(event.session_id);
      this.input.taskGraphStore.upsertSyntheticTool({
        session_id: event.session_id,
        swarm_id: row?.swarm_id ?? `swarm_${event.session_id}`,
        task_id: event.task_id,
        title: event.title,
        action: event.action,
        status: event.status === "failed" ? "failed" : "completed",
        attempt: event.attempt,
        write_policy: event.write_policy,
        file_scope: event.file_scope
      });
      this.input.usageStore.append({
        session_id: event.session_id,
        task_id: event.task_id,
        kind: "tool_call",
        amount: 1,
        unit: "count",
        metadata: {
          action: event.action,
          status: event.status ?? "success",
          summary: event.summary,
          capability_id: event.capability?.id,
          provider_id: event.capability?.providerId,
          permission: event.capability?.permissionName
        }
      });
      this.input.auditStore.append({
        session_id: event.session_id,
        task_id: event.task_id,
        trace_id: event.session_id,
        actor_type: "tool",
        actor_id: event.action,
        action: event.action,
        resource: {
          capability_id: event.capability?.id,
          provider_id: event.capability?.providerId,
          permission: event.capability?.permissionName,
          summary: event.summary,
          outputRef: event.outputRef,
          errorCode: event.errorCode,
          recoverySuggestion: event.recoverySuggestion,
          recovery: event.recovery
        },
        risk_class: event.capability?.riskClass ?? riskClassForActionName(event.action),
        decision: event.status === "failed" ? "failed" : "executed",
        reason: event.summary
      });
      this.input.runAttemptStore.upsert({
        session_id: event.session_id,
        task_id: event.task_id,
        runner_id: event.action,
        kind: "tool_call",
        status: event.status === "failed" ? "failed" : "completed",
        attempt: event.attempt ?? 0,
        title: event.title,
        terminal_reason: event.summary,
        workspace_path: this.input.workspaceForSession(event.session_id),
        error_code: event.errorCode,
        recovery_suggestion: event.recoverySuggestion,
        metadata: {
          ...(event.metadata ?? {}),
          action: event.action,
          summary: event.summary,
          capability_id: event.capability?.id,
          provider_id: event.capability?.providerId,
          permission: event.capability?.permissionName,
          outputRef: event.outputRef,
          recoverySuggestion: event.recoverySuggestion,
          recovery: event.recovery,
          status: event.status ?? "success"
        }
      });
    } else {
      this.input.usageStore.append({
        task_id: event.task_id,
        kind: "tool_call",
        amount: 1,
        unit: "count",
        metadata: {
          action: event.action,
          status: event.status ?? "success",
          summary: event.summary,
          capability_id: event.capability?.id,
          provider_id: event.capability?.providerId,
          permission: event.capability?.permissionName
        }
      });
      this.input.auditStore.append({
        task_id: event.task_id,
        actor_type: "tool",
        actor_id: event.action,
        action: event.action,
        resource: {
          capability_id: event.capability?.id,
          provider_id: event.capability?.providerId,
          permission: event.capability?.permissionName,
          summary: event.summary,
          outputRef: event.outputRef,
          errorCode: event.errorCode,
          recoverySuggestion: event.recoverySuggestion,
          recovery: event.recovery
        },
        risk_class: event.capability?.riskClass ?? riskClassForActionName(event.action),
        decision: event.status === "failed" ? "failed" : "executed",
        reason: event.summary
      });
    }
  }

  private recordAgentRunStarted(event: Extract<RuntimeEvent, { type: "agent_run_started" }>): void {
    this.recordSessionContext(event.worker.parent_session_id, "worker", "worker", `Started ${event.worker.worker_id}: ${event.worker.objective}`, {
      worker_id: event.worker.worker_id,
      agent_spec_id: event.worker.agent_spec_id,
      invocation_mode: event.worker.invocation_mode
    });
    this.input.runAttemptStore.upsert({
      session_id: event.worker.parent_session_id,
      task_id: event.worker.worker_id,
      runner_id: event.worker.agent_spec_id ?? event.worker.capability,
      kind: "worker_run",
      status: "started",
      attempt: 1,
      title: event.worker.objective,
      workspace_path: this.input.workspaceForSession(event.worker.parent_session_id),
      metadata: {
        worker_id: event.worker.worker_id,
        agent_spec_id: event.worker.agent_spec_id,
        invocation_mode: event.worker.invocation_mode,
        task_packet: stripEphemeralAgentPersona(event.task_packet)
      }
    });
    this.input.usageStore.append({
      session_id: event.worker.parent_session_id,
      task_id: event.worker.worker_id,
      kind: "worker_spawn",
      amount: 1,
      unit: "count",
      metadata: { agent_spec_id: event.worker.agent_spec_id, capability: event.worker.capability }
    });
    this.input.auditStore.append({
      session_id: event.worker.parent_session_id,
      task_id: event.worker.worker_id,
      trace_id: event.worker.parent_session_id,
      actor_type: "runtime",
      actor_id: "main_swarm",
      action: "agent.spawn",
      resource: { worker_id: event.worker.worker_id, task_packet: stripEphemeralAgentPersona(event.task_packet) },
      risk_class: "r1",
      decision: "executed",
      reason: event.worker.spawn_reason
    });
  }

  private recordAgentRunCompleted(event: Extract<RuntimeEvent, { type: "agent_run_completed" }>): void {
    this.recordSessionContext(event.worker.parent_session_id, "worker", "worker", `Completed ${event.worker.worker_id}: ${event.result}`, {
      worker_id: event.worker.worker_id,
      status: event.worker.status
    });
    this.input.runAttemptStore.upsert({
      session_id: event.worker.parent_session_id,
      task_id: event.worker.worker_id,
      runner_id: event.worker.agent_spec_id ?? event.worker.capability,
      kind: "worker_run",
      status: event.worker.status === "failed" ? "failed" : event.worker.status === "stopped" ? "stopped" : "completed",
      attempt: 1,
      title: event.worker.objective,
      terminal_reason: firstLine(event.result),
      workspace_path: this.input.workspaceForSession(event.worker.parent_session_id),
      metadata: {
        result: event.result,
        outcome: event.worker.outcome
      }
    });
  }

  private recordSessionContext(
    sessionId: string | undefined,
    kind: Parameters<SessionContextStore["append"]>[0]["kind"],
    role: Parameters<SessionContextStore["append"]>[0]["role"],
    content: string | undefined,
    metadata: Record<string, unknown> = {}
  ): void {
    const normalizedSessionId = sessionId?.trim();
    const normalizedContent = content?.trim();
    if (!normalizedSessionId || !normalizedContent) {
      return;
    }
    this.input.sessionContextStore.append({
      session_id: normalizedSessionId,
      kind,
      role,
      content: normalizedContent,
      metadata
    });
    this.input.sessionContextStore.compact(normalizedSessionId);
  }
}

function stripEphemeralAgentPersona(taskPacket: AgentTaskPacket): AgentTaskPacket {
  const { persona_brief: _personaBrief, ...durableTaskPacket } = taskPacket;
  return durableTaskPacket;
}

function normalizeAttemptStatus(status: "started" | "completed" | "failed"): RunAttemptStatus {
  return status === "started" ? "started" : status === "failed" ? "failed" : "completed";
}

function riskClassForActionName(action: string): RiskClass {
  try {
    return riskClassForAction(normalizeToolAction({ action }));
  } catch {
    if (action.startsWith("file.write") || action.startsWith("file.edit")) return "r1";
    if (action.includes("shell") || action.includes("package") || action.includes("fetch")) return "r2";
    return "r0";
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 240) ?? "";
}

function governanceAuditDecision(status: "requested" | "granted" | "denied" | "evidence"): "requested" | "approved" | "denied" | "executed" {
  if (status === "granted") {
    return "approved";
  }
  if (status === "evidence") {
    return "executed";
  }
  return status;
}
