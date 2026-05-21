import { strict as assert } from "node:assert";
import test from "node:test";
import {
  approvalRiskToken,
  cacheOutcomeTone,
  checkStatusTone,
  compactKernelRow,
  serviceHealthTone,
  transcriptEventToken
} from "./theme.js";

test("TUI theme exposes semantic tokens for transcript, approvals, cache, services, and compact rows", () => {
  assert.deepEqual(transcriptEventToken("tool_result", "success"), {
    prefix: "✓ result ",
    label: "result",
    tone: "success"
  });
  assert.deepEqual(transcriptEventToken("approval", "pending"), {
    prefix: "? approval ",
    label: "approval",
    tone: "pending"
  });
  assert.equal(approvalRiskToken({ risk: "shell", riskClass: "r4" }).tone, "danger");
  assert.equal(checkStatusTone("failed"), "danger");
  assert.equal(cacheOutcomeTone("cache_hit"), "success");
  assert.equal(cacheOutcomeTone("cache_miss"), "pending");
  assert.equal(serviceHealthTone("reconnecting"), "warning");
  assert.equal(compactKernelRow({
    status: "running",
    kind: "session",
    id: "session-123456789",
    title: "Long running objective",
    metadata: ["agent=worker", undefined, "cache=hit"]
  }), "[RUN] SESSION session... Long running objective (agent=worker | cache=hit)");
});
