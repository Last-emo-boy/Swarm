import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box, Text } from "../ui.js";
import { renderTuiToFrame } from "./testing.js";
import { screenToSvg, styledRuns } from "./frame-svg.js";
import { resolveTuiColor, withTuiThemeProfile } from "../theme.js";

test("a screen becomes an SVG panel: runs at their columns, colours and bold kept, CJK and rules on the grid", () => {
  const frame = withTuiThemeProfile("swarm-dark", () => renderTuiToFrame(React.createElement(Box, { flexDirection: "column", width: 30 },
    React.createElement(Text, null,
      React.createElement(Text, { color: resolveTuiColor("brand.focus"), bold: true }, "› "),
      React.createElement(Text, null, "配对 <ok> & go")
    ),
    React.createElement(Text, { color: resolveTuiColor("surface.line") }, "─".repeat(30)),
    React.createElement(Text, { backgroundColor: resolveTuiColor("surface.selection") }, "picked")
  ), { columns: 30, rows: 6 }));

  const runs = styledRuns(frame.screen.cells[0]!);
  assert.deepEqual(runs.map((run) => [run.column, run.cells, run.text]), [[0, 2, "› "], [2, 4, "配对"], [6, 10, " <ok> & go"]],
    "a wide run is cut from the narrow text around it, and counts two cells per character");

  const svg = screenToSvg(frame.screen, { fontSize: 10, cellRatio: 0.6, lineHeight: 14, padding: 0, title: "a <test> frame" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="180" height="42"/, "three rows are kept, blank rows below dropped");
  assert.match(svg, /<title>a &lt;test&gt; frame<\/title>/);
  assert.match(svg, /<text xml:space="preserve" x="0" y="10" textLength="12" lengthAdjust="spacingAndGlyphs" fill="#e09758" font-weight="700">› <\/text>/);
  assert.match(svg, /<text xml:space="preserve" x="12" y="10" textLength="24" [^>]*fill="#e8e8e8">配对<\/text>/, "uncoloured text takes the terminal foreground");
  assert.match(svg, /<text xml:space="preserve" x="36" y="10" textLength="60" [^>]*> &lt;ok&gt; &amp; go<\/text>/, "XML is escaped and trailing blanks are not drawn");
  assert.match(svg, /<line x1="0" y1="21" x2="180" y2="21" stroke="#525252" stroke-width="1"\/>/, "a rule is drawn as a line");
  assert.match(svg, /<rect x="0" y="28" width="36" height="14" fill="#264f78"\/>/, "a background becomes a rectangle behind its run");
  assert.doesNotMatch(svg, /─/);
});

test("inverse cells swap foreground and background, and trailing spaces draw nothing", () => {
  const frame = renderTuiToFrame(React.createElement(Text, { inverse: true }, "A"), { columns: 10, rows: 1 });
  const runs = styledRuns(frame.screen.cells[0]!);
  assert.equal(runs.length, 1);
  const svg = screenToSvg(frame.screen, { background: "#000000", foreground: "#ffffff", padding: 0, fontSize: 10, cellRatio: 0.6, lineHeight: 14 });
  assert.match(svg, /<rect x="0" y="0" width="6" height="14" fill="#ffffff"\/>/);
  assert.match(svg, /fill="#000000">A<\/text>/);
});
