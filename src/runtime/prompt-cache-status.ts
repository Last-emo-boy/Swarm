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
>;

export function promptCacheStatusFromUsage(usage: ProviderUsageReport): PromptCacheRuntimeStatus {
  const hitRate = usage.cacheHitRate ?? (
    usage.totalInputWithCacheTokens && typeof usage.cachedInputTokens === "number"
      ? usage.cachedInputTokens / Math.max(1, usage.totalInputWithCacheTokens)
      : undefined
  );
  const changed = usage.promptCacheDiagnostics?.changed ?? [];
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
    minimumCacheableTokens: usage.promptCacheDiagnostics?.minimumCacheableTokens
  };
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
    minimumCacheableTokens: status.minimumCacheableTokens
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
    status.changed?.length ? `changed=${status.changed.join(", ")}` : undefined,
    status.diagnostics ? `diagnostics=${status.diagnostics}` : undefined,
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
  return `cache:${status.status}${rates ? ` ${rates}` : ""}${status.diagnostics ? ` ${status.diagnostics}` : ""}`;
}

function formatPromptCacheRates(status: Pick<PromptCacheRuntimeStatus, "hitRate" | "writeRate">): string {
  return [
    typeof status.hitRate === "number" ? `hit ${Math.round(status.hitRate * 100)}%` : undefined,
    typeof status.writeRate === "number" ? `write ${Math.round(status.writeRate * 100)}%` : undefined
  ].filter(Boolean).join(", ");
}
