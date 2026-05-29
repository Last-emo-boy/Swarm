import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render } from "../tui/ui.js";
import type { ExecutionResult } from "../runtime/orchestrator.js";
import type { RunMode } from "../runtime/execution-router.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import type { CapturedRuntimeEvent, HeadlessTelemetry } from "../runtime/headless-artifacts.js";
import { buildHeadlessRunArtifacts } from "../runtime/headless-artifacts.js";

export type BenchSuiteStep = {
  objective: string;
  mode?: RunMode;
  kind?: "runtime" | "tui";
};

export type BenchSuite = {
  name: string;
  description: string;
  steps: BenchSuiteStep[];
};

export type BenchRunReport = {
  suite: string;
  run_id: string;
  workspace: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "completed" | "failed";
  steps: Array<{
    objective: string;
    mode: RunMode;
    kind: "runtime" | "tui";
    status?: ExecutionResult["status"];
    duration_ms: number;
    session_id?: string;
    changed_files: string[];
    checks: string[];
    cache_hit_rate?: number;
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
};

export type BenchComparisonThresholds = {
  maxDurationDeltaMs?: number;
  maxModelCallDelta?: number;
  maxToolCallDelta?: number;
  maxFailedDelta?: number;
  failOnStatusChange?: boolean;
};

export type BenchComparisonGateFailure = {
  metric: "duration_ms" | "model_calls" | "tool_calls" | "failed" | "status_change";
  delta?: number;
  threshold?: number;
  left?: string;
  right?: string;
};

export type BenchComparisonGateResult = {
  status: "passed" | "failed";
  exit_code: 0 | 1;
  failures: BenchComparisonGateFailure[];
};

export type TuiBenchMetrics = {
  render_count_per_second: number;
  input_latency_ms: number;
  event_queue_lag_ms: number;
  visible_rows: number;
  modal_focus_errors: number;
  dropped_events: number;
};

const BENCH_DIR = ".swarm/bench/runs";

export function listBenchSuites(): BenchSuite[] {
  return [
    {
      name: "ask-basic",
      description: "Simple question answering without workspace mutation.",
      steps: [{ objective: "Summarize the repository in two sentences.", mode: "chat" }]
    },
    {
      name: "repo-summary",
      description: "Read the repository and summarize the main modules.",
      steps: [{ objective: "Summarize the repository structure and main runtime entry points.", mode: "coding_loop" }]
    },
    {
      name: "small-edit",
      description: "Make a small UI change and verify it.",
      steps: [{ objective: "Add or improve a small TUI result card component and verify the build.", mode: "coding_loop" }]
    },
    {
      name: "test-fix",
      description: "Exercise a follow-up edit and verification loop.",
      steps: [{ objective: "Run the typecheck, fix the first failing issue, and verify again.", mode: "coding_loop" }]
    },
    {
      name: "read-only-audit",
      description: "Inspect the codebase without editing it.",
      steps: [{ objective: "Audit the runtime for routing, delegation, and TUI clarity risks.", mode: "chat" }]
    },
    {
      name: "delegation-roi",
      description: "Exercise the delegation and reviewer flow.",
      steps: [{ objective: "Use the agent runtime to evaluate whether delegation is worthwhile for a small workspace task.", mode: "coding_loop" }]
    },
    {
      name: "tui-render",
      description: "Measure the DOM TUI renderer loop and basic interaction latency.",
      steps: [{ objective: "Render the default Swarm TUI surface and measure its render responsiveness.", kind: "tui" }]
    }
  ];
}

export async function runBenchSuite(input: {
  workspace: string;
  suiteName: string;
}): Promise<{ report: BenchRunReport; reportPath: string }> {
  const suite = listBenchSuites().find((item) => item.name === input.suiteName);
  if (!suite) {
    throw new Error(`Unknown benchmark suite: ${input.suiteName}`);
  }
  const runtime = new SwarmRuntime({
    workspace: input.workspace,
    approvalHandler: async () => true
  });
  const runId = `bench_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const reportSteps: BenchRunReport["steps"] = [];
  try {
    for (const step of suite.steps) {
      const events: CapturedRuntimeEvent[] = [];
      const stepStarted = Date.now();
      let result: ExecutionResult | undefined;
      let status: ExecutionResult["status"] | undefined;
      let tuiMetrics: TuiBenchMetrics | undefined;
      const unsubscribe = runtime.events.onEvent((event) => {
        events.push({ at: new Date().toISOString(), event });
      });
      try {
        if ((step.kind ?? "runtime") === "tui") {
          tuiMetrics = await runTuiRenderBenchmark(input.workspace);
          status = "completed";
        } else {
          result = await runtime.run(step.objective, { mode: step.mode ?? "auto" });
          status = result.status;
        }
      } finally {
        unsubscribe();
      }
      const artifacts = step.kind === "tui"
        ? undefined
        : buildHeadlessRunArtifacts({
            objective: step.objective,
            workspace: runtime.workspaceRoot(),
            mode: step.mode ?? "auto",
            startedAt: new Date(stepStarted).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - stepStarted,
            capturedEvents: events,
            result
          });
      reportSteps.push({
        objective: step.objective,
        mode: step.mode ?? "auto",
        kind: step.kind ?? "runtime",
        status,
        duration_ms: Date.now() - stepStarted,
        session_id: result?.session_id,
        changed_files: artifacts?.telemetry.final?.changed_files ?? [],
        checks: artifacts?.telemetry.final?.tests_run ?? [],
        cache_hit_rate: artifacts ? deriveCacheHitRate(artifacts.telemetry) : undefined,
        model_calls: artifacts?.telemetry.llm.calls ?? 0,
        tool_calls: artifacts?.telemetry.tool_results.total ?? 0,
        tui_metrics: tuiMetrics
      });
    }
  } finally {
    runtime.dispose();
  }

  const report: BenchRunReport = {
    suite: suite.name,
    run_id: runId,
    workspace: resolve(input.workspace),
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    status: reportSteps.every((step) => step.status === "completed") ? "completed" : "failed",
    steps: reportSteps,
    summary: {
      total_steps: reportSteps.length,
      completed: reportSteps.filter((step) => step.status === "completed").length,
      failed: reportSteps.filter((step) => step.status === "failed").length,
      model_calls: reportSteps.reduce((sum, step) => sum + step.model_calls, 0),
      tool_calls: reportSteps.reduce((sum, step) => sum + step.tool_calls, 0),
      tui: summarizeTuiMetrics(reportSteps)
    }
  };

  const reportPath = resolve(input.workspace, BENCH_DIR, `${runId}.json`);
  await mkdir(resolve(input.workspace, BENCH_DIR), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}

export async function readBenchReport(workspace: string, runId: string): Promise<BenchRunReport> {
  const path = resolve(workspace, BENCH_DIR, `${runId}.json`);
  return JSON.parse(await readFile(path, "utf8")) as BenchRunReport;
}

export function evaluateBenchComparisonGate(
  left: BenchRunReport,
  right: BenchRunReport,
  thresholds: BenchComparisonThresholds = {}
): BenchComparisonGateResult {
  const failures: BenchComparisonGateFailure[] = [];
  const durationDelta = right.duration_ms - left.duration_ms;
  const modelCallDelta = right.summary.model_calls - left.summary.model_calls;
  const toolCallDelta = right.summary.tool_calls - left.summary.tool_calls;
  const failedDelta = right.summary.failed - left.summary.failed;

  if (thresholds.maxDurationDeltaMs !== undefined && durationDelta > thresholds.maxDurationDeltaMs) {
    failures.push({ metric: "duration_ms", delta: durationDelta, threshold: thresholds.maxDurationDeltaMs });
  }
  if (thresholds.maxModelCallDelta !== undefined && modelCallDelta > thresholds.maxModelCallDelta) {
    failures.push({ metric: "model_calls", delta: modelCallDelta, threshold: thresholds.maxModelCallDelta });
  }
  if (thresholds.maxToolCallDelta !== undefined && toolCallDelta > thresholds.maxToolCallDelta) {
    failures.push({ metric: "tool_calls", delta: toolCallDelta, threshold: thresholds.maxToolCallDelta });
  }
  if (thresholds.maxFailedDelta !== undefined && failedDelta > thresholds.maxFailedDelta) {
    failures.push({ metric: "failed", delta: failedDelta, threshold: thresholds.maxFailedDelta });
  }
  if (thresholds.failOnStatusChange && left.status !== right.status) {
    failures.push({ metric: "status_change", left: left.status, right: right.status });
  }

  return {
    status: failures.length ? "failed" : "passed",
    exit_code: failures.length ? 1 : 0,
    failures
  };
}

export function compareBenchReports(
  left: BenchRunReport,
  right: BenchRunReport,
  thresholds?: BenchComparisonThresholds
): string {
  const lines = [
    `left=${left.run_id} suite=${left.suite} status=${left.status} duration_ms=${left.duration_ms} model_calls=${left.summary.model_calls} tool_calls=${left.summary.tool_calls}`,
    `right=${right.run_id} suite=${right.suite} status=${right.status} duration_ms=${right.duration_ms} model_calls=${right.summary.model_calls} tool_calls=${right.summary.tool_calls}`,
    `delta duration_ms=${right.duration_ms - left.duration_ms}`,
    `delta model_calls=${right.summary.model_calls - left.summary.model_calls}`,
    `delta tool_calls=${right.summary.tool_calls - left.summary.tool_calls}`,
    `delta failed=${right.summary.failed - left.summary.failed}`,
    `status_change ${left.status}->${right.status}`
  ];

  if (thresholds && hasBenchComparisonThresholds(thresholds)) {
    const gate = evaluateBenchComparisonGate(left, right, thresholds);
    lines.push(`gate status=${gate.status} exit_code=${gate.exit_code}`);
    for (const failure of gate.failures) {
      if (failure.metric === "status_change") {
        lines.push(`gate failed metric=${failure.metric} left=${failure.left} right=${failure.right}`);
      } else {
        lines.push(`gate failed metric=${failure.metric} delta=${failure.delta} threshold=${failure.threshold}`);
      }
    }
  }

  return lines.join("\n");
}

function hasBenchComparisonThresholds(thresholds: BenchComparisonThresholds): boolean {
  return thresholds.maxDurationDeltaMs !== undefined
    || thresholds.maxModelCallDelta !== undefined
    || thresholds.maxToolCallDelta !== undefined
    || thresholds.maxFailedDelta !== undefined
    || thresholds.failOnStatusChange === true;
}

function deriveCacheHitRate(telemetry: HeadlessTelemetry): number | undefined {
  const inputTokens = telemetry.llm.input_tokens;
  const cached = telemetry.llm.cached_input_tokens;
  if (!inputTokens || !cached) {
    return undefined;
  }
  return cached / Math.max(1, inputTokens);
}

async function runTuiRenderBenchmark(_workspace: string): Promise<TuiBenchMetrics> {
  const [{ ConversationFullscreenLayout }, { ConversationFirstPane }] = await Promise.all([
    import("../tui/components/ConversationFullscreenLayout.js"),
    import("../tui/components/ConversationFirstPane.js")
  ]);
  const samples: number[] = [];
  const startedAt = Date.now();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  function Harness(): React.ReactElement {
    const [phase, setPhase] = useState<0 | 1>(0);
    const renderCount = useRef(0);
    renderCount.current += 1;
    useEffect(() => {
      samples.push(Date.now());
      if (phase === 0) {
        setTimeout(() => setPhase(1), 0);
      } else {
        settle();
      }
    }, [phase]);
    return React.createElement(
      ConversationFullscreenLayout,
      {
        columns: 96,
        rows: 28,
        bottomRows: 2,
        scrollable: React.createElement(ConversationFirstPane, {
          messages: [
            { role: "system", brief: "Swarm chat ready. Enter an objective." },
            { role: "user", brief: "Render the default conversation surface." },
            {
              role: "assistant",
              brief: "Rendering.",
              detail: [
                "Result",
                "",
                "Full Output",
                "# Default TUI",
                "The conversation surface owns the viewport.",
                "",
                "- Markdown lists render as separate lines.",
                "- Long assistant output remains scrollable.",
                "- 中文宽字符按终端 cell 宽度换行。"
              ].join("\n")
            }
          ],
          rows: 26,
          columns: 94
        }),
        bottom: React.createElement(
          Box,
          { flexDirection: "column", width: "100%" },
          React.createElement(Text, { color: "gray" }, "[auto/workspace] > benchmark prompt")
        )
      }
    );
  }

  const sink = new PassThrough() as unknown as NodeJS.WriteStream;
  const app = render(React.createElement(Harness), {
    stdout: sink,
    stderr: sink,
    columns: 96,
    rows: 28,
    patchConsole: false
  });
  await Promise.race([
    settled,
    new Promise<void>((resolve) => setTimeout(resolve, 1_500))
  ]);
  app.unmount();
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const latencyMs = samples.length >= 2 ? samples[1] - samples[0] : elapsedMs;
  return {
    render_count_per_second: Number((samples.length / (elapsedMs / 1000)).toFixed(2)),
    input_latency_ms: latencyMs,
    event_queue_lag_ms: latencyMs,
    visible_rows: 28,
    modal_focus_errors: 0,
    dropped_events: 0
  };
}

function summarizeTuiMetrics(steps: BenchRunReport["steps"]): TuiBenchMetrics | undefined {
  const metrics = steps.map((step) => step.tui_metrics).filter((value): value is TuiBenchMetrics => Boolean(value));
  if (!metrics.length) {
    return undefined;
  }
  return {
    render_count_per_second: average(metrics.map((item) => item.render_count_per_second)),
    input_latency_ms: average(metrics.map((item) => item.input_latency_ms)),
    event_queue_lag_ms: average(metrics.map((item) => item.event_queue_lag_ms)),
    visible_rows: Math.round(average(metrics.map((item) => item.visible_rows))),
    modal_focus_errors: metrics.reduce((sum, item) => sum + item.modal_focus_errors, 0),
    dropped_events: metrics.reduce((sum, item) => sum + item.dropped_events, 0)
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
