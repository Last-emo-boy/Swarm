import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import React from "react";
import { defaultSwarmSettings } from "../config/settings.js";
import { SwarmDatabase } from "../storage/database.js";
import { UsageStore } from "../storage/usage-store.js";
import { StatusLine } from "./components/StatusLine.js";
import { assertFrameHasNoOverflow, createFrameSnapshot } from "./renderer/frame-snapshot.js";
import { renderTuiToFrame } from "./renderer/testing.js";
import { buildStatusLine } from "./status-line.js";
import { usageView } from "./usage-view.js";

test("/usage counts each model call of the session once and shows this device's day and its budgets", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-tui-usage-"));
  const database = new SwarmDatabase(join(root, "swarm.db"));
  try {
    const store = new UsageStore(database);
    const usage = { providerId: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", purpose: "main_coding_loop", sessionId: "s1",
      inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000, totalInputWithCacheTokens: 1_000_000, uncachedInputTokens: 200_000 };
    const at = "2026-11-07T12:00:00.000Z";
    store.append({ session_id: "s1", kind: "llm_call", amount: 1, unit: "count", metadata: usage, created_at: at });
    for (const [name, amount] of [["input", 1_000_000], ["cached_input", 800_000], ["uncached_input", 200_000], ["total_input_with_cache", 1_000_000], ["output", 100_000]] as const) {
      store.append({ session_id: "s1", kind: "llm_call", amount, unit: "tokens", metadata: { ...usage, token_type: name }, created_at: at });
    }
    const settings = defaultSwarmSettings();
    settings.usage.budgets.providers.deepseek = { daily: 0.05, currency: "USD" };
    const view = usageView({ database: database.db, settings, sessionId: "s1", policyBudget: "{}", now: new Date("2026-11-07T12:01:00.000Z") });
    assert.equal(view.brief, "s1 usage: 1 call · 1.00M in (800K cached) · 100K out · $0.0924 · 1 budget reached");
    assert.match(view.detail, /Model calls in this session, each counted once\n  model\s+calls\s+input\s+cached\s+output\s+cost\n  deepseek\/deepseek-v4-flash\s+1\s+1\.00M\s+800K\s+100K\s+\$0\.0924/);
    assert.match(view.detail, /This device today\n  provider/);
    assert.match(view.detail, /provider deepseek, daily: \$0\.0924 of \$0\.0500 — reached/);
    assert.match(view.detail, /Policy budget\n\{\}$/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the status line puts what needs attention first, fits the terminal, and keeps its hint at the right", () => {
  const line = buildStatusLine({
    budgetsReached: ["deepseek daily budget reached"],
    approvalsWaiting: 1,
    tickets: { needYou: 2, working: 3 },
    spentToday: "$0.13",
    promptEmpty: true
  });
  assert.deepEqual(line.items.map((item) => [item.text, item.tone]), [
    ["deepseek daily budget reached", "danger"], ["1 approval waiting", "warning"], ["2 tickets need you", "warning"], ["$0.13 today", "muted"]
  ]);
  assert.equal(line.hint, "? keys");
  assert.equal(buildStatusLine({ promptEmpty: false }).hint, "", "the hint gives way while typing: ? would be typed");
  assert.equal(buildStatusLine({ promptEmpty: true, transcriptFocus: true }).hint, "↑↓ pick · Enter fold · o open · Esc prompt");
  assert.deepEqual(buildStatusLine({ search: { query: "pair", position: "1/3" }, promptEmpty: true }),
    { items: [{ id: "search", text: "search \"pair\" 1/3", tone: "accent" }], hint: "Enter jump · Esc close" });

  for (const columns of [60, 120]) {
    const frame = renderTuiToFrame(React.createElement(StatusLine, { ...line, columns }), { columns, rows: 1 });
    assertFrameHasNoOverflow(createFrameSnapshot(frame));
    const text = frame.screen.cells.map((cells) => cells.map((cell) => cell.char).join("").trimEnd()).join("\n");
    assert.match(text, /\? keys$/);
    if (columns === 60) assert.match(text, /^ {3}deepseek daily budget reached +\? keys$/, "items that do not fit are left out whole");
    else assert.match(text, /^ {3}deepseek daily budget reached · 1 approval waiting · 2 tickets need you · \$0\.13 today +\? keys$/);
  }
});
