import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSwarmContextCacheImpact,
  buildPromptCacheRoi,
  cacheFactFromStatus,
  evaluatePromptCacheSlo,
  formatPromptCacheBrief,
  formatPromptCacheDetail,
  formatPromptCacheDetailWithTrend,
  formatPromptCacheRoiInline,
  formatSwarmContextCacheImpact,
  formatPromptCacheInline,
  promptCacheTrendFromStatuses,
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
          changedSections: ["tools"],
          missReason: "changed_tools",
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
    assert.deepEqual(status.changedSections, ["tools"]);
    assert.equal(status.missReason, "changed_tools");
    const trend = runtime.getPromptCacheTrend();
    assert.equal(trend.source, "provider_usage");
    assert.equal(trend.calls, 1);
    assert.equal(trend.missCalls, 1);
    assert.equal(trend.cachedInputTokens, 3200);
    assert.deepEqual(trend.changedSections, ["tools"]);
    assert.deepEqual(trend.missReasons, { changed_tools: 1 });
    assert.equal(trend.normalizedMissReasons.prefix_drift, 1);
    assert.equal(trend.estimatedSavingsTokens, 3200);
    assert.match(trend.prefixIdentities[0] ?? "", /^pcx:[a-f0-9]{12}$/);
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
  assert.match(detail, /hit_tokens=100/);
  assert.match(detail, /estimated_savings_tokens=100/);
  assert.match(detail, /prefix_identity=pcx:[a-f0-9]{12}/);
  assert.match(detail, /outcome=miss/);
  assert.match(detail, /normalized_miss_reason=provider_omitted_usage/);
  assert.match(detail, /recommendation=/);
  assert.match(detail, /roi_saved_tokens=100/);
  assert.match(detail, /policy_recommendations=/);
  assert.doesNotMatch(detail, /key=swarm:key/);
  assert.doesNotMatch(detail, /scope=scope/);
  assert.doesNotMatch(detail, /"promptCacheKey"/);
  assert.doesNotMatch(detail, /"promptCacheScope"/);
  const inline = formatPromptCacheInline(resultCardCacheStatus(status));
  assert(inline);
  assert.match(inline, /cache:cache_miss hit 50%, write 25% miss reason provider_omitted_usage prefix pcx:[a-f0-9]{12} saved 100t miss 100t/);
  const roi = buildPromptCacheRoi(promptCacheTrendFromStatuses([status], "provider_usage"));
  assert.equal(formatPromptCacheRoiInline(roi), "saved 100t miss 100t stable 100% miss_reasons provider_omitted_usage:1 rec 1");
  assert.match(detail, /JSON/);
});

test("prompt cache facts normalize miss reasons and redact raw cache identity", () => {
  const changed = cacheFactFromStatus({
    status: "changed",
    outcome: "miss",
    providerId: "openai",
    model: "gpt-test",
    purpose: "main_coding_loop",
    cacheMode: "prefix-structured",
    promptCacheKey: "swarm:key",
    promptCacheScope: "scope",
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 2000,
    cacheCreationInputTokens: 100,
    cacheablePrefixTokensEstimate: 2048,
    changedSections: ["tools"],
    missReason: "changed_tools"
  });
  assert.equal(changed.hitTokens, 0);
  assert.equal(changed.missTokens, 2000);
  assert.equal(changed.writeTokens, 100);
  assert.equal(changed.cacheableTokens, 2000);
  assert.equal(changed.estimatedSavingsTokens, 0);
  assert.equal(changed.normalizedMissReason, "prefix_drift");
  assert.match(changed.prefixIdentity ?? "", /^pcx:[a-f0-9]{12}$/);

  assert.equal(cacheFactFromStatus({ status: "new_scope", outcome: "warming" }).normalizedMissReason, "cold_start");
  assert.equal(cacheFactFromStatus({ status: "expected_empty_cache", cacheMode: "prefix-structured", outcome: "bypass" }).normalizedMissReason, "provider_unsupported");
  assert.equal(cacheFactFromStatus({ status: "cache_miss", missReason: "provider_no_cache", outcome: "miss" }).normalizedMissReason, "provider_omitted_usage");
  assert.equal(cacheFactFromStatus({
    status: "expected_empty_cache",
    cacheMode: "prefix-structured",
    outcome: "bypass",
    cacheablePrefixTokensEstimate: 256,
    minimumCacheableTokens: 1024
  }).normalizedMissReason, "context_overflow");

  const detail = formatPromptCacheDetail({
    status: "changed",
    cacheMode: "prefix-structured",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "main_coding_loop",
    promptCacheKey: "swarm:key:sk-test1234567890",
    promptCacheScope: "scope:raw-user-prompt",
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 4096,
    changedSections: ["tools"],
    missReason: "changed_tools",
    diagnostics: "raw prompt sk-test1234567890 user prompt: do secret work"
  });
  assert.match(detail, /prefix_identity=pcx:[a-f0-9]{12}/);
  assert.doesNotMatch(detail, /sk-test1234567890/);
  assert.doesNotMatch(detail, /raw-user-prompt/);
  assert.doesNotMatch(detail, /user prompt: do secret work/);
  assert.doesNotMatch(detail, /key=/);
  assert.doesNotMatch(detail, /scope=/);
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
        changedSections: ["tools"],
        missReason: "changed_tools",
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
  assert.deepEqual(trend.changedSections, ["tools"]);
  assert.deepEqual(trend.missReasons, { changed_tools: 1 });
  assert.equal(trend.normalizedMissReasons.cold_start, 1);
  assert.equal(trend.normalizedMissReasons.prefix_drift, 1);
  assert.equal(trend.estimatedSavingsTokens, 2400);
  assert.match(trend.prefixIdentities[0] ?? "", /^pcx:[a-f0-9]{12}$/);

  const detail = formatPromptCacheDetailWithTrend(trend.latest, trend);
  assert.match(detail, /Trend/);
  assert.match(detail, /calls=3 cacheable=3 hit=1 miss=1 warming=1/);
  assert.match(detail, /miss_reason=changed_tools/);
  assert.match(detail, /changed_sections=tools/);
  assert.match(detail, /miss_reasons=changed_tools:1/);
  assert.match(detail, /normalized_miss_reasons=cold_start:1, prefix_drift:1/);
  assert.match(detail, /estimated_savings_tokens=2400/);
  assert.match(detail, /roi_saved_tokens=2400/);
  assert.match(detail, /policy_recommendations=/);
  assert.match(detail, /prefix_identities=pcx:[a-f0-9]{12}/);
  assert.match(detail, /diagnostics=changed:1, new_scope:1, stable:1/);
});

test("prompt cache helper formats section-level miss reasons", () => {
  const status = promptCacheStatusFromUsage({
    providerId: "openai",
    protocol: "openai-responses",
    model: "gpt-test",
    purpose: "main_coding_loop",
    sessionId: "session-cache-sections",
    taskId: "turn-5",
    cacheMode: "prefix-structured",
    promptCacheKey: "swarm:key",
    promptCacheScope: "scope-sections",
    cacheablePrefixTokensEstimate: 2048,
    durationMs: 12,
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 2000,
    promptCacheDiagnostics: {
      scope: "scope-sections",
      status: "changed",
      changed: ["requestPrefixHash4096"],
      changedSections: ["tools"],
      missReason: "changed_tools",
      current: promptCacheDiagnosticCurrent("swarm:key"),
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 2000,
      cacheHitRate: 0,
      minimumCacheableTokens: 1024
    }
  });

  assert.equal(status.outcome, "miss");
  assert.deepEqual(status.changedSections, ["tools"]);
  assert.equal(status.missReason, "changed_tools");
  assert.equal(status.diagnostics, "sections:tools");
  assert.match(status.reason ?? "", /stable prefix changed: tools/);
  assert.match(status.recommendation ?? "", /tool schemas/i);

  const detail = formatPromptCacheDetail(status);
  assert.match(detail, /miss_reason=changed_tools/);
  assert.match(detail, /normalized_miss_reason=prefix_drift/);
  assert.match(detail, /changed_sections=tools/);

  const inline = formatPromptCacheInline(resultCardCacheStatus(status));
  assert(inline);
  assert.match(inline, /reason changed_tools/);
  assert.match(inline, /normalized prefix_drift/);
  assert.match(inline, /sections tools/);
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

test("prompt cache SLO evaluation gates trend, hit rate, fallback, and changed-prefix regressions", () => {
  const stable = promptCacheTrendFromStatuses([
    {
      status: "stable",
      outcome: "hit",
      cachedInputTokens: 800,
      totalInputWithCacheTokens: 1000,
      cacheCreationInputTokens: 50
    }
  ], "provider_usage");
  const stableGate = evaluatePromptCacheSlo(stable, {
    requireTrend: true,
    minCalls: 1,
    minHitRate: 0.5,
    maxChangedPrefixMisses: 0,
    maxFallbackCalls: 0,
    maxProviderUsageMissingCalls: 0
  });

  assert.equal(stableGate.status, "pass");
  assert.equal(stableGate.state, "stable");
  assert.equal(stableGate.metrics.hitTokens, 800);
  assert.equal(stableGate.metrics.cacheableTokens, 1000);
  assert.equal(stableGate.metrics.writeTokens, 50);
  assert.equal(stableGate.metrics.estimatedSavingsTokens, 800);
  assert.match(stableGate.summary, /cache_slo=pass/);
  assert.match(stableGate.summary, /estimated_savings_tokens=800/);

  const changed = promptCacheTrendFromStatuses([
    {
      status: "changed",
      outcome: "miss",
      changed: ["requestPrefixHash4096"],
      changedSections: ["tools"],
      missReason: "changed_tools",
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 1000
    }
  ], "provider_usage");
  const changedGate = evaluatePromptCacheSlo(changed, {
    maxChangedPrefixMisses: 0,
    minHitRate: 0.1
  });

  assert.equal(changedGate.status, "fail");
  assert.equal(changedGate.state, "degraded");
  assert.equal(changedGate.metrics.changedPrefixMisses, 1);
  assert.deepEqual(changedGate.metrics.missReasons, { changed_tools: 1 });
  assert.equal(changedGate.metrics.normalizedMissReasons.prefix_drift, 1);
  assert(changedGate.failures.some((failure) => failure.includes("changed-prefix misses")));

  const fallback = promptCacheTrendFromStatuses([
    {
      status: "stable",
      outcome: "hit",
      cachedInputTokens: 100,
      totalInputWithCacheTokens: 200
    }
  ], "result_card_fallback");
  const fallbackGate = evaluatePromptCacheSlo(fallback, {
    maxFallbackCalls: 0,
    maxProviderUsageMissingCalls: 0
  });

  assert.equal(fallbackGate.status, "fail");
  assert.equal(fallbackGate.metrics.fallbackCalls, 1);
  assert.equal(fallbackGate.metrics.providerUsageMissingCalls, 1);
  assert(fallbackGate.failures.some((failure) => failure.includes("fallback cache calls")));
  assert(fallbackGate.failures.some((failure) => failure.includes("provider-usage missing")));

  const missingGate = evaluatePromptCacheSlo(promptCacheTrendFromStatuses([], "provider_usage"), {
    requireTrend: true
  });
  assert.equal(missingGate.status, "fail");
  assert.equal(missingGate.source, "none");
  assert(missingGate.failures.some((failure) => failure.includes("cache trend is missing")));
});

test("swarm cache impact keeps actor heartbeat and mailbox payload behind stable prefix", () => {
  const first = buildSwarmContextCacheImpact({
    stablePrefix: [
      { id: "system", kind: "system", content: "runtime protocol v1", tokens: 128 },
      { id: "tools", kind: "tool_schema", content: JSON.stringify(["Read", "Grep"]), tokens: 256 },
      { id: "workspace", kind: "shared_context", content: "repo summary", tokens: 512 },
      { id: "actor-heartbeat", kind: "actor_state", actorId: "worker-1", content: "status=idle turn=1", tokens: 32 },
      { id: "mailbox", kind: "mailbox", actorId: "worker-1", content: "message 1", tokens: 24 }
    ]
  });
  const second = buildSwarmContextCacheImpact({
    stablePrefix: [
      { id: "system", kind: "system", content: "runtime protocol v1", tokens: 128 },
      { id: "tools", kind: "tool_schema", content: JSON.stringify(["Read", "Grep"]), tokens: 256 },
      { id: "workspace", kind: "shared_context", content: "repo summary", tokens: 512 },
      { id: "actor-heartbeat", kind: "actor_state", actorId: "worker-1", content: "status=running turn=2", tokens: 32 },
      { id: "mailbox", kind: "mailbox", actorId: "worker-1", content: "message 2", tokens: 24 }
    ]
  });

  assert.equal(first.stable_prefix_hash, second.stable_prefix_hash);
  assert.notEqual(first.dynamic_hash, second.dynamic_hash);
  assert.notEqual(first.mailbox_hash, second.mailbox_hash);
  assert(first.dynamic_segments.some((segment) => segment.segment_id === "actor-heartbeat" && segment.kind === "actor_state"));
  assert(first.dynamic_segments.some((segment) => segment.segment_id === "mailbox" && segment.kind === "mailbox"));
  assert(!first.stable_segments.some((segment) => segment.kind === "actor_state" || segment.kind === "mailbox"));
});

test("swarm cache impact preserves protected objective and active task under context budget", () => {
  const impact = buildSwarmContextCacheImpact({
    stablePrefix: [
      { id: "system", kind: "system", content: "runtime protocol v1", tokens: 200 }
    ],
    dynamicContext: [
      { id: "user-objective", kind: "user_objective", content: "Fix the checkout total regression", tokens: 160 },
      { id: "active-task", kind: "active_task", content: "TASK-008 cache manager", tokens: 160 },
      { id: "large-mailbox", kind: "mailbox", content: "x".repeat(4000), tokens: 1000 },
      { id: "large-artifact", kind: "artifact_summary", content: "y".repeat(4000), tokens: 1000 }
    ],
    contextBudgetTokens: 500
  });

  assert.deepEqual(impact.protected_context_retained, ["active-task", "user-objective"]);
  assert(impact.dropped_context.includes("large-mailbox"));
  assert(impact.dropped_context.includes("large-artifact"));
  assert(impact.retained_context.includes("user-objective"));
  assert(impact.retained_context.includes("active-task"));
});

test("swarm cache impact formats changed actor context schema and mailbox reasons without raw prompt", () => {
  const impact = buildSwarmContextCacheImpact({
    stablePrefix: [
      { id: "tools", kind: "tool_schema", content: "secret tool schema sk-test1234567890", changed: true },
      { id: "workspace", kind: "shared_context", content: "workspace summary", changed: true }
    ],
    dynamicContext: [
      { id: "worker-state", kind: "actor_state", actorId: "worker-1", content: "heartbeat=2", changed: true },
      { id: "mailbox", kind: "mailbox", actorId: "worker-1", content: "deliver token=supersecret", changed: true }
    ],
    changedSections: ["tools", "context", "volatile_footer"],
    missReasons: ["changed_tools"]
  });
  const detail = formatSwarmContextCacheImpact(impact);

  assert(detail);
  assert.deepEqual(impact.changed_dimensions, ["actor", "context", "mailbox", "schema"]);
  assert.match(detail, /changed_dimensions=actor, context, mailbox, schema/);
  assert.match(detail, /tool schema changed before the cache boundary/);
  assert.match(detail, /mailbox payload should remain dynamic/);
  assert.match(detail, /actor_hashes=worker-1:sca:[a-f0-9]{12}/);
  assert.doesNotMatch(detail, /sk-test1234567890/);
  assert.doesNotMatch(detail, /supersecret/);
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
