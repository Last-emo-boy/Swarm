import { editInput, type InputEditKey } from "./input-editing.js";

export type OnboardInputKey = InputEditKey & {
  return?: boolean;
  tab?: boolean;
};

export type OnboardInputEditResult =
  | { handled: true; value: string }
  | { handled: false };

export function editOnboardFieldInput(
  value: string,
  character: string | undefined,
  key: OnboardInputKey
): OnboardInputEditResult {
  if (key.return || key.tab) {
    return { handled: false };
  }
  const edited = editInput(value, value.length, character, key);
  return edited.handled
    ? { handled: true, value: edited.state.value }
    : { handled: false };
}
