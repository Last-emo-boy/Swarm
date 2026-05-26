import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { Text } from "./components/Text.js";
import { OffscreenRenderCache, renderToScreen } from "./render-to-screen.js";
import { searchFrameText } from "./search-highlight.js";
import { screenToLines } from "./screen.js";

test("offscreen render produces searchable screen cells", () => {
  const result = renderToScreen(React.createElement(Text, null, "Cache hit\nCache miss"), {
    width: 20,
    height: 4
  });
  assert.equal(result.diagnostics.status, "cache_miss");
  assert.deepEqual(screenToLines(result.frame.screen).slice(0, 2), ["Cache hit", "Cache miss"]);
  assert.deepEqual(searchFrameText(result.frame, "cache").map((match) => [match.row, match.column]), [
    [0, 0],
    [1, 0]
  ]);
});

test("offscreen render cache keys by id width height and revision", () => {
  const cache = new OffscreenRenderCache();
  const first = cache.render(React.createElement(Text, null, "alpha"), {
    id: "message:1",
    width: 10,
    height: 3,
    revision: 1
  });
  const second = cache.render(React.createElement(Text, null, "alpha changed"), {
    id: "message:1",
    width: 10,
    height: 3,
    revision: 1
  });
  const third = cache.render(React.createElement(Text, null, "alpha changed"), {
    id: "message:1",
    width: 10,
    height: 3,
    revision: 2
  });

  assert.equal(first.diagnostics.status, "cache_miss");
  assert.equal(second.diagnostics.status, "cache_hit");
  assert.equal(third.diagnostics.status, "cache_miss");
  assert.equal(cache.size(), 2);
});

