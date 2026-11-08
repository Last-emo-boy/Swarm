import {
  conversationMessageFoldKey,
  conversationRenderPlan,
  isFoldableConversationMessage,
  toolGroupFoldKey,
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
  const candidates = selectableMessageIndexes(messages, state.expandedKeys);
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
    // The first row of a settled group of tool calls folds and unfolds the whole group.
    const group = message && conversationRenderPlan(messages, { expandedMessageKeys: state.expandedKeys })
      .some((entry) => entry.kind === "group" && entry.first === selectedIndex);
    if (message && group) {
      const key = toolGroupFoldKey(message, selectedIndex);
      const expandedKeys = new Set(state.expandedKeys);
      if (action.type === "toggle" && expandedKeys.has(key)) {
        expandedKeys.delete(key);
      } else {
        expandedKeys.add(key);
      }
      return { selectedIndex, expandedKeys };
    }
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
  const candidates = selectableMessageIndexes(messages, state.expandedKeys);
  if (candidates.length === 0) {
    return undefined;
  }
  const index = normalizeSelectedIndex(state.selectedIndex, candidates);
  const message = messages[index];
  return message ? { index, message } : undefined;
}

/** The rows that can be selected: every shown message, and the first row of a folded group of tool calls. */
export function selectableMessageIndexes(messages: readonly ConversationMessage[], expandedKeys?: ReadonlySet<string>): number[] {
  return conversationRenderPlan(messages, { expandedMessageKeys: expandedKeys }).flatMap((entry) =>
    entry.kind === "message" ? [entry.index] : entry.expanded ? entry.indices : [entry.first]);
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
