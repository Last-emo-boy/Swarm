import OpenAI from "openai";
import {
  getProviderApiKey,
  getSelectedModelReadiness,
  loadSwarmConfig,
  loadSwarmSettings,
  resolveModelRef,
  type ProviderDefinition,
  type SwarmConfig,
  type SwarmSettings
} from "../config/settings.js";

export class OpenAIProvider {
  readonly model: string;
  readonly workerModel: string;
  readonly aggregatorModel: string;
  private readonly settings: SwarmSettings;
  private readonly config: SwarmConfig;

  constructor() {
    this.settings = loadSwarmSettings();
    this.config = loadSwarmConfig();
    this.model = process.env.SWARM_MODEL ?? this.settings.models.planner;
    this.workerModel = process.env.SWARM_WORKER_MODEL ?? this.settings.models.worker;
    this.aggregatorModel = process.env.SWARM_AGGREGATOR_MODEL ?? this.settings.models.aggregator;
  }

  get enabled(): boolean {
    return getSelectedModelReadiness(this.settings, this.config).every((readiness) => readiness.configured);
  }

  async generateText(input: {
    system: string;
    user: string;
    model?: string;
  }): Promise<string> {
    const resolved = this.resolveModel(input.model ?? this.model);
    if (resolved.provider.apiKeyRequired && !resolved.apiKey) {
      throw new Error(
        `Missing API key for provider "${resolved.providerId}". Run "swarm onboard" or "swarm auth set-key ${resolved.providerId} <api-key>".`
      );
    }

    if (resolved.provider.protocol === "openai-responses") {
      return this.generateWithResponses(resolved, input);
    }

    if (resolved.provider.protocol === "openai-chat-completions") {
      return this.generateWithChatCompletions(resolved, input);
    }

    if (resolved.provider.protocol === "anthropic-messages") {
      return this.generateWithAnthropic(resolved, input);
    }

    return this.generateWithGemini(resolved, input);
  }

  private async generateWithResponses(
    resolved: ResolvedModel,
    input: { system: string; user: string }
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: resolved.apiKey || "local",
      baseURL: resolved.provider.baseURL
    });
    const response = await client.responses.create({
      model: resolved.model,
      input: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ]
    } as never);
    return requireText(extractOutputText(response), resolved);
  }

  private async generateWithChatCompletions(
    resolved: ResolvedModel,
    input: { system: string; user: string }
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: resolved.apiKey || "local",
      baseURL: resolved.provider.baseURL,
      defaultHeaders: resolved.provider.headers
    });
    const response = await client.chat.completions.create({
      model: resolved.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ]
    });
    return requireText(response.choices[0]?.message?.content ?? "", resolved);
  }

  private async generateWithAnthropic(
    resolved: ResolvedModel,
    input: { system: string; user: string }
  ): Promise<string> {
    const response = await fetch(resolved.provider.baseURL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...resolved.provider.headers,
        ...authHeaders(resolved.provider, resolved.apiKey)
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: 4096,
        system: input.system,
        messages: [{ role: "user", content: input.user }]
      })
    });
    if (!response.ok) {
      throw new Error(`Anthropic provider failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as { content?: { type?: string; text?: string }[] };
    return requireText(json.content?.map((part) => part.text).filter(Boolean).join("\n") ?? "", resolved);
  }

  private async generateWithGemini(
    resolved: ResolvedModel,
    input: { system: string; user: string }
  ): Promise<string> {
    const url = new URL(`${resolved.provider.baseURL.replace(/\/$/, "")}/models/${resolved.model}:generateContent`);
    url.searchParams.set("key", resolved.apiKey);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...resolved.provider.headers },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }]
      })
    });
    if (!response.ok) {
      throw new Error(`Gemini provider failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return requireText(
      json.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n") ?? "",
      resolved
    );
  }

  private resolveModel(ref: string): ResolvedModel {
    if (!ref.trim()) {
      throw new Error('No model selected. Run "swarm onboard" or set models with "swarm models set".');
    }
    const { providerId, model, provider } = resolveModelRef(ref, this.settings);
    if (!providerId) {
      throw new Error(`No provider selected for model reference "${ref}". Run "swarm onboard".`);
    }
    if (!model) {
      throw new Error(`No model name found in model reference "${ref}".`);
    }
    if (!provider) {
      throw new Error(`Unknown provider "${providerId}" in model reference "${ref}"`);
    }
    const apiKey = getProviderApiKey(provider, this.config);
    return { provider, providerId, model, apiKey };
  }
}

type ResolvedModel = {
  provider: ProviderDefinition;
  providerId: string;
  model: string;
  apiKey: string;
};

function requireText(text: string, resolved: ResolvedModel): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`Provider "${resolved.providerId}" returned an empty response for model "${resolved.model}".`);
  }
  return trimmed;
}

function authHeaders(provider: ProviderDefinition, apiKey: string): Record<string, string> {
  if (!apiKey || provider.auth === "none" || provider.auth === "query-key") {
    return {};
  }
  if (provider.auth === "x-api-key") {
    return { "x-api-key": apiKey };
  }
  return { authorization: `Bearer ${apiKey}` };
}

function extractOutputText(response: unknown): string {
  const direct = response as { output_text?: unknown };
  if (typeof direct.output_text === "string") {
    return direct.output_text;
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        chunks.push(text);
      }
    }
  }
  return chunks.join("\n").trim();
}
