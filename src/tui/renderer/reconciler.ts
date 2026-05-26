import React from "react";
import createReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import {
  appendChild,
  createElement,
  createRootElement,
  createTextNode,
  insertBefore,
  removeChild,
  setAttribute,
  setTextNodeValue,
  type TuiElement,
  type TuiElementName,
  type TuiNode,
  type TuiNodeAttribute,
  type TuiTextNode
} from "./dom.js";

type Props = Record<string, unknown>;
type HostContext = {
  insideText: boolean;
};
type UpdatePayload = {
  attributes: Record<string, TuiNodeAttribute>;
  handlers: Record<string, unknown>;
  handlerDeletes: string[];
};
type RootContainer = TuiElement;

const EVENT_HANDLER_PATTERN = /^on[A-Z]/;
const commitCallbacks = new WeakMap<RootContainer, () => void>();

export type ReconcileOptions = {
  ownerChain?: string[];
  onCommit?: () => void;
};

export type TuiReactRoot = {
  container: unknown;
  root: TuiElement;
  render: (node: React.ReactNode) => void;
  unmount: () => void;
};

const reconciler = createReconciler<
  TuiElementName,
  Props,
  RootContainer,
  TuiElement,
  TuiTextNode,
  TuiNode,
  TuiNode,
  TuiElement,
  HostContext,
  UpdatePayload | null,
  null,
  NodeJS.Timeout,
  -1
>({
  getRootHostContext: () => ({ insideText: false }),
  getChildHostContext(parentHostContext, type) {
    const insideText = parentHostContext.insideText ||
      type === "swarm-text" ||
      type === "swarm-virtual-text" ||
      type === "swarm-link" ||
      type === "swarm-no-select";
    return insideText === parentHostContext.insideText ? parentHostContext : { insideText };
  },
  getPublicInstance: (instance) => instance as TuiElement,
  prepareForCommit: () => null,
  resetAfterCommit(container) {
    commitCallbacks.get(container)?.();
  },
  preparePortalMount() {},
  shouldSetTextContent: () => false,
  createInstance(type, props, _root, hostContext, internalHandle): TuiElement {
    if (hostContext.insideText && type === "swarm-box") {
      throw new Error("<Box> can't be nested inside <Text> component.");
    }
    const node = createElement(hostContext.insideText && type === "swarm-box" ? "swarm-virtual-text" : type);
    node.debugOwnerChain = ownerChainFromFiber(internalHandle, type);
    applyProps(node, props);
    return node;
  },
  createTextInstance(text, _root, hostContext): TuiTextNode {
    if (!hostContext.insideText) {
      throw new Error(`Text string "${text}" must be rendered inside <Text> component.`);
    }
    const node = createTextNode(text);
    node.debugOwnerChain = ["Text"];
    return node;
  },
  appendInitialChild(parent, child) {
    appendChild(parent, child);
  },
  finalizeInitialChildren: () => false,
  prepareUpdate(_instance, _type, oldProps, newProps): UpdatePayload | null {
    const payload: UpdatePayload = { attributes: {}, handlers: {}, handlerDeletes: [] };
    let changed = false;
    for (const key of Object.keys(oldProps)) {
      if (key === "children") {
        continue;
      }
      if (!(key in newProps)) {
        if (isEventHandlerProp(key)) {
          payload.handlerDeletes.push(key);
        } else {
          payload.attributes[key] = undefined;
        }
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(newProps)) {
      if (key === "children") {
        continue;
      }
      if (oldProps[key] !== value) {
        if (isEventHandlerProp(key)) {
          payload.handlers[key] = value;
        } else {
          payload.attributes[key] = normalizeAttribute(value);
        }
        changed = true;
      }
    }
    return changed ? payload : null;
  },
  commitUpdate(instance, updatePayload) {
    if (!updatePayload) {
      return;
    }
    for (const [key, value] of Object.entries(updatePayload.attributes)) {
      setAttribute(instance, key, value);
    }
    for (const [key, value] of Object.entries(updatePayload.handlers)) {
      setEventHandler(instance, key, value);
    }
    for (const key of updatePayload.handlerDeletes) {
      setEventHandler(instance, key, undefined);
    }
  },
  commitTextUpdate(textInstance, _oldText, newText) {
    setTextNodeValue(textInstance, newText);
  },
  resetTextContent() {},
  appendChild(parent, child) {
    appendChild(parent, child);
  },
  appendChildToContainer(parent, child) {
    appendChild(parent, child);
  },
  insertBefore(parent, child, beforeChild) {
    insertBefore(parent, child, beforeChild);
  },
  insertInContainerBefore(parent, child, beforeChild) {
    insertBefore(parent, child, beforeChild);
  },
  removeChild(parent, child) {
    removeChild(parent, child);
  },
  removeChildFromContainer(parent, child) {
    removeChild(parent, child);
  },
  hideInstance(instance) {
    instance.hidden = true;
  },
  hideTextInstance(instance) {
    instance.hidden = true;
  },
  unhideInstance(instance) {
    instance.hidden = false;
  },
  unhideTextInstance(instance) {
    instance.hidden = false;
  },
  clearContainer(container) {
    for (const child of [...container.childNodes]) {
      removeChild(container, child);
    }
  },
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  getCurrentEventPriority: () => DefaultEventPriority,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  detachDeletedInstance() {}
});

export function createTuiReactRoot(options: ReconcileOptions = {}): TuiReactRoot {
  const root = createRootElement();
  root.debugOwnerChain = options.ownerChain ?? ["TuiRoot"];
  if (options.onCommit) {
    commitCallbacks.set(root, options.onCommit);
  }
  const container = reconciler.createContainer(
    root,
    0,
    null,
    false,
    null,
    "swarm",
    reportRecoverableError,
    null
  );
  return {
    container,
    root,
    render(node: React.ReactNode) {
      reconciler.updateContainer(node, container, null, null);
    },
    unmount() {
      reconciler.updateContainer(null, container, null, null);
      commitCallbacks.delete(root);
    }
  };
}

export function renderReactTreeToDom(element: React.ReactNode, options: ReconcileOptions = {}): TuiElement {
  const root = createTuiReactRoot(options);
  root.render(element);
  return root.root;
}

function applyProps(node: TuiElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      continue;
    }
    if (isEventHandlerProp(key)) {
      setEventHandler(node, key, value);
      continue;
    }
    setAttribute(node, key, normalizeAttribute(value));
  }
}

function isEventHandlerProp(key: string): boolean {
  return EVENT_HANDLER_PATTERN.test(key);
}

function setEventHandler(node: TuiElement, key: string, value: unknown): void {
  if (typeof value === "function") {
    node.eventHandlers[key] = value;
    return;
  }
  delete node.eventHandlers[key];
}

function normalizeAttribute(value: unknown): TuiNodeAttribute {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string" || value === undefined) {
    return value;
  }
  if (value === null) {
    return undefined;
  }
  return JSON.stringify(value);
}

type FiberLike = {
  elementType?: { displayName?: string; name?: string } | string | null;
  type?: { displayName?: string; name?: string } | string | null;
  _debugOwner?: FiberLike | null;
  return?: FiberLike | null;
};

function ownerChainFromFiber(fiber: unknown, fallbackType: TuiElementName): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current = fiber as FiberLike | null | undefined;
  for (let depth = 0; current && depth < 50; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const name = fiberName(current);
    if (name && name !== chain[chain.length - 1]) {
      chain.push(name);
    }
    current = current._debugOwner ?? current.return;
  }
  if (chain.length > 0) {
    return chain;
  }
  return [ownerNameForType(fallbackType)];
}

function fiberName(fiber: FiberLike): string | undefined {
  const type = fiber.elementType ?? fiber.type;
  if (typeof type === "string") {
    return undefined;
  }
  return type?.displayName || type?.name || undefined;
}

function ownerNameForType(type: TuiElementName): string {
  switch (type) {
    case "swarm-root":
      return "TuiRoot";
    case "swarm-box":
      return "Box";
    case "swarm-text":
    case "swarm-virtual-text":
      return "Text";
    case "swarm-link":
      return "Link";
    case "swarm-no-select":
      return "NoSelect";
    case "swarm-raw-ansi":
      return "RawAnsi";
    case "swarm-progress":
      return "Progress";
    case "swarm-scroll":
      return "Scroll";
  }
}

function reportRecoverableError(error: unknown): void {
  if (process.env.SWARM_TUI_RENDERER_DEBUG) {
    process.stderr.write(`[swarm tui renderer] ${String(error)}\n`);
  }
}

export default reconciler;
