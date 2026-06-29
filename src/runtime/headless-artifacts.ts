import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunMode, RunSandboxMode } from "./execution-router.js";
import type { RuntimeEvent, SessionOutcome } from "./events.js";
import type { ExecutionResult } from "./orchestrator.js";
import type { ResultCard } from "./result-card.js";
import type { ProviderUsageReport } from "../providers/openai-provider.js";
import {
  buildPromptCacheRoi,
  swarmCacheImpactFromUsage,
  evaluatePromptCacheSlo,
  promptCacheTrendFromResultCardCache,
  promptCacheTrendFromUsage,
  type CacheFact,
  type CacheMissReason,
  type CacheRoi,
  type SwarmCacheContextKind,
  type SwarmCacheImpactDimension,
  type SwarmContextCacheImpact,
  type SwarmContextCacheImpactSegment,
  type PromptCacheSloEvaluation,
  type PromptCacheTrend
} from "./prompt-cache-status.js";
import { redactSensitive } from "./recovery.js";
import { buildWorkRecordFromRuntimeEvent, buildWorkRunRecord, type WorkProtocolRecord } from "./work-protocol.js";
import { declaredToolTaskFileScope, declaredToolTaskWritePolicy } from "./tool-task-scope.js";
import { buildProtocolDebugTimeline, type ProtocolTimelineSummary } from "./protocol-debug-timeline.js";
import type { ProtocolReplayDiff } from "./protocol-replay.js";

const SWARM_VERSION = loadSwarmVersion();

export type HeadlessPermissionMode = "ask" | "auto-edit" | "full-auto" | "yolo";
export type HeadlessOperation = "run" | "resume" | "continue";
export type HeadlessRunBudget = {
  max_turns?: number;
  max_tool_calls?: number;
};
export type HeadlessToolPolicy = {
  allowed_tools?: string[];
  disallowed_tools?: string[];
};
export type HeadlessPromptCustomization = {
  system_prompt?: {
    source: "inline" | "file";
    bytes: number;
  };
  append_system_prompt?: {
    source: "inline" | "file";
    bytes: number;
  };
};
export type HeadlessMcpConfig = {
  strict?: boolean;
  sources: Array<{
    source: "file" | "json";
    path?: string;
    bytes: number;
    server_ids: string[];
  }>;
};
export type HeadlessResumePreflight = {
  command: "resume" | "continue";
  route: "stored_plan" | "coding_loop";
  instruction: string;
  detail: string;
};

export type CapturedRuntimeEvent = {
  at: string;
  event: RuntimeEvent;
};

export type HeadlessRunArtifacts = {
  report: HeadlessRunReport;
  telemetry: HeadlessTelemetry;
  trajectory: HeadlessTrajectory;
  artifactIndex: HeadlessArtifactIndex;
};

export type HeadlessArtifactKind =
  | "report"
  | "telemetry"
  | "trajectory"
  | "result"
  | "debug_log"
  | "eval_summary"
  | "stdout"
  | "stderr"
  | "diff_summary";

export type HeadlessArtifactIndex = {
  schema_version: "swarm.artifact-index.v1";
  session_id?: string;
  workspace: string;
  artifacts: Array<{
    kind: HeadlessArtifactKind;
    path: string;
  }>;
};

export type ParityReleaseGateDimensionId =
  | "interactive_trust"
  | "coding_quality"
  | "cache_yield"
  | "provider_setup"
  | "control_plane"
  | "semantic_tooling"
  | "artifact_debug_loop";

export type ParityReleaseGateStatus = "pass" | "fail";
export type ParityReleaseGateDimensionStatus = "pass" | "warning" | "fail";

export type ParityReleaseGateDimension = {
  id: ParityReleaseGateDimensionId;
  label: string;
  status: ParityReleaseGateDimensionStatus;
  score: number;
  reason: string;
  evidence: string[];
  gaps: string[];
  next_task?: string;
};

export type ParityReleaseGateRedLine = {
  id: string;
  status: ParityReleaseGateStatus;
  reason: string;
  evidence: string[];
  next_task?: string;
};

export type ParityReleaseGateTriageItem = {
  failed_dimension: ParityReleaseGateDimensionId | string;
  status: ParityReleaseGateDimensionStatus | ParityReleaseGateStatus;
  evidence_links: string[];
  suspected_owner_files: string[];
  next_task_suggestion: string;
};

export type ParityReleaseGateSummary = {
  schema_version: "swarm.parity_release_gate.v1";
  profile: "offline_quick" | "live_provider";
  compared_to: "Claude Code";
  status: ParityReleaseGateStatus;
  summary: string;
  pass_reasons: string[];
  fail_reasons: string[];
  near_claude_code: string[];
  gaps: string[];
  dimensions: ParityReleaseGateDimension[];
  red_lines: ParityReleaseGateRedLine[];
  triage_queue: ParityReleaseGateTriageItem[];
  dogfood: {
    covered: string[];
    artifact_kinds: string[];
    evidence: string[];
  };
  commands: string[];
  next_task?: string;
};

export type HeadlessStreamRecord =
  | {
      schema_version: "swarm.headless.stream.v1";
      type: "run_start";
      at: string;
      objective: string;
      workspace: string;
      mode: RunMode;
      permission_mode?: HeadlessPermissionMode;
      sandbox_mode?: RunSandboxMode;
      operation?: HeadlessOperation;
      resume_session_id?: string;
      resume_preflight?: HeadlessResumePreflight;
      budget?: HeadlessRunBudget;
      tool_policy?: HeadlessToolPolicy;
      additional_read_directories?: string[];
      prompt_customization?: HeadlessPromptCustomization;
      mcp_config?: HeadlessMcpConfig;
      activated_skills?: string[];
      work: WorkProtocolRecord;
    }
  | {
      schema_version: "swarm.headless.stream.v1";
      type: "runtime_event";
      at: string;
      event: RuntimeEvent;
      work: WorkProtocolRecord;
    }
  | {
      schema_version: "swarm.headless.stream.v1";
      type: "run_signal";
      at: string;
      signal: NodeJS.Signals;
      message: string;
      session_id?: string;
      resume_hint?: string;
      work: WorkProtocolRecord;
    }
  | {
      schema_version: "swarm.headless.stream.v1";
      type: "run_end";
      at: string;
      status: "completed" | "failed" | "stopped";
      session_id?: string;
      duration_ms: number;
      report: HeadlessRunReport;
      resume_hint?: string;
      work: WorkProtocolRecord;
    };

export type HeadlessRunReport = {
  schema_version: "swarm.headless.v1";
  swarm_version: string;
  objective: string;
  workspace: string;
  mode: RunMode;
  permission_mode?: HeadlessPermissionMode;
  sandbox_mode?: RunSandboxMode;
  operation?: HeadlessOperation;
  resume_session_id?: string;
  resume_preflight?: HeadlessResumePreflight;
  budget?: HeadlessRunBudget;
  tool_policy?: HeadlessToolPolicy;
  additional_read_directories?: string[];
  prompt_customization?: HeadlessPromptCustomization;
  mcp_config?: HeadlessMcpConfig;
  activated_skills?: string[];
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "completed" | "failed" | "stopped";
  session_id?: string;
  result?: {
    content: string;
    artifact_path?: string;
    outcome?: SessionOutcome;
    result_card?: ResultCard;
  };
  telemetry: HeadlessTelemetry;
  protocol_timeline?: ProtocolTimelineSummary;
  protocol_replay_diff?: ProtocolReplayDiff;
  artifacts: {
    report_path?: string;
    telemetry_path?: string;
    trajectory_path?: string;
    stdout_path?: string;
    stderr_path?: string;
    diff_summary_path?: string;
  };
  artifact_index?: HeadlessArtifactIndex;
  release_gate?: ParityReleaseGateSummary;
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
  permission_mode?: HeadlessPermissionMode;
  sandbox_mode?: RunSandboxMode;
  operation?: HeadlessOperation;
  resume_session_id?: string;
  budget?: HeadlessRunBudget;
  tool_policy?: HeadlessToolPolicy;
  additional_read_directories?: string[];
  prompt_customization?: HeadlessPromptCustomization;
  mcp_config?: HeadlessMcpConfig;
  activated_skills?: string[];
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
    uncached_input_tokens: number;
    total_input_with_cache_tokens: number;
    cache_hit_rate?: number;
    cache_write_rate?: number;
    cacheable_prefix_estimate: number;
    prompt_cache_diagnostics: Record<string, number>;
    cache_roi?: HeadlessPromptCacheRoi;
    cache_impact?: HeadlessPromptCacheImpact;
    cache_trend: HeadlessPromptCacheTrend;
    cache_slo: HeadlessPromptCacheSlo;
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
  protocol_replay_diff?: ProtocolReplayDiff;
  release_gate?: ParityReleaseGateSummary;
  error?: {
    message: string;
  };
};

export type HeadlessPromptCacheTrend = {
  source: PromptCacheTrend["source"];
  calls: number;
  cacheable_calls: number;
  hit_calls: number;
  miss_calls: number;
  warming_calls: number;
  bypass_calls: number;
  unknown_calls: number;
  hit_rate?: number;
  write_rate?: number;
  cached_input_tokens: number;
  total_input_with_cache_tokens: number;
  cache_creation_input_tokens: number;
  uncached_input_tokens: number;
  cacheable_prefix_tokens_estimate: number;
  estimated_savings_tokens: number;
  prefix_identities: string[];
  changed: string[];
  changed_sections: string[];
  miss_reasons: Record<string, number>;
  normalized_miss_reasons: Record<CacheMissReason, number>;
  facts: HeadlessPromptCacheFact[];
};

export type HeadlessPromptCacheRoi = {
  schema_version: CacheRoi["schema_version"];
  source: CacheRoi["source"];
  hit_tokens: number;
  miss_tokens: number;
  saved_tokens: number;
  estimated_saved_cost?: number;
  estimated_saved_cost_currency?: string;
  cost_source: CacheRoi["cost_source"];
  stable_prefix_ratio?: number;
  miss_reasons: Record<CacheMissReason, number>;
  policy_recommendations: string[];
};

export type HeadlessPromptCacheImpact = {
  schema_version: SwarmContextCacheImpact["schema_version"];
  stable_prefix_hash?: string;
  stable_prefix_tokens: number;
  dynamic_hash?: string;
  dynamic_tokens: number;
  tool_schema_hash?: string;
  mailbox_hash?: string;
  actor_hashes: Record<string, string>;
  context_hashes: Record<string, string>;
  changed_dimensions: SwarmCacheImpactDimension[];
  reasons: string[];
  recommendations: string[];
  retained_context: string[];
  dropped_context: string[];
  protected_context_retained: string[];
  stable_segments: HeadlessPromptCacheImpactSegment[];
  dynamic_segments: HeadlessPromptCacheImpactSegment[];
};

export type HeadlessPromptCacheImpactSegment = {
  segment_id: string;
  kind: SwarmCacheContextKind;
  phase: SwarmContextCacheImpactSegment["phase"];
  content_hash: string;
  tokens: number;
  retained: boolean;
  protected: boolean;
  changed: boolean;
  actor_id?: string;
  reason?: string;
};

export type HeadlessPromptCacheFact = {
  provider_id?: string;
  model?: string;
  purpose?: string;
  cache_mode?: string;
  status: string;
  outcome: CacheFact["outcome"];
  hit_tokens: number;
  miss_tokens: number;
  write_tokens: number;
  cacheable_tokens: number;
  cacheable_prefix_tokens_estimate: number;
  minimum_cacheable_tokens?: number;
  hit_rate?: number;
  write_rate?: number;
  estimated_savings_tokens: number;
  prefix_identity?: string;
  miss_reason?: string;
  normalized_miss_reason?: CacheMissReason;
  changed: string[];
  changed_sections: string[];
  reason?: string;
  recommendation?: string;
};

export type HeadlessPromptCacheSlo = {
  status: PromptCacheSloEvaluation["status"];
  state: PromptCacheSloEvaluation["state"];
  source: PromptCacheSloEvaluation["source"];
  summary: string;
  failures: string[];
  metrics: {
    calls: number;
    hit_tokens: number;
    cacheable_tokens: number;
    write_tokens: number;
    hit_rate?: number;
    changed_prefix_misses: number;
    fallback_calls: number;
    provider_usage_missing_calls: number;
    estimated_savings_tokens: number;
    unexplained_misses: number;
    unexplained_miss_rate?: number;
    min_cacheable_prefix_tokens?: number;
    prefix_identities: string[];
    normalized_miss_reasons: Record<CacheMissReason, number>;
    miss_reasons: Record<string, number>;
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
  permissionMode?: HeadlessPermissionMode;
  sandboxMode?: RunSandboxMode;
  operation?: HeadlessOperation;
  resumeSessionId?: string;
  resumePreflight?: HeadlessResumePreflight;
  budget?: HeadlessRunBudget;
  toolPolicy?: HeadlessToolPolicy;
  additionalReadDirectories?: string[];
  promptCustomization?: HeadlessPromptCustomization;
  mcpConfig?: HeadlessMcpConfig;
  activatedSkills?: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  capturedEvents: CapturedRuntimeEvent[];
  result?: ExecutionResult;
  error?: Error;
  reportPath?: string;
  telemetryPath?: string;
  trajectoryPath?: string;
  debugLogPath?: string;
  evalSummaryPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  diffSummaryPath?: string;
  protocolReplayDiff?: ProtocolReplayDiff;
  releaseGate?: ParityReleaseGateSummary;
}): HeadlessRunArtifacts {
  const telemetry = buildHeadlessTelemetry(input);
  const protocolTimeline = buildProtocolDebugTimeline({ capturedEvents: input.capturedEvents, limit: 50 });
  const trajectory = buildHeadlessTrajectory(input, telemetry);
  const artifactIndex = buildHeadlessArtifactIndex({
    sessionId: input.result?.session_id ?? extractSessionId(input.capturedEvents),
    workspace: input.workspace,
    reportPath: input.reportPath,
    telemetryPath: input.telemetryPath,
    trajectoryPath: input.trajectoryPath,
    resultArtifactPath: input.result?.artifact_path,
    debugLogPath: input.debugLogPath,
    evalSummaryPath: input.evalSummaryPath,
    stdoutPath: input.stdoutPath,
    stderrPath: input.stderrPath,
    diffSummaryPath: input.diffSummaryPath
  });
  const report: HeadlessRunReport = {
    schema_version: "swarm.headless.v1",
    swarm_version: SWARM_VERSION,
    objective: input.objective,
    workspace: input.workspace,
    mode: input.mode,
    permission_mode: input.permissionMode,
    sandbox_mode: input.sandboxMode,
    operation: input.operation,
    resume_session_id: input.resumeSessionId,
    resume_preflight: input.resumePreflight,
    budget: input.budget,
    tool_policy: input.toolPolicy,
    additional_read_directories: input.additionalReadDirectories,
    prompt_customization: input.promptCustomization,
    mcp_config: input.mcpConfig,
    activated_skills: input.activatedSkills,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: input.durationMs,
    status: input.result?.status ?? (input.error ? "failed" : "completed"),
    session_id: input.result?.session_id ?? extractSessionId(input.capturedEvents),
    telemetry,
    protocol_timeline: protocolTimeline,
    protocol_replay_diff: input.protocolReplayDiff,
    artifacts: {
      report_path: input.reportPath,
      telemetry_path: input.telemetryPath,
      trajectory_path: input.trajectoryPath,
      stdout_path: input.stdoutPath,
      stderr_path: input.stderrPath,
      diff_summary_path: input.diffSummaryPath
    },
    artifact_index: artifactIndex.artifacts.length ? artifactIndex : undefined,
    release_gate: input.releaseGate
  };

  if (input.result) {
    report.result = {
      content: input.result.content,
      artifact_path: input.result.artifact_path,
      outcome: input.result.outcome,
      result_card: input.result.result_card
    };
  }
  if (input.error) {
    report.error = { message: input.error.message };
  }

  return { report, telemetry, trajectory, artifactIndex };
}

export function buildHeadlessArtifactIndex(input: {
  sessionId?: string;
  workspace: string;
  reportPath?: string;
  telemetryPath?: string;
  trajectoryPath?: string;
  resultArtifactPath?: string;
  debugLogPath?: string;
  evalSummaryPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  diffSummaryPath?: string;
}): HeadlessArtifactIndex {
  return {
    schema_version: "swarm.artifact-index.v1",
    session_id: input.sessionId,
    workspace: normalizeArtifactPath(input.workspace),
    artifacts: uniqueArtifactEntries([
      artifactEntry("report", input.reportPath),
      artifactEntry("telemetry", input.telemetryPath),
      artifactEntry("trajectory", input.trajectoryPath),
      artifactEntry("result", input.resultArtifactPath),
      artifactEntry("debug_log", input.debugLogPath),
      artifactEntry("eval_summary", input.evalSummaryPath),
      artifactEntry("stdout", input.stdoutPath),
      artifactEntry("stderr", input.stderrPath),
      artifactEntry("diff_summary", input.diffSummaryPath)
    ])
  };
}

function artifactEntry(kind: HeadlessArtifactKind, path: string | undefined): HeadlessArtifactIndex["artifacts"][number] | undefined {
  if (!path) {
    return undefined;
  }
  return {
    kind,
    path: normalizeArtifactPath(path)
  };
}

function uniqueArtifactEntries(
  entries: Array<HeadlessArtifactIndex["artifacts"][number] | undefined>
): HeadlessArtifactIndex["artifacts"] {
  const seen = new Set<string>();
  const output: HeadlessArtifactIndex["artifacts"] = [];
  for (const entry of entries) {
    if (!entry?.path) {
      continue;
    }
    const key = `${entry.kind}\u0000${entry.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function normalizeArtifactPath(path: string): string {
  return redactSensitive(path).replace(/\\/g, "/");
}

export function buildHeadlessStreamRecord(
  input:
    | Omit<Extract<HeadlessStreamRecord, { type: "run_start" }>, "schema_version" | "work">
    | Omit<Extract<HeadlessStreamRecord, { type: "runtime_event" }>, "schema_version" | "work">
    | Omit<Extract<HeadlessStreamRecord, { type: "run_signal" }>, "schema_version" | "work">
    | Omit<Extract<HeadlessStreamRecord, { type: "run_end" }>, "schema_version" | "work">
): HeadlessStreamRecord {
  const record = {
    schema_version: "swarm.headless.stream.v1",
    ...input
  } as HeadlessStreamRecord;
  if (record.work) {
    return record;
  }
  return {
    ...record,
    work: buildWorkRecordForHeadlessStream(record)
  } as HeadlessStreamRecord;
}

export function headlessStreamJson(record: HeadlessStreamRecord): string {
  return JSON.stringify(stripUndefined(record));
}

function buildWorkRecordForHeadlessStream(record: HeadlessStreamRecord): WorkProtocolRecord {
  if (record.type === "runtime_event") {
    return buildWorkRecordFromRuntimeEvent(record.event, record.at);
  }
  if (record.type === "run_start") {
    return buildWorkRunRecord({
      at: record.at,
      phase: "start",
      objective: record.objective,
      workspace: record.workspace,
      mode: record.mode,
      permissionMode: record.permission_mode,
      sandboxMode: record.sandbox_mode,
      toolPolicy: record.tool_policy,
      additionalReadDirectories: record.additional_read_directories,
      operation: record.operation,
      resumeSessionId: record.resume_session_id
    });
  }
  if (record.type === "run_signal") {
    return buildWorkRunRecord({
      at: record.at,
      phase: "signal",
      sessionId: record.session_id,
      message: record.message
    });
  }
  return buildWorkRunRecord({
    at: record.at,
    phase: "end",
    sessionId: record.session_id,
    status: record.status,
    objective: record.report.objective,
    workspace: record.report.workspace,
    mode: record.report.mode,
    permissionMode: record.report.permission_mode,
    sandboxMode: record.report.sandbox_mode,
    toolPolicy: record.report.tool_policy,
    additionalReadDirectories: record.report.additional_read_directories,
    operation: record.report.operation,
    resumeSessionId: record.report.resume_session_id
  });
}

export function resolveHeadlessSessionId(input: {
  capturedEvents: CapturedRuntimeEvent[];
  result?: ExecutionResult;
}): string | undefined {
  return input.result?.session_id ?? extractSessionId(input.capturedEvents);
}

export function buildHeadlessResumeHint(sessionId: string | undefined): string | undefined {
  return sessionId
    ? `Resume in the TUI with: swarm, then run /resume ${sessionId}`
    : undefined;
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
  permissionMode?: HeadlessPermissionMode;
  sandboxMode?: RunSandboxMode;
  operation?: HeadlessOperation;
  resumeSessionId?: string;
  budget?: HeadlessRunBudget;
  toolPolicy?: HeadlessToolPolicy;
  additionalReadDirectories?: string[];
  promptCustomization?: HeadlessPromptCustomization;
  mcpConfig?: HeadlessMcpConfig;
  activatedSkills?: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  capturedEvents: CapturedRuntimeEvent[];
  result?: ExecutionResult;
  error?: Error;
  protocolReplayDiff?: ProtocolReplayDiff;
  releaseGate?: ParityReleaseGateSummary;
}): HeadlessTelemetry {
  const eventCounts: Record<string, number> = {};
  const providerModels = new Set<string>();
  const providerIds = new Set<string>();
  const purposes = new Set<string>();
  const promptCacheDiagnostics: Record<string, number> = {};
  const providerUsages: ProviderUsageReport[] = [];
  const usageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    totalInputWithCacheTokens: 0,
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
      providerUsages.push(usage);
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
      usageTotals.uncachedInputTokens += usage.uncachedInputTokens ?? 0;
      usageTotals.totalInputWithCacheTokens += usage.totalInputWithCacheTokens ?? 0;
      usageTotals.cacheablePrefixEstimate += usage.cacheablePrefixTokensEstimate ?? 0;
      if (usage.promptCacheDiagnostics) {
        const status = usage.promptCacheDiagnostics.status;
        promptCacheDiagnostics[status] = (promptCacheDiagnostics[status] ?? 0) + 1;
      }
    }
  }
  if (usageTotals.calls === 0) {
    const cache = input.result?.result_card?.cache;
    if (cache && (cache.providerId || cache.model || typeof cache.totalInputWithCacheTokens === "number" || typeof cache.cachedInputTokens === "number")) {
      usageTotals.calls = 1;
      if (cache.providerId) {
        providerIds.add(cache.providerId);
      }
      if (cache.model) {
        providerModels.add(cache.model);
      }
      if (cache.purpose) {
        purposes.add(cache.purpose);
      }
      usageTotals.cachedInputTokens += cache.cachedInputTokens ?? 0;
      usageTotals.cacheCreationInputTokens += cache.cacheCreationInputTokens ?? 0;
      usageTotals.totalInputWithCacheTokens += cache.totalInputWithCacheTokens ?? 0;
      usageTotals.inputTokens += cache.totalInputWithCacheTokens ?? 0;
      usageTotals.uncachedInputTokens += typeof cache.totalInputWithCacheTokens === "number" && typeof cache.cachedInputTokens === "number"
        ? Math.max(0, cache.totalInputWithCacheTokens - cache.cachedInputTokens)
        : 0;
      usageTotals.cacheablePrefixEstimate += cache.cacheablePrefixTokensEstimate ?? 0;
      if (cache.status) {
        promptCacheDiagnostics[cache.status] = (promptCacheDiagnostics[cache.status] ?? 0) + 1;
      }
    }
  }
  const cacheTrend = providerUsages.length > 0
    ? promptCacheTrendFromUsage(providerUsages)
    : promptCacheTrendFromResultCardCache(input.result?.result_card?.cache);
  const cacheSlo = evaluatePromptCacheSlo(cacheTrend);
  const cacheRoi = buildPromptCacheRoi(cacheTrend);
  const cacheImpact = swarmCacheImpactFromUsage(providerUsages, input.result?.result_card?.cache);

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
    permission_mode: input.permissionMode,
    sandbox_mode: input.sandboxMode,
    operation: input.operation,
    resume_session_id: input.resumeSessionId,
    budget: input.budget,
    tool_policy: input.toolPolicy,
    additional_read_directories: input.additionalReadDirectories,
    prompt_customization: input.promptCustomization,
    mcp_config: input.mcpConfig,
    activated_skills: input.activatedSkills,
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
      uncached_input_tokens: usageTotals.uncachedInputTokens,
      total_input_with_cache_tokens: usageTotals.totalInputWithCacheTokens,
      cache_hit_rate: usageTotals.totalInputWithCacheTokens > 0
        ? usageTotals.cachedInputTokens / usageTotals.totalInputWithCacheTokens
        : undefined,
      cache_write_rate: usageTotals.totalInputWithCacheTokens > 0
        ? usageTotals.cacheCreationInputTokens / usageTotals.totalInputWithCacheTokens
        : undefined,
      cacheable_prefix_estimate: usageTotals.cacheablePrefixEstimate,
      prompt_cache_diagnostics: promptCacheDiagnostics,
      cache_roi: headlessPromptCacheRoi(cacheRoi),
      cache_impact: headlessPromptCacheImpact(cacheImpact),
      cache_trend: headlessPromptCacheTrend(cacheTrend),
      cache_slo: headlessPromptCacheSlo(cacheSlo)
    },
    outcome: input.result?.outcome,
    final,
    protocol_replay_diff: input.protocolReplayDiff,
    release_gate: input.releaseGate,
    error: input.error ? { message: input.error.message } : undefined
  };
}

function headlessPromptCacheTrend(trend: PromptCacheTrend): HeadlessPromptCacheTrend {
  return {
    source: trend.source,
    calls: trend.calls,
    cacheable_calls: trend.cacheableCalls,
    hit_calls: trend.hitCalls,
    miss_calls: trend.missCalls,
    warming_calls: trend.warmingCalls,
    bypass_calls: trend.bypassCalls,
    unknown_calls: trend.unknownCalls,
    hit_rate: trend.hitRate,
    write_rate: trend.writeRate,
    cached_input_tokens: trend.cachedInputTokens,
    total_input_with_cache_tokens: trend.totalInputWithCacheTokens,
    cache_creation_input_tokens: trend.cacheCreationInputTokens,
    uncached_input_tokens: trend.uncachedInputTokens,
    cacheable_prefix_tokens_estimate: trend.cacheablePrefixTokensEstimate,
    estimated_savings_tokens: trend.estimatedSavingsTokens,
    prefix_identities: trend.prefixIdentities,
    changed: trend.changed,
    changed_sections: trend.changedSections,
    miss_reasons: trend.missReasons,
    normalized_miss_reasons: trend.normalizedMissReasons,
    facts: trend.facts.map(headlessPromptCacheFact)
  };
}

function headlessPromptCacheRoi(roi: CacheRoi): HeadlessPromptCacheRoi {
  return {
    schema_version: roi.schema_version,
    source: roi.source,
    hit_tokens: roi.hit_tokens,
    miss_tokens: roi.miss_tokens,
    saved_tokens: roi.saved_tokens,
    estimated_saved_cost: roi.estimated_saved_cost,
    estimated_saved_cost_currency: roi.estimated_saved_cost_currency,
    cost_source: roi.cost_source,
    stable_prefix_ratio: roi.stable_prefix_ratio,
    miss_reasons: roi.miss_reasons,
    policy_recommendations: roi.policy_recommendations
  };
}

function headlessPromptCacheImpact(impact: SwarmContextCacheImpact | undefined): HeadlessPromptCacheImpact | undefined {
  if (!impact) {
    return undefined;
  }
  return {
    schema_version: impact.schema_version,
    stable_prefix_hash: impact.stable_prefix_hash,
    stable_prefix_tokens: impact.stable_prefix_tokens,
    dynamic_hash: impact.dynamic_hash,
    dynamic_tokens: impact.dynamic_tokens,
    tool_schema_hash: impact.tool_schema_hash,
    mailbox_hash: impact.mailbox_hash,
    actor_hashes: impact.actor_hashes,
    context_hashes: impact.context_hashes,
    changed_dimensions: impact.changed_dimensions,
    reasons: impact.reasons,
    recommendations: impact.recommendations,
    retained_context: impact.retained_context,
    dropped_context: impact.dropped_context,
    protected_context_retained: impact.protected_context_retained,
    stable_segments: impact.stable_segments.map(headlessPromptCacheImpactSegment),
    dynamic_segments: impact.dynamic_segments.map(headlessPromptCacheImpactSegment)
  };
}

function headlessPromptCacheImpactSegment(segment: SwarmContextCacheImpactSegment): HeadlessPromptCacheImpactSegment {
  return {
    segment_id: segment.segment_id,
    kind: segment.kind,
    phase: segment.phase,
    content_hash: segment.content_hash,
    tokens: segment.tokens,
    retained: segment.retained,
    protected: segment.protected,
    changed: segment.changed,
    actor_id: segment.actor_id,
    reason: segment.reason
  };
}

function headlessPromptCacheFact(fact: CacheFact): HeadlessPromptCacheFact {
  return {
    provider_id: fact.providerId,
    model: fact.model,
    purpose: fact.purpose,
    cache_mode: fact.cacheMode,
    status: fact.status,
    outcome: fact.outcome,
    hit_tokens: fact.hitTokens,
    miss_tokens: fact.missTokens,
    write_tokens: fact.writeTokens,
    cacheable_tokens: fact.cacheableTokens,
    cacheable_prefix_tokens_estimate: fact.cacheablePrefixTokensEstimate,
    minimum_cacheable_tokens: fact.minimumCacheableTokens,
    hit_rate: fact.hitRate,
    write_rate: fact.writeRate,
    estimated_savings_tokens: fact.estimatedSavingsTokens,
    prefix_identity: fact.prefixIdentity,
    miss_reason: fact.missReason,
    normalized_miss_reason: fact.normalizedMissReason,
    changed: fact.changed,
    changed_sections: fact.changedSections,
    reason: fact.reason,
    recommendation: fact.recommendation
  };
}

function headlessPromptCacheSlo(evaluation: PromptCacheSloEvaluation): HeadlessPromptCacheSlo {
  return {
    status: evaluation.status,
    state: evaluation.state,
    source: evaluation.source,
    summary: evaluation.summary,
    failures: evaluation.failures,
    metrics: {
      calls: evaluation.metrics.calls,
      hit_tokens: evaluation.metrics.hitTokens,
      cacheable_tokens: evaluation.metrics.cacheableTokens,
      write_tokens: evaluation.metrics.writeTokens,
      hit_rate: evaluation.metrics.hitRate,
      changed_prefix_misses: evaluation.metrics.changedPrefixMisses,
      fallback_calls: evaluation.metrics.fallbackCalls,
      provider_usage_missing_calls: evaluation.metrics.providerUsageMissingCalls,
      estimated_savings_tokens: evaluation.metrics.estimatedSavingsTokens,
      unexplained_misses: evaluation.metrics.unexplainedMisses,
      unexplained_miss_rate: evaluation.metrics.unexplainedMissRate,
      min_cacheable_prefix_tokens: evaluation.metrics.minCacheablePrefixTokens,
      prefix_identities: evaluation.metrics.prefixIdentities,
      normalized_miss_reasons: evaluation.metrics.normalizedMissReasons,
      miss_reasons: evaluation.metrics.missReasons
    }
  };
}

function buildHeadlessTrajectory(input: {
  objective: string;
  workspace: string;
  mode: RunMode;
  permissionMode?: HeadlessPermissionMode;
  sandboxMode?: RunSandboxMode;
  operation?: HeadlessOperation;
  resumeSessionId?: string;
  budget?: HeadlessRunBudget;
  toolPolicy?: HeadlessToolPolicy;
  additionalReadDirectories?: string[];
  promptCustomization?: HeadlessPromptCustomization;
  mcpConfig?: HeadlessMcpConfig;
  activatedSkills?: string[];
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
          parent_session_id: event.parent_session_id,
          confidence: event.decision.confidence,
          reason: event.decision.reason,
          display_name: event.decision.display_name,
          role_title: event.decision.role_title,
          objective: event.task_packet.objective,
          write_policy: event.task_packet.write_policy,
          file_scope: event.task_packet.file_scope,
          allowed_tools: event.task_packet.allowed_tools
        }
      });
      continue;
    }
    if (event.type === "plan") {
      steps.push({
        step_id: stepId++,
        timestamp,
        source: "system",
        message: `plan ${event.session_id}: ${event.plan.summary}`,
        extra: {
          objective: event.plan.objective,
          intent: event.plan.intent,
          tasks: event.plan.tasks.map((task) => {
            const inputs = task.inputs && typeof task.inputs === "object" ? task.inputs : {};
            return {
              task_id: task.task_id,
              title: task.title,
              status: task.status,
              required_capabilities: task.required_capabilities,
              action: typeof inputs.action === "string" ? inputs.action : undefined,
              write_policy: declaredToolTaskWritePolicy(inputs),
              file_scope: declaredToolTaskFileScope(inputs)
            };
          }),
          final_artifact: event.plan.final_artifact
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
            capability: event.capability,
            write_policy: event.write_policy,
            file_scope: event.file_scope
          },
          extra: {
            errorCode: event.errorCode,
            recoverySuggestion: event.recoverySuggestion,
            recovery: event.recovery,
            outputRef: event.outputRef,
            write_policy: event.write_policy,
            file_scope: event.file_scope
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
              recovery: event.recovery,
              outputRef: event.outputRef,
              write_policy: event.write_policy,
              file_scope: event.file_scope
            }
          }]
        },
        extra: {
          action: event.action,
          title: event.title,
          task_id: event.task_id,
          status: event.status,
          capability: event.capability,
          recovery: event.recovery,
          write_policy: event.write_policy,
          file_scope: event.file_scope
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
        permission_mode: input.permissionMode,
        sandbox_mode: input.sandboxMode,
        operation: input.operation,
        resume_session_id: input.resumeSessionId,
        budget: input.budget,
        tool_policy: input.toolPolicy,
        additional_read_directories: input.additionalReadDirectories,
        prompt_customization: input.promptCustomization,
        mcp_config: input.mcpConfig,
        activated_skills: input.activatedSkills,
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
      permission_mode: input.permissionMode,
      sandbox_mode: input.sandboxMode,
      operation: input.operation,
      resume_session_id: input.resumeSessionId,
      budget: input.budget,
      tool_policy: input.toolPolicy,
      additional_read_directories: input.additionalReadDirectories,
      prompt_customization: input.promptCustomization,
      mcp_config: input.mcpConfig,
      activated_skills: input.activatedSkills,
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
    if (event.type === "agent_spawn_decision") {
      return event.parent_session_id;
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
