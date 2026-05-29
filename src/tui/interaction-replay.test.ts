import { strict as assert } from "node:assert";
import test from "node:test";
import {
  formatTuiReplaySuiteReport,
  runDefaultTuiReplaySuite,
  runTuiInteractionReplay
} from "./interaction-replay.js";

test("default TUI replay suite covers focus detail search fold and long-session budgets", () => {
  const suite = runDefaultTuiReplaySuite();
  const report = formatTuiReplaySuiteReport(suite).join("\n");

  assert.equal(suite.status, "pass", report);
  assert.equal(suite.failureCount, 0, report);
  assert.deepEqual(suite.scenarios.map((scenario) => scenario.name), [
    "startup-enter-command-output-guard",
    "debug-mode-trace-action-detail",
    "cache-miss-detail-search-replay",
    "lsp-fallback-detail-search-replay",
    "long-session-search-scroll-fold-budget"
  ]);

  const startup = suite.scenarios.find((scenario) => scenario.name === "startup-enter-command-output-guard");
  assert(startup);
  assert.equal(startup.trace[0]?.transition?.reason, "empty-enter");
  assert.equal(startup.trace[0]?.transition?.allowed, false);
  assert.equal(startup.trace[0]?.detailOpen, false);
  assert.equal(startup.trace[0]?.focus, "input");
  assert.equal(startup.finalState.focus, "input");
  assert.equal(startup.finalState.detailOpen, false);

  const debug = suite.scenarios.find((scenario) => scenario.name === "debug-mode-trace-action-detail");
  assert.equal(debug?.trace.some((entry) => entry.event === "slash:/view trace" && entry.pane === "trace"), true);
  assert.equal(debug?.trace.some((entry) => entry.selectedActionRow === 2), true);

  const cache = suite.scenarios.find((scenario) => scenario.name === "cache-miss-detail-search-replay");
  assert.equal(cache?.trace.some((entry) => entry.search?.includes("cache miss") && entry.currentSearchMessageIndex === 1), true);

  const lsp = suite.scenarios.find((scenario) => scenario.name === "lsp-fallback-detail-search-replay");
  assert.equal(lsp?.trace.some((entry) => entry.search?.includes("lsp fallback") && entry.currentSearchMessageIndex === 1), true);

  const long = suite.scenarios.find((scenario) => scenario.name === "long-session-search-scroll-fold-budget");
  assert(long);
  assert(long.maxMountedMessageCount <= 42, `mounted=${long.maxMountedMessageCount}`);
  assert(long.trace.some((entry) => entry.event === "fold:1175" && entry.selectedRow === 1175));
  assert.match(report, /TUI Replay/);
});

test("TUI replay failure trace points at the last focus detail pane and selected row", () => {
  const result = runTuiInteractionReplay({
    name: "bad-open-without-detail-source",
    messages: [{ role: "system", brief: "No detail is available." }],
    latestDetailSource: "none",
    events: [
      { type: "open-detail", via: "ctrl+o" }
    ]
  });

  assert.equal(result.status, "fail");
  assert.equal(result.failures[0]?.kind, "detail");
  assert.match(result.failures[0]?.message ?? "", /no latest or selected action target/);
  assert.equal(result.finalState.focus, "input");
  assert.equal(result.finalState.detailOpen, false);
});

test("TUI replay keeps collaboration overlay inline and returns with Esc", () => {
  const result = runTuiInteractionReplay({
    name: "collaboration-overlay-inline",
    messages: [{ role: "system", brief: "Swarm chat ready." }],
    events: [
      { type: "collaboration-key", character: "o", key: {}, inputIsEmpty: true },
      { type: "close-detail", via: "escape" }
    ]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.trace[0]?.collaborationOverlay, "ownership");
  assert.equal(result.trace[0]?.detailOpen, false);
  assert.equal(result.trace[0]?.focus, "input");
  assert.equal(result.finalState.collaborationOverlay, undefined);
  assert.equal(result.finalState.detailOpen, false);
});

test("TUI replay does not claim collaboration shortcut while prompt has text", () => {
  const result = runTuiInteractionReplay({
    name: "collaboration-shortcut-prompt-text-guard",
    messages: [{ role: "system", brief: "Swarm chat ready." }],
    events: [
      { type: "collaboration-key", character: "o", key: {}, inputIsEmpty: false }
    ]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.trace[0]?.collaborationOverlay, undefined);
  assert.equal(result.finalState.collaborationOverlay, undefined);
  assert.equal(result.finalState.focus, "input");
});

test("TUI replay models transcript scrollback keys without stealing prompt focus", () => {
  const messages = Array.from({ length: 80 }, (_, index) => (
    index % 2 === 0
      ? { role: "user" as const, brief: `prompt ${index}` }
      : { role: "assistant" as const, brief: `response ${index}` }
  ));
  const result = runTuiInteractionReplay({
    name: "transcript-scrollback-keymap",
    rows: 24,
    columns: 100,
    messages,
    events: [
      { type: "transcript-key", label: "pgup", key: { pageUp: true } },
      { type: "transcript-key", label: "ctrl-u", character: "u", key: { ctrl: true } },
      { type: "transcript-key", label: "home", key: { home: true } },
      { type: "transcript-key", label: "end", key: { end: true } },
      { type: "transcript-key", label: "g", character: "g", key: {} },
      { type: "transcript-key", label: "G", character: "G", key: {} },
      { type: "transcript-key", label: "ctrl-d", character: "d", key: { ctrl: true } }
    ]
  });

  assert.equal(result.status, "pass", result.failures.map((failure) => failure.message).join("\n"));
  assert((result.trace[0]?.scrollOffset ?? 0) > 0);
  assert((result.trace[2]?.scrollOffset ?? 0) > (result.trace[0]?.scrollOffset ?? 0));
  assert.equal(result.trace[3]?.scrollOffset, 0);
  assert((result.trace[4]?.scrollOffset ?? 0) > 0);
  assert.equal(result.trace[5]?.scrollOffset, 0);
  assert.equal(result.trace[6]?.scrollOffset, 0);
  assert.equal(result.finalState.focus, "input");
  assert.equal(result.finalState.detailOpen, false);
});

test("TUI replay keeps closed transcript search repeat navigation available", () => {
  const result = runTuiInteractionReplay({
    name: "transcript-search-repeat-navigation",
    rows: 24,
    columns: 100,
    messages: [
      { role: "user", brief: "first cache miss" },
      { role: "assistant", brief: "middle answer" },
      { role: "assistant", brief: "second cache miss" }
    ],
    events: [
      { type: "search", query: "cache miss" },
      { type: "search", close: true },
      { type: "search", delta: 1 },
      { type: "search", delta: -1 }
    ]
  });

  assert.equal(result.status, "pass", result.failures.map((failure) => failure.message).join("\n"));
  assert.equal(result.trace[0]?.currentSearchMessageIndex, 0);
  assert.equal(result.trace[1]?.search, undefined);
  assert.equal(result.trace[2]?.currentSearchMessageIndex, 2);
  assert.equal(result.trace[3]?.currentSearchMessageIndex, 0);
});
