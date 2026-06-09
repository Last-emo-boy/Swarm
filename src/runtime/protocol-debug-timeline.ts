import type { ProviderUsageReport } from "../providers/openai-provider.js";
import type { AgentAddress, BlackboardEntry, SwarmEnvelope } from "../protocol/types.js";
import type { RuntimeEvent } from "./events.js";
import { redactSensitive } from "./recovery.js";

export type ProtocolTimelineCategory =
  | "envelope"
  | "ownership"
  | "blackboard"
  | "capability"
  | "cache";

export type ProtocolTimelineSeverity = "info" | "warning" | "error";

export type ProtocolTimelineEvent = {
  schema_version: "swarm.protocol_timeline.event.v1";
  timeline_id: string;
  at: string;
  category: ProtocolTimelineCategory;
  severity: ProtocolTimelineSeverity;
  source: string;
  summary: string;
  session_id?: string;
  task_id?: string;
  actor_id?: string;
  correlation_id?: string;
  envelope_id?: string;
  metadata?: Record<string, unknown>;
};

export type ProtocolTimelineCorrelationGroup = {
  correlation_id: string;
  events: number;
  categories: ProtocolTimelineCategory[];
  severities: ProtocolTimelineSeverity[];
  actors: string[];
  tasks: string[];
  envelope_ids: string[];
  first_at: string;
  last_at: string;
};

export type ProtocolTimelineSummary = {
  schema_version: "swarm.protocol_timeline.summary.v1";
  total_events: number;
  by_category: Record<ProtocolTimelineCategory, number>;
  by_severity: Record<ProtocolTimelineSeverity, number>;
  correlations: ProtocolTimelineCorrelationGroup[];
  events: ProtocolTimelineEvent[];
};

export type ProtocolTimelineFilter = {
  actorId?: string;
  source?: string;
  taskId?: string;
  correlationId?: string;
  category?: ProtocolTimelineCategory;
  text?: string;
  limit?: number;
};

const CATEGORY_ZERO: Record<ProtocolTimelineCategory, number> = {
  envelope: 0,
  ownership: 0,
  blackboard: 0,
  capability: 0,
  cache: 0
};

const SEVERITY_ZERO: Record<ProtocolTimelineSeverity, number> = {
  info: 0,
  warning: 0,
  error: 0
};

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|token|secret|password|credential|private[_-]?key|prompt|raw[_-]?prompt|content)/iu;

export function buildProtocolDebugTimeline(input: {
  capturedEvents: Array<{ at: string; event: RuntimeEvent }>;
  limit?: number;
}): ProtocolTimelineSummary {
  const events: ProtocolTimelineEvent[] = [];
  for (const captured of input.capturedEvents) {
    events.push(...protocolTimelineEventsFromRuntimeEvent(captured.event, captured.at));
  }
  events.sort((left, right) => {
    const time = left.at.localeCompare(right.at);
    return time !== 0 ? time : left.timeline_id.localeCompare(right.timeline_id);
  });
  const limited = typeof input.limit === "number" && input.limit > 0
    ? events.slice(-input.limit)
    : events;
  return summarizeProtocolTimeline(limited);
}

function summarizeProtocolTimeline(events: readonly ProtocolTimelineEvent[]): ProtocolTimelineSummary {
  const byCategory = { ...CATEGORY_ZERO };
  const bySeverity = { ...SEVERITY_ZERO };
  const groups = new Map<string, ProtocolTimelineCorrelationGroup>();
  for (const event of events) {
    byCategory[event.category] += 1;
    bySeverity[event.severity] += 1;
    const correlationId = event.correlation_id ?? event.envelope_id ?? event.task_id ?? event.timeline_id;
    const group = groups.get(correlationId) ?? {
      correlation_id: correlationId,
      events: 0,
      categories: [],
      severities: [],
      actors: [],
      tasks: [],
      envelope_ids: [],
      first_at: event.at,
      last_at: event.at
    };
    group.events += 1;
    pushUnique(group.categories, event.category);
    pushUnique(group.severities, event.severity);
    if (event.actor_id) pushUnique(group.actors, event.actor_id);
    if (event.task_id) pushUnique(group.tasks, event.task_id);
    if (event.envelope_id) pushUnique(group.envelope_ids, event.envelope_id);
    if (event.at < group.first_at) group.first_at = event.at;
    if (event.at > group.last_at) group.last_at = event.at;
    groups.set(correlationId, group);
  }
  return {
    schema_version: "swarm.protocol_timeline.summary.v1",
    total_events: events.length,
    by_category: byCategory,
    by_severity: bySeverity,
    correlations: [...groups.values()].sort((left, right) => right.events - left.events || left.first_at.localeCompare(right.first_at)),
    events: events.map((event) => redactTimelineEvent(event))
  };
}

export function protocolTimelineEventsFromRuntimeEvent(event: RuntimeEvent, at: string): ProtocolTimelineEvent[] {
  switch (event.type) {
    case "envelope":
      return envelopeTimelineEvents(event.envelope, at);
    case "blackboard":
      return [blackboardTimelineEvent(event.entry, at)];
    case "tool_result":
      return [
        ...capabilityTimelineEventsFromToolResult(event, at),
        ...ownershipTimelineEventsFromToolResult(event, at)
      ];
    case "provider_usage":
      return cacheTimelineEvents(event.usage, at);
    case "approval":
      return event.request.task_id ? [ownershipTimelineEvent({
        at,
        source: "runtime.approval",
        severity: event.status === "denied" ? "error" : event.status === "pending" ? "warning" : "info",
        summary: `approval ${event.status}: ${event.request.action}`,
        sessionId: event.request.session_id,
        taskId: event.request.task_id,
        actorId: event.status === "pending" ? "policy_engine" : "local_user",
        correlationId: event.request.id,
        metadata: {
          approval_id: event.request.id,
          action: event.request.action,
          risk: event.request.risk,
          risk_class: event.request.risk_class,
          target: event.request.target,
          permission_name: event.request.permission_name,
          permission_rule: event.request.permission_rule
        }
      })] : [];
    default:
      return [];
  }
}

export function filterProtocolTimeline(
  events: readonly ProtocolTimelineEvent[],
  filter: ProtocolTimelineFilter = {}
): ProtocolTimelineEvent[] {
  let output = events.filter((event) => {
    if (filter.actorId && event.actor_id !== filter.actorId) return false;
    if (filter.source && event.source !== filter.source && event.metadata?.source !== filter.source && event.metadata?.source_id !== filter.source) return false;
    if (filter.taskId && event.task_id !== filter.taskId) return false;
    if (filter.correlationId && event.correlation_id !== filter.correlationId) return false;
    if (filter.category && event.category !== filter.category) return false;
    if (filter.text) {
      const text = [
        event.category,
        event.severity,
        event.source,
        event.summary,
        event.session_id,
        event.task_id,
        event.actor_id,
        event.correlation_id,
        event.envelope_id,
        event.metadata ? JSON.stringify(event.metadata) : undefined
      ].filter(Boolean).join("\n").toLowerCase();
      if (!text.includes(filter.text.toLowerCase())) {
        return false;
      }
    }
    return true;
  });
  if (typeof filter.limit === "number" && filter.limit > 0 && output.length > filter.limit) {
    output = output.slice(-filter.limit);
  }
  return output.map(redactTimelineEvent);
}

export function formatProtocolDebugTimeline(input: {
  events: readonly ProtocolTimelineEvent[];
  title?: string;
  filter?: ProtocolTimelineFilter;
  limit?: number;
}): string {
  const filtered = filterProtocolTimeline(input.events, { ...input.filter, limit: input.limit ?? input.filter?.limit });
  const lines = [
    input.title ?? "Protocol Timeline",
    filtered.length ? undefined : "(no protocol events)"
  ].filter((line): line is string => typeof line === "string");
  for (const event of filtered) {
    lines.push(formatProtocolTimelineEvent(event));
  }
  return lines.join("\n");
}

export function formatProtocolTimelineEvent(event: ProtocolTimelineEvent): string {
  const parts = [
    event.at,
    `[${event.severity}]`,
    event.category,
    event.actor_id ? `actor=${event.actor_id}` : undefined,
    event.task_id ? `task=${event.task_id}` : undefined,
    event.correlation_id ? `corr=${event.correlation_id}` : undefined,
    event.envelope_id ? `env=${event.envelope_id}` : undefined,
    redactSensitive(event.summary)
  ].filter(Boolean);
  return parts.join(" ");
}

function redactTimelineEvent(event: ProtocolTimelineEvent): ProtocolTimelineEvent {
  return {
    ...event,
    source: redactSensitive(event.source),
    summary: redactSensitive(event.summary),
    session_id: redactOptional(event.session_id),
    task_id: redactOptional(event.task_id),
    actor_id: redactOptional(event.actor_id),
    correlation_id: redactOptional(event.correlation_id),
    envelope_id: redactOptional(event.envelope_id),
    metadata: event.metadata ? redactTimelineValue(event.metadata) as Record<string, unknown> : undefined
  };
}

export function redactTimelineValue(value: unknown, key = ""): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (SENSITIVE_KEY.test(key)) {
    return "REDACTED";
  }
  if (typeof value === "string") {
    return redactSensitive(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactTimelineValue(item, key));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[redactSensitive(childKey)] = redactTimelineValue(childValue, childKey);
    }
    return output;
  }
  return redactSensitive(String(value));
}

function envelopeTimelineEvents(envelope: SwarmEnvelope, at: string): ProtocolTimelineEvent[] {
  const actorId = addressLabel(envelope.from);
  const to = Array.isArray(envelope.to) ? envelope.to.map(addressLabel) : [addressLabel(envelope.to)];
  const correlationId = envelope.correlation_id ?? envelope.reply_to ?? envelope.id;
  const payload = recordField(envelope.payload) ?? {};
  const severity = envelope.type === "error" ? "error" : envelope.type.endsWith(".reject") || envelope.type === "task.fail" ? "warning" : "info";
  const source = stringField(payload.source) ?? (envelope.from.role === "source_adapter" ? addressLabel(envelope.from) : "runtime.envelope");
  const events: ProtocolTimelineEvent[] = [{
    schema_version: "swarm.protocol_timeline.event.v1",
    timeline_id: `protocol:${envelope.id}:envelope`,
    at,
    category: "envelope",
    severity,
    source,
    summary: `${envelope.type} ${actorId} -> ${to.join(",")}`,
    session_id: envelope.session_id,
    task_id: envelope.task_id,
    actor_id: actorId,
    correlation_id: correlationId,
    envelope_id: envelope.id,
    metadata: redactTimelineValue({
      type: envelope.type,
      intent: envelope.intent,
      reply_to: envelope.reply_to,
      idempotency_key: envelope.idempotency_key,
      routing: envelope.routing,
      trace: envelope.trace,
      source,
      source_id: payload.source_id ?? payload.source_identity,
      trust_level: payload.trust_level,
      route: payload.route,
      to
    }) as Record<string, unknown>
  }];

  if (isOwnershipEnvelope(envelope)) {
    events.push({
      schema_version: "swarm.protocol_timeline.event.v1",
      timeline_id: `protocol:${envelope.id}:ownership`,
      at,
      category: "ownership",
      severity,
      source: `${source}.ownership`,
      summary: ownershipEnvelopeSummary(envelope),
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      actor_id: actorId,
      correlation_id: correlationId,
      envelope_id: envelope.id,
      metadata: redactTimelineValue(ownershipMetadataFromEnvelope(envelope)) as Record<string, unknown>
    });
  }
  return events.map(redactTimelineEvent);
}

function blackboardTimelineEvent(entry: BlackboardEntry, at: string): ProtocolTimelineEvent {
  const metadata = entry.metadata ?? {};
  const kind = metadata.kind ?? entry.type;
  const severity: ProtocolTimelineSeverity = metadata.kind === "claim_conflict" || metadata.decision_status === "rejected" ? "warning" : "info";
  return redactTimelineEvent({
    schema_version: "swarm.protocol_timeline.event.v1",
    timeline_id: `protocol:${entry.entry_id}:blackboard`,
    at,
    category: "blackboard",
    severity,
    source: "runtime.blackboard",
    summary: `blackboard ${kind}: ${entry.key}`,
    session_id: entry.session_id,
    task_id: entry.task_id,
    actor_id: addressLabel(entry.created_by),
    correlation_id: metadata.correlation_id ?? metadata.source_envelope_id ?? entry.entry_id,
    envelope_id: metadata.source_envelope_id,
    metadata: redactTimelineValue({
      entry_id: entry.entry_id,
      key: entry.key,
      type: entry.type,
      visibility: entry.visibility,
      version: entry.version,
      tags: entry.tags,
      collaboration: metadata
    }) as Record<string, unknown>
  });
}

function capabilityTimelineEventsFromToolResult(
  event: Extract<RuntimeEvent, { type: "tool_result" }>,
  at: string
): ProtocolTimelineEvent[] {
  const metadata = event.metadata ?? {};
  const capability = event.capability;
  const capabilityId = capability?.id ?? stringField(metadata.capability_id) ?? stringField(metadata.capability);
  const lease = recordField(metadata.capability_lease);
  const evidence = recordField(metadata.envelope_evidence);
  if (!capabilityId && !lease && !evidence) {
    return [];
  }
  const envelopeId = stringField(evidence?.source_envelope_id) ?? stringField(lease?.source_envelope_id);
  const correlationId = stringField(evidence?.correlation_id) ?? stringField(lease?.correlation_id) ?? envelopeId ?? event.task_id;
  return [redactTimelineEvent({
    schema_version: "swarm.protocol_timeline.event.v1",
    timeline_id: `protocol:${event.session_id ?? "session"}:${event.task_id}:${event.action}:capability`,
    at,
    category: "capability",
    severity: event.status === "failed" ? "error" : event.status === "partial" ? "warning" : "info",
    source: "runtime.tool_result.capability",
    summary: `capability ${capabilityId ?? "unknown"} ${event.status ?? "success"} via ${event.action}`,
    session_id: event.session_id,
    task_id: event.task_id,
    actor_id: event.agent?.worker_id ?? event.agent?.agent_id ?? event.action,
    correlation_id: correlationId,
    envelope_id: envelopeId,
    metadata: redactTimelineValue({
      action: event.action,
      status: event.status ?? "success",
      capability,
      capability_lease: lease,
      envelope_evidence: evidence,
      output_ref: event.outputRef,
      error_code: event.errorCode,
      recovery_suggestion: event.recoverySuggestion
    }) as Record<string, unknown>
  })];
}

function ownershipTimelineEventsFromToolResult(
  event: Extract<RuntimeEvent, { type: "tool_result" }>,
  at: string
): ProtocolTimelineEvent[] {
  const metadata = event.metadata ?? {};
  const envelopeId = stringField(metadata.envelope_id) ?? stringField(metadata.source_envelope_id);
  const correlationId = stringField(metadata.correlation_id) ?? envelopeId;
  if (!event.write_policy && !event.file_scope?.length && !event.sandbox && !correlationId) {
    return [];
  }
  return [ownershipTimelineEvent({
    at,
    source: "runtime.tool_result.ownership",
    severity: event.sandbox?.decision === "deny" || event.status === "failed" ? "warning" : "info",
    summary: `ownership ${event.write_policy ?? event.sandbox?.policy ?? "task"} ${event.status ?? "success"} via ${event.action}`,
    sessionId: event.session_id,
    taskId: event.task_id,
    actorId: event.agent?.worker_id ?? event.agent?.agent_id ?? event.action,
    correlationId,
    envelopeId,
    metadata: {
      action: event.action,
      status: event.status ?? "success",
      write_policy: event.write_policy,
      file_scope: event.file_scope,
      sandbox: event.sandbox,
      output_ref: event.outputRef
    }
  })];
}

function cacheTimelineEvents(usage: ProviderUsageReport, at: string): ProtocolTimelineEvent[] {
  const diagnostics = usage.promptCacheDiagnostics;
  const hasCacheData = diagnostics || typeof usage.cachedInputTokens === "number" || typeof usage.cacheHitRate === "number" || usage.cacheMode || usage.promptCacheKey;
  if (!hasCacheData) {
    return [];
  }
  const status = diagnostics?.status ?? (usage.cachedInputTokens && usage.cachedInputTokens > 0 ? "cache_hit" : "cache_unknown");
  const severity: ProtocolTimelineSeverity = status === "cache_miss" || status === "changed" ? "warning" : "info";
  const taskId = usage.taskId;
  return [redactTimelineEvent({
    schema_version: "swarm.protocol_timeline.event.v1",
    timeline_id: `protocol:${usage.sessionId ?? "session"}:${taskId ?? "usage"}:${usage.purpose}:cache`,
    at,
    category: "cache",
    severity,
    source: "runtime.provider_usage.cache",
    summary: `cache ${status}: ${usage.providerId}/${usage.model} ${formatPercent(usage.cacheHitRate) ?? "hit=unknown"}`,
    session_id: usage.sessionId,
    task_id: taskId,
    actor_id: usage.purpose,
    correlation_id: taskId ?? usage.sessionId,
    metadata: redactTimelineValue({
      provider_id: usage.providerId,
      model: usage.model,
      purpose: usage.purpose,
      protocol: usage.protocol,
      cache_mode: usage.cacheMode,
      prompt_cache_key: usage.promptCacheKey,
      prompt_cache_scope: usage.promptCacheScope,
      status,
      changed: diagnostics?.changed,
      changed_sections: diagnostics?.changedSections,
      miss_reason: diagnostics?.missReason,
      cached_input_tokens: usage.cachedInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
      total_input_with_cache_tokens: usage.totalInputWithCacheTokens,
      cache_hit_rate: usage.cacheHitRate,
      cache_write_rate: usage.cacheWriteRate
    }) as Record<string, unknown>
  })];
}

function ownershipTimelineEvent(input: {
  at: string;
  source: string;
  severity: ProtocolTimelineSeverity;
  summary: string;
  sessionId?: string;
  taskId?: string;
  actorId?: string;
  correlationId?: string;
  envelopeId?: string;
  metadata?: Record<string, unknown>;
}): ProtocolTimelineEvent {
  return redactTimelineEvent({
    schema_version: "swarm.protocol_timeline.event.v1",
    timeline_id: `protocol:${input.sessionId ?? "session"}:${input.taskId ?? "task"}:${input.correlationId ?? input.envelopeId ?? input.source}:ownership`,
    at: input.at,
    category: "ownership",
    severity: input.severity,
    source: input.source,
    summary: input.summary,
    session_id: input.sessionId,
    task_id: input.taskId,
    actor_id: input.actorId,
    correlation_id: input.correlationId,
    envelope_id: input.envelopeId,
    metadata: input.metadata ? redactTimelineValue(input.metadata) as Record<string, unknown> : undefined
  });
}

function isOwnershipEnvelope(envelope: SwarmEnvelope): boolean {
  return envelope.type === "task.assign" ||
    envelope.type === "task.accept" ||
    envelope.type === "task.reject" ||
    envelope.type === "task.result" ||
    envelope.type === "task.fail" ||
    envelope.type.startsWith("handoff.") ||
    envelope.type === "agent.update_status";
}

function ownershipEnvelopeSummary(envelope: SwarmEnvelope): string {
  const payload = recordField(envelope.payload);
  const owner = stringField(payload?.owner_agent_id) ?? stringField(payload?.worker_actor_id) ?? addressLabel(envelope.from);
  const target = stringField(payload?.target_agent_id) ?? stringField(payload?.handoff_id) ?? envelope.task_id ?? envelope.id;
  return `${envelope.type} owner=${owner} target=${target}`;
}

function ownershipMetadataFromEnvelope(envelope: SwarmEnvelope): Record<string, unknown> {
  const payload = recordField(envelope.payload) ?? {};
  return {
    type: envelope.type,
    intent: envelope.intent,
    from: addressLabel(envelope.from),
    to: Array.isArray(envelope.to) ? envelope.to.map(addressLabel) : addressLabel(envelope.to),
    owner_agent_id: payload.owner_agent_id,
    worker_actor_id: payload.worker_actor_id,
    target_agent_id: payload.target_agent_id,
    handoff_id: payload.handoff_id,
    assignment_envelope_id: payload.assignment_envelope_id,
    request_envelope_id: payload.request_envelope_id,
    accept_envelope_id: payload.accept_envelope_id,
    return_envelope_id: payload.return_envelope_id,
    take_back_envelope_id: payload.take_back_envelope_id,
    reason: payload.reason,
    status: payload.status
  };
}

function addressLabel(address: AgentAddress | undefined): string {
  return address?.agent_id ?? address?.role ?? address?.capability ?? "unknown";
}

function redactOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSensitive(value);
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length ? value : undefined;
}

function formatPercent(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `hit=${Math.round(value * 100)}%` : undefined;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) {
    items.push(item);
  }
}
