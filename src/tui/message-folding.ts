import {
  conversationMessageFoldKey,
  isFoldableConversationMessage,
  type ConversationMessage
} from "./conversation-layout.js";

export type MessageCursorState = {
  selectedIndex?: number;
  expandedKeys: Set<string>;
};

export type PriorityConversationMessageReason =
  | "user"
  | "approval"
  | "failure"
  | "cache"
  | "lsp"
  | "gateway"
  | "recovery"
  | "review"
  | "result";

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

export function priorityConversationMessageReason(
  message: ConversationMessage
): PriorityConversationMessageReason | undefined {
  const text = conversationMessageSearchableText(message);
  if (message.kind === "approval" || message.status === "pending") {
    return "approval";
  }
  if (message.status === "error") {
    return "failure";
  }
  if (/\b(cache_miss|cache miss|prefix_drift|prompt cache|cached_input_tokens)\b/i.test(text)) {
    return "cache";
  }
  if (/\b(lsp|semantic fallback|fallback_reason|fallback_reasons|file\.grep\/file\.read)\b/i.test(text)) {
    return "lsp";
  }
  if (/\b(gateway|symphony|live_control|operator action|not_supported)\b/i.test(text)) {
    return "gateway";
  }
  if (/\brecovery\b|\bretry\b|next action/i.test(text)) {
    return "recovery";
  }
  if (/\breview\b/i.test(text) && message.status === "warning") {
    return "review";
  }
  if (
    message.kind === "tool_result" ||
    message.title === "Final status" ||
    message.title === "Agent completed" ||
    (message.kind === "progress" && message.status === "success")
  ) {
    return "result";
  }
  if (message.role === "user") {
    return "user";
  }
  return undefined;
}

export function priorityConversationMessageIndexes(
  messages: readonly ConversationMessage[]
): Array<{ index: number; reason: PriorityConversationMessageReason }> {
  return messages
    .map((message, index) => {
      const reason = priorityConversationMessageReason(message);
      return reason ? { index, reason } : undefined;
    })
    .filter((item): item is { index: number; reason: PriorityConversationMessageReason } => item !== undefined);
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

function conversationMessageSearchableText(message: ConversationMessage): string {
  return [
    message.role,
    message.kind,
    message.status,
    message.title,
    message.brief,
    message.preview,
    message.detail
  ].filter(Boolean).join("\n");
}
