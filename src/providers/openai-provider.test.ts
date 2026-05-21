import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmConfig, defaultSwarmSettings } from "../config/settings.js";
import { OpenAIProvider, type ProviderUsageReport } from "./openai-provider.js";

test("OpenAI-compatible provider usage reads DeepSeek prompt cache counters", async () => {
  const fixture = await createProviderFixture({
    prompt_tokens: 1200,
    completion_tokens: 34,
    total_tokens: 1234,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 300
  });
  try {
    const usageReports: ProviderUsageReport[] = [];
    const provider = new OpenAIProvider({
      workspace: fixture.workspace,
      onUsage: (usage) => usageReports.push(usage)
    });

    const text = await provider.generateText({
      model: "deepseek/test-chat",
      system: [{ text: "Stable system prompt ".repeat(80), cache: true }],
      user: [
        { text: JSON.stringify({ tool_schemas: { Bash: { command: "string" } } }), cache: true },
        { text: JSON.stringify({ turn: 2, tool_results: [{ status: "success" }] }), cache: false }
      ],
      cache: { key: "swarm:test-cache", ttlSeconds: 3600 },
      usage: { sessionId: "session-cache", taskId: "turn-2", purpose: "main_coding_loop" },
      responseFormat: "json_object"
    });

    assert.equal(text, "{\"status\":\"completed\"}");
    assert.equal(usageReports.length, 1);
    assert.equal(usageReports[0].cachedInputTokens, 900);
    assert.equal(usageReports[0].totalInputWithCacheTokens, 1200);
    assert.equal(usageReports[0].uncachedInputTokens, 300);
    assert.equal(usageReports[0].cacheHitRate, 0.75);
  } finally {
    await fixture.close();
  }
});

test("prompt cache diagnostics ignore dynamic non-cacheable system text", async () => {
  const fixture = await createProviderFixture({
    prompt_tokens: 1200,
    completion_tokens: 10,
    total_tokens: 1210,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 300
  });
  try {
    const usageReports: ProviderUsageReport[] = [];
    const provider = new OpenAIProvider({
      workspace: fixture.workspace,
      onUsage: (usage) => usageReports.push(usage)
    });
    const stableSystem = [{ text: "Stable behavior block ".repeat(80), cache: true }];
    const stableUser = [{ text: JSON.stringify({ tool_schemas: { Bash: { command: "string" } } }), cache: true }];

    await provider.generateText({
      model: "deepseek/test-chat",
      system: [...stableSystem, { text: "dynamic durable context one", cache: false }],
      user: stableUser,
      cache: { key: "swarm:test-diagnostics", ttlSeconds: 3600 },
      usage: { sessionId: "session-cache", taskId: "turn-1", purpose: "main_coding_loop" },
      responseFormat: "json_object"
    });
    await provider.generateText({
      model: "deepseek/test-chat",
      system: [...stableSystem, { text: "dynamic durable context two", cache: false }],
      user: stableUser,
      cache: { key: "swarm:test-diagnostics", ttlSeconds: 3600 },
      usage: { sessionId: "session-cache", taskId: "turn-2", purpose: "main_coding_loop" },
      responseFormat: "json_object"
    });

    assert.equal(usageReports.length, 2);
    assert.equal(usageReports[0].promptCacheDiagnostics?.status, "new_scope");
    assert.equal(usageReports[1].promptCacheDiagnostics?.status, "stable");
    assert.deepEqual(usageReports[1].promptCacheDiagnostics?.changed, []);
  } finally {
    await fixture.close();
  }
});

test("non-cacheable system blocks are moved behind the cacheable request prefix", async () => {
  const fixture = await createProviderFixture({
    prompt_tokens: 1400,
    completion_tokens: 10,
    total_tokens: 1410,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 1400
  });
  try {
    const usageReports: ProviderUsageReport[] = [];
    const provider = new OpenAIProvider({
      workspace: fixture.workspace,
      onUsage: (usage) => usageReports.push(usage)
    });

    await provider.generateText({
      model: "deepseek/test-chat",
      system: [
        { text: "Stable system prompt ".repeat(80), cache: true },
        { text: "dynamic system context one", cache: false }
      ],
      user: [
        { text: JSON.stringify({ tool_schemas: { Bash: { command: "string" } } }), cache: true },
        { text: JSON.stringify({ turn: 1 }), cache: false }
      ],
      cache: { key: "swarm:test-request-prefix", ttlSeconds: 3600 },
      usage: { sessionId: "session-cache", taskId: "turn-1", purpose: "main_coding_loop" },
      responseFormat: "json_object"
    });

    assert.equal(fixture.requests.length, 1);
    const body = fixture.requests[0] as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const system = body.messages?.[0]?.content ?? "";
    const user = body.messages?.[1]?.content ?? "";
    assert.doesNotMatch(system, /dynamic system context one/);
    assert.match(user, /"tool_schemas"/);
    assert.match(user, /Additional non-cacheable system context:\ndynamic system context one/);
    assert(user.indexOf("\"tool_schemas\"") < user.indexOf("Additional non-cacheable system context"));
    assert.equal(usageReports[0].promptCacheDiagnostics?.current.firstDynamicBlockIndex, 2);
    assert.equal(typeof usageReports[0].promptCacheDiagnostics?.current.requestPrefixHash1024, "string");
    assert.equal(typeof usageReports[0].promptCacheDiagnostics?.current.requestPrefixHash4096, "string");
  } finally {
    await fixture.close();
  }
});

async function createProviderFixture(usage: Record<string, number>): Promise<{
  workspace: string;
  requests: unknown[];
  close: () => Promise<void>;
}> {
  const home = mkdtempSync(join(tmpdir(), "swarm-provider-cache-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "swarm-provider-cache-workspace-"));
  const previousHome = process.env.SWARM_HOME;
  const previousDisableCache = process.env.SWARM_DISABLE_PROMPT_CACHING;
  const requests: unknown[] = [];
  const server = await startChatCompletionServer(usage, requests);
  process.env.SWARM_HOME = home;
  delete process.env.SWARM_DISABLE_PROMPT_CACHING;

  const settings = defaultSwarmSettings();
  settings.models.defaultProvider = "deepseek";
  settings.models.planner = "deepseek/test-chat";
  settings.models.worker = "deepseek/test-chat";
  settings.models.aggregator = "deepseek/test-chat";
  settings.providers.deepseek.baseURL = server.baseURL;
  settings.providers.deepseek.models = { "test-chat": { name: "Test Chat" } };
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings, null, 2));
  const config = defaultSwarmConfig();
  config.providerApiKeys.deepseek = "test-key";
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));

  return {
    workspace,
    requests,
    close: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.SWARM_HOME;
      } else {
        process.env.SWARM_HOME = previousHome;
      }
      if (previousDisableCache === undefined) {
        delete process.env.SWARM_DISABLE_PROMPT_CACHING;
      } else {
        process.env.SWARM_DISABLE_PROMPT_CACHING = previousDisableCache;
      }
    }
  };
}

function startChatCompletionServer(usage: Record<string, number>, requests: unknown[]): Promise<{
  baseURL: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        requests.push(JSON.parse(body) as unknown);
      } catch {
        requests.push(body);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "test-chat",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "{\"status\":\"completed\"}" },
            finish_reason: "stop"
          }
        ],
        usage
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({
        baseURL: `http://127.0.0.1:${address.port}`,
        close: () => closeServer(server)
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
