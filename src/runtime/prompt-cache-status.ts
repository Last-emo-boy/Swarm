import { createHash } from "node:crypto";
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
  changedSections?: string[];
  missReason?: string;
  minimumCacheableTokens?: number;
  outcome?: "hit" | "miss" | "warming" | "bypass" | "unknown";
  reason?: string;
  recommendation?: string;
  cacheImpact?: SwarmContextCacheImpact;
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
  | "changedSections"
  | "missReason"
  | "minimumCacheableTokens"
  | "outcome"
  | "reason"
  | "recommendation"
  | "cacheImpact"
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
  changedSections: string[];
  missReasons: Record<string, number>;
  normalizedMissReasons: Record<CacheMissReason, number>;
  prefixIdentities: string[];
  estimatedSavingsTokens: number;
  facts: CacheFact[];
  latest?: ResultCardPromptCacheStatus;
};

export type PromptCacheSloThresholds = {
  minCalls?: number;
  minHitRate?: number;
  maxChangedPrefixMisses?: number;
  maxFallbackCalls?: number;
  maxProviderUsageMissingCalls?: number;
  maxUnexplainedMissRate?: number;
  minCacheablePrefixTokens?: number;
  requireTrend?: boolean;
};

export type PromptCacheSloEvaluation = {
  status: "pass" | "fail";
  state: "stable" | "warming" | "bypassed" | "degraded" | "unknown";
  source: PromptCacheTrend["source"];
  summary: string;
  failures: string[];
  metrics: {
    calls: number;
    hitTokens: number;
    cacheableTokens: number;
    writeTokens: number;
    hitRate?: number;
    changedPrefixMisses: number;
    fallbackCalls: number;
    providerUsageMissingCalls: number;
    estimatedSavingsTokens: number;
    unexplainedMisses: number;
    unexplainedMissRate?: number;
    minCacheablePrefixTokens?: number;
    prefixIdentities: string[];
    normalizedMissReasons: Record<CacheMissReason, number>;
    missReasons: Record<string, number>;
  };
};

export type CacheRoiPrice = {
  currency?: string;
  input_per_mtok: number;
  cached_input_per_mtok?: number;
  source?: string;
};

export type CacheRoi = {
  schema_version: "swarm.cache_roi.v1";
  source: PromptCacheTrend["source"];
  hit_tokens: number;
  miss_tokens: number;
  saved_tokens: number;
  estimated_saved_cost?: number;
  estimated_saved_cost_currency?: string;
  cost_source: "priced" | "unpriced";
  stable_prefix_ratio?: number;
  miss_reasons: Record<CacheMissReason, number>;
  policy_recommendations: string[];
};

type CacheRoiTrendLike = {
  source: PromptCacheTrend["source"];
  facts?: readonly unknown[];
  normalizedMissReasons?: Record<CacheMissReason, number>;
  normalized_miss_reasons?: Record<CacheMissReason, number>;
  hitRate?: number;
  hit_rate?: number;
  cacheableCalls?: number;
  cacheable_calls?: number;
  cachedInputTokens?: number;
  cached_input_tokens?: number;
  totalInputWithCacheTokens?: number;
  total_input_with_cache_tokens?: number;
  cacheCreationInputTokens?: number;
  cache_creation_input_tokens?: number;
  uncachedInputTokens?: number;
  uncached_input_tokens?: number;
  cacheablePrefixTokensEstimate?: number;
  cacheable_prefix_tokens_estimate?: number;
  estimatedSavingsTokens?: number;
  estimated_savings_tokens?: number;
};

export type CacheMissReason =
  | "cold_start"
  | "prefix_drift"
  | "context_overflow"
  | "provider_unsupported"
  | "provider_omitted_usage"
  | "unknown";

export type CacheFact = {
  providerId?: string;
  model?: string;
  purpose?: string;
  cacheMode?: string;
  status: string;
  outcome: NonNullable<PromptCacheRuntimeStatus["outcome"]> | "unknown";
  hitTokens: number;
  missTokens: number;
  writeTokens: number;
  cacheableTokens: number;
  cacheablePrefixTokensEstimate: number;
  minimumCacheableTokens?: number;
  hitRate?: number;
  writeRate?: number;
  estimatedSavingsTokens: number;
  prefixIdentity?: string;
  missReason?: string;
  normalizedMissReason?: CacheMissReason;
  changed: string[];
  changedSections: string[];
  reason?: string;
  recommendation?: string;
};

export type SwarmCacheContextKind =
  | "system"
  | "tool_schema"
  | "shared_context"
  | "artifact_summary"
  | "user_objective"
  | "active_task"
  | "actor_context"
  | "actor_state"
  | "mailbox"
  | "task_local"
  | "provider_prefix"
  | "other";

export type SwarmCacheImpactDimension =
  | "actor"
  | "context"
  | "schema"
  | "mailbox"
  | "stable_prefix"
  | "unknown";

export type SwarmContextCacheBlock = {
  id: string;
  kind: SwarmCacheContextKind;
  content?: string;
  hash?: string;
  tokens?: number;
  actorId?: string;
  protected?: boolean;
  changed?: boolean;
  reason?: string;
};

export type SwarmContextCacheImpactSegment = {
  segment_id: string;
  kind: SwarmCacheContextKind;
  phase: "stable_prefix" | "dynamic_suffix";
  content_hash: string;
  tokens: number;
  retained: boolean;
  protected: boolean;
  changed: boolean;
  actor_id?: string;
  reason?: string;
};

export type SwarmContextCacheImpact = {
  schema_version: "swarm.cache_impact.v1";
  stable_prefix_hash?: string;
  stable_prefix_tokens: number;
  dynamic_hash?: string;
  dynamic_tokens: number;
  tool_schema_hash?: string;
  mailbox_hash?: string;
  actor_hashes: Record<string, string>;
  context_hashes: Record<string, string>;
  changed_dimensions: SwarmCacheImpactDimension[];
  reasons: string[];
  recommendations: string[];
  retained_context: string[];
  dropped_context: string[];
  protected_context_retained: string[];
  stable_segments: SwarmContextCacheImpactSegment[];
  dynamic_segments: SwarmContextCacheImpactSegment[];
};

export type BuildSwarmContextCacheImpactInput = {
  stablePrefix: SwarmContextCacheBlock[];
  dynamicContext?: SwarmContextCacheBlock[];
  contextBudgetTokens?: number;
  changedSections?: string[];
  missReasons?: string[];
};

export function promptCacheStatusFromUsage(usage: ProviderUsageReport): PromptCacheRuntimeStatus {
  const hitRate = usage.cacheHitRate ?? (
    usage.totalInputWithCacheTokens && typeof usage.cachedInputTokens === "number"
      ? usage.cachedInputTokens / Math.max(1, usage.totalInputWithCacheTokens)
      : undefined
  );
  const changed = usage.promptCacheDiagnostics?.changed ?? [];
  const changedSections = usage.promptCacheDiagnostics?.changedSections ?? [];
  const missReason = usage.promptCacheDiagnostics?.missReason;
  const analysis = analyzePromptCacheUsage({
    status: usage.promptCacheDiagnostics?.status ?? "unknown",
    changed,
    changedSections,
    missReason,
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
    diagnostics: changedSections.length ? `sections:${changedSections.join(",")}` : changed.length ? changed.join(", ") : missReason ?? usage.promptCacheDiagnostics?.status,
    changed,
    changedSections,
    missReason,
    minimumCacheableTokens: usage.promptCacheDiagnostics?.minimumCacheableTokens,
    cacheImpact: swarmCacheImpactFromUsage([usage]),
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
  return promptCacheTrendFromCacheFacts(
    cacheFactsFromStatuses(statuses),
    statuses.length ? source : "none",
    statuses.at(-1)
  );
}

export function cacheFactsFromStatuses(statuses: ResultCardPromptCacheStatus[]): CacheFact[] {
  return statuses.map(cacheFactFromStatus);
}

export function cacheFactFromStatus(status: ResultCardPromptCacheStatus): CacheFact {
  const outcome = promptCacheTrendOutcome(status);
  const hitTokens = positiveTokenCount(status.cachedInputTokens);
  const writeTokens = positiveTokenCount(status.cacheCreationInputTokens);
  const cacheableTokens = positiveTokenCount(status.totalInputWithCacheTokens);
  const missTokens = cacheableTokens > 0 ? Math.max(0, cacheableTokens - hitTokens) : 0;
  const cacheablePrefixTokensEstimate = positiveTokenCount(status.cacheablePrefixTokensEstimate);
  const hitRate = typeof status.hitRate === "number"
    ? status.hitRate
    : cacheableTokens > 0
      ? hitTokens / cacheableTokens
      : undefined;
  const writeRate = typeof status.writeRate === "number"
    ? status.writeRate
    : cacheableTokens > 0
      ? writeTokens / cacheableTokens
      : undefined;
  const normalizedMissReason = normalizeCacheMissReason(status, outcome);
  return {
    providerId: safeCacheText(status.providerId),
    model: safeCacheText(status.model),
    purpose: safeCacheText(status.purpose),
    cacheMode: safeCacheText(status.cacheMode),
    status: safeCacheText(status.status) || "unknown",
    outcome,
    hitTokens,
    missTokens,
    writeTokens,
    cacheableTokens,
    cacheablePrefixTokensEstimate,
    minimumCacheableTokens: status.minimumCacheableTokens,
    hitRate,
    writeRate,
    estimatedSavingsTokens: hitTokens,
    prefixIdentity: promptCachePrefixIdentity(status),
    missReason: safeCacheText(status.missReason),
    normalizedMissReason,
    changed: safeCacheList(status.changed),
    changedSections: safeCacheList(status.changedSections),
    reason: safeCacheText(status.reason),
    recommendation: safeCacheText(status.recommendation)
  };
}

export function promptCacheTrendFromCacheFacts(
  facts: CacheFact[],
  source: PromptCacheTrend["source"] = "provider_usage",
  latest?: ResultCardPromptCacheStatus
): PromptCacheTrend {
  const trend: PromptCacheTrend = {
    source: facts.length ? source : "none",
    calls: facts.length,
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
    changed: [],
    changedSections: [],
    missReasons: {},
    normalizedMissReasons: emptyNormalizedMissReasonCounts(),
    prefixIdentities: [],
    estimatedSavingsTokens: 0,
    facts,
    latest
  };
  const changed = new Set<string>();
  const changedSections = new Set<string>();
  const prefixIdentities = new Set<string>();
  for (const fact of facts) {
    if (fact.outcome === "hit") trend.hitCalls += 1;
    else if (fact.outcome === "miss") trend.missCalls += 1;
    else if (fact.outcome === "warming") trend.warmingCalls += 1;
    else if (fact.outcome === "bypass") trend.bypassCalls += 1;
    else trend.unknownCalls += 1;

    if (fact.cacheableTokens > 0) {
      trend.cacheableCalls += 1;
      trend.totalInputWithCacheTokens += fact.cacheableTokens;
    }
    trend.cachedInputTokens += fact.hitTokens;
    trend.cacheCreationInputTokens += fact.writeTokens;
    trend.cacheablePrefixTokensEstimate += fact.cacheablePrefixTokensEstimate;
    trend.uncachedInputTokens += fact.missTokens;
    trend.estimatedSavingsTokens += fact.estimatedSavingsTokens;
    if (fact.status) {
      trend.diagnostics[fact.status] = (trend.diagnostics[fact.status] ?? 0) + 1;
    }
    for (const item of fact.changed) {
      changed.add(item);
    }
    for (const section of fact.changedSections) {
      changedSections.add(section);
    }
    if (fact.missReason) {
      trend.missReasons[fact.missReason] = (trend.missReasons[fact.missReason] ?? 0) + 1;
    }
    if (fact.normalizedMissReason) {
      trend.normalizedMissReasons[fact.normalizedMissReason] += 1;
    }
    if (fact.prefixIdentity) {
      prefixIdentities.add(fact.prefixIdentity);
    }
  }
  trend.changed = [...changed].sort();
  trend.changedSections = [...changedSections].sort();
  trend.prefixIdentities = [...prefixIdentities].sort();
  if (trend.totalInputWithCacheTokens > 0) {
    trend.hitRate = trend.cachedInputTokens / trend.totalInputWithCacheTokens;
    trend.writeRate = trend.cacheCreationInputTokens / trend.totalInputWithCacheTokens;
  }
  return trend;
}

export function evaluatePromptCacheSlo(
  trend: PromptCacheTrend,
  thresholds: PromptCacheSloThresholds = {}
): PromptCacheSloEvaluation {
  const fallbackCalls = trend.source === "result_card_fallback" ? trend.calls : 0;
  const providerUsageMissingCalls = trend.source === "result_card_fallback"
    ? trend.calls
    : trend.source === "none" && thresholds.requireTrend
      ? 1
      : 0;
  const changedPrefixMisses = trend.normalizedMissReasons.prefix_drift;
  const unexplainedMisses = trend.normalizedMissReasons.unknown;
  const unexplainedMissRate = trend.missCalls > 0 ? unexplainedMisses / trend.missCalls : undefined;
  const minCacheablePrefixTokens = minPositive(trend.facts.map((fact) => fact.cacheablePrefixTokensEstimate));
  const metrics: PromptCacheSloEvaluation["metrics"] = {
    calls: trend.calls,
    hitTokens: trend.cachedInputTokens,
    cacheableTokens: trend.totalInputWithCacheTokens,
    writeTokens: trend.cacheCreationInputTokens,
    hitRate: trend.hitRate,
    changedPrefixMisses,
    fallbackCalls,
    providerUsageMissingCalls,
    estimatedSavingsTokens: trend.estimatedSavingsTokens,
    unexplainedMisses,
    unexplainedMissRate,
    minCacheablePrefixTokens,
    prefixIdentities: trend.prefixIdentities,
    normalizedMissReasons: { ...trend.normalizedMissReasons },
    missReasons: { ...trend.missReasons }
  };
  const failures = [
    thresholds.requireTrend && trend.source === "none" ? "cache trend is missing" : undefined,
    typeof thresholds.minCalls === "number" && trend.calls < thresholds.minCalls
      ? `calls ${trend.calls} below minimum ${thresholds.minCalls}`
      : undefined,
    typeof thresholds.minHitRate === "number" && (trend.hitRate ?? 0) < thresholds.minHitRate
      ? `hit rate ${formatRateForSlo(trend.hitRate)} below minimum ${formatRateForSlo(thresholds.minHitRate)}`
      : undefined,
    typeof thresholds.maxChangedPrefixMisses === "number" && changedPrefixMisses > thresholds.maxChangedPrefixMisses
      ? `changed-prefix misses ${changedPrefixMisses} exceed ${thresholds.maxChangedPrefixMisses}`
      : undefined,
    typeof thresholds.maxFallbackCalls === "number" && fallbackCalls > thresholds.maxFallbackCalls
      ? `fallback cache calls ${fallbackCalls} exceed ${thresholds.maxFallbackCalls}`
      : undefined,
    typeof thresholds.maxProviderUsageMissingCalls === "number" && providerUsageMissingCalls > thresholds.maxProviderUsageMissingCalls
      ? `provider-usage missing calls ${providerUsageMissingCalls} exceed ${thresholds.maxProviderUsageMissingCalls}`
      : undefined,
    typeof thresholds.maxUnexplainedMissRate === "number" && (unexplainedMissRate ?? 0) > thresholds.maxUnexplainedMissRate
      ? `unexplained miss rate ${formatRateForSlo(unexplainedMissRate)} exceeds ${formatRateForSlo(thresholds.maxUnexplainedMissRate)}`
      : undefined,
    typeof thresholds.minCacheablePrefixTokens === "number" && (minCacheablePrefixTokens ?? 0) < thresholds.minCacheablePrefixTokens
      ? `cacheable prefix ${minCacheablePrefixTokens ?? 0} below minimum ${thresholds.minCacheablePrefixTokens}`
      : undefined
  ].filter((failure): failure is string => Boolean(failure));
  const status: PromptCacheSloEvaluation["status"] = failures.length ? "fail" : "pass";
  const state = promptCacheSloState(trend, status);
  return {
    status,
    state,
    source: trend.source,
    summary: formatPromptCacheSloSummary({
      status,
      state,
      source: trend.source,
      failures,
      metrics
    }),
    failures,
    metrics
  };
}

export function buildPromptCacheRoi(
  trend: PromptCacheTrend | CacheRoiTrendLike,
  options: { price?: CacheRoiPrice } = {}
): CacheRoi {
  const missReasons = roiMissReasons(trend);
  const stablePrefixRatio = trendTotalInputWithCacheTokens(trend) > 0
    ? clampRatio(trendCacheablePrefixTokensEstimate(trend) / trendTotalInputWithCacheTokens(trend))
    : undefined;
  const estimatedSavedCost = estimateSavedCost(trendEstimatedSavingsTokens(trend), options.price);
  return {
    schema_version: "swarm.cache_roi.v1",
    source: trend.source,
    hit_tokens: trendCachedInputTokens(trend),
    miss_tokens: trendUncachedInputTokens(trend),
    saved_tokens: trendEstimatedSavingsTokens(trend),
    estimated_saved_cost: estimatedSavedCost,
    estimated_saved_cost_currency: estimatedSavedCost === undefined ? undefined : options.price?.currency ?? "USD",
    cost_source: estimatedSavedCost === undefined ? "unpriced" : "priced",
    stable_prefix_ratio: stablePrefixRatio,
    miss_reasons: missReasons,
    policy_recommendations: cachePolicyRecommendations(trend, missReasons, stablePrefixRatio)
  };
}

export function formatPromptCacheRoiInline(roi: CacheRoi | undefined): string | undefined {
  if (!roi) {
    return undefined;
  }
  const missReasons = formatNormalizedMissReasons(roi.miss_reasons);
  return [
    `saved ${roi.saved_tokens}t`,
    `miss ${roi.miss_tokens}t`,
    typeof roi.stable_prefix_ratio === "number" ? `stable ${Math.round(roi.stable_prefix_ratio * 100)}%` : undefined,
    roi.estimated_saved_cost !== undefined ? `cost ${roi.estimated_saved_cost_currency ?? "USD"} ${formatCost(roi.estimated_saved_cost)}` : undefined,
    missReasons ? `miss_reasons ${missReasons}` : undefined,
    roi.policy_recommendations.length ? `rec ${roi.policy_recommendations.length}` : undefined
  ].filter(Boolean).join(" ");
}

export function buildSwarmContextCacheImpact(input: BuildSwarmContextCacheImpactInput): SwarmContextCacheImpact {
  const stableInput = input.stablePrefix ?? [];
  const dynamicInput = input.dynamicContext ?? [];
  const stableCandidates = stableInput.map((block, index) => cacheImpactSegment(block, "stable_prefix", index));
  const dynamicCandidates = [
    ...stableCandidates.filter((segment) => shouldForceDynamic(segment.kind)).map((segment) => ({ ...segment, phase: "dynamic_suffix" as const })),
    ...dynamicInput.map((block, index) => cacheImpactSegment(block, "dynamic_suffix", stableInput.length + index))
  ];
  const stableSegments = stableCandidates
    .filter((segment) => !shouldForceDynamic(segment.kind))
    .map((segment) => ({ ...segment, retained: true }));
  const dynamicSegments = applyContextBudget(dynamicCandidates, input.contextBudgetTokens, stableSegments);
  const retainedStable = stableSegments.filter((segment) => segment.retained);
  const retainedDynamic = dynamicSegments.filter((segment) => segment.retained);
  const changedDimensions = cacheImpactChangedDimensions({
    segments: [...stableSegments, ...dynamicSegments],
    changedSections: input.changedSections ?? [],
    missReasons: input.missReasons ?? []
  });
  return {
    schema_version: "swarm.cache_impact.v1",
    stable_prefix_hash: hashSegments("scp", retainedStable),
    stable_prefix_tokens: retainedStable.reduce((sum, segment) => sum + segment.tokens, 0),
    dynamic_hash: hashSegments("scd", retainedDynamic),
    dynamic_tokens: retainedDynamic.reduce((sum, segment) => sum + segment.tokens, 0),
    tool_schema_hash: hashSegments("sct", retainedStable.filter((segment) => segment.kind === "tool_schema")),
    mailbox_hash: hashSegments("scm", retainedDynamic.filter((segment) => segment.kind === "mailbox")),
    actor_hashes: groupedSegmentHashes("sca", retainedDynamic.filter((segment) => segment.actor_id), (segment) => segment.actor_id ?? "unknown"),
    context_hashes: groupedSegmentHashes("scc", [...retainedStable, ...retainedDynamic], (segment) => segment.kind),
    changed_dimensions: changedDimensions,
    reasons: cacheImpactReasons(changedDimensions, [...stableSegments, ...dynamicSegments], input.missReasons ?? []),
    recommendations: cacheImpactRecommendations(changedDimensions, dynamicSegments),
    retained_context: [...retainedStable, ...retainedDynamic].map((segment) => segment.segment_id).sort(),
    dropped_context: [...stableSegments, ...dynamicSegments].filter((segment) => !segment.retained).map((segment) => segment.segment_id).sort(),
    protected_context_retained: [...retainedStable, ...retainedDynamic]
      .filter((segment) => segment.protected)
      .map((segment) => segment.segment_id)
      .sort(),
    stable_segments: stableSegments,
    dynamic_segments: dynamicSegments
  };
}

export function swarmCacheImpactFromUsage(
  usages: ProviderUsageReport[],
  fallback?: ResultCardPromptCacheStatus
): SwarmContextCacheImpact | undefined {
  const latest = usages.at(-1);
  if (!latest) {
    return swarmCacheImpactFromPromptCacheStatus(fallback);
  }
  const current = latest.promptCacheDiagnostics?.current;
  const cacheableSections = current?.cacheableSectionHashes ?? {};
  const allSections = current?.sectionHashes ?? {};
  const stablePrefix: SwarmContextCacheBlock[] = [];
  stablePrefix.push(current
    ? {
        id: "provider_prefix",
        kind: "provider_prefix",
        hash: current.cacheablePrefixHash,
        tokens: latest.cacheablePrefixTokensEstimate
      }
    : {
        id: "provider_prefix",
        kind: "provider_prefix",
        hash: [latest.providerId, latest.model, latest.purpose, latest.cacheMode, latest.promptCacheKey].join("\u0000"),
        tokens: latest.cacheablePrefixTokensEstimate
      });
  if (current?.cacheableSystemHash) {
    stablePrefix.push({ id: "system", kind: "system", hash: current.cacheableSystemHash });
  }
  if (current?.toolSchemaHash) {
    stablePrefix.push({ id: "tool_schema", kind: "tool_schema", hash: current.toolSchemaHash });
  }
  if (cacheableSections.workspace) {
    stablePrefix.push({ id: "shared_context", kind: "shared_context", hash: cacheableSections.workspace });
  }
  if (cacheableSections.context) {
    stablePrefix.push({ id: "context_cacheable", kind: "shared_context", hash: cacheableSections.context });
  }
  const dynamicContext: SwarmContextCacheBlock[] = [];
  if (allSections.task) {
    dynamicContext.push({ id: "active_task", kind: "active_task", hash: allSections.task, protected: true });
  }
  if (allSections.context) {
    dynamicContext.push({ id: "task_local_context", kind: "task_local", hash: allSections.context });
  }
  if (allSections.volatile_footer) {
    dynamicContext.push({ id: "actor_runtime_state", kind: "actor_state", hash: allSections.volatile_footer });
  }
  return buildSwarmContextCacheImpact({
    stablePrefix,
    dynamicContext,
    changedSections: latest.promptCacheDiagnostics?.changedSections ?? [],
    missReasons: latest.promptCacheDiagnostics?.missReason ? [latest.promptCacheDiagnostics.missReason] : undefined
  });
}

export function swarmCacheImpactFromPromptCacheStatus(
  status: ResultCardPromptCacheStatus | undefined
): SwarmContextCacheImpact | undefined {
  if (!status) {
    return undefined;
  }
  return buildSwarmContextCacheImpact({
    stablePrefix: [{
      id: "provider_prefix",
      kind: "provider_prefix",
      hash: [
        status.providerId,
        status.model,
        status.purpose,
        status.cacheMode,
        status.promptCacheKey,
        status.promptCacheScope
      ].filter(Boolean).join("\u0000") || status.status,
      tokens: status.cacheablePrefixTokensEstimate
    }],
    changedSections: status.changedSections ?? [],
    missReasons: status.missReason ? [status.missReason] : undefined
  });
}

export function formatSwarmContextCacheImpact(impact: SwarmContextCacheImpact | undefined): string | undefined {
  if (!impact) {
    return undefined;
  }
  return [
    "Swarm Cache Impact",
    impact.stable_prefix_hash ? `stable_prefix_hash=${impact.stable_prefix_hash}` : undefined,
    `stable_prefix_tokens=${impact.stable_prefix_tokens}`,
    impact.dynamic_hash ? `dynamic_hash=${impact.dynamic_hash}` : undefined,
    `dynamic_tokens=${impact.dynamic_tokens}`,
    impact.tool_schema_hash ? `tool_schema_hash=${impact.tool_schema_hash}` : undefined,
    impact.mailbox_hash ? `mailbox_hash=${impact.mailbox_hash}` : undefined,
    Object.keys(impact.actor_hashes).length ? `actor_hashes=${formatCacheImpactMap(impact.actor_hashes)}` : undefined,
    Object.keys(impact.context_hashes).length ? `context_hashes=${formatCacheImpactMap(impact.context_hashes)}` : undefined,
    impact.changed_dimensions.length ? `changed_dimensions=${impact.changed_dimensions.join(", ")}` : undefined,
    impact.reasons.length ? `reasons=${impact.reasons.join(" | ")}` : undefined,
    impact.recommendations.length ? `recommendations=${impact.recommendations.join(" | ")}` : undefined,
    impact.protected_context_retained.length ? `protected_context_retained=${impact.protected_context_retained.join(", ")}` : undefined,
    impact.dropped_context.length ? `dropped_context=${impact.dropped_context.join(", ")}` : undefined,
    impact.stable_segments.length ? `stable_segments=${formatCacheImpactSegments(impact.stable_segments)}` : undefined,
    impact.dynamic_segments.length ? `dynamic_segments=${formatCacheImpactSegments(impact.dynamic_segments)}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function promptCacheTrendOutcome(status: ResultCardPromptCacheStatus): NonNullable<PromptCacheRuntimeStatus["outcome"]> {
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

function normalizeCacheMissReason(
  status: ResultCardPromptCacheStatus,
  outcome: PromptCacheRuntimeStatus["outcome"] | "unknown"
): CacheMissReason | undefined {
  const raw = status.missReason ?? status.status;
  if (outcome === "hit") {
    return undefined;
  }
  if (status.status === "new_scope" || raw === "first_call") {
    return "cold_start";
  }
  if (status.changed?.length || status.changedSections?.length || /^changed_/i.test(raw ?? "")) {
    return "prefix_drift";
  }
  if (
    typeof status.cacheablePrefixTokensEstimate === "number" &&
    typeof status.minimumCacheableTokens === "number" &&
    status.cacheablePrefixTokensEstimate < status.minimumCacheableTokens
  ) {
    return "context_overflow";
  }
  if (status.cacheMode === "off" || status.cacheMode === "disabled" || status.cacheMode === "none" || status.status === "expected_empty_cache") {
    return "provider_unsupported";
  }
  if (raw === "provider_no_cache" || status.status === "cache_miss") {
    return "provider_omitted_usage";
  }
  if (outcome === "miss") {
    return "unknown";
  }
  return undefined;
}

function promptCachePrefixIdentity(status: ResultCardPromptCacheStatus): string | undefined {
  const source = [
    status.providerId,
    status.model,
    status.purpose,
    status.cacheMode,
    status.promptCacheScope,
    status.promptCacheKey
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\u0000");
  if (!source) {
    return undefined;
  }
  return `pcx:${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}

function cacheImpactSegment(
  block: SwarmContextCacheBlock,
  phase: SwarmContextCacheImpactSegment["phase"],
  index: number
): SwarmContextCacheImpactSegment {
  const id = safeCacheIdentifier(block.id, `segment_${index}`);
  const hashSource = block.hash ?? block.content ?? block.id;
  const tokens = positiveTokenCount(block.tokens) || estimateCacheImpactTokens(block.content ?? block.hash ?? block.id);
  return {
    segment_id: id,
    kind: block.kind,
    phase,
    content_hash: cacheImpactHash("sch", hashSource),
    tokens,
    retained: true,
    protected: block.protected === true || block.kind === "user_objective" || block.kind === "active_task",
    changed: block.changed === true,
    actor_id: safeCacheText(block.actorId),
    reason: safeCacheText(block.reason)
  };
}

function applyContextBudget(
  dynamicSegments: SwarmContextCacheImpactSegment[],
  contextBudgetTokens: number | undefined,
  stableSegments: SwarmContextCacheImpactSegment[]
): SwarmContextCacheImpactSegment[] {
  if (typeof contextBudgetTokens !== "number" || !Number.isFinite(contextBudgetTokens) || contextBudgetTokens <= 0) {
    return dynamicSegments.map((segment) => ({ ...segment, retained: true }));
  }
  const stableTokens = stableSegments.reduce((sum, segment) => sum + segment.tokens, 0);
  let remaining = Math.max(0, Math.floor(contextBudgetTokens) - stableTokens);
  const retainedIds = new Set<string>();
  const protectedSegments = dynamicSegments.filter((segment) => segment.protected);
  for (const segment of protectedSegments) {
    retainedIds.add(segment.segment_id);
    remaining -= segment.tokens;
  }
  if (remaining > 0) {
    for (const segment of [...dynamicSegments].reverse()) {
      if (retainedIds.has(segment.segment_id)) {
        continue;
      }
      if (segment.tokens <= remaining) {
        retainedIds.add(segment.segment_id);
        remaining -= segment.tokens;
      }
    }
  }
  return dynamicSegments.map((segment) => ({ ...segment, retained: retainedIds.has(segment.segment_id) }));
}

function shouldForceDynamic(kind: SwarmCacheContextKind): boolean {
  return kind === "actor_state" || kind === "mailbox" || kind === "task_local";
}

function cacheImpactChangedDimensions(input: {
  segments: SwarmContextCacheImpactSegment[];
  changedSections: string[];
  missReasons: string[];
}): SwarmCacheImpactDimension[] {
  const dimensions = new Set<SwarmCacheImpactDimension>();
  for (const segment of input.segments) {
    if (!segment.changed) {
      continue;
    }
    dimensions.add(cacheImpactDimensionForKind(segment.kind));
  }
  for (const section of input.changedSections) {
    dimensions.add(cacheImpactDimensionForChangedToken(section));
  }
  for (const reason of input.missReasons) {
    dimensions.add(cacheImpactDimensionForChangedToken(reason));
  }
  dimensions.delete("unknown");
  if (dimensions.size === 0 && (input.changedSections.length > 0 || input.missReasons.length > 0)) {
    dimensions.add("unknown");
  }
  return [...dimensions].sort();
}

function cacheImpactDimensionForKind(kind: SwarmCacheContextKind): SwarmCacheImpactDimension {
  if (kind === "actor_context" || kind === "actor_state") {
    return "actor";
  }
  if (kind === "mailbox") {
    return "mailbox";
  }
  if (kind === "tool_schema") {
    return "schema";
  }
  if (kind === "system" || kind === "provider_prefix") {
    return "stable_prefix";
  }
  if (kind === "shared_context" || kind === "artifact_summary" || kind === "user_objective" || kind === "active_task" || kind === "task_local") {
    return "context";
  }
  return "unknown";
}

function cacheImpactDimensionForChangedToken(value: string): SwarmCacheImpactDimension {
  const normalized = value.toLowerCase();
  if (normalized.includes("tool") || normalized.includes("schema")) {
    return "schema";
  }
  if (normalized.includes("mailbox")) {
    return "mailbox";
  }
  if (normalized.includes("actor") || normalized.includes("volatile")) {
    return "actor";
  }
  if (normalized.includes("workspace") || normalized.includes("context") || normalized.includes("task") || normalized.includes("objective")) {
    return "context";
  }
  if (normalized.includes("system") || normalized.includes("prefix") || normalized.includes("cacheable")) {
    return "stable_prefix";
  }
  return "unknown";
}

function cacheImpactReasons(
  dimensions: SwarmCacheImpactDimension[],
  segments: SwarmContextCacheImpactSegment[],
  missReasons: string[]
): string[] {
  const droppedProtected = segments.filter((segment) => segment.protected && !segment.retained).map((segment) => segment.segment_id);
  return uniqueStrings([
    ...missReasons.map((reason) => `miss_reason=${safeCacheText(reason) ?? "unknown"}`),
    dimensions.includes("schema") ? "tool schema changed before the cache boundary" : undefined,
    dimensions.includes("context") ? "shared or task context changed across repeated calls" : undefined,
    dimensions.includes("actor") ? "actor runtime state should stay behind the cache boundary" : undefined,
    dimensions.includes("mailbox") ? "mailbox payload should remain dynamic and uncached" : undefined,
    dimensions.includes("stable_prefix") ? "stable prefix identity changed" : undefined,
    droppedProtected.length ? `protected context dropped: ${droppedProtected.join(", ")}` : undefined
  ]);
}

function cacheImpactRecommendations(
  dimensions: SwarmCacheImpactDimension[],
  dynamicSegments: SwarmContextCacheImpactSegment[]
): string[] {
  const hasDroppedProtected = dynamicSegments.some((segment) => segment.protected && !segment.retained);
  return uniqueStrings([
    dimensions.includes("schema")
      ? "Keep tool schemas and ordering deterministic for the same route."
      : undefined,
    dimensions.includes("context")
      ? "Keep reusable shared summaries stable and move task-local retrieval behind the cache boundary."
      : undefined,
    dimensions.includes("actor")
      ? "Exclude actor heartbeat, status, and turn counters from the stable prefix."
      : undefined,
    dimensions.includes("mailbox")
      ? "Keep mailbox payloads in the dynamic suffix so delivery changes do not churn the prefix."
      : undefined,
    hasDroppedProtected
      ? "Increase context budget or reduce volatile tail size so user objective and active task remain available."
      : undefined
  ]);
}

function hashSegments(prefix: string, segments: SwarmContextCacheImpactSegment[]): string | undefined {
  const retained = segments.filter((segment) => segment.retained);
  if (retained.length === 0) {
    return undefined;
  }
  const source = retained
    .map((segment) => `${segment.segment_id}\u0000${segment.kind}\u0000${segment.content_hash}`)
    .join("\u0001");
  return cacheImpactHash(prefix, source);
}

function groupedSegmentHashes(
  prefix: string,
  segments: SwarmContextCacheImpactSegment[],
  groupBy: (segment: SwarmContextCacheImpactSegment) => string
): Record<string, string> {
  const groups = new Map<string, SwarmContextCacheImpactSegment[]>();
  for (const segment of segments.filter((item) => item.retained)) {
    const group = safeCacheIdentifier(groupBy(segment), "unknown");
    groups.set(group, [...(groups.get(group) ?? []), segment]);
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupSegments]) => [group, hashSegments(prefix, groupSegments) ?? cacheImpactHash(prefix, group)]));
}

function formatCacheImpactMap(value: Record<string, string>): string {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, hash]) => `${key}:${hash}`)
    .join(", ");
}

function formatCacheImpactSegments(segments: SwarmContextCacheImpactSegment[]): string {
  return segments.map((segment) => [
    segment.segment_id,
    segment.kind,
    segment.retained ? "kept" : "dropped",
    segment.protected ? "protected" : undefined,
    segment.changed ? "changed" : undefined
  ].filter(Boolean).join(":")).join(", ");
}

function cacheImpactHash(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function safeCacheIdentifier(value: string | undefined, fallback: string): string {
  const text = safeCacheText(value)?.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "");
  return text ? text.slice(0, 80) : fallback;
}

function estimateCacheImpactTokens(value: string | undefined): number {
  return value ? Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4)) : 0;
}

function positiveTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeCacheText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-REDACTED")
    .replace(/\b(api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=REDACTED")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer REDACTED")
    .replace(/(authorization\s*[:=]\s*)["']?Bearer\s+[^"'\s,;]+/gi, "$1Bearer REDACTED")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!redacted) {
    return undefined;
  }
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

function safeCacheDiagnosticText(value: string | undefined): string | undefined {
  const redacted = safeCacheText(value);
  if (!redacted || redacted.length > 120 || /raw prompt|system prompt|user prompt/i.test(redacted)) {
    return undefined;
  }
  return redacted;
}

function safeCacheList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(safeCacheText).filter((item): item is string => Boolean(item)))].sort();
}

function emptyNormalizedMissReasonCounts(): Record<CacheMissReason, number> {
  return {
    cold_start: 0,
    prefix_drift: 0,
    context_overflow: 0,
    provider_unsupported: 0,
    provider_omitted_usage: 0,
    unknown: 0
  };
}

function minPositive(values: number[]): number | undefined {
  const positives = values.filter((value) => Number.isFinite(value) && value > 0);
  return positives.length ? Math.min(...positives) : undefined;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function estimateSavedCost(savedTokens: number, price: CacheRoiPrice | undefined): number | undefined {
  if (!price || !Number.isFinite(price.input_per_mtok) || price.input_per_mtok <= 0) {
    return undefined;
  }
  const cachedInputPerMTok = Number.isFinite(price.cached_input_per_mtok)
    ? Math.max(0, price.cached_input_per_mtok ?? 0)
    : 0;
  const savedPerMTok = Math.max(0, price.input_per_mtok - cachedInputPerMTok);
  return Number(((savedTokens / 1_000_000) * savedPerMTok).toFixed(6));
}

function roiMissReasons(trend: CacheRoiTrendLike): Record<CacheMissReason, number> {
  const reasons = { ...trendNormalizedMissReasons(trend) };
  if (trendFacts(trend).length === 0 && trendCacheableCalls(trend) > 0 && Object.values(reasons).every((count) => count === 0)) {
    reasons.unknown = trendCacheableCalls(trend);
  }
  return reasons;
}

function cachePolicyRecommendations(
  trend: CacheRoiTrendLike,
  missReasons: Record<CacheMissReason, number>,
  stablePrefixRatio: number | undefined
): string[] {
  return uniqueStrings([
    trend.source === "none"
      ? "Capture provider usage before tuning cache ROI."
      : undefined,
    trend.source === "result_card_fallback"
      ? "Prefer provider usage telemetry over result-card fallback when comparing cache ROI."
      : undefined,
    missReasons.cold_start > 0
      ? "Repeat the same route, model, cache key, and stable prefix to separate cold-start warming from real misses."
      : undefined,
    missReasons.prefix_drift > 0
      ? "Keep system text, tool schemas, model, cache key, and stable workspace context deterministic before the cache boundary."
      : undefined,
    missReasons.context_overflow > 0
      ? "Move durable system, tool, and workspace blocks ahead of the cache boundary and keep volatile retrieval later."
      : undefined,
    missReasons.provider_unsupported > 0
      ? "Use a cache-capable provider/model or disable cache ROI expectations for this route."
      : undefined,
    missReasons.provider_omitted_usage > 0
      ? "Inspect provider cache support, response usage fields, model compatibility, and TTL before trusting hit-rate metrics."
      : undefined,
    missReasons.unknown > 0
      ? "Add provider-normalized cache diagnostics so every miss has an enum reason."
      : undefined,
    typeof trendHitRate(trend) === "number" && trendCacheableCalls(trend) >= 2 && trendHitRate(trend)! < 0.3
      ? "Reduce volatile prompt segments before the cache boundary; current repeated-call hit rate is low."
      : undefined,
    typeof stablePrefixRatio === "number" && stablePrefixRatio < 0.35 && trendTotalInputWithCacheTokens(trend) > 0
      ? "Increase the stable-prefix share of total input so cacheable context contributes meaningful savings."
      : undefined
  ].filter((item): item is string => Boolean(item)));
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
    changedSections: status.changedSections,
    missReason: status.missReason,
    minimumCacheableTokens: status.minimumCacheableTokens,
    outcome: status.outcome,
    reason: status.reason,
    recommendation: status.recommendation,
    cacheImpact: status.cacheImpact
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
  const fact = cacheFactFromStatus(resultCardCacheStatus(status) ?? status);
  const roi = buildPromptCacheRoi(trend ?? promptCacheTrendFromResultCardCache(resultCardCacheStatus(status)));
  const cacheImpact = status.cacheImpact ?? swarmCacheImpactFromPromptCacheStatus(resultCardCacheStatus(status));
  const trendJson = trend ? {
    source: trend.source,
    calls: trend.calls,
    cacheableCalls: trend.cacheableCalls,
    hitCalls: trend.hitCalls,
    missCalls: trend.missCalls,
    warmingCalls: trend.warmingCalls,
    bypassCalls: trend.bypassCalls,
    unknownCalls: trend.unknownCalls,
    cachedInputTokens: trend.cachedInputTokens,
    totalInputWithCacheTokens: trend.totalInputWithCacheTokens,
    cacheCreationInputTokens: trend.cacheCreationInputTokens,
    uncachedInputTokens: trend.uncachedInputTokens,
    estimatedSavingsTokens: trend.estimatedSavingsTokens,
    hitRate: trend.hitRate,
    writeRate: trend.writeRate,
    changed: trend.changed,
    changedSections: trend.changedSections,
    missReasons: trend.missReasons,
    normalizedMissReasons: trend.normalizedMissReasons,
    prefixIdentities: trend.prefixIdentities,
    facts: trend.facts
  } : undefined;
  const lines = [
    `status=${fact.status}`,
    fact.cacheMode ? `mode=${fact.cacheMode}` : undefined,
    fact.providerId ? `provider=${fact.providerId}` : undefined,
    fact.model ? `model=${fact.model}` : undefined,
    fact.purpose ? `purpose=${fact.purpose}` : undefined,
    fact.prefixIdentity ? `prefix_identity=${fact.prefixIdentity}` : undefined,
    formatPromptCacheRates({ hitRate: fact.hitRate, writeRate: fact.writeRate }),
    `hit_tokens=${fact.hitTokens}`,
    `miss_tokens=${fact.missTokens}`,
    `write_tokens=${fact.writeTokens}`,
    `cacheable_tokens=${fact.cacheableTokens}`,
    `estimated_savings_tokens=${fact.estimatedSavingsTokens}`,
    `cacheable_prefix_tokens_estimate=${fact.cacheablePrefixTokensEstimate}`,
    typeof fact.minimumCacheableTokens === "number" ? `minimum_cacheable_tokens=${fact.minimumCacheableTokens}` : undefined,
    roi ? `roi_saved_tokens=${roi.saved_tokens}` : undefined,
    roi ? `roi_miss_tokens=${roi.miss_tokens}` : undefined,
    roi && typeof roi.stable_prefix_ratio === "number" ? `stable_prefix_ratio=${Math.round(roi.stable_prefix_ratio * 100)}%` : undefined,
    roi?.policy_recommendations.length ? `policy_recommendations=${roi.policy_recommendations.join(" | ")}` : undefined,
    `outcome=${fact.outcome}`,
    fact.missReason ? `miss_reason=${fact.missReason}` : undefined,
    fact.normalizedMissReason ? `normalized_miss_reason=${fact.normalizedMissReason}` : undefined,
    fact.reason ? `reason=${fact.reason}` : undefined,
    fact.recommendation ? `recommendation=${fact.recommendation}` : undefined,
    fact.changedSections.length ? `changed_sections=${fact.changedSections.join(", ")}` : undefined,
    fact.changed.length ? `changed=${fact.changed.join(", ")}` : undefined,
    safeCacheDiagnosticText(status.diagnostics) ? `diagnostics=${safeCacheDiagnosticText(status.diagnostics)}` : undefined,
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
      `estimated_savings_tokens=${trend.estimatedSavingsTokens}`,
      `cacheable_prefix_tokens_estimate=${trend.cacheablePrefixTokensEstimate}`,
      trend.prefixIdentities.length ? `prefix_identities=${trend.prefixIdentities.join(", ")}` : undefined,
      trend.changedSections.length ? `changed_sections=${trend.changedSections.join(", ")}` : undefined,
      trend.changed.length ? `changed=${trend.changed.join(", ")}` : undefined,
      Object.keys(trend.missReasons).length ? `miss_reasons=${Object.entries(trend.missReasons).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join(", ")}` : undefined,
      `normalized_miss_reasons=${formatNormalizedMissReasons(trend.normalizedMissReasons)}`,
      Object.keys(trend.diagnostics).length ? `diagnostics=${Object.entries(trend.diagnostics).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join(", ")}` : undefined
    ] : []),
    ...(cacheImpact ? [
      "",
      formatSwarmContextCacheImpact(cacheImpact)
    ] : []),
    "",
    "JSON",
    JSON.stringify({ fact, roi, trend: trendJson, cacheImpact }, null, 2)
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function formatPromptCacheInline(status: ResultCardPromptCacheStatus | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  const fact = cacheFactFromStatus(status);
  const roi = buildPromptCacheRoi(promptCacheTrendFromResultCardCache(status));
  const rates = formatPromptCacheRates({ hitRate: fact.hitRate, writeRate: fact.writeRate });
  const changedSections = fact.changedSections.length ? ` sections ${fact.changedSections.join(",")}` : "";
  const visibleReason = fact.missReason ?? fact.normalizedMissReason;
  const missReason = visibleReason ? ` reason ${visibleReason}` : "";
  const normalized = fact.normalizedMissReason && fact.normalizedMissReason !== visibleReason
    ? ` normalized ${fact.normalizedMissReason}`
    : "";
  const prefix = fact.prefixIdentity ? ` prefix ${fact.prefixIdentity}` : "";
  const diagnostics = safeCacheDiagnosticText(status.diagnostics);
  const roiInline = formatPromptCacheRoiInline(roi);
  return `cache:${fact.status}${rates ? ` ${rates}` : ""} ${fact.outcome}${missReason}${normalized}${changedSections}${prefix}${roiInline ? ` ${roiInline}` : ""}${diagnostics ? ` ${diagnostics}` : ""}`;
}

function formatPromptCacheRates(status: Pick<PromptCacheRuntimeStatus, "hitRate" | "writeRate">): string {
  return [
    typeof status.hitRate === "number" ? `hit ${Math.round(status.hitRate * 100)}%` : undefined,
    typeof status.writeRate === "number" ? `write ${Math.round(status.writeRate * 100)}%` : undefined
  ].filter(Boolean).join(", ");
}

function promptCacheSloState(
  trend: PromptCacheTrend,
  status: PromptCacheSloEvaluation["status"]
): PromptCacheSloEvaluation["state"] {
  if (status === "fail") {
    return "degraded";
  }
  if (trend.source === "none" || trend.calls === 0) {
    return "unknown";
  }
  if (trend.bypassCalls > 0 && trend.hitCalls === 0 && trend.missCalls === 0) {
    return "bypassed";
  }
  if (trend.warmingCalls > 0 && trend.hitCalls === 0 && trend.missCalls === 0) {
    return "warming";
  }
  if (trend.hitCalls > 0 && trend.missCalls === 0) {
    return "stable";
  }
  if (trend.hitCalls > 0 && typeof trend.hitRate === "number" && trend.hitRate > 0) {
    return "stable";
  }
  return "unknown";
}

function formatPromptCacheSloSummary(input: Pick<PromptCacheSloEvaluation, "status" | "state" | "source" | "failures" | "metrics">): string {
  const missReasons = Object.entries(input.metrics.missReasons)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
  const normalizedMissReasons = formatNormalizedMissReasons(input.metrics.normalizedMissReasons);
  const prefixIdentities = input.metrics.prefixIdentities.slice(0, 4).join(",");
  const base = [
    `cache_slo=${input.status}`,
    `state=${input.state}`,
    `source=${input.source}`,
    `calls=${input.metrics.calls}`,
    `hit_tokens=${input.metrics.hitTokens}`,
    `cacheable_tokens=${input.metrics.cacheableTokens}`,
    `write_tokens=${input.metrics.writeTokens}`,
    `hit_rate=${formatRateForSlo(input.metrics.hitRate)}`,
    `estimated_savings_tokens=${input.metrics.estimatedSavingsTokens}`,
    `changed_prefix_misses=${input.metrics.changedPrefixMisses}`,
    `unexplained_miss_rate=${formatRateForSlo(input.metrics.unexplainedMissRate)}`,
    `fallback_calls=${input.metrics.fallbackCalls}`,
    `provider_usage_missing=${input.metrics.providerUsageMissingCalls}`,
    typeof input.metrics.minCacheablePrefixTokens === "number" ? `min_cacheable_prefix_tokens=${input.metrics.minCacheablePrefixTokens}` : undefined,
    normalizedMissReasons ? `normalized_miss_reasons=${normalizedMissReasons}` : undefined,
    prefixIdentities ? `prefix_identities=${prefixIdentities}` : undefined,
    missReasons ? `miss_reasons=${missReasons}` : undefined
  ].filter(Boolean).join(" ");
  return input.failures.length ? `${base} failures=${input.failures.join("; ")}` : base;
}

function formatNormalizedMissReasons(reasons: Record<CacheMissReason, number>): string {
  return Object.entries(reasons)
    .filter((entry): entry is [CacheMissReason, number] => entry[1] > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

function formatRateForSlo(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.trim()).filter(Boolean))];
}

function formatCost(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function trendValue(trend: CacheRoiTrendLike, camelKey: string, snakeKey: string): unknown {
  const record = trend as Record<string, unknown>;
  return record[camelKey] ?? record[snakeKey];
}

function trendNumber(trend: CacheRoiTrendLike, camelKey: string, snakeKey: string): number | undefined {
  const value = trendValue(trend, camelKey, snakeKey);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function trendRequiredNumber(trend: CacheRoiTrendLike, camelKey: string, snakeKey: string): number {
  return trendNumber(trend, camelKey, snakeKey) ?? 0;
}

function trendFacts(trend: CacheRoiTrendLike): CacheFact[] {
  const value = trendValue(trend, "facts", "facts");
  return Array.isArray(value) ? value.filter((item): item is CacheFact => Boolean(item)) : [];
}

function trendNormalizedMissReasons(trend: CacheRoiTrendLike): Record<CacheMissReason, number> {
  const value = trendValue(trend, "normalizedMissReasons", "normalized_miss_reasons");
  if (!isRecord(value)) {
    return emptyNormalizedMissReasonCounts();
  }
  return {
    cold_start: numberFromRecord(value, "cold_start"),
    prefix_drift: numberFromRecord(value, "prefix_drift"),
    context_overflow: numberFromRecord(value, "context_overflow"),
    provider_unsupported: numberFromRecord(value, "provider_unsupported"),
    provider_omitted_usage: numberFromRecord(value, "provider_omitted_usage"),
    unknown: numberFromRecord(value, "unknown")
  };
}

function trendHitRate(trend: CacheRoiTrendLike): number | undefined {
  return trendNumber(trend, "hitRate", "hit_rate");
}

function trendCacheableCalls(trend: CacheRoiTrendLike): number {
  return trendRequiredNumber(trend, "cacheableCalls", "cacheable_calls");
}

function trendCachedInputTokens(trend: CacheRoiTrendLike): number {
  return trendRequiredNumber(trend, "cachedInputTokens", "cached_input_tokens");
}

function trendTotalInputWithCacheTokens(trend: CacheRoiTrendLike): number {
  return trendRequiredNumber(trend, "totalInputWithCacheTokens", "total_input_with_cache_tokens");
}

function trendCacheCreationInputTokens(trend: CacheRoiTrendLike): number {
  return trendRequiredNumber(trend, "cacheCreationInputTokens", "cache_creation_input_tokens");
}

function trendUncachedInputTokens(trend: CacheRoiTrendLike): number {
  const explicit = trendNumber(trend, "uncachedInputTokens", "uncached_input_tokens");
  if (typeof explicit === "number") {
    return explicit;
  }
  const total = trendTotalInputWithCacheTokens(trend);
  const hit = trendCachedInputTokens(trend);
  return Math.max(0, total - hit);
}

function trendCacheablePrefixTokensEstimate(trend: CacheRoiTrendLike): number {
  return trendRequiredNumber(trend, "cacheablePrefixTokensEstimate", "cacheable_prefix_tokens_estimate");
}

function trendEstimatedSavingsTokens(trend: CacheRoiTrendLike): number {
  const explicit = trendNumber(trend, "estimatedSavingsTokens", "estimated_savings_tokens");
  return typeof explicit === "number" ? explicit : trendCachedInputTokens(trend);
}

function numberFromRecord(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function analyzePromptCacheUsage(input: {
  status: string;
  changed: string[];
  changedSections: string[];
  missReason?: string;
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
    if (input.changedSections.length > 0) {
      return {
        outcome: "miss",
        reason: `stable prefix changed: ${input.changedSections.slice(0, 4).join(", ")}`,
        recommendation: cacheRecommendationForMissReason(input.missReason)
      };
    }
    return {
      outcome: "miss",
      reason: input.missReason ? `miss_reason=${input.missReason}` : `stable prefix changed: ${input.changed.slice(0, 4).join(", ") || "unknown field"}`,
      recommendation: cacheRecommendationForMissReason(input.missReason)
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
      reason: input.missReason ? `miss_reason=${input.missReason}` : "provider reported no cached input tokens for an otherwise cacheable request",
      recommendation: input.missReason
        ? cacheRecommendationForMissReason(input.missReason)
        : "Check provider cache support, model compatibility, TTL, and whether the same prompt prefix was reused."
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

function cacheRecommendationForMissReason(missReason: string | undefined): string {
  if (missReason === "changed_tools") {
    return "Keep tool schemas and allowed-tool ordering deterministic across turns.";
  }
  if (missReason === "changed_workspace") {
    return "Keep stable workspace summaries deterministic and move volatile git/recent-file state behind the cache boundary.";
  }
  if (missReason === "changed_system") {
    return "Keep stable system text, model, and cache policy unchanged across turns.";
  }
  if (missReason === "changed_task" || missReason === "changed_context") {
    return "Keep reusable context before the cache boundary and move task-specific or volatile context later in the prompt.";
  }
  if (missReason === "provider_no_cache") {
    return "Check provider cache support, model compatibility, TTL, and whether the same prompt prefix was reused.";
  }
  return "Keep tool schemas, stable system text, model, cache key, and long-lived workspace context unchanged across turns.";
}
