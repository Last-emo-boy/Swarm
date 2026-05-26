import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultSwarmConfig, defaultSwarmSettings } from "../config/settings.js";
import {
  buildProviderProfiles,
  explainProviderProbeError,
  formatProviderProfiles
} from "./provider-profile.js";

test("buildProviderProfiles describes OpenAI-compatible DeepSeek profile without leaking keys", () => {
  const settings = defaultSwarmSettings();
  settings.models.defaultProvider = "deepseek";
  settings.models.planner = "deepseek/test-chat";
  settings.models.worker = "deepseek/test-chat";
  settings.models.aggregator = "deepseek/test-chat";
  settings.providers.deepseek.baseURL = "https://api.deepseek.com";
  settings.providers.deepseek.models = {
    "test-chat": { name: "Test Chat" }
  };

  const config = defaultSwarmConfig();
  config.providerApiKeys.deepseek = "sk-test-secret-123456";

  const profiles = buildProviderProfiles({ settings, config });
  const profile = profiles.find((item) => item.providerId === "deepseek");

  assert(profile);
  assert.equal(profile.compatMode, "openai-compatible");
  assert.equal(profile.baseURL, "https://api.deepseek.com");
  assert.deepEqual(profile.selectedRoles, ["planner", "worker", "aggregator"]);
  assert.deepEqual(profile.selectedModels, ["test-chat"]);
  assert.equal(profile.apiKeySource, "config");
  assert.match(profile.apiKeyFingerprint ?? "", /^sha256:[a-f0-9]{10}$/);
  assert.notEqual(profile.apiKeyFingerprint, "sk-test-secret-123456");
  assert.equal(profile.supportsUsage, true);
  assert.equal(profile.supportsCacheUsage, true);
  assert.equal(profile.configured, true);
  assert.deepEqual(profile.problems, []);

  const formatted = formatProviderProfiles(profiles).join("\n");
  assert.match(formatted, /provider=deepseek mode=openai-compatible/);
  assert.match(formatted, /endpoint=https:\/\/api\.deepseek\.com/);
  assert.match(formatted, /api_key=config fingerprint=sha256:/);
  assert.match(formatted, /usage=supported cache_usage=supported/);
  assert.doesNotMatch(formatted, /sk-test-secret-123456/);
});

test("buildProviderProfiles reports missing key and unknown model next actions", () => {
  const settings = defaultSwarmSettings();
  settings.models.defaultProvider = "deepseek";
  settings.models.planner = "deepseek/does-not-exist";
  settings.providers.deepseek.models = {
    "known-chat": { name: "Known Chat" }
  };

  const profile = buildProviderProfiles({
    settings,
    config: defaultSwarmConfig()
  }).find((item) => item.providerId === "deepseek");

  assert(profile);
  assert.equal(profile.configured, false);
  assert.equal(profile.apiKeySource, "missing");
  assert(profile.problems.some((problem) => problem.includes("Missing API key")));
  assert(profile.problems.some((problem) => problem.includes("Unknown model")));
  assert(profile.nextActions.some((action) => action.includes("DEEPSEEK_API_KEY")));
});

test("explainProviderProbeError classifies provider failures and redacts secrets", () => {
  const cases = [
    {
      input: { statusCode: 401, message: "Authorization: Bearer sk-test-secret-123456 is invalid", providerId: "deepseek" },
      code: "auth_failed",
      retryable: false
    },
    {
      input: { statusCode: 404, message: "model not found: missing-model", providerId: "deepseek" },
      code: "model_not_found",
      retryable: false
    },
    {
      input: { statusCode: 429, message: "rate limit exceeded", providerId: "deepseek" },
      code: "rate_limited",
      retryable: true
    },
    {
      input: { message: "prompt_cache usage unsupported by this endpoint", providerId: "compatible" },
      code: "unsupported_usage",
      retryable: false
    },
    {
      input: { message: "fetch failed: ENOTFOUND api.example.invalid", providerId: "compatible" },
      code: "network_error",
      retryable: true
    },
    {
      input: { statusCode: 500, message: "upstream provider error", providerId: "deepseek" },
      code: "provider_error",
      retryable: true
    }
  ] as const;

  for (const item of cases) {
    const explanation = explainProviderProbeError(item.input);
    assert.equal(explanation.code, item.code);
    assert.equal(explanation.retryable, item.retryable);
    assert(explanation.summary.length > 0);
    assert(explanation.nextAction.length > 0);
    assert.doesNotMatch(JSON.stringify(explanation), /sk-test-secret-123456/);
    assert.doesNotMatch(JSON.stringify(explanation), /Bearer sk-test-secret-123456/);
  }
});
