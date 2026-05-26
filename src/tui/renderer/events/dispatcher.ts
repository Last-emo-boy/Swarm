import type { TuiInputEvent, TuiInputKey } from "./input-event.js";
import type { TuiElement } from "../dom.js";
import type { TuiTerminalEvent } from "./terminal-event.js";

export type TuiInputRoute = {
  id: string;
  priority: number;
  isActive?: () => boolean;
  handle: (event: TuiInputEvent) => boolean | void;
};

export type TuiInputDispatchResult = {
  handled: boolean;
  handlerId?: string;
  event: TuiInputEvent;
};

export class TuiInputDispatcher {
  private readonly routes = new Map<string, TuiInputRoute>();
  private sequence = 0;

  register(route: TuiInputRoute): () => void {
    this.routes.set(route.id, route);
    return () => {
      this.routes.delete(route.id);
    };
  }

  dispatch(input: string | undefined, key: TuiInputKey = {}, target = "input"): TuiInputDispatchResult {
    const event: TuiInputEvent = {
      sequence: ++this.sequence,
      input,
      key,
      target,
      timestamp: Date.now()
    };
    const routes = [...this.routes.values()]
      .filter((route) => route.isActive?.() ?? true)
      .sort((left, right) => right.priority - left.priority);
    for (const route of routes) {
      if (route.handle(event)) {
        return { handled: true, handlerId: route.id, event };
      }
    }
    return { handled: false, event };
  }

  routeIds(): string[] {
    return [...this.routes.values()]
      .sort((left, right) => right.priority - left.priority)
      .map((route) => route.id);
  }
}

export type TuiDomEventHandler = (event: TuiTerminalEvent) => void;

type TuiDomListener = {
  node: TuiElement;
  handler: TuiDomEventHandler;
  phase: "capturing" | "at_target" | "bubbling";
};

export class TuiDomEventDispatcher {
  currentEvent: TuiTerminalEvent | null = null;

  dispatch(target: TuiElement, event: TuiTerminalEvent): boolean {
    const previous = this.currentEvent;
    this.currentEvent = event;
    event.target = target;
    try {
      for (const listener of collectDomListeners(target, event)) {
        if (event.isImmediatePropagationStopped()) {
          break;
        }
        if (event.isPropagationStopped() && listener.node !== event.currentTarget) {
          break;
        }
        event.currentTarget = listener.node;
        event.eventPhase = listener.phase;
        listener.handler(event);
      }
      event.currentTarget = null;
      event.eventPhase = "none";
      return !event.defaultPrevented;
    } finally {
      this.currentEvent = previous;
    }
  }
}

function collectDomListeners(target: TuiElement, event: TuiTerminalEvent): TuiDomListener[] {
  const listeners: TuiDomListener[] = [];
  let node: TuiElement | undefined = target;
  while (node) {
    const isTarget = node === target;
    const capture = node.eventHandlers[handlerName(event.type, true)] as TuiDomEventHandler | undefined;
    const bubble = node.eventHandlers[handlerName(event.type, false)] as TuiDomEventHandler | undefined;
    if (capture) {
      listeners.unshift({ node, handler: capture, phase: isTarget ? "at_target" : "capturing" });
    }
    if (bubble && (event.bubbles || isTarget)) {
      listeners.push({ node, handler: bubble, phase: isTarget ? "at_target" : "bubbling" });
    }
    node = node.parentNode;
  }
  return listeners;
}

function handlerName(type: string, capture: boolean): string {
  const normalized = type
    .split(/[-_:]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
  return `on${normalized}${capture ? "Capture" : ""}`;
}
