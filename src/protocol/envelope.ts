import { randomUUID } from "node:crypto";
import type { AgentAddress, SwarmEnvelope, SwarmMessageType } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

const IDEMPOTENT_TYPES = new Set([
  "task.assign",
  "task.result",
  "artifact.create",
  "blackboard.write"
]);

export function createEnvelope<T>(input: {
  swarm_id: string;
  session_id: string;
  task_id?: string;
  subtask_id?: string;
  from: AgentAddress;
  to: AgentAddress | AgentAddress[];
  type: SwarmMessageType;
  intent: string;
  payload: T;
  correlation_id?: string;
  reply_to?: string;
  idempotency_key?: string;
  ttl_ms?: number;
  priority?: "low" | "normal" | "high" | "critical";
  routing?: {
    mode: "direct" | "broadcast" | "any" | "all" | "role" | "capability";
    require_ack?: boolean;
    retry?: {
      max_attempts: number;
      backoff_ms: number;
    };
  };
}): SwarmEnvelope<T> {
  const idempotencyKey =
    input.idempotency_key ??
    (IDEMPOTENT_TYPES.has(input.type)
      ? `${input.swarm_id}:${input.session_id}:${input.task_id ?? "notask"}:${input.type}`
      : undefined);

  return {
    id: `env_${randomUUID()}`,
    version: "1.0",
    swarm_id: input.swarm_id,
    session_id: input.session_id,
    task_id: input.task_id,
    subtask_id: input.subtask_id,
    from: input.from,
    to: input.to,
    type: input.type,
    intent: input.intent,
    correlation_id: input.correlation_id,
    reply_to: input.reply_to,
    idempotency_key: idempotencyKey,
    created_at: nowIso(),
    ttl_ms: input.ttl_ms,
    priority: input.priority ?? "normal",
    routing: input.routing,
    payload: input.payload
  };
}

export function addressLabel(address: AgentAddress): string {
  return address.agent_id ?? address.role ?? address.capability ?? "unknown";
}
