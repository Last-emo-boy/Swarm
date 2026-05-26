import { TuiTerminalEvent } from "./terminal-event.js";

export class TuiTerminalFocusEvent extends TuiTerminalEvent {
  readonly focused: boolean;

  constructor(focused: boolean) {
    super("terminal-focus", { bubbles: true, cancelable: false });
    this.focused = focused;
  }
}

