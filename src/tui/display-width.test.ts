import { strict as assert } from "node:assert";
import test from "node:test";
import { ansiDisplayWidth, displayWidth, fitToDisplayWidth, padToDisplayWidth, sliceByDisplayWidth, stripAnsi } from "./display-width.js";

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

test("display-width helpers ignore ANSI control sequences", () => {
  const colored = "\u001b[36mWorkspace Write\u001b[0m [RW]";
  assert.equal(stripAnsi(colored), "Workspace Write [RW]");
  assert.equal(ansiDisplayWidth(colored), "Workspace Write [RW]".length);
});

test("fitToDisplayWidth and padToDisplayWidth handle emoji and Windows paths", () => {
  assert.equal(displayWidth("😀"), 2);
  assert.equal(fitToDisplayWidth("C:\\Users\\ES&E\\VeryLongWorkspace", 18), "C:\\Users\\ES&E\\V...");
  assert.equal(displayWidth(fitToDisplayWidth("任务 ✅ running", 10)), 10);
  assert.equal(padToDisplayWidth("RW", 6), "RW    ");
  assert.equal(displayWidth(padToDisplayWidth("中文", 6)), 6);
});
