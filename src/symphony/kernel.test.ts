import { strict as assert } from "node:assert";
import test from "node:test";
import { createSymphonyPolicy, createSymphonyPolicyForExperienceProfile } from "./kernel.js";

test("createSymphonyPolicyForExperienceProfile applies named profile without changing default policy", () => {
  const base = createSymphonyPolicy(4, 10_000);
  const careful = createSymphonyPolicyForExperienceProfile(4, 10_000, "careful-security-review");

  assert.equal(base.safety.sandbox_required, false);
  assert.equal(careful.safety.sandbox_required, true);
  assert.equal(careful.consensus, "reviewer_approval");
  assert.equal(careful.budget?.max_agents, 4);
  assert.equal(careful.budget?.max_tool_calls, 80);
  assert.ok(careful.human_approval_for?.includes("tool.shell.exec"));
  assert.ok(careful.human_approval_for?.includes("tool.file.write"));
});
