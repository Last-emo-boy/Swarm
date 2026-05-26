import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Box } from "./components/Box.js";
import { Link } from "./components/Link.js";
import { NoSelect } from "./components/NoSelect.js";
import { Text } from "./components/Text.js";
import { hitTestDom, hitTestLink, hitTestScreen } from "./hit-test.js";
import { renderReactTreeToDom } from "./reconciler.js";
import { renderDomToFrame } from "./renderer.js";

test("hit test maps screen cells back to links no-select and owner chains", () => {
  const dom = renderReactTreeToDom(React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, null, React.createElement(Link, { href: "https://example.test" }, "docs")),
    React.createElement(Text, null, React.createElement(NoSelect, null, "chrome"), " value")
  ));
  const frame = renderDomToFrame(dom, { columns: 20, rows: 3 });

  assert.equal(hitTestLink(frame.screen, 1, 0), "https://example.test");
  assert.equal(hitTestScreen(frame.screen, 1, 1)?.noSelect, true);
  assert.equal(hitTestScreen(frame.screen, 8, 1)?.noSelect, false);
  assert(hitTestScreen(frame.screen, 1, 0)?.ownerChain.length);
  assert.equal(hitTestDom(dom, 1, 0)?.nodeName, "swarm-link");
});

