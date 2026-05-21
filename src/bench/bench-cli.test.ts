import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import type { BenchRunReport, TuiBenchMetrics } from "./bench-runner.js";

test("bench compare returns exit code 1 when explicit thresholds fail", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-"));
  try {
    const baseline = benchReport({
      runId: "bench_cli_baseline",
      durationMs: 1000,
      modelCalls: 2,
      toolCalls: 3
    });
    const candidate = benchReport({
      runId: "bench_cli_candidate",
      durationMs: 1500,
      modelCalls: 5,
      toolCalls: 9,
      status: "failed",
      failed: 1,
      stepStatus: "failed"
    });

    await writeBenchReport(workspace, baseline);
    await writeBenchReport(workspace, candidate);

    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "compare",
      baseline.run_id,
      candidate.run_id,
      "--workspace",
      workspace,
      "--max-duration-delta-ms",
      "250",
      "--max-model-call-delta",
      "1",
      "--max-tool-call-delta",
      "4",
      "--max-failed-delta",
      "0",
      "--fail-on-status-change"
    ]);

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /delta duration_ms=500/);
    assert.match(result.stdout, /gate status=failed exit_code=1/);
    assert.match(result.stdout, /gate failed metric=duration_ms delta=500 threshold=250/);
    assert.match(result.stdout, /gate failed metric=model_calls delta=3 threshold=1/);
    assert.match(result.stdout, /gate failed metric=tool_calls delta=6 threshold=4/);
    assert.match(result.stdout, /gate failed metric=failed delta=1 threshold=0/);
    assert.match(result.stdout, /gate failed metric=status_change left=completed right=failed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench compare returns exit code 0 when explicit thresholds pass", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-pass-"));
  try {
    const baseline = benchReport({
      runId: "bench_cli_pass_baseline",
      durationMs: 1000,
      modelCalls: 2,
      toolCalls: 3
    });
    const candidate = benchReport({
      runId: "bench_cli_pass_candidate",
      durationMs: 1200,
      modelCalls: 3,
      toolCalls: 4
    });

    await writeBenchReport(workspace, baseline);
    await writeBenchReport(workspace, candidate);

    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "compare",
      baseline.run_id,
      candidate.run_id,
      "--workspace",
      workspace,
      "--max-duration-delta-ms",
      "250",
      "--max-model-call-delta",
      "1",
      "--max-tool-call-delta",
      "1",
      "--max-failed-delta",
      "0",
      "--fail-on-status-change"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /gate status=passed exit_code=0/);
    assert.doesNotMatch(result.stdout, /gate failed metric=/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench compare returns stable product error for a missing left report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-compare-missing-left-"));
  try {
    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "compare",
      "missing-left",
      "missing-right",
      "--workspace",
      workspace
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Benchmark report not found: missing-left/);
    assert.match(result.stderr, /swarm bench run <suite>/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /node:internal/);
    assert.doesNotMatch(result.stderr, /bench-runner\.ts/);
    assert.doesNotMatch(result.stderr, /Node\.js/);
    assert.doesNotMatch(result.stdout, /left=/);
    assert.doesNotMatch(result.stdout, /right=/);
    assert.doesNotMatch(result.stdout, /delta/);
    assert.doesNotMatch(result.stdout, /gate status=passed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench compare returns stable product error for a missing right report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-compare-missing-right-"));
  try {
    const baseline = benchReport({
      runId: "existing-left",
      durationMs: 1000,
      modelCalls: 2,
      toolCalls: 3
    });
    await writeBenchReport(workspace, baseline);

    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "compare",
      baseline.run_id,
      "missing-right",
      "--workspace",
      workspace
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Benchmark report not found: missing-right/);
    assert.match(result.stderr, /swarm bench run <suite>/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /node:internal/);
    assert.doesNotMatch(result.stderr, /bench-runner\.ts/);
    assert.doesNotMatch(result.stderr, /Node\.js/);
    assert.doesNotMatch(result.stdout, /left=/);
    assert.doesNotMatch(result.stdout, /right=/);
    assert.doesNotMatch(result.stdout, /delta/);
    assert.doesNotMatch(result.stdout, /gate status=passed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench compare returns stable product errors for invalid threshold values", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-invalid-threshold-"));
  try {
    const cases = [
      {
        flag: "--max-duration-delta-ms",
        value: "-1",
        stderr: "Invalid --max-duration-delta-ms: -1. Expected a non-negative number."
      },
      {
        flag: "--max-model-call-delta",
        value: "many",
        stderr: "Invalid --max-model-call-delta: many. Expected a non-negative number."
      }
    ];

    for (const item of cases) {
      const result = await runCli([
        "--import",
        "tsx",
        "src/index.ts",
        "bench",
        "compare",
        "missing-left",
        "missing-right",
        "--workspace",
        workspace,
        item.flag,
        item.value
      ]);

      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), item.stderr);
      assert.doesNotMatch(result.stdout, /left=/);
      assert.doesNotMatch(result.stdout, /right=/);
      assert.doesNotMatch(result.stdout, /delta/);
      assert.doesNotMatch(result.stdout, /gate status=passed/);
      assert.doesNotMatch(result.stderr, /Benchmark report not found/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
      assert.doesNotMatch(result.stderr, /src[\\/]index\.ts/);
      assert.doesNotMatch(result.stderr, /node:internal/);
      assert.doesNotMatch(result.stderr, /Node\.js/);
      assert.doesNotMatch(result.stderr, /OPENAI_API_KEY|API key|provider readiness|model readiness|No provider/i);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench list run and report expose tui-render benchmark evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-evidence-"));
  try {
    const listResult = await runCli(["--import", "tsx", "src/index.ts", "bench", "list"]);
    assert.equal(listResult.code, 0, listResult.stderr);
    assert.equal(listResult.stderr, "");
    assert.match(listResult.stdout, /ask-basic/);
    assert.match(listResult.stdout, /tui-render/);

    const runResult = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "run",
      "tui-render",
      "--workspace",
      workspace
    ]);
    assert.equal(runResult.code, 0, runResult.stderr);
    assert.equal(runResult.stderr, "");

    const runOutput = JSON.parse(runResult.stdout) as {
      report: BenchRunReport;
      report_path: string;
    };
    const reportPath = resolve(runOutput.report_path);
    const runsDir = resolve(workspace, ".swarm/bench/runs");

    assert.ok(existsSync(reportPath), "report_path should exist on disk");
    assert.equal(runOutput.report.suite, "tui-render");
    assert.equal(runOutput.report.workspace, resolve(workspace));
    assert.equal(runOutput.report.status, "completed");
    assert.equal(runOutput.report.summary.total_steps, 1);
    assert.equal(runOutput.report.summary.completed, 1);
    assert.equal(runOutput.report.summary.failed, 0);
    assert.equal(runOutput.report.summary.model_calls, 0);
    assert.equal(runOutput.report.summary.tool_calls, 0);
    assertTuiMetrics(runOutput.report.summary.tui);

    assert.equal(runOutput.report.steps.length, 1);
    const [runStep] = runOutput.report.steps;
    assert.equal(runStep.kind, "tui");
    assert.equal(runStep.status, "completed");
    assert.equal(runStep.mode, "auto");
    assert.equal(runStep.model_calls, 0);
    assert.equal(runStep.tool_calls, 0);
    assertTuiMetrics(runStep.tui_metrics);

    const reportPathRelativeToRunsDir = relative(runsDir, reportPath);
    assert.ok(reportPathRelativeToRunsDir.length > 0);
    assert.ok(!reportPathRelativeToRunsDir.startsWith(".."));
    assert.ok(!isAbsolute(reportPathRelativeToRunsDir));

    const reportResult = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "report",
      runOutput.report.run_id,
      "--workspace",
      workspace
    ]);
    assert.equal(reportResult.code, 0, reportResult.stderr);
    assert.equal(reportResult.stderr, "");

    const reportOutput = JSON.parse(reportResult.stdout) as BenchRunReport;
    assert.deepEqual(projectBenchReport(reportOutput), projectBenchReport(runOutput.report));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench run returns stable product error for an unknown suite", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-unknown-"));
  try {
    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "run",
      "missing-suite",
      "--workspace",
      workspace
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown benchmark suite: missing-suite/);
    assert.match(result.stderr, /swarm bench list/);
    assert.doesNotMatch(result.stderr, /bench-runner\.ts/);
    assert.doesNotMatch(result.stderr, /Node\.js/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bench report returns stable product error for a missing report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-bench-cli-missing-report-"));
  try {
    const result = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "bench",
      "report",
      "missing-report",
      "--workspace",
      workspace
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Benchmark report not found: missing-report/);
    assert.match(result.stderr, /swarm bench run <suite>/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /node:internal/);
    assert.doesNotMatch(result.stderr, /bench-runner\.ts/);
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

function projectBenchReport(report: BenchRunReport): {
  suite: string;
  run_id: string;
  workspace: string;
  status: BenchRunReport["status"];
  steps: Array<{
    objective: string;
    mode: BenchRunReport["steps"][number]["mode"];
    kind: "runtime" | "tui";
    status?: BenchRunReport["steps"][number]["status"];
    changed_files: string[];
    checks: string[];
    model_calls: number;
    tool_calls: number;
    tui_metrics?: TuiBenchMetrics;
  }>;
  summary: {
    total_steps: number;
    completed: number;
    failed: number;
    model_calls: number;
    tool_calls: number;
    tui?: TuiBenchMetrics;
  };
} {
  return {
    suite: report.suite,
    run_id: report.run_id,
    workspace: report.workspace,
    status: report.status,
    steps: report.steps.map((step) => ({
      objective: step.objective,
      mode: step.mode,
      kind: step.kind,
      status: step.status,
      changed_files: step.changed_files,
      checks: step.checks,
      model_calls: step.model_calls,
      tool_calls: step.tool_calls,
      tui_metrics: step.tui_metrics
    })),
    summary: {
      total_steps: report.summary.total_steps,
      completed: report.summary.completed,
      failed: report.summary.failed,
      model_calls: report.summary.model_calls,
      tool_calls: report.summary.tool_calls,
      tui: report.summary.tui
    }
  };
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

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}
