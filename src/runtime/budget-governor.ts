import type { SwarmEnvelope } from "../protocol/types.js";
import type { EnvelopeDeliveryRecord } from "../storage/envelope-delivery-store.js";

export const SWARM_BUDGET_GOVERNOR_VERSION = "swarm.budget_governor.v1";

export type BudgetScope = "session" | "task" | "actor" | "provider";
export type BudgetPressureLevel = "normal" | "warning" | "critical" | "exhausted";
export type BudgetDecisionAction = "allow" | "defer" | "sleep" | "reject";

export type BudgetLimit = {
  max_tokens?: number;
  used_tokens?: number;
  max_cost?: number;
  used_cost?: number;
  max_concurrency?: number;
  running?: number;
  max_queue_depth?: number;
  queue_depth?: number;
  retry_after_ms?: number;
  provider_retry_count?: number;
  max_provider_retries?: number;
};

export type BudgetGovernorPolicy = {
  session?: BudgetLimit;
  task?: Record<string, BudgetLimit>;
  actor?: Record<string, BudgetLimit>;
  provider?: Record<string, BudgetLimit>;
  low_priority_threshold?: "low" | "normal" | "high" | "critical";
  accepted_task_ids?: string[];
  now?: string;
};

export type BudgetDecisionInput = {
  actor_id: string;
  session_id: string;
  task_id?: string;
  priority?: SwarmEnvelope["priority"];
  provider_id?: string;
  envelope_id?: string;
  estimated_tokens?: number;
  estimated_cost?: number;
};

export type BudgetDecision = {
  schema_version: typeof SWARM_BUDGET_GOVERNOR_VERSION;
  action: BudgetDecisionAction;
  pressure: BudgetPressureLevel;
  reason: string;
  scope: BudgetScope;
  actor_id: string;
  session_id: string;
  task_id?: string;
  provider_id?: string;
  envelope_id?: string;
  retry_after_ms?: number;
  sleep_until?: string;
  preserve_ownership: boolean;
  metrics: BudgetPressureMetrics;
};

export type BudgetPressureMetrics = {
  tokens_used: number;
  tokens_limit?: number;
  cost_used: number;
  cost_limit?: number;
  running: number;
  concurrency_limit?: number;
  queue_depth: number;
  queue_limit?: number;
  provider_retry_count: number;
  max_provider_retries?: number;
  deferred_tasks: number;
  sleeping_actors: number;
  accepted_tasks_preserved: number;
};

export type BudgetGovernorReport = {
  schema_version: typeof SWARM_BUDGET_GOVERNOR_VERSION;
  generated_at: string;
  status: BudgetPressureLevel;
  decisions: BudgetDecision[];
  metrics: BudgetPressureMetrics;
};

export class SwarmBudgetGovernor {
  constructor(private readonly policy: BudgetGovernorPolicy = {}) {}

  decide(input: BudgetDecisionInput): BudgetDecision {
    const limits = this.limitsFor(input);
    const metrics = pressureMetrics(limits, this.policy);
    const accepted = Boolean(input.task_id && (this.policy.accepted_task_ids ?? []).includes(input.task_id));
    const queuePressure = pressureFromQueue(limits.session, limits.actor);
    const concurrencyPressure = pressureFromConcurrency(limits.session, limits.actor);
    const tokenPressure = pressureFromTokens(limits.session, limits.task);
    const costPressure = pressureFromCost(limits.session, limits.provider);
    const retryAfter = positiveNumber(limits.provider?.retry_after_ms);
    const providerRetriesExceeded =
      positiveNumber(limits.provider?.max_provider_retries) !== undefined &&
      (limits.provider?.provider_retry_count ?? 0) >= (limits.provider?.max_provider_retries ?? Number.MAX_SAFE_INTEGER);
    const pressure = maxPressure([
      queuePressure,
      concurrencyPressure,
      tokenPressure,
      costPressure,
      retryAfter ? "critical" : "normal",
      providerRetriesExceeded ? "exhausted" : "normal"
    ]);
    const lowPriority = isLowPriority(input.priority, this.policy.low_priority_threshold ?? "low");

    if (providerRetriesExceeded) {
      return this.decision(input, "reject", "exhausted", "provider", `provider retry budget exhausted for ${input.provider_id ?? "provider"}`, metrics, { preserveOwnership: accepted });
    }
    if (retryAfter) {
      return this.decision(input, accepted ? "sleep" : "defer", "critical", "provider", `provider retry-after backpressure ${retryAfter}ms`, metrics, {
        retryAfterMs: retryAfter,
        preserveOwnership: accepted
      });
    }
    if (pressure === "exhausted") {
      if (accepted) {
        return this.decision(input, "sleep", "exhausted", exhaustedScope(limits), "accepted task actor is sleeping until budget recovers", metrics, {
          preserveOwnership: true
        });
      }
      if (lowPriority) {
        return this.decision(input, "defer", "exhausted", exhaustedScope(limits), "low priority task deferred by exhausted budget", metrics);
      }
      return this.decision(input, "reject", "exhausted", exhaustedScope(limits), "budget exhausted", metrics);
    }
    if ((pressure === "critical" || pressure === "warning") && lowPriority) {
      return this.decision(input, "defer", pressure, pressureScope(limits), "low priority task deferred by budget pressure", metrics);
    }
    if (pressure === "critical" && accepted) {
      return this.decision(input, "sleep", pressure, pressureScope(limits), "accepted task actor is sleeping until pressure drops", metrics, {
        preserveOwnership: true
      });
    }
    return this.decision(input, "allow", pressure, pressureScope(limits), "budget governor allowed dispatch", metrics, {
      preserveOwnership: accepted
    });
  }

  report(decisions: BudgetDecision[], input: { generatedAt?: string } = {}): BudgetGovernorReport {
    const metrics = mergeMetrics(decisions.map((decision) => decision.metrics));
    const status = maxPressure(decisions.map((decision) => decision.pressure));
    return {
      schema_version: SWARM_BUDGET_GOVERNOR_VERSION,
      generated_at: input.generatedAt ?? this.policy.now ?? new Date().toISOString(),
      status,
      decisions,
      metrics
    };
  }

  private limitsFor(input: BudgetDecisionInput): {
    session?: BudgetLimit;
    task?: BudgetLimit;
    actor?: BudgetLimit;
    provider?: BudgetLimit;
  } {
    return {
      session: this.policy.session,
      task: input.task_id ? this.policy.task?.[input.task_id] : undefined,
      actor: this.policy.actor?.[input.actor_id],
      provider: input.provider_id ? this.policy.provider?.[input.provider_id] : undefined
    };
  }

  private decision(
    input: BudgetDecisionInput,
    action: BudgetDecisionAction,
    pressure: BudgetPressureLevel,
    scope: BudgetScope,
    reason: string,
    metrics: BudgetPressureMetrics,
    options: { retryAfterMs?: number; preserveOwnership?: boolean } = {}
  ): BudgetDecision {
    return {
      schema_version: SWARM_BUDGET_GOVERNOR_VERSION,
      action,
      pressure,
      reason,
      scope,
      actor_id: input.actor_id,
      session_id: input.session_id,
      task_id: input.task_id,
      provider_id: input.provider_id,
      envelope_id: input.envelope_id,
      retry_after_ms: options.retryAfterMs,
      sleep_until: options.retryAfterMs ? new Date(Date.parse(this.policy.now ?? new Date().toISOString()) + options.retryAfterMs).toISOString() : undefined,
      preserve_ownership: options.preserveOwnership ?? false,
      metrics: {
        ...metrics,
        deferred_tasks: action === "defer" ? metrics.deferred_tasks + 1 : metrics.deferred_tasks,
        sleeping_actors: action === "sleep" ? metrics.sleeping_actors + 1 : metrics.sleeping_actors,
        accepted_tasks_preserved: options.preserveOwnership ? metrics.accepted_tasks_preserved + 1 : metrics.accepted_tasks_preserved
      }
    };
  }
}

export function budgetDecisionForDelivery(
  governor: SwarmBudgetGovernor | undefined,
  actorId: string,
  envelope: SwarmEnvelope,
  delivery: EnvelopeDeliveryRecord
): BudgetDecision | undefined {
  return governor?.decide({
    actor_id: actorId,
    session_id: envelope.session_id,
    task_id: envelope.task_id ?? delivery.task_id,
    priority: envelope.priority,
    provider_id: providerIdFromEnvelope(envelope),
    envelope_id: envelope.id,
    estimated_tokens: numberField(recordPayload(envelope.payload).estimated_tokens ?? recordPayload(envelope.payload).estimatedTokens),
    estimated_cost: numberField(recordPayload(envelope.payload).estimated_cost ?? recordPayload(envelope.payload).estimatedCost)
  });
}

export function budgetDecisionToEnvelope(decision: BudgetDecision, from = "budget.governor"): SwarmEnvelope {
  return {
    id: `budget-${decision.action}-${sanitizeId(decision.actor_id)}-${sanitizeId(decision.envelope_id ?? decision.task_id ?? decision.session_id)}`,
    version: "1.0",
    swarm_id: "swarm-budget",
    session_id: decision.session_id,
    task_id: decision.task_id,
    from: { agent_id: from, role: "governor" },
    to: { agent_id: decision.actor_id },
    type: "task.progress",
    intent: `budget.${decision.action}`,
    correlation_id: decision.envelope_id,
    reply_to: decision.envelope_id,
    idempotency_key: `budget:${decision.session_id}:${decision.envelope_id ?? decision.task_id ?? decision.actor_id}:${decision.action}`,
    created_at: new Date().toISOString(),
    priority: decision.pressure === "exhausted" ? "critical" : "normal",
    payload: {
      budget_decision: decision
    }
  };
}

export function formatBudgetPressure(report: BudgetGovernorReport): string[] {
  return [
    `budget status=${report.status} decisions=${report.decisions.length} deferred=${report.metrics.deferred_tasks} sleeping=${report.metrics.sleeping_actors} preserved=${report.metrics.accepted_tasks_preserved}`,
    `tokens=${report.metrics.tokens_used}/${report.metrics.tokens_limit ?? "unlimited"} cost=${report.metrics.cost_used}/${report.metrics.cost_limit ?? "unlimited"} queue=${report.metrics.queue_depth}/${report.metrics.queue_limit ?? "unlimited"} retries=${report.metrics.provider_retry_count}/${report.metrics.max_provider_retries ?? "unlimited"}`,
    ...report.decisions.map((decision) =>
      `${decision.action} ${decision.actor_id}${decision.task_id ? ` task=${decision.task_id}` : ""} pressure=${decision.pressure} scope=${decision.scope} reason=${decision.reason}${decision.retry_after_ms ? ` retry_after=${decision.retry_after_ms}` : ""}`
    )
  ];
}

function pressureMetrics(
  limits: { session?: BudgetLimit; task?: BudgetLimit; actor?: BudgetLimit; provider?: BudgetLimit },
  policy: BudgetGovernorPolicy
): BudgetPressureMetrics {
  return {
    tokens_used: Math.max(limits.session?.used_tokens ?? 0, limits.task?.used_tokens ?? 0),
    tokens_limit: limits.task?.max_tokens ?? limits.session?.max_tokens,
    cost_used: Math.max(limits.session?.used_cost ?? 0, limits.provider?.used_cost ?? 0),
    cost_limit: limits.provider?.max_cost ?? limits.session?.max_cost,
    running: Math.max(limits.session?.running ?? 0, limits.actor?.running ?? 0),
    concurrency_limit: limits.actor?.max_concurrency ?? limits.session?.max_concurrency,
    queue_depth: Math.max(limits.session?.queue_depth ?? 0, limits.actor?.queue_depth ?? 0),
    queue_limit: limits.actor?.max_queue_depth ?? limits.session?.max_queue_depth,
    provider_retry_count: limits.provider?.provider_retry_count ?? 0,
    max_provider_retries: limits.provider?.max_provider_retries,
    deferred_tasks: 0,
    sleeping_actors: 0,
    accepted_tasks_preserved: 0
  };
}

function pressureFromQueue(session: BudgetLimit | undefined, actor: BudgetLimit | undefined): BudgetPressureLevel {
  return maxPressure([limitPressure(session?.queue_depth, session?.max_queue_depth), limitPressure(actor?.queue_depth, actor?.max_queue_depth)]);
}

function pressureFromConcurrency(session: BudgetLimit | undefined, actor: BudgetLimit | undefined): BudgetPressureLevel {
  return maxPressure([limitPressure(session?.running, session?.max_concurrency), limitPressure(actor?.running, actor?.max_concurrency)]);
}

function pressureFromTokens(session: BudgetLimit | undefined, task: BudgetLimit | undefined): BudgetPressureLevel {
  return maxPressure([limitPressure(session?.used_tokens, session?.max_tokens), limitPressure(task?.used_tokens, task?.max_tokens)]);
}

function pressureFromCost(session: BudgetLimit | undefined, provider: BudgetLimit | undefined): BudgetPressureLevel {
  return maxPressure([limitPressure(session?.used_cost, session?.max_cost), limitPressure(provider?.used_cost, provider?.max_cost)]);
}

function limitPressure(used: number | undefined, limit: number | undefined): BudgetPressureLevel {
  if (used === undefined || limit === undefined || limit <= 0) {
    return "normal";
  }
  if (used >= limit) {
    return "exhausted";
  }
  const ratio = used / limit;
  if (ratio >= 0.9) {
    return "critical";
  }
  if (ratio >= 0.75) {
    return "warning";
  }
  return "normal";
}

function maxPressure(values: BudgetPressureLevel[]): BudgetPressureLevel {
  const rank: Record<BudgetPressureLevel, number> = { normal: 0, warning: 1, critical: 2, exhausted: 3 };
  return values.reduce((current, next) => rank[next] > rank[current] ? next : current, "normal" as BudgetPressureLevel);
}

function isLowPriority(priority: SwarmEnvelope["priority"] | undefined, threshold: NonNullable<BudgetGovernorPolicy["low_priority_threshold"]>): boolean {
  const rank = { low: 0, normal: 1, high: 2, critical: 3 };
  return rank[priority ?? "normal"] <= rank[threshold];
}

function pressureScope(limits: { session?: BudgetLimit; task?: BudgetLimit; actor?: BudgetLimit; provider?: BudgetLimit }): BudgetScope {
  if (limits.provider?.retry_after_ms || limitPressure(limits.provider?.used_cost, limits.provider?.max_cost) !== "normal") {
    return "provider";
  }
  if (limitPressure(limits.actor?.queue_depth, limits.actor?.max_queue_depth) !== "normal" || limitPressure(limits.actor?.running, limits.actor?.max_concurrency) !== "normal") {
    return "actor";
  }
  if (limitPressure(limits.task?.used_tokens, limits.task?.max_tokens) !== "normal") {
    return "task";
  }
  return "session";
}

function exhaustedScope(limits: { session?: BudgetLimit; task?: BudgetLimit; actor?: BudgetLimit; provider?: BudgetLimit }): BudgetScope {
  return pressureScope(limits);
}

function mergeMetrics(items: BudgetPressureMetrics[]): BudgetPressureMetrics {
  return {
    tokens_used: Math.max(0, ...items.map((item) => item.tokens_used)),
    tokens_limit: minDefined(items.map((item) => item.tokens_limit)),
    cost_used: Math.max(0, ...items.map((item) => item.cost_used)),
    cost_limit: minDefined(items.map((item) => item.cost_limit)),
    running: Math.max(0, ...items.map((item) => item.running)),
    concurrency_limit: minDefined(items.map((item) => item.concurrency_limit)),
    queue_depth: Math.max(0, ...items.map((item) => item.queue_depth)),
    queue_limit: minDefined(items.map((item) => item.queue_limit)),
    provider_retry_count: Math.max(0, ...items.map((item) => item.provider_retry_count)),
    max_provider_retries: minDefined(items.map((item) => item.max_provider_retries)),
    deferred_tasks: items.reduce((total, item) => total + item.deferred_tasks, 0),
    sleeping_actors: items.reduce((total, item) => total + item.sleeping_actors, 0),
    accepted_tasks_preserved: items.reduce((total, item) => total + item.accepted_tasks_preserved, 0)
  };
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return defined.length ? Math.min(...defined) : undefined;
}

function providerIdFromEnvelope(envelope: SwarmEnvelope): string | undefined {
  const payload = recordPayload(envelope.payload);
  return stringField(payload.provider_id ?? payload.providerId ?? payload.model_provider ?? payload.modelProvider);
}

function recordPayload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}
