import { strict as assert } from "node:assert";
import test from "node:test";
import {
  conversationMessageFoldKey,
  renderConversationMessageLines,
  type ConversationMessage
} from "./conversation-layout.js";
import {
  createMessageCursorState,
  messageCursorReducer,
  priorityConversationMessageIndexes,
  priorityConversationMessageReason,
  selectedConversationMessage
} from "./message-folding.js";

test("message cursor selects rows and persists fold state by stable message key", () => {
  const rows = messages();
  let state = createMessageCursorState();

  state = messageCursorReducer(state, { type: "previous" }, rows);
  assert.equal(selectedConversationMessage(state, rows)?.index, 1);

  state = messageCursorReducer(state, { type: "next" }, rows);
  assert.equal(selectedConversationMessage(state, rows)?.index, 2);

  state = messageCursorReducer(state, { type: "toggle" }, rows);
  assert(state.expandedKeys.has(conversationMessageFoldKey(rows[2]!, 2)));

  state = messageCursorReducer(state, { type: "toggle" }, rows);
  assert.equal(state.expandedKeys.size, 0);
});

test("foldable transcript rows are compact by default and expanded on demand", () => {
  const row: ConversationMessage = {
    role: "system",
    kind: "tool_result",
    status: "success",
    brief: "shell.exec: command exited 0",
    preview: "shell.exec: command exited 0\nshort",
    detail: "shell.exec: command exited 0\nshort\nfull line"
  };
  const compact = renderConversationMessageLines(row, 80);
  const expanded = renderConversationMessageLines(row, 80, {
    expandedMessageKeys: new Set([conversationMessageFoldKey(row, 0)])
  });

  assert.equal(compact.length, 1);
  assert.match(compact[0]?.text ?? "", /shell\.exec/);
  assert.doesNotMatch(compact.map((line) => line.text).join("\n"), /full line/);
  assert.match(expanded.map((line) => line.text).join("\n"), /full line/);
});

test("priority transcript rows keep failures, recovery, cache, LSP, Gateway, approvals, reviews, results, and user prompts inspectable", () => {
  const rows: ConversationMessage[] = [
    { role: "user", brief: "Fix the failing eval." },
    { role: "system", kind: "thinking", status: "running", brief: "Thinking about it" },
    { role: "system", kind: "approval", status: "pending", brief: "approve file edit" },
    { role: "system", kind: "tool_result", status: "error", brief: "file.edit failed" },
    { role: "system", kind: "progress", status: "warning", brief: "Prompt cache cache_miss missReason=prefix_drift" },
    { role: "system", kind: "progress", status: "warning", brief: "LSP fallback_reason=provider_unavailable; use file.grep/file.read" },
    { role: "system", kind: "progress", status: "warning", brief: "Gateway operator action not_supported live_control=blocked" },
    { role: "system", kind: "progress", status: "warning", brief: "Review warning: possible regression" },
    { role: "system", kind: "progress", status: "warning", brief: "Recovery: retry with a narrower patch" },
    { role: "assistant", kind: "progress", status: "success", title: "Agent completed", brief: "Finished" }
  ];

  assert.equal(priorityConversationMessageReason(rows[0]!), "user");
  assert.equal(priorityConversationMessageReason(rows[1]!), undefined);
  assert.equal(priorityConversationMessageReason(rows[2]!), "approval");
  assert.equal(priorityConversationMessageReason(rows[3]!), "failure");
  assert.equal(priorityConversationMessageReason(rows[4]!), "cache");
  assert.equal(priorityConversationMessageReason(rows[5]!), "lsp");
  assert.equal(priorityConversationMessageReason(rows[6]!), "gateway");
  assert.equal(priorityConversationMessageReason(rows[7]!), "review");
  assert.equal(priorityConversationMessageReason(rows[8]!), "recovery");
  assert.equal(priorityConversationMessageReason(rows[9]!), "result");
  assert.deepEqual(priorityConversationMessageIndexes(rows), [
    { index: 0, reason: "user" },
    { index: 2, reason: "approval" },
    { index: 3, reason: "failure" },
    { index: 4, reason: "cache" },
    { index: 5, reason: "lsp" },
    { index: 6, reason: "gateway" },
    { index: 7, reason: "review" },
    { index: 8, reason: "recovery" },
    { index: 9, reason: "result" }
  ]);
});

function messages(): ConversationMessage[] {
  return [
    { role: "user", brief: "first prompt" },
    { role: "assistant", kind: "thinking", status: "running", brief: "Thinking about it" },
    {
      role: "system",
      kind: "tool_result",
      status: "success",
      brief: "shell.exec: command exited 0",
      detail: "line one\nline two"
    }
  ];
}
