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
import type { ToolResult, WebSearchAction } from "../tools/types.js";

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

  private async webSearchWithResponses(resolved: ResolvedModel, action: WebSearchAction): Promise<ToolResult> {
    const startedAt = Date.now();
    const client = new OpenAI({
      apiKey: resolved.apiKey || "local",
      baseURL: resolved.provider.baseURL,
      defaultHeaders: resolved.provider.headers
    });
    const response = await client.responses.create({
      model: resolved.model,
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
        max_tokens: 4096,
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

type WebSearchLink = {
  title: string;
  url: string;
};

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
