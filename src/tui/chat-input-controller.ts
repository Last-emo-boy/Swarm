import {
  editInput,
  insertInputText,
  killInputBackward,
  killInputToLineEnd,
  killInputWordBackward
} from "./input-editing.js";
import { inputReducer, type InputAction, type InputState } from "./input-state.js";
import {
  acceptSlashCommandCandidate,
  commandCandidatesForInput,
  completeSlashCommand,
  slashCommandCompletionKey,
  type SlashCommandSpec
} from "./slash-commands.js";

export type ChatInputKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export type ChatInputControllerState = {
  input: InputState;
  history: string[];
  killBuffer: string;
  completionIndex: number;
};

export type ChatInputControllerResult = {
  state: ChatInputControllerState;
  submit?: string;
};

export function createChatInputControllerState(): ChatInputControllerState {
  return {
    input: { value: "", cursor: 0 },
    history: [],
    killBuffer: "",
    completionIndex: 0
  };
}

export function chatInputCompletionCandidates(state: ChatInputControllerState): SlashCommandSpec[] {
  const key = slashCommandCompletionKey(state.input.value, state.input.cursor);
  return key && key !== state.input.dismissedCompletionKey
    ? commandCandidatesForInput(state.input.value, state.input.cursor).slice(0, 6)
    : [];
}

export function chatInputCompletionRows(state: ChatInputControllerState): number {
  const candidates = chatInputCompletionCandidates(state);
  return candidates.length > 0 ? Math.min(candidates.length, 4) + 4 : 0;
}

export function selectedChatInputCompletionIndex(state: ChatInputControllerState): number {
  const candidates = chatInputCompletionCandidates(state);
  return Math.min(state.completionIndex, Math.max(0, candidates.length - 1));
}

export function applyChatInputKey(
  state: ChatInputControllerState,
  character: string | undefined,
  key: ChatInputKey
): ChatInputControllerResult {
  if (key.escape) {
    const activeCompletionKey = slashCommandCompletionKey(state.input.value, state.input.cursor);
    if (activeCompletionKey && activeCompletionKey !== state.input.dismissedCompletionKey) {
      return {
        state: {
          ...state,
          input: reduceInputState(state.input, { type: "dismissCompletion", key: activeCompletionKey }),
          completionIndex: 0
        }
      };
    }
    return { state };
  }

  const activeCompletionKey = slashCommandCompletionKey(state.input.value, state.input.cursor);
  const activeCandidates = activeCompletionKey && activeCompletionKey !== state.input.dismissedCompletionKey
    ? commandCandidatesForInput(state.input.value, state.input.cursor)
    : [];
  const autocompleteOpen = activeCandidates.length > 0;
  if (autocompleteOpen && activeCompletionKey) {
    if (key.upArrow) {
      return {
        state: {
          ...state,
          completionIndex: state.completionIndex <= 0 ? activeCandidates.length - 1 : state.completionIndex - 1
        }
      };
    }
    if (key.downArrow) {
      return {
        state: {
          ...state,
          completionIndex: (state.completionIndex + 1) % activeCandidates.length
        }
      };
    }
    if (key.tab) {
      const completed = acceptSlashCommandCandidate(
        state.input.value,
        state.input.cursor,
        activeCandidates[state.completionIndex] ?? activeCandidates[0]
      );
      return completed
        ? { state: syncCompletion({ ...state, input: replaceInput(state.input, completed.value, completed.cursor), completionIndex: 0 }) }
        : { state };
    }
  }

  if (key.upArrow) {
    return { state: syncCompletion(recallInputHistory(state, "previous")) };
  }

  if (key.downArrow) {
    return { state: syncCompletion(recallInputHistory(state, "next")) };
  }

  if (key.leftArrow) {
    return { state: syncCompletion({ ...state, input: reduceInputState(state.input, { type: "cursor", cursor: state.input.cursor - 1, clearDismissed: true }) }) };
  }

  if (key.rightArrow) {
    return { state: syncCompletion({ ...state, input: reduceInputState(state.input, { type: "cursor", cursor: state.input.cursor + 1, clearDismissed: true }) }) };
  }

  if (key.ctrl && character === "a") {
    return { state: syncCompletion({ ...state, input: reduceInputState(state.input, { type: "cursor", cursor: 0, clearDismissed: true }) }) };
  }

  if (key.ctrl && character === "e") {
    return { state: syncCompletion({ ...state, input: reduceInputState(state.input, { type: "cursor", cursor: state.input.value.length, clearDismissed: true }) }) };
  }

  if (key.ctrl && character === "u") {
    const killed = killInputBackward(state.input.value, state.input.cursor);
    return {
      state: syncCompletion({
        ...state,
        input: replaceInput(state.input, killed.state.value, killed.state.cursor),
        killBuffer: killed.killed || state.killBuffer,
        completionIndex: 0
      })
    };
  }

  if (key.ctrl && character === "k") {
    const killed = killInputToLineEnd(state.input.value, state.input.cursor);
    return {
      state: syncCompletion({
        ...state,
        input: replaceInput(state.input, killed.state.value, killed.state.cursor),
        killBuffer: killed.killed || state.killBuffer,
        completionIndex: 0
      })
    };
  }

  if (key.ctrl && character === "w") {
    const killed = killInputWordBackward(state.input.value, state.input.cursor);
    return {
      state: syncCompletion({
        ...state,
        input: replaceInput(state.input, killed.state.value, killed.state.cursor),
        killBuffer: killed.killed || state.killBuffer,
        completionIndex: 0
      })
    };
  }

  if (key.ctrl && character === "y") {
    return state.killBuffer
      ? { state: syncCompletion(insertText(state, state.killBuffer)) }
      : { state };
  }

  if (key.tab) {
    const completed = completeSlashCommand(state.input.value, state.input.cursor);
    return completed
      ? { state: syncCompletion({ ...state, input: replaceInput(state.input, completed.value, completed.cursor), completionIndex: 0 }) }
      : { state };
  }

  if ((key.return && key.meta) || (key.ctrl && character === "j")) {
    return { state: syncCompletion(insertText(state, "\n")) };
  }

  if (key.return) {
    const objective = state.input.value.trim();
    if (!objective) {
      return { state };
    }
    return {
      state: syncCompletion({
        ...state,
        input: replaceInput(state.input, "", 0),
        history: rememberInput(state.history, objective),
        completionIndex: 0
      }),
      submit: objective
    };
  }

  if (key.backspace || (key.delete && !character)) {
    const edited = editInput(state.input.value, state.input.cursor, character, { backspace: true });
    return edited.handled
      ? { state: syncCompletion({ ...state, input: replaceInput(state.input, edited.state.value, edited.state.cursor) }) }
      : { state };
  }

  if (key.delete) {
    const edited = editInput(state.input.value, state.input.cursor, character || "[3~", {});
    return edited.handled
      ? { state: syncCompletion({ ...state, input: replaceInput(state.input, edited.state.value, edited.state.cursor) }) }
      : { state };
  }

  if (character && !key.ctrl && !key.meta) {
    return { state: syncCompletion(insertText(state, character)) };
  }

  return { state };
}

function reduceInputState(state: InputState, action: InputAction): InputState {
  return inputReducer(state, action);
}

function replaceInput(state: InputState, value: string, cursor: number): InputState {
  return reduceInputState(state, { type: "replace", value, cursor, resetHistory: true });
}

function insertText(state: ChatInputControllerState, text: string): ChatInputControllerState {
  const edited = insertInputText(state.input.value, state.input.cursor, text);
  return {
    ...state,
    input: {
      ...state.input,
      value: edited.value,
      cursor: edited.cursor,
      historyIndex: undefined,
      historyDraft: undefined,
      dismissedCompletionKey: undefined
    }
  };
}

function recallInputHistory(state: ChatInputControllerState, direction: "previous" | "next"): ChatInputControllerState {
  if (state.history.length === 0) {
    return state;
  }
  const historyIndex = state.input.historyIndex;
  const historyDraft = historyIndex === undefined ? state.input.value : state.input.historyDraft;
  const nextIndex = direction === "previous"
    ? historyIndex === undefined
      ? state.history.length - 1
      : Math.max(0, historyIndex - 1)
    : historyIndex === undefined
      ? undefined
      : historyIndex >= state.history.length - 1
        ? undefined
        : historyIndex + 1;
  const nextInput = nextIndex === undefined ? historyDraft ?? "" : state.history[nextIndex];
  return {
    ...state,
    input: reduceInputState(state.input, {
      type: "history",
      value: nextInput,
      cursor: nextInput.length,
      historyIndex: nextIndex,
      historyDraft,
      clearDismissed: true
    })
  };
}

function rememberInput(history: string[], value: string): string[] {
  const withoutDuplicateTail = history[history.length - 1] === value ? history.slice(0, -1) : history;
  return [...withoutDuplicateTail, value].slice(-100);
}

function syncCompletion(state: ChatInputControllerState): ChatInputControllerState {
  const candidates = chatInputCompletionCandidates(state);
  return {
    ...state,
    completionIndex: Math.min(state.completionIndex, Math.max(0, candidates.length - 1))
  };
}
