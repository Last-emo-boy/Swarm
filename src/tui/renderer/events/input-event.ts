export type TuiInputKey = {
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  tab?: boolean;
  paste?: boolean;
  backspace?: boolean;
  delete?: boolean;
  home?: boolean;
  end?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
};

export type TuiInputEvent = {
  sequence: number;
  input?: string;
  key: TuiInputKey;
  target: string;
  timestamp: number;
};

export function tuiInputEventLabel(event: Pick<TuiInputEvent, "input" | "key">): string {
  if (event.key.ctrl && event.input) {
    return `ctrl+${event.input.toLowerCase()}`;
  }
  if (event.key.return) return "return";
  if (event.key.escape) return "escape";
  if (event.key.tab) return "tab";
  if (event.key.backspace) return "backspace";
  if (event.key.delete) return "delete";
  if (event.key.upArrow) return "up";
  if (event.key.downArrow) return "down";
  if (event.key.leftArrow) return "left";
  if (event.key.rightArrow) return "right";
  return event.input ?? "";
}
