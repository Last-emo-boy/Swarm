import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box } from "./components/Box.js";
import { Link } from "./components/Link.js";
import { Progress } from "./components/Progress.js";
import { RawAnsi } from "./components/RawAnsi.js";
import { Text } from "./components/Text.js";
import { stripAnsi } from "./ansi.js";
import { createElement, updateScrollFields } from "./dom.js";
import { buildTerminalPatch, diffScreens, terminalPatchToString } from "./output.js";
import { renderReactTreeToDom } from "./reconciler.js";
import { renderDomToFrame } from "./renderer.js";
import { blitRegion, clearRegion, createScreen, screenToLines, setCell, shiftRows } from "./screen.js";

test("renderer handles invalid dimensions without crashing", () => {
  const root = createElement("swarm-root");
  const frame = renderDomToFrame(root, { columns: Number.POSITIVE_INFINITY, rows: -1 });
  assert.equal(frame.metadata.invalidLayout, true);
  assert.equal(frame.screen.height, 0);
});

test("renderer exposes dirty counts, scroll drain metadata, and screen diffs", () => {
  const dom = renderReactTreeToDom(React.createElement(Box, null, React.createElement(Text, null, "alpha")));
  const scroll = createElement("swarm-scroll");
  updateScrollFields(scroll, { pendingDelta: 3, scrollHeight: 100, viewportHeight: 10 });
  dom.childNodes.push(scroll);
  const first = renderDomToFrame(dom, { columns: 20, rows: 4 });
  assert.equal(first.metadata.scrollDrainPending, true);
  assert(screenToLines(first.screen)[0]?.startsWith("alpha"));

  const secondDom = renderReactTreeToDom(React.createElement(Box, null, React.createElement(Text, null, "beta")));
  const second = renderDomToFrame(secondDom, { columns: 20, rows: 4 });
  const diff = diffScreens(first.screen, second.screen);
  assert.equal(diff.fullReset, false);
  assert.equal(diff.scannedRows > 0, true);
  assert.equal(diff.changed[0]?.row, 0);
  assert.match(diff.changed[0]?.next ?? "", /beta/);
});

test("renderer layout supports percent width truncate wrap and wide cells", () => {
  const dom = renderReactTreeToDom(React.createElement(
    Box,
    { flexDirection: "column", width: "100%" } as never,
    React.createElement(Text, { wrap: "truncate" }, "abcdef"),
    React.createElement(Text, { wrap: "wrap" }, "中文abc")
  ));

  const frame = renderDomToFrame(dom, { columns: 5, rows: 4 });
  const lines = screenToLines(frame.screen);
  assert.equal(dom.layout.width, 5);
  assert.equal(lines[0], "abcde");
  assert.equal(lines[1], "中文a");
  assert.equal(lines[2], "bc");
});

test("renderer layout applies min max dimensions and skips hidden nodes", () => {
  const dom = renderReactTreeToDom(React.createElement(
    Box,
    { flexDirection: "column", width: 12, maxWidth: 8, minHeight: 3 } as never,
    React.createElement(Text, { hidden: true } as never, "hidden"),
    React.createElement(Text, { minWidth: 6, maxWidth: 6 } as never, "xy")
  ));

  const frame = renderDomToFrame(dom, { columns: 12, rows: 4 });
  const child = dom.childNodes[0];
  const visibleText = child?.nodeName !== "#text" ? child?.childNodes[1] : undefined;

  assert(child && child.nodeName !== "#text");
  assert.equal(child.layout.width, 8);
  assert.equal(child.layout.height, 3);
  assert.equal(visibleText?.layout.width, 6);
  assert.equal(screenToLines(frame.screen)[0], "xy");
  assert.doesNotMatch(screenToLines(frame.screen).join("\n"), /hidden/);
});

test("screen diff limits scans to damage rows when dimensions match", () => {
  const first = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, null, "same"),
      React.createElement(Text, null, "old"),
      React.createElement(Text, null, "same")
    )),
    { columns: 12, rows: 5 }
  );
  const second = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, null, "same"),
      React.createElement(Text, null, "new"),
      React.createElement(Text, null, "same")
    )),
    { columns: 12, rows: 5 }
  );
  first.screen.damage = { x: 0, y: 1, width: 3, height: 1 };
  second.screen.damage = { x: 0, y: 1, width: 3, height: 1 };

  const diff = diffScreens(first.screen, second.screen);
  assert.equal(diff.fullReset, false);
  assert.equal(diff.scannedRows, 1);
  assert.deepEqual(diff.changed.map((line) => line.row), [1]);
});

test("terminal patch output uses full reset first then row-level updates", () => {
  const first = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null, React.createElement(Text, null, "alpha"))),
    { columns: 12, rows: 3 }
  );
  const firstPatch = buildTerminalPatch(diffScreens(undefined, first.screen));
  assert.deepEqual(firstPatch[0], { type: "clearScreen" });
  assert.match(terminalPatchToString(firstPatch), /alpha/);

  const second = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null, React.createElement(Text, null, "beta"))),
    { columns: 12, rows: 3 }
  );
  const updatePatch = buildTerminalPatch(diffScreens(first.screen, second.screen));
  assert.equal(updatePatch.some((item) => item.type === "clearScreen"), false);
  assert.match(terminalPatchToString(updatePatch), /beta/);
});

test("terminal patch encodes cell foreground background and text attributes", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, { flexDirection: "row" },
      React.createElement(Text, { color: "red", backgroundColor: "brightBlue", bold: true, underline: true }, "hot"),
      React.createElement(Text, { color: "green" }, " ok")
    )),
    { columns: 16, rows: 2 }
  );

  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { trueColor: true }
  }));

  assert.match(patch, /\u001B\[1;4;31;104mhot/);
  assert.match(patch, /\u001B\[0;32m ok/);
  assert.match(patch, /\u001B\[0m/);
  assert.match(stripAnsi(patch), /hot ok/);
});

test("terminal patch supports rgb hex and ansi256 color values", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, { flexDirection: "row" },
      React.createElement(Text, { color: "rgb(12, 34, 56)" }, "rgb"),
      React.createElement(Text, { color: "#0f8", backgroundColor: "ansi256(236)" }, " hex")
    )),
    { columns: 16, rows: 2 }
  );

  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { trueColor: true }
  }));

  assert.match(patch, /\u001B\[38;2;12;34;56mrgb/);
  assert.match(patch, /\u001B\[0;38;2;0;255;136;48;5;236m hex/);
  assert.match(stripAnsi(patch), /rgb hex/);
});

test("terminal patch falls rgb hex and ansi256 back to 256 color when truecolor is unavailable", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, { flexDirection: "row" },
      React.createElement(Text, { color: "rgb(12, 34, 56)" }, "rgb"),
      React.createElement(Text, { color: "#0f8", backgroundColor: "ansi256(236)" }, " hex")
    )),
    { columns: 16, rows: 2 }
  );

  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { trueColor: false, colorLevel: 2 }
  }));

  assert.doesNotMatch(patch, /38;2/);
  assert.match(patch, /\u001B\[38;5;\d+mrgb/);
  assert.match(patch, /\u001B\[0;38;5;\d+;48;5;236m hex/);
  assert.match(stripAnsi(patch), /rgb hex/);
});

test("terminal patch falls rgb colors back to ANSI16 at basic color level", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Text, { color: "rgb(224,151,88)", backgroundColor: "rgb(34,92,43)" }, "basic")
    )),
    { columns: 12, rows: 2 }
  );

  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { trueColor: false, colorLevel: 1 }
  }));

  assert.doesNotMatch(patch, /38;2|38;5|48;2|48;5/);
  assert.match(patch, /\u001B\[[\d;]*mbasic/);
  assert.match(stripAnsi(patch), /basic/);
});

test("terminal patch can disable color output for no-color environments", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Text, { color: "rgb(224,151,88)", backgroundColor: "ansi256(236)", bold: true }, "plain")
    )),
    { columns: 12, rows: 2 }
  );

  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { color: false }
  }));

  assert.doesNotMatch(patch, /38;2|38;5|48;2|48;5|31m/);
  assert.match(patch, /\u001B\[1mplain/);
  assert.match(stripAnsi(patch), /plain/);
});

test("screen diff detects style-only row changes", () => {
  const first = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Text, { color: "red" }, "same")
    )),
    { columns: 12, rows: 2 }
  );
  const second = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Text, { color: "green" }, "same")
    )),
    { columns: 12, rows: 2 }
  );
  first.screen.damage = { x: 0, y: 0, width: 4, height: 1 };
  second.screen.damage = { x: 0, y: 0, width: 4, height: 1 };

  const diff = diffScreens(first.screen, second.screen);
  const patch = terminalPatchToString(buildTerminalPatch(diff));

  assert.equal(diff.fullReset, false);
  assert.deepEqual(diff.changed.map((line) => line.row), [0]);
  assert.match(patch, /\u001B\[32msame/);
});

test("screen diff full-resets on resize so stale shrink cells are cleared", () => {
  const wide = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null, React.createElement(Text, null, "stale-tail"))),
    { columns: 16, rows: 3 }
  );
  const narrow = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null, React.createElement(Text, null, "new"))),
    { columns: 5, rows: 2 }
  );

  const diff = diffScreens(wide.screen, narrow.screen);
  const patch = buildTerminalPatch(diff);
  assert.equal(diff.fullReset, true);
  assert.deepEqual(diff.damage, { x: 0, y: 0, width: 5, height: 2 });
  assert.deepEqual(patch[0], { type: "clearScreen" });
  assert.match(terminalPatchToString(patch), /new/);
});

test("screen buffer supports clear blit shiftRows and wide boundary cleanup", () => {
  const source = createScreen(8, 4);
  setCell(source, 0, 0, "a");
  setCell(source, 1, 0, "中");
  setCell(source, 3, 0, "b");
  assert.equal(screenToLines(source, { trimRight: false })[0], "a中b    ");

  setCell(source, 2, 0, "x");
  assert.equal(screenToLines(source, { trimRight: false })[0], "a xb    ");

  const target = createScreen(8, 4);
  blitRegion(source, target, 0, 0, 4, 1, 2, 1);
  assert.equal(screenToLines(target, { trimRight: false })[1], "  a xb  ");
  assert.deepEqual(target.damage, { x: 2, y: 1, width: 4, height: 1 });

  clearRegion(target, 3, 1, 2, 1);
  assert.equal(screenToLines(target, { trimRight: false })[1], "  a  b  ");
  assert.deepEqual(target.damage, { x: 2, y: 1, width: 4, height: 1 });

  shiftRows(target, 0, 3, 1);
  assert.equal(screenToLines(target, { trimRight: false })[2], "  a  b  ");
  assert.equal(screenToLines(target, { trimRight: false })[0], "        ");
  assert.deepEqual(target.damage, { x: 0, y: 0, width: 8, height: 4 });
});

test("renderer paints RawAnsi visible text and basic SGR styles", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(RawAnsi, { lines: ["plain \u001B[31;1mred\u001B[0m done"], width: 20 })
    )),
    { columns: 24, rows: 3 }
  );
  const lines = screenToLines(frame.screen);

  assert.equal(lines[0], "plain red done");
  assert.deepEqual(frame.screen.cells[0]?.[6]?.style, { color: "red", bold: true });
  assert.deepEqual(frame.screen.cells[0]?.[10]?.style, {});
});

test("renderer preserves Link hyperlink metadata in screen cells", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Link, { href: "https://example.test" }, "docs")
    )),
    { columns: 16, rows: 2 }
  );

  assert.equal(screenToLines(frame.screen)[0], "docs");
  assert.equal(frame.screen.cells[0]?.[0]?.hyperlink, "https://example.test");
  assert.equal(frame.screen.cells[0]?.[3]?.hyperlink, "https://example.test");
  assert.equal(frame.screen.cells[0]?.[4]?.hyperlink, undefined);
});

test("terminal patch preserves hyperlinks while encoding text styles", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Text, { color: "yellow" },
        React.createElement(Link, { href: "https://example.test" }, "docs")
      )
    )),
    { columns: 16, rows: 2 }
  );

  const patch = terminalPatchToString(buildTerminalPatch(diffScreens(undefined, frame.screen), {
    capabilities: { hyperlinks: true }
  }));

  assert.match(patch, /\u001B\]8;;https:\/\/example\.test\u001B\\/);
  assert.match(patch, /\u001B\[33mdocs/);
  assert.match(patch, /\u001B\]8;;\u001B\\/);
  assert.match(patch, /\u001B\[0m/);
});

test("renderer bounds Progress output to the available width", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, null,
      React.createElement(Progress, { value: 0.5, width: 12, label: "cache" })
    )),
    { columns: 12, rows: 2 }
  );
  const line = screenToLines(frame.screen, { trimRight: false })[0] ?? "";

  assert.equal(line.length, 12);
  assert.match(line, /^cache \[/);
  assert.equal(frame.screen.damage?.width, 12);
});
