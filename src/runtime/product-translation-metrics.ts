import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSwarmPaths } from "../config/settings.js";

const PRODUCT_METRICS_SCHEMA_VERSION = "swarm.product_metrics.v1";
const PRODUCT_METRICS_SUMMARY_SCHEMA_VERSION = "swarm.product_metrics_summary.v1";

export type ProductMetricSource = "tui" | "headless" | "cli" | "eval";
export type ProductMetricScenario = "codebase_deep_review";
export type ProductMetricObservatoryView = "observatory" | "workers" | "trace" | "team_reasoning";
export type ProductMetricSteering = "reply" | "interrupt";
export type ProductMetricEventName =
  | "scenario_started"
  | "result_card_shown"
  | "headless_result_completed"
  | "observatory_opened"
  | "steering_used";

export type ProductMetricEventInput = {
  event: ProductMetricEventName;
  source: ProductMetricSource;
  session_id?: string;
  flow_id?: string;
  scenario?: ProductMetricScenario;
  route?: string;
  status?: string;
  view?: ProductMetricObservatoryView;
  steering?: ProductMetricSteering;
  trigger?: string;
  focus_provided?: boolean;
  has_result_card?: boolean;
  duration_ms?: number;
  changed_files?: number;
  checks?: number;
  findings?: number;
};

export type ProductMetricEvent = ProductMetricEventInput & {
  schema_version: typeof PRODUCT_METRICS_SCHEMA_VERSION;
  at: string;
};

export type ProductMetricsTimingSummary = {
  count: number;
  min_ms?: number;
  p50_ms?: number;
  p95_ms?: number;
  max_ms?: number;
};

export type ProductMetricsSummary = {
  schema_version: typeof PRODUCT_METRICS_SUMMARY_SCHEMA_VERSION;
  path: string;
  event_count: number;
  session_count: number;
  scenario_sessions: number;
  scenario_completed: number;
  scenario_completion_rate: number;
  time_to_impressive_result: ProductMetricsTimingSummary;
  sessions_without_advanced_views: {
    count: number;
    total: number;
    percent: number;
  };
  advanced_views: {
    sessions: number;
    events: number;
    by_view: Record<ProductMetricObservatoryView, number>;
  };
  steering: {
    sessions: number;
    events: number;
    reply: number;
    interrupt: number;
  };
  privacy: {
    local_only: true;
    prompt_text_stored: false;
  };
};

type ProductMetricsOptions = {
  path?: string;
  at?: Date;
};

type ProductMetricSessionFacts = {
  startedAt?: number;
  completedAt?: number;
  completionDurationMs?: number;
  hasScenario: boolean;
  hasCompletion: boolean;
  advancedViews: Set<ProductMetricObservatoryView>;
  steering: Set<ProductMetricSteering>;
};

const PRODUCT_METRICS_FILE = "product-translation-metrics.jsonl";

export function createProductMetricFlowId(prefix = "product"): string {
  return `${prefix}_${randomUUID()}`;
}

export function defaultProductMetricsPath(): string {
  return resolve(process.env.SWARM_PRODUCT_METRICS_PATH ?? join(getSwarmPaths().stateDir, PRODUCT_METRICS_FILE));
}

function productMetricsEnabled(): boolean {
  const value = process.env.SWARM_PRODUCT_METRICS;
  return value !== "0" && value !== "false" && value !== "off";
}

export function recordProductMetricEvent(
  input: ProductMetricEventInput,
  options: ProductMetricsOptions = {}
): ProductMetricEvent | undefined {
  if (!productMetricsEnabled()) {
    return undefined;
  }
  const event = normalizeProductMetricEvent(input, options.at ?? new Date());
  const path = options.path ? resolve(options.path) : defaultProductMetricsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  } catch {
    return undefined;
  }
}

export function readProductMetricEvents(path = defaultProductMetricsPath()): ProductMetricEvent[] {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return [];
  }
  const lines = readFileSync(resolved, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const events: ProductMetricEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isProductMetricEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore corrupt partial lines so metrics never break the product path.
    }
  }
  return events;
}

export function summarizeProductMetrics(path = defaultProductMetricsPath()): ProductMetricsSummary {
  return summarizeProductMetricEvents(readProductMetricEvents(path), path);
}

export function summarizeProductMetricEvents(
  events: ProductMetricEvent[],
  path = defaultProductMetricsPath()
): ProductMetricsSummary {
  const facts = new Map<string, ProductMetricSessionFacts>();
  const anonymousPrefix = "event";
  let anonymousIndex = 0;
  const viewCounts: Record<ProductMetricObservatoryView, number> = {
    observatory: 0,
    workers: 0,
    trace: 0,
    team_reasoning: 0
  };
  let advancedEvents = 0;
  let steeringEvents = 0;
  let replyEvents = 0;
  let interruptEvents = 0;

  for (const event of events) {
    const key = metricGroupingKey(event) ?? `${anonymousPrefix}:${anonymousIndex++}`;
    const entry = facts.get(key) ?? {
      hasScenario: false,
      hasCompletion: false,
      advancedViews: new Set<ProductMetricObservatoryView>(),
      steering: new Set<ProductMetricSteering>()
    };
    const atMs = Date.parse(event.at);
    if (event.event === "scenario_started") {
      entry.hasScenario = true;
      if (Number.isFinite(atMs)) {
        entry.startedAt = Math.min(entry.startedAt ?? atMs, atMs);
      }
    }
    if (event.event === "result_card_shown" || event.event === "headless_result_completed") {
      entry.hasCompletion = true;
      if (Number.isFinite(atMs)) {
        entry.completedAt = entry.completedAt === undefined ? atMs : Math.min(entry.completedAt, atMs);
      }
      if (typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms) && event.duration_ms >= 0) {
        entry.completionDurationMs = event.duration_ms;
      }
    }
    if (event.event === "observatory_opened" && event.view) {
      entry.advancedViews.add(event.view);
      viewCounts[event.view] += 1;
      advancedEvents += 1;
    }
    if (event.event === "steering_used" && event.steering) {
      entry.steering.add(event.steering);
      steeringEvents += 1;
      if (event.steering === "reply") {
        replyEvents += 1;
      } else if (event.steering === "interrupt") {
        interruptEvents += 1;
      }
    }
    facts.set(key, entry);
  }

  const scenarioFacts = [...facts.values()].filter((entry) => entry.hasScenario);
  const scenarioCompleted = scenarioFacts.filter((entry) => entry.hasCompletion).length;
  const advancedSessionCount = [...facts.values()].filter((entry) => entry.advancedViews.size > 0).length;
  const steeringSessionCount = [...facts.values()].filter((entry) => entry.steering.size > 0).length;
  const noAdvancedCount = scenarioFacts.filter((entry) => entry.advancedViews.size === 0).length;
  const timings = scenarioFacts
    .map((entry) => {
      if (entry.startedAt !== undefined && entry.completedAt !== undefined && entry.completedAt >= entry.startedAt) {
        return entry.completedAt - entry.startedAt;
      }
      return entry.completionDurationMs;
    })
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  return {
    schema_version: PRODUCT_METRICS_SUMMARY_SCHEMA_VERSION,
    path: resolve(path),
    event_count: events.length,
    session_count: facts.size,
    scenario_sessions: scenarioFacts.length,
    scenario_completed: scenarioCompleted,
    scenario_completion_rate: ratio(scenarioCompleted, scenarioFacts.length),
    time_to_impressive_result: timingSummary(timings),
    sessions_without_advanced_views: {
      count: noAdvancedCount,
      total: scenarioFacts.length,
      percent: ratio(noAdvancedCount, scenarioFacts.length)
    },
    advanced_views: {
      sessions: advancedSessionCount,
      events: advancedEvents,
      by_view: viewCounts
    },
    steering: {
      sessions: steeringSessionCount,
      events: steeringEvents,
      reply: replyEvents,
      interrupt: interruptEvents
    },
    privacy: {
      local_only: true,
      prompt_text_stored: false
    }
  };
}

export function productMetricsSmokeEvents(baseAt = new Date("2026-06-03T00:00:00.000Z")): ProductMetricEvent[] {
  const flowId = createProductMetricFlowId("smoke");
  const start = baseAt.getTime();
  return [
    normalizeProductMetricEvent({
      event: "scenario_started",
      source: "eval",
      scenario: "codebase_deep_review",
      flow_id: flowId,
      focus_provided: true,
      route: "coding_loop"
    }, new Date(start)),
    normalizeProductMetricEvent({
      event: "result_card_shown",
      source: "eval",
      session_id: "smoke_session",
      flow_id: flowId,
      scenario: "codebase_deep_review",
      route: "work",
      status: "completed",
      has_result_card: true,
      changed_files: 0,
      checks: 2,
      findings: 3
    }, new Date(start + 87_000)),
    normalizeProductMetricEvent({
      event: "steering_used",
      source: "eval",
      session_id: "smoke_session",
      flow_id: flowId,
      steering: "reply",
      trigger: "smoke"
    }, new Date(start + 30_000))
  ];
}

export function formatProductMetricsSummary(summary: ProductMetricsSummary): string[] {
  const views = Object.entries(summary.advanced_views.by_view)
    .filter(([, count]) => count > 0)
    .map(([view, count]) => `${view}:${count}`)
    .join(", ") || "none";
  return [
    "Product Translation Metrics",
    `source=${summary.path} events=${summary.event_count} sessions=${summary.session_count}`,
    `scenario_completion started=${summary.scenario_sessions} completed=${summary.scenario_completed} rate=${formatPercent(summary.scenario_completion_rate)}`,
    `time_to_impressive_result count=${summary.time_to_impressive_result.count} min_ms=${summary.time_to_impressive_result.min_ms ?? "-"} p50_ms=${summary.time_to_impressive_result.p50_ms ?? "-"} p95_ms=${summary.time_to_impressive_result.p95_ms ?? "-"} max_ms=${summary.time_to_impressive_result.max_ms ?? "-"}`,
    `sessions_without_advanced_views ${summary.sessions_without_advanced_views.count}/${summary.sessions_without_advanced_views.total} (${formatPercent(summary.sessions_without_advanced_views.percent)})`,
    `advanced_views sessions=${summary.advanced_views.sessions} events=${summary.advanced_views.events} views=${views}`,
    `steering sessions=${summary.steering.sessions} events=${summary.steering.events} reply=${summary.steering.reply} interrupt=${summary.steering.interrupt}`,
    "privacy=local-only prompt_text_stored=false"
  ];
}

function normalizeProductMetricEvent(input: ProductMetricEventInput, at: Date): ProductMetricEvent {
  return stripUndefined({
    schema_version: PRODUCT_METRICS_SCHEMA_VERSION,
    at: at.toISOString(),
    event: input.event,
    source: input.source,
    session_id: sanitizeMetricId(input.session_id),
    flow_id: sanitizeMetricId(input.flow_id),
    scenario: input.scenario,
    route: sanitizeMetricLabel(input.route),
    status: sanitizeMetricLabel(input.status),
    view: input.view,
    steering: input.steering,
    trigger: sanitizeMetricLabel(input.trigger),
    focus_provided: input.focus_provided,
    has_result_card: input.has_result_card,
    duration_ms: sanitizeMetricCount(input.duration_ms),
    changed_files: sanitizeMetricCount(input.changed_files),
    checks: sanitizeMetricCount(input.checks),
    findings: sanitizeMetricCount(input.findings)
  });
}

function metricGroupingKey(event: ProductMetricEvent): string | undefined {
  return event.flow_id ?? event.session_id;
}

function timingSummary(values: number[]): ProductMetricsTimingSummary {
  if (!values.length) {
    return { count: 0 };
  }
  return {
    count: values.length,
    min_ms: values[0],
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: values[values.length - 1]
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 1) {
    return values[0];
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index];
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}

function sanitizeMetricId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 160);
}

function sanitizeMetricLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 80);
}

function sanitizeMetricCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function isProductMetricEvent(value: unknown): value is ProductMetricEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.schema_version === PRODUCT_METRICS_SCHEMA_VERSION &&
    typeof record.at === "string" &&
    isProductMetricEventName(record.event) &&
    isProductMetricSource(record.source);
}

function isProductMetricEventName(value: unknown): value is ProductMetricEventName {
  return value === "scenario_started" ||
    value === "result_card_shown" ||
    value === "headless_result_completed" ||
    value === "observatory_opened" ||
    value === "steering_used";
}

function isProductMetricSource(value: unknown): value is ProductMetricSource {
  return value === "tui" || value === "headless" || value === "cli" || value === "eval";
}
