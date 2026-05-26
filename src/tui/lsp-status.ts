import type { LspProviderStatus, LspStatusReport } from "../lsp/manager.js";

export type TuiLspHealthStatus =
  | "disabled"
  | "no-provider"
  | "not-configured"
  | "starting"
  | "ready"
  | "degraded"
  | "fallback"
  | "external"
  | "partial"
  | "unavailable"
  | "failed"
  | "unknown";

export type TuiLspStatusSummary = {
  health: TuiLspHealthStatus;
  providers: number;
  readyProviders: number;
  fallbackProviders: number;
  partialProviders: number;
  unavailableProviders: number;
  failedProviders: number;
  semanticGraphHealth: "ready" | "fallback" | "partial" | "unavailable" | "unknown";
  semanticEvidenceSources: string[];
  staleReasons: string[];
  fallbackReasons: string[];
  nextActions: string[];
};

export function lspHealthStatusFromReport(report: LspStatusReport | undefined): TuiLspHealthStatus {
  return lspStatusSummaryFromReport(report).health;
}

export function lspStatusSummaryFromReport(report: LspStatusReport | undefined): TuiLspStatusSummary {
  const relevant = report?.providers.filter((provider) => provider.detected) ?? [];
  if (relevant.length === 0) {
    const providers = report?.providers ?? [];
    if (providers.length > 0 && providers.every((provider) => !provider.detected)) {
      return emptySummary("no-provider", uniqueStrings(providers.map((provider) => provider.reason ?? `${provider.providerId} provider not detected.`)));
    }
    return emptySummary("unknown");
  }
  const failedProviders = relevant.filter((provider) => provider.status === "failed" || provider.status === "exited");
  const unavailableProviders = relevant.filter((provider) => provider.status === "unavailable" || !provider.available);
  const fallbackProviders = relevant.filter(providerHasSemanticFallback);
  const partialProviders = relevant.filter(providerHasPartialCapability);
  const readyProviders = relevant.filter(providerIsReadyLike);
  const fallbackReasons = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.flatMap((capability) => capability.fallback_reason ? [capability.fallback_reason] : []) ?? []
  ));
  const semanticEvidenceSources = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.map((capability) => capability.mode) ?? []
  ));
  const staleReasons = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.flatMap((capability) =>
      !capability.available && capability.fallback_reason
        ? [capability.fallback_reason]
        : []
    ) ?? []
  ));
  const nextActions = uniqueStrings(relevant.flatMap((provider) =>
    provider.capabilities?.flatMap((capability) => capability.next_action ? [capability.next_action] : []) ?? []
  )).slice(0, 4);

  let health: TuiLspHealthStatus = "unknown";
  if (relevant.some((provider) => provider.status === "failed" || provider.status === "exited")) {
    health = "failed";
  } else if (relevant.some((provider) => provider.status === "unavailable" || !provider.available)) {
    health = relevant.every((provider) => !provider.available) ? "not-configured" : "degraded";
  } else if (relevant.some((provider) => provider.status === "starting")) {
    health = "starting";
  } else if (partialProviders.length > 0) {
    health = "partial";
  } else if (fallbackProviders.length > 0) {
    health = "fallback";
  } else if (relevant.some((provider) => provider.status === "external")) {
    health = "external";
  } else if (relevant.some(providerIsReadyLike)) {
    health = "ready";
  }
  return {
    health,
    providers: relevant.length,
    readyProviders: readyProviders.length,
    fallbackProviders: fallbackProviders.length,
    partialProviders: partialProviders.length,
    unavailableProviders: unavailableProviders.length,
    failedProviders: failedProviders.length,
    semanticGraphHealth: semanticGraphHealth({
      failed: failedProviders.length,
      unavailable: unavailableProviders.length,
      partial: partialProviders.length,
      fallback: fallbackProviders.length,
      ready: readyProviders.length
    }),
    semanticEvidenceSources,
    staleReasons,
    fallbackReasons,
    nextActions
  };
}

function semanticGraphHealth(counts: {
  failed: number;
  unavailable: number;
  partial: number;
  fallback: number;
  ready: number;
}): TuiLspStatusSummary["semanticGraphHealth"] {
  if (counts.failed > 0 || counts.unavailable > 0) {
    return "unavailable";
  }
  if (counts.partial > 0) {
    return "partial";
  }
  if (counts.fallback > 0) {
    return "fallback";
  }
  if (counts.ready > 0) {
    return "ready";
  }
  return "unknown";
}

function providerIsReadyLike(provider: LspProviderStatus): boolean {
  return provider.status === "ready" || (provider.status === "stopped" && provider.available);
}

function providerHasSemanticFallback(provider: LspProviderStatus): boolean {
  return provider.capabilities?.some((capability) =>
    capability.available && capability.mode === "typescript_semantic_fallback"
  ) ?? false;
}

function providerHasPartialCapability(provider: LspProviderStatus): boolean {
  return provider.capabilities?.some((capability) =>
    !capability.available || capability.fallback_reason === "partial_capability"
  ) ?? false;
}

function emptySummary(health: TuiLspHealthStatus, nextActions: string[] = []): TuiLspStatusSummary {
  return {
    health,
    providers: 0,
    readyProviders: 0,
    fallbackProviders: 0,
    partialProviders: 0,
    unavailableProviders: 0,
    failedProviders: 0,
    semanticGraphHealth: "unknown",
    semanticEvidenceSources: [],
    staleReasons: [],
    fallbackReasons: [],
    nextActions
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
