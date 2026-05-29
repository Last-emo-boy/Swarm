import { createHash } from "node:crypto";
import {
  getProviderModels,
  providerKnowsModel,
  resolveModelRef,
  type ProviderDefinition,
  type SwarmConfig,
  type SwarmSettings
} from "../config/settings.js";
import { redactSensitive } from "../runtime/recovery.js";

export type ProviderApiKeySource = "config" | "env" | "not_required" | "missing";
export type ProviderCompatMode =
  | "openai-responses"
  | "openai-compatible"
  | "anthropic-messages"
  | "google-gemini";

export type ProviderProbeCode =
  | "ok"
  | "auth_failed"
  | "model_not_found"
  | "rate_limited"
  | "unsupported_usage"
  | "network_error"
  | "provider_error"
  | "unknown";

export type ProviderProfile = {
  providerId: string;
  name: string;
  baseURL: string;
  protocol: ProviderDefinition["protocol"];
  compatMode: ProviderCompatMode;
  selectedRoles: Array<"planner" | "worker" | "aggregator">;
  selectedModels: string[];
  apiKeyRequired: boolean;
  apiKeySource: ProviderApiKeySource;
  apiKeyFingerprint?: string;
  supportsUsage: boolean;
  supportsCacheUsage: boolean;
  rateLimitPolicy: string;
  modelDiscovery: {
    supported: boolean;
    modelListURL?: string;
    lastError?: string;
    lastCheckedAt?: string;
  };
  configured: boolean;
  problems: string[];
  nextActions: string[];
};

export type ProviderProbeExplanation = {
  code: ProviderProbeCode;
  retryable: boolean;
  summary: string;
  nextAction: string;
  detail?: string;
};

type SelectedModelRole = "planner" | "worker" | "aggregator";

export function buildProviderProfiles(input: {
  settings: SwarmSettings;
  config: SwarmConfig;
}): ProviderProfile[] {
  const selected = selectedModelsByProvider(input.settings);
  return Object.values(input.settings.providers)
    .filter((provider) => selected.has(provider.id) || provider.id === input.settings.models.defaultProvider)
    .map((provider) => providerProfile(provider, selected.get(provider.id) ?? [], input.settings, input.config))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

export function explainProviderProbeError(input: {
  statusCode?: number;
  message?: string;
  providerId?: string;
}): ProviderProbeExplanation {
  const message = redactSensitive(input.message ?? "");
  const combined = `${input.statusCode ?? ""} ${message}`;
  if (!input.statusCode && !message.trim()) {
    return {
      code: "ok",
      retryable: false,
      summary: "Provider probe did not report an error.",
      nextAction: "No action needed."
    };
  }
  if (input.statusCode === 401 || input.statusCode === 403 || /unauthorized|forbidden|invalid api key|missing api key|authentication|auth/i.test(combined)) {
    return {
      code: "auth_failed",
      retryable: false,
      summary: "Provider authentication failed.",
      nextAction: `Check the API key for ${input.providerId ?? "the provider"}, then run swarm doctor again.`,
      detail: compactDetail(message)
    };
  }
  if (input.statusCode === 404 || /model.*not found|not found.*model|unknown model|model_not_found/i.test(combined)) {
    return {
      code: "model_not_found",
      retryable: false,
      summary: "Configured model was not found by the provider.",
      nextAction: "Refresh models or select a provider/model that exists on the endpoint.",
      detail: compactDetail(message)
    };
  }
  if (input.statusCode === 429 || /rate.?limit|too many requests|quota/i.test(combined)) {
    return {
      code: "rate_limited",
      retryable: true,
      summary: "Provider rate limit or quota was hit.",
      nextAction: "Wait and retry, reduce concurrency, or switch to a less constrained provider/model.",
      detail: compactDetail(message)
    };
  }
  if (/usage.*unsupported|unsupported.*usage|cache.*unsupported|prompt_cache.*unsupported/i.test(combined)) {
    return {
      code: "unsupported_usage",
      retryable: false,
      summary: "Provider did not return supported usage/cache fields.",
      nextAction: "Treat cache savings as unknown or use a provider with token usage reporting.",
      detail: compactDetail(message)
    };
  }
  if (/network|fetch failed|econnrefused|enotfound|etimedout|timeout|socket/i.test(combined)) {
    return {
      code: "network_error",
      retryable: true,
      summary: "Provider endpoint could not be reached.",
      nextAction: "Check baseURL, proxy/network access, and whether the local server is running.",
      detail: compactDetail(message)
    };
  }
  if (input.statusCode && input.statusCode >= 500) {
    return {
      code: "provider_error",
      retryable: true,
      summary: "Provider returned a server error.",
      nextAction: "Retry later or switch provider/model for this run.",
      detail: compactDetail(message)
    };
  }
  return {
    code: "unknown",
    retryable: true,
    summary: "Provider probe failed with an unclassified error.",
    nextAction: "Inspect provider endpoint, model, API key, and response body.",
    detail: compactDetail(message)
  };
}

export function formatProviderProfiles(profiles: ProviderProfile[]): string[] {
  if (profiles.length === 0) {
    return ["WARN no provider profile selected; set /provider and /model before running real tasks."];
  }
  return profiles.flatMap((profile) => {
    const status = profile.configured ? "OK" : "FAIL";
    return [
      `${status} provider=${profile.providerId} mode=${profile.compatMode} protocol=${profile.protocol}`,
      `OK endpoint=${redactSensitive(profile.baseURL)}`,
      `OK models=${profile.selectedModels.length ? profile.selectedModels.join(",") : "(none)"} roles=${profile.selectedRoles.length ? profile.selectedRoles.join(",") : "(none)"}`,
      `${profile.apiKeySource === "missing" ? "FAIL" : "OK"} api_key=${profile.apiKeySource}${profile.apiKeyFingerprint ? ` fingerprint=${profile.apiKeyFingerprint}` : ""}`,
      `OK usage=${profile.supportsUsage ? "supported" : "unknown"} cache_usage=${profile.supportsCacheUsage ? "supported" : "unknown"} rate_limit=${profile.rateLimitPolicy}`,
      `${profile.modelDiscovery.lastError ? "WARN" : "OK"} model_discovery=${profile.modelDiscovery.supported ? "supported" : "unsupported"}${profile.modelDiscovery.modelListURL ? ` url=${redactSensitive(profile.modelDiscovery.modelListURL)}` : ""}${profile.modelDiscovery.lastError ? ` error=${redactSensitive(profile.modelDiscovery.lastError)}` : ""}`,
      ...profile.problems.map((problem) => `FAIL ${redactSensitive(problem)}`),
      ...profile.nextActions.map((action) => `NEXT ${redactSensitive(action)}`)
    ];
  });
}

function providerProfile(
  provider: ProviderDefinition,
  selected: Array<{ role: SelectedModelRole; model: string }>,
  settings: SwarmSettings,
  config: SwarmConfig
): ProviderProfile {
  const apiKey = providerApiKey(provider, config);
  const apiKeySource = providerApiKeySource(provider, config);
  const selectedModels = [...new Set(selected.map((item) => item.model))];
  const problems = providerProblems(provider, selectedModels, settings, apiKeySource);
  const nextActions = providerNextActions(provider, problems, apiKeySource);
  return {
    providerId: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    protocol: provider.protocol,
    compatMode: compatMode(provider),
    selectedRoles: selected.map((item) => item.role),
    selectedModels,
    apiKeyRequired: provider.apiKeyRequired,
    apiKeySource,
    apiKeyFingerprint: apiKey ? fingerprintSecret(apiKey) : undefined,
    supportsUsage: providerSupportsUsage(provider),
    supportsCacheUsage: providerSupportsCacheUsage(provider),
    rateLimitPolicy: rateLimitPolicy(provider),
    modelDiscovery: {
      supported: Boolean(provider.modelListURL && provider.modelListProtocol !== "none"),
      modelListURL: provider.modelListURL,
      lastError: provider.lastModelDiscoveryError,
      lastCheckedAt: provider.lastModelDiscoveryAt
    },
    configured: problems.length === 0,
    problems,
    nextActions
  };
}

function selectedModelsByProvider(settings: SwarmSettings): Map<string, Array<{ role: SelectedModelRole; model: string }>> {
  const selected = new Map<string, Array<{ role: SelectedModelRole; model: string }>>();
  for (const [role, modelRef] of [
    ["planner", settings.models.planner],
    ["worker", settings.models.worker],
    ["aggregator", settings.models.aggregator]
  ] as const) {
    if (!modelRef.trim()) {
      continue;
    }
    const resolved = resolveModelRef(modelRef, settings);
    if (!resolved.providerId) {
      continue;
    }
    const entries = selected.get(resolved.providerId) ?? [];
    entries.push({ role, model: resolved.model });
    selected.set(resolved.providerId, entries);
  }
  return selected;
}

function providerProblems(
  provider: ProviderDefinition,
  selectedModels: string[],
  settings: SwarmSettings,
  apiKeySource: ProviderApiKeySource
): string[] {
  const problems: string[] = [];
  if (provider.apiKeyRequired && apiKeySource === "missing") {
    problems.push(`Missing API key for provider "${provider.id}".`);
  }
  for (const model of selectedModels) {
    if (!providerKnowsModel(provider, model)) {
      problems.push(`Unknown model "${model}" for provider "${provider.id}". Known models: ${getProviderModels(provider).slice(0, 8).join(", ") || "(none)"}.`);
    }
  }
  if (settings.models.defaultProvider === provider.id && selectedModels.length === 0) {
    problems.push(`Provider "${provider.id}" is the default provider but no role model currently selects it.`);
  }
  return problems;
}

function providerNextActions(
  provider: ProviderDefinition,
  problems: string[],
  apiKeySource: ProviderApiKeySource
): string[] {
  const actions: string[] = [];
  if (provider.apiKeyRequired && apiKeySource === "missing") {
    actions.push(`Set ${provider.apiKeyEnv} or run swarm auth set-key ${provider.id} <api-key>.`);
  }
  if (problems.some((problem) => problem.includes("Unknown model")) && provider.modelListProtocol !== "none") {
    actions.push(`Run swarm providers refresh ${provider.id}, then select a discovered model.`);
  }
  if (provider.protocol === "openai-chat-completions" && !provider.baseURL.match(/\/v1\/?$/i) && !provider.id.includes("deepseek")) {
    actions.push("Verify the OpenAI-compatible endpoint path; many providers require a /v1 baseURL.");
  }
  return actions;
}

function providerApiKey(provider: ProviderDefinition, config: SwarmConfig): string {
  return config.providerApiKeys[provider.id] || process.env[provider.apiKeyEnv] || "";
}

function providerApiKeySource(provider: ProviderDefinition, config: SwarmConfig): ProviderApiKeySource {
  if (!provider.apiKeyRequired) {
    return "not_required";
  }
  if (config.providerApiKeys[provider.id]) {
    return "config";
  }
  if (process.env[provider.apiKeyEnv]) {
    return "env";
  }
  return "missing";
}

function compatMode(provider: ProviderDefinition): ProviderCompatMode {
  if (provider.protocol === "openai-responses") {
    return "openai-responses";
  }
  if (provider.protocol === "anthropic-messages") {
    return "anthropic-messages";
  }
  if (provider.protocol === "google-gemini") {
    return "google-gemini";
  }
  return "openai-compatible";
}

function providerSupportsUsage(provider: ProviderDefinition): boolean {
  return provider.protocol === "openai-responses" ||
    provider.protocol === "openai-chat-completions" ||
    provider.protocol === "anthropic-messages" ||
    provider.protocol === "google-gemini";
}

function providerSupportsCacheUsage(provider: ProviderDefinition): boolean {
  return provider.protocol === "anthropic-messages" ||
    provider.protocol === "google-gemini" ||
    provider.id === "openai" ||
    provider.id === "deepseek";
}

function rateLimitPolicy(provider: ProviderDefinition): string {
  if (provider.id === "deepseek") {
    return "provider-managed; reduce concurrency on HTTP 429";
  }
  if (provider.baseURL.includes("127.0.0.1") || provider.baseURL.includes("localhost")) {
    return "local-server; check server capacity";
  }
  return "provider-managed; retry with lower concurrency on HTTP 429";
}

function fingerprintSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret).digest("hex").slice(0, 10)}`;
}

function compactDetail(value: string | undefined, maxLength = 240): string | undefined {
  const line = redactSensitive(value)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) {
    return undefined;
  }
  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 3))}...` : line;
}
