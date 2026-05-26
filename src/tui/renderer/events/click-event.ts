import { TuiTerminalEvent } from "./terminal-event.js";

export type TuiPointerButton = "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "unknown";

export class TuiClickEvent extends TuiTerminalEvent {
  readonly x: number;
  readonly y: number;
  readonly button: TuiPointerButton;

  constructor(init: { x: number; y: number; button?: TuiPointerButton }) {
    super("click", { bubbles: true, cancelable: true });
    this.x = Math.max(0, Math.floor(init.x));
    this.y = Math.max(0, Math.floor(init.y));
    this.button = init.button ?? "left";
  }
}

