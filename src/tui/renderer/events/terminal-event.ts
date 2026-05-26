import type { TuiElement } from "../dom.js";

export type TuiEventPhase = "none" | "capturing" | "at_target" | "bubbling";

export type TuiTerminalEventInit = {
  bubbles?: boolean;
  cancelable?: boolean;
  timeStamp?: number;
};

export class TuiTerminalEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly timeStamp: number;
  target: TuiElement | null = null;
  currentTarget: TuiElement | null = null;
  eventPhase: TuiEventPhase = "none";
  defaultPrevented = false;
  private propagationStopped = false;
  private immediatePropagationStopped = false;

  constructor(type: string, init: TuiTerminalEventInit = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    this.timeStamp = init.timeStamp ?? Date.now();
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }

  isPropagationStopped(): boolean {
    return this.propagationStopped;
  }

  isImmediatePropagationStopped(): boolean {
    return this.immediatePropagationStopped;
  }
}

export class TuiKeyboardEvent extends TuiTerminalEvent {
  readonly input?: string;
  readonly key: Record<string, boolean | undefined>;

  constructor(input: string | undefined, key: Record<string, boolean | undefined> = {}) {
    super("keydown", { bubbles: true, cancelable: true });
    this.input = input;
    this.key = key;
  }
}

