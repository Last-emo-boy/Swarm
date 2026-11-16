import { strict as assert } from "node:assert";
import test from "node:test";
import { inputViewport, visibleInputRows } from "./input-rendering.js";

test("visibleInputRows reports single-line prompts as one row", () => {
  assert.equal(visibleInputRows("hello", 5), 1);
});

test("a line the terminal wraps takes the rows it draws", () => {
  // The input renders wrapped text (ChatInputArea's InputLine), so a long single line is several rows on screen; a count
  // that did not know the width let the bottom slot clip it and pushed the status line out.
  assert.equal(visibleInputRows("x".repeat(10), 10, 4, 8), 2);
  assert.equal(visibleInputRows("x".repeat(8), 8, 4, 8), 1);
  assert.equal(visibleInputRows("中".repeat(4), 4, 4, 8), 1);
  assert.equal(visibleInputRows("中".repeat(5), 5, 4, 8), 2);
  // Still capped by the viewport's rows, and without a width the count is logical lines as before.
  assert.equal(visibleInputRows(["one", "two", "three"].join("\n"), 13, 2, 8), 2);
  assert.equal(visibleInputRows("x".repeat(100), 100, 4), 1);
});

test("visibleInputRows caps multiline prompt viewport", () => {
  const value = ["one", "two", "three", "four", "five", "six"].join("\n");
  const viewport = inputViewport(value, value.length, 4);

  assert.equal(viewport.rows, 4);
  assert.equal(visibleInputRows(value, value.length, 4), 4);
  assert.match(viewport.value, /^\.\.\. /);
  assert.match(viewport.value, /six$/);
});
