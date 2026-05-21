import { strict as assert } from "node:assert";
import test from "node:test";
import { displayWidth, sliceByDisplayWidth } from "./display-width.js";

test("displayWidth treats CJK characters as two terminal cells", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文abc"), 7);
});

test("sliceByDisplayWidth does not split past the terminal cell limit", () => {
  const sliced = sliceByDisplayWidth("中文abc", 5);
  assert.equal(sliced.head, "中文a");
  assert.equal(sliced.tail, "bc");
  assert.equal(displayWidth(sliced.head), 5);
});
