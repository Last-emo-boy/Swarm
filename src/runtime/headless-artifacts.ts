import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunMode } from "./execution-router.js";
import type { RuntimeEvent, SessionOutcome } from "./events.js";
import type { ExecutionResult } from "./orchestrator.js";

const SWARM_VERSION = loadSwarmVersion();

export type CapturedRuntimeEvent = {
  at: string;
  event: RuntimeEvent;
};

export type HeadlessRunArtifacts = {
  report: HeadlessRunReport;
  telemetry: HeadlessTelemetry;
  trajectory: HeadlessTrajectory;
};

export type HeadlessRunReport = {
  schema_version: "swarm.headless.v1";
  swarm_version: string;
  objective: string;
  workspace: string;
  mode: RunMode;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "completed" | "failed" | "stopped";
  session_id?: string;
  result?: {
    content: string;
    artifact_path?: string;
    outcome?: SessionOutcome;
  };
  telemetry: HeadlessTelemetry;
  artifacts: {
    report_path?: string;
    telemetry_path?: string;
    trajectory_path?: string;
  };
  error?: {
    message: string;
  };
};

export type HeadlessTelemetry = {
  schema_version: "swarm.telemetry.v1";
  swarm_version: string;
  objective: string;
  workspace: string;
  mode: RunMode;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "completed" | "failed" | "stopped";
  session_id?: string;
  event_counts: Record<string, number>;
  tool_results: {
    total: number;
    success: number;
    partial: number;
    failed: number;
  };
  approvals: {
    total: number;
    pending: number;
    approved: number;
    denied: number;
  };
  workers: {
    spawned: number;
    completed: number;
    failed: number;
    stopped: number;
  };
  llm: {
    calls: number;
    providers: string[];
    models: string[];
    purposes: string[];
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_creation_input_tokens: number;
    cacheable_prefix_estimate: number;
    prompt_cache_diagnostics: Record<string, number>;
  };
  outcome?: SessionOutcome;
  final?: {
    content_bytes: number;
    content_lines: number;
    changed_files: string[];
    tests_run: string[];
    intermediate_artifacts: string[];
    final_summary?: string;
    artifact_path?: string;
  };
  error?: {
    message: string;
  };
};

export type HeadlessTrajectory = {
  schema_version: "ATIF-v1.7";
  session_id?: string;
  trajectory_id: string;
  agent: {
    name: string;
    version: string;
    model_name?: string;
    extra?: Record<string, unknown>;
  };
  steps: HeadlessTrajectoryStep[];
  notes?: string;
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_cost_usd?: number;
    total_steps?: number;
    extra?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
};

export type HeadlessTrajectoryStep = {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  model_name?: string;
  reasoning_effort?: string | number;
  message: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }>;
  observation?: {
    results: Array<{
      source_call_id?: string;
      content?: string;
      extra?: Record<string, unknown>;
    }>;
  };
  metrics?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    cost_usd?: number;
    extra?: Record<string, unknown>;
  };
  llm_call_count?: number;
  extra?: Record<string, unknown>;
};

export function buildHeadlessRunArtifacts(input: {
  objective: string;
  workspace: string;
  mode: RunMode;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  capturedEvents: CapturedRuntimeEvent[];
  result?: ExecutionResult;
  error?: Error;
  reportPath?: string;
  telemetryPath?: string;
  trajectoryPath?: string;
}): HeadlessRunArtifacts {
  const telemetry = buildHeadlessTelemetry(input);
  const trajectory = buildHeadlessTrajectory(input, telemetry);
  const report: HeadlessRunReport = {
    schema_version: "swarm.headless.v1",
    swarm_version: SWARM_VERSION,
    objective: input.objective,
    workspace: input.workspace,
    mode: input.mode,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: input.durationMs,
    status: input.result?.status ?? (input.error ? "failed" : "completed"),
    session_id: input.result?.session_id ?? extractSessionId(input.capturedEvents),
    telemetry,
    artifacts: {
      report_path: input.reportPath,
      telemetry_path: input.telemetryPath,
      trajectory_path: input.trajectoryPath
    }
  };

  if (input.result) {
    report.result = {
      content: input.result.content,
      artifact_path: input.result.artifact_path,
      outcome: input.result.outcome
    };
  }
  if (input.error) {
    report.error = { message: input.error.message };
  }

  return { report, telemetry, trajectory };
}

export function writeJsonArtifact(path: string, value: unknown): string {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(stripUndefined(value), null, 2)}\n`, "utf8");
  return absolute;
}

function buildHeadlessTelemetry(input: {
  objective: string;
  workspace: string;
  mode: RunMode;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  capturedEvents: CapturedRuntimeEvent[];
  result?: ExecutionResult;
  error?: Error;
}): HeadlessTelemetry {
  const eventCounts: Record<string, number> = {};
  const providerModels = new Set<string>();
  const providerIds = new Set<string>();
  const purposes = new Set<string>();
  const promptCacheDiagnostics: Record<string, number> = {};
  const usageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheablePrefixEstimate: 0
  };
  const toolResults = { total: 0, success: 0, partial: 0, failed: 0 };
  const approvals = { total: 0, pending: 0, approved: 0, denied: 0 };
  const workers = { spawned: 0, completed: 0, failed: 0, stopped: 0 };

  for (const captured of input.capturedEvents) {
    eventCounts[captured.event.type] = (eventCounts[captured.event.type] ?? 0) + 1;
    if (captured.event.type === "agent_spawn_decision") {
      workers.spawned += 1;
    } else if (captured.event.type === "agent_run_completed") {
      workers.completed += 1;
    } else if (captured.event.type === "worker") {
      if (captured.event.status === "failed") {
        workers.failed += 1;
      } else if (captured.event.status === "stopped") {
        workers.stopped += 1;
      }
    } else if (captured.event.type === "approval") {
      approvals.total += 1;
      approvals[captured.event.status] += 1;
    } else if (captured.event.type === "tool_result") {
      toolResults.total += 1;
      toolResults[captured.event.status ?? "success"] += 1;
    } else if (captured.event.type === "provider_usage") {
      const usage = captured.event.usage;
      usageTotals.calls += 1;
      if (usage.providerId) {
        providerIds.add(usage.providerId);
      }
      if (usage.model) {
        providerModels.add(usage.model);
      }
      if (usage.purpose) {
        purposes.add(usage.purpose);
      }
      usageTotals.inputTokens += usage.inputTokens ?? 0;
      usageTotals.outputTokens += usage.outputTokens ?? 0;
      usageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
      usageTotals.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
      usageTotals.cacheablePrefixEstimate += usage.cacheablePrefixTokensEstimate ?? 0;
      if (usage.promptCacheDiagnostics) {
        const status = usage.promptCacheDiagnostics.status;
        promptCacheDiagnostics[status] = (promptCacheDiagnostics[status] ?? 0) + 1;
      }
    }
  }

  const outcome = input.result?.outcome;
  const final = input.result ? {
    content_bytes: byteLength(input.result.content),
    content_lines: input.result.content.split(/\r?\n/).length,
    changed_files: outcome?.changed_files ?? [],
    tests_run: outcome?.tests_run ?? [],
    intermediate_artifacts: outcome?.intermediate_artifacts ?? [],
    final_summary: outcome?.final_summary,
    artifact_path: input.result.artifact_path
  } : undefined;

  return {
    schema_version: "swarm.telemetry.v1",
    swarm_version: SWARM_VERSION,
    objective: input.objective,
    workspace: input.workspace,
    mode: input.mode,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: input.durationMs,
    status: input.result?.status ?? (input.error ? "failed" : "completed"),
    session_id: input.result?.session_id ?? extractSessionId(input.capturedEvents),
    event_counts: eventCounts,
    tool_results: toolResults,
    approvals,
    workers,
    llm: {
      calls: usageTotals.calls,
      providers: [...providerIds].sort(),
      models: [...providerModels].sort(),
      purposes: [...purposes].sort(),
      input_tokens: usageTotals.inputTokens,
      output_tokens: usageTotals.outputTokens,
      cached_input_tokens: usageTotals.cachedInputTokens,
      cache_creation_input_tokens: usageTotals.cacheCreationInputTokens,
      cacheable_prefix_estimate: usageTotals.cacheablePrefixEstimate,
      prompt_cache_diagnostics: promptCacheDiagnostics
    },
    outcome: input.result?.outcome,
    final,
    error: input.error ? { message: input.error.message } : undefined
  };
}

function buildHeadlessTrajectory(input: {
  objective: string;
  workspace: string;
  mode: RunMode;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  capturedEvents: CapturedRuntimeEvent[];
  result?: ExecutionResult;
  error?: Error;
}, telemetry: HeadlessTelemetry): HeadlessTrajectory {
  const steps: HeadlessTrajectoryStep[] = [];
  let stepId = 1;
  steps.push({
    step_id: stepId++,
    timestamp: input.startedAt,
    source: "user",
    message: input.objective
  });

  const firstModel = findFirstModelName(input.capturedEvents);
  for (const captured of input.capturedEvents) {
    const timestamp = captured.at;
    const event = captured.event;
    if (event.type === "controller") {
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "system",
        message: `route ${event.action}: ${event.reason}`,
        extra: {
          confidence: event.confidence,
          instruction: event.instruction,
          details: event.details
        }
      });
      continue;
    }
    if (event.type === "agent_spawn_decision") {
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "system",
        message: `spawn ${event.worker_id} -> ${event.decision.agent_spec_id}/${event.decision.invocation_mode}`,
        extra: {
          confidence: event.decision.confidence,
          reason: event.decision.reason,
          display_name: event.decision.display_name,
          role_title: event.decision.role_title,
          objective: event.task_packet.objective,
          file_scope: event.task_packet.file_scope,
          allowed_tools: event.task_packet.allowed_tools
        }
      });
      continue;
    }
    if (event.type === "review_completed") {
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "system",
        message: `review ${event.result.verdict} (${event.result.score}) ${event.result.summary}`,
        extra: {
          review: event.result
        }
      });
      continue;
    }
    if (event.type === "verification_completed") {
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "system",
        message: `verify ${event.result.status}: ${event.result.summary}`,
        extra: {
          verification: event.result
        }
      });
      continue;
    }
    if (event.type === "tool_result") {
      const toolCallId = buildToolCallId(event);
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "agent",
        model_name: firstModel,
        message: event.summary || event.action,
        tool_calls: [{
          tool_call_id: toolCallId,
          function_name: event.action,
          arguments: {
            task_id: event.task_id,
            title: event.title,
            status: event.status,
            attempt: event.attempt,
            capability: event.capability
          },
          extra: {
            errorCode: event.errorCode,
            recoverySuggestion: event.recoverySuggestion,
            outputRef: event.outputRef
          }
        }],
        observation: {
          results: [{
            source_call_id: toolCallId,
            content: truncateText(event.content ?? event.summary, 20_000),
            extra: {
              status: event.status,
              errorCode: event.errorCode,
              recoverySuggestion: event.recoverySuggestion,
              outputRef: event.outputRef
            }
          }]
        },
        extra: {
          action: event.action,
          title: event.title,
          task_id: event.task_id,
          status: event.status,
          capability: event.capability
        }
      });
      continue;
    }
    if (event.type === "final") {
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "agent",
        model_name: firstModel,
        message: event.content,
        extra: {
          status: event.status ?? "completed",
          artifact_path: event.artifact_path,
          outcome: event.outcome
        }
      });
    }
  }

  if (input.error) {
    steps.push({
      step_id: stepId++,
      timestamp: input.endedAt,
      source: "system",
      message: `error: ${input.error.message}`
    });
  }

  const result = input.result;
  const usage = telemetry.llm;
  const outcome = result?.outcome;
  const totalCompletionTokens = usage.output_tokens || undefined;
  const totalPromptTokens = usage.input_tokens || undefined;
  const totalCachedTokens = usage.cached_input_tokens || undefined;

  return {
    schema_version: "ATIF-v1.7",
    session_id: result?.session_id ?? telemetry.session_id,
    trajectory_id: result?.session_id ?? telemetry.session_id ?? `swarm-${sanitizePart(input.objective).slice(0, 32)}-${Date.now()}`,
    agent: {
      name: "swarm",
      version: SWARM_VERSION,
      model_name: firstModel,
      extra: {
        mode: input.mode,
        workspace: input.workspace,
        swarm_version: SWARM_VERSION
      }
    },
    steps,
    notes: "Generated from Swarm CLI headless runtime events.",
    final_metrics: {
      total_prompt_tokens: totalPromptTokens,
      total_completion_tokens: totalCompletionTokens,
      total_cached_tokens: totalCachedTokens,
      total_steps: steps.length,
      extra: {
        tool_results: telemetry.tool_results,
        approvals: telemetry.approvals,
        workers: telemetry.workers,
        event_counts: telemetry.event_counts,
        result_status: result?.status ?? (input.error ? "failed" : "completed"),
        outcome
      }
    },
    extra: {
      mode: input.mode,
      objective: input.objective,
      workspace: input.workspace,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      duration_ms: input.durationMs
    }
  };
}

function buildToolCallId(event: Extract<RuntimeEvent, { type: "tool_result" }>): string {
  return sanitizePart([
    event.task_id,
    event.attempt ?? 0,
    event.action
  ].join(":"));
}

function extractSessionId(capturedEvents: CapturedRuntimeEvent[]): string | undefined {
  for (const captured of capturedEvents) {
    const event = captured.event;
    if (event.type === "session") {
      return event.session_id;
    }
    if (event.type === "final") {
      return event.session_id;
    }
    if (event.type === "tool_result" && event.session_id) {
      return event.session_id;
    }
    if (event.type === "provider_usage" && event.usage.sessionId) {
      return event.usage.sessionId;
    }
  }
  return undefined;
}

function findFirstModelName(capturedEvents: CapturedRuntimeEvent[]): string | undefined {
  for (const captured of capturedEvents) {
    if (captured.event.type === "provider_usage") {
      return captured.event.usage.model;
    }
  }
  return undefined;
}

export function loadSwarmVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function truncateText(value: string | undefined, maxBytes: number): string {
  const text = value ?? "";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return text;
  }
  const head = Math.floor(maxBytes * 0.7);
  const tail = Math.max(0, maxBytes - head);
  const buffer = Buffer.from(text, "utf8");
  return [
    buffer.subarray(0, head).toString("utf8").trimEnd(),
    "",
    `[... ${bytes - maxBytes} bytes omitted ...]`,
    "",
    buffer.subarray(Math.max(head, buffer.length - tail)).toString("utf8").trimStart()
  ].join("\n");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        continue;
      }
      output[key] = stripUndefined(item);
    }
    return output as T;
  }
  return value;
}
