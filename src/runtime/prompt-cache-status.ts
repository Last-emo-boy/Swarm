import type { ProviderUsageReport } from "../providers/openai-provider.js";

export type PromptCacheRuntimeStatus = {
  status: string;
  cacheMode?: string;
  providerId?: string;
  model?: string;
  purpose?: string;
  promptCacheKey?: string;
  promptCacheScope?: string;
  hitRate?: number;
  writeRate?: number;
  cachedInputTokens?: number;
  totalInputWithCacheTokens?: number;
  cacheCreationInputTokens?: number;
  cacheablePrefixTokensEstimate?: number;
  diagnostics?: string;
  changed?: string[];
  minimumCacheableTokens?: number;
  outcome?: "hit" | "miss" | "warming" | "bypass" | "unknown";
  reason?: string;
  recommendation?: string;
};

export type ResultCardPromptCacheStatus = Pick<PromptCacheRuntimeStatus,
  | "status"
  | "cacheMode"
  | "providerId"
  | "model"
  | "purpose"
  | "promptCacheKey"
  | "promptCacheScope"
  | "hitRate"
  | "writeRate"
  | "cachedInputTokens"
  | "totalInputWithCacheTokens"
  | "cacheCreationInputTokens"
  | "cacheablePrefixTokensEstimate"
  | "diagnostics"
  | "changed"
  | "minimumCacheableTokens"
  | "outcome"
  | "reason"
  | "recommendation"
>;

export type PromptCacheTrend = {
  source: "provider_usage" | "result_card_fallback" | "none";
  calls: number;
  cacheableCalls: number;
  hitCalls: number;
  missCalls: number;
  warmingCalls: number;
  bypassCalls: number;
  unknownCalls: number;
  cachedInputTokens: number;
  totalInputWithCacheTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  cacheablePrefixTokensEstimate: number;
  hitRate?: number;
  writeRate?: number;
  diagnostics: Record<string, number>;
  changed: string[];
  latest?: ResultCardPromptCacheStatus;
};

export function promptCacheStatusFromUsage(usage: ProviderUsageReport): PromptCacheRuntimeStatus {
  const hitRate = usage.cacheHitRate ?? (
    usage.totalInputWithCacheTokens && typeof usage.cachedInputTokens === "number"
      ? usage.cachedInputTokens / Math.max(1, usage.totalInputWithCacheTokens)
      : undefined
  );
  const changed = usage.promptCacheDiagnostics?.changed ?? [];
  const analysis = analyzePromptCacheUsage({
    status: usage.promptCacheDiagnostics?.status ?? "unknown",
    changed,
    hitRate,
    cacheMode: usage.cacheMode,
    cacheablePrefixTokensEstimate: usage.cacheablePrefixTokensEstimate,
    minimumCacheableTokens: usage.promptCacheDiagnostics?.minimumCacheableTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalInputWithCacheTokens: usage.totalInputWithCacheTokens
  });
  return {
    status: usage.promptCacheDiagnostics?.status ?? "unknown",
    cacheMode: usage.cacheMode,
    providerId: usage.providerId,
    model: usage.model,
    purpose: usage.purpose,
    promptCacheKey: usage.promptCacheKey,
    promptCacheScope: usage.promptCacheScope,
    hitRate,
    writeRate: usage.cacheWriteRate,
    cachedInputTokens: usage.cachedInputTokens,
    totalInputWithCacheTokens: usage.totalInputWithCacheTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheablePrefixTokensEstimate: usage.cacheablePrefixTokensEstimate,
    diagnostics: changed.length ? changed.join(", ") : usage.promptCacheDiagnostics?.status,
    changed,
    minimumCacheableTokens: usage.promptCacheDiagnostics?.minimumCacheableTokens,
    ...analysis
  };
}

export function promptCacheTrendFromUsage(usages: ProviderUsageReport[]): PromptCacheTrend {
  return promptCacheTrendFromStatuses(usages.map(promptCacheStatusFromUsage), "provider_usage");
}

export function promptCacheTrendFromResultCardCache(status: ResultCardPromptCacheStatus | undefined): PromptCacheTrend {
  return promptCacheTrendFromStatuses(status ? [status] : [], status ? "result_card_fallback" : "none");
}

export function promptCacheTrendFromStatuses(
  statuses: ResultCardPromptCacheStatus[],
  source: PromptCacheTrend["source"] = "provider_usage"
): PromptCacheTrend {
  const trend: PromptCacheTrend = {
    source: statuses.length ? source : "none",
    calls: statuses.length,
    cacheableCalls: 0,
    hitCalls: 0,
    missCalls: 0,
    warmingCalls: 0,
    bypassCalls: 0,
    unknownCalls: 0,
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    cacheablePrefixTokensEstimate: 0,
    diagnostics: {},
    changed: []
  };
  const changed = new Set<string>();
  for (const status of statuses) {
    trend.latest = status;
    const outcome = promptCacheTrendOutcome(status);
    if (outcome === "hit") trend.hitCalls += 1;
    else if (outcome === "miss") trend.missCalls += 1;
    else if (outcome === "warming") trend.warmingCalls += 1;
    else if (outcome === "bypass") trend.bypassCalls += 1;
    else trend.unknownCalls += 1;

    if (typeof status.totalInputWithCacheTokens === "number" && status.totalInputWithCacheTokens > 0) {
      trend.cacheableCalls += 1;
      trend.totalInputWithCacheTokens += status.totalInputWithCacheTokens;
    }
    trend.cachedInputTokens += status.cachedInputTokens ?? 0;
    trend.cacheCreationInputTokens += status.cacheCreationInputTokens ?? 0;
    trend.cacheablePrefixTokensEstimate += status.cacheablePrefixTokensEstimate ?? 0;
    if (typeof status.totalInputWithCacheTokens === "number" && typeof status.cachedInputTokens === "number") {
      trend.uncachedInputTokens += Math.max(0, status.totalInputWithCacheTokens - status.cachedInputTokens);
    }
    if (status.status) {
      trend.diagnostics[status.status] = (trend.diagnostics[status.status] ?? 0) + 1;
    }
    for (const item of status.changed ?? []) {
      changed.add(item);
    }
  }
  trend.changed = [...changed].sort();
  if (trend.totalInputWithCacheTokens > 0) {
    trend.hitRate = trend.cachedInputTokens / trend.totalInputWithCacheTokens;
    trend.writeRate = trend.cacheCreationInputTokens / trend.totalInputWithCacheTokens;
  }
  return trend;
}

function promptCacheTrendOutcome(status: ResultCardPromptCacheStatus): PromptCacheRuntimeStatus["outcome"] | "unknown" {
  if (status.outcome) {
    return status.outcome;
  }
  if (status.status === "new_scope") {
    return "warming";
  }
  if (status.status === "changed" || status.status === "cache_miss" || status.changed?.length) {
    return "miss";
  }
  if (status.status === "expected_empty_cache" || status.cacheMode === "off" || status.cacheMode === "disabled") {
    return "bypass";
  }
  if (
    (typeof status.hitRate === "number" && status.hitRate > 0)
    || (typeof status.cachedInputTokens === "number" && status.cachedInputTokens > 0)
    || status.status === "stable"
    || status.status === "cache_hit"
  ) {
    return "hit";
  }
  return "unknown";
}

export function resultCardCacheStatus(status: PromptCacheRuntimeStatus | undefined): ResultCardPromptCacheStatus | undefined {
  if (!status) {
    return undefined;
  }
  return {
    status: status.status,
    cacheMode: status.cacheMode,
    providerId: status.providerId,
    model: status.model,
    purpose: status.purpose,
    promptCacheKey: status.promptCacheKey,
    promptCacheScope: status.promptCacheScope,
    hitRate: status.hitRate,
    writeRate: status.writeRate,
    cachedInputTokens: status.cachedInputTokens,
    totalInputWithCacheTokens: status.totalInputWithCacheTokens,
    cacheCreationInputTokens: status.cacheCreationInputTokens,
    cacheablePrefixTokensEstimate: status.cacheablePrefixTokensEstimate,
    diagnostics: status.diagnostics,
    changed: status.changed,
    minimumCacheableTokens: status.minimumCacheableTokens,
    outcome: status.outcome,
    reason: status.reason,
    recommendation: status.recommendation
  };
}

export function formatPromptCacheBrief(status: PromptCacheRuntimeStatus | undefined): string {
  if (!status) {
    return "No prompt cache status yet.";
  }
  const rates = formatPromptCacheRates(status);
  const provider = [status.providerId, status.model].filter(Boolean).join("/");
  return [
    `Prompt cache: ${status.status}${rates ? ` (${rates})` : ""}.`,
    provider ? `${provider}.` : undefined,
    "Ctrl+O for details."
  ].filter(Boolean).join(" ");
}

export function formatPromptCacheDetail(status: PromptCacheRuntimeStatus | undefined): string {
  return formatPromptCacheDetailWithTrend(status);
}

export function formatPromptCacheDetailWithTrend(
  status: PromptCacheRuntimeStatus | undefined,
  trend?: PromptCacheTrend
): string {
  if (!status) {
    return "No prompt cache usage has been recorded yet.";
  }
  const lines = [
    `status=${status.status}`,
    status.cacheMode ? `mode=${status.cacheMode}` : undefined,
    status.providerId ? `provider=${status.providerId}` : undefined,
    status.model ? `model=${status.model}` : undefined,
    status.purpose ? `purpose=${status.purpose}` : undefined,
    status.promptCacheKey ? `key=${status.promptCacheKey}` : undefined,
    status.promptCacheScope ? `scope=${status.promptCacheScope}` : undefined,
    formatPromptCacheRates(status),
    typeof status.cachedInputTokens === "number" ? `cached_input_tokens=${status.cachedInputTokens}` : undefined,
    typeof status.totalInputWithCacheTokens === "number" ? `total_input_with_cache_tokens=${status.totalInputWithCacheTokens}` : undefined,
    typeof status.cacheCreationInputTokens === "number" ? `cache_creation_input_tokens=${status.cacheCreationInputTokens}` : undefined,
    typeof status.cacheablePrefixTokensEstimate === "number" ? `cacheable_prefix_tokens_estimate=${status.cacheablePrefixTokensEstimate}` : undefined,
    typeof status.minimumCacheableTokens === "number" ? `minimum_cacheable_tokens=${status.minimumCacheableTokens}` : undefined,
    status.outcome ? `outcome=${status.outcome}` : undefined,
    status.reason ? `reason=${status.reason}` : undefined,
    status.recommendation ? `recommendation=${status.recommendation}` : undefined,
    status.changed?.length ? `changed=${status.changed.join(", ")}` : undefined,
    status.diagnostics ? `diagnostics=${status.diagnostics}` : undefined,
    ...(trend && trend.calls > 0 ? [
      "",
      "Trend",
      `source=${trend.source}`,
      `calls=${trend.calls} cacheable=${trend.cacheableCalls} hit=${trend.hitCalls} miss=${trend.missCalls} warming=${trend.warmingCalls} bypass=${trend.bypassCalls} unknown=${trend.unknownCalls}`,
      formatPromptCacheRates({ hitRate: trend.hitRate, writeRate: trend.writeRate }),
      `cached_input_tokens=${trend.cachedInputTokens}`,
      `total_input_with_cache_tokens=${trend.totalInputWithCacheTokens}`,
      `cache_creation_input_tokens=${trend.cacheCreationInputTokens}`,
      `uncached_input_tokens=${trend.uncachedInputTokens}`,
      `cacheable_prefix_tokens_estimate=${trend.cacheablePrefixTokensEstimate}`,
      trend.changed.length ? `changed=${trend.changed.join(", ")}` : undefined,
      Object.keys(trend.diagnostics).length ? `diagnostics=${Object.entries(trend.diagnostics).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join(", ")}` : undefined
    ] : []),
    "",
    "JSON",
    JSON.stringify(status, null, 2)
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function formatPromptCacheInline(status: ResultCardPromptCacheStatus | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  const rates = formatPromptCacheRates(status);
  return `cache:${status.status}${rates ? ` ${rates}` : ""}${status.outcome ? ` ${status.outcome}` : ""}${status.diagnostics ? ` ${status.diagnostics}` : ""}`;
}

function formatPromptCacheRates(status: Pick<PromptCacheRuntimeStatus, "hitRate" | "writeRate">): string {
  return [
    typeof status.hitRate === "number" ? `hit ${Math.round(status.hitRate * 100)}%` : undefined,
    typeof status.writeRate === "number" ? `write ${Math.round(status.writeRate * 100)}%` : undefined
  ].filter(Boolean).join(", ");
}

function analyzePromptCacheUsage(input: {
  status: string;
  changed: string[];
  hitRate?: number;
  cacheMode?: string;
  cacheablePrefixTokensEstimate?: number;
  minimumCacheableTokens?: number;
  cachedInputTokens?: number;
  totalInputWithCacheTokens?: number;
}): Pick<PromptCacheRuntimeStatus, "outcome" | "reason" | "recommendation"> {
  if (!input.cacheMode || input.cacheMode === "off" || input.cacheMode === "disabled") {
    return {
      outcome: "bypass",
      reason: "prompt cache is disabled for this request",
      recommendation: "Enable prompt cache or set stable cacheable prompt blocks before tuning hit rate."
    };
  }
  if (
    typeof input.cacheablePrefixTokensEstimate === "number" &&
    typeof input.minimumCacheableTokens === "number" &&
    input.cacheablePrefixTokensEstimate < input.minimumCacheableTokens
  ) {
    return {
      outcome: "bypass",
      reason: `cacheable prefix is below provider threshold (${input.cacheablePrefixTokensEstimate}/${input.minimumCacheableTokens} tokens)`,
      recommendation: "Move stable system, tool, and workspace context into the cacheable prefix or expect no provider-side cache."
    };
  }
  if (input.status === "changed" || input.changed.length > 0) {
    return {
      outcome: "miss",
      reason: `stable prefix changed: ${input.changed.slice(0, 4).join(", ") || "unknown field"}`,
      recommendation: "Keep tool schemas, stable system text, model, cache key, and long-lived workspace context unchanged across turns."
    };
  }
  if (input.status === "new_scope") {
    return {
      outcome: "warming",
      reason: "first request for this cache scope",
      recommendation: "Run the same route/model/cache key again to measure the second-turn hit rate."
    };
  }
  if (input.status === "cache_miss" || (typeof input.cachedInputTokens === "number" && input.cachedInputTokens <= 0)) {
    return {
      outcome: "miss",
      reason: "provider reported no cached input tokens for an otherwise cacheable request",
      recommendation: "Check provider cache support, model compatibility, TTL, and whether the same prompt prefix was reused."
    };
  }
  if (typeof input.hitRate === "number" && input.hitRate > 0) {
    return {
      outcome: "hit",
      reason: `${Math.round(input.hitRate * 100)}% of input tokens were served from cache`,
      recommendation: input.hitRate < 0.5
        ? "Increase stable-prefix size and reduce per-turn changes before the cache boundary."
        : "Cache is working; keep the stable prefix and cache key unchanged."
    };
  }
  if (input.status === "expected_empty_cache") {
    return {
      outcome: "bypass",
      reason: "request is too small or otherwise expected to skip provider cache",
      recommendation: "Only tune cache for prompts above the provider minimum cacheable token threshold."
    };
  }
  if (typeof input.totalInputWithCacheTokens === "number" && input.totalInputWithCacheTokens > 0) {
    return {
      outcome: "unknown",
      reason: "usage was recorded but provider did not expose cache hit tokens",
      recommendation: "Inspect raw provider usage and cache diagnostics for this model/provider."
    };
  }
  return {
    outcome: "unknown",
    reason: "no provider cache usage has been recorded yet",
    recommendation: "Send a model request, then inspect /debug cache or the result card cache row."
  };
}
