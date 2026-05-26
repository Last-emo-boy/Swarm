import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box } from "./components/Box.js";
import { NoSelect } from "./components/NoSelect.js";
import { Text } from "./components/Text.js";
import { renderReactTreeToDom } from "./reconciler.js";
import { renderDomToFrame } from "./renderer.js";
import { selectedTextFromScreen, shiftSelectionRange, wordSelectionAt } from "./selection.js";

test("selection extracts copy-safe screen text without no-select chrome", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, null,
        React.createElement(NoSelect, null, "> "),
        "hello world"
      ),
      React.createElement(Text, null,
        React.createElement(NoSelect, null, "[status] "),
        "cache hit"
      )
    )),
    { columns: 24, rows: 3 }
  );

  assert.equal(selectedTextFromScreen(frame.screen, {
    anchor: { x: 0, y: 0 },
    focus: { x: 20, y: 1 }
  }), "hello world\ncache hit");
});

test("selection supports word ranges and scroll-aware row shifts", () => {
  const frame = renderDomToFrame(
    renderReactTreeToDom(React.createElement(Text, null, "alpha beta")),
    { columns: 16, rows: 2 }
  );

  assert.deepEqual(wordSelectionAt(frame.screen, { x: 7, y: 0 }), {
    anchor: { x: 6, y: 0 },
    focus: { x: 9, y: 0 }
  });
  assert.deepEqual(shiftSelectionRange({
    anchor: { x: 1, y: 4 },
    focus: { x: 3, y: 6 }
  }, -2), {
    anchor: { x: 1, y: 2 },
    focus: { x: 3, y: 4 }
  });
});

