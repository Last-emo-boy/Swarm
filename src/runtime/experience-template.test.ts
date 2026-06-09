import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SwarmPolicy } from "../protocol/types.js";
import {
  resolveExperienceProfile,
  getAllExperienceProfiles,
  applyExperienceProfileToPolicy,
  buildExperienceObjective,
  buildCodebaseDeepReviewObjective,
  getExperienceStarters,
  EXPERIENCE_PROFILE_NAMES
} from "./experience-template.js";

const BASE_POLICY: SwarmPolicy = {
  max_agents: 6,
  max_parallel_tasks: 3,
  timeout_ms: 180_000,
  retry: { max_attempts: 2, backoff_ms: 5000 },
  require_review: true,
  consensus: "reviewer_approval",
  approval_mode: "on-request",
  network_access: "deny",
  allow_domains: [],
  human_approval_for: [],
  safety: {
    require_human_approval_for: ["tool.shell.exec"],
    forbidden_capabilities: ["credential.exfiltrate"],
    sandbox_required: false
  },
  memory: { allow_read: true, allow_write: true, retention: "session" },
  budget: { max_tool_calls: 50 }
};

describe("experience-template", () => {
  it("should resolve known profiles by canonical name", () => {
    const careful = resolveExperienceProfile("careful-security-review");
    assert.ok(careful);
    assert.equal(careful.name, "careful-security-review");
    assert.equal(careful.intensity, "careful");

    const fast = resolveExperienceProfile("fast-architecture-pass");
    assert.ok(fast);
    assert.equal(fast.intensity, "balanced");

    const auto = resolveExperienceProfile("autonomous-safe-draft");
    assert.ok(auto);
    assert.equal(auto.intensity, "fast");
  });

  it("should return undefined for unknown names", () => {
    assert.equal(resolveExperienceProfile("nonexistent"), undefined);
    assert.equal(resolveExperienceProfile(""), undefined);
  });

  it("should list all registered profiles", () => {
    const all = getAllExperienceProfiles();
    assert.ok(all.length >= 3);
    assert.ok(all.every((p) => EXPERIENCE_PROFILE_NAMES.includes(p.name)));
    assert.ok(all.every((p) => p.label.length > 0 && p.resultRequirements.length > 0));
  });

  it("applyExperienceProfileToPolicy should merge safety and budget correctly for careful profile", () => {
    const profile = resolveExperienceProfile("careful-security-review")!;
    const merged = applyExperienceProfileToPolicy(BASE_POLICY, profile);

    assert.equal(merged.require_review, true);
    assert.equal(merged.consensus, "reviewer_approval");
    assert.equal(merged.safety.sandbox_required, true);
    assert.ok(merged.safety.require_human_approval_for.includes("tool.shell.exec"));
    assert.ok(merged.safety.require_human_approval_for.includes("tool.file.write"));
    assert.ok(merged.human_approval_for?.includes("tool.shell.exec"));
    assert.ok(merged.human_approval_for?.includes("tool.file.edit"));
    assert.ok(merged.safety.forbidden_capabilities.includes("credential.exfiltrate"));
    assert.equal(merged.budget?.max_tool_calls, 80);
  });

  it("applyExperienceProfileToPolicy should not lose base fields when profile omits them", () => {
    const profile = resolveExperienceProfile("fast-architecture-pass")!;
    const merged = applyExperienceProfileToPolicy(BASE_POLICY, profile);

    assert.equal(merged.max_agents, BASE_POLICY.max_agents);
    assert.equal(merged.timeout_ms, BASE_POLICY.timeout_ms);
    assert.equal(merged.retry.max_attempts, BASE_POLICY.retry.max_attempts);
    assert.equal(merged.memory.retention, "session");
  });

  it("buildCodebaseDeepReviewObjective should produce a result-first review prompt", () => {
    const objective = buildCodebaseDeepReviewObjective("auth and permissions");

    assert.match(objective, /Codebase Deep Review: auth and permissions/);
    assert.match(objective, /Careful Security Review/);
    assert.match(objective, /file:line/);
    assert.doesNotMatch(objective, /blackboard|worker lease|protocol envelope/i);
  });

  it("buildExperienceObjective should keep profile labels and requirements aligned", () => {
    const architecture = buildExperienceObjective("fast-architecture-pass", "architecture boundaries");
    const draft = buildExperienceObjective("autonomous-safe-draft");

    assert.match(architecture, /Fast Architecture Pass: architecture boundaries/);
    assert.match(architecture, /Experience: Fast Architecture Pass/);
    assert.match(architecture, /top architecture risks/);
    assert.doesNotMatch(architecture, /Careful Security Review/);
    assert.match(draft, /Safe Draft/);
    assert.match(draft, /Experience: Autonomous Safe Draft/);
    assert.match(draft, /verification gap/);
  });

  it("getExperienceStarters should expose runnable first-run commands", () => {
    const starters = getExperienceStarters();

    assert.equal(starters.length, 3);
    assert.equal(starters[0]?.id, "codebase-deep-review");
    assert.equal(starters[0]?.profileName, "careful-security-review");
    assert.match(starters[0]?.command ?? "", /^\/review /);
    assert.ok(starters.every((starter) => starter.objective.length > 20));
    for (const starter of starters) {
      const profile = resolveExperienceProfile(starter.profileName);
      assert.ok(profile);
      assert.match(starter.objective, new RegExp(`Experience: ${profile.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(starter.objective, /blackboard|worker lease|protocol envelope/i);
    }
    assert.doesNotMatch(starters.find((starter) => starter.id === "architecture-pass")?.objective ?? "", /Careful Security Review/);
  });
});
