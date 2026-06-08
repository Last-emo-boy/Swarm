import { strict as assert } from "node:assert";
import test from "node:test";
import { createInitialRunBoardState, reduceRunBoardActions } from "./run-board-reducer.js";
import { selectProductResultCardView } from "./product-result-card-selectors.js";

test("product result selector projects final card worker summary and attention history", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: "2026-05-28T00:00:00.000Z" }), [
    {
      type: "result/preview",
      at: "2026-05-28T00:00:01.000Z",
      preview: {
        contributors: [
          { workerId: "worker:code", label: "Code Worker", contribution: "implemented patch" }
        ]
      }
    },
    {
      type: "attention/upsert",
      at: "2026-05-28T00:00:02.000Z",
      item: {
        id: "att-slow",
        kind: "slow",
        severity: "warning",
        title: "Test Runner may be slow",
        summary: "Test Runner had no output for 72s",
        recommendation: "Wait briefly.",
        resolvedAt: "2026-05-28T00:01:20.000Z",
        resolution: "waited; command completed successfully"
      }
    },
    {
      type: "result/final",
      at: "2026-05-28T00:02:00.000Z",
      card: {
        status: "completed",
        sessionId: "sess-1",
        route: "work",
        summary: "Fixed session restore.",
        changedFiles: ["src/runtime/session-row.ts"],
        checks: [{ command: "npm test -- session-row", status: "passed" }],
        review: { status: "passed", summary: "review passed" },
        risks: [{ level: "medium", message: "broader verification pending" }],
        recovery: [{
          category: "sandbox",
          severity: "error",
          retryable: true,
          summary: "Sandbox blocked shell.exec.",
          nextAction: "Retry with an allowed command or request approval.",
          commandHint: "swarm run --approval-mode wait"
        }],
        checkpoint: {
          id: "cp_git_1",
          name: "Workspace checkpoint",
          mode: "git",
          revertAvailable: true
        },
        artifacts: [],
        next: ["/diff", "/commit"],
        decisionTrail: {
          split: ["Objective adopted"],
          assign: ["Code Worker owns patch"],
          verify: ["focused test passed"],
          decide: ["Reviewer approved"],
          risk: ["medium: broader verification pending"]
        }
      }
    }
  ]);

  const view = selectProductResultCardView(state);

  assert.equal(view.status, "success");
  assert.equal(view.runtimeStatus, "completed");
  assert.equal(view.risk, "medium");
  assert.deepEqual(view.changedFiles, ["src/runtime/session-row.ts"]);
  assert.deepEqual(view.workerSummary.map((item) => item.label), ["Code Worker"]);
  assert.deepEqual(view.attentionHistory.map((item) => item.resolution), ["waited; command completed successfully"]);
  assert.equal(view.recovery?.[0]?.category, "sandbox");
  assert.equal(view.recovery?.[0]?.nextAction, "Retry with an allowed command or request approval.");
  assert.equal(view.checkpoint?.id, "cp_git_1");
  assert.equal(view.checkpoint?.name, "Workspace checkpoint");
  assert.equal(view.checkpoint?.mode, "git");
  assert.equal(view.checkpoint?.revertAvailable, true);
  assert.deepEqual(view.decisionTrail?.assign, ["Code Worker owns patch"]);
  assert.deepEqual(view.nextActions.map((item) => `${item.source}:${item.command}`), ["final:/diff", "final:/commit"]);
});

test("product result selector can disable decision trail for collaboration rollback", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: "2026-05-28T00:00:00.000Z" }), [
    {
      type: "result/final",
      at: "2026-05-28T00:02:00.000Z",
      card: {
        status: "completed",
        sessionId: "sess-rollback",
        route: "team",
        summary: "Fixed session restore.",
        changedFiles: [],
        checks: [],
        review: { status: "passed", summary: "review passed" },
        risks: [],
        artifacts: [],
        next: [],
        decisionTrail: {
          split: ["Objective adopted"],
          assign: ["Code Worker owns patch"]
        }
      }
    }
  ]);

  assert.equal(selectProductResultCardView(state, { decisionTrailEnabled: true }).decisionTrail?.split?.[0], "Objective adopted");
  assert.equal(selectProductResultCardView(state, { decisionTrailEnabled: false }).decisionTrail, undefined);
});
