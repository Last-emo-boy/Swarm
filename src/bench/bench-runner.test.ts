import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  compareBenchReports,
  evaluateBenchComparisonGate,
  listBenchSuites,
  readBenchReport,
  runBenchSuite,
  type BenchRunReport,
  type TuiBenchMetrics
} from "./bench-runner.js";

test("listBenchSuites exposes runtime and TUI observability suites", () => {
  const suites = listBenchSuites();
  const names = suites.map((suite) => suite.name);

  assert.ok(names.includes("ask-basic"));
  assert.ok(names.includes("repo-summary"));
  assert.ok(names.includes("tui-render"));
  assert.ok(suites.every((suite) => suite.description.length > 0));
  assert.ok(suites.every((suite) => suite.steps.length > 0));
  assert.equal(suites.find((suite) => suite.name === "tui-render")?.steps[0].kind, "tui");
});

test("compareBenchReports reports stable deltas without running suites", () => {
  const left = benchReport({
    runId: "bench_left",
    durationMs: 1000,
    modelCalls: 2,
    toolCalls: 3
  });
  const right = benchReport({
    runId: "bench_right",
    durationMs: 1300,
    modelCalls: 4,
    toolCalls: 5
  });

  const comparison = compareBenchReports(left, right);

  assert.match(comparison, /left=bench_left suite=ask-basic status=completed duration_ms=1000 model_calls=2 tool_calls=3/);
  assert.match(comparison, /right=bench_right suite=ask-basic status=completed duration_ms=1300 model_calls=4 tool_calls=5/);
  assert.match(comparison, /delta duration_ms=300/);
  assert.match(comparison, /delta model_calls=2/);
  assert.match(comparison, /delta tool_calls=2/);
  assert.match(comparison, /delta failed=0/);
  assert.match(comparison, /status_change completed->completed/);
});

test("compareBenchReports surfaces persisted baseline and candidate regression signals", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-compare-"));
  try {
    const baseline = benchReport({
      runId: "bench_baseline",
      durationMs: 1000,
      modelCalls: 2,
      toolCalls: 3
    });
    const candidate = benchReport({
      runId: "bench_candidate",
      durationMs: 1450,
      modelCalls: 5,
      toolCalls: 8,
      status: "failed",
      failed: 1,
      stepStatus: "failed"
    });

    await writeBenchReport(workspace, baseline);
    await writeBenchReport(workspace, candidate);

    const loadedBaseline = await readBenchReport(workspace, baseline.run_id);
    const loadedCandidate = await readBenchReport(workspace, candidate.run_id);
    const comparison = compareBenchReports(loadedBaseline, loadedCandidate);

    assert.deepEqual(loadedBaseline, baseline);
    assert.deepEqual(loadedCandidate, candidate);
    assert.match(comparison, /left=bench_baseline suite=ask-basic status=completed duration_ms=1000 model_calls=2 tool_calls=3/);
    assert.match(comparison, /right=bench_candidate suite=ask-basic status=failed duration_ms=1450 model_calls=5 tool_calls=8/);
    assert.match(comparison, /delta duration_ms=450/);
    assert.match(comparison, /delta model_calls=3/);
    assert.match(comparison, /delta tool_calls=5/);
    assert.match(comparison, /delta failed=1/);
    assert.match(comparison, /status_change completed->failed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("evaluateBenchComparisonGate passes when explicit thresholds are not exceeded", () => {
  const baseline = benchReport({
    runId: "bench_gate_pass_baseline",
    durationMs: 1000,
    modelCalls: 2,
    toolCalls: 3
  });
  const candidate = benchReport({
    runId: "bench_gate_pass_candidate",
    durationMs: 1200,
    modelCalls: 3,
    toolCalls: 4
  });

  const gate = evaluateBenchComparisonGate(baseline, candidate, {
    maxDurationDeltaMs: 250,
    maxModelCallDelta: 1,
    maxToolCallDelta: 1,
    maxFailedDelta: 0,
    failOnStatusChange: true
  });

  assert.equal(gate.status, "passed");
  assert.equal(gate.exit_code, 0);
  assert.deepEqual(gate.failures, []);
});

test("compareBenchReports appends deterministic threshold gate failures when requested", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-gate-"));
  try {
    const baseline = benchReport({
      runId: "bench_gate_baseline",
      durationMs: 1000,
      modelCalls: 2,
      toolCalls: 3
    });
    const candidate = benchReport({
      runId: "bench_gate_candidate",
      durationMs: 1500,
      modelCalls: 5,
      toolCalls: 9,
      status: "failed",
      failed: 1,
      stepStatus: "failed"
    });

    await writeBenchReport(workspace, baseline);
    await writeBenchReport(workspace, candidate);

    const loadedBaseline = await readBenchReport(workspace, baseline.run_id);
    const loadedCandidate = await readBenchReport(workspace, candidate.run_id);
    const gate = evaluateBenchComparisonGate(loadedBaseline, loadedCandidate, {
      maxDurationDeltaMs: 250,
      maxModelCallDelta: 1,
      maxToolCallDelta: 4,
      maxFailedDelta: 0,
      failOnStatusChange: true
    });
    const comparison = compareBenchReports(loadedBaseline, loadedCandidate, {
      maxDurationDeltaMs: 250,
      maxModelCallDelta: 1,
      maxToolCallDelta: 4,
      maxFailedDelta: 0,
      failOnStatusChange: true
    });

    assert.equal(gate.status, "failed");
    assert.equal(gate.exit_code, 1);
    assert.deepEqual(gate.failures.map((failure) => failure.metric), [
      "duration_ms",
      "model_calls",
      "tool_calls",
      "failed",
      "status_change"
    ]);
    assert.match(comparison, /delta duration_ms=500/);
    assert.match(comparison, /gate status=failed exit_code=1/);
    assert.match(comparison, /gate failed metric=duration_ms delta=500 threshold=250/);
    assert.match(comparison, /gate failed metric=model_calls delta=3 threshold=1/);
    assert.match(comparison, /gate failed metric=tool_calls delta=6 threshold=4/);
    assert.match(comparison, /gate failed metric=failed delta=1 threshold=0/);
    assert.match(comparison, /gate failed metric=status_change left=completed right=failed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runBenchSuite persists and reloads a deterministic TUI benchmark report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-"));
  try {
    const { report, reportPath } = await runBenchSuite({ workspace, suiteName: "tui-render" });
    const runsDir = resolve(workspace, ".swarm/bench/runs");
    const reportRelativeToRunsDir = relative(runsDir, reportPath);

    assert.ok(existsSync(reportPath), "benchmark report should be written to disk");
    assert.ok(reportRelativeToRunsDir.length > 0, "reportPath should point to a file below the benchmark runs dir");
    assert.ok(!reportRelativeToRunsDir.startsWith(".."), "reportPath should stay below the benchmark runs dir");
    assert.ok(!isAbsolute(reportRelativeToRunsDir), "reportPath should be relative to the benchmark runs dir");

    const loaded = await readBenchReport(workspace, report.run_id);
    assert.deepEqual(loaded, JSON.parse(JSON.stringify(report)) as BenchRunReport);
    assert.equal(loaded.suite, "tui-render");
    assert.equal(loaded.run_id, report.run_id);
    assert.equal(loaded.status, "completed");
    assert.equal(loaded.steps.length, 1);

    const [step] = loaded.steps;
    assert.equal(step.kind, "tui");
    assert.equal(step.status, "completed");
    assert.equal(step.model_calls, 0);
    assert.equal(step.tool_calls, 0);
    assertTuiMetrics(step.tui_metrics);

    assert.equal(loaded.summary.total_steps, 1);
    assert.equal(loaded.summary.completed, 1);
    assert.equal(loaded.summary.failed, 0);
    assert.equal(loaded.summary.model_calls, 0);
    assert.equal(loaded.summary.tool_calls, 0);
    assertTuiMetrics(loaded.summary.tui);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function benchReport(input: {
  runId: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  status?: BenchRunReport["status"];
  failed?: number;
  stepStatus?: NonNullable<BenchRunReport["steps"][number]["status"]>;
}): BenchRunReport {
  return {
    suite: "ask-basic",
    run_id: input.runId,
    workspace: "E:/Playground/Swarm",
    started_at: "2026-05-11T00:00:00.000Z",
    ended_at: "2026-05-11T00:00:01.000Z",
    duration_ms: input.durationMs,
    status: input.status ?? "completed",
    steps: [
      {
        objective: "Summarize the repository in two sentences.",
        mode: "chat",
        kind: "runtime",
        status: input.stepStatus ?? "completed",
        duration_ms: input.durationMs,
        changed_files: [],
        checks: [],
        model_calls: input.modelCalls,
        tool_calls: input.toolCalls
      }
    ],
    summary: {
      total_steps: 1,
      completed: input.stepStatus === "failed" ? 0 : 1,
      failed: input.failed ?? 0,
      model_calls: input.modelCalls,
      tool_calls: input.toolCalls
    }
  };
}

async function writeBenchReport(workspace: string, report: BenchRunReport): Promise<void> {
  const runsDir = resolve(workspace, ".swarm/bench/runs");
  await mkdir(runsDir, { recursive: true });
  await writeFile(resolve(runsDir, `${report.run_id}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function assertTuiMetrics(metrics: TuiBenchMetrics | undefined): asserts metrics is TuiBenchMetrics {
  assert.ok(metrics, "TUI benchmark metrics should be present");
  assert.equal(typeof metrics.render_count_per_second, "number");
  assert.equal(typeof metrics.input_latency_ms, "number");
  assert.equal(typeof metrics.event_queue_lag_ms, "number");
  assert.equal(typeof metrics.visible_rows, "number");
  assert.equal(typeof metrics.modal_focus_errors, "number");
  assert.equal(typeof metrics.dropped_events, "number");
}
