import { strict as assert } from "node:assert";
import test from "node:test";
import { BuiltinLocalToolProvider } from "./builtin-tools.js";

test("shared fact tool capabilities keep protocol actions behind product-facing labels", () => {
  const provider = new BuiltinLocalToolProvider();
  const capabilities = provider.listCapabilities();
  const expected = [
    ["blackboard.write", "Save Shared Fact", "Save a typed shared fact for the team."],
    ["blackboard.search", "Search Shared Facts", "Search shared facts by text and filters."],
    ["blackboard.read", "Read Shared Fact", "Read a shared fact by id or key."],
    ["blackboard.list", "List Shared Facts", "List recent shared facts with optional filters."]
  ] as const;

  for (const [action, title, description] of expected) {
    const capability = capabilities.find((item) => capabilityAction(item.metadata) === action);
    assert(capability, `missing capability for ${action}`);
    assert.equal(capability.title, title);
    assert.equal(capability.description, description);
    assert.equal(capabilityAliases(capability.metadata).includes(action), true);
    assert.doesNotMatch(capability.title, /Blackboard/);
    assert.doesNotMatch(capability.description, /blackboard|runtime protocol|Swarm agents/i);
  }
});

function capabilityAction(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || !("action" in metadata)) {
    return undefined;
  }
  const action = (metadata as { action?: unknown }).action;
  return typeof action === "string" ? action : undefined;
}

function capabilityAliases(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || !("aliases" in metadata)) {
    return [];
  }
  const aliases = (metadata as { aliases?: unknown }).aliases;
  return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : [];
}
