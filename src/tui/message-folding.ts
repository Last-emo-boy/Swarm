import {
  conversationMessageFoldKey,
  isFoldableConversationMessage,
  type ConversationMessage
} from "./conversation-layout.js";

export type MessageCursorState = {
  selectedIndex?: number;
  expandedKeys: Set<string>;
};

export type MessageCursorAction =
  | { type: "previous" }
  | { type: "next" }
  | { type: "select"; index: number }
  | { type: "toggle" }
  | { type: "open" }
  | { type: "clear" };

export function createMessageCursorState(): MessageCursorState {
  return {
    expandedKeys: new Set()
  };
}

export function messageCursorReducer(
  state: MessageCursorState,
  action: MessageCursorAction,
  messages: readonly ConversationMessage[]
): MessageCursorState {
  const candidates = selectableMessageIndexes(messages);
  if (candidates.length === 0) {
    return { expandedKeys: new Set(state.expandedKeys) };
  }
  const current = normalizeSelectedIndex(state.selectedIndex, candidates);
  if (action.type === "previous" || action.type === "next") {
    const delta = action.type === "previous" ? -1 : 1;
    return {
      ...state,
      selectedIndex: stepMessageIndex(candidates, current, delta),
      expandedKeys: new Set(state.expandedKeys)
    };
  }
  if (action.type === "select") {
    return {
      ...state,
      selectedIndex: clampMessageIndex(action.index, candidates),
      expandedKeys: new Set(state.expandedKeys)
    };
  }
  if (action.type === "clear") {
    return {
      expandedKeys: new Set(state.expandedKeys)
    };
  }
  if (action.type === "toggle" || action.type === "open") {
    const selectedIndex = current;
    const message = messages[selectedIndex];
    if (!message || !isFoldableConversationMessage(message)) {
      return {
        ...state,
        selectedIndex,
        expandedKeys: new Set(state.expandedKeys)
      };
    }
    const key = conversationMessageFoldKey(message, selectedIndex);
    const expandedKeys = new Set(state.expandedKeys);
    if (action.type === "toggle" && expandedKeys.has(key)) {
      expandedKeys.delete(key);
    } else {
      expandedKeys.add(key);
    }
    return { selectedIndex, expandedKeys };
  }
  return state;
}

export function selectedConversationMessage(
  state: MessageCursorState,
  messages: readonly ConversationMessage[]
): { index: number; message: ConversationMessage } | undefined {
  const candidates = selectableMessageIndexes(messages);
  if (candidates.length === 0) {
    return undefined;
  }
  const index = normalizeSelectedIndex(state.selectedIndex, candidates);
  const message = messages[index];
  return message ? { index, message } : undefined;
}

export function selectableMessageIndexes(messages: readonly ConversationMessage[]): number[] {
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.kind !== "logo")
    .map(({ index }) => index);
}

function normalizeSelectedIndex(selectedIndex: number | undefined, candidates: number[]): number {
  if (selectedIndex !== undefined && candidates.includes(selectedIndex)) {
    return selectedIndex;
  }
  return candidates.at(-1) ?? 0;
}

function stepMessageIndex(candidates: number[], selectedIndex: number, delta: number): number {
  const current = Math.max(0, candidates.indexOf(selectedIndex));
  const next = (current + delta + candidates.length) % candidates.length;
  return candidates[next] ?? selectedIndex;
}

function clampMessageIndex(index: number, candidates: number[]): number {
  if (candidates.includes(index)) {
    return index;
  }
  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - index) < Math.abs(closest - index) ? candidate : closest
  , candidates[0]!);
}
