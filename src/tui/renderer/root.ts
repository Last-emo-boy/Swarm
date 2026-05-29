import React from "react";
import { clampScrollTop, type TuiElement } from "./dom.js";
import type { TuiFrame } from "./frame.js";
import { RendererAppProvider } from "./hooks/use-app.js";
import { createInputRegistry, RendererInputProvider, type RendererKey } from "./hooks/use-input.js";
import { RendererStdoutProvider } from "./hooks/use-stdout.js";
import { TuiDomEventDispatcher } from "./events/dispatcher.js";
import { TuiKeyboardEvent } from "./events/terminal-event.js";
import { isInTree, TuiFocusManager } from "./focus.js";
import { hitTestDom } from "./hit-test.js";
import { buildTerminalPatch, diffScreens, type TuiFrameDiff, type TuiTerminalPatch } from "./output.js";
import { createTuiReactRoot } from "./reconciler.js";
import { renderDomToFrame } from "./renderer.js";
import type { TuiMouseInput, TuiParsedInput } from "./input-parser.js";
import { TuiTerminalInputController, type TuiTerminalInputDelivery } from "./terminal-input.js";
import { detectTuiTerminalCapabilities, type TuiTerminalCapabilities } from "./terminal-capabilities.js";
import { acquireTerminalLifecycleForStream, type TerminalLifecycleSnapshot } from "./terminal.js";
import { TuiClickEvent } from "./events/click-event.js";

export type TuiRootOptions = {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  columns?: number;
  rows?: number;
  patchConsole?: boolean;
  terminalCapabilities?: Partial<TuiTerminalCapabilities>;
  onFrame?: (frame: TuiFrame, output: { diff: TuiFrameDiff; patch: readonly TuiTerminalPatch[] }) => void;
};

export type TuiRoot = {
  render: (node: React.ReactNode) => void;
  rerender: (node: React.ReactNode) => void;
  resize: (columns?: number, rows?: number) => void;
  forceFullRedraw: () => void;
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
  getFrame: () => TuiFrame | undefined;
  getLastDiff: () => TuiFrameDiff | undefined;
  getLastPatch: () => readonly TuiTerminalPatch[];
  getDom: () => TuiElement;
  getFocusManager: () => TuiFocusManager;
  getTerminalLifecycleSnapshot: () => TerminalLifecycleSnapshot;
  focusElement: (node: TuiElement) => void;
  dispatchInput: (input: string | undefined, key?: RendererKey) => void;
  dispatchMouse: (mouse: TuiMouseInput) => void;
  dispatchParsedInput: (events: readonly TuiParsedInput[]) => TuiTerminalInputDelivery;
  dispatchRawInput: (chunk: string | Buffer, options?: { flush?: boolean }) => TuiTerminalInputDelivery;
  flushRawInput: () => TuiTerminalInputDelivery;
};

export function createTuiRoot(options: TuiRootOptions = {}): TuiRoot {
  let mounted = true;
  const stdout = options.stdout ?? process.stdout;
  const reactRoot = createTuiReactRoot({ ownerChain: ["TuiRoot"], onCommit: paintCommittedRoot });
  const inputRegistry = createInputRegistry();
  const domDispatcher = new TuiDomEventDispatcher();
  const focusManager = new TuiFocusManager((target, event) => domDispatcher.dispatch(target, event));
  const terminalCapabilities = options.terminalCapabilities ?? detectTuiTerminalCapabilities(process.env, stdout);
  let dimensions = {
    columns: rootColumnsFor(options),
    rows: rootRowsFor(options)
  };
  const lifecycleOwner = `tui-root-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const terminalLifecycle = acquireTerminalLifecycleForStream(stdout, lifecycleOwner, {
    rawMode: terminalCapabilities.rawMode,
    hideCursor: true,
    altScreen: true,
    patchConsole: options.patchConsole ?? true,
    bracketedPaste: terminalCapabilities.bracketedPaste,
    focusReporting: terminalCapabilities.focusReporting,
    extendedKeyboard: terminalCapabilities.extendedKeyboard,
    mouseTracking: terminalCapabilities.mouse
  }, {
    stdout,
    stdin: options.stdin ?? process.stdin,
    stderr: options.stderr ?? process.stderr
  });
  let frame: TuiFrame | undefined;
  let lastDiff: TuiFrameDiff | undefined;
  let lastPatch: readonly TuiTerminalPatch[] = [];
  let currentNode: React.ReactNode | undefined;
  let forceNextFullReset = false;
  let paintCount = 0;
  let resolveExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const root: TuiRoot = {
    render(node: React.ReactNode) {
      if (!mounted) {
        throw new Error("Cannot render into an unmounted TUI root.");
      }
      currentNode = node;
      const paintCountBeforeRender = paintCount;
      reactRoot.render(wrapWithRootProviders(node, {
        options,
        dimensions,
        inputRegistry,
        exit(error?: Error) {
          root.unmount();
          if (error) {
            throw error;
          }
        }
      }));
      if (mounted && paintCount === paintCountBeforeRender) {
        paintCommittedRoot();
      }
    },
    rerender(node: React.ReactNode) {
      root.render(node);
    },
    resize(columns, rows) {
      if (!mounted) {
        return;
      }
      dimensions = {
        columns: columns ?? stdout.columns ?? dimensions.columns,
        rows: rows ?? stdout.rows ?? dimensions.rows
      };
      forceNextFullReset = true;
      if (currentNode !== undefined) {
        root.render(currentNode);
      }
    },
    forceFullRedraw() {
      if (!mounted) {
        return;
      }
      forceNextFullReset = true;
      if (currentNode !== undefined) {
        root.render(currentNode);
      }
    },
    unmount() {
      if (!mounted) {
        return;
      }
      mounted = false;
      reactRoot.unmount();
      terminalLifecycle.release();
      resolveExit?.();
    },
    waitUntilExit() {
      return exit;
    },
    getFrame() {
      return frame;
    },
    getLastDiff() {
      return lastDiff;
    },
    getLastPatch() {
      return lastPatch;
    },
    getDom() {
      return reactRoot.root;
    },
    getFocusManager() {
      return focusManager;
    },
    getTerminalLifecycleSnapshot() {
      return terminalLifecycle.snapshot();
    },
    focusElement(node) {
      focusManager.focus(node);
    },
    dispatchInput(input, key = {}) {
      const activeElement = focusManager.activeElement;
      if (activeElement) {
        const handledByDom = !domDispatcher.dispatch(activeElement, new TuiKeyboardEvent(input, key));
        if (handledByDom) {
          return;
        }
      }
      inputRegistry.dispatch(input, key);
    },
    dispatchMouse(mouse) {
      if (!terminalCapabilities.mouse || !frame) {
        return;
      }
      if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
        const target = hitTestDom(reactRoot.root, mouse.x, mouse.y);
        const scrollTarget = target ? nearestScrollable(target) : undefined;
        if (scrollTarget?.scroll) {
          const delta = mouse.button === "wheel-up" ? -3 : 3;
          scrollTarget.scroll.pendingDelta += delta;
          scrollTarget.scroll.scrollTop = clampScrollTop(scrollTarget.scroll, scrollTarget.scroll.scrollTop + delta);
          forceNextFullReset = true;
          if (currentNode !== undefined) {
            root.render(currentNode);
          }
        }
        return;
      }
      if (mouse.button !== "left" || mouse.action !== "press") {
        return;
      }
      const target = hitTestDom(reactRoot.root, mouse.x, mouse.y);
      if (!target) {
        return;
      }
      const event = new TuiClickEvent({ x: mouse.x, y: mouse.y, button: mouse.button });
      const shouldContinue = domDispatcher.dispatch(target, event);
      if (!shouldContinue) {
        return;
      }
      if (target.focusable) {
        focusManager.focus(target);
      }
    },
    dispatchParsedInput(events) {
      return terminalInput.deliver(events);
    },
    dispatchRawInput(chunk, inputOptions) {
      return terminalInput.feed(chunk, inputOptions);
    },
    flushRawInput() {
      return terminalInput.flush();
    }
  };
  const terminalInput = new RootTerminalInput(root);

  function paintCommittedRoot(): void {
    if (!mounted) {
      return;
    }
    const previousFrame = forceNextFullReset ? undefined : frame;
    forceNextFullReset = false;
    frame = renderDomToFrame(reactRoot.root, {
      columns: dimensions.columns,
      rows: dimensions.rows
    });
    ensureActiveFocus(reactRoot.root, focusManager);
    lastDiff = diffScreens(previousFrame?.screen, frame.screen);
    lastPatch = buildTerminalPatch(lastDiff, { capabilities: terminalCapabilities });
    frame.metadata.output = {
      fullReset: lastDiff.fullReset,
      changedRows: lastDiff.changed.length,
      scannedRows: lastDiff.scannedRows,
      patchOps: lastPatch.length,
      damageArea: damageArea(lastDiff.damage),
      damage: lastDiff.damage
    };
    paintCount += 1;
    options.onFrame?.(frame, { diff: lastDiff, patch: lastPatch });
  }

  return root;
}

class RootTerminalInput {
  private readonly controller: TuiTerminalInputController;

  constructor(root: Pick<TuiRoot, "dispatchInput" | "dispatchMouse">) {
    this.controller = new TuiTerminalInputController(root);
  }

  feed(chunk: string | Buffer, options: { flush?: boolean } = {}): TuiTerminalInputDelivery {
    return this.controller.feed(chunk, options);
  }

  flush(): TuiTerminalInputDelivery {
    return this.controller.flush();
  }

  deliver(events: readonly TuiParsedInput[]): TuiTerminalInputDelivery {
    return this.controller.deliver(events);
  }
}

function ensureActiveFocus(root: TuiElement, focusManager: TuiFocusManager): void {
  const active = focusManager.activeElement;
  if (active && isInTree(active, root) && active.focusable && !active.hidden) {
    return;
  }
  if (active && !isInTree(active, root)) {
    focusManager.handleNodeRemoved(active, root);
    return;
  }
  if (active) {
    focusManager.blur();
  }
  focusManager.focusFirst(root);
}

function nearestScrollable(node: TuiElement): TuiElement | undefined {
  let current: TuiElement | undefined = node;
  while (current) {
    if (current.scroll) {
      return current;
    }
    current = current.parentNode;
  }
  return undefined;
}

function damageArea(damage: TuiFrameDiff["damage"]): number {
  return damage ? damage.width * damage.height : 0;
}

function wrapWithRootProviders(
  node: React.ReactNode,
  context: {
    options: TuiRootOptions;
    dimensions: { columns: number; rows: number };
    inputRegistry: ReturnType<typeof createInputRegistry>;
    exit: (error?: Error) => void;
  }
): React.ReactElement {
  return React.createElement(
    RendererStdoutProvider,
    {
      value: {
        stdout: context.options.stdout,
        columns: context.dimensions.columns,
        rows: context.dimensions.rows
      }
    },
    React.createElement(
      RendererInputProvider,
      { registry: context.inputRegistry },
      React.createElement(RendererAppProvider, { value: { exit: context.exit } }, node)
    )
  );
}

function rootColumnsFor(options: TuiRootOptions): number {
  return options.columns ?? options.stdout?.columns ?? 80;
}

function rootRowsFor(options: TuiRootOptions): number {
  return options.rows ?? options.stdout?.rows ?? 24;
}
