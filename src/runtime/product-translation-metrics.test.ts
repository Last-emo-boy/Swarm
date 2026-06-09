import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  formatProductMetricsSummary,
  productMetricsSmokeEvents,
  readProductMetricEvents,
  recordProductMetricEvent,
  summarizeProductMetricEvents,
  summarizeProductMetrics
} from "./product-translation-metrics.js";

test("product metrics record local-only events and summarize first-result timing", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-product-metrics-"));
  const path = join(dir, "metrics.jsonl");
  try {
    recordProductMetricEvent({
      event: "scenario_started",
      source: "tui",
      flow_id: "flow 1",
      scenario: "codebase_deep_review",
      route: "coding_loop",
      focus_provided: true
    }, { path, at: new Date("2026-06-03T00:00:00.000Z") });
    recordProductMetricEvent({
      event: "result_card_shown",
      source: "tui",
      flow_id: "flow 1",
      session_id: "session 1",
      scenario: "codebase_deep_review",
      route: "work",
      status: "completed",
      has_result_card: true,
      changed_files: 2,
      checks: 1,
      findings: 3
    }, { path, at: new Date("2026-06-03T00:01:30.000Z") });
    recordProductMetricEvent({
      event: "observatory_opened",
      source: "tui",
      flow_id: "flow 1",
      session_id: "session 1",
      view: "team_reasoning",
      trigger: "result_action"
    }, { path, at: new Date("2026-06-03T00:01:35.000Z") });
    recordProductMetricEvent({
      event: "steering_used",
      source: "tui",
      flow_id: "flow 1",
      session_id: "session 1",
      steering: "reply",
      trigger: "slash"
    }, { path, at: new Date("2026-06-03T00:00:45.000Z") });
    appendFileSync(path, "{not-json}\n", "utf8");

    const events = readProductMetricEvents(path);
    const summary = summarizeProductMetrics(path);
    const text = formatProductMetricsSummary(summary).join("\n");

    assert.equal(events.length, 4);
    assert.equal(events[0]?.flow_id, "flow-1");
    assert.equal(summary.event_count, 4);
    assert.equal(summary.scenario_sessions, 1);
    assert.equal(summary.scenario_completed, 1);
    assert.equal(summary.scenario_completion_rate, 100);
    assert.equal(summary.time_to_impressive_result.p50_ms, 90_000);
    assert.equal(summary.sessions_without_advanced_views.count, 0);
    assert.equal(summary.advanced_views.by_view.team_reasoning, 1);
    assert.equal(summary.steering.reply, 1);
    assert.equal(summary.privacy.local_only, true);
    assert.equal(summary.privacy.prompt_text_stored, false);
    assert.match(text, /time_to_impressive_result count=1/);
    assert.match(text, /privacy=local-only prompt_text_stored=false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("product metrics smoke events validate the no-advanced-view happy path", () => {
  const summary = summarizeProductMetricEvents(productMetricsSmokeEvents());

  assert.equal(summary.scenario_sessions, 1);
  assert.equal(summary.scenario_completed, 1);
  assert.equal(summary.time_to_impressive_result.p50_ms, 87_000);
  assert.equal(summary.sessions_without_advanced_views.percent, 100);
  assert.equal(summary.steering.reply, 1);
});

test("product metrics can be disabled without affecting callers", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-product-metrics-disabled-"));
  const path = join(dir, "metrics.jsonl");
  const previous = process.env.SWARM_PRODUCT_METRICS;
  try {
    process.env.SWARM_PRODUCT_METRICS = "0";
    const event = recordProductMetricEvent({
      event: "scenario_started",
      source: "headless",
      scenario: "codebase_deep_review"
    }, { path });

    assert.equal(event, undefined);
    assert.deepEqual(readProductMetricEvents(path), []);
  } finally {
    if (previous === undefined) {
      delete process.env.SWARM_PRODUCT_METRICS;
    } else {
      process.env.SWARM_PRODUCT_METRICS = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
