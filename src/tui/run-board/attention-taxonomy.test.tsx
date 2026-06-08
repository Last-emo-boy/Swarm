import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { renderTuiToFrame, frameText } from "../renderer/testing.js";
import { AttentionPanel } from "./AttentionPanel.js";
import type { AttentionItemView } from "./run-board-types.js";

test("AttentionPanel renders all exception taxonomy kinds with concise user-facing next steps", () => {
  const items: AttentionItemView[] = [
    attention("slow", "Slow test", "Test command still running, no output for 72s."),
    attention("blocked", "Reviewer blocked", "Reviewer is waiting for Test Runner."),
    attention("conflicted", "Patch conflict", "Code Worker suggests patch A, Reviewer recommends patch B."),
    attention("uncertain", "Direction needed", "Swarm found two possible fixes and needs direction."),
    attention("failed", "Command failed", "Command exited 1 after patch."),
    attention("approval", "Approval needed", "File write needs approval.")
  ];

  const frame = renderTuiToFrame(React.createElement(AttentionPanel, { items }), { columns: 132, rows: 28 });
  const text = frameText(frame);

  for (const item of items) {
    assert.match(text, new RegExp(item.title));
    assert.match(text, new RegExp(item.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, new RegExp(item.evidence[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((text.match(/Next/g) ?? []).length, items.length);
  assert.doesNotMatch(text, /recommend:|activity:/);
  assert.match(text, /\[ASK\] Approval needed/);
  assert.match(text, /\[ERR\] Command failed/);
  assert.doesNotMatch(text, /handoff contract id|lease participant|blackboard claim owner|ASP/);
});

test("AttentionPanel hides why evidence already covered by the summary", () => {
  const item = attention("blocked", "Reviewer blocked", "Reviewer is waiting for Test Runner.");
  item.evidence = ["Reviewer is waiting for Test Runner."];

  const frame = renderTuiToFrame(React.createElement(AttentionPanel, { items: [item] }), { columns: 100, rows: 8 });
  const text = frameText(frame);

  assert.match(text, /Reviewer blocked/);
  assert.match(text, /Next\s+recommended action for blocked/);
  assert.doesNotMatch(text, /Why\s+Reviewer is waiting for Test Runner\./);
});

function attention(kind: AttentionItemView["kind"], title: string, summary: string): AttentionItemView {
  return {
    id: kind,
    kind,
    severity: kind === "failed" ? "failed" : kind === "approval" ? "blocking" : "warning",
    title,
    summary,
    evidence: [`evidence for ${kind}`],
    recommendation: `recommended action for ${kind}`,
    actions: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z"
  };
}
