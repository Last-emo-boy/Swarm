import { strict as assert } from "node:assert";
import test from "node:test";
import {
  formatRecoveryAdvice,
  recoveryAdviceFromCacheStatus,
  recoveryAdviceFromProviderError,
  recoveryAdviceFromToolFailure
} from "./recovery.js";

test("provider rate-limit recovery redacts API keys and stays retryable", () => {
  const advice = recoveryAdviceFromProviderError({
    message: "HTTP 429 Too Many Requests apiKey=sk-test1234567890"
  });

  assert(advice, "expected rate-limit recovery advice");
  assert.equal(advice.category, "provider_rate_limit");
  assert.equal(advice.severity, "warning");
  assert.equal(advice.retryable, true);
  assert.doesNotMatch(JSON.stringify(advice), /sk-test/);
  assert.doesNotMatch(formatRecoveryAdvice(advice), /sk-test/);
});

test("provider auth failures map to provider config recovery", () => {
  const advice = recoveryAdviceFromProviderError({
    message: "401 invalid api key",
    statusCode: 401
  });

  assert(advice, "expected provider config recovery advice");
  assert.equal(advice.category, "provider_config");
  assert.equal(advice.severity, "error");
  assert.equal(advice.retryable, false);
  assert.match(advice.nextAction, /endpoint, model name, and API key/i);
});

test("read-root denied failures expose the add-dir command hint", () => {
  const advice = recoveryAdviceFromToolFailure({
    action: "file.read",
    reason: "Path is outside the current read roots.",
    errorCode: "READ_ROOT_DENIED",
    recoverySuggestion: "Add a read root before retrying: /add-dir E:\\Shared or swarm run --add-dir E:\\Shared"
  });

  assert.equal(advice.category, "read_root");
  assert.equal(advice.severity, "warning");
  assert.equal(advice.retryable, true);
  assert.equal(advice.commandHint, "/add-dir E:\\Shared");
});

test("cache changed and miss statuses map to cache recovery", () => {
  const changed = recoveryAdviceFromCacheStatus({
    status: "changed",
    outcome: "miss",
    changed: ["requestPrefixHash4096"],
    changedSections: ["tools"],
    missReason: "changed_tools",
    diagnostics: "sections:tools"
  });
  const miss = recoveryAdviceFromCacheStatus({
    status: "cache_miss",
    outcome: "miss",
    reason: "provider reported no reusable prefix"
  });

  assert(changed, "expected changed cache recovery");
  assert.equal(changed.category, "cache");
  assert.match(changed.nextAction, /stable system text/i);
  assert.match(changed.detail ?? "", /requestPrefixHash4096/);
  assert.match(changed.detail ?? "", /miss_reason=changed_tools/);
  assert.match(changed.detail ?? "", /changed_sections=tools/);
  assert(miss, "expected cache miss recovery");
  assert.equal(miss.category, "cache");
  assert.match(miss.summary, /provider reported no reusable prefix/);
});
