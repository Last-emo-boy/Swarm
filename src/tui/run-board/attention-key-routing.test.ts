import { strict as assert } from "node:assert";
import test from "node:test";
import { runBoardAttentionActionForKey } from "./attention-key-routing.js";
import type { AttentionItemView } from "./run-board-types.js";

test("attention key routing returns only enabled active attention actions", () => {
  const item: AttentionItemView = {
    id: "approval-1",
    kind: "approval",
    severity: "blocking",
    title: "Approval needed",
    summary: "Allow shell command",
    recommendation: "Review before approving.",
    evidence: [],
    actions: [
      { key: "y", label: "approve" },
      { key: "n", label: "deny" },
      { key: "d", label: "details" },
      { key: "r", label: "retry", enabled: false }
    ],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z"
  };

  assert.equal(runBoardAttentionActionForKey(item, "d")?.label, "details");
  assert.equal(runBoardAttentionActionForKey(item, "D")?.label, "details");
  assert.equal(runBoardAttentionActionForKey(item, "r"), undefined);
  assert.equal(runBoardAttentionActionForKey(item, "d", { ctrl: true }), undefined);
});
