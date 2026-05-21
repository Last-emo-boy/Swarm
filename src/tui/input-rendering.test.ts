import { strict as assert } from "node:assert";
import test from "node:test";
import { inputViewport, visibleInputRows } from "./input-rendering.js";

test("visibleInputRows reports single-line prompts as one row", () => {
  assert.equal(visibleInputRows("hello", 5), 1);
});

test("visibleInputRows caps multiline prompt viewport", () => {
  const value = ["one", "two", "three", "four", "five", "six"].join("\n");
  const viewport = inputViewport(value, value.length, 4);

  assert.equal(viewport.rows, 4);
  assert.equal(visibleInputRows(value, value.length, 4), 4);
  assert.match(viewport.value, /^\.\.\. /);
  assert.match(viewport.value, /six$/);
});
