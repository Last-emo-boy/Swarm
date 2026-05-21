import { strict as assert } from "node:assert";
import test from "node:test";
import { parseRipgrepJson } from "./file-grep.js";
import type { LocalToolContext } from "./types.js";

test("parseRipgrepJson maps matches and context lines", () => {
  const context = { workspace: process.cwd(), settings: {} } as LocalToolContext;
  const stdout = [
    JSON.stringify({ type: "context", data: { path: { text: "src/a.ts" }, line_number: 1, lines: { text: "before\n" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 2, lines: { text: "needle\n" } } }),
    JSON.stringify({ type: "context", data: { path: { text: "src/a.ts" }, line_number: 3, lines: { text: "after\n" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "src/b.ts" }, line_number: 1, lines: { text: "needle two\n" } } })
  ].join("\n");

  const matches = parseRipgrepJson({
    stdout,
    context,
    maxMatches: 5,
    displayPath: (path) => path.replace(/\\/g, "/"),
    isPathDenied: () => false
  });

  assert.deepEqual(matches, [{
    path: `${process.cwd().replace(/\\/g, "/")}/src/a.ts`,
    line: 2,
    text: "needle",
    after: ["after"]
  }, {
    path: `${process.cwd().replace(/\\/g, "/")}/src/b.ts`,
    line: 1,
    text: "needle two"
  }]);
});

test("parseRipgrepJson honors max match limit", () => {
  const context = { workspace: process.cwd(), settings: {} } as LocalToolContext;
  const stdout = [
    JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 2, lines: { text: "needle\n" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "src/b.ts" }, line_number: 1, lines: { text: "needle two\n" } } })
  ].join("\n");

  const matches = parseRipgrepJson({
    stdout,
    context,
    maxMatches: 1,
    displayPath: (path) => path.replace(/\\/g, "/"),
    isPathDenied: () => false
  });

  assert.deepEqual(matches, [{
    path: `${process.cwd().replace(/\\/g, "/")}/src/a.ts`,
    line: 2,
    text: "needle"
  }]);
});

test("parseRipgrepJson skips denied paths and returns undefined for malformed JSON", () => {
  const context = { workspace: process.cwd(), settings: {} } as LocalToolContext;
  const denied = parseRipgrepJson({
    stdout: JSON.stringify({ type: "match", data: { path: { text: ".env" }, line_number: 1, lines: { text: "secret\n" } } }),
    context,
    maxMatches: 5,
    displayPath: (path) => path,
    isPathDenied: () => true
  });

  assert.deepEqual(denied, []);
  assert.equal(parseRipgrepJson({
    stdout: "{not json",
    context,
    maxMatches: 5,
    displayPath: (path) => path,
    isPathDenied: () => false
  }), undefined);
});
