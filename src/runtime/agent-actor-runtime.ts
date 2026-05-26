import { createEnvelope } from "../protocol/envelope.js";
import type { AgentAddress, AgentCard, SwarmEnvelope } from "../protocol/types.js";
import type { AgentActorKind, AgentActorRecord, AgentActorStatus, AgentMailboxProjection } from "../storage/agent-actor-store.js";
import { AgentActorStore } from "../storage/agent-actor-store.js";
import type { EnvelopeDeliveryRecord } from "../storage/envelope-delivery-store.js";
import { RuntimeEvents } from "./events.js";
import type { MailboxDeliveryPump, MailboxDeliveryPumpResult } from "./mailbox-delivery-pump.js";
import { AgentRegistry } from "./registry.js";

export type AgentActorRuntimeRegisterInput = {
  actor_id: string;
  kind: AgentActorKind;
  name: string;
  role: string;
  capabilities?: string[];
  status?: AgentActorStatus;
  max_tasks?: number;
  metadata?: Record<string, unknown>;
  now?: string;
};

export type AgentActorRuntimeSnapshot = {
  actor: AgentActorRecord;
  mailbox: AgentMailboxProjection;
};

export type AgentActorRunnerLifecycle = "idle" | "polling" | "working" | "blocked" | "sleeping" | "terminated";

export type AgentActorRunnerEmit = (envelope: SwarmEnvelope) => void | Promise<void>;

export type AgentActorRunnerHandler = (input: {
  actor: AgentActorRecord;
  envelope: SwarmEnvelope;
  delivery: EnvelopeDeliveryRecord;
  emit: AgentActorRunnerEmit;
}) => Promise<SwarmEnvelope | void> | SwarmEnvelope | void;

export type AgentActorExecutionLoopOptions = {
  actor_id: string;
  pump: MailboxDeliveryPump;
  handler?: AgentActorRunnerHandler;
  emit?: AgentActorRunnerEmit;
  now?: string;
};

export type AgentActorExecutionLoopResult = {
  actor_id: string;
  lifecycle: AgentActorRunnerLifecycle;
  handled: number;
  terminal_results: number;
  terminal_failures: number;
  pump: MailboxDeliveryPumpResult;
};

export type LegacyDirectInvokeTelemetryInput = {
  worker_id: string;
  worker_actor_id: string;
  parent_session_id?: string;
  agent_spec_id?: string;
  invocation_mode?: string;
  assignment_envelope_id?: string;
};

export class AgentActorRuntime {
  constructor(
    private readonly actors: AgentActorStore,
    private readonly registry?: AgentRegistry,
    private readonly events?: RuntimeEvents
  ) {}

  register(input: AgentActorRuntimeRegisterInput): AgentActorRecord {
    const card = cardFromRegisterInput(input);
    this.registry?.register(card);
    const actor = this.actors.registerSystemActor(input);
    this.events?.emitEvent({ type: "log", level: "info", message: `Agent actor registered: ${actor.actor_id}` });
    return actor;
  }

  recover(options: { now?: string; staleAfterMs?: number; offlineAfterMs?: number } = {}): AgentActorRecord[] {
    return this.actors.list(options).map((actor) => this.actors.get(actor.actor_id, options) ?? actor);
  }

  heartbeat(
    actorId: string,
    input: {
      status?: AgentActorStatus;
      current_task_id?: string | null;
      current_worker_id?: string | null;
      current_session_id?: string | null;
      current_ownership?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
      now?: string;
    } = {}
  ): AgentActorRecord | undefined {
    const actor = this.actors.heartbeat(actorId, input);
    if (actor) {
      this.registry?.updateStatus(actorId, actor.status === "draining" ? "busy" : actor.status);
    }
    return actor;
  }

  pause(actorId: string, reason: string, input: { now?: string } = {}): AgentActorRecord | undefined {
    return this.actors.updateStatus(actorId, "draining", {
      now: input.now,
      metadata: { blocked_reason: reason, paused_reason: reason }
    });
  }

  terminate(actorId: string, reason: string, input: { now?: string } = {}): AgentActorRecord | undefined {
    const actor = this.actors.updateStatus(actorId, "offline", {
      now: input.now,
      metadata: { terminated_reason: reason }
    });
    this.registry?.updateStatus(actorId, "offline");
    return actor;
  }

  snapshot(actorId: string): AgentActorRuntimeSnapshot | undefined {
    const actor = this.actors.get(actorId);
    return actor ? { actor, mailbox: this.actors.mailbox(actorId) } : undefined;
  }

  async runExecutionLoop(options: AgentActorExecutionLoopOptions): Promise<AgentActorExecutionLoopResult> {
    const actor = this.actors.get(options.actor_id, { now: options.now });
    if (!actor) {
      throw new Error(`Unknown actor: ${options.actor_id}`);
    }
    if (actor.status === "offline") {
      this.heartbeat(options.actor_id, {
        status: "offline",
        metadata: { runner_lifecycle: "terminated" },
        now: options.now
      });
      return {
        actor_id: options.actor_id,
        lifecycle: "terminated",
        handled: 0,
        terminal_results: 0,
        terminal_failures: 0,
        pump: emptyPumpResult(options.actor_id)
      };
    }

    this.heartbeat(options.actor_id, {
      status: "idle",
      metadata: {
        runner_lifecycle: "polling",
        blocked_reason: ""
      },
      now: options.now
    });

    const handler = options.handler ?? deterministicActorRunner;
    const emit = options.emit ?? (() => undefined);
    let handled = 0;
    let terminalResults = 0;
    let terminalFailures = 0;
    let lastFailure: string | undefined;

    const pumpResult = await options.pump.pumpActor(options.actor_id, async (envelope, delivery) => {
      const currentActor = this.actors.get(options.actor_id, { now: options.now }) ?? actor;
      this.heartbeat(options.actor_id, {
        status: "busy",
        current_task_id: envelope.task_id ?? null,
        current_session_id: envelope.session_id,
        current_ownership: {
          envelope_id: envelope.id,
          delivery_id: delivery.delivery_id,
          intent: envelope.intent,
          runner_lifecycle: "working"
        },
        metadata: {
          runner_lifecycle: "working",
          runner_delivery_id: delivery.delivery_id,
          runner_envelope_id: envelope.id,
          blocked_reason: ""
        },
        now: options.now
      });

      handled += 1;
      const response = await handler({
        actor: currentActor,
        envelope,
        delivery,
        emit
      });
      if (response && isTerminalResponse(response)) {
        terminalResults += 1;
        if (response.type === "task.fail" || response.type === "error") {
          terminalFailures += 1;
          lastFailure = failureMessage(response);
        }
      }
      return response;
    });

    if (pumpResult.failed > 0) {
      const message = lastFailure ?? "Actor execution loop failed while processing mailbox delivery.";
      this.heartbeat(options.actor_id, {
        status: "degraded",
        current_task_id: null,
        current_worker_id: null,
        current_session_id: null,
        current_ownership: null,
        metadata: {
          runner_lifecycle: "blocked",
          blocked_reason: message
        },
        now: options.now
      });
      return {
        actor_id: options.actor_id,
        lifecycle: "blocked",
        handled,
        terminal_results: terminalResults,
        terminal_failures: terminalFailures,
        pump: pumpResult
      };
    }

    if (terminalFailures > 0) {
      this.heartbeat(options.actor_id, {
        status: "degraded",
        current_task_id: null,
        current_worker_id: null,
        current_session_id: null,
        current_ownership: null,
        metadata: {
          runner_lifecycle: "blocked",
          blocked_reason: lastFailure ?? "Actor returned a terminal failure."
        },
        now: options.now
      });
      return {
        actor_id: options.actor_id,
        lifecycle: "blocked",
        handled,
        terminal_results: terminalResults,
        terminal_failures: terminalFailures,
        pump: pumpResult
      };
    }

    this.heartbeat(options.actor_id, {
      status: "idle",
      current_task_id: null,
      current_worker_id: null,
      current_session_id: null,
      current_ownership: null,
      metadata: {
        runner_lifecycle: handled > 0 ? "idle" : "sleeping",
        blocked_reason: ""
      },
      now: options.now
    });
    return {
      actor_id: options.actor_id,
      lifecycle: handled > 0 ? "idle" : "sleeping",
      handled,
      terminal_results: terminalResults,
      terminal_failures: terminalFailures,
      pump: pumpResult
    };
  }
}

export const deterministicActorRunner: AgentActorRunnerHandler = async ({ actor, envelope, emit }) => {
  const payload = recordPayload(envelope.payload);
  const failure = deterministicFailureMessage(payload);
  if (failure) {
    return createActorResponse(actor, envelope, "task.fail", "actor.runner.failed", {
      status: "failed",
      summary: failure,
      message: failure,
      error: failure,
      worker_id: stringField(payload.worker_id),
      owner_agent_id: actor.actor_id,
      protocol: "actor_execution_loop",
      runner: "deterministic",
      recoverable: true
    });
  }

  if (envelope.type === "review.request") {
    return createActorResponse(actor, envelope, "review.result", "actor.review.completed", {
      verdict: "approve",
      score: 1,
      summary: deterministicSummary(actor, envelope, payload),
      protocol: "actor_execution_loop",
      runner: "deterministic"
    });
  }

  if (envelope.type === "handoff.request") {
    return createActorResponse(actor, envelope, "handoff.return", "actor.handoff.returned", {
      status: "returned",
      summary: deterministicSummary(actor, envelope, payload),
      result: deterministicSummary(actor, envelope, payload),
      owner_agent_id: actor.actor_id,
      handoff_id: stringField(payload.handoff_id),
      worker_id: stringField(payload.worker_id),
      protocol: "actor_execution_loop",
      runner: "deterministic"
    });
  }

  if (envelope.type === "task.assign") {
    await emit(createActorResponse(actor, envelope, "task.accept", "actor.runner.accepted", {
      status: "accepted",
      summary: `Deterministic actor ${actor.actor_id} accepted ${envelope.task_id ?? envelope.id}.`,
      worker_id: stringField(payload.worker_id),
      owner_agent_id: actor.actor_id,
      protocol: "actor_execution_loop",
      runner: "deterministic"
    }));
    await emit(createActorResponse(actor, envelope, "task.progress", "actor.runner.progress", {
      status: "running",
      summary: `Deterministic actor ${actor.actor_id} processed ${envelope.task_id ?? envelope.id}.`,
      worker_id: stringField(payload.worker_id),
      owner_agent_id: actor.actor_id,
      protocol: "actor_execution_loop",
      runner: "deterministic"
    }));
    return createActorResponse(actor, envelope, "task.result", "actor.runner.completed", {
      status: "completed",
      summary: deterministicSummary(actor, envelope, payload),
      content: deterministicContent(envelope, payload),
      worker_id: stringField(payload.worker_id),
      owner_agent_id: actor.actor_id,
      protocol: "actor_execution_loop",
      runner: "deterministic"
    });
  }

  return undefined;
};

export function formatLegacyDirectInvokeAdapterTelemetry(input: LegacyDirectInvokeTelemetryInput): string {
  return [
    `Legacy direct invoke adapter fallback: ${input.worker_actor_id} is still executed by the main runtime after mailbox assignment.`,
    "protocol=local_worker_actor_adapter",
    `worker_id=${input.worker_id}`,
    input.parent_session_id ? `session_id=${input.parent_session_id}` : undefined,
    input.agent_spec_id ? `agent_spec_id=${input.agent_spec_id}` : undefined,
    input.invocation_mode ? `invocation_mode=${input.invocation_mode}` : undefined,
    input.assignment_envelope_id ? `assignment_envelope_id=${input.assignment_envelope_id}` : undefined
  ].filter((part): part is string => typeof part === "string").join(" ");
}

export function emitLegacyDirectInvokeAdapterTelemetry(events: RuntimeEvents, input: LegacyDirectInvokeTelemetryInput): void {
  events.emitEvent({
    type: "log",
    level: "warn",
    message: formatLegacyDirectInvokeAdapterTelemetry(input)
  });
}

function cardFromRegisterInput(input: AgentActorRuntimeRegisterInput): AgentCard {
  return {
    agent_id: input.actor_id,
    name: input.name,
    role: input.role,
    capabilities: input.capabilities ?? [],
    status: input.status === "draining" ? "busy" : input.status ?? "idle",
    load: { running_tasks: input.status === "busy" ? 1 : 0, max_tasks: input.max_tasks ?? 1 },
    reliability: { success_rate: 1, avg_latency_ms: 0 },
    metadata: { ...(input.metadata ?? {}), kind: input.kind }
  };
}

function createActorResponse(
  actor: AgentActorRecord,
  request: SwarmEnvelope,
  type: SwarmEnvelope["type"],
  intent: string,
  payload: Record<string, unknown>
): SwarmEnvelope {
  return createEnvelope({
    swarm_id: request.swarm_id,
    session_id: request.session_id,
    task_id: request.task_id,
    subtask_id: request.subtask_id,
    attempt: request.attempt,
    from: actorAddress(actor, request),
    to: request.from,
    type,
    intent,
    payload,
    reply_to: request.id,
    correlation_id: request.correlation_id ?? request.id,
    trace: {
      trace_id: request.trace?.trace_id ?? request.correlation_id ?? request.id,
      span_id: `span_actor_runner_${type.replace(/[^a-z0-9]+/gi, "_")}_${Date.now()}`,
      parent_span_id: request.trace?.span_id
    }
  });
}

function actorAddress(actor: AgentActorRecord, request: SwarmEnvelope): AgentAddress {
  const addressed = Array.isArray(request.to)
    ? request.to.find((address) => address.agent_id === actor.actor_id)
    : request.to;
  return {
    agent_id: actor.actor_id,
    role: actor.role,
    capability: addressed?.capability ?? actor.capabilities[0]
  };
}

function deterministicSummary(actor: AgentActorRecord, envelope: SwarmEnvelope, payload: Record<string, unknown>): string {
  const objective = stringField(payload.objective) ?? stringField(recordPayload(payload.task_packet).objective);
  return objective
    ? `Deterministic actor ${actor.actor_id} completed: ${objective}`
    : `Deterministic actor ${actor.actor_id} completed ${envelope.task_id ?? envelope.id}.`;
}

function deterministicContent(envelope: SwarmEnvelope, payload: Record<string, unknown>): string {
  return stringField(payload.content) ??
    stringField(payload.objective) ??
    `Processed ${envelope.type} ${envelope.task_id ?? envelope.id} from inbox.`;
}

function deterministicFailureMessage(payload: Record<string, unknown>): string | undefined {
  if (payload.fail === true || payload.deterministic_status === "failed" || payload.status === "failed") {
    return stringField(payload.fail_reason) ?? stringField(payload.failReason) ?? "Deterministic actor runner returned failure.";
  }
  return stringField(payload.fail_reason) ?? stringField(payload.failReason);
}

function isTerminalResponse(envelope: SwarmEnvelope): boolean {
  return envelope.type === "task.result" ||
    envelope.type === "task.fail" ||
    envelope.type === "task.cancel" ||
    envelope.type === "review.result" ||
    envelope.type === "handoff.return" ||
    envelope.type === "error";
}

function failureMessage(envelope: SwarmEnvelope): string {
  const payload = recordPayload(envelope.payload);
  return stringField(payload.message) ?? stringField(payload.error) ?? stringField(payload.summary) ?? envelope.intent;
}

function emptyPumpResult(actorId: string): MailboxDeliveryPumpResult {
  return {
    actor_id: actorId,
    delivered: 0,
    acked: 0,
    failed: 0,
    expired: 0,
    missing: 0,
    deferred: 0,
    sleeping: 0,
    rejected: 0
  };
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
