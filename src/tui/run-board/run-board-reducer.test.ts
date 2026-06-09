import { strict as assert } from "node:assert";
import test from "node:test";
import { createInitialRunBoardState, reduceRunBoardActions, runBoardReducer } from "./run-board-reducer.js";
import { formatWorkerRow } from "./run-board-row-format.js";
import { selectAttentionHistory, selectAttentionItems, selectRunBoardPhase, selectRunBoardSurface, selectWorkerRows, summarizeRunBoardCounts } from "./run-board-selectors.js";

const AT = "2026-05-28T00:00:00.000Z";

test("run board reducer tracks worker lifecycle and preserves status age", () => {
  const initial = createInitialRunBoardState({ runId: "sess-1", objective: "Fix tests", now: AT });
  const active = runBoardReducer(initial, {
    type: "worker/upsert",
    at: "2026-05-28T00:00:01.000Z",
    worker: {
      id: "worker:code",
      label: "Code Worker",
      role: "code",
      status: "active",
      currentAction: "editing patch"
    }
  });
  const updated = runBoardReducer(active, {
    type: "worker/upsert",
    at: "2026-05-28T00:00:05.000Z",
    worker: {
      id: "worker:code",
      currentAction: "running focused test"
    }
  });
  const done = runBoardReducer(updated, {
    type: "worker/upsert",
    at: "2026-05-28T00:00:08.000Z",
    worker: {
      id: "worker:code",
      status: "done",
      currentAction: "patch complete"
    }
  });

  assert.equal(updated.workersById.get("worker:code")?.statusChangedAt, "2026-05-28T00:00:01.000Z");
  assert.equal(done.workersById.get("worker:code")?.statusChangedAt, "2026-05-28T00:00:08.000Z");
  assert.equal(done.workersById.get("worker:code")?.status, "done");
});

test("run board reducer links attention and evidence", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: AT }), [
    {
      type: "evidence/append",
      evidence: {
        id: "ev-1",
        kind: "tool",
        summary: "npm test failed",
        at: AT,
        status: "failed"
      }
    },
    {
      type: "attention/upsert",
      at: AT,
      item: {
        id: "att-1",
        kind: "failed",
        severity: "failed",
        title: "Tool failed",
        summary: "npm test failed",
        evidenceIds: ["ev-1"],
        recommendation: "Inspect output, fix, then retry."
      }
    }
  ]);

  assert.equal(state.phase, "waiting-attention");
  assert.deepEqual(selectAttentionItems(state).map((item) => item.evidence), [["npm test failed"]]);
});

test("run board surface focuses active attention without a subject worker", () => {
  const state = runBoardReducer(createInitialRunBoardState({ now: AT }), {
    type: "attention/upsert",
    at: AT,
    item: {
      id: "approval:1",
      kind: "approval",
      severity: "blocking",
      title: "Approval needed",
      summary: "Allow shell command",
      recommendation: "Approve only if the command matches the objective.",
      actions: [{ key: "d", label: "details" }]
    }
  });

  assert.equal(selectRunBoardSurface(state, { now: AT }).focus, "Approval needed");
});

test("run board reducer ignores repeated display-equivalent evidence", () => {
  const evidence = {
    id: "ev-repeat",
    kind: "tool" as const,
    summary: "npm test still running",
    at: AT,
    status: "running" as const
  };
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: AT }), [
    { type: "evidence/append", evidence },
    { type: "evidence/append", evidence: { ...evidence, at: "2026-05-28T00:00:01.000Z" } }
  ]);

  assert.equal(state.evidenceById.size, 1);
  assert.equal(state.resultPreview.summary, "npm test still running");
});

test("run board reducer updates evidence when repeated id carries new status", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: AT }), [
    {
      type: "evidence/append",
      evidence: {
        id: "ev-check",
        kind: "check",
        summary: "npm test",
        command: "npm test",
        at: AT,
        status: "running"
      }
    },
    {
      type: "evidence/append",
      evidence: {
        id: "ev-check",
        kind: "check",
        summary: "npm test",
        command: "npm test",
        at: "2026-05-28T00:00:01.000Z",
        status: "success"
      }
    }
  ]);

  assert.equal(state.evidenceById.size, 1);
  assert.deepEqual(state.resultPreview.checks, [{ command: "npm test", status: "passed" }]);
});

test("run board reducer records contributors only from completed worker evidence", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: AT }), [
    {
      type: "evidence/append",
      evidence: {
        id: "ev-running",
        kind: "worker",
        summary: "running focused test",
        at: AT,
        workerId: "worker_test",
        status: "running"
      }
    },
    {
      type: "evidence/append",
      evidence: {
        id: "ev-done",
        kind: "worker",
        summary: "verified focused test",
        at: "2026-05-28T00:00:01.000Z",
        workerId: "worker_test",
        workerLabel: "Test Runner",
        status: "success"
      }
    }
  ]);

  assert.deepEqual(state.resultPreview.contributors, [{
    workerId: "worker_test",
    label: "Test Runner",
    contribution: "verified focused test"
  }]);
});

test("worker selector hides internal ids and computes elapsed time", () => {
  const state = runBoardReducer(createInitialRunBoardState({ now: AT }), {
    type: "worker/upsert",
    at: AT,
    worker: {
      id: "worker:worker_123",
      label: "Test Runner",
      role: "test",
      status: "active",
      currentAction: "running focused test",
      sourceIds: { workerId: "worker_123" }
    }
  });

  const rows = selectWorkerRows(state, { now: "2026-05-28T00:01:12.000Z" });

  assert.equal(rows[0]?.label, "Test Runner");
  assert.equal(rows[0]?.elapsedMs, 72_000);
  assert.doesNotMatch(formatWorkerRow(rows[0]!, 100), /worker_123/);
});

test("selectors derive slow attention from stale active workers", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({
    now: AT,
    config: { slowThresholdMs: 60_000 }
  }), [
    {
      type: "evidence/append",
      evidence: {
        id: "ev-test",
        kind: "command",
        summary: "npm test -- src/runtime/session-row.test.ts",
        at: AT,
        status: "running"
      }
    },
    {
      type: "worker/upsert",
      at: AT,
      worker: {
        id: "worker:test",
        label: "Test Runner",
        role: "test",
        status: "active",
        currentAction: "running focused test",
        lastEvidenceId: "ev-test"
      }
    }
  ]);

  assert.equal(selectAttentionItems(state, { now: "2026-05-28T00:00:59.000Z" }).length, 0);
  const attention = selectAttentionItems(state, { now: "2026-05-28T00:01:12.000Z" });

  assert.equal(attention[0]?.kind, "slow");
  assert.equal(attention[0]?.subjectWorkerId, "worker:test");
  assert.match(attention[0]?.summary ?? "", /No new evidence for 72s/);
  assert.equal(attention[0]?.recommendation, "Wait briefly if the process is still alive; review output before stopping.");
  assert.doesNotMatch(attention[0]?.recommendation ?? "", /inspect output/i);
  assert.deepEqual(attention[0]?.evidence, ["npm test -- src/runtime/session-row.test.ts"]);
  assert.equal(selectRunBoardPhase(state, { now: "2026-05-28T00:01:12.000Z" }), "waiting-attention");
  assert.equal(summarizeRunBoardCounts(state, { now: "2026-05-28T00:01:12.000Z" }).stuck, 1);
});

test("run board reducer archives resolved slow attention for result history", () => {
  const stale = reduceRunBoardActions(createInitialRunBoardState({
    now: AT,
    config: { slowThresholdMs: 60_000 }
  }), [
    {
      type: "evidence/append",
      evidence: {
        id: "ev-test",
        kind: "command",
        summary: "npm test -- src/runtime/session-row.test.ts",
        at: AT,
        status: "running"
      }
    },
    {
      type: "worker/upsert",
      at: AT,
      worker: {
        id: "worker:test",
        label: "Test Runner",
        role: "test",
        status: "active",
        currentAction: "running focused test",
        lastEvidenceId: "ev-test"
      }
    }
  ]);

  const withHistory = reduceRunBoardActions(stale, [{
    type: "attention/archive-derived-slow",
    at: "2026-05-28T00:01:12.000Z",
    workerIds: ["worker:test"],
    resolution: "waited; command completed successfully"
  }, {
    type: "worker/upsert",
    at: "2026-05-28T00:01:13.000Z",
    worker: {
      id: "worker:test",
      status: "done",
      currentAction: "focused test passed"
    }
  }]);

  assert.equal(selectAttentionItems(withHistory, { now: "2026-05-28T00:01:14.000Z" }).length, 0);
  const history = selectAttentionHistory(withHistory);
  assert.equal(history[0]?.kind, "slow");
  assert.equal(history[0]?.resolvedAt, "2026-05-28T00:01:12.000Z");
  assert.equal(history[0]?.resolution, "waited; command completed successfully");
  assert.deepEqual(history[0]?.evidence, ["npm test -- src/runtime/session-row.test.ts"]);
});

test("final result card feeds result preview continuity", () => {
  const state = runBoardReducer(createInitialRunBoardState({ now: AT }), {
    type: "result/final",
    at: AT,
    card: {
      status: "completed",
      sessionId: "sess-1",
      route: "work",
      summary: "Fixed session restore.",
      changedFiles: ["src/runtime/session-row.ts"],
      checks: [{ command: "npm test -- session-row", status: "passed" }],
      review: { status: "passed", summary: "review passed" },
      risks: [{ level: "medium", message: "broader verification pending" }],
      artifacts: ["artifacts/session-row.log"],
      next: ["/diff", "/commit"]
    }
  });

  assert.equal(state.phase, "done");
  assert.equal(state.finalResult?.summary, "Fixed session restore.");
  assert.equal(state.resultPreview.summary, "Fixed session restore.");
  assert.deepEqual(state.resultPreview.changedFiles, ["src/runtime/session-row.ts"]);
  assert.deepEqual(state.resultPreview.checks, [{ command: "npm test -- session-row", status: "passed" }]);
  assert.deepEqual(state.resultPreview.artifacts, ["artifacts/session-row.log"]);
  assert.deepEqual(state.resultPreview.blockers, ["broader verification pending"]);
  assert.deepEqual(state.resultPreview.risks, [{ level: "medium", summary: "broader verification pending" }]);
  assert.deepEqual(state.resultPreview.nextActions, ["/diff", "/commit"]);
});
