import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box } from "./components/Box.js";
import { Text } from "./components/Text.js";
import { useRendererApp } from "./hooks/use-app.js";
import { useRendererInput } from "./hooks/use-input.js";
import { useRendererStdout } from "./hooks/use-stdout.js";
import { createTuiRoot } from "./root.js";
import ScrollBox from "./components/ScrollBox.js";
import { terminalPatchToString } from "./output.js";
import { screenToLines } from "./screen.js";

test("TuiRoot renders a simple React tree into a deterministic screen buffer", async () => {
  const frames: number[] = [];
  const root = createTuiRoot({
    columns: 20,
    rows: 5,
    onFrame(frame) {
      frames.push(frame.timing.totalMs);
    }
  });

  root.render(React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "cyan" }, "hello"),
    React.createElement(Text, null, "world")
  ));

  const frame = root.getFrame();
  assert(frame);
  assert.deepEqual(screenToLines(frame.screen).slice(0, 2), ["hello", "world"]);
  assert.equal(frame.metadata.renderer, "dom-renderer");
  assert.equal(frame.metadata.invalidLayout, false);
  assert(frame.metadata.nodeCount >= 5);
  assert.equal(frames.length, 1);

  const wait = root.waitUntilExit();
  root.unmount();
  await wait;
});

test("TuiRoot rejects render after unmount", () => {
  const root = createTuiRoot();
  root.unmount();
  assert.throws(() => root.render(React.createElement(Text, null, "late")), /unmounted/);
});

test("TuiRoot keeps one host DOM root across rerenders", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(Box, null, React.createElement(Text, null, "first")));
  const firstDom = root.getDom();
  const firstChild = firstDom.childNodes[0];

  root.rerender(React.createElement(Box, null, React.createElement(Text, null, "second")));
  const secondDom = root.getDom();

  assert.equal(secondDom, firstDom);
  assert.equal(secondDom.childNodes[0], firstChild);
  assert.deepEqual(screenToLines(root.getFrame()!.screen).slice(0, 1), ["second"]);
  root.unmount();
});

test("TuiRoot tracks previous-frame diff metadata and terminal patches", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(Box, null, React.createElement(Text, null, "first")));

  const firstFrame = root.getFrame();
  assert(firstFrame);
  assert.equal(firstFrame.metadata.output?.fullReset, true);
  assert.equal(root.getLastDiff()?.fullReset, true);
  assert.match(terminalPatchToString(root.getLastPatch()), /first/);

  root.rerender(React.createElement(Box, null, React.createElement(Text, null, "second")));
  const secondFrame = root.getFrame();
  assert(secondFrame);
  assert.equal(secondFrame.metadata.output?.fullReset, false);
  assert.equal(secondFrame.metadata.output?.changedRows, 1);
  assert.equal(root.getLastDiff()?.changed[0]?.row, 0);
  assert.match(terminalPatchToString(root.getLastPatch()), /second/);
  root.unmount();
});

test("TuiRoot resize forces full redraw and updates stdout dimensions", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(Box, null, React.createElement(Text, null, "same")));
  assert.equal(root.getLastDiff()?.fullReset, true);

  root.rerender(React.createElement(Box, null, React.createElement(Text, null, "same")));
  assert.equal(root.getLastDiff()?.fullReset, false);

  root.resize(10, 3);
  const frame = root.getFrame();
  assert(frame);
  assert.equal(frame.screen.width, 10);
  assert.equal(frame.screen.height, 3);
  assert.equal(root.getLastDiff()?.fullReset, true);
  assert.equal(frame.metadata.output?.fullReset, true);
  assert.equal(frame.metadata.output?.damageArea, 30);
  root.unmount();
});

test("TuiRoot forceFullRedraw repaints without stale previous diff state", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(Box, null, React.createElement(Text, null, "stable")));
  root.rerender(React.createElement(Box, null, React.createElement(Text, null, "stable")));
  assert.equal(root.getLastDiff()?.fullReset, false);
  assert.equal(root.getLastDiff()?.changed.length, 0);

  root.forceFullRedraw();

  assert.equal(root.getLastDiff()?.fullReset, true);
  assert.match(terminalPatchToString(root.getLastPatch()), /stable/);
  root.unmount();
});

test("TuiRoot lifecycle snapshot restores all enabled terminal modes on unmount", () => {
  const root = createTuiRoot({
    columns: 20,
    rows: 4,
    terminalCapabilities: {
      rawMode: true,
      bracketedPaste: true,
      extendedKeyboard: true,
      mouse: true,
      focusReporting: true,
      hyperlinks: true,
      clipboard: true,
      notifications: true,
      tabStatus: true
    }
  });
  const active = root.getTerminalLifecycleSnapshot();
  assert.equal(active.rawMode, true);
  assert.equal(active.cursorHidden, true);
  assert.equal(active.altScreen, true);
  assert.equal(active.consolePatched, true);
  assert.equal(active.bracketedPaste, true);
  assert.equal(active.focusReporting, true);
  assert.equal(active.extendedKeyboard, true);
  assert.equal(active.mouseTracking, true);
  assert.equal(active.owners.length, 1);

  root.unmount();

  assert.deepEqual(root.getTerminalLifecycleSnapshot(), {
    rawMode: false,
    cursorHidden: false,
    altScreen: false,
    consolePatched: false,
    bracketedPaste: false,
    focusReporting: false,
    extendedKeyboard: false,
    mouseTracking: false,
    owners: []
  });
});

test("TuiRoot stores event handlers on DOM nodes across rerenders", () => {
  const firstHandler = () => undefined;
  const secondHandler = () => undefined;
  const root = createTuiRoot({ columns: 20, rows: 4 });

  root.render(React.createElement(Box, { onKeyDown: firstHandler } as never, React.createElement(Text, null, "input")));
  const box = root.getDom().childNodes[0];
  assert(box && box.nodeName !== "#text");
  assert.equal(box.attributes.onKeyDown, undefined);
  assert.equal(box.eventHandlers.onKeyDown, firstHandler);

  root.render(React.createElement(Box, { onKeyDown: secondHandler } as never, React.createElement(Text, null, "input")));
  assert.equal(box.eventHandlers.onKeyDown, secondHandler);

  root.render(React.createElement(Box, null, React.createElement(Text, null, "input")));
  assert.equal(box.eventHandlers.onKeyDown, undefined);
  root.unmount();
});

test("TuiRoot enforces Text nesting rules", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    assert.throws(
      () => root.render(React.createElement(Box, null, "raw text")),
      /must be rendered inside <Text>/
    );
    assert.throws(
      () => root.render(React.createElement(Text, null, React.createElement(Box, null, React.createElement(Text, null, "nested")))),
      /can't be nested inside <Text>/
    );
    root.unmount();
  } finally {
    console.error = originalConsoleError;
  }
});

test("TuiRoot provides stdout input and app contexts in dom-renderer mode", async () => {
  const received: string[] = [];
  function Harness(): React.ReactElement {
    const stdout = useRendererStdout();
    const app = useRendererApp();
    useRendererInput((input, key) => {
      received.push(key.return ? "return" : input ?? "");
      app.exit();
    });
    return React.createElement(Text, null, `${stdout.columns}x${stdout.rows}`);
  }

  const root = createTuiRoot({ columns: 33, rows: 7 });
  root.render(React.createElement(Harness));
  assert.deepEqual(screenToLines(root.getFrame()!.screen).slice(0, 1), ["33x7"]);

  const wait = root.waitUntilExit();
  root.dispatchInput(undefined, { return: true });
  await wait;
  assert.deepEqual(received, ["return"]);
});

test("TuiRoot routes input through focused DOM handlers before input registry fallback", () => {
  const calls: string[] = [];
  const root = createTuiRoot({ columns: 30, rows: 5 });

  function Harness(): React.ReactElement {
    useRendererInput((input, key) => {
      calls.push(`fallback:${key.return ? "return" : input ?? ""}`);
    });
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Box, {
        focusable: true,
        onKeydown: (event: { preventDefault: () => void; input?: string }) => {
          calls.push(`prompt:${event.input ?? ""}`);
          event.preventDefault();
        }
      } as never, React.createElement(Text, null, "prompt")),
      React.createElement(Box, {
        focusable: true,
        onKeydown: (event: { preventDefault: () => void; key?: { return?: boolean } }) => {
          calls.push(`modal:${event.key?.return ? "return" : ""}`);
          event.preventDefault();
        }
      } as never, React.createElement(Text, null, "modal"))
    );
  }

  root.render(React.createElement(Harness));
  const shell = root.getDom().childNodes[0];
  assert(shell && shell.nodeName !== "#text");
  const prompt = shell.childNodes[0];
  const modal = shell.childNodes[1];
  assert(prompt && prompt.nodeName !== "#text");
  assert(modal && modal.nodeName !== "#text");

  root.focusElement(prompt);
  root.dispatchInput("a");
  root.focusElement(modal);
  root.dispatchInput(undefined, { return: true });
  root.getFocusManager().blur();
  root.dispatchInput("z");

  assert.deepEqual(calls, ["prompt:a", "modal:return", "fallback:z"]);
  root.unmount();
});

test("TuiRoot dispatches raw SGR mouse clicks through hit-tested DOM handlers", () => {
  const calls: string[] = [];
  const root = createTuiRoot({
    columns: 40,
    rows: 6,
    terminalCapabilities: { mouse: true }
  });

  function Harness(): React.ReactElement {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Box, {
        onClick: (event: { x: number; y: number; preventDefault: () => void }) => {
          calls.push(`row:${event.x},${event.y}`);
          event.preventDefault();
        }
      } as never, React.createElement(Text, null, "clickable worker row")),
      React.createElement(Text, null, "plain")
    );
  }

  root.render(React.createElement(Harness));
  const summary = root.dispatchRawInput("\u001B[<0;2;1M");

  assert.deepEqual(summary, {
    delivered: 0,
    responses: 0,
    mouse: 1,
    focus: 0,
    malformed: 0
  });
  assert.deepEqual(calls, ["row:1,0"]);
  root.unmount();
});

test("TuiRoot ignores mouse dispatch when capability is disabled", () => {
  const calls: string[] = [];
  const root = createTuiRoot({
    columns: 40,
    rows: 6,
    terminalCapabilities: { mouse: false }
  });

  root.render(React.createElement(Box, {
    onClick: (() => calls.push("clicked")) as never
  } as never, React.createElement(Text, null, "clickable")));

  root.dispatchRawInput("\u001B[<0;2;1M");

  assert.deepEqual(calls, []);
  root.unmount();
});

test("TuiRoot applies wheel input to the nearest scroll region", () => {
  const root = createTuiRoot({
    columns: 40,
    rows: 6,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ScrollBox, {
    width: 30,
    height: 5,
    scrollTop: 0,
    scrollHeight: 20,
    viewportHeight: 3
  }, React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, null, "scroll target"),
    React.createElement(Text, null, "more content")
  )));

  const scroll = root.getDom().childNodes[0];
  assert(scroll && scroll.nodeName !== "#text");
  assert.equal(scroll.scroll?.scrollTop, 0);

  root.dispatchMouse({ x: 1, y: 0, button: "wheel-down", action: "press" });

  assert.equal(scroll.scroll?.scrollTop, 3);
  assert.equal(scroll.scroll?.pendingDelta, 3);
  root.unmount();
});

test("TuiRoot focuses first prompt target and blocks empty Enter before fallback detail handlers", () => {
  const calls: string[] = [];
  const root = createTuiRoot({ columns: 40, rows: 6 });

  function Harness(): React.ReactElement {
    useRendererInput((input, key) => {
      if (key.return) {
        calls.push("fallback:open-command-output");
        return;
      }
      calls.push(`fallback:${input ?? ""}`);
    });
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Box, {
        focusable: true,
        onKeydown: (event: { preventDefault: () => void; key?: { return?: boolean } }) => {
          if (event.key?.return) {
            calls.push("prompt:empty-enter");
            event.preventDefault();
          }
        }
      } as never, React.createElement(Text, null, "prompt")),
      React.createElement(Text, null, "Command Output available")
    );
  }

  root.render(React.createElement(Harness));
  assert.equal(root.getFocusManager().activeElement?.focused, true);

  root.dispatchInput(undefined, { return: true });

  assert.deepEqual(calls, ["prompt:empty-enter"]);
  root.unmount();
});

test("TuiRoot delivers raw Ctrl+O to explicit detail handlers after empty Enter guard", async () => {
  const calls: string[] = [];
  const root = createTuiRoot({ columns: 44, rows: 7 });

  function Harness(): React.ReactElement {
    const [detailOpen, setDetailOpen] = React.useState(false);
    useRendererInput((input, key) => {
      if (key.ctrl && input === "o") {
        calls.push("fallback:ctrl+o");
        setDetailOpen(true);
      }
    });
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Box, {
        focusable: true,
        onKeydown: (event: { preventDefault: () => void; key?: { return?: boolean } }) => {
          if (event.key?.return) {
            calls.push("prompt:empty-enter");
            event.preventDefault();
          }
        }
      } as never, React.createElement(Text, null, "prompt")),
      detailOpen
        ? React.createElement(Text, null, "COMMAND OUTPUT")
        : React.createElement(Text, null, "Command Output available")
    );
  }

  try {
    root.render(React.createElement(Harness));
    root.dispatchRawInput("\r");
    assert.deepEqual(calls, ["prompt:empty-enter"]);
    assert.doesNotMatch(screenToLines(root.getFrame()!.screen).join("\n"), /COMMAND OUTPUT/);

    root.dispatchRawInput("\x0f");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(calls, ["prompt:empty-enter", "fallback:ctrl+o"]);
    assert.match(screenToLines(root.getFrame()!.screen).join("\n"), /COMMAND OUTPUT/);
  } finally {
    root.unmount();
  }
});

test("TuiRoot restores focus to prompt when focused overlay disappears on rerender", () => {
  const calls: string[] = [];
  const root = createTuiRoot({ columns: 40, rows: 6 });

  function Harness({ modal }: { modal: boolean }): React.ReactElement {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Box, {
        focusable: true,
        onKeydown: (event: { input?: string; preventDefault: () => void }) => {
          calls.push(`prompt:${event.input ?? ""}`);
          event.preventDefault();
        }
      } as never, React.createElement(Text, null, "prompt")),
      modal
        ? React.createElement(Box, {
          focusable: true,
          onKeydown: (event: { input?: string; preventDefault: () => void }) => {
            calls.push(`modal:${event.input ?? ""}`);
            event.preventDefault();
          }
        } as never, React.createElement(Text, null, "modal"))
        : null
    );
  }

  root.render(React.createElement(Harness, { modal: true }));
  const shell = root.getDom().childNodes[0];
  assert(shell && shell.nodeName !== "#text");
  const prompt = shell.childNodes[0];
  const modal = shell.childNodes[1];
  assert(prompt && prompt.nodeName !== "#text");
  assert(modal && modal.nodeName !== "#text");

  root.focusElement(modal);
  root.dispatchInput("m");
  root.rerender(React.createElement(Harness, { modal: false }));
  root.dispatchInput("p");

  assert.equal(root.getFocusManager().activeElement, prompt);
  assert.deepEqual(calls, ["modal:m", "prompt:p"]);
  root.unmount();
});

test("TuiRoot lets focused approval overlays claim decisions before prompt fallback", () => {
  const calls: string[] = [];
  const root = createTuiRoot({ columns: 50, rows: 8 });

  function Harness({ approval }: { approval: boolean }): React.ReactElement {
    useRendererInput((input, key) => {
      calls.push(`fallback:${key.escape ? "escape" : input ?? ""}`);
    });
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Box, {
        focusable: true,
        onKeydown: (event: { input?: string; preventDefault: () => void }) => {
          calls.push(`prompt:${event.input ?? ""}`);
          event.preventDefault();
        }
      } as never, React.createElement(Text, null, "prompt")),
      approval
        ? React.createElement(Box, {
          focusable: true,
          onKeydown: (event: { input?: string; key?: { escape?: boolean }; preventDefault: () => void }) => {
            if (event.input === "y" || event.input === "n" || event.key?.escape) {
              calls.push(`approval:${event.key?.escape ? "escape" : event.input}`);
              event.preventDefault();
            }
          }
        } as never, React.createElement(Text, null, "approval"))
        : null
    );
  }

  root.render(React.createElement(Harness, { approval: true }));
  const shell = root.getDom().childNodes[0];
  assert(shell && shell.nodeName !== "#text");
  const prompt = shell.childNodes[0];
  const approval = shell.childNodes[1];
  assert(prompt && prompt.nodeName !== "#text");
  assert(approval && approval.nodeName !== "#text");

  root.focusElement(approval);
  root.dispatchInput("y");
  root.dispatchInput(undefined, { escape: true });
  root.rerender(React.createElement(Harness, { approval: false }));
  root.dispatchInput("p");

  assert.equal(root.getFocusManager().activeElement, prompt);
  assert.deepEqual(calls, ["approval:y", "approval:escape", "prompt:p"]);
  root.unmount();
});
