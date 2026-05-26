import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildHeadlessArtifactIndex,
  buildHeadlessRunArtifacts,
  buildHeadlessStreamRecord,
  headlessStreamJson,
  type HeadlessStreamRecord,
  type ParityReleaseGateSummary,
  type HeadlessToolPolicy
} from "./headless-artifacts.js";
import { buildProtocolReplay, diffProtocolReplaySnapshots } from "./protocol-replay.js";
import type { ResultCard } from "./result-card.js";
import type { WorkProtocolRecord } from "./work-protocol.js";

const STARTED_AT = "2026-05-13T00:00:00.000Z";
const ENDED_AT = "2026-05-13T00:00:02.000Z";
const OBJECTIVE = "Project policy metadata";
const WORKSPACE = "E:/Playground/Swarm";
const TOOL_POLICY: HeadlessToolPolicy = {
  allowed_tools: ["Read", "Grep"],
  disallowed_tools: ["Bash"]
};
const ADDITIONAL_READ_DIRECTORIES = ["E:/Shared/ReadOnly", "D:/Reference"];

test("buildHeadlessRunArtifacts preserves policy sandbox metadata across report telemetry and trajectory", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "ask",
    sandboxMode: "read-only",
    toolPolicy: TOOL_POLICY,
    additionalReadDirectories: ADDITIONAL_READ_DIRECTORIES,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: "session-1",
      content: "Done",
      status: "completed",
      outcome: {
        changed_files: [],
        tests_run: [],
        intermediate_artifacts: [],
        final_summary: "Done"
      }
    }
  });

  assert.equal(artifacts.report.sandbox_mode, "read-only");
  assert.deepEqual(artifacts.report.tool_policy, TOOL_POLICY);
  assert.deepEqual(artifacts.report.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);

  assert.equal(artifacts.telemetry.sandbox_mode, "read-only");
  assert.deepEqual(artifacts.telemetry.tool_policy, TOOL_POLICY);
  assert.deepEqual(artifacts.telemetry.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);

  assertPolicyMetadata(artifacts.trajectory.agent.extra);
  assertPolicyMetadata(artifacts.trajectory.extra);
});

test("headless artifact index links report telemetry trajectory logs and redacts secrets", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: OBJECTIVE,
    workspace: "E:\\Playground\\Swarm",
    mode: "coding_loop",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    reportPath: "E:\\Playground\\Swarm\\.swarm\\reports\\run.report.json",
    telemetryPath: "E:\\Playground\\Swarm\\.swarm\\reports\\run.telemetry.json",
    trajectoryPath: "E:\\Playground\\Swarm\\.swarm\\reports\\run.trajectory.json",
    debugLogPath: "C:\\Users\\dev\\.swarm\\logs\\session-sk-test1234567890.log",
    evalSummaryPath: "E:\\Playground\\Swarm\\.swarm\\evals\\summary.json",
    stdoutPath: "E:\\Playground\\Swarm\\.swarm\\local-tests\\stdout.log",
    stderrPath: "E:\\Playground\\Swarm\\.swarm\\local-tests\\stderr.log",
    diffSummaryPath: "E:\\Playground\\Swarm\\.swarm\\local-tests\\diff-summary.json",
    result: {
      session_id: "session-artifacts",
      content: "Done",
      status: "completed",
      artifact_path: "E:\\Playground\\Swarm\\.swarm\\artifacts\\result.json"
    }
  });

  assert.equal(artifacts.artifactIndex.schema_version, "swarm.artifact-index.v1");
  assert.equal(artifacts.artifactIndex.session_id, "session-artifacts");
  assert.equal(artifacts.artifactIndex.workspace, "E:/Playground/Swarm");
  assert.deepEqual(artifacts.artifactIndex.artifacts.map((artifact) => artifact.kind), [
    "report",
    "telemetry",
    "trajectory",
    "result",
    "debug_log",
    "eval_summary",
    "stdout",
    "stderr",
    "diff_summary"
  ]);
  assert.equal(artifacts.report.artifacts.stdout_path, "E:\\Playground\\Swarm\\.swarm\\local-tests\\stdout.log");
  assert.equal(artifacts.report.artifacts.stderr_path, "E:\\Playground\\Swarm\\.swarm\\local-tests\\stderr.log");
  assert.equal(artifacts.report.artifacts.diff_summary_path, "E:\\Playground\\Swarm\\.swarm\\local-tests\\diff-summary.json");
  assert(artifacts.artifactIndex.artifacts.every((artifact) => !artifact.path.includes("\\")));
  assert(artifacts.artifactIndex.artifacts.some((artifact) => artifact.kind === "debug_log" && artifact.path.includes("sk-REDACTED")));
  assert(artifacts.artifactIndex.artifacts.some((artifact) => artifact.kind === "diff_summary" && artifact.path.endsWith("/diff-summary.json")));
  assert.doesNotMatch(JSON.stringify(artifacts.artifactIndex), /sk-test1234567890/);
  assert.deepEqual(artifacts.report.artifact_index, artifacts.artifactIndex);

  const direct = buildHeadlessArtifactIndex({
    workspace: "E:\\Playground\\Swarm",
    reportPath: "E:\\Playground\\Swarm\\report.json",
    telemetryPath: "E:\\Playground\\Swarm\\report.json"
  });
  assert.deepEqual(direct.artifacts, [
    { kind: "report", path: "E:/Playground/Swarm/report.json" },
    { kind: "telemetry", path: "E:/Playground/Swarm/report.json" }
  ]);
});

test("headless report includes shared protocol timeline summary", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Trace protocol timeline",
    workspace: WORKSPACE,
    mode: "coding_loop",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [
      {
        at: STARTED_AT,
        event: {
          type: "envelope",
          envelope: {
            id: "env-headless-1",
            version: "1.0",
            swarm_id: "swarm-headless",
            session_id: "session-headless",
            task_id: "task-headless",
            from: { agent_id: "worker-headless" },
            to: { agent_id: "router" },
            type: "task.result",
            intent: "return result",
            correlation_id: "corr-headless",
            created_at: STARTED_AT,
            payload: {
              owner_agent_id: "worker-headless",
              authorization: "Bearer abcdefghijklmnop"
            }
          }
        }
      },
      {
        at: ENDED_AT,
        event: {
          type: "provider_usage",
          usage: providerUsage({
            taskId: "task-headless",
            status: "changed",
            cachedInputTokens: 0,
            totalInputWithCacheTokens: 3000,
            missReason: "changed_tools"
          })
        }
      }
    ],
    result: {
      session_id: "session-headless",
      content: "Done",
      status: "completed"
    }
  });

  assert.equal(artifacts.report.protocol_timeline?.schema_version, "swarm.protocol_timeline.summary.v1");
  assert.equal(artifacts.report.protocol_timeline?.by_category.envelope, 1);
  assert.equal(artifacts.report.protocol_timeline?.by_category.ownership, 1);
  assert.equal(artifacts.report.protocol_timeline?.by_category.cache, 1);
  assert(artifacts.report.protocol_timeline?.correlations.some((group) => group.correlation_id === "corr-headless"));
  assert(artifacts.report.protocol_timeline?.events.some((event) => event.correlation_id === "task-headless" && event.category === "cache"));
  assert.doesNotMatch(JSON.stringify(artifacts.report.protocol_timeline), /Bearer abcdefghijklmnop/);

  const parsed = JSON.parse(headlessStreamJson(buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: "completed",
    session_id: "session-headless",
    duration_ms: 2_000,
    report: artifacts.report
  }))) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assert.equal(parsed.report.protocol_timeline?.correlations[0]?.events, 2);
});

test("headless report includes replay diff", () => {
  const replay = buildProtocolReplay({
    sessionId: "session-headless-replay",
    generatedAt: STARTED_AT,
    envelopes: [
      {
        id: "env-headless-replay-assign",
        version: "1.0",
        swarm_id: "swarm-headless",
        session_id: "session-headless-replay",
        task_id: "worker-headless-replay",
        from: { agent_id: "main_swarm" },
        to: { agent_id: "worker:worker-headless-replay", capability: "code.test" },
        type: "task.assign",
        intent: "task.assign",
        created_at: STARTED_AT,
        payload: { worker_id: "worker-headless-replay", objective: "Diff headless replay" }
      }
    ]
  });
  const live = {
    ...replay,
    workers: replay.workers.map((worker) => ({ ...worker, status: "completed" as const }))
  };
  const protocolReplayDiff = diffProtocolReplaySnapshots({ live, replay, generatedAt: STARTED_AT });
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Trace protocol replay diff",
    workspace: WORKSPACE,
    mode: "coding_loop",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    protocolReplayDiff,
    result: {
      session_id: "session-headless-replay",
      content: "Done",
      status: "completed"
    }
  });

  assert.equal(artifacts.report.protocol_replay_diff?.schema_version, "swarm.protocol_replay.diff.v1");
  assert.equal(artifacts.report.protocol_replay_diff?.status, "fail");
  assert.equal(artifacts.report.protocol_replay_diff?.replay_verdict.forced, true);
  assert.equal(artifacts.telemetry.protocol_replay_diff?.summary.errors, 1);

  const parsed = JSON.parse(headlessStreamJson(buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: "completed",
    session_id: "session-headless-replay",
    duration_ms: 2_000,
    report: artifacts.report
  }))) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assert.equal(parsed.report.protocol_replay_diff?.issues[0]?.path, "worker.worker-headless-replay.status");
});

test("headless report telemetry and run_end stream preserve parity release gate summary", () => {
  const releaseGate = parityReleaseGateSummary();
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Run offline release gate",
    workspace: WORKSPACE,
    mode: "coding_loop",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    evalSummaryPath: "E:/Playground/Swarm/.swarm/local-tests/parity/release-gate.summary.json",
    releaseGate,
    result: {
      session_id: "session-release-gate",
      content: releaseGate.summary,
      status: "completed"
    }
  });

  assert.equal(artifacts.report.release_gate?.schema_version, "swarm.parity_release_gate.v1");
  assert.equal(artifacts.report.release_gate?.compared_to, "Claude Code");
  assert.equal(artifacts.telemetry.release_gate?.profile, "offline_quick");
  assert.equal(artifacts.telemetry.release_gate?.next_task, "CAND-PROD-054-TASK-001");
  assert.equal(artifacts.telemetry.release_gate?.triage_queue[0]?.next_task_suggestion, "CAND-PROD-054-TASK-001");
  assert(artifacts.artifactIndex.artifacts.some((artifact) => artifact.kind === "eval_summary"));

  const record = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: "completed",
    session_id: "session-release-gate",
    duration_ms: 2_000,
    report: artifacts.report
  });
  const parsed = JSON.parse(headlessStreamJson(record)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assert.equal(parsed.report.release_gate?.status, "pass");
  assert.equal(parsed.report.release_gate?.dimensions[0]?.id, "interactive_trust");
  assert.deepEqual(parsed.report.release_gate?.dogfood.covered, ["TUI", "cache", "provider", "Gateway/Symphony", "LSP fallback", "artifacts"]);
});

test("buildHeadlessStreamRecord preserves run_start metadata at top level and nested WorkProtocol record", () => {
  const record = buildHeadlessStreamRecord({
    type: "run_start",
    at: STARTED_AT,
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    mode: "coding_loop",
    permission_mode: "ask",
    sandbox_mode: "read-only",
    tool_policy: TOOL_POLICY,
    additional_read_directories: ADDITIONAL_READ_DIRECTORIES
  });

  assert.equal(record.type, "run_start");
  assert.equal(record.sandbox_mode, "read-only");
  assert.deepEqual(record.tool_policy, TOOL_POLICY);
  assert.deepEqual(record.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(record.work, "start");

  const parsed = JSON.parse(headlessStreamJson(record)) as Extract<HeadlessStreamRecord, { type: "run_start" }>;
  assert.equal(parsed.sandbox_mode, "read-only");
  assert.deepEqual(parsed.tool_policy, TOOL_POLICY);
  assert.deepEqual(parsed.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(parsed.work, "start");
});

test("buildHeadlessStreamRecord preserves run_end report metadata in nested WorkProtocol record", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    toolPolicy: TOOL_POLICY,
    additionalReadDirectories: ADDITIONAL_READ_DIRECTORIES,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: "session-1",
      content: "Done",
      status: "completed"
    }
  });
  const record = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: "completed",
    session_id: "session-1",
    duration_ms: 2_000,
    report: artifacts.report
  });

  assert.equal(record.type, "run_end");
  assert.equal(record.report.sandbox_mode, "workspace-write");
  assert.deepEqual(record.report.tool_policy, TOOL_POLICY);
  assert.deepEqual(record.report.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(record.work, "end", "workspace-write");

  const parsed = JSON.parse(headlessStreamJson(record)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;
  assert.equal(parsed.report.sandbox_mode, "workspace-write");
  assert.deepEqual(parsed.report.tool_policy, TOOL_POLICY);
  assert.deepEqual(parsed.report.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
  assertRunWorkMetadata(parsed.work, "end", "workspace-write");
});

test("headless report and run_end stream preserve Review / Verification result-card evidence", () => {
  const warningArtifacts = buildReviewProjectionArtifacts(REVIEW_WARNING_RESULT_CARD);

  assertReviewWarningVerificationCard(warningArtifacts.report.result?.result_card);

  const warningRunEnd = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: warningArtifacts.report.status,
    session_id: REVIEW_WARNING_RESULT_CARD.sessionId,
    duration_ms: 2_000,
    report: warningArtifacts.report
  });
  const warningParsed = JSON.parse(headlessStreamJson(warningRunEnd)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assertReviewWarningVerificationCard(warningParsed.report.result?.result_card);

  const failedArtifacts = buildReviewProjectionArtifacts(FAILED_REVIEW_RESULT_CARD, "failed");

  assertFailedReviewCard(failedArtifacts.report.result?.result_card);

  const failedRunEnd = buildHeadlessStreamRecord({
    type: "run_end",
    at: ENDED_AT,
    status: failedArtifacts.report.status,
    session_id: FAILED_REVIEW_RESULT_CARD.sessionId,
    duration_ms: 2_000,
    report: failedArtifacts.report
  });
  const failedParsed = JSON.parse(headlessStreamJson(failedRunEnd)) as Extract<HeadlessStreamRecord, { type: "run_end" }>;

  assertFailedReviewCard(failedParsed.report.result?.result_card);
});

test("headless telemetry falls back to result-card prompt cache when usage events are absent", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Project prompt cache telemetry fallback",
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: "session-cache-fallback",
      content: "Done",
      status: "completed",
      result_card: {
        ...REVIEW_WARNING_RESULT_CARD,
        sessionId: "session-cache-fallback",
        cache: {
          status: "stable",
          cacheMode: "prefix-structured",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          purpose: "worker_coding_loop",
          promptCacheKey: "swarm:worker:stable:test",
          cachedInputTokens: 5120,
          totalInputWithCacheTokens: 9749,
          cacheablePrefixTokensEstimate: 4184,
          hitRate: 5120 / 9749,
          diagnostics: "stable"
        }
      }
    }
  });

  assert.equal(artifacts.telemetry.llm.calls, 1);
  assert.deepEqual(artifacts.telemetry.llm.providers, ["deepseek"]);
  assert.deepEqual(artifacts.telemetry.llm.models, ["deepseek-v4-flash"]);
  assert.deepEqual(artifacts.telemetry.llm.purposes, ["worker_coding_loop"]);
  assert.equal(artifacts.telemetry.llm.input_tokens, 9749);
  assert.equal(artifacts.telemetry.llm.cached_input_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.total_input_with_cache_tokens, 9749);
  assert.equal(artifacts.telemetry.llm.uncached_input_tokens, 4629);
  assert.equal(artifacts.telemetry.llm.cacheable_prefix_estimate, 4184);
  assert.equal(artifacts.telemetry.llm.cache_hit_rate, 5120 / 9749);
  assert.deepEqual(artifacts.telemetry.llm.prompt_cache_diagnostics, { stable: 1 });
  assert.equal(artifacts.telemetry.llm.cache_trend.source, "result_card_fallback");
  assert.equal(artifacts.telemetry.llm.cache_trend.calls, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.cacheable_calls, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.hit_calls, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.hit_rate, 5120 / 9749);
  assert.equal(artifacts.telemetry.llm.cache_trend.cached_input_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_trend.total_input_with_cache_tokens, 9749);
  assert.equal(artifacts.telemetry.llm.cache_trend.estimated_savings_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_roi?.schema_version, "swarm.cache_roi.v1");
  assert.equal(artifacts.telemetry.llm.cache_roi?.saved_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_roi?.miss_tokens, 4629);
  assert.equal(artifacts.telemetry.llm.cache_roi?.cost_source, "unpriced");
  assert.match(artifacts.telemetry.llm.cache_roi?.policy_recommendations[0] ?? "", /provider usage telemetry/i);
  assert.equal(artifacts.telemetry.llm.cache_impact?.schema_version, "swarm.cache_impact.v1");
  assert.match(artifacts.telemetry.llm.cache_impact?.stable_prefix_hash ?? "", /^scp:[a-f0-9]{12}$/);
  assert.equal(artifacts.telemetry.llm.cache_impact?.stable_prefix_tokens, 4184);
  assert.deepEqual(artifacts.telemetry.llm.cache_impact?.changed_dimensions, []);
  assert.match(artifacts.telemetry.llm.cache_trend.prefix_identities[0] ?? "", /^pcx:[a-f0-9]{12}$/);
  assert.deepEqual(artifacts.telemetry.llm.cache_trend.normalized_miss_reasons, {
    cold_start: 0,
    prefix_drift: 0,
    context_overflow: 0,
    provider_unsupported: 0,
    provider_omitted_usage: 0,
    unknown: 0
  });
  assert.equal(artifacts.telemetry.llm.cache_trend.facts.length, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.provider_id, "deepseek");
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.hit_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.miss_tokens, 4629);
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.estimated_savings_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.prefix_identity, artifacts.telemetry.llm.cache_trend.prefix_identities[0]);
  assert.equal(artifacts.telemetry.llm.cache_slo.status, "pass");
  assert.equal(artifacts.telemetry.llm.cache_slo.state, "stable");
  assert.equal(artifacts.telemetry.llm.cache_slo.source, "result_card_fallback");
  assert.match(artifacts.telemetry.llm.cache_slo.summary, /estimated_savings_tokens=5120/);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.hit_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.cacheable_tokens, 9749);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.estimated_savings_tokens, 5120);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.fallback_calls, 1);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.provider_usage_missing_calls, 1);
  assert.deepEqual(artifacts.telemetry.llm.cache_slo.metrics.prefix_identities, artifacts.telemetry.llm.cache_trend.prefix_identities);
});

test("headless telemetry exposes provider prompt cache trend when usage events are captured", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Project prompt cache trend",
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [
      {
        at: STARTED_AT,
        event: {
          type: "provider_usage",
          usage: providerUsage({
            taskId: "turn-1",
            status: "new_scope",
            cachedInputTokens: 0,
            totalInputWithCacheTokens: 3000
          })
        }
      },
      {
        at: ENDED_AT,
        event: {
          type: "provider_usage",
          usage: providerUsage({
            taskId: "turn-2",
            status: "stable",
            cachedInputTokens: 2400,
            totalInputWithCacheTokens: 4000
          })
        }
      }
    ],
    result: {
      session_id: "session-cache-trend",
      content: "Done",
      status: "completed"
    }
  });

  assert.equal(artifacts.telemetry.llm.calls, 2);
  assert.equal(artifacts.telemetry.llm.cached_input_tokens, 2400);
  assert.equal(artifacts.telemetry.llm.total_input_with_cache_tokens, 7000);
  assert.equal(artifacts.telemetry.llm.cache_hit_rate, 2400 / 7000);
  assert.deepEqual(artifacts.telemetry.llm.prompt_cache_diagnostics, { new_scope: 1, stable: 1 });
  assert.equal(artifacts.telemetry.llm.cache_trend.source, "provider_usage");
  assert.equal(artifacts.telemetry.llm.cache_trend.calls, 2);
  assert.equal(artifacts.telemetry.llm.cache_trend.cacheable_calls, 2);
  assert.equal(artifacts.telemetry.llm.cache_trend.hit_calls, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.warming_calls, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.hit_rate, 2400 / 7000);
  assert.equal(artifacts.telemetry.llm.cache_trend.cached_input_tokens, 2400);
  assert.equal(artifacts.telemetry.llm.cache_trend.total_input_with_cache_tokens, 7000);
  assert.equal(artifacts.telemetry.llm.cache_trend.uncached_input_tokens, 4600);
  assert.equal(artifacts.telemetry.llm.cache_trend.estimated_savings_tokens, 2400);
  assert.equal(artifacts.telemetry.llm.cache_roi?.source, "provider_usage");
  assert.equal(artifacts.telemetry.llm.cache_roi?.saved_tokens, 2400);
  assert.match(artifacts.telemetry.llm.cache_roi?.policy_recommendations.join(" | ") ?? "", /same route, model, cache key/i);
  assert.equal(artifacts.telemetry.llm.cache_impact?.schema_version, "swarm.cache_impact.v1");
  assert.match(artifacts.telemetry.llm.cache_impact?.stable_prefix_hash ?? "", /^scp:[a-f0-9]{12}$/);
  assert.match(artifacts.telemetry.llm.cache_impact?.tool_schema_hash ?? "", /^sct:[a-f0-9]{12}$/);
  assert.deepEqual(artifacts.telemetry.llm.cache_impact?.stable_segments.map((segment) => segment.segment_id).sort(), ["provider_prefix", "shared_context", "system", "tool_schema"]);
  assert.deepEqual(artifacts.telemetry.llm.cache_impact?.dynamic_segments.map((segment) => segment.segment_id).sort(), ["active_task", "actor_runtime_state", "task_local_context"]);
  assert.match(artifacts.telemetry.llm.cache_trend.prefix_identities[0] ?? "", /^pcx:[a-f0-9]{12}$/);
  assert.equal(artifacts.telemetry.llm.cache_trend.normalized_miss_reasons.cold_start, 1);
  assert.equal(artifacts.telemetry.llm.cache_trend.facts.length, 2);
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.status, "new_scope");
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[0]?.normalized_miss_reason, "cold_start");
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[1]?.status, "stable");
  assert.equal(artifacts.telemetry.llm.cache_trend.facts[1]?.hit_tokens, 2400);
  assert.equal(artifacts.telemetry.llm.cache_slo.status, "pass");
  assert.equal(artifacts.telemetry.llm.cache_slo.state, "stable");
  assert.equal(artifacts.telemetry.llm.cache_slo.source, "provider_usage");
  assert.match(artifacts.telemetry.llm.cache_slo.summary, /estimated_savings_tokens=2400/);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.hit_tokens, 2400);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.cacheable_tokens, 7000);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.estimated_savings_tokens, 2400);
  assert.equal(artifacts.telemetry.llm.cache_slo.metrics.normalized_miss_reasons.cold_start, 1);
  assert.deepEqual(artifacts.telemetry.llm.cache_slo.metrics.prefix_identities, artifacts.telemetry.llm.cache_trend.prefix_identities);
});

test("headless telemetry cache impact explains context and schema prefix churn", () => {
  const artifacts = buildHeadlessRunArtifacts({
    objective: "Project prompt cache impact",
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [
      {
        at: STARTED_AT,
        event: {
          type: "provider_usage",
          usage: providerUsage({
            taskId: "turn-1",
            status: "changed",
            cachedInputTokens: 0,
            totalInputWithCacheTokens: 5000,
            changedSections: ["tools", "context", "volatile_footer"],
            missReason: "changed_tools"
          })
        }
      }
    ],
    result: {
      session_id: "session-cache-impact",
      content: "Done",
      status: "completed"
    }
  });
  const impact = artifacts.telemetry.llm.cache_impact;

  assert.equal(impact?.schema_version, "swarm.cache_impact.v1");
  assert.deepEqual(impact?.changed_dimensions, ["actor", "context", "schema"]);
  assert.match(impact?.reasons.join(" | ") ?? "", /miss_reason=changed_tools/);
  assert.match(impact?.reasons.join(" | ") ?? "", /tool schema changed/);
  assert.match(impact?.reasons.join(" | ") ?? "", /actor runtime state/);
  assert.match(impact?.stable_prefix_hash ?? "", /^scp:[a-f0-9]{12}$/);
  assert.match(impact?.dynamic_hash ?? "", /^scd:[a-f0-9]{12}$/);
  assert(impact?.stable_segments.some((segment) => segment.kind === "tool_schema"));
  assert(impact?.dynamic_segments.some((segment) => segment.kind === "actor_state"));
  assert.doesNotMatch(JSON.stringify(impact), /swarm:worker:stable:test/);
});

function assertPolicyMetadata(value: Record<string, unknown> | undefined): void {
  assert(value);
  assert.equal(value.sandbox_mode, "read-only");
  assert.deepEqual(value.tool_policy, TOOL_POLICY);
  assert.deepEqual(value.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
}

function parityReleaseGateSummary(): ParityReleaseGateSummary {
  return {
    schema_version: "swarm.parity_release_gate.v1",
    profile: "offline_quick",
    compared_to: "Claude Code",
    status: "pass",
    summary: "Offline parity release gate passed.",
    pass_reasons: ["TUI, cache, provider, control plane, LSP, and artifacts are covered."],
    fail_reasons: [],
    near_claude_code: ["conversation-first coding loop with result card evidence"],
    gaps: ["Next cycle should broaden startup replay coverage."],
    dimensions: [
      {
        id: "interactive_trust",
        label: "Interactive trust",
        status: "pass",
        score: 88,
        reason: "Command Output detail is explicit.",
        evidence: ["TUI command-output detail eval blocks auto-open regression"],
        gaps: ["Next cycle should keep long-session replay broad."],
        next_task: "CAND-PROD-054-TASK-001"
      }
    ],
    red_lines: [
      {
        id: "tui_no_auto_focus_steal",
        status: "pass",
        reason: "Command Output detail does not auto-open.",
        evidence: ["TUI command-output detail eval blocks auto-open regression"],
        next_task: "CAND-PROD-054-TASK-001"
      }
    ],
    triage_queue: [{
      failed_dimension: "interactive_trust",
      status: "pass",
      evidence_links: ["TUI command-output detail eval blocks auto-open regression"],
      suspected_owner_files: ["src/tui/interaction-replay.ts", "src/tui/conversation-layout.ts"],
      next_task_suggestion: "CAND-PROD-054-TASK-001"
    }],
    dogfood: {
      covered: ["TUI", "cache", "provider", "Gateway/Symphony", "LSP fallback", "artifacts"],
      artifact_kinds: ["report", "telemetry", "trajectory", "debug_log", "eval_summary"],
      evidence: ["real usage regression evals"]
    },
    commands: ["npm run release:gate", "/evals --release-gate"],
    next_task: "CAND-PROD-054-TASK-001"
  };
}

function assertRunWorkMetadata(
  record: WorkProtocolRecord,
  phase: "start" | "end",
  sandboxMode: "read-only" | "workspace-write" = "read-only"
): void {
  assert.equal(record.kind, "run");
  assert.equal(record.phase, phase);
  assert.equal(record.sandbox_mode, sandboxMode);
  assert.deepEqual(record.tool_policy, TOOL_POLICY);
  assert.deepEqual(record.additional_read_directories, ADDITIONAL_READ_DIRECTORIES);
}

function buildReviewProjectionArtifacts(
  resultCard: ResultCard,
  status: "completed" | "failed" = "completed"
) {
  return buildHeadlessRunArtifacts({
    objective: "Project Review / Verification result-card evidence",
    workspace: WORKSPACE,
    mode: "coding_loop",
    permissionMode: "auto-edit",
    sandboxMode: "workspace-write",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 2_000,
    capturedEvents: [],
    result: {
      session_id: resultCard.sessionId,
      content: resultCard.summary,
      status,
      result_card: resultCard
    }
  });
}

function assertReviewWarningVerificationCard(card: ResultCard | undefined): void {
  assert(card, "missing result_card");
  assert.equal(card.review.status, "warning");
  assert(card.review.summary.includes("missing edge-case assertion"));
  assert(card.checks.some((check) =>
    check.command === "verification check failed: npm run check exited 2" && check.status === "failed"
  ));
  assert(card.artifacts.includes("worker_id_review_verify"));
  assert(card.risks.some((risk) =>
    risk.level === "medium" &&
    risk.message === "Reviewer reported findings or reduced confidence; inspect review details before trusting the result."
  ));
  assert(card.risks.some((risk) =>
    risk.level === "high" &&
    risk.message === "At least one recorded verification check failed."
  ));
  assert(card.next.includes("open the inspector and verify the diff"));
}

function assertFailedReviewCard(card: ResultCard | undefined): void {
  assert(card, "missing result_card");
  assert.equal(card.review.status, "failed");
  assert(card.review.summary.includes("reject 45"));
  assert(card.review.summary.includes("Reject until verification artifacts are attached."));
}

const REVIEW_WARNING_RESULT_CARD: ResultCard = {
  sessionId: "session-review-warning-result-card",
  status: "completed",
  route: "work",
  summary: "Review found a missing edge-case assertion.",
  changedFiles: ["src/runtime/headless-artifacts.test.ts"],
  checks: [
    {
      command: "node --import tsx --test src/runtime/headless-artifacts.test.ts",
      status: "passed"
    },
    {
      command: "verification check failed: npm run check exited 2",
      status: "failed"
    }
  ],
  review: {
    status: "warning",
    summary: "needs_revision 82 - Review found a missing edge-case assertion."
  },
  risks: [
    {
      level: "medium",
      message: "Reviewer reported findings or reduced confidence; inspect review details before trusting the result."
    },
    {
      level: "high",
      message: "At least one recorded verification check failed."
    }
  ],
  artifacts: ["worker_id_review_verify"],
  next: ["open the inspector and verify the diff"]
};

const FAILED_REVIEW_RESULT_CARD: ResultCard = {
  sessionId: "session-review-failed-result-card",
  status: "failed",
  route: "work",
  summary: "Reject until verification artifacts are attached.",
  changedFiles: ["src/runtime/headless-artifacts.test.ts"],
  checks: [],
  review: {
    status: "failed",
    summary: "reject 45 - Reject until verification artifacts are attached."
  },
  risks: [
    {
      level: "high",
      message: "Run ended in failure."
    }
  ],
  artifacts: [],
  next: ["inspect the error and rerun the narrowest failing step"]
};

function providerUsage(input: {
  taskId: string;
  status: "new_scope" | "stable" | "changed";
  cachedInputTokens: number;
  totalInputWithCacheTokens: number;
  changedSections?: Array<"system" | "tools" | "workspace" | "task" | "context" | "volatile_footer">;
  missReason?: "first_call" | "changed_system" | "changed_tools" | "changed_workspace" | "changed_task" | "changed_context" | "provider_no_cache" | "unknown";
}) {
  const changedSections = input.changedSections ?? (input.status === "changed" ? ["tools"] : []);
  return {
    providerId: "deepseek",
    protocol: "openai-chat-completions" as const,
    model: "deepseek-v4-flash",
    purpose: "worker_coding_loop",
    sessionId: "session-cache-trend",
    taskId: input.taskId,
    cacheMode: "prefix-structured",
    promptCacheKey: "swarm:worker:stable:test",
    promptCacheScope: "scope",
    cacheablePrefixTokensEstimate: 4096,
    durationMs: 12,
    inputTokens: input.totalInputWithCacheTokens,
    cachedInputTokens: input.cachedInputTokens,
    totalInputWithCacheTokens: input.totalInputWithCacheTokens,
    uncachedInputTokens: Math.max(0, input.totalInputWithCacheTokens - input.cachedInputTokens),
    promptCacheDiagnostics: {
      scope: "scope",
      status: input.status,
      changed: input.status === "changed" ? ["requestPrefixHash4096"] : [],
      changedSections,
      missReason: input.missReason,
      current: {
        systemHash: "system",
        userHash: "user",
        cacheablePrefixHash: "prefix",
        cacheableSystemHash: "system-prefix",
        cacheableUserHash: "user-prefix",
        toolSchemaHash: "tools",
        dynamicUserHash: "dynamic",
        sectionHashes: {
          system: "system-section",
          tools: "tools-section",
          workspace: "workspace-section",
          task: "task-section",
          context: "context-section",
          volatile_footer: "volatile-section"
        },
        cacheableSectionHashes: {
          system: "system-section",
          tools: "tools-section",
          workspace: "workspace-section"
        },
        requestPrefixHash1024: "1024",
        requestPrefixHash4096: "4096",
        firstDynamicBlockIndex: 1,
        cacheKey: "swarm:worker:stable:test",
        model: "deepseek-v4-flash",
        protocol: "openai-chat-completions" as const,
        retention: "in_memory" as const,
        ttlSeconds: 3600,
        anthropicTtl: "5m" as const
      },
      cachedInputTokens: input.cachedInputTokens,
      totalInputWithCacheTokens: input.totalInputWithCacheTokens,
      cacheHitRate: input.cachedInputTokens / Math.max(1, input.totalInputWithCacheTokens),
      minimumCacheableTokens: 1024
    }
  };
}
