import {
  evaluatePromptCacheSlo,
  promptCacheTrendFromStatuses,
  type PromptCacheSloEvaluation,
  type PromptCacheSloThresholds,
  type PromptCacheTrend,
  type ResultCardPromptCacheStatus
} from "../runtime/prompt-cache-status.js";

export type RealSwarmEvalScenarioKind =
  | "bugfix"
  | "feature"
  | "refactor"
  | "conflict"
  | "handoff"
  | "symphony_intake"
  | "lsp_fallback"
  | "cache_reuse";

export type RealSwarmEvalProviderMode = "fake-provider" | "real-provider";

export type RealSwarmEvalFailureCategory =
  | "quality"
  | "protocol"
  | "cache"
  | "lsp"
  | "handoff"
  | "provider";

export type RealSwarmEvalQualityVerdict = "pass" | "warning" | "fail";

export type RealSwarmEvalTestStatus = "pass" | "fail" | "skipped";

export type RealSwarmEvalTestEvidence = {
  name: string;
  status: RealSwarmEvalTestStatus;
  category?: RealSwarmEvalFailureCategory;
  detail?: string;
};

export type RealSwarmEvalConflictResolution = {
  required: boolean;
  resolved?: boolean;
  detail?: string;
};

export type RealSwarmEvalLspFallback = {
  required: boolean;
  used?: boolean;
  detail?: string;
};

export type RealSwarmEvalSymphonyIntake = {
  required: boolean;
  accepted?: boolean;
  workItems?: number;
  detail?: string;
};

export type RealSwarmEvalCacheMetrics = {
  source: PromptCacheTrend["source"];
  status: PromptCacheSloEvaluation["status"];
  state: PromptCacheSloEvaluation["state"];
  calls: number;
  hitCalls: number;
  missCalls: number;
  warmingCalls: number;
  readTokens: number;
  writeTokens: number;
  cacheableTokens: number;
  hitRate?: number;
  writeRate?: number;
  failures: string[];
};

export type RealSwarmEvalScenarioFixture = {
  id: string;
  kind: RealSwarmEvalScenarioKind;
  name: string;
  objective: string;
  quality: {
    verdict: RealSwarmEvalQualityVerdict;
    reason: string;
  };
  tests: RealSwarmEvalTestEvidence[];
  cache: ResultCardPromptCacheStatus[];
  cacheThresholds?: PromptCacheSloThresholds;
  handoffCount: number;
  expectedHandoffCount?: number;
  conflictResolution?: RealSwarmEvalConflictResolution;
  lspFallback?: RealSwarmEvalLspFallback;
  symphonyIntake?: RealSwarmEvalSymphonyIntake;
  protocolTraceOk?: boolean;
  latencyMs: number;
  maxLatencyMs?: number;
  providerRetries: number;
  maxProviderRetries?: number;
  providerError?: string;
  notes?: string[];
};

export type RealSwarmEvalScenarioResult = {
  schema_version: "swarm.real_swarm_eval.scenario.v1";
  id: string;
  kind: RealSwarmEvalScenarioKind;
  name: string;
  objective: string;
  providerMode: RealSwarmEvalProviderMode;
  status: "pass" | "fail";
  quality: RealSwarmEvalScenarioFixture["quality"];
  tests: RealSwarmEvalTestEvidence[];
  cache: RealSwarmEvalCacheMetrics;
  handoffCount: number;
  conflictResolution: RealSwarmEvalConflictResolution;
  lspFallback: RealSwarmEvalLspFallback;
  symphonyIntake: RealSwarmEvalSymphonyIntake;
  latencyMs: number;
  providerRetries: number;
  failureCategories: RealSwarmEvalFailureCategory[];
  notes: string[];
};

export type RealSwarmEvalSuiteReport = {
  schema_version: "swarm.real_swarm_eval_suite.v1";
  providerMode: RealSwarmEvalProviderMode;
  status: "pass" | "fail";
  scenarios: RealSwarmEvalScenarioResult[];
  failureCategories: RealSwarmEvalFailureCategory[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    quality: Record<RealSwarmEvalQualityVerdict, number>;
    cache: {
      calls: number;
      hitCalls: number;
      missCalls: number;
      readTokens: number;
      writeTokens: number;
      cacheableTokens: number;
      hitRate?: number;
      writeRate?: number;
    };
    handoffCount: number;
    conflictScenarios: number;
    conflictsResolved: number;
    lspFallbackScenarios: number;
    lspFallbacksUsed: number;
    latencyMs: {
      max: number;
      average: number;
    };
    providerRetries: number;
  };
  releaseGate: {
    status: "pass" | "fail";
    blockingCategories: RealSwarmEvalFailureCategory[];
    reason: string;
  };
  optionalRealProviderDogfood: RealSwarmRealProviderDogfoodPlan;
};

export type RealSwarmRealProviderDogfoodPlan = {
  schema_version: "swarm.real_swarm_provider_dogfood_plan.v1";
  defaultEnabled: false;
  requiredEnv: string[];
  command: string;
  scenarios: RealSwarmEvalScenarioKind[];
  note: string;
};

const REAL_SWARM_SCENARIO_KINDS: RealSwarmEvalScenarioKind[] = [
  "bugfix",
  "feature",
  "refactor",
  "conflict",
  "handoff",
  "symphony_intake",
  "lsp_fallback",
  "cache_reuse"
];

export function runOfflineRealSwarmEvalSuite(
  fixtures: RealSwarmEvalScenarioFixture[] = defaultRealSwarmEvalFixtures()
): RealSwarmEvalSuiteReport {
  return runRealSwarmEvalSuite(fixtures, "fake-provider");
}

export function runRealProviderDogfoodEvalSuite(fixtures: RealSwarmEvalScenarioFixture[]): RealSwarmEvalSuiteReport {
  return runRealSwarmEvalSuite(fixtures, "real-provider");
}

export function buildRealProviderDogfoodEvalPlan(): RealSwarmRealProviderDogfoodPlan {
  return {
    schema_version: "swarm.real_swarm_provider_dogfood_plan.v1",
    defaultEnabled: false,
    requiredEnv: ["OPENAI_API_KEY"],
    command: "node dist/evals/local-evals.js --real-swarm --provider real",
    scenarios: REAL_SWARM_SCENARIO_KINDS,
    note: "Optional dogfood uses the same suite contract but is never required by the default release gate."
  };
}

export function runRealSwarmEvalSuite(
  fixtures: RealSwarmEvalScenarioFixture[],
  providerMode: RealSwarmEvalProviderMode
): RealSwarmEvalSuiteReport {
  const scenarios = fixtures.map((fixture) => evaluateRealSwarmScenario(fixture, providerMode));
  const failureCategories = uniqueCategories(scenarios.flatMap((scenario) => scenario.failureCategories));
  const passed = scenarios.filter((scenario) => scenario.status === "pass").length;
  const summary = summarizeRealSwarmScenarios(scenarios);
  const status = failureCategories.length || passed !== scenarios.length ? "fail" : "pass";
  return {
    schema_version: "swarm.real_swarm_eval_suite.v1",
    providerMode,
    status,
    scenarios,
    failureCategories,
    summary,
    releaseGate: {
      status,
      blockingCategories: failureCategories,
      reason: status === "pass"
        ? "offline real swarm scenarios cover collaboration quality, cache reuse, handoff, LSP fallback, Symphony intake, latency, and provider retry evidence"
        : `real swarm suite failed categories: ${failureCategories.join(", ")}`
    },
    optionalRealProviderDogfood: buildRealProviderDogfoodEvalPlan()
  };
}

export function evaluateRealSwarmScenario(
  fixture: RealSwarmEvalScenarioFixture,
  providerMode: RealSwarmEvalProviderMode = "fake-provider"
): RealSwarmEvalScenarioResult {
  const trend = promptCacheTrendFromStatuses(fixture.cache, "provider_usage");
  const cacheGate = evaluatePromptCacheSlo(trend, {
    requireTrend: true,
    minCalls: 1,
    minHitRate: 0,
    maxProviderUsageMissingCalls: 0,
    ...fixture.cacheThresholds
  });
  const conflictResolution = fixture.conflictResolution ?? { required: false };
  const lspFallback = fixture.lspFallback ?? { required: false };
  const symphonyIntake = fixture.symphonyIntake ?? { required: false };
  const failureCategories = uniqueCategories([
    fixture.quality.verdict === "fail" ? "quality" : undefined,
    ...fixture.tests
      .filter((test) => test.status === "fail")
      .map((test) => test.category ?? "quality"),
    cacheGate.status === "fail" ? "cache" : undefined,
    fixture.protocolTraceOk === false ? "protocol" : undefined,
    fixture.handoffCount < (fixture.expectedHandoffCount ?? 0) ? "handoff" : undefined,
    conflictResolution.required && conflictResolution.resolved !== true ? "handoff" : undefined,
    lspFallback.required && lspFallback.used !== true ? "lsp" : undefined,
    symphonyIntake.required && symphonyIntake.accepted !== true ? "protocol" : undefined,
    symphonyIntake.required && (symphonyIntake.workItems ?? 0) <= 0 ? "protocol" : undefined,
    fixture.providerError || fixture.providerRetries > (fixture.maxProviderRetries ?? 2) ? "provider" : undefined,
    fixture.latencyMs > (fixture.maxLatencyMs ?? 30_000) ? "provider" : undefined
  ]);
  return {
    schema_version: "swarm.real_swarm_eval.scenario.v1",
    id: fixture.id,
    kind: fixture.kind,
    name: fixture.name,
    objective: fixture.objective,
    providerMode,
    status: failureCategories.length ? "fail" : "pass",
    quality: fixture.quality,
    tests: fixture.tests,
    cache: cacheMetricsFromGate(trend, cacheGate),
    handoffCount: fixture.handoffCount,
    conflictResolution,
    lspFallback,
    symphonyIntake,
    latencyMs: fixture.latencyMs,
    providerRetries: fixture.providerRetries,
    failureCategories,
    notes: fixture.notes ?? []
  };
}

export function realSwarmEvalReleaseGateStatus(report: RealSwarmEvalSuiteReport): "pass" | "fail" {
  return report.releaseGate.status;
}

export function realSwarmEvalScenarioKinds(): RealSwarmEvalScenarioKind[] {
  return [...REAL_SWARM_SCENARIO_KINDS];
}

export function formatRealSwarmEvalSuite(report: RealSwarmEvalSuiteReport): string[] {
  return [
    "Real Swarm Eval Suite",
    `status=${report.status} provider=${report.providerMode} scenarios=${report.summary.total} passed=${report.summary.passed} failed=${report.summary.failed}`,
    `coverage=${report.scenarios.map((scenario) => scenario.kind).join(",")}`,
    `cache_calls=${report.summary.cache.calls} cache_hit=${report.summary.cache.hitCalls} cache_read_tokens=${report.summary.cache.readTokens} cache_write_tokens=${report.summary.cache.writeTokens} cache_hit_rate=${formatRate(report.summary.cache.hitRate)}`,
    `handoffs=${report.summary.handoffCount} conflicts=${report.summary.conflictsResolved}/${report.summary.conflictScenarios} lsp_fallback=${report.summary.lspFallbacksUsed}/${report.summary.lspFallbackScenarios} latency_max_ms=${report.summary.latencyMs.max} provider_retries=${report.summary.providerRetries}`,
    `release_gate=${report.releaseGate.status} blocking=${report.releaseGate.blockingCategories.join(",") || "none"}`,
    ...report.scenarios.map(formatRealSwarmScenario)
  ];
}

export function defaultRealSwarmEvalFixtures(): RealSwarmEvalScenarioFixture[] {
  return [
    {
      id: "real-swarm-bugfix",
      kind: "bugfix",
      name: "cart total bugfix with verifier handoff",
      objective: "Fix a regression in a shared cart total helper with implementer and verifier agents.",
      quality: { verdict: "pass", reason: "patch is scoped, verified, and leaves a result-card trail" },
      tests: [
        { name: "cart total unit test", status: "pass", category: "quality" },
        { name: "verifier reviewed changed helper", status: "pass", category: "handoff" }
      ],
      cache: [
        cacheStatus("bugfix", "new_scope", 0, 520, 5200, "warming"),
        cacheStatus("bugfix", "cache_hit", 4200, 0, 5200, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.35 },
      handoffCount: 1,
      expectedHandoffCount: 1,
      protocolTraceOk: true,
      latencyMs: 4200,
      providerRetries: 0
    },
    {
      id: "real-swarm-feature",
      kind: "feature",
      name: "feature slice with planner executor reviewer",
      objective: "Add a small command surface using planner, executor, and reviewer roles.",
      quality: { verdict: "pass", reason: "feature output includes tests, review notes, and no broad refactor" },
      tests: [
        { name: "feature contract test", status: "pass", category: "quality" },
        { name: "review warning budget", status: "pass", category: "handoff" }
      ],
      cache: [
        cacheStatus("feature", "cache_hit", 3900, 0, 5800, "hit"),
        cacheStatus("feature", "cache_hit", 4100, 0, 5900, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.55 },
      handoffCount: 2,
      expectedHandoffCount: 2,
      protocolTraceOk: true,
      latencyMs: 6100,
      providerRetries: 1,
      notes: ["fake-provider retry is recorded as recovered telemetry"]
    },
    {
      id: "real-swarm-refactor",
      kind: "refactor",
      name: "shared helper refactor with unchanged behavior",
      objective: "Refactor repeated helper logic while preserving public behavior.",
      quality: { verdict: "pass", reason: "behavior-preserving tests and diff summary agree" },
      tests: [
        { name: "golden behavior test", status: "pass", category: "quality" },
        { name: "diff summary has no unrelated files", status: "pass", category: "protocol" }
      ],
      cache: [
        cacheStatus("refactor", "cache_hit", 4600, 0, 6200, "hit"),
        cacheStatus("refactor", "cache_hit", 4700, 0, 6200, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.7 },
      handoffCount: 1,
      expectedHandoffCount: 1,
      protocolTraceOk: true,
      latencyMs: 5300,
      providerRetries: 0
    },
    {
      id: "real-swarm-conflict",
      kind: "conflict",
      name: "parallel edit conflict arbitration",
      objective: "Detect overlapping edits from two agents and preserve the accepted resolution.",
      quality: { verdict: "pass", reason: "conflict was resolved with explicit owner evidence" },
      tests: [
        { name: "conflict marker absent", status: "pass", category: "handoff" },
        { name: "accepted patch still passes tests", status: "pass", category: "quality" }
      ],
      cache: [
        cacheStatus("conflict", "cache_hit", 3600, 0, 5600, "hit"),
        cacheStatus("conflict", "cache_hit", 3800, 0, 5600, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.6 },
      handoffCount: 3,
      expectedHandoffCount: 2,
      conflictResolution: {
        required: true,
        resolved: true,
        detail: "owner vote selected executor patch, reviewer verified merged output"
      },
      protocolTraceOk: true,
      latencyMs: 8200,
      providerRetries: 0
    },
    {
      id: "real-swarm-handoff",
      kind: "handoff",
      name: "planner to specialist handoff",
      objective: "Route work from the planner to a specialist and back to a verifier.",
      quality: { verdict: "pass", reason: "handoff envelope preserves objective, files, and verification result" },
      tests: [
        { name: "handoff envelope has task packet", status: "pass", category: "handoff" },
        { name: "verifier receives final artifact", status: "pass", category: "protocol" }
      ],
      cache: [
        cacheStatus("handoff", "cache_hit", 3300, 0, 5000, "hit"),
        cacheStatus("handoff", "cache_hit", 3400, 0, 5000, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.6 },
      handoffCount: 2,
      expectedHandoffCount: 2,
      protocolTraceOk: true,
      latencyMs: 4800,
      providerRetries: 0
    },
    {
      id: "real-swarm-symphony-intake",
      kind: "symphony_intake",
      name: "Symphony intake creates work items",
      objective: "Convert a Symphony intake request into visible swarm work items.",
      quality: { verdict: "pass", reason: "intake is accepted and produces auditable work item metadata" },
      tests: [
        { name: "intake accepted", status: "pass", category: "protocol" },
        { name: "work item visible in control plane", status: "pass", category: "protocol" }
      ],
      cache: [
        cacheStatus("symphony", "cache_hit", 3100, 0, 5100, "hit"),
        cacheStatus("symphony", "cache_hit", 3200, 0, 5100, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.55 },
      handoffCount: 1,
      expectedHandoffCount: 1,
      symphonyIntake: {
        required: true,
        accepted: true,
        workItems: 2,
        detail: "daemon intake created planner and verifier work items"
      },
      protocolTraceOk: true,
      latencyMs: 5700,
      providerRetries: 1
    },
    {
      id: "real-swarm-lsp-fallback",
      kind: "lsp_fallback",
      name: "semantic tooling fallback remains useful",
      objective: "Run a coding task when LSP is unavailable and preserve semantic fallback evidence.",
      quality: { verdict: "pass", reason: "fallback evidence is cited without turning semantic loss into provider failure" },
      tests: [
        { name: "fallback symbols recorded", status: "pass", category: "lsp" },
        { name: "semantic evidence attached to result", status: "pass", category: "lsp" }
      ],
      cache: [
        cacheStatus("lsp", "cache_hit", 3500, 0, 5400, "hit"),
        cacheStatus("lsp", "cache_hit", 3600, 0, 5400, "hit")
      ],
      cacheThresholds: { minCalls: 2, minHitRate: 0.6 },
      handoffCount: 1,
      expectedHandoffCount: 1,
      lspFallback: {
        required: true,
        used: true,
        detail: "semantic gateway emitted fallback evidence instead of blocking the task"
      },
      protocolTraceOk: true,
      latencyMs: 5000,
      providerRetries: 0
    },
    {
      id: "real-swarm-cache-reuse",
      kind: "cache_reuse",
      name: "stable prompt cache reuse across repeated swarm route",
      objective: "Replay the same swarm route with a volatile tail change and verify cache reads and writes.",
      quality: { verdict: "pass", reason: "cache hit is preserved while task-specific context remains dynamic" },
      tests: [
        { name: "cache write captured on warmup", status: "pass", category: "cache" },
        { name: "cache read captured on replay", status: "pass", category: "cache" }
      ],
      cache: [
        cacheStatus("cache-reuse", "new_scope", 0, 5600, 6400, "warming"),
        cacheStatus("cache-reuse", "cache_hit", 5700, 0, 6400, "hit"),
        cacheStatus("cache-reuse", "cache_hit", 5800, 0, 6400, "hit")
      ],
      cacheThresholds: { minCalls: 3, minHitRate: 0.55, maxChangedPrefixMisses: 0 },
      handoffCount: 1,
      expectedHandoffCount: 1,
      protocolTraceOk: true,
      latencyMs: 3900,
      providerRetries: 0,
      notes: ["warmup writes and replay reads are both expected in offline fake-provider mode"]
    }
  ];
}

function cacheStatus(
  scope: string,
  status: ResultCardPromptCacheStatus["status"],
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  totalInputWithCacheTokens: number,
  outcome: NonNullable<ResultCardPromptCacheStatus["outcome"]>
): ResultCardPromptCacheStatus {
  return {
    status,
    cacheMode: "enabled",
    providerId: "fake-provider",
    model: "fake-swarm-eval",
    purpose: `real-swarm-${scope}`,
    promptCacheKey: `real-swarm:${scope}:stable-prefix`,
    promptCacheScope: scope,
    cachedInputTokens,
    cacheCreationInputTokens,
    totalInputWithCacheTokens,
    cacheablePrefixTokensEstimate: Math.max(cachedInputTokens, cacheCreationInputTokens, 4096),
    hitRate: totalInputWithCacheTokens > 0 ? cachedInputTokens / totalInputWithCacheTokens : undefined,
    writeRate: totalInputWithCacheTokens > 0 ? cacheCreationInputTokens / totalInputWithCacheTokens : undefined,
    outcome,
    reason: outcome === "hit"
      ? "stable swarm route prefix reused"
      : "first call warms the stable swarm route prefix"
  };
}

function cacheMetricsFromGate(trend: PromptCacheTrend, gate: PromptCacheSloEvaluation): RealSwarmEvalCacheMetrics {
  return {
    source: trend.source,
    status: gate.status,
    state: gate.state,
    calls: trend.calls,
    hitCalls: trend.hitCalls,
    missCalls: trend.missCalls,
    warmingCalls: trend.warmingCalls,
    readTokens: trend.cachedInputTokens,
    writeTokens: trend.cacheCreationInputTokens,
    cacheableTokens: trend.totalInputWithCacheTokens,
    hitRate: trend.hitRate,
    writeRate: trend.writeRate,
    failures: gate.failures
  };
}

function summarizeRealSwarmScenarios(scenarios: RealSwarmEvalScenarioResult[]): RealSwarmEvalSuiteReport["summary"] {
  const quality: Record<RealSwarmEvalQualityVerdict, number> = { pass: 0, warning: 0, fail: 0 };
  let cacheCalls = 0;
  let cacheHitCalls = 0;
  let cacheMissCalls = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheableTokens = 0;
  let handoffCount = 0;
  let conflictScenarios = 0;
  let conflictsResolved = 0;
  let lspFallbackScenarios = 0;
  let lspFallbacksUsed = 0;
  let latencyTotal = 0;
  let latencyMax = 0;
  let providerRetries = 0;

  for (const scenario of scenarios) {
    quality[scenario.quality.verdict] += 1;
    cacheCalls += scenario.cache.calls;
    cacheHitCalls += scenario.cache.hitCalls;
    cacheMissCalls += scenario.cache.missCalls;
    cacheReadTokens += scenario.cache.readTokens;
    cacheWriteTokens += scenario.cache.writeTokens;
    cacheableTokens += scenario.cache.cacheableTokens;
    handoffCount += scenario.handoffCount;
    if (scenario.conflictResolution.required) {
      conflictScenarios += 1;
      if (scenario.conflictResolution.resolved) conflictsResolved += 1;
    }
    if (scenario.lspFallback.required) {
      lspFallbackScenarios += 1;
      if (scenario.lspFallback.used) lspFallbacksUsed += 1;
    }
    latencyTotal += scenario.latencyMs;
    latencyMax = Math.max(latencyMax, scenario.latencyMs);
    providerRetries += scenario.providerRetries;
  }

  return {
    total: scenarios.length,
    passed: scenarios.filter((scenario) => scenario.status === "pass").length,
    failed: scenarios.filter((scenario) => scenario.status === "fail").length,
    quality,
    cache: {
      calls: cacheCalls,
      hitCalls: cacheHitCalls,
      missCalls: cacheMissCalls,
      readTokens: cacheReadTokens,
      writeTokens: cacheWriteTokens,
      cacheableTokens,
      hitRate: cacheableTokens > 0 ? cacheReadTokens / cacheableTokens : undefined,
      writeRate: cacheableTokens > 0 ? cacheWriteTokens / cacheableTokens : undefined
    },
    handoffCount,
    conflictScenarios,
    conflictsResolved,
    lspFallbackScenarios,
    lspFallbacksUsed,
    latencyMs: {
      max: latencyMax,
      average: scenarios.length ? Math.round(latencyTotal / scenarios.length) : 0
    },
    providerRetries
  };
}

function formatRealSwarmScenario(scenario: RealSwarmEvalScenarioResult): string {
  return [
    `${scenario.kind}: ${scenario.status}`,
    `quality=${scenario.quality.verdict}`,
    `tests=${scenario.tests.filter((test) => test.status === "pass").length}/${scenario.tests.length}`,
    `cache_read=${scenario.cache.readTokens}`,
    `cache_write=${scenario.cache.writeTokens}`,
    `handoffs=${scenario.handoffCount}`,
    scenario.conflictResolution.required ? `conflict_resolved=${scenario.conflictResolution.resolved ? "yes" : "no"}` : "conflict_resolved=n/a",
    scenario.lspFallback.required ? `lsp_fallback=${scenario.lspFallback.used ? "yes" : "no"}` : "lsp_fallback=n/a",
    scenario.symphonyIntake.required ? `symphony_items=${scenario.symphonyIntake.workItems ?? 0}` : "symphony_items=n/a",
    `latency_ms=${scenario.latencyMs}`,
    `provider_retries=${scenario.providerRetries}`,
    `failures=${scenario.failureCategories.join(",") || "none"}`
  ].join(" ");
}

function uniqueCategories(categories: Array<RealSwarmEvalFailureCategory | undefined>): RealSwarmEvalFailureCategory[] {
  return [...new Set(categories.filter((category): category is RealSwarmEvalFailureCategory => Boolean(category)))].sort();
}

function formatRate(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
}
