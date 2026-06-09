import { strict as assert } from "node:assert";
import React from "react";
import test from "node:test";
import { buildProtocolTimelineActionRows, renderActionRowDetail, runtimeEventToActionRow } from "./action-log.js";
import { ActionLog } from "./components/ActionLog.js";
import { nextMainPane } from "./main-panes.js";
import type { TuiFrame } from "./renderer/frame.js";
import { frameText, renderTuiToFrame } from "./renderer/testing.js";
import { resolveTuiColor } from "./theme.js";

test("tool result action rows keep successful output behind details", () => {
  const row = runtimeEventToActionRow({
    type: "tool_result",
    session_id: "session-1",
    task_id: "task-1",
    title: "Read file",
    action: "file.read",
    summary: "Read README.md",
    content: "line 1\nline 2\nline 3",
    status: "success",
    outputRef: "tool-output-1"
  }, 0);

  assert.equal(row.kind, "tool");
  assert.equal(row.status, "success");
  assert.equal(row.title, "Tool file.read");
  assert.equal(row.summary, "Read README.md");
  assert(row.details.includes("line 1"));
});

test("tool result action rows show the running agent identity", () => {
  const row = runtimeEventToActionRow({
    type: "tool_result",
    session_id: "worker-loop-1",
    task_id: "task-1",
    title: "Read file",
    action: "file.read",
    summary: "Read README.md",
    content: "line 1",
    status: "success",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  }, 0);

  assert(row.details.includes("agent=Ada / Diff Investigator"));
  assert(row.details.includes("worker=worker-1"));
});

test("activity action rows show the running agent identity", () => {
  const row = runtimeEventToActionRow({
    type: "loop_activity",
    session_id: "worker-loop-1",
    phase: "running_tool",
    message: "running code build",
    turn: 2,
    tool: "code.build",
    task_id: "task-1",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  }, 0);

  assert.equal(row.kind, "work:activity");
  assert.equal(row.summary, "Ada / Diff Investigator: running code build");
  assert(row.details.includes("agent=Ada / Diff Investigator"));
  assert(row.details.includes("worker=worker-1"));
  assert(row.details.includes("agent_spec=researcher"));
  assert(row.details.includes("mode=call_subagent"));
});

test("ActionLog hides routine run identifiers in default rows", () => {
  const row = runtimeEventToActionRow({
    type: "loop_activity",
    session_id: "worker-loop-1",
    phase: "running_tool",
    message: "running code build",
    turn: 2,
    tool: "code.build",
    task_id: "task-1",
    agent: {
      worker_id: "worker-1",
      display_name: "Ada",
      role_title: "Diff Investigator",
      agent_spec_id: "researcher",
      invocation_mode: "call_subagent"
    }
  }, 0);

  assert(row.details.includes("session=worker-loop-1"));
  assert(row.details.includes("worker=worker-1"));
  assert(row.details.includes("agent_spec=researcher"));
  assert.match(renderActionRowDetail(row), /worker=worker-1/);

  const frame = renderTuiToFrame(React.createElement(ActionLog, {
    rows: [row],
    height: 8,
    columns: 120,
    scrollOffset: 0,
    onScrollOffsetChange: () => undefined,
    selectedIndex: 0
  }), { columns: 120, rows: 8 });
  const text = frameText(frame);

  assert.match(text, /Ada \/ Diff Investigator: running code build/);
  assert.doesNotMatch(text, /session=|task=|worker=worker-1|agent_spec=researcher|swarm\.work\.v1|runtime=|agent=|tool=code\.build|mode=call_subagent/);
});

test("ActionLog keeps the default header quiet", () => {
  const rows = [
    { id: "one", kind: "message:user", status: "pending" as const, title: "User request", summary: "Review auth", details: [] },
    { id: "two", kind: "tool", status: "success" as const, title: "Checked files", summary: "2 files", details: ["done"] },
    { id: "three", kind: "review", status: "running" as const, title: "Review running", summary: "Checking risks", details: ["working"] }
  ];
  const frame = renderTuiToFrame(React.createElement(ActionLog, {
    rows,
    height: 5,
    columns: 100,
    scrollOffset: 0,
    onScrollOffsetChange: () => undefined
  }), { columns: 100, rows: 5 });
  const text = frameText(frame);

  assert.match(text, /ACTIVITY/);
  assert.doesNotMatch(text, /Action Log|\d+ actions|\d+ lines|following/);

  const paused = renderTuiToFrame(React.createElement(ActionLog, {
    rows,
    height: 4,
    columns: 100,
    scrollOffset: 1,
    onScrollOffsetChange: () => undefined
  }), { columns: 100, rows: 4 });
  const pausedText = frameText(paused);

  assert.match(pausedText, /ACTIVITY\s+Paused/);
  assert.doesNotMatch(pausedText, /lines from bottom|\d+ actions|\d+ lines/);
});

test("failed tool result action rows prioritize recovery before raw output", () => {
  const row = runtimeEventToActionRow({
    type: "tool_result",
    session_id: "session-1",
    task_id: "task-1",
    title: "Run tests",
    action: "shell.exec",
    summary: "npm test failed",
    content: "long raw output line",
    status: "failed",
    outputRef: "tool-output-1",
    errorCode: "TEST_FAILED",
    recoverySuggestion: "Open the failing assertion and rerun the focused test.",
    recovery: {
      category: "tool",
      severity: "warning",
      retryable: true,
      summary: "Test command failed.",
      nextAction: "Fix the failing assertion, then rerun the focused test.",
      commandHint: "node --import tsx --test src/tui/action-log.test.ts"
    }
  }, 0);

  assert.equal(row.status, "error");
  assert.deepEqual(row.details.slice(0, 4), [
    "error=TEST_FAILED",
    "recovery=Open the failing assertion and rerun the focused test.",
    "recovery_detail=[tool/warning/retry] Test command failed. Next: Fix the failing assertion, then rerun the focused test. Hint: node --import tsx --test src/tui/action-log.test.ts",
    "diagnosis=/debug latest"
  ]);
  assert(row.details.indexOf("long raw output line") > row.details.indexOf("diagnosis=/debug latest"));
});

test("pending approval action rows show operator decision context first", () => {
  const row = runtimeEventToActionRow({
    type: "approval",
    status: "pending",
    request: {
      id: "approval-1",
      session_id: "session-1",
      task_id: "task-1",
      action: "file.write",
      summary: "Update source file",
      detail: "Patch src/tui/action-log.ts",
      risk: "write",
      risk_class: "r3",
      target: "src/tui/action-log.ts",
      why_now: "The fix needs to persist the new action-log ordering.",
      predicted_impact: "Changes TUI action-log detail order.",
      rollback_plan: "Revert src/tui/action-log.ts.",
      permission_decision: "ask",
      permission_reason: "Write access requires confirmation.",
      permission_mode: "ask",
      permission_name: "Write",
      permission_rule: "Write(src/tui/action-log.ts)"
    }
  }, 0);

  assert.equal(row.kind, "work:permission");
  assert.equal(row.status, "pending");
  assert.deepEqual(row.details.slice(0, 5), [
    "target=src/tui/action-log.ts",
    "why=The fix needs to persist the new action-log ordering.",
    "impact=Changes TUI action-log detail order.",
    "rollback=Revert src/tui/action-log.ts.",
    "next=approve or deny after checking target, impact, and rollback"
  ]);
});

test("action rows expose facets, deep links, and redacted copy summaries", () => {
  const tool = runtimeEventToActionRow({
    type: "tool_result",
    session_id: "session-1",
    task_id: "task-1",
    title: "Run LSP hover",
    action: "lsp.hover",
    summary: "LSP semantic fallback used",
    content: "fallback_reason=provider_unavailable\nAuthorization: Bearer sk-secret-1234567890",
    status: "failed",
    outputRef: "tool-output-1",
    recoverySuggestion: "Fall back to file.grep/file.read.",
    errorCode: "LSP_UNAVAILABLE"
  }, 0);

  assert(tool.facets?.includes("tool"));
  assert(tool.facets?.includes("lsp"));
  assert(tool.facets?.includes("failure"));
  assert(tool.facets?.includes("recovery"));
  assert(tool.deepLinks?.some((link) => link.kind === "session" && link.target === "session-1"));
  assert(tool.deepLinks?.some((link) => link.kind === "task" && link.target === "task-1"));
  assert(tool.deepLinks?.some((link) => link.kind === "output" && link.target === "tool-output-1"));
  assert(tool.deepLinks?.some((link) => link.kind === "diagnosis" && link.target === "/debug latest"));
  assert.doesNotMatch(tool.copySummary ?? "", /sk-secret-1234567890/);
  assert.doesNotMatch(tool.details.join("\n"), /sk-secret-1234567890/);
  assert.match(tool.details.join("\n"), /Bearer REDACTED/);

  const final = runtimeEventToActionRow({
    type: "final",
    session_id: "session-final",
    status: "completed",
    content: "Done",
    artifact_path: ".swarm/local-tests/run/reports/swarm-run.report.json",
    outcome: {
      changed_files: ["src/tui/action-log.ts"],
      tests_run: ["node --test"],
      intermediate_artifacts: [
        ".swarm/local-tests/run/trajectory.jsonl",
        ".swarm/logs/chat.log"
      ],
      final_summary: "Done"
    }
  }, 1);

  assert(final.facets?.includes("artifact"));
  assert(final.deepLinks?.some((link) => link.kind === "report"));
  assert(final.deepLinks?.some((link) => link.kind === "trajectory"));
  assert(final.deepLinks?.some((link) => link.kind === "log"));

  const detail = renderActionRowDetail(final);
  assert.match(detail, /facets: .*artifact/);
  assert.match(detail, /Links\n(?:.*\n)*link:report=/);
  assert.match(detail, /link:trajectory=/);
  assert.match(detail, /link:log=/);
  assert.match(detail, /Copy Summary\n(?:.*\n)*link:report=/);
});

test("provider usage action rows are searchable by cache diagnostics", () => {
  const row = runtimeEventToActionRow({
    type: "provider_usage",
    usage: {
      providerId: "deepseek",
      protocol: "openai-chat-completions",
      model: "deepseek-v4-flash",
      purpose: "coding",
      sessionId: "session-cache",
      taskId: "turn-2",
      cacheMode: "prefix-structured",
      promptCacheKey: "swarm:test",
      promptCacheScope: "deepseek:deepseek-v4-flash",
      promptCacheDiagnostics: {
        scope: "deepseek:deepseek-v4-flash:swarm:test",
        status: "cache_miss",
        changed: ["cacheablePrefixHash4096"],
        changedSections: ["tools"],
        missReason: "changed_tools",
        current: {
          systemHash: "sys-1",
          userHash: "user-1",
          cacheablePrefixHash: "prefix-1",
          cacheableSystemHash: "system-prefix-1",
          cacheableUserHash: "user-prefix-1",
          toolSchemaHash: "tools-1",
          dynamicUserHash: "dynamic-1",
          requestPrefixHash1024: "rp1024-1",
          requestPrefixHash4096: "rp4096-1",
          firstDynamicBlockIndex: 2,
          cacheKey: "swarm:test",
          model: "deepseek-v4-flash",
          protocol: "openai-chat-completions",
          retention: "in_memory",
          ttlSeconds: 0,
          anthropicTtl: "5m"
        },
        minimumCacheableTokens: 1024
      },
      cacheablePrefixTokensEstimate: 4096,
      durationMs: 120,
      totalTokens: 5000,
      cachedInputTokens: 0,
      totalInputWithCacheTokens: 4096,
      cacheHitRate: 0
    }
  }, 0);

  assert(row.facets?.includes("cache"));
  assert(row.deepLinks?.some((link) => link.kind === "diagnosis" && link.target === "/debug cache"));
  assert.match(row.copySummary ?? "", /facets: .*cache/);
});

test("tui focus action rows expose blocked empty Enter transitions", () => {
  const row = runtimeEventToActionRow({
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
    route: "coding",
    session_id: "session-focus"
  }, 0);

  assert.equal(row.kind, "focus");
  assert.equal(row.status, "info");
  assert.equal(row.title, "TUI focus empty-enter");
  assert(row.details.includes("key=return"));
  assert(row.details.includes("focus=input->input"));
  assert(row.details.includes("detail=false->false"));
  assert(row.details.includes("pane=chat->chat"));
  assert(row.details.some((detail) => detail.includes("blocked=empty Enter")));
  assert(row.deepLinks?.some((link) => link.kind === "diagnosis" && link.target === "/debug latest"));
});

test("gateway control rows can be filtered as operator actions", () => {
  const row = runtimeEventToActionRow({
    type: "control",
    message_id: "gateway-action-1",
    action: "interrupt_and_redirect",
    reason: "gateway operator action requested retry",
    instruction: "Retry the current work item"
  }, 0);

  assert(row.facets?.includes("gateway"));
  assert(row.deepLinks?.some((link) => link.kind === "gateway" && link.target === "gateway-action-1"));
});

test("protocol timeline action rows filter actor events for the inspector", () => {
  const rows = buildProtocolTimelineActionRows({
    events: [
      {
        type: "envelope",
        envelope: {
          id: "env-worker-a",
          version: "1.0",
          swarm_id: "swarm-1",
          session_id: "session-1",
          task_id: "task-a",
          from: { agent_id: "worker-a" },
          to: { agent_id: "router" },
          type: "task.result",
          intent: "return result",
          correlation_id: "corr-a",
          created_at: "2026-05-25T00:00:00.000Z",
          payload: { owner_agent_id: "worker-a" }
        }
      },
      {
        type: "envelope",
        envelope: {
          id: "env-worker-b",
          version: "1.0",
          swarm_id: "swarm-1",
          session_id: "session-1",
          task_id: "task-b",
          from: { agent_id: "worker-b" },
          to: { agent_id: "router" },
          type: "task.result",
          intent: "return result",
          correlation_id: "corr-b",
          created_at: "2026-05-25T00:00:01.000Z",
          payload: { owner_agent_id: "worker-b" }
        }
      }
    ],
    filter: { actorId: "worker-a" }
  });

  assert.equal(rows.length, 2);
  assert(rows.every((row) => row.facets?.includes("protocol")));
  assert(rows.every((row) => row.deepLinks?.some((link) => link.kind === "diagnosis" && link.target.includes("corr-a"))));
  const detail = rows.map(renderActionRowDetail).join("\n---\n");
  assert.match(detail, /actor=worker-a/);
  assert.match(detail, /correlation=corr-a/);
  assert.doesNotMatch(detail, /worker-b|corr-b/);
});

test("main pane navigation remains explicit through slash view routing", () => {
  assert.equal(nextMainPane("board", 1), "trace");
  assert.equal(nextMainPane("board", -1), "plan");
  assert.equal(nextMainPane("plan", 1), "board");
  assert.equal(nextMainPane("chat", 1), "plan");
  assert.equal(nextMainPane("sessions", 1), "chat");
  assert.equal(nextMainPane("sessions", -1), "trace");
});

test("ActionLog renders status and kind accents without tinting neutral titles", () => {
  const frame = renderTuiToFrame(React.createElement(ActionLog, {
    rows: [{
      id: "row-1",
      kind: "tool",
      status: "error",
      title: "Tool shell.exec",
      summary: "Command: npm run check",
      meta: "artifact=E:/Playground/Swarm/.swarm/reports/check.report.json",
      details: [
        "error=TEST_FAILED",
        "+added line",
        "-removed line"
      ],
      facets: ["tool", "failure"],
      deepLinks: [],
      copySummary: "ERROR Tool shell.exec"
    }],
    height: 8,
    columns: 96,
    scrollOffset: 0,
    onScrollOffsetChange: () => undefined,
    selectedIndex: 0
  }), { columns: 96, rows: 8 });

  assert.equal(colorAtText(frame, "[ERR]"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "[TOOL]"), resolveTuiColor("role.tool"));
  assert.equal(colorAtText(frame, "Tool shell.exec"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "⏵"), resolveTuiColor("role.tool"));
  assert.equal(colorAtTextAfter(frame, "⏵", "shell"), resolveTuiColor("role.tool"));
  assert.equal(colorAtText(frame, "npm run check"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "⎿"), resolveTuiColor("text.muted"));
  assert.equal(colorAtText(frame, "error"), resolveTuiColor("status.danger"));
  assert.equal(colorAtText(frame, "TEST_FAILED"), resolveTuiColor("text.primary"));
  assert.equal(colorAtText(frame, "diff"), resolveTuiColor("role.gateway"));
  assert.equal(colorAtText(frame, "+"), resolveTuiColor("diff.added"));
  assert.equal(colorAtText(frame, "-"), resolveTuiColor("diff.removed"));
});

function colorAtText(frame: TuiFrame, needle: string): string | undefined {
  for (const row of frame.screen.cells) {
    const line = row.map((cell) => cell.char).join("");
    const index = line.indexOf(needle);
    if (index >= 0) {
      const offset = [...needle].findIndex((char) => char.trim().length > 0);
      return row[index + Math.max(0, offset)]?.style.color;
    }
  }
  return undefined;
}

function colorAtTextAfter(frame: TuiFrame, anchor: string, needle: string): string | undefined {
  for (const row of frame.screen.cells) {
    const line = row.map((cell) => cell.char).join("");
    const anchorIndex = line.indexOf(anchor);
    if (anchorIndex < 0) {
      continue;
    }
    const index = line.indexOf(needle, anchorIndex + anchor.length);
    if (index >= 0) {
      const offset = [...needle].findIndex((char) => char.trim().length > 0);
      return row[index + Math.max(0, offset)]?.style.color;
    }
  }
  return undefined;
}
