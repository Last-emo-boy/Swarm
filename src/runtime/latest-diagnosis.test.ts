import { strict as assert } from "node:assert";
import test from "node:test";
import { buildHeadlessArtifactIndex, type ParityReleaseGateSummary } from "./headless-artifacts.js";
import { promptCacheTrendFromStatuses } from "./prompt-cache-status.js";
import type { ResultCard } from "./result-card.js";
import { buildLatestRunDiagnosis } from "./latest-diagnosis.js";
import { createSymphonyActionFact } from "../symphony/action-lifecycle.js";

test("latest diagnosis reports no run yet", () => {
  const diagnosis = buildLatestRunDiagnosis({});

  assert.match(diagnosis.brief, /No latest run recorded/);
  assert.match(diagnosis.detail, /Latest Diagnosis/);
  assert.match(diagnosis.detail, /No run has been recorded/);
});

test("latest diagnosis summarizes completed warning result with cache data", () => {
  const cache = {
    status: "stable",
    cacheMode: "prefix-structured",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worker_coding_loop",
    hitRate: 0.64,
    cachedInputTokens: 640,
    totalInputWithCacheTokens: 1000,
    outcome: "hit" as const
  };
  const card = resultCard({
    review: { status: "warning", summary: "needs_revision 82 - minor naming issue" },
    cache,
    artifacts: ["reports/swarm-run.report.json"]
  });

  const diagnosis = buildLatestRunDiagnosis({
    resultCard: card,
    promptCache: cache,
    promptCacheTrend: promptCacheTrendFromStatuses([cache]),
    latestDetail: {
      source: "ai",
      title: "Assistant Detail",
      route: "coding_loop",
      sessionId: "session-cache"
    },
    artifactPaths: {
      telemetryPath: "reports/swarm-run.telemetry.json"
    }
  });

  assert.match(diagnosis.brief, /session session-cache/);
  assert.match(diagnosis.brief, /cache hit 64%/);
  assert.match(diagnosis.detail, /review=warning - needs_revision 82 - minor naming issue/);
  assert.match(diagnosis.detail, /provider=deepseek/);
  assert.match(diagnosis.detail, /model=deepseek-v4-flash/);
  assert.match(diagnosis.detail, /hit_rate=64%/);
  assert.match(diagnosis.detail, /reports\/swarm-run\.telemetry\.json/);
});

test("latest diagnosis reports cache section miss reasons", () => {
  const cache = {
    status: "changed",
    cacheMode: "prefix-structured",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    purpose: "worker_coding_loop",
    hitRate: 0,
    cachedInputTokens: 0,
    totalInputWithCacheTokens: 4096,
    outcome: "miss" as const,
    reason: "stable prefix changed: tools",
    recommendation: "Keep tool schemas and allowed-tool ordering deterministic across turns.",
    changed: ["requestPrefixHash4096"],
    changedSections: ["tools"],
    missReason: "changed_tools"
  };
  const diagnosis = buildLatestRunDiagnosis({
    resultCard: resultCard({ cache }),
    promptCache: cache,
    promptCacheTrend: promptCacheTrendFromStatuses([cache])
  });

  assert.match(diagnosis.detail, /cache_status=changed/);
  assert.match(diagnosis.detail, /miss_reason=changed_tools/);
  assert.match(diagnosis.detail, /changed_sections=tools/);
  assert.match(diagnosis.detail, /miss_reasons=changed_tools:1/);
  assert.match(diagnosis.detail, /reason=stable prefix changed: tools/);
  assert.match(diagnosis.detail, /recommendation=Keep tool schemas/);
});

test("latest diagnosis maps provider rate-limit failures and redacts secrets", () => {
  const diagnosis = buildLatestRunDiagnosis({
    events: [
      {
        type: "error",
        message: "HTTP 429 rate limit for Authorization: Bearer abcdefghijklmnop and apiKey=sk-testabcdef"
      }
    ],
    report: {
      schema_version: "swarm.headless.v1",
      swarm_version: "0.1.0",
      objective: "rate limit",
      workspace: "E:/Playground/Swarm",
      mode: "auto",
      started_at: "2026-05-22T00:00:00.000Z",
      ended_at: "2026-05-22T00:00:01.000Z",
      duration_ms: 1000,
      status: "failed",
      session_id: "session-rate-limit",
      telemetry: {} as never,
      artifacts: {},
      error: {
        message: "provider failed with sk-test1234567890"
      }
    }
  });

  assert.match(diagnosis.detail, /provider_rate_limit/);
  assert.match(diagnosis.detail, /Model provider rate limit or quota was hit/);
  assert.doesNotMatch(diagnosis.detail, /sk-test1234567890/);
  assert.doesNotMatch(diagnosis.detail, /sk-testabcdef/);
  assert.match(diagnosis.detail, /sk-REDACTED/);
  assert.match(diagnosis.detail, /Bearer REDACTED/);
});

test("latest diagnosis exposes command output anomaly metadata", () => {
  const diagnosis = buildLatestRunDiagnosis({
    latestDetail: {
      source: "command",
      title: "Command Output",
      route: "coding_loop",
      sessionId: "-"
    },
    events: [{
      type: "tui_focus",
      key_event: "return",
      focus_before: "input",
      focus_after: "input",
      detail_before: false,
      detail_after: false,
      detail_source: "command",
      detail_reason: "empty-enter",
      allowed: false,
      blocked_reason: "empty Enter submits input only; it must not open Command Output or change panes",
      pane_before: "chat",
      pane_after: "chat",
      route: "coding_loop",
      session_id: "-"
    }]
  });

  assert.match(diagnosis.detail, /Detail Target/);
  assert.match(diagnosis.detail, /source=command/);
  assert.match(diagnosis.detail, /title=Command Output/);
  assert.match(diagnosis.detail, /route=work \(raw=coding_loop\)/);
  assert.match(diagnosis.detail, /session_id=-/);
  assert.match(diagnosis.detail, /TUI Focus/);
  assert.match(diagnosis.detail, /key=return reason=empty-enter allowed=false focus=input->input detail=false->false pane=chat->chat/);
  assert.match(diagnosis.detail, /blocked=empty Enter submits input only/);
});

test("latest diagnosis links Gateway and Symphony operator action facts", () => {
  const actionFact = createSymphonyActionFact({
    action_id: "action-pause-1",
    correlation_id: "corr-pause-1",
    gateway_envelope_id: "env_gateway_pause_1",
    action: "pause",
    status: "not_supported",
    policy_verdict: "denied",
    risk_level: "high",
    audit_id: "audit_pause_1",
    target: {
      session_id: "session-symphony-1",
      work_item_key: "symphony:local:WK-101"
    },
    actor: { kind: "gateway", id: "gateway.symphony.operator" },
    reason: "operator smoke",
    message: "Symphony operator action pause is not supported by this local gateway yet.",
    recovery: "Use action=cancel for local cancellation.",
    error_code: "SYMPHONY_ACTION_NOT_SUPPORTED",
    attempt_id: "attempt_session_symphony_pause",
    replay: [
      { status: "requested", at: "2026-05-22T01:00:00.000Z", message: "operator smoke" },
      { status: "not_supported", at: "2026-05-22T01:00:00.000Z", message: "pause unsupported" }
    ]
  });
  const diagnosis = buildLatestRunDiagnosis({
    events: [{
      type: "tool_result",
      session_id: "session-symphony-1",
      task_id: "symphony.operator.pause",
      title: "Symphony operator pause",
      action: "symphony.pause",
      summary: "Symphony operator action pause is not supported by this local gateway yet.",
      status: "failed",
      errorCode: "SYMPHONY_ACTION_NOT_SUPPORTED",
      recoverySuggestion: "Use action=cancel for local cancellation.",
      metadata: {
        action_id: "action-pause-1",
        correlation_id: "corr-pause-1",
        action_fact: actionFact
      }
    }],
    artifactPaths: {
      reportPath: ".swarm/local-tests/run/reports/swarm-run.report.json",
      logPath: "C:/Users/dev/.swarm/logs/chat.log"
    }
  });

  assert.match(diagnosis.brief, /action pause\/not_supported/);
  assert.match(diagnosis.detail, /Control Plane/);
  assert.match(diagnosis.detail, /policy_verdict=denied/);
  assert.match(diagnosis.detail, /risk_level=high/);
  assert.match(diagnosis.detail, /audit_id=audit_pause_1/);
  assert.match(diagnosis.detail, /action_id=action-pause-1/);
  assert.match(diagnosis.detail, /correlation_id=corr-pause-1/);
  assert.match(diagnosis.detail, /gateway_envelope_id=env_gateway_pause_1/);
  assert.match(diagnosis.detail, /status=not_supported/);
  assert.match(diagnosis.detail, /target_session=session-symphony-1/);
  assert.match(diagnosis.detail, /target_work_item=symphony:local:WK-101/);
  assert.match(diagnosis.detail, /attempt_id=attempt_session_symphony_pause/);
  assert.match(diagnosis.detail, /replay=requested@2026-05-22T01:00:00.000Z:operator smoke -> not_supported@2026-05-22T01:00:00.000Z:pause unsupported/);
  assert.match(diagnosis.detail, /report=.swarm\/local-tests\/run\/reports\/swarm-run.report.json/);
  assert.match(diagnosis.detail, /log=C:\/Users\/dev\/.swarm\/logs\/chat.log/);
});

test("latest diagnosis exposes rolled back and timed out action policy facts", () => {
  const rolledBack = createSymphonyActionFact({
    action_id: "action-cancel-2",
    correlation_id: "corr-cancel-2",
    action: "cancel",
    status: "rolled_back",
    policy_verdict: "allowed",
    risk_level: "low",
    audit_id: "audit_cancel_2",
    rollback_plan: "Restore session status to running.",
    target: {
      session_id: "session-symphony-2",
      work_item_key: "symphony:local:WK-102"
    },
    actor: { kind: "gateway", id: "gateway.symphony.operator" },
    previous_status: "running",
    next_status: "cancelled",
    reason: "operator smoke",
    message: "Rolled back to running.",
    replay: [
      { status: "requested", at: "2026-05-22T02:00:00.000Z", message: "operator smoke" },
      { status: "applied", at: "2026-05-22T02:00:01.000Z", message: "Session status set to cancelled." },
      { status: "rolled_back", at: "2026-05-22T02:00:02.000Z", message: "Rolled back to running." }
    ]
  });
  const timedOut = createSymphonyActionFact({
    action_id: "action-retry-1",
    correlation_id: "corr-retry-1",
    action: "retry",
    status: "timed_out",
    policy_verdict: "risk",
    risk_level: "high",
    audit_id: "audit_retry_1",
    target: {
      session_id: "session-symphony-3",
      work_item_key: "symphony:local:WK-103"
    },
    actor: { kind: "gateway", id: "gateway.symphony.operator" },
    previous_status: "failed",
    reason: "operator smoke",
    message: "Retry timed out before completion.",
    recovery: "Use action=cancel for local cancellation.",
    replay: [
      { status: "requested", at: "2026-05-22T03:00:00.000Z", message: "operator smoke" },
      { status: "timed_out", at: "2026-05-22T03:00:01.000Z", message: "Retry timed out before completion." }
    ]
  });
  const rolledBackDiagnosis = buildLatestRunDiagnosis({
    events: [{
      type: "tool_result",
      session_id: "session-symphony-2",
      task_id: "symphony.operator.cancel",
      title: "Symphony operator cancel",
      action: "symphony.cancel",
      summary: rolledBack.message ?? "Rolled back to running.",
      status: "success",
      metadata: {
        action_id: rolledBack.action_id,
        correlation_id: rolledBack.correlation_id,
        action_fact: rolledBack
      }
    }]
  });
  const timedOutDiagnosis = buildLatestRunDiagnosis({
    events: [{
      type: "tool_result",
      session_id: "session-symphony-3",
      task_id: "symphony.operator.retry",
      title: "Symphony operator retry",
      action: "symphony.retry",
      summary: timedOut.message ?? "Retry timed out before completion.",
      status: "failed",
      errorCode: "SYMPHONY_ACTION_TIMED_OUT",
      recoverySuggestion: "Use action=cancel for local cancellation.",
      metadata: {
        action_id: timedOut.action_id,
        correlation_id: timedOut.correlation_id,
        action_fact: timedOut
      }
    }]
  });

  assert.match(rolledBackDiagnosis.detail, /action=cancel status=rolled_back policy_verdict=allowed risk_level=low audit_id=audit_cancel_2/);
  assert.match(rolledBackDiagnosis.detail, /rollback_plan=Restore session status to running\./);
  assert.match(timedOutDiagnosis.detail, /action=retry status=timed_out policy_verdict=risk risk_level=high audit_id=audit_retry_1/);
  assert.match(timedOutDiagnosis.detail, /not_rollbackable=Retry timed out before completion\./);
  assert.match(timedOutDiagnosis.detail, /recovery=Use action=cancel for local cancellation\./);
});

test("latest diagnosis shows artifact index pointers and redacts sensitive paths", () => {
  const artifactIndex = buildHeadlessArtifactIndex({
    sessionId: "session-artifact-index",
    workspace: "E:\\Playground\\Swarm",
    reportPath: "E:\\Playground\\Swarm\\.swarm\\reports\\run.report.json",
    telemetryPath: "E:\\Playground\\Swarm\\.swarm\\reports\\run.telemetry.json",
    debugLogPath: "C:\\Users\\dev\\.swarm\\logs\\session-sk-test1234567890.log"
  });
  const diagnosis = buildLatestRunDiagnosis({
    artifactIndex,
    latestDetail: {
      source: "event",
      title: "Event Detail",
      route: "coding_loop",
      sessionId: "session-artifact-index"
    }
  });

  assert.match(diagnosis.detail, /report:E:\/Playground\/Swarm\/\.swarm\/reports\/run\.report\.json/);
  assert.match(diagnosis.detail, /telemetry:E:\/Playground\/Swarm\/\.swarm\/reports\/run\.telemetry\.json/);
  assert.match(diagnosis.detail, /debug_log:C:\/Users\/dev\/\.swarm\/logs\/session-sk-REDACTED\.log/);
  assert.doesNotMatch(diagnosis.detail, /sk-test1234567890/);
});

test("latest diagnosis shows parity release gate scorecard and next task", () => {
  const releaseGate: ParityReleaseGateSummary = {
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

  const diagnosis = buildLatestRunDiagnosis({
    releaseGate,
    latestDetail: {
      source: "event",
      title: "Parity Release Gate",
      route: "coding_loop",
      sessionId: "session-release-gate"
    }
  });

  assert.match(diagnosis.brief, /release gate pass/);
  assert.match(diagnosis.detail, /Parity Release Gate/);
  assert.match(diagnosis.detail, /schema_version=swarm\.parity_release_gate\.v1/);
  assert.match(diagnosis.detail, /compared_to=Claude Code/);
  assert.match(diagnosis.detail, /dimensions=interactive_trust:pass:88/);
  assert.match(diagnosis.detail, /near_claude_code=conversation-first coding loop with result card evidence/);
  assert.match(diagnosis.detail, /dogfood_covered=TUI,cache,provider,Gateway\/Symphony,LSP fallback,artifacts/);
  assert.match(diagnosis.detail, /triage_queue=interactive_trust:pass:CAND-PROD-054-TASK-001/);
  assert.match(diagnosis.detail, /next_task=CAND-PROD-054-TASK-001/);
});

test("latest diagnosis shows protocol replay migration audit", () => {
  const diagnosis = buildLatestRunDiagnosis({
    latestDetail: {
      source: "event",
      title: "Protocol Replay Audit",
      route: "coding_loop",
      sessionId: "session-protocol-replay"
    },
    protocolAudit: {
      schema_version: "swarm.protocol_migration_audit.v1",
      generated_at: "2026-05-24T00:00:00.000Z",
      session_id: "session-protocol-replay",
      status: "warning",
      summary: {
        issues: 1,
        errors: 0,
        warnings: 1,
        replay_workers: 1,
        direct_workers: 1,
        replay_handoffs: 1,
        direct_handoffs: 1,
        replay_symphony_claims: 1,
        direct_symphony_claims: 1
      },
      issues: [{
        severity: "warning",
        source: "delivery",
        id: "envelope_deliveries",
        code: "delivery_failures_present",
        message: "failed=1 expired=0"
      }]
    }
  });

  assert.match(diagnosis.brief, /protocol replay warning/);
  assert.match(diagnosis.detail, /Protocol Replay/);
  assert.match(diagnosis.detail, /schema_version=swarm\.protocol_migration_audit\.v1/);
  assert.match(diagnosis.detail, /status=warning/);
  assert.match(diagnosis.detail, /session_id=session-protocol-replay/);
  assert.match(diagnosis.detail, /workers=replay=1 direct=1/);
  assert.match(diagnosis.detail, /handoffs=replay=1 direct=1/);
  assert.match(diagnosis.detail, /symphony=replay=1 direct=1/);
  assert.match(diagnosis.detail, /warning delivery:envelope_deliveries delivery_failures_present failed=1 expired=0/);
});

test("latest diagnosis shows semantic graph health and stale evidence refresh action", () => {
  const diagnosis = buildLatestRunDiagnosis({
    events: [{
      type: "tool_result",
      session_id: "session-lsp-semantic",
      task_id: "rename-preview",
      title: "Rename preview",
      action: "lsp.rename_preview",
      summary: "rename preview for add: 1/3 location(s)",
      status: "partial",
      metadata: {
        lsp_status: "partial",
        language: "typescript",
        provider: "typescript-language-service",
        root: ".",
        semantic_evidence: {
          schema_version: "swarm.semantic_evidence.v1",
          evidence_id: "sem:123456789abc",
          source: "lsp",
          action: "lsp.rename_preview",
          status: "partial",
          lsp_status: "partial",
          language: "typescript",
          provider: "typescript-language-service",
          root: ".",
          symbol: "add",
          range: { start: { line: 2, column: 22 }, end: { line: 2, column: 25 } },
          confidence: 0.65,
          staleness: "stale",
          stale_reason: "semantic result was truncated; refresh with a narrower query before relying on complete coverage",
          fallback_used: false,
          truncated: true,
          summary: "rename preview for add: 1/3 location(s)",
          result_keys: ["canRename", "locations"],
          primary_refs: ["src/use.ts:2:22#add"],
          changed_files: ["src/use.ts"]
        }
      }
    }]
  });

  assert.match(diagnosis.detail, /semantic_graph=health=stale evidence=1 fresh=0 stale=1 fallback=0/);
  assert.match(diagnosis.detail, /semantic_evidence_ids=sem:123456789abc/);
  assert.match(diagnosis.detail, /stale_reasons=semantic result was truncated/);
  assert.match(diagnosis.detail, /changed_files=src\/use\.ts/);
  assert.match(diagnosis.detail, /tool=lsp\.rename_preview status=partial code=partial/);
});

function resultCard(overrides: Partial<ResultCard> = {}): ResultCard {
  return {
    sessionId: "session-cache",
    status: "completed",
    route: "work",
    summary: "Implemented the requested fix.",
    changedFiles: ["src/app.ts"],
    checks: [
      { command: "npm test", status: "passed" }
    ],
    review: {
      status: "passed",
      summary: "approve 96 - ok"
    },
    risks: [],
    recovery: [],
    artifacts: [],
    next: [],
    ...overrides
  };
}
