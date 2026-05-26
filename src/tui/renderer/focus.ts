import type { TuiElement } from "./dom.js";
import { TuiTerminalEvent } from "./events/terminal-event.js";

export type TuiFocusDispatcher = (target: TuiElement, event: TuiTerminalEvent) => boolean;

export class TuiFocusManager {
  activeElement: TuiElement | null = null;
  private enabled = true;
  private readonly focusStack: TuiElement[] = [];

  constructor(private readonly dispatchFocusEvent: TuiFocusDispatcher) {}

  focus(node: TuiElement): void {
    if (!this.enabled || this.activeElement === node || !node.focusable) {
      return;
    }
    const previous = this.activeElement;
    if (previous) {
      previous.focused = false;
      this.removeFromStack(previous);
      this.focusStack.push(previous);
      this.dispatchFocusEvent(previous, new TuiTerminalEvent("blur", { bubbles: false }));
    }
    node.focused = true;
    this.activeElement = node;
    this.dispatchFocusEvent(node, new TuiTerminalEvent("focus", { bubbles: false }));
  }

  blur(): void {
    const previous = this.activeElement;
    if (!previous) {
      return;
    }
    previous.focused = false;
    this.activeElement = null;
    this.dispatchFocusEvent(previous, new TuiTerminalEvent("blur", { bubbles: false }));
  }

  handleNodeRemoved(node: TuiElement, root: TuiElement): void {
    this.removeDetachedEntries(root);
    if (!this.activeElement || (this.activeElement !== node && isInTree(this.activeElement, root))) {
      return;
    }
    const removed = this.activeElement;
    removed.focused = false;
    this.activeElement = null;
    this.dispatchFocusEvent(removed, new TuiTerminalEvent("blur", { bubbles: false }));
    this.restoreFocus(root);
  }

  focusFirst(root: TuiElement): void {
    const next = collectFocusable(root)[0];
    if (next) {
      this.focus(next);
    }
  }

  focusNext(root: TuiElement): void {
    this.moveFocus(root, 1);
  }

  focusPrevious(root: TuiElement): void {
    this.moveFocus(root, -1);
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  private moveFocus(root: TuiElement, direction: 1 | -1): void {
    const focusable = collectFocusable(root);
    if (focusable.length === 0) {
      return;
    }
    const currentIndex = this.activeElement ? focusable.indexOf(this.activeElement) : -1;
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : focusable.length - 1
      : (currentIndex + direction + focusable.length) % focusable.length;
    this.focus(focusable[nextIndex]!);
  }

  private restoreFocus(root: TuiElement): void {
    while (this.focusStack.length > 0) {
      const candidate = this.focusStack.pop()!;
      if (candidate.focusable && isInTree(candidate, root)) {
        this.focus(candidate);
        return;
      }
    }
    this.focusFirst(root);
  }

  private removeFromStack(node: TuiElement): void {
    const index = this.focusStack.indexOf(node);
    if (index >= 0) {
      this.focusStack.splice(index, 1);
    }
  }

  private removeDetachedEntries(root: TuiElement): void {
    for (let index = this.focusStack.length - 1; index >= 0; index -= 1) {
      if (!isInTree(this.focusStack[index]!, root)) {
        this.focusStack.splice(index, 1);
      }
    }
  }
}

export function collectFocusable(root: TuiElement): TuiElement[] {
  const result: TuiElement[] = [];
  walk(root);
  return result;

  function walk(node: TuiElement): void {
    if (!node.hidden && node.focusable) {
      result.push(node);
    }
    for (const child of node.childNodes) {
      if (child.nodeName !== "#text") {
        walk(child);
      }
    }
  }
}

export function isInTree(node: TuiElement, root: TuiElement): boolean {
  let current: TuiElement | undefined = node;
  while (current) {
    if (current === root) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

