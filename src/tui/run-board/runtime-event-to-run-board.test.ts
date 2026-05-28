import { strict as assert } from "node:assert";
import test from "node:test";
import type { RuntimeEvent } from "../../runtime/events.js";
import { createInitialRunBoardState, reduceRunBoardActions } from "./run-board-reducer.js";
import { runBoardActionsFromRuntimeEvent } from "./runtime-event-to-run-board.js";
import { selectAttentionItems, selectWorkerRows } from "./run-board-selectors.js";

const AT = "2026-05-28T00:00:00.000Z";

test("runtime event mapper projects worker events into product-facing rows", () => {
  const workerEvent: RuntimeEvent = {
    type: "worker",
    status: "running",
    worker: {
      worker_id: "worker_code_1",
      display_name: "coder/parallel",
      role_title: "coder",
      parent_session_id: "sess-1",
      agent_spec_id: "coder",
      capability: "code.implement",
      objective: "Patch session restore",
      status: "running",
      file_scope: ["src/sessions/session-row.ts"],
      tool_budget: { max_tool_calls: 10, max_turns: 3 },
      created_at: AT,
      updated_at: AT
    }
  };

  const state = reduceRunBoardActions(
    createInitialRunBoardState({ now: AT }),
    runBoardActionsFromRuntimeEvent(workerEvent, { now: AT })
  );
  const rows = selectWorkerRows(state, { now: AT });

  assert.equal(rows[0]?.label, "Code Worker");
  assert.equal(rows[0]?.status, "active");
  assert.equal(rows[0]?.currentAction, "Patch session restore");
});

test("runtime event mapper creates failed attention for failed tool result", () => {
  const event: RuntimeEvent = {
    type: "tool_result",
    task_id: "test-task",
    title: "Run focused test",
    action: "npm test -- src/tui/run-board.test.ts",
    summary: "npm test failed",
    status: "failed",
    recoverySuggestion: "Open output and fix assertion."
  };

  const state = reduceRunBoardActions(
    createInitialRunBoardState({ now: AT }),
    runBoardActionsFromRuntimeEvent(event, { now: AT })
  );

  assert.equal(selectWorkerRows(state, { now: AT })[0]?.status, "failed");
  assert.equal(selectAttentionItems(state)[0]?.kind, "failed");
  assert.match(selectAttentionItems(state)[0]?.recommendation ?? "", /Open output/);
});

test("runtime event mapper keeps approval as attention while overlay remains separate", () => {
  const event: RuntimeEvent = {
    type: "approval",
    status: "pending",
    request: {
      id: "approval-1",
      task_id: "task-1",
      tool: "shell",
      action: "npm test",
      risk: "r2",
      reason: "run verification",
      created_at: AT
    } as never
  };

  const state = reduceRunBoardActions(
    createInitialRunBoardState({ now: AT }),
    runBoardActionsFromRuntimeEvent(event, { now: AT })
  );

  const attention = selectAttentionItems(state);
  assert.equal(attention[0]?.kind, "approval");
  assert.deepEqual(attention[0]?.actions.map((action) => action.key), ["y", "n", "d"]);
});

test("runtime event mapper supports no-worker single-agent runs", () => {
  const events: RuntimeEvent[] = [
    {
      type: "session",
      session_id: "sess-main",
      status: "running",
      objective: "Explain code"
    },
    {
      type: "loop_activity",
      session_id: "sess-main",
      phase: "thinking",
      message: "Main Swarm is reading files"
    }
  ];
  const state = events.reduce(
    (current, event) => reduceRunBoardActions(current, runBoardActionsFromRuntimeEvent(event, { now: AT })),
    createInitialRunBoardState({ now: AT })
  );

  const rows = selectWorkerRows(state, { now: AT });
  assert.equal(rows[0]?.label, "Main Swarm");
  assert.equal(rows[0]?.status, "active");
});

test("runtime event mapper covers review verification queue progress and final evidence", () => {
  const events: RuntimeEvent[] = [
    {
      type: "review_started",
      session_id: "sess-1",
      objective: "Check patch risk"
    },
    {
      type: "review_completed",
      session_id: "sess-1",
      result: {
        target_task_id: "task-1",
        reviewer: { role: "reviewer" },
        verdict: "approve",
        score: 96,
        summary: "No broad regression risk.",
        issues: []
      }
    },
    {
      type: "verification_started",
      session_id: "sess-1",
      objective: "Run focused test"
    },
    {
      type: "verification_completed",
      session_id: "sess-1",
      result: {
        worker_id: "worker_test",
        status: "success",
        summary: "focused test passed"
      }
    },
    {
      type: "queue",
      session_id: "sess-1",
      queue: "worker_slots",
      operation: "enqueue",
      size: 1,
      message: "worker queued"
    },
    {
      type: "progress",
      completed: 1,
      total: 2
    },
    {
      type: "final",
      session_id: "sess-1",
      status: "completed",
      content: "Fixed session restore.",
      outcome: {
        final_summary: "Fixed session restore.",
        changed_files: ["src/runtime/session-row.ts"],
        tests_run: ["npm test -- session-row"],
        intermediate_artifacts: ["artifacts/session-row.log"]
      }
    }
  ] as RuntimeEvent[];

  const state = events.reduce(
    (current, event) => reduceRunBoardActions(current, runBoardActionsFromRuntimeEvent(event, { now: AT })),
    createInitialRunBoardState({ now: AT })
  );

  assert.equal(state.phase, "done");
  assert.deepEqual(state.resultPreview.changedFiles, ["src/runtime/session-row.ts"]);
  assert.deepEqual(state.resultPreview.checks, [{ command: "npm test -- session-row", status: "unknown" }]);
  assert.deepEqual(state.resultPreview.artifacts, ["artifacts/session-row.log"]);
  assert.deepEqual(state.resultPreview.nextActions, ["/diff", "/commit"]);
  assert.equal([...state.evidenceById.values()].some((item) => item.kind === "review" && item.summary === "No broad regression risk."), true);
  assert.equal([...state.evidenceById.values()].some((item) => item.kind === "check" && item.summary === "focused test passed"), true);
  assert.equal(selectWorkerRows(state, { now: AT }).some((row) => row.currentAction === "progress 1/2"), true);
});

test("runtime event mapper keeps unknown events as safe no-ops", () => {
  const actions = runBoardActionsFromRuntimeEvent({ type: "log", level: "info", message: "hello" } as RuntimeEvent, { now: AT });

  assert.deepEqual(actions, []);
});
