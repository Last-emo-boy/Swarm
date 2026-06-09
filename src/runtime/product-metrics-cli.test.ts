import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createCodebaseReviewMetricsContext,
  formatProductMetricsCommandOutput,
  stringRecordValue
} from "./product-metrics-cli.js";

test("product metrics CLI helper formats demo JSON output", () => {
  const output = formatProductMetricsCommandOutput({
    demo: true,
    json: true,
    path: "product-metrics-smoke.jsonl"
  });
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const privacy = parsed.privacy as Record<string, unknown>;
  const timing = parsed.time_to_impressive_result as Record<string, unknown>;

  assert.equal(parsed.schema_version, "swarm.product_metrics_summary.v1");
  assert.equal(parsed.scenario_sessions, 1);
  assert.equal(parsed.scenario_completed, 1);
  assert.equal(timing.p50_ms, 87_000);
  assert.equal(privacy.local_only, true);
  assert.equal(privacy.prompt_text_stored, false);
});

test("product metrics CLI helper handles missing metrics files", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "swarm-product-metrics-cli-"));
  try {
    const output = formatProductMetricsCommandOutput({
      json: true,
      path: join(dir, "missing", "metrics.jsonl")
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const timing = parsed.time_to_impressive_result as Record<string, unknown>;

    assert.equal(parsed.event_count, 0);
    assert.equal(parsed.scenario_sessions, 0);
    assert.equal(parsed.scenario_completed, 0);
    assert.equal(timing.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review metrics context tracks whether focus was provided", () => {
  const blank = createCodebaseReviewMetricsContext("  ");
  const focused = createCodebaseReviewMetricsContext("auth and permissions");

  assert.equal(blank.scenario, "codebase_deep_review");
  assert.equal(blank.focusProvided, false);
  assert.match(blank.flowId, /^review_/);
  assert.equal(focused.focusProvided, true);
  assert.match(focused.flowId, /^review_/);
});

test("stringRecordValue only accepts non-empty string fields", () => {
  assert.equal(stringRecordValue({ session_id: " sess_1 " }, "session_id"), " sess_1 ");
  assert.equal(stringRecordValue({ session_id: "   " }, "session_id"), undefined);
  assert.equal(stringRecordValue({ session_id: 42 }, "session_id"), undefined);
  assert.equal(stringRecordValue(null, "session_id"), undefined);
  assert.equal(stringRecordValue("not-object", "session_id"), undefined);
});
