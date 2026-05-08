import { createHash } from "node:crypto";
import OpenAI from "openai";
import {
  MODEL_MAX_OUTPUT_TOKENS_DEFAULT,
  MODEL_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  getProviderApiKey,
  getSelectedModelReadiness,
  loadSwarmConfig,
  loadSwarmSettings,
  resolveModelRef,
  type ProviderDefinition,
  type SwarmConfig,
  type SwarmSettings
} from "../config/settings.js";
import type { ToolResult, WebSearchAction } from "../tools/types.js";

const WEB_SEARCH_MAX_OUTPUT_TOKENS = 4_000;
const MAX_CACHE_DIAGNOSTIC_SOURCES = 10;
const MIN_CACHE_MISS_TOKENS = 2_000;
const promptCachePolicies = new Map<string, PromptCachePolicy>();
const promptCacheDiagnostics = new Map<string, PromptCacheDiagnosticState>();

export class OpenAIProvider {
  readonly model: string;
  readonly workerModel: string;
  readonly aggregatorModel: string;
  private readonly settings: SwarmSettings;
  private readonly config: SwarmConfig;
  private readonly onUsage?: ProviderUsageHandler;
  private readonly geminiExplicitCaches = new Map<string, GeminiExplicitCache>();

  constructor(options: { onUsage?: ProviderUsageHandler } = {}) {
    this.settings = loadSwarmSettings();
    this.config = loadSwarmConfig();
    this.onUsage = options.onUsage;
    const envModel = nonEmptyEnv("SWARM_MODEL");
    this.model = envModel ?? this.settings.models.planner;
    this.workerModel = nonEmptyEnv("SWARM_WORKER_MODEL") ?? envModel ?? this.settings.models.worker;
    this.aggregatorModel = nonEmptyEnv("SWARM_AGGREGATOR_MODEL") ?? envModel ?? this.settings.models.aggregator;
  }

  get enabled(): boolean {
    return getSelectedModelReadiness(this.settings, this.config).every((readiness) => readiness.configured);
  }

  async generateText(input: {
    system: PromptInput;
    user: PromptInput;
    model?: string;
    cache?: PromptCacheOptions;
    maxOutputTokens?: number;
    usage?: ProviderUsageContext;
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

  async webSearch(action: WebSearchAction): Promise<ToolResult> {
    const resolved = this.resolveModel(this.workerModel);
    if (resolved.provider.apiKeyRequired && !resolved.apiKey) {
      throw new Error(
        `Missing API key for provider "${resolved.providerId}". Run "swarm onboard" or "swarm auth set-key ${resolved.providerId} <api-key>".`
      );
    }

    if (resolved.provider.protocol === "openai-responses") {
      return this.webSearchWithResponses(resolved, action);
    }

    if (resolved.provider.protocol === "anthropic-messages") {
      return this.webSearchWithAnthropic(resolved, action);
    }

    throw new Error(`Provider protocol "${resolved.provider.protocol}" does not support server-side web search`);
  }

  private async generateWithResponses(
    resolved: ResolvedModel,
    input: GenerateTextInput
  ): Promise<string> {
    const prompt = preparePrompt(input);
    const client = new OpenAI({
      apiKey: resolved.apiKey || "local",
      baseURL: resolved.provider.baseURL,
      defaultHeaders: resolved.provider.headers
    });
    const startedAt = Date.now();
    const response = await client.responses.create({
      model: resolved.model,
      max_output_tokens: maxOutputTokensForResolvedModel(resolved, this.settings, input.maxOutputTokens),
      ...openAIPromptCacheParams(resolved, prompt, input.cache),
      input: [
        { role: "system", content: prompt.systemText },
        { role: "user", content: prompt.userText }
      ]
    } as never);
    this.emitUsage(resolved, "generateText", input.usage, usageFromOpenAIResponse(response), prompt, startedAt);
    return requireText(extractOutputText(response), resolved);
  }

  private async generateWithChatCompletions(
    resolved: ResolvedModel,
    input: GenerateTextInput
  ): Promise<string> {
    const prompt = preparePrompt(input);
    const client = new OpenAI({
      apiKey: resolved.apiKey || "local",
      baseURL: resolved.provider.baseURL,
      defaultHeaders: resolved.provider.headers
    });
    const startedAt = Date.now();
    const response = await client.chat.completions.create({
      model: resolved.model,
      max_tokens: maxOutputTokensForResolvedModel(resolved, this.settings, input.maxOutputTokens),
      ...openAIPromptCacheParams(resolved, prompt, input.cache),
      messages: [
        { role: "system", content: prompt.systemText },
        { role: "user", content: prompt.userText }
      ]
    } as never);
    this.emitUsage(resolved, "generateText", input.usage, usageFromOpenAIResponse(response), prompt, startedAt);
    return requireText(response.choices[0]?.message?.content ?? "", resolved);
  }

  private async generateWithAnthropic(
    resolved: ResolvedModel,
    input: GenerateTextInput
  ): Promise<string> {
    const prompt = preparePrompt(input);
    const enableCache = promptCacheEnabled() && input.cache?.enabled !== false;
    const startedAt = Date.now();
    const response = await fetch(resolved.provider.baseURL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...resolved.provider.headers,
        ...authHeaders(resolved.provider, resolved.apiKey)
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: maxOutputTokensForResolvedModel(resolved, this.settings, input.maxOutputTokens),
        system: anthropicSystem(prompt, enableCache, input.cache),
        messages: [{ role: "user", content: anthropicContentBlocks(prompt.userBlocks, enableCache, input.cache) }]
      })
    });
    if (!response.ok) {
      throw new Error(`Anthropic provider failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as { content?: { type?: string; text?: string }[]; usage?: unknown };
    this.emitUsage(resolved, "generateText", input.usage, usageFromAnthropic(json), prompt, startedAt);
    return requireText(json.content?.map((part) => part.text).filter(Boolean).join("\n") ?? "", resolved);
  }

  private async webSearchWithResponses(resolved: ResolvedModel, action: WebSearchAction): Promise<ToolResult> {
    const startedAt = Date.now();
    const client = new OpenAI({
      apiKey: resolved.apiKey || "local",
      baseURL: resolved.provider.baseURL,
      defaultHeaders: resolved.provider.headers
    });
    const response = await client.responses.create({
      model: resolved.model,
      max_output_tokens: maxOutputTokensForResolvedModel(resolved, this.settings, WEB_SEARCH_MAX_OUTPUT_TOKENS),
      tools: [{ type: "web_search_preview" }],
      input: [
        { role: "system", content: webSearchSystemPrompt(action) },
        { role: "user", content: `Search the web for: ${action.query}` }
      ]
    } as never);
    const text = extractOutputText(response);
    const links = uniqueLinks(collectLinksFromUnknown(response));
    return makeServerWebSearchResult(action, resolved, "openai-responses", text, links, startedAt);
  }

  private async webSearchWithAnthropic(resolved: ResolvedModel, action: WebSearchAction): Promise<ToolResult> {
    const startedAt = Date.now();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...resolved.provider.headers,
      ...authHeaders(resolved.provider, resolved.apiKey)
    };
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "anthropic-beta")) {
      headers["anthropic-beta"] = "web-search-2025-03-05";
    }
    const tool: Record<string, unknown> = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: Math.max(1, Math.min(10, action.maxUses ?? 8))
    };
    if (action.allowed_domains?.length) {
      tool.allowed_domains = action.allowed_domains;
    }
    if (action.blocked_domains?.length) {
      tool.blocked_domains = action.blocked_domains;
    }
    const response = await fetch(resolved.provider.baseURL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: maxOutputTokensForResolvedModel(resolved, this.settings, WEB_SEARCH_MAX_OUTPUT_TOKENS),
        system: webSearchSystemPrompt(action),
        messages: [{ role: "user", content: `Perform a web search for the query: ${action.query}` }],
        tools: [tool]
      })
    });
    if (!response.ok) {
      throw new Error(`Anthropic web search failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const json = await response.json();
    const contentBlocks = isRecord(json) && Array.isArray(json.content) ? json.content : [];
    const text = contentBlocks
      .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    const links = uniqueLinks(collectLinksFromUnknown(json));
    return makeServerWebSearchResult(action, resolved, "anthropic-messages", text, links, startedAt);
  }

  private async generateWithGemini(
    resolved: ResolvedModel,
    input: GenerateTextInput
  ): Promise<string> {
    const prompt = preparePrompt(input);
    const cache = await this.getGeminiExplicitCache(resolved, prompt, input.cache);
    const url = new URL(`${resolved.provider.baseURL.replace(/\/$/, "")}/models/${resolved.model}:generateContent`);
    url.searchParams.set("key", resolved.apiKey);
    const startedAt = Date.now();
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: cache ? prompt.dynamicUserText || prompt.userText : prompt.userText }] }],
      generationConfig: {
        maxOutputTokens: maxOutputTokensForResolvedModel(resolved, this.settings, input.maxOutputTokens)
      }
    };
    if (cache) {
      body.cachedContent = cache.name;
    } else {
      body.systemInstruction = { parts: [{ text: prompt.systemText }] };
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...resolved.provider.headers },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Gemini provider failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: unknown;
    };
    this.emitUsage(resolved, "generateText", input.usage, usageFromGemini(json), prompt, startedAt, cache ? "explicit" : "implicit");
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

  private emitUsage(
    resolved: ResolvedModel,
    purpose: string,
    context: ProviderUsageContext | undefined,
    usage: ProviderUsage,
    prompt: PreparedPrompt,
    startedAt: number,
    cacheMode = providerCacheMode(resolved)
  ): void {
    this.onUsage?.({
      providerId: resolved.providerId,
      protocol: resolved.provider.protocol,
      model: resolved.model,
      purpose: context?.purpose ?? purpose,
      sessionId: context?.sessionId,
      taskId: context?.taskId,
      cacheMode,
      promptCacheKey: prompt.cacheKey,
      promptCacheScope: promptCacheScope(resolved, prompt, context),
      promptCacheDiagnostics: trackPromptCacheDiagnostics(resolved, prompt, context, usage),
      cacheablePrefixTokensEstimate: estimateTokens(prompt.cacheablePrefixText),
      durationMs: Date.now() - startedAt,
      ...usage
    });
  }

  private async getGeminiExplicitCache(
    resolved: ResolvedModel,
    prompt: PreparedPrompt,
    options?: PromptCacheOptions
  ): Promise<GeminiExplicitCache | undefined> {
    if (!promptCacheEnabled() || !isOfficialGeminiProvider(resolved) || options?.enabled === false) {
      return undefined;
    }
    const cacheableText = prompt.cacheablePrefixText.trim();
    if (!cacheableText) {
      return undefined;
    }
    const minTokens = geminiExplicitCacheMinTokens(resolved.model);
    if (estimateTokens(cacheableText) < minTokens) {
      return undefined;
    }
    const ttlSeconds = geminiCacheTtlSeconds(options);
    const key = `${resolved.providerId}:${resolved.model}:${ttlSeconds}:${stableHash(cacheableText)}`;
    const existing = this.geminiExplicitCaches.get(key);
    if (existing && existing.expiresAt > Date.now() + 30_000) {
      return existing;
    }
    try {
      const created = await this.createGeminiExplicitCache(resolved, prompt, ttlSeconds);
      this.geminiExplicitCaches.set(key, created);
      return created;
    } catch {
      return undefined;
    }
  }

  private async createGeminiExplicitCache(
    resolved: ResolvedModel,
    prompt: PreparedPrompt,
    ttlSeconds: number
  ): Promise<GeminiExplicitCache> {
    const url = new URL(`${resolved.provider.baseURL.replace(/\/$/, "")}/cachedContents`);
    url.searchParams.set("key", resolved.apiKey);
    const body: Record<string, unknown> = {
      model: geminiModelResource(resolved.model),
      ttl: `${ttlSeconds}s`
    };
    if (prompt.cacheableSystemText.trim()) {
      body.systemInstruction = { parts: [{ text: prompt.cacheableSystemText }] };
    }
    if (prompt.cacheableUserText.trim()) {
      body.contents = [{ role: "user", parts: [{ text: prompt.cacheableUserText }] }];
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...resolved.provider.headers },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Gemini cache create failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const json = await response.json();
    const name = isRecord(json) && typeof json.name === "string" ? json.name : "";
    if (!name) {
      throw new Error("Gemini cache create response did not include a cache name");
    }
    return { name, expiresAt: Date.now() + ttlSeconds * 1000 };
  }
}

export type PromptBlock = {
  text: string;
  cache?: boolean;
};

export type PromptInput = string | PromptBlock[];

export type PromptCacheOptions = {
  enabled?: boolean;
  key?: string;
  retention?: "in_memory" | "24h";
  ttlSeconds?: number;
};

export type ProviderUsageContext = {
  sessionId?: string;
  taskId?: string;
  purpose?: string;
};

export type ProviderUsageReport = {
  providerId: string;
  protocol: ProviderDefinition["protocol"];
  model: string;
  purpose: string;
  sessionId?: string;
  taskId?: string;
  cacheMode: string;
  promptCacheKey: string;
  promptCacheScope: string;
  promptCacheDiagnostics?: PromptCacheDiagnostics;
  cacheablePrefixTokensEstimate: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export type ProviderUsageHandler = (usage: ProviderUsageReport) => void;

type GenerateTextInput = {
  system: PromptInput;
  user: PromptInput;
  model?: string;
  cache?: PromptCacheOptions;
  maxOutputTokens?: number;
  usage?: ProviderUsageContext;
};

type PreparedPrompt = {
  systemBlocks: NormalizedPromptBlock[];
  userBlocks: NormalizedPromptBlock[];
  systemText: string;
  userText: string;
  cacheableSystemText: string;
  cacheableUserText: string;
  cacheablePrefixText: string;
  dynamicUserText: string;
  cacheKey: string;
  explicitCacheKey: string;
  diagnostics: PreparedPromptDiagnostics;
};

type PreparedPromptDiagnostics = {
  systemHash: string;
  userHash: string;
  cacheablePrefixHash: string;
  cacheableSystemHash: string;
  cacheableUserHash: string;
  toolSchemaHash: string;
  dynamicUserHash: string;
};

type PromptCachePolicy = {
  key: string;
  retention: "in_memory" | "24h";
  ttlSeconds: number;
  anthropicTtl: "5m" | "1h";
};

export type PromptCacheDiagnostics = {
  scope: string;
  status: "new_scope" | "stable" | "changed" | "expected_empty_cache" | "cache_miss";
  changed: string[];
  current: PreparedPromptDiagnostics & {
    cacheKey: string;
    model: string;
    protocol: ProviderDefinition["protocol"];
    retention: "in_memory" | "24h";
    ttlSeconds: number;
    anthropicTtl: "5m" | "1h";
  };
  previous?: Partial<PromptCacheDiagnostics["current"]>;
  cachedInputTokens?: number;
};

type PromptCacheDiagnosticState = PromptCacheDiagnostics["current"] & {
  seenAt: number;
};

type NormalizedPromptBlock = {
  text: string;
  cache: boolean;
};

type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type GeminiExplicitCache = {
  name: string;
  expiresAt: number;
};

type ResolvedModel = {
  provider: ProviderDefinition;
  providerId: string;
  model: string;
  apiKey: string;
};

type WebSearchLink = {
  title: string;
  url: string;
};

function maxOutputTokensForResolvedModel(resolved: ResolvedModel, settings: SwarmSettings, requestMaxOutputTokens?: number): number {
  return boundedMaxOutputTokens(
    requestMaxOutputTokens,
    process.env.SWARM_MAX_OUTPUT_TOKENS,
    settings.models.maxOutputTokens,
    defaultMaxOutputTokensForModel(resolved.model)
  );
}

function preparePrompt(input: GenerateTextInput): PreparedPrompt {
  const systemBlocks = normalizePromptBlocks(input.system);
  const userBlocks = normalizePromptBlocks(input.user);
  const systemText = joinPromptBlocks(systemBlocks);
  const userText = joinPromptBlocks(userBlocks);
  const cacheableSystemText = joinPromptBlocks(systemBlocks.filter((block) => block.cache));
  const cacheableUserText = joinPromptBlocks(userBlocks.filter((block) => block.cache));
  const cacheablePrefixText = [cacheableSystemText, cacheableUserText].filter(Boolean).join("\n\n");
  const lastCacheableUserIndex = lastCacheableIndex(userBlocks);
  const dynamicUserText = lastCacheableUserIndex >= 0
    ? joinPromptBlocks(userBlocks.slice(lastCacheableUserIndex + 1))
    : userText;
  const explicitKey = input.cache?.key?.trim();
  const cacheKey = explicitKey || (cacheablePrefixText ? `swarm:${stableHash(cacheablePrefixText).slice(0, 24)}` : "");
  const toolSchemaHash = hashToolSchemaFromText(userText);
  return {
    systemBlocks,
    userBlocks,
    systemText,
    userText,
    cacheableSystemText,
    cacheableUserText,
    cacheablePrefixText,
    dynamicUserText,
    cacheKey,
    explicitCacheKey: explicitKey ?? "",
    diagnostics: {
      systemHash: stableHash(systemText),
      userHash: stableHash(userText),
      cacheablePrefixHash: stableHash(cacheablePrefixText),
      cacheableSystemHash: stableHash(cacheableSystemText),
      cacheableUserHash: stableHash(cacheableUserText),
      toolSchemaHash,
      dynamicUserHash: stableHash(dynamicUserText)
    }
  };
}

function normalizePromptBlocks(input: PromptInput): NormalizedPromptBlock[] {
  if (typeof input === "string") {
    return input.trim() ? [{ text: input, cache: false }] : [];
  }
  return input
    .map((block) => ({ text: block.text.trim(), cache: block.cache === true }))
    .filter((block) => block.text.length > 0);
}

function joinPromptBlocks(blocks: NormalizedPromptBlock[]): string {
  return blocks.map((block) => block.text).filter(Boolean).join("\n\n");
}

function lastCacheableIndex(blocks: NormalizedPromptBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.cache) {
      return index;
    }
  }
  return -1;
}

function anthropicSystem(prompt: PreparedPrompt, enableCache: boolean, options?: PromptCacheOptions): string | Array<Record<string, unknown>> {
  const markerIndex = lastCacheableIndex(prompt.userBlocks) >= 0 ? -1 : lastCacheableIndex(prompt.systemBlocks);
  if (!enableCache || (markerIndex < 0 && !prompt.systemBlocks.some((block) => block.cache))) {
    return prompt.systemText;
  }
  return prompt.systemBlocks.map((block, index) => ({
    type: "text",
    text: block.text,
    ...(enableCache && index === markerIndex ? { cache_control: anthropicCacheControl(options) } : {})
  }));
}

function anthropicContentBlocks(blocks: NormalizedPromptBlock[], enableCache: boolean, options?: PromptCacheOptions): Array<Record<string, unknown>> {
  const markerIndex = lastCacheableIndex(blocks);
  return blocks.map((block, index) => ({
    type: "text",
    text: block.text,
    ...(enableCache && index === markerIndex ? { cache_control: anthropicCacheControl(options) } : {})
  }));
}

function anthropicCacheControl(options?: PromptCacheOptions): Record<string, unknown> {
  return {
    type: "ephemeral",
    ...(promptCachePolicy({ options }).anthropicTtl === "1h" ? { ttl: "1h" } : {})
  };
}

function anthropicCacheTtl(options?: PromptCacheOptions): "5m" | "1h" {
  return promptCachePolicy({ options }).anthropicTtl;
}

function rawAnthropicCacheTtl(): "5m" | "1h" {
  return process.env.SWARM_PROMPT_CACHE_TTL === "1h" ? "1h" : "5m";
}

function openAIPromptCacheParams(
  resolved: ResolvedModel,
  prompt: PreparedPrompt,
  options?: PromptCacheOptions
): Record<string, unknown> {
  if (!promptCacheEnabled() || options?.enabled === false || !isOfficialOpenAIProvider(resolved) || !prompt.cacheKey) {
    return {};
  }
  const retention = promptCachePolicy({ prompt, options }).retention;
  return {
    prompt_cache_key: prompt.cacheKey,
    ...(retention === "24h" ? { prompt_cache_retention: "24h" } : {})
  };
}

function openAIPromptCacheRetention(options?: PromptCacheOptions): "in_memory" | "24h" {
  return promptCachePolicy({ options }).retention;
}

function rawOpenAIPromptCacheRetention(): "in_memory" | "24h" {
  return process.env.SWARM_PROMPT_CACHE_RETENTION === "24h" ? "24h" : "in_memory";
}

function promptCachePolicy(input: { prompt?: PreparedPrompt; options?: PromptCacheOptions }): PromptCachePolicy {
  const scope = input.options?.key?.trim() || input.prompt?.cacheKey || "default";
  const existing = promptCachePolicies.get(scope);
  if (existing) {
    return existing;
  }
  const envTtl = Number(process.env.SWARM_GEMINI_CACHE_TTL_SECONDS);
  const ttlSeconds = Math.max(
    60,
    Math.min(Math.floor(input.options?.ttlSeconds ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 3600)), 86_400)
  );
  const policy: PromptCachePolicy = {
    key: scope,
    retention: input.options?.retention ?? rawOpenAIPromptCacheRetention(),
    ttlSeconds,
    anthropicTtl: rawAnthropicCacheTtl()
  };
  promptCachePolicies.set(scope, policy);
  if (promptCachePolicies.size > MAX_CACHE_DIAGNOSTIC_SOURCES) {
    const oldest = promptCachePolicies.keys().next().value;
    if (typeof oldest === "string") {
      promptCachePolicies.delete(oldest);
    }
  }
  return policy;
}

function promptCacheEnabled(): boolean {
  return !isTruthyEnv(process.env.SWARM_DISABLE_PROMPT_CACHING);
}

function isOfficialOpenAIProvider(resolved: ResolvedModel): boolean {
  return resolved.providerId === "openai" && /^https:\/\/api\.openai\.com\/v1\/?$/i.test(resolved.provider.baseURL);
}

function isOfficialGeminiProvider(resolved: ResolvedModel): boolean {
  return resolved.providerId === "gemini" && /generativelanguage\.googleapis\.com/i.test(resolved.provider.baseURL);
}

function providerCacheMode(resolved: ResolvedModel): string {
  if (resolved.provider.protocol === "anthropic-messages") {
    return "anthropic-cache-control";
  }
  if (isOfficialOpenAIProvider(resolved)) {
    return "openai-automatic";
  }
  if (isOfficialGeminiProvider(resolved)) {
    return "gemini-implicit";
  }
  if (resolved.provider.protocol === "openai-chat-completions") {
    return "prefix-structured";
  }
  return "none";
}

function promptCacheScope(
  resolved: ResolvedModel,
  prompt: PreparedPrompt,
  context?: ProviderUsageContext
): string {
  return [
    context?.sessionId ?? "nosession",
    context?.purpose ?? "generateText",
    resolved.providerId,
    resolved.model,
    prompt.explicitCacheKey || prompt.cacheKey || "nocache"
  ].join(":");
}

function trackPromptCacheDiagnostics(
  resolved: ResolvedModel,
  prompt: PreparedPrompt,
  context: ProviderUsageContext | undefined,
  usage: ProviderUsage
): PromptCacheDiagnostics {
  const policy = promptCachePolicy({ prompt });
  const scope = promptCacheScope(resolved, prompt, context);
  const current: PromptCacheDiagnostics["current"] = {
    ...prompt.diagnostics,
    cacheKey: prompt.cacheKey,
    model: resolved.model,
    protocol: resolved.provider.protocol,
    retention: policy.retention,
    ttlSeconds: policy.ttlSeconds,
    anthropicTtl: policy.anthropicTtl
  };
  const previous = promptCacheDiagnostics.get(scope);
  const changed = previous ? changedPromptCacheFields(previous, current) : [];
  const cacheableTokens = estimateTokens(prompt.cacheablePrefixText);
  const cachedInputTokens = usage.cachedInputTokens;
  const status: PromptCacheDiagnostics["status"] = !previous
    ? "new_scope"
    : changed.length > 0
      ? "changed"
      : cacheableTokens < MIN_CACHE_MISS_TOKENS
        ? "expected_empty_cache"
        : (typeof cachedInputTokens === "number" && cachedInputTokens <= 0 ? "cache_miss" : "stable");
  promptCacheDiagnostics.set(scope, { ...current, seenAt: Date.now() });
  trimPromptCacheDiagnostics();
  return {
    scope,
    status,
    changed,
    current,
    previous: previous ? { ...previous } : undefined,
    cachedInputTokens
  };
}

function changedPromptCacheFields(
  previous: PromptCacheDiagnosticState,
  current: PromptCacheDiagnostics["current"]
): string[] {
  const fields = [
    "systemHash",
    "cacheablePrefixHash",
    "cacheableSystemHash",
    "cacheableUserHash",
    "toolSchemaHash",
    "cacheKey",
    "model",
    "protocol",
    "retention",
    "ttlSeconds",
    "anthropicTtl"
  ] as const;
  return fields.filter((field) => previous[field] !== current[field]);
}

function trimPromptCacheDiagnostics(): void {
  if (promptCacheDiagnostics.size <= MAX_CACHE_DIAGNOSTIC_SOURCES) {
    return;
  }
  const oldest = [...promptCacheDiagnostics.entries()]
    .sort((a, b) => a[1].seenAt - b[1].seenAt)[0]?.[0];
  if (oldest) {
    promptCacheDiagnostics.delete(oldest);
  }
}

function usageFromOpenAIResponse(response: unknown): ProviderUsage {
  const usage = isRecord(response) && isRecord(response.usage) ? response.usage : {};
  const promptTokens = numberField(usage, "prompt_tokens") ?? numberField(usage, "input_tokens");
  const completionTokens = numberField(usage, "completion_tokens") ?? numberField(usage, "output_tokens");
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : {};
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: numberField(usage, "total_tokens") ?? sumDefined(promptTokens, completionTokens),
    cachedInputTokens: numberField(promptDetails, "cached_tokens")
  };
}

function usageFromAnthropic(response: { usage?: unknown }): ProviderUsage {
  const usage = isRecord(response.usage) ? response.usage : {};
  return {
    inputTokens: numberField(usage, "input_tokens"),
    outputTokens: numberField(usage, "output_tokens"),
    totalTokens: sumDefined(numberField(usage, "input_tokens"), numberField(usage, "output_tokens")),
    cachedInputTokens: numberField(usage, "cache_read_input_tokens"),
    cacheCreationInputTokens: numberField(usage, "cache_creation_input_tokens")
  };
}

function usageFromGemini(response: { usageMetadata?: unknown }): ProviderUsage {
  const usage = isRecord(response.usageMetadata) ? response.usageMetadata : {};
  return {
    inputTokens: numberField(usage, "promptTokenCount"),
    outputTokens: numberField(usage, "candidatesTokenCount"),
    totalTokens: numberField(usage, "totalTokenCount"),
    cachedInputTokens: numberField(usage, "cachedContentTokenCount")
  };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashToolSchemaFromText(value: string): string {
  const matches = value.match(/"tool_schemas"\s*:\s*(?:\{|\[)[\s\S]*?(?=\n\s*"available_agent_specs"|\n\s*"delegation_policy"|\n\s*"swarm_runtime_state"|\n\s*"live_user_messages"|$)/);
  return stableHash(matches?.[0] ?? "");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function geminiExplicitCacheMinTokens(model: string): number {
  return model.toLowerCase().includes("pro") ? 4096 : 1024;
}

function geminiCacheTtlSeconds(options?: PromptCacheOptions): number {
  return promptCachePolicy({ options }).ttlSeconds;
}

function geminiModelResource(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boundedMaxOutputTokens(...candidates: Array<number | string | null | undefined>): number {
  for (const candidate of candidates) {
    const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.floor(parsed), MODEL_MAX_OUTPUT_TOKENS_UPPER_LIMIT);
    }
  }
  return MODEL_MAX_OUTPUT_TOKENS_DEFAULT;
}

function defaultMaxOutputTokensForModel(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes("opus-4-6") || lower.includes("opus_4_6")) {
    return 64_000;
  }
  if (lower.includes("claude-3-opus") || lower.includes("claude-3-haiku")) {
    return 4_096;
  }
  if (
    lower.includes("claude-3-sonnet") ||
    lower.includes("3-5-sonnet") ||
    lower.includes("3-5-haiku")
  ) {
    return 8_192;
  }
  return MODEL_MAX_OUTPUT_TOKENS_DEFAULT;
}

function webSearchSystemPrompt(action: WebSearchAction): string {
  const domainRule = action.allowed_domains?.length
    ? `Only include results from these domains when searching: ${action.allowed_domains.join(", ")}.`
    : action.blocked_domains?.length
      ? `Do not include results from these domains when searching: ${action.blocked_domains.join(", ")}.`
      : "No domain filter was requested.";
  return [
    "You are Swarm's provider-native web search tool.",
    "Search the web for current, factual information and return concise findings.",
    domainRule,
    "Always include a final Sources section with markdown links for every relevant source.",
    "Do not include prose outside the search answer and Sources section."
  ].join(" ");
}

function makeServerWebSearchResult(
  action: WebSearchAction,
  resolved: ResolvedModel,
  protocol: ProviderDefinition["protocol"],
  text: string,
  links: WebSearchLink[],
  startedAt: number
): ToolResult {
  const trimmedText = text.trim();
  if (!trimmedText && links.length === 0) {
    throw new Error(`Provider "${resolved.providerId}" returned no web search content for "${action.query}".`);
  }
  const content = [
    `Web search results for "${action.query}" via ${resolved.providerId}/${resolved.model}`,
    trimmedText,
    "Sources:",
    ...links.map((link) => `- [${escapeMarkdownLinkText(link.title)}](${link.url})`),
    "",
    "REMINDER: Include relevant sources above in the final user response using markdown hyperlinks."
  ].filter((line) => line !== "").join("\n");
  return {
    action: "web.search",
    status: "success",
    summary: `web search returned ${links.length} source(s) using ${resolved.providerId}`,
    content,
    data: {
      query: action.query,
      provider: resolved.providerId,
      protocol,
      model: resolved.model,
      durationSeconds: (Date.now() - startedAt) / 1000,
      allowed_domains: action.allowed_domains ?? [],
      blocked_domains: action.blocked_domains ?? [],
      text: trimmedText,
      results: links
    }
  };
}

function collectLinksFromUnknown(value: unknown, depth = 0): WebSearchLink[] {
  if (depth > 8) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectLinksFromUnknown(item, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }

  const links: WebSearchLink[] = [];
  if (typeof value.url === "string" && isHttpUrl(value.url)) {
    const title = typeof value.title === "string"
      ? value.title
      : typeof value.page_title === "string"
        ? value.page_title
        : typeof value.name === "string"
          ? value.name
          : value.url;
    links.push({ title: title.trim() || value.url, url: value.url });
  }
  for (const nested of Object.values(value)) {
    links.push(...collectLinksFromUnknown(nested, depth + 1));
  }
  return links;
}

function uniqueLinks(links: WebSearchLink[]): WebSearchLink[] {
  const seen = new Set<string>();
  const result: WebSearchLink[] = [];
  for (const link of links) {
    const key = link.url.replace(/#.*$/, "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      title: link.title.replace(/\s+/g, " ").trim() || link.url,
      url: link.url
    });
  }
  return result.slice(0, 20);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
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
