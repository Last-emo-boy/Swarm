import type { AgentAddress, SwarmEnvelope, WorkItem } from "../protocol/types.js";
import { createEnvelope } from "../protocol/envelope.js";

export type SourceAdapterKind = "cli" | "gateway" | "symphony" | "mcp" | "file_watcher" | "webhook" | string;
export type SourceAdapterTrustLevel = "local" | "trusted" | "external" | "untrusted";

export type SourceUserMessageEnvelopeInput = {
  source: SourceAdapterKind;
  sourceId?: string;
  trustLevel?: SourceAdapterTrustLevel;
  content: string;
  swarmId: string;
  sessionId: string;
  taskId?: string;
  route?: string;
  mode?: string;
  requestId?: string;
  correlationId?: string;
  dedupeKey?: string;
  from?: AgentAddress;
  to?: AgentAddress;
  metadata?: Record<string, unknown>;
};

export function createSourceUserMessageEnvelope(input: SourceUserMessageEnvelopeInput): SwarmEnvelope<Record<string, unknown>> {
  const sourceId = input.sourceId ?? `${input.source}:${input.sessionId}`;
  const correlationId = input.correlationId ?? input.requestId ?? `${input.source}:${sourceId}:${input.sessionId}`;
  const dedupeKey = input.dedupeKey ?? input.requestId ?? `${input.source}:${sourceId}:${input.sessionId}:${stableTextHash(input.content)}`;
  const from = input.from ?? sourceAdapterAddress(input.source);
  const trustLevel = input.trustLevel ?? defaultTrustLevel(input.source);
  return createEnvelope<Record<string, unknown>>({
    swarm_id: input.swarmId,
    session_id: input.sessionId,
    task_id: input.taskId,
    from,
    to: input.to ?? { agent_id: "main_swarm", role: "controller" },
    type: "user.message",
    intent: "source.user.message",
    payload: stripUndefinedRecord({
      schema_version: "swarm.source_adapter.user_message.v1",
      source: input.source,
      source_id: sourceId,
      trust_level: trustLevel,
      route: input.route,
      mode: input.mode,
      request_id: input.requestId,
      correlation_id: correlationId,
      dedupe_key: dedupeKey,
      content: input.content,
      metadata: input.metadata
    }),
    correlation_id: correlationId,
    idempotency_key: `source:${input.source}:user.message:${dedupeKey}`,
    auth: {
      actor: from.agent_id ?? from.role ?? `source.${input.source}`,
      scopes: ["source_adapter.user_message", `source.${input.source}`]
    },
    trace: {
      trace_id: correlationId,
      span_id: `span_source_${sanitizeTracePart(input.source)}_${stableTextHash(dedupeKey)}`
    }
  });
}

export function workItemSourceAdapterMetadata(source: WorkItem | undefined): Record<string, unknown> {
  return stripUndefinedRecord({
    source: source?.source,
    source_id: source?.source_id ?? source?.external_id,
    human_id: source?.human_id,
    title: source?.title,
    state: source?.state,
    labels: source?.labels,
    url: source?.url
  });
}

function sourceAdapterAddress(source: SourceAdapterKind): AgentAddress {
  return {
    agent_id: `source.${sanitizeActorPart(source)}`,
    role: "source_adapter"
  };
}

function defaultTrustLevel(source: SourceAdapterKind): SourceAdapterTrustLevel {
  if (source === "cli" || source === "symphony" || source === "file_watcher") {
    return "local";
  }
  if (source === "gateway") {
    return "trusted";
  }
  return "external";
}

function stableTextHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeActorPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function sanitizeTracePart(value: string): string {
  return sanitizeActorPart(value).replace(/[^A-Za-z0-9_]+/g, "_");
}

function stripUndefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
