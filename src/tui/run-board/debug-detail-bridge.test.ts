import { strict as assert } from "node:assert";
import test from "node:test";
import { createInitialRunBoardState, reduceRunBoardActions } from "./run-board-reducer.js";
import { formatWorkerRow } from "./run-board-row-format.js";
import { selectDebugRefsForRow, selectWorkerRows } from "./run-board-selectors.js";

test("debug refs expose protocol evidence only through explicit detail selectors", () => {
  const state = reduceRunBoardActions(createInitialRunBoardState({ now: "2026-05-28T00:00:00.000Z" }), [
    {
      type: "evidence/append",
      evidence: {
        id: "ev-handoff",
        kind: "handoff",
        summary: "Reviewer accepted the patch",
        at: "2026-05-28T00:00:00.000Z",
        status: "success"
      }
    },
    {
      type: "worker/upsert",
      at: "2026-05-28T00:00:00.000Z",
      worker: {
        id: "worker:reviewer",
        label: "Reviewer",
        role: "review",
        status: "done",
        currentAction: "checked patch risk",
        lastEvidenceId: "ev-handoff",
        sourceIds: {
          workerId: "worker_internal_123",
          taskId: "task_internal_456",
          handoffId: "handoff_contract_789",
          sessionId: "sess_abc"
        }
      }
    }
  ]);

  const row = selectWorkerRows(state, { now: "2026-05-28T00:00:01.000Z" })[0]!;
  const defaultText = formatWorkerRow(row, 120);

  assert.match(defaultText, /Reviewer/);
  assert.doesNotMatch(defaultText, /worker_internal_123|task_internal_456|handoff_contract_789|sess_abc/);
  assert.deepEqual(selectDebugRefsForRow(state, "worker:reviewer"), [
    "worker:worker_internal_123",
    "task:task_internal_456",
    "handoff:handoff_contract_789",
    "session:sess_abc",
    "evidence:ev-handoff"
  ]);
});
