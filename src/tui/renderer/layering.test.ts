import { strict as assert } from "node:assert";
import test from "node:test";
import { closeTopLayer, topLayer } from "./layering.js";

test("renderer layers make modal z-order and focus restoration explicit", () => {
  const layers = [
    { layer: "conversation", open: true, focusOwner: "input" },
    { layer: "detail", open: true, focusOwner: "detail", previousFocusOwner: "input" },
    { layer: "approval", open: true, focusOwner: "approval", previousFocusOwner: "detail" }
  ] as const;

  assert.equal(topLayer(layers)?.layer, "approval");
  const closed = closeTopLayer(layers);
  assert.equal(closed.restoredFocusOwner, "detail");
  assert.equal(topLayer(closed.layers)?.layer, "detail");
});

