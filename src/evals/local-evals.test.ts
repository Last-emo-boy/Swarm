import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildOfflineParityReleaseGate,
  runCacheLabReport,
  runParityReleaseGateEvals,
  runRealUsageRegressionEvals,
  runTuiReplayReport
} from "./local-evals.js";
import {
  evaluateRealSwarmScenario,
  formatRealSwarmEvalSuite,
  realSwarmEvalScenarioKinds,
  runOfflineRealSwarmEvalSuite,
  type RealSwarmEvalScenarioFixture
} from "./real-swarm-evals.js";

test("real usage regression evals run offline and cover status cache diagnosis and TUI detail gates", () => {
  const results = runRealUsageRegressionEvals();

  assert.deepEqual(results.map((result) => result.name), [
    "real-task replay eval preserves status, cache, and diagnosis evidence",
    "dogfood harness grades quality artifacts without failing low review warnings",
    "real swarm offline eval suite covers collaboration quality cache handoff LSP and provider gates",
    "protocol replay eval forces replay verdict",
    "fault injection drills recover through replay proof",
    "budget backpressure eval reports cost retry and pressure metrics",
    "provider fault eval surfaces retry recovery without secrets",
    "cache miss eval preserves fallback telemetry and miss reason",
    "cache SLO eval gates fallback, missing usage, and changed-prefix regressions",
    "cache lab replay distinguishes volatile tail from stable prefix drift",
    "TUI command-output detail eval blocks auto-open regression",
    "TUI interaction replay harness covers focus detail search fold and long-session budgets"
  ]);
  assert.deepEqual(results.map((result) => result.status), ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"]);
  assert(results.every((result) => !/provider credits|live provider|external model/i.test(result.message)));
});

test("Claude Code parity release gate runs offline and reports next task guidance", () => {
  const gate = buildOfflineParityReleaseGate();
  const results = runParityReleaseGateEvals();

  assert.equal(gate.schema_version, "swarm.parity_release_gate.v1");
  assert.equal(gate.profile, "offline_quick");
  assert.equal(gate.compared_to, "Claude Code");
  assert.equal(gate.status, "pass");
  assert.equal(gate.next_task, "CAND-PROD-054-TASK-001");
  assert.deepEqual(gate.dimensions.map((dimension) => dimension.id), [
    "interactive_trust",
    "coding_quality",
    "cache_yield",
    "provider_setup",
    "control_plane",
    "semantic_tooling",
    "artifact_debug_loop"
  ]);
  assert(gate.near_claude_code.some((item) => /coding loop/i.test(item)));
  assert(gate.gaps.some((item) => /Next cycle/i.test(item)));
  assert(gate.triage_queue.some((item) =>
    item.failed_dimension === "artifact_debug_loop" &&
    item.suspected_owner_files.includes("src/runtime/headless-artifacts.ts")
  ));
  assert(gate.red_lines.every((redLine) => redLine.status === "pass"));
  assert(gate.red_lines.some((redLine) => redLine.id === "true_swarm_eval_suite_passes"));
  assert(gate.dimensions.some((dimension) =>
    dimension.id === "control_plane" &&
    dimension.evidence.some((item) => item.includes("fault drills pass total=6"))
  ));
  assert(gate.dimensions.some((dimension) =>
    dimension.id === "control_plane" &&
    dimension.evidence.some((item) => item.includes("budget pressure exhausted"))
  ));
  assert.deepEqual(gate.dogfood.covered, ["TUI", "cache", "provider", "Gateway/Symphony", "LSP fallback", "artifacts", "true swarm evals"]);
  assert(gate.dogfood.artifact_kinds.includes("eval_summary"));
  assert(gate.commands.includes("npm run release:gate"));
  assert(gate.commands.includes("node dist/evals/local-evals.js --real-swarm"));
  assert(gate.commands.includes("node dist/evals/local-evals.js --tui-replay"));
  assert.deepEqual(results.map((result) => result.name), [
    "Claude Code parity release gate runs offline and emits scorecard evidence"
  ]);
  assert.deepEqual(results.map((result) => result.status), ["pass"]);
  assert(results.every((result) => !/provider credits|live provider|external model/i.test(result.message)));
});

test("real swarm eval suite covers fake-provider collaboration cache handoff conflict and LSP fallback", () => {
  const report = runOfflineRealSwarmEvalSuite();
  const text = formatRealSwarmEvalSuite(report).join("\n");
  const cacheReuse = report.scenarios.find((scenario) => scenario.kind === "cache_reuse");
  const conflict = report.scenarios.find((scenario) => scenario.kind === "conflict");
  const handoff = report.scenarios.find((scenario) => scenario.kind === "handoff");
  const lspFallback = report.scenarios.find((scenario) => scenario.kind === "lsp_fallback");
  const symphonyIntake = report.scenarios.find((scenario) => scenario.kind === "symphony_intake");

  assert.equal(report.schema_version, "swarm.real_swarm_eval_suite.v1");
  assert.equal(report.providerMode, "fake-provider");
  assert.equal(report.status, "pass");
  assert.deepEqual(report.scenarios.map((scenario) => scenario.kind), realSwarmEvalScenarioKinds());
  assert.equal(report.summary.total, 8);
  assert.equal(report.summary.failed, 0);
  assert.deepEqual(report.failureCategories, []);
  assert(report.summary.cache.hitCalls > 0);
  assert(report.summary.cache.readTokens > 0);
  assert(report.summary.cache.writeTokens > 0);
  assert((cacheReuse?.cache.hitCalls ?? 0) > 0);
  assert((cacheReuse?.cache.readTokens ?? 0) > 0);
  assert((cacheReuse?.cache.writeTokens ?? 0) > 0);
  assert((handoff?.handoffCount ?? 0) > 0);
  assert((conflict?.handoffCount ?? 0) > 0);
  assert.equal(conflict?.conflictResolution.resolved, true);
  assert.equal(lspFallback?.lspFallback.used, true);
  assert.equal(symphonyIntake?.symphonyIntake.accepted, true);
  assert((symphonyIntake?.symphonyIntake.workItems ?? 0) > 0);
  assert(report.summary.latencyMs.max > 0);
  assert(report.summary.providerRetries > 0);
  assert.equal(report.releaseGate.status, "pass");
  assert.equal(report.optionalRealProviderDogfood.defaultEnabled, false);
  assert.match(text, /release_gate=pass blocking=none/);
  assert.match(text, /provider_retries=/);
});

test("real swarm eval suite classifies degraded scenarios by quality protocol cache LSP handoff and provider", () => {
  const degradedFixture = {
    id: "degraded-real-swarm",
    kind: "conflict",
    name: "degraded conflict handoff",
    objective: "Exercise failure classification for a degraded swarm path.",
    quality: { verdict: "fail", reason: "output did not meet acceptance criteria" },
    tests: [
      { name: "protocol trace present", status: "fail", category: "protocol", detail: "missing correlation id" }
    ],
    cache: [],
    cacheThresholds: { requireTrend: true, minCalls: 1, minHitRate: 0.5 },
    handoffCount: 0,
    expectedHandoffCount: 1,
    conflictResolution: { required: true, resolved: false, detail: "overlap was not resolved" },
    lspFallback: { required: true, used: false, detail: "semantic fallback not recorded" },
    symphonyIntake: { required: true, accepted: false, workItems: 0, detail: "intake rejected" },
    protocolTraceOk: false,
    latencyMs: 45_000,
    maxLatencyMs: 1_000,
    providerRetries: 3,
    maxProviderRetries: 0,
    providerError: "provider 429"
  } satisfies RealSwarmEvalScenarioFixture;
  const scenario = evaluateRealSwarmScenario(degradedFixture);
  const report = runOfflineRealSwarmEvalSuite([degradedFixture]);

  assert.equal(scenario.status, "fail");
  assert.deepEqual(new Set(scenario.failureCategories), new Set(["quality", "protocol", "cache", "lsp", "handoff", "provider"]));
  assert.equal(report.status, "fail");
  assert.equal(report.releaseGate.status, "fail");
  assert.deepEqual(new Set(report.releaseGate.blockingCategories), new Set(["quality", "protocol", "cache", "lsp", "handoff", "provider"]));
});

test("cache lab report exposes best profile and quality-safe recommendation", () => {
  const lines = runCacheLabReport();
  const text = lines.join("\n");

  assert.match(text, /Cache Lab/);
  assert.match(text, /best_profile=volatile-tail-change/);
  assert.match(text, /top_hit_profile=volatile-tail-change/);
  assert.match(text, /quality_guard=.*quality-safe best profile/i);
  assert.match(text, /quality=warning/);
  assert.match(text, /quality=fail/);
  assert.match(text, /prefix drift/i);
  assert.match(text, /Prefer volatile-tail-change as the default profile/);
});

test("TUI replay report exposes deterministic trace summary for local evals", () => {
  const lines = runTuiReplayReport();
  const text = lines.join("\n");

  assert.match(text, /TUI Replay/);
  assert.match(text, /status=pass/);
  assert.match(text, /startup-enter-command-output-guard: pass/);
  assert.match(text, /debug-mode-trace-action-detail: pass/);
  assert.match(text, /cache-miss-detail-search-replay: pass/);
  assert.match(text, /lsp-fallback-detail-search-replay: pass/);
  assert.match(text, /long-session-search-scroll-fold-budget: pass/);
  assert.match(text, /final_focus=input/);
  assert.match(text, /mounted_max=/);
});
