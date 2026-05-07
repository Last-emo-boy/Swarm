import { clampCursor, nextGraphemeBoundary, previousGraphemeBoundary } from "./input-editing.js";

export type InputState = {
  value: string;
  cursor: number;
  historyIndex?: number;
  historyDraft?: string;
  dismissedCompletionKey?: string;
};

export type InputAction =
  | { type: "replace"; value: string; cursor?: number; resetHistory?: boolean; dismissedCompletionKey?: string }
  | { type: "cursor"; cursor: number; clearDismissed?: boolean }
  | { type: "history"; value: string; cursor?: number; historyIndex?: number; historyDraft?: string; clearDismissed?: boolean }
  | { type: "dismissCompletion"; key: string }
  | { type: "clearDismissed" };

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case "replace": {
      const cursor = clampCursor(action.value, action.cursor ?? action.value.length);
      return {
        value: action.value,
        cursor,
        historyIndex: action.resetHistory ? undefined : state.historyIndex,
        historyDraft: action.resetHistory ? undefined : state.historyDraft,
        dismissedCompletionKey: action.dismissedCompletionKey
      };
    }
    case "cursor":
      return {
        ...state,
        cursor: moveCursorToBoundary(state.value, state.cursor, action.cursor),
        dismissedCompletionKey: action.clearDismissed ? undefined : state.dismissedCompletionKey
      };
    case "history":
      return {
        value: action.value,
        cursor: clampCursor(action.value, action.cursor ?? action.value.length),
        historyIndex: action.historyIndex,
        historyDraft: action.historyDraft,
        dismissedCompletionKey: action.clearDismissed ? undefined : state.dismissedCompletionKey
      };
    case "dismissCompletion":
      return { ...state, dismissedCompletionKey: action.key };
    case "clearDismissed":
      return { ...state, dismissedCompletionKey: undefined };
  }
}

function moveCursorToBoundary(value: string, current: number, requested: number): number {
  if (requested < current) {
    return previousGraphemeBoundary(value, current);
  }
  if (requested > current) {
    return nextGraphemeBoundary(value, current);
  }
  return clampCursor(value, requested);
}
