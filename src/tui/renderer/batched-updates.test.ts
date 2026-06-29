import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { useState } from "react";
import { Box } from "./components/Box.js";
import { Text } from "./components/Text.js";
import { createTuiRoot } from "./root.js";
import { batchedUpdates } from "./reconciler.js";
import { screenToLines } from "./screen.js";

// Setters captured during render so the test can drive setState from outside
// React's own event dispatch — the same situation as a runtime EventEmitter
// callback, where LegacyRoot performs no automatic batching.
let setters: Array<(n: number) => void> = [];

function MultiState(): React.ReactElement {
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const [c, setC] = useState(0);
  const [d, setD] = useState(0);
  setters = [setA, setB, setC, setD];
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, null, `a${a} b${b} c${c} d${d}`)
  );
}

test("batchedUpdates collapses many synchronous setState into one paint", async () => {
  let paints = 0;
  const root = createTuiRoot({ columns: 24, rows: 3, onFrame() { paints += 1; } });
  root.render(React.createElement(MultiState));
  assert.equal(paints, 1);

  // Outside React's batching, each setState drives its own commit + paint.
  const beforeUnbatched = paints;
  setters[0](1); setters[1](1); setters[2](1); setters[3](1);
  assert.equal(paints - beforeUnbatched, 4, "expected one paint per setState without batching");
  const frameUnbatched = screenToLines(root.getFrame()!.screen)[0];

  // Reset, then run the same four setState calls inside a single batch.
  setters[0](0); setters[1](0); setters[2](0); setters[3](0);
  const beforeBatched = paints;
  batchedUpdates(() => {
    setters[0](1); setters[1](1); setters[2](1); setters[3](1);
  });
  assert.equal(paints - beforeBatched, 1, "expected a single paint for the batched updates");

  // The batched flush is synchronous and produces the identical final frame.
  const frameBatched = screenToLines(root.getFrame()!.screen)[0];
  assert.equal(frameBatched, frameUnbatched);
  assert.equal(frameBatched, "a1 b1 c1 d1");

  const wait = root.waitUntilExit();
  root.unmount();
  await wait;
});
