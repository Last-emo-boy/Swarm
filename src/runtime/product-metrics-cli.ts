import {
  createProductMetricFlowId,
  defaultProductMetricsPath,
  formatProductMetricsSummary,
  productMetricsSmokeEvents,
  recordProductMetricEvent,
  summarizeProductMetricEvents,
  summarizeProductMetrics,
  type ProductMetricEventInput,
  type ProductMetricScenario
} from "./product-translation-metrics.js";

export type HeadlessProductMetricsContext = {
  scenario: ProductMetricScenario;
  focusProvided: boolean;
  flowId: string;
};

export type ProductMetricsCommandOptions = {
  json?: boolean;
  demo?: boolean;
  path?: string;
};

export function createCodebaseReviewMetricsContext(focus: string): HeadlessProductMetricsContext {
  return {
    scenario: "codebase_deep_review",
    focusProvided: focus.trim().length > 0,
    flowId: createProductMetricFlowId("review")
  };
}

export function formatProductMetricsCommandOutput(options: ProductMetricsCommandOptions = {}): string {
  const path = options.path ?? defaultProductMetricsPath();
  const summary = options.demo
    ? summarizeProductMetricEvents(productMetricsSmokeEvents(), path)
    : summarizeProductMetrics(path);
  return options.json
    ? JSON.stringify(summary, null, 2)
    : formatProductMetricsSummary(summary).join("\n");
}

export function recordCliProductMetric(input: ProductMetricEventInput): void {
  try {
    recordProductMetricEvent(input);
  } catch {
    // Product translation metrics are local validation signals; they must not affect user work.
  }
}

export function stringRecordValue(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" && item.trim() ? item : undefined;
}
