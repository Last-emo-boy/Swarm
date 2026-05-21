import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatPromptCacheBrief, formatPromptCacheDetail, promptCacheStatusFromUsage } from "./prompt-cache-status.js";
import { SwarmRuntime } from "./runtime.js";

test("runtime prompt cache status preserves diagnostic fields for debug cache", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-prompt-cache-status-"));
  const runtime = new SwarmRuntime({
    workspace: root,
    databasePath: join(root, "swarm.db")
  });
  try {
    runtime.events.emitEvent({
      type: "provider_usage",
      usage: {
        providerId: "deepseek",
        protocol: "openai-chat-completions",
        model: "deepseek-chat",
        purpose: "main_coding_loop",
        sessionId: "session-cache",
        taskId: "turn-2",
        cacheMode: "prefix-structured",
        promptCacheKey: "swarm:main:stable:abc123",
        promptCacheScope: "session-cache:main_coding_loop:deepseek:deepseek-chat:swarm:main:stable:abc123",
        cacheablePrefixTokensEstimate: 4096,
        durationMs: 42,
        inputTokens: 5000,
        outputTokens: 100,
        cachedInputTokens: 3200,
        providerReportedMissInputTokens: 1800,
        totalInputWithCacheTokens: 5000,
        uncachedInputTokens: 1800,
        cacheHitRate: 0.64,
        promptCacheDiagnostics: {
          scope: "session-cache:main_coding_loop:deepseek:deepseek-chat:swarm:main:stable:abc123",
          status: "changed",
          changed: ["requestPrefixHash4096"],
          current: {
            systemHash: "system",
            userHash: "user",
            cacheablePrefixHash: "prefix",
            cacheableSystemHash: "system-prefix",
            cacheableUserHash: "user-prefix",
            toolSchemaHash: "tools",
            dynamicUserHash: "dynamic",
            requestPrefixHash1024: "1024",
            requestPrefixHash4096: "4096-new",
            firstDynamicBlockIndex: 2,
            cacheKey: "swarm:main:stable:abc123",
            model: "deepseek-chat",
            protocol: "openai-chat-completions",
            retention: "in_memory",
            ttlSeconds: 3600,
            anthropicTtl: "5m"
          },
          previous: {
            requestPrefixHash4096: "4096-old"
          },
          cachedInputTokens: 3200,
          totalInputWithCacheTokens: 5000,
          cacheHitRate: 0.64,
          minimumCacheableTokens: 1024
        }
      }
    });

    const status = runtime.getPromptCacheStatus();
    assert(status, "expected prompt cache status");
    assert.equal(status.status, "changed");
    assert.equal(status.cacheMode, "prefix-structured");
    assert.equal(status.promptCacheKey, "swarm:main:stable:abc123");
    assert.equal(status.cachedInputTokens, 3200);
    assert.equal(status.totalInputWithCacheTokens, 5000);
    assert.equal(status.cacheablePrefixTokensEstimate, 4096);
    assert.equal(status.hitRate, 0.64);
    assert.deepEqual(status.changed, ["requestPrefixHash4096"]);
    assert.equal(status.minimumCacheableTokens, 1024);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt cache helper derives shared brief and detail formatting from usage", () => {
  const status = promptCacheStatusFromUsage({
    providerId: "openai",
    protocol: "openai-responses",
    model: "gpt-test",
    purpose: "main_coding_loop",
    sessionId: "session-cache",
    taskId: "turn-3",
    cacheMode: "prefix-structured",
    promptCacheKey: "swarm:key",
    promptCacheScope: "scope",
    cacheablePrefixTokensEstimate: 2048,
    durationMs: 12,
    cachedInputTokens: 100,
    totalInputWithCacheTokens: 200,
    cacheWriteRate: 0.25,
    promptCacheDiagnostics: {
      scope: "scope",
      status: "cache_miss",
      changed: [],
      current: {
        systemHash: "system",
        userHash: "user",
        cacheablePrefixHash: "prefix",
        cacheableSystemHash: "system-prefix",
        cacheableUserHash: "user-prefix",
        toolSchemaHash: "tools",
        dynamicUserHash: "dynamic",
        requestPrefixHash1024: "1024",
        requestPrefixHash4096: "4096",
        firstDynamicBlockIndex: 1,
        cacheKey: "swarm:key",
        model: "gpt-test",
        protocol: "openai-responses",
        retention: "in_memory",
        ttlSeconds: 3600,
        anthropicTtl: "5m"
      },
      cachedInputTokens: 100,
      totalInputWithCacheTokens: 200,
      cacheHitRate: 0.5,
      cacheWriteRate: 0.25,
      minimumCacheableTokens: 1024
    }
  });

  assert.equal(status.hitRate, 0.5);
  assert.equal(status.diagnostics, "cache_miss");
  assert.match(formatPromptCacheBrief(status), /Prompt cache: cache_miss \(hit 50%, write 25%\)\./);
  const detail = formatPromptCacheDetail(status);
  assert.match(detail, /status=cache_miss/);
  assert.match(detail, /cached_input_tokens=100/);
  assert.match(detail, /JSON/);
});
