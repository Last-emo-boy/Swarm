import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box } from "./components/Box.js";
import { Text } from "./components/Text.js";
import { createTuiRoot } from "./root.js";

test("reconciler updates host nodes in place and preserves dirty ancestry", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(Box, { focusable: true }, React.createElement(Text, null, "alpha")));
  const dom = root.getDom();
  const box = dom.childNodes[0];
  assert(box && box.nodeName !== "#text");
  assert.equal(box.dirty, false);
  assert.equal(box.focusable, true);
  assert.equal(box.debugOwnerChain[0], "Box");

  root.rerender(React.createElement(Box, { focusable: true }, React.createElement(Text, null, "beta")));

  assert.equal(dom.childNodes[0], box);
  assert.equal(box.dirty, false);
  assert.equal(root.getFrame()?.metadata.invalidLayout, false);
  root.unmount();
});

test("reconciler stores object props as serializable attributes without function leakage", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  const handler = () => undefined;
  root.render(React.createElement(
    Box,
    { onKeyDown: handler, metadata: { source: "test" } } as never,
    React.createElement(Text, null, "props")
  ));
  const box = root.getDom().childNodes[0];
  assert(box && box.nodeName !== "#text");
  assert.equal(box.attributes.onKeyDown, undefined);
  assert.equal(box.eventHandlers.onKeyDown, handler);
  assert.equal(box.attributes.metadata, "{\"source\":\"test\"}");
  root.unmount();
});

test("reconciler captures component owner chains for diagnostics", () => {
  function DiagnosticRow(): React.ReactElement {
    return React.createElement(Box, null, React.createElement(Text, null, "owner"));
  }
  DiagnosticRow.displayName = "DiagnosticRow";

  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(DiagnosticRow));
  const box = root.getDom().childNodes[0];

  assert(box && box.nodeName !== "#text");
  assert(box.debugOwnerChain.includes("DiagnosticRow"));
  root.unmount();
});

test("reconciler dirty propagation stays scoped to changed style and text subtrees", () => {
  const root = createTuiRoot({ columns: 20, rows: 4 });
  root.render(React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "green" }, "alpha"),
    React.createElement(Text, null, "stable")
  ));
  const dom = root.getDom();
  const box = dom.childNodes[0];
  assert(box && box.nodeName !== "#text");
  const firstText = box.childNodes[0];
  const secondText = box.childNodes[1];
  assert(firstText && firstText.nodeName !== "#text");
  assert(secondText && secondText.nodeName !== "#text");

  root.getFrame();
  assert.equal(dom.dirty, false);
  assert.equal(firstText.dirty, false);
  assert.equal(secondText.dirty, false);

  root.rerender(React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "red" }, "alpha"),
    React.createElement(Text, null, "stable")
  ));

  assert.equal(firstText.style.color, "red");
  assert.equal(secondText.dirty, false);
  assert.equal(root.getFrame()?.metadata.dirtyNodeCount, 3);
  root.unmount();
});
