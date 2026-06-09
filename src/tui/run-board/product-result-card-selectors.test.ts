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
  assert.equal("route" in view, false);
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
  assert.deepEqual(view.nextActions.map((item) => `${item.source}:${item.command}`), ["final:/revert last", "final:/diff", "final:/commit"]);
  assert.deepEqual(view.nextActions.map((item) => item.label), ["Undo latest change", "Review changes", "Commit when ready"]);
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

test("product result selector prioritizes the visible final action by outcome", () => {
  const success = reduceRunBoardActions(createInitialRunBoardState({ now: "2026-05-28T00:00:00.000Z" }), [
    {
      type: "result/final",
      at: "2026-05-28T00:02:00.000Z",
      card: {
        status: "completed",
        sessionId: "sess-success-actions",
        route: "work",
        summary: "Patch ready.",
        changedFiles: ["src/runtime/session-row.ts"],
        checks: [],
        review: { status: "passed", summary: "review passed" },
        risks: [],
        artifacts: [],
        next: ["/commit", "/output", "/diff"]
      }
    }
  ]);
  const failed = reduceRunBoardActions(createInitialRunBoardState({ now: "2026-05-28T00:00:00.000Z" }), [
    {
      type: "result/final",
      at: "2026-05-28T00:02:00.000Z",
      card: {
        status: "failed",
        sessionId: "sess-failed-actions",
        route: "work",
        summary: "Verification failed.",
        changedFiles: [],
        checks: [{ command: "npm run check", status: "failed" }],
        review: { status: "skipped", summary: "review not run" },
        risks: [],
        artifacts: [],
        next: ["/diff", "/output", "/debug latest"]
      }
    }
  ]);

  assert.deepEqual(selectProductResultCardView(success).nextActions.map((item) => item.command), ["/diff", "/commit", "/output"]);
  assert.deepEqual(selectProductResultCardView(failed).nextActions.map((item) => item.command), ["/debug latest", "/diff", "/output"]);
  assert.deepEqual(selectProductResultCardView(failed).nextActions.map((item) => item.label), ["Inspect latest issue", "Review changes", "Review output"]);
});

test("product result selector keeps preview commands behind user-facing labels", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: "2026-05-28T00:00:00.000Z" }), [
    {
      type: "result/preview",
      at: "2026-05-28T00:00:01.000Z",
      preview: {
        summary: "Patch ready for inspection.",
        nextActions: ["/diff", "/commit", "/output"]
      }
    }
  ]);

  const view = selectProductResultCardView(state);

  assert.equal(view.status, "preview");
  assert.deepEqual(view.nextActions.map((item) => `${item.source}:${item.command}`), ["preview:/diff", "preview:/commit", "preview:/output"]);
  assert.deepEqual(view.nextActions.map((item) => item.label), ["Review changes", "Commit when ready", "Review output"]);
});
