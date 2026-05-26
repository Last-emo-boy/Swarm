import type { RuntimeEvent } from "./events.js";
import type {
  HeadlessArtifactIndex,
  HeadlessRunReport,
  HeadlessTelemetry,
  ParityReleaseGateSummary
} from "./headless-artifacts.js";
import type { LspStatusReport } from "../lsp/manager.js";
import type { SemanticEvidence } from "../lsp/types.js";
import {
  formatSymphonyActionStatus,
  latestSymphonyActionFact,
  type SymphonyActionFact
} from "../symphony/action-lifecycle.js";
import {
  buildPromptCacheRoi,
  cacheFactFromStatus,
  type PromptCacheRuntimeStatus,
  type PromptCacheTrend
} from "./prompt-cache-status.js";
import {
  formatProtocolMigrationAudit,
  type ProtocolMigrationAudit
} from "./protocol-replay.js";
import type { ResultCard } from "./result-card.js";
import type { RecoveryAdvice } from "./recovery.js";
import {
  formatRecoveryAdviceInline,
  recoveryAdviceFromProviderError,
  recoveryAdviceFromSuggestion,
  recoveryAdviceFromToolFailure,
  redactSensitive
} from "./recovery.js";

export type LatestDetailSource = "none" | "ai" | "task" | "command" | "event";

export type LatestRunDiagnosisInput = {
  report?: HeadlessRunReport;
  telemetry?: HeadlessTelemetry;
  events?: RuntimeEvent[];
  resultCard?: ResultCard;
  latestDetail?: {
    source?: LatestDetailSource;
    title?: string;
    route?: string;
    sessionId?: string;
  };
  promptCache?: PromptCacheRuntimeStatus;
  promptCacheTrend?: PromptCacheTrend;
  lspStatusReport?: LspStatusReport;
  protocolAudit?: ProtocolMigrationAudit;
  artifactIndex?: HeadlessArtifactIndex;
  releaseGate?: ParityReleaseGateSummary;
  artifactPaths?: {
    reportPath?: string;
    telemetryPath?: string;
    trajectoryPath?: string;
    logPath?: string;
  };
  workspace?: string;
};

export type LatestRunDiagnosis = {
  brief: string;
  detail: string;
};

type FailureLine = {
  source: string;
  text: string;
};

export function buildLatestRunDiagnosis(input: LatestRunDiagnosisInput): LatestRunDiagnosis {
  const events = input.events ?? [];
  const sessionId = firstDefined(
    input.latestDetail?.sessionId,
    input.resultCard?.sessionId,
    input.report?.session_id,
    input.telemetry?.session_id,
    latestSessionId(events)
  );
  const status = firstDefined(
    input.resultCard?.status,
    input.report?.status,
    input.telemetry?.status,
    latestFinalStatus(events)
  );
  const route = normalizeRoute(firstDefined(
    input.latestDetail?.route,
    input.resultCard?.route,
    input.report?.mode,
    input.telemetry?.mode
  ));
  const rawRoute = firstDefined(input.latestDetail?.route, input.resultCard?.route, input.report?.mode, input.telemetry?.mode);
  const cache = input.promptCache ?? input.resultCard?.cache;
  const trend = input.promptCacheTrend ?? input.telemetry?.llm.cache_trend;
  const recoveries = collectRecoveries(input, events);
  const failures = collectFailures(input, events);
  const artifacts = collectArtifacts(input);
  const latestAction = collectLatestSymphonyAction(events);
  const releaseGate = input.releaseGate ?? input.report?.release_gate ?? input.telemetry?.release_gate;
  const protocolAudit = input.protocolAudit;
  const hasRunEvidence = Boolean(sessionId || status || input.resultCard || input.report || input.telemetry || releaseGate || protocolAudit || events.length || input.latestDetail?.source !== undefined && input.latestDetail.source !== "none");

  if (!hasRunEvidence) {
    return {
      brief: "No latest run recorded. Ctrl+O for details.",
      detail: [
        "Latest Diagnosis",
        "No run has been recorded in this TUI/runtime yet.",
        "",
        "Next",
        "- Start a run, or inspect persisted sessions with /session latest."
      ].join("\n")
    };
  }

  const warningLines = recentWarningLines(events);
  const cacheRate = typeof cache?.hitRate === "number" ? cache.hitRate : trendHitRate(trend);
  const brief = [
    "Latest diagnosis:",
    sessionId ? `session ${redactSensitive(sessionId)}` : "session unknown",
    status ? `status ${status}` : undefined,
    route ? `route ${route}` : undefined,
    typeof cacheRate === "number" ? `cache hit ${Math.round(cacheRate * 100)}%` : undefined,
    releaseGate ? `release gate ${releaseGate.status}` : undefined,
    protocolAudit ? `protocol replay ${protocolAudit.status}` : undefined,
    latestAction ? `action ${latestAction.action}/${latestAction.status}` : undefined,
    failures.length ? `${failures.length} failure${failures.length === 1 ? "" : "s"}` : undefined,
    "Ctrl+O for details."
  ].filter(Boolean).join(" ");

  const detail = [
    "Latest Diagnosis",
    "",
    "Session",
    ...nonEmptyList([
      kv("session_id", sessionId),
      kv("status", status),
      kv("route", route && rawRoute && route !== rawRoute ? `${route} (raw=${rawRoute})` : route),
      kv("workspace", input.workspace ?? input.report?.workspace ?? input.telemetry?.workspace)
    ]),
    "",
    "Detail Target",
    ...nonEmptyList([
      kv("source", input.latestDetail?.source ?? "none"),
      kv("title", input.latestDetail?.title),
      kv("route", route && rawRoute && route !== rawRoute ? `${route} (raw=${rawRoute})` : route),
      kv("session_id", input.latestDetail?.sessionId)
    ]),
    "",
    "TUI Focus",
    ...formatTuiFocus(events),
    "",
    "Result",
    ...formatResult(input.resultCard, input.report),
    "",
    "Provider / Cache",
    ...formatProviderCache(input, cache, trend),
    "",
    "Parity Release Gate",
    ...formatParityReleaseGate(releaseGate),
    "",
    "LSP",
    ...formatLsp(input.lspStatusReport, events),
    "",
    "Protocol Replay",
    ...formatProtocolReplay(protocolAudit),
    "",
    "Control Plane",
    ...formatControlPlane(latestAction, input),
    "",
    "Failures",
    ...formatFailures(failures),
    "",
    "Recovery",
    ...formatRecoveries(recoveries),
    "",
    "Artifacts",
    ...formatArtifacts(artifacts),
    "",
    "Recent Warnings",
    ...formatWarnings(warningLines)
  ].join("\n");

  return {
    brief: redactSensitive(brief),
    detail: redactSensitive(detail)
  };
}

function formatProtocolReplay(audit: ProtocolMigrationAudit | undefined): string[] {
  if (!audit) {
    return ["- No protocol replay audit recorded."];
  }
  return [
    ...nonEmptyList([
      kv("schema_version", audit.schema_version),
      kv("status", audit.status),
      kv("session_id", audit.session_id),
      kv("issues", String(audit.summary.issues)),
      kv("errors", String(audit.summary.errors)),
      kv("warnings", String(audit.summary.warnings)),
      kv("workers", `replay=${audit.summary.replay_workers} direct=${audit.summary.direct_workers}`),
      kv("handoffs", `replay=${audit.summary.replay_handoffs} direct=${audit.summary.direct_handoffs}`),
      kv("symphony", `replay=${audit.summary.replay_symphony_claims} direct=${audit.summary.direct_symphony_claims}`)
    ]),
    ...formatProtocolMigrationAudit(audit).map((line) => `- ${line}`)
  ];
}

function formatTuiFocus(events: RuntimeEvent[]): string[] {
  const focusEvents = events
    .filter((event): event is Extract<RuntimeEvent, { type: "tui_focus" }> => event.type === "tui_focus")
    .slice(-8);
  if (!focusEvents.length) {
    return ["- No TUI focus transitions recorded."];
  }
  return focusEvents.flatMap((event) => nonEmptyList([
    kv("transition", `key=${event.key_event} reason=${event.detail_reason} allowed=${event.allowed} focus=${event.focus_before}->${event.focus_after} detail=${event.detail_before}->${event.detail_after} pane=${event.pane_before}->${event.pane_after}`),
    kv("source", event.detail_source),
    kv("route", event.route),
    kv("session_id", event.session_id),
    kv("action_id", event.action_id),
    kv("blocked", event.blocked_reason)
  ]));
}

function formatControlPlane(action: SymphonyActionFact | undefined, input: LatestRunDiagnosisInput): string[] {
  if (!action) {
    return ["- No Gateway/Symphony operator action recorded."];
  }
  const replay = action.replay
    .map((step) => `${step.status}@${step.at}${step.message ? `:${step.message}` : ""}`)
    .join(" -> ");
  return nonEmptyList([
    kv("latest_action", formatSymphonyActionStatus(action)),
    kv("action_id", action.action_id),
    kv("correlation_id", action.correlation_id),
    kv("gateway_envelope_id", action.gateway_envelope_id),
    kv("status", action.status),
    kv("target_session", action.target.session_id),
    kv("target_work_item", action.target.work_item_key),
    kv("attempt_id", action.attempt_id),
    kv("error", action.error_code),
    kv("recovery", action.recovery),
    replay ? kv("replay", replay) : undefined,
    kv("report", input.artifactPaths?.reportPath ?? input.report?.artifacts.report_path),
    kv("log", input.artifactPaths?.logPath)
  ]);
}

function collectLatestSymphonyAction(events: RuntimeEvent[]): SymphonyActionFact | undefined {
  return latestSymphonyActionFact(events.slice(-120).flatMap((event): unknown[] => {
    if (event.type === "tool_result" && event.action.startsWith("symphony.")) {
      return [
        event.metadata,
        event.metadata?.action_fact
      ];
    }
    if (event.type === "blackboard" && (event.entry.tags ?? []).includes("operator")) {
      return [
        event.entry.value
      ];
    }
    return [];
  }));
}

function formatLsp(report: LspStatusReport | undefined, events: RuntimeEvent[]): string[] {
  const graphLines = formatSemanticGraph(report, events);
  const providerLines = report?.providers
    .filter((provider) => provider.detected)
    .flatMap((provider) => {
      const capabilities = provider.capabilities ?? [];
      const fallbackReasons = uniqueStrings(capabilities.flatMap((capability) => capability.fallback_reason ? [capability.fallback_reason] : []));
      const modes = uniqueStrings(capabilities.map((capability) => capability.mode));
      const nextActions = uniqueStrings(capabilities.flatMap((capability) => capability.next_action ? [capability.next_action] : [])).slice(0, 2);
      return nonEmptyList([
        kv("provider", `${provider.providerId} status=${provider.status} detected=${provider.detected} available=${provider.available}`),
        capabilities.length ? kv("capabilities", `${capabilities.filter((capability) => capability.available).length}/${capabilities.length}`) : undefined,
        modes.length ? kv("modes", modes.join(",")) : undefined,
        fallbackReasons.length ? kv("fallback_reasons", fallbackReasons.join(",")) : undefined,
        provider.reason ? kv("reason", provider.reason) : undefined,
        provider.lastError ? kv("error", provider.lastError) : undefined,
        nextActions.length ? kv("next", nextActions.join(" | ")) : undefined
      ]);
    }) ?? [];
  const toolLines = events
    .slice(-80)
    .filter((event): event is Extract<RuntimeEvent, { type: "tool_result" }> => event.type === "tool_result" && event.action.startsWith("lsp."))
    .flatMap((event) => {
      const metadata = event.metadata ?? {};
      const fallbackTools = metadataStringArray(metadata.fallback_tools).join(",");
      return nonEmptyList([
        kv("tool", `${event.action} status=${event.status ?? "unknown"} code=${event.errorCode ?? metadataString(metadata.lsp_status) ?? "unknown"}`),
        kv("fallback_reason", metadataString(metadata.fallback_reason)),
        fallbackTools ? kv("fallback_tools", fallbackTools) : undefined,
        kv("language", metadataString(metadata.language)),
        kv("provider", metadataString(metadata.provider)),
        kv("root", metadataString(metadata.root)),
        kv("next", metadataString(metadata.next_action) ?? event.recoverySuggestion)
      ]);
    });
  const lines = [...graphLines, ...providerLines, ...toolLines];
  return lines.length ? lines.slice(0, 16) : ["- No LSP status or fallback facts recorded."];
}

function formatSemanticGraph(report: LspStatusReport | undefined, events: RuntimeEvent[]): string[] {
  const evidence = semanticEvidenceFromEvents(events);
  const reportNextActions = uniqueStrings(report?.providers.flatMap((provider) =>
    provider.capabilities?.flatMap((capability) => capability.next_action ? [capability.next_action] : []) ?? []
  ) ?? []);
  if (!evidence.length && !report) {
    return [];
  }
  const fresh = evidence.filter((item) => item.staleness === "fresh").length;
  const stale = evidence.filter((item) => item.staleness === "stale").length;
  const fallback = evidence.filter((item) => item.fallback_used || item.staleness === "fallback").length;
  const partial = evidence.filter((item) => item.status === "partial" || item.lsp_status === "partial").length;
  const staleReasons = uniqueStrings(evidence.flatMap((item) =>
    item.stale_reason
      ? [item.stale_reason]
      : item.staleness && item.staleness !== "fresh"
        ? [item.staleness]
        : []
  )).slice(0, 3);
  const evidenceIds = uniqueStrings(evidence.flatMap((item) => item.evidence_id ? [item.evidence_id] : [])).slice(-4);
  const changedFiles = uniqueStrings(evidence.flatMap((item) => item.changed_files ?? [])).slice(0, 4);
  const nextActions = uniqueStrings([
    ...evidence.flatMap((item) => item.next_action ? [item.next_action] : []),
    ...reportNextActions
  ]).slice(0, 2);
  return nonEmptyList([
    kv("semantic_graph", `health=${semanticGraphHealth(report, { evidence: evidence.length, fresh, stale, fallback, partial })} evidence=${evidence.length} fresh=${fresh} stale=${stale} fallback=${fallback}`),
    evidenceIds.length ? kv("semantic_evidence_ids", evidenceIds.join(",")) : undefined,
    staleReasons.length ? kv("stale_reasons", staleReasons.join(" | ")) : undefined,
    changedFiles.length ? kv("changed_files", changedFiles.join(",")) : undefined,
    nextActions.length ? kv("next_refresh", nextActions.join(" | ")) : undefined
  ]);
}

function semanticGraphHealth(
  report: LspStatusReport | undefined,
  counts: { evidence: number; fresh: number; stale: number; fallback: number; partial: number }
): "fresh" | "partial" | "stale" | "fallback" | "available" | "unavailable" | "unknown" {
  if (counts.fresh > 0 && (counts.stale > 0 || counts.fallback > 0 || counts.partial > 0)) {
    return "partial";
  }
  if (counts.fresh > 0) {
    return "fresh";
  }
  if (counts.stale > 0 || counts.partial > 0) {
    return "stale";
  }
  if (counts.fallback > 0) {
    return "fallback";
  }
  const providers = report?.providers.filter((provider) => provider.detected) ?? [];
  if (providers.some((provider) => provider.capabilities?.some((capability) => capability.available))) {
    return "available";
  }
  if (providers.some((provider) => provider.status === "failed" || provider.status === "exited" || provider.status === "unavailable" || !provider.available)) {
    return "unavailable";
  }
  return "unknown";
}

function semanticEvidenceFromEvents(events: RuntimeEvent[]): SemanticEvidence[] {
  return events.slice(-80).flatMap((event): SemanticEvidence[] => {
    if (event.type !== "tool_result" || !event.action.startsWith("lsp.")) {
      return [];
    }
    const metadata = event.metadata;
    if (!isRecord(metadata)) {
      return [];
    }
    const evidence = metadata.semantic_evidence;
    return isSemanticEvidence(evidence) ? [evidence] : [];
  });
}

function isSemanticEvidence(value: unknown): value is SemanticEvidence {
  return isRecord(value)
    && value.schema_version === "swarm.semantic_evidence.v1"
    && typeof value.evidence_id === "string"
    && typeof value.source === "string"
    && typeof value.action === "string"
    && typeof value.status === "string"
    && typeof value.staleness === "string"
    && typeof value.fallback_used === "boolean";
}

function collectRecoveries(input: LatestRunDiagnosisInput, events: RuntimeEvent[]): RecoveryAdvice[] {
  const recoveries: RecoveryAdvice[] = [];
  recoveries.push(...(input.resultCard?.recovery ?? []));
  for (const event of events.slice(-80)) {
    if ((event.type === "tool_result" || event.type === "loop_activity") && event.recovery) {
      recoveries.push(event.recovery);
    }
    if ((event.type === "tool_result" || event.type === "loop_activity") && event.recoverySuggestion) {
      recoveries.push(recoveryAdviceFromSuggestion({
        suggestion: event.recoverySuggestion,
        errorCode: event.errorCode,
        summary: event.type === "tool_result" ? event.summary : event.message
      }));
    }
    if (event.type === "tool_result" && event.status === "failed") {
      recoveries.push(recoveryAdviceFromToolFailure({
        action: event.action,
        reason: event.content ?? event.summary,
        errorCode: event.errorCode,
        recoverySuggestion: event.recoverySuggestion,
        sandbox: event.sandbox
      }));
    }
    if (event.type === "error" || event.type === "log") {
      const message = event.type === "error" ? event.message : event.message;
      const provider = recoveryAdviceFromProviderError({ message });
      if (provider) {
        recoveries.push(provider);
      }
    }
  }
  if (input.report?.error?.message) {
    const provider = recoveryAdviceFromProviderError({ message: input.report.error.message });
    if (provider) {
      recoveries.push(provider);
    }
  }
  return uniqueRecoveries(recoveries).slice(0, 8);
}

function collectFailures(input: LatestRunDiagnosisInput, events: RuntimeEvent[]): FailureLine[] {
  const failures: FailureLine[] = [];
  if (input.report?.error?.message) {
    failures.push({ source: "report", text: input.report.error.message });
  }
  if (input.telemetry?.error?.message) {
    failures.push({ source: "telemetry", text: input.telemetry.error.message });
  }
  if (input.resultCard?.status === "failed") {
    failures.push({ source: "result_card", text: input.resultCard.summary });
  }
  if (input.resultCard?.review.status === "failed") {
    failures.push({ source: "review", text: input.resultCard.review.summary });
  }
  for (const event of events.slice(-80)) {
    if (event.type === "error") {
      failures.push({ source: "event:error", text: event.message });
    } else if (event.type === "log" && event.level === "error") {
      failures.push({ source: "event:log", text: event.message });
    } else if (event.type === "tool_result" && event.status === "failed") {
      failures.push({ source: `tool:${event.action}`, text: `${event.title}: ${event.summary}` });
    } else if (event.type === "loop_activity" && event.phase === "failed") {
      failures.push({ source: "loop", text: event.summary ?? event.message });
    }
  }
  return failures.slice(-10);
}

function collectArtifacts(input: LatestRunDiagnosisInput): string[] {
  const indexedArtifacts = [
    ...(input.artifactIndex?.artifacts ?? []),
    ...(input.report?.artifact_index?.artifacts ?? [])
  ].map((artifact) => `${artifact.kind}:${artifact.path}`);
  const values = [
    ...indexedArtifacts,
    input.artifactPaths?.reportPath,
    input.artifactPaths?.telemetryPath,
    input.artifactPaths?.trajectoryPath,
    input.artifactPaths?.logPath,
    input.report?.artifacts.report_path,
    input.report?.artifacts.telemetry_path,
    input.report?.artifacts.trajectory_path,
    input.report?.result?.artifact_path,
    ...(input.resultCard?.artifacts ?? [])
  ];
  return uniqueStrings(values.filter((value): value is string => Boolean(value))).slice(0, 12);
}

function formatResult(card: ResultCard | undefined, report: HeadlessRunReport | undefined): string[] {
  if (!card && !report) {
    return ["- No result card or report yet."];
  }
  return nonEmptyList([
    card ? kv("result_card", `${card.status} ${card.route}`) : undefined,
    card ? kv("summary", card.summary) : report?.result?.content ? kv("summary", firstLine(report.result.content)) : undefined,
    card ? kv("review", `${card.review.status} - ${card.review.summary}`) : undefined,
    card ? kv("changed_files", String(card.changedFiles.length)) : undefined,
    card ? kv("checks", `${card.checks.length} (${card.checks.filter((check) => check.status === "failed").length} failed)`) : undefined,
    report?.status ? kv("report_status", report.status) : undefined,
    report?.error?.message ? kv("error", report.error.message) : undefined
  ]);
}

function formatProviderCache(
  input: LatestRunDiagnosisInput,
  cache: PromptCacheRuntimeStatus | ResultCard["cache"] | undefined,
  trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined
): string[] {
  const llm = input.telemetry?.llm;
  const providers = llm?.providers.length ? llm.providers.join(",") : cache?.providerId;
  const models = llm?.models.length ? llm.models.join(",") : cache?.model;
  const hitRate = typeof cache?.hitRate === "number" ? cache.hitRate : trendHitRate(trend) ?? llm?.cache_hit_rate;
  const writeRate = typeof cache?.writeRate === "number" ? cache.writeRate : trendWriteRate(trend) ?? llm?.cache_write_rate;
  const calls = "calls" in (trend ?? {}) ? trend?.calls : llm?.calls;
  const source = trend && "source" in trend ? trend.source : undefined;
  const changedSections = cache?.changedSections?.length ? cache.changedSections : trendChangedSections(trend);
  const missReasons = trendMissReasons(trend);
  const cacheFact = cache ? cacheFactFromStatus(cache) : undefined;
  const prefixIdentities = uniqueStrings([
    ...(cacheFact?.prefixIdentity ? [cacheFact.prefixIdentity] : []),
    ...trendPrefixIdentities(trend)
  ]);
  const estimatedSavingsTokens = cacheFact?.estimatedSavingsTokens ?? trendEstimatedSavingsTokens(trend);
  const normalizedMissReason = cacheFact?.normalizedMissReason;
  const normalizedMissReasons = trendNormalizedMissReasons(trend);
  const cacheTrendFallback = cache ? promptCacheTrendFromCache(cache) : undefined;
  const roi = trend ? buildPromptCacheRoi(trend) : cacheTrendFallback ? buildPromptCacheRoi(cacheTrendFallback) : undefined;
  return nonEmptyList([
    kv("provider", providers),
    kv("model", models),
    typeof calls === "number" ? kv("calls", String(calls)) : undefined,
    cache?.status ? kv("cache_status", cache.status) : undefined,
    cache?.missReason ? kv("miss_reason", cache.missReason) : undefined,
    normalizedMissReason ? kv("normalized_miss_reason", normalizedMissReason) : undefined,
    source ? kv("cache_trend_source", source) : undefined,
    prefixIdentities.length ? kv("prefix_identities", prefixIdentities.join(",")) : undefined,
    typeof hitRate === "number" ? kv("hit_rate", formatPercent(hitRate)) : undefined,
    typeof writeRate === "number" ? kv("write_rate", formatPercent(writeRate)) : undefined,
    typeof cache?.cachedInputTokens === "number" ? kv("cached_input_tokens", String(cache.cachedInputTokens)) : undefined,
    typeof cache?.totalInputWithCacheTokens === "number" ? kv("total_input_with_cache_tokens", String(cache.totalInputWithCacheTokens)) : undefined,
    typeof estimatedSavingsTokens === "number" ? kv("estimated_savings_tokens", String(estimatedSavingsTokens)) : undefined,
    roi ? kv("cache_roi_schema", roi.schema_version) : undefined,
    roi ? kv("roi_saved_tokens", String(roi.saved_tokens)) : undefined,
    roi ? kv("roi_hit_tokens", String(roi.hit_tokens)) : undefined,
    roi ? kv("roi_miss_tokens", String(roi.miss_tokens)) : undefined,
    roi && typeof roi.stable_prefix_ratio === "number" ? kv("stable_prefix_ratio", formatPercent(roi.stable_prefix_ratio)) : undefined,
    roi && roi.estimated_saved_cost !== undefined ? kv("estimated_saved_cost", `${roi.estimated_saved_cost_currency ?? "USD"} ${formatCost(roi.estimated_saved_cost)}`) : undefined,
    roi?.policy_recommendations.length ? kv("policy_recommendations", roi.policy_recommendations.join(" | ")) : undefined,
    trend && "missCalls" in trend ? kv("trend", `hit=${trend.hitCalls} miss=${trend.missCalls} warming=${trend.warmingCalls} bypass=${trend.bypassCalls} unknown=${trend.unknownCalls}`) : undefined,
    trend && "miss_calls" in trend ? kv("trend", `hit=${trend.hit_calls} miss=${trend.miss_calls} warming=${trend.warming_calls} bypass=${trend.bypass_calls} unknown=${trend.unknown_calls}`) : undefined,
    changedSections.length ? kv("changed_sections", changedSections.join(",")) : undefined,
    normalizedMissReasons ? kv("normalized_miss_reasons", normalizedMissReasons) : undefined,
    missReasons ? kv("miss_reasons", missReasons) : undefined,
    cache?.changed?.length ? kv("changed", cache.changed.join(",")) : undefined,
    cache?.reason ? kv("reason", cache.reason) : undefined,
    cache?.recommendation ? kv("recommendation", cache.recommendation) : undefined
  ]);
}

function formatParityReleaseGate(gate: ParityReleaseGateSummary | undefined): string[] {
  if (!gate) {
    return ["- No parity release gate recorded."];
  }
  const dimensions = gate.dimensions
    .map((dimension) => `${dimension.id}:${dimension.status}:${dimension.score}`)
    .join(",");
  const failedRedLines = gate.red_lines
    .filter((redLine) => redLine.status === "fail")
    .map((redLine) => redLine.id)
    .join(",");
  const triageQueue = gate.triage_queue
    .slice(0, 5)
    .map((item) => `${item.failed_dimension}:${item.status}:${item.next_task_suggestion}`)
    .join(",");
  return [
    ...nonEmptyList([
      kv("schema_version", gate.schema_version),
      kv("profile", gate.profile),
      kv("compared_to", gate.compared_to),
      kv("status", gate.status),
      kv("summary", gate.summary),
      dimensions ? kv("dimensions", dimensions) : undefined,
      gate.near_claude_code.length ? kv("near_claude_code", gate.near_claude_code.join(" | ")) : undefined,
      gate.gaps.length ? kv("gaps", gate.gaps.join(" | ")) : undefined,
      failedRedLines ? kv("failed_red_lines", failedRedLines) : undefined,
      triageQueue ? kv("triage_queue", triageQueue) : undefined,
      gate.dogfood.covered.length ? kv("dogfood_covered", gate.dogfood.covered.join(",")) : undefined,
      gate.dogfood.artifact_kinds.length ? kv("artifact_kinds", gate.dogfood.artifact_kinds.join(",")) : undefined,
      gate.next_task ? kv("next_task", gate.next_task) : undefined
    ]),
    ...gate.fail_reasons.slice(0, 4).map((reason) => `- fail_reason=${redactSensitive(reason)}`),
    ...gate.pass_reasons.slice(0, 4).map((reason) => `- pass_reason=${redactSensitive(reason)}`)
  ];
}

function formatFailures(failures: FailureLine[]): string[] {
  if (!failures.length) {
    return ["- No recent failures detected."];
  }
  return failures.map((failure) => `- ${redactSensitive(failure.source)}: ${redactSensitive(failure.text)}`);
}

function formatRecoveries(recoveries: RecoveryAdvice[]): string[] {
  if (!recoveries.length) {
    return ["- No recovery advice recorded."];
  }
  return recoveries.map((advice) => `- ${formatRecoveryAdviceInline(advice)}`);
}

function formatArtifacts(artifacts: string[]): string[] {
  if (!artifacts.length) {
    return ["- No artifact paths recorded."];
  }
  return artifacts.map((artifact) => `- ${artifact}`);
}

function formatWarnings(warnings: string[]): string[] {
  if (!warnings.length) {
    return ["- No recent warnings."];
  }
  return warnings.map((warning) => `- ${warning}`);
}

function recentWarningLines(events: RuntimeEvent[]): string[] {
  return events.slice(-80).flatMap((event): string[] => {
    if (event.type === "log" && (event.level === "warn" || event.level === "error")) {
      return [`${event.level}: ${event.message}`];
    }
    if (event.type === "loop_activity" && (event.phase === "failed" || event.errorCode || event.recoverySuggestion)) {
      return [`loop:${event.phase}: ${event.summary ?? event.message}`];
    }
    if (event.type === "tool_result" && event.status === "failed") {
      return [`tool:${event.action}: ${event.summary}`];
    }
    return [];
  }).slice(-8).map(redactSensitive);
}

function latestSessionId(events: RuntimeEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if ("session_id" in event && typeof event.session_id === "string") {
      return event.session_id;
    }
    if (event.type === "provider_usage" && event.usage.sessionId) {
      return event.usage.sessionId;
    }
  }
  return undefined;
}

function latestFinalStatus(events: RuntimeEvent[]): "completed" | "failed" | "stopped" | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "final") {
      return event.status;
    }
    if (event?.type === "loop_activity" && (event.phase === "completed" || event.phase === "failed" || event.phase === "stopped")) {
      return event.phase;
    }
  }
  return undefined;
}

function uniqueRecoveries(items: RecoveryAdvice[]): RecoveryAdvice[] {
  const seen = new Set<string>();
  const output: RecoveryAdvice[] = [];
  for (const item of items) {
    const key = [item.category, item.severity, item.summary, item.nextAction, item.commandHint].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(redactSensitive))];
}

function formatCost(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function metadataString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function metadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function trendHitRate(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): number | undefined {
  if (!trend) {
    return undefined;
  }
  const record = trend as Record<string, unknown>;
  return typeof record.hitRate === "number"
    ? record.hitRate
    : typeof record.hit_rate === "number"
      ? record.hit_rate
      : undefined;
}

function trendWriteRate(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): number | undefined {
  if (!trend) {
    return undefined;
  }
  const record = trend as Record<string, unknown>;
  return typeof record.writeRate === "number"
    ? record.writeRate
    : typeof record.write_rate === "number"
      ? record.write_rate
      : undefined;
}

function trendChangedSections(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): string[] {
  if (!trend) {
    return [];
  }
  const record = trend as Record<string, unknown>;
  const value = Array.isArray(record.changedSections) ? record.changedSections : Array.isArray(record.changed_sections) ? record.changed_sections : [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function trendMissReasons(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): string | undefined {
  if (!trend) {
    return undefined;
  }
  const record = trend as Record<string, unknown>;
  const value = record.missReasons ?? record.miss_reasons;
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([key, count]) => `${key}:${count}`).join(",") : undefined;
}

function trendNormalizedMissReasons(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): string | undefined {
  if (!trend) {
    return undefined;
  }
  const record = trend as Record<string, unknown>;
  const value = record.normalizedMissReasons ?? record.normalized_miss_reasons;
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([key, count]) => `${key}:${count}`).join(",") : undefined;
}

function trendPrefixIdentities(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): string[] {
  if (!trend) {
    return [];
  }
  const record = trend as Record<string, unknown>;
  const values = Array.isArray(record.prefixIdentities)
    ? record.prefixIdentities
    : Array.isArray(record.prefix_identities)
      ? record.prefix_identities
      : [];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function trendEstimatedSavingsTokens(trend: PromptCacheTrend | HeadlessTelemetry["llm"]["cache_trend"] | undefined): number | undefined {
  if (!trend) {
    return undefined;
  }
  const record = trend as Record<string, unknown>;
  return typeof record.estimatedSavingsTokens === "number"
    ? record.estimatedSavingsTokens
    : typeof record.estimated_savings_tokens === "number"
      ? record.estimated_savings_tokens
      : undefined;
}

type LatestDiagnosisCache = PromptCacheRuntimeStatus | NonNullable<ResultCard["cache"]>;

function promptCacheTrendFromCache(cache: LatestDiagnosisCache): PromptCacheTrend {
  return {
    source: "result_card_fallback",
    calls: 1,
    cacheableCalls: cache.totalInputWithCacheTokens ? 1 : 0,
    hitCalls: cache.cachedInputTokens && cache.cachedInputTokens > 0 ? 1 : 0,
    missCalls: cache.cachedInputTokens && cache.cachedInputTokens > 0 ? 0 : 1,
    warmingCalls: cache.status === "new_scope" ? 1 : 0,
    bypassCalls: cache.cacheMode === "off" || cache.cacheMode === "disabled" ? 1 : 0,
    unknownCalls: cache.cachedInputTokens || cache.status ? 0 : 1,
    cachedInputTokens: cache.cachedInputTokens ?? 0,
    totalInputWithCacheTokens: cache.totalInputWithCacheTokens ?? 0,
    cacheCreationInputTokens: cache.cacheCreationInputTokens ?? 0,
    uncachedInputTokens: typeof cache.totalInputWithCacheTokens === "number" && typeof cache.cachedInputTokens === "number"
      ? Math.max(0, cache.totalInputWithCacheTokens - cache.cachedInputTokens)
      : 0,
    cacheablePrefixTokensEstimate: cache.cacheablePrefixTokensEstimate ?? 0,
    hitRate: cache.hitRate,
    writeRate: cache.writeRate,
    diagnostics: cache.status ? { [cache.status]: 1 } : {},
    changed: cache.changed ?? [],
    changedSections: cache.changedSections ?? [],
    missReasons: cache.missReason ? { [cache.missReason]: 1 } : {},
    normalizedMissReasons: {
      cold_start: cache.status === "new_scope" ? 1 : 0,
      prefix_drift: cache.changed?.length ? 1 : 0,
      context_overflow: 0,
      provider_unsupported: cache.cacheMode === "off" || cache.cacheMode === "disabled" ? 1 : 0,
      provider_omitted_usage: cache.status === "cache_miss" ? 1 : 0,
      unknown: cache.cachedInputTokens ? 0 : 1
    },
    prefixIdentities: [],
    estimatedSavingsTokens: cache.cachedInputTokens ?? 0,
    facts: [cacheFactFromStatus(cache)],
    latest: cache
  };
}

function normalizeRoute(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "coding" || value === "coding_loop") {
    return "work";
  }
  if (value === "full_swarm" || value === "swarm") {
    return "team";
  }
  if (value === "chat") {
    return "ask";
  }
  return value;
}

function nonEmptyList(values: Array<string | undefined>): string[] {
  const lines = values.filter((value): value is string => Boolean(value));
  return lines.length ? lines.map(redactSensitive) : ["- (none)"];
}

function kv(key: string, value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : `- ${key}=${redactSensitive(value)}`;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
