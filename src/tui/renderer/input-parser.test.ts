import { strict as assert } from "node:assert";
import test from "node:test";
import { TuiInputParser, parseTuiInputChunk } from "./input-parser.js";

test("TUI input parser emits typed text enter escape ctrl arrows and modifiers", () => {
  const events = parseTuiInputChunk("a\r\u001B\u0003\u001B[1;5A\u001B[3~", { flush: true });

  assert.deepEqual(events.map((event) => event.type), ["key", "key", "key", "key", "key", "key"]);
  assert.deepEqual(events[0], { type: "key", input: "a", key: {}, raw: "a" });
  assert.deepEqual(events[1], { type: "key", key: { return: true }, raw: "\r" });
  assert.deepEqual(events[2], { type: "key", key: { escape: true }, raw: "\u001B" });
  assert.deepEqual(events[3], { type: "key", input: "c", key: { ctrl: true }, raw: "\u0003" });
  assert.deepEqual(events[4], { type: "key", key: { upArrow: true, ctrl: true }, raw: "\u001B[1;5A" });
  assert.deepEqual(events[5], { type: "key", key: { delete: true }, raw: "\u001B[3~" });
});

test("TUI input parser maps raw C0 control bytes to ctrl key labels", () => {
  const events = parseTuiInputChunk("\x0f\x0e\x10\x14", { flush: true });

  assert.deepEqual(events, [
    { type: "key", input: "o", key: { ctrl: true }, raw: "\x0f" },
    { type: "key", input: "n", key: { ctrl: true }, raw: "\x0e" },
    { type: "key", input: "p", key: { ctrl: true }, raw: "\x10" },
    { type: "key", input: "t", key: { ctrl: true }, raw: "\x14" }
  ]);
});

test("TUI input parser coalesces bracketed paste and keeps incomplete escapes buffered", () => {
  const parser = new TuiInputParser();

  assert.deepEqual(parser.parse("\u001B[200~line 1\n"), []);
  assert.equal(parser.pending(), "");

  const events = parser.parse("line 2\u001B[201~");
  assert.deepEqual(events, [{
    type: "paste",
    text: "line 1\nline 2",
    key: { paste: true },
    raw: "\u001B[200~line 1\nline 2\u001B[201~"
  }]);

  const split = new TuiInputParser();
  assert.deepEqual(split.parse("\u001B["), []);
  assert.equal(split.pending(), "\u001B[");
  assert.deepEqual(split.parse("A"), [{ type: "key", key: { upArrow: true }, raw: "\u001B[A" }]);
});

test("TUI input parser separates mouse focus and terminal responses from prompt text", () => {
  const events = parseTuiInputChunk("\u001B[<0;4;2M\u001B[I\u001B[O\u001B[?1;2c\u001B]8;;https://example.test\u001B\\", { flush: true });

  assert.equal(events[0]?.type, "mouse");
  assert.deepEqual(events[0], {
    type: "mouse",
    mouse: { x: 3, y: 1, button: "left", action: "press" },
    raw: "\u001B[<0;4;2M"
  });
  assert.deepEqual(events[1], { type: "terminal-focus", focused: true, raw: "\u001B[I" });
  assert.deepEqual(events[2], { type: "terminal-focus", focused: false, raw: "\u001B[O" });
  assert.equal(events[3]?.type, "terminal-response");
  assert.equal(events[4]?.type, "terminal-response");
});
