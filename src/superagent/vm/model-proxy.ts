/**
 * The model proxy of a ticket VM's gateway: the worker in the VM calls the providers through it with its slot's token, and
 * the host adds the provider's real key, so no key ever enters a VM. It forwards only the requests Swarm's provider makes
 * (one JSON answer per call, no streaming or background work, whose usage it could not count), refuses a call whose
 * provider budget is reached, and records each call's usage in this device's ledger under the ticket's worker session.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProviderApiKey, loadSwarmConfig, loadSwarmSettings, type ProviderDefinition } from "../../config/settings.js";
import { usageFromAnthropic, usageFromGemini, usageFromOpenAIResponse, type ProviderUsageHandler } from "../../providers/openai-provider.js";
import { HttpError, sendJson } from "../../server/gateway-http.js";
import { capMessage, reachedCap } from "../../usage/budget.js";

/** The largest request a worker sends to a provider. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** The paths after a provider's base URL that Swarm's provider calls, by protocol. */
const PATHS: Readonly<Record<ProviderDefinition["protocol"], RegExp>> = {
  "openai-responses": /^\/(?:responses|chat\/completions)$/,
  "openai-chat-completions": /^\/chat\/completions$/,
  // Its base URL is the messages endpoint itself.
  "anthropic-messages": /^$/,
  "google-gemini": /^\/(?:models\/[\w.-]+:generateContent|cachedContents)$/
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "The request is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The header a provider takes its key in, or the query parameter for one that takes it there. */
function credential(provider: ProviderDefinition, key: string): { headers: Record<string, string>; query?: [string, string] } {
  if (!key || provider.auth === "none") return { headers: {} };
  if (provider.auth === "query-key") return { headers: {}, query: ["key", key] };
  return { headers: provider.auth === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` } };
}

export interface ProxyCall {
  providerId: string;
  /** The path after the provider's base URL, with its leading slash, or empty. */
  rest: string;
  query: URLSearchParams;
  /** The ticket whose worker calls, for its usage records. */
  ticketId: string;
  /** Where this device's Swarm settings live, for its providers, keys and budgets. */
  workspace?: string;
  onUsage: ProviderUsageHandler;
  fetch?: typeof fetch;
}

/** Forwards a worker's model call to its provider with the provider's key, and answers with the provider's answer. */
export async function proxyModel(call: ProxyCall, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const settings = loadSwarmSettings(call.workspace);
  const provider = settings.providers[call.providerId];
  if (!provider) throw new HttpError(404, `No provider ${call.providerId}`);
  if (request.method !== "POST" || !PATHS[provider.protocol].test(call.rest)) throw new HttpError(403, `${call.providerId} takes no ${request.method} ${call.rest || "/"} through the gateway`);
  const raw = await readBody(request);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The request is not JSON");
  }
  if (body.stream === true || body.background === true) throw new HttpError(400, "Streamed and background calls do not go through the gateway");
  const cap = reachedCap({ provider: call.providerId }, call.workspace);
  if (cap) throw new HttpError(402, capMessage(cap));
  const { headers, query } = credential(provider, getProviderApiKey(provider, loadSwarmConfig()));
  const url = new URL(`${provider.baseURL.replace(/\/$/, "")}${call.rest}`);
  for (const [name, value] of call.query) if (name !== "key") url.searchParams.append(name, value);
  if (query) url.searchParams.set(...query);
  const forwarded = await (call.fetch ?? fetch)(url, { method: "POST", body: new Uint8Array(raw),
    headers: { "content-type": "application/json", ...provider.headers, ...headers,
      ...(typeof request.headers["anthropic-version"] === "string" ? { "anthropic-version": request.headers["anthropic-version"] } : {}) } });
  const text = await forwarded.text();
  if (forwarded.ok) record(call, provider, body, text);
  response.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json" });
  response.end(text);
}

/** Records a call's usage as Swarm's provider does, under the ticket's worker session, so its ledger and budgets count it. */
function record(call: ProxyCall, provider: ProviderDefinition, body: Record<string, unknown>, text: string): void {
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const usage = provider.protocol === "anthropic-messages" ? usageFromAnthropic(answer)
    : provider.protocol === "google-gemini" ? usageFromGemini(answer) : usageFromOpenAIResponse(answer);
  const model = typeof body.model === "string" ? body.model : /\/models\/([\w.-]+):/.exec(call.rest)?.[1] ?? "unknown";
  call.onUsage({ providerId: call.providerId, protocol: provider.protocol, model, purpose: "worker_coding_loop", sessionId: `worker-${call.ticketId}`,
    taskId: call.ticketId, cacheMode: "provider", promptCacheKey: "", promptCacheScope: "", cacheablePrefixTokensEstimate: 0, durationMs: 0, ...usage });
}

/** Answers a proxy failure as the provider would, so the worker's SDK reads its message. */
export function proxyError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 502;
  const message = error instanceof Error ? error.message : String(error);
  if (!response.headersSent) sendJson(response, status, { error: { type: status === 402 ? "budget_reached" : "gateway_error", message } });
  else response.end();
}
