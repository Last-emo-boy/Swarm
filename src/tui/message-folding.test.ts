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
