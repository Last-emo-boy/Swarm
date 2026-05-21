import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatPromptCacheBrief,
  formatPromptCacheDetail,
  formatPromptCacheDetailWithTrend,
  formatPromptCacheInline,
  promptCacheTrendFromUsage,
  promptCacheStatusFromUsage,
  resultCardCacheStatus
} from "./prompt-cache-status.js";
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
    assert.equal(status.outcome, "miss");
    assert.match(status.reason ?? "", /stable prefix changed/);
    const trend = runtime.getPromptCacheTrend();
    assert.equal(trend.source, "provider_usage");
    assert.equal(trend.calls, 1);
    assert.equal(trend.missCalls, 1);
    assert.equal(trend.cachedInputTokens, 3200);
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
  assert.equal(status.outcome, "miss");
  assert.match(status.recommendation ?? "", /provider cache support/);
  assert.match(formatPromptCacheBrief(status), /Prompt cache: cache_miss \(hit 50%, write 25%\)\./);
  const detail = formatPromptCacheDetail(status);
  assert.match(detail, /status=cache_miss/);
  assert.match(detail, /cached_input_tokens=100/);
  assert.match(detail, /outcome=miss/);
  assert.match(detail, /recommendation=/);
  const inline = formatPromptCacheInline(resultCardCacheStatus(status));
  assert(inline);
  assert.match(inline, /cache:cache_miss hit 50%, write 25% miss cache_miss/);
  assert.match(detail, /JSON/);
});

test("prompt cache trend aggregates hit, miss, warming, and changed-prefix reasons", () => {
  const trend = promptCacheTrendFromUsage([
    {
      providerId: "deepseek",
      protocol: "openai-chat-completions",
      model: "deepseek-v4-flash",
      purpose: "worker_coding_loop",
      sessionId: "session-cache",
      taskId: "turn-1",
      cacheMode: "prefix-structured",
      promptCacheKey: "swarm:key",
      promptCacheScope: "scope-1",
      cacheablePrefixTokensEstimate: 4096,
      durationMs: 10,
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 3000,
      promptCacheDiagnostics: {
        scope: "scope-1",
        status: "new_scope",
        changed: [],
        current: promptCacheDiagnosticCurrent("swarm:key"),
        cachedInputTokens: 0,
        totalInputWithCacheTokens: 3000,
        cacheHitRate: 0,
        minimumCacheableTokens: 1024
      }
    },
    {
      providerId: "deepseek",
      protocol: "openai-chat-completions",
      model: "deepseek-v4-flash",
      purpose: "worker_coding_loop",
      sessionId: "session-cache",
      taskId: "turn-2",
      cacheMode: "prefix-structured",
      promptCacheKey: "swarm:key",
      promptCacheScope: "scope-1",
      cacheablePrefixTokensEstimate: 4096,
      durationMs: 12,
      cachedInputTokens: 2400,
      totalInputWithCacheTokens: 4000,
      cacheCreationInputTokens: 200,
      promptCacheDiagnostics: {
        scope: "scope-1",
        status: "stable",
        changed: [],
        current: promptCacheDiagnosticCurrent("swarm:key"),
        cachedInputTokens: 2400,
        totalInputWithCacheTokens: 4000,
        cacheHitRate: 0.6,
        cacheWriteRate: 0.05,
        minimumCacheableTokens: 1024
      }
    },
    {
      providerId: "deepseek",
      protocol: "openai-chat-completions",
      model: "deepseek-v4-flash",
      purpose: "worker_coding_loop",
      sessionId: "session-cache",
      taskId: "turn-3",
      cacheMode: "prefix-structured",
      promptCacheKey: "swarm:key",
      promptCacheScope: "scope-1",
      cacheablePrefixTokensEstimate: 4096,
      durationMs: 13,
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 5000,
      promptCacheDiagnostics: {
        scope: "scope-1",
        status: "changed",
        changed: ["requestPrefixHash4096"],
        current: promptCacheDiagnosticCurrent("swarm:key"),
        cachedInputTokens: 0,
        totalInputWithCacheTokens: 5000,
        cacheHitRate: 0,
        minimumCacheableTokens: 1024
      }
    }
  ]);

  assert.equal(trend.source, "provider_usage");
  assert.equal(trend.calls, 3);
  assert.equal(trend.cacheableCalls, 3);
  assert.equal(trend.hitCalls, 1);
  assert.equal(trend.missCalls, 1);
  assert.equal(trend.warmingCalls, 1);
  assert.equal(trend.cachedInputTokens, 2400);
  assert.equal(trend.totalInputWithCacheTokens, 12000);
  assert.equal(trend.uncachedInputTokens, 9600);
  assert.equal(trend.hitRate, 0.2);
  assert.deepEqual(trend.diagnostics, { changed: 1, new_scope: 1, stable: 1 });
  assert.deepEqual(trend.changed, ["requestPrefixHash4096"]);

  const detail = formatPromptCacheDetailWithTrend(trend.latest, trend);
  assert.match(detail, /Trend/);
  assert.match(detail, /calls=3 cacheable=3 hit=1 miss=1 warming=1/);
  assert.match(detail, /diagnostics=changed:1, new_scope:1, stable:1/);
});

test("prompt cache helper explains provider-threshold bypass", () => {
  const status = promptCacheStatusFromUsage({
    providerId: "gemini",
    protocol: "google-gemini",
    model: "gemini-pro",
    purpose: "main_coding_loop",
    sessionId: "session-cache",
    taskId: "turn-4",
    cacheMode: "prefix-structured",
    promptCacheKey: "swarm:key",
    promptCacheScope: "scope-small",
    cacheablePrefixTokensEstimate: 256,
    durationMs: 12,
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 1200,
    promptCacheDiagnostics: {
      scope: "scope-small",
      status: "expected_empty_cache",
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
        model: "gemini-pro",
        protocol: "google-gemini",
        retention: "in_memory",
        ttlSeconds: 3600,
        anthropicTtl: "5m"
      },
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 1200,
      cacheHitRate: 0,
      minimumCacheableTokens: 1024
    }
  });

  assert.equal(status.outcome, "bypass");
  assert.match(status.reason ?? "", /below provider threshold/);
  assert.match(formatPromptCacheDetail(status), /cacheable prefix is below provider threshold/);
});

function promptCacheDiagnosticCurrent(cacheKey: string) {
  return {
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
    cacheKey,
    model: "deepseek-v4-flash",
    protocol: "openai-chat-completions" as const,
    retention: "in_memory" as const,
    ttlSeconds: 3600,
    anthropicTtl: "5m" as const
  };
}
