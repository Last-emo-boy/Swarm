import {
  getProviderApiKey,
  loadSwarmConfig,
  loadSwarmSettings,
  updateProviderModels,
  type ProviderDefinition
} from "../config/settings.js";

export type ModelDiscoveryResult = {
  providerId: string;
  models: string[];
  error?: string;
};

export async function refreshProviderModels(providerId: string): Promise<ModelDiscoveryResult> {
  const settings = loadSwarmSettings();
  const config = loadSwarmConfig();
  const provider = settings.providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  try {
    const models = await fetchProviderModels(provider, getProviderApiKey(provider, config));
    updateProviderModels({ providerId, models, discovered: true });
    return { providerId, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateProviderModels({ providerId, models: [], discovered: true, error: message });
    return { providerId, models: [], error: message };
  }
}

export async function fetchProviderModels(provider: ProviderDefinition, apiKey: string): Promise<string[]> {
  if (!provider.modelListURL || provider.modelListProtocol === "none") {
    throw new Error(`Provider "${provider.id}" does not support automatic model discovery.`);
  }
  if (provider.apiKeyRequired && !apiKey) {
    throw new Error(`Missing API key for provider "${provider.id}".`);
  }

  const response = await fetch(provider.modelListURL, {
    method: "GET",
    headers: modelListHeaders(provider, apiKey)
  });
  if (!response.ok) {
    throw new Error(`Model discovery failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as { data?: unknown[]; models?: unknown[] };
  const rawModels = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const models = rawModels
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
      }
      return "";
    })
    .filter(Boolean);

  if (models.length === 0) {
    throw new Error(`Provider "${provider.id}" returned no models.`);
  }
  return [...new Set(models)].sort();
}

function modelListHeaders(provider: ProviderDefinition, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(provider.headers ?? {})
  };

  if (provider.auth === "bearer" && apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (provider.auth === "x-api-key" && apiKey) {
    headers["x-api-key"] = apiKey;
  }

  return headers;
}
