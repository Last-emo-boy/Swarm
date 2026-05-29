import { strict as assert } from "node:assert";
import test from "node:test";
import type { OpenAIProvider } from "../providers/openai-provider.js";
import {
  applyStructuredRoutingPolicy,
  fastRouteExecution,
  routeExecution
} from "./execution-router.js";

test("routeExecution honors forced modes without provider calls", async () => {
  const provider = providerStub([]);
  const route = await routeExecution("answer directly", provider, { mode: "chat" });

  assert.deepEqual(route, {
    mode: "chat",
    reason: "forced:chat",
    confidence: 1
  });
  assert.equal(provider.calls.length, 0);
});

test("fastRouteExecution keeps simple questions in chat and workspace work in coding_loop", () => {
  assert.deepEqual(fastRouteExecution("What is a task graph?"), {
    mode: "chat",
    confidence: 0.92,
    reason: "fast_route: simple question without required workspace access.",
    requires_workspace: false,
    expected_side_effects: "none",
    needs_parallelism: false,
    risk: "low",
    fallback_mode: "chat"
  });

  const mutation = fastRouteExecution("Fix the failing tests in this repo");
  assert.equal(mutation?.mode, "coding_loop");
  assert.equal(mutation?.requires_workspace, true);
  assert.equal(mutation?.expected_side_effects, "run_commands");
  assert.equal(mutation?.fallback_mode, "coding_loop");

  const swarm = fastRouteExecution("Use multiple agents to review this repository architecture");
  assert.equal(swarm?.mode, "full_swarm");
  assert.equal(swarm?.needs_parallelism, true);
  assert.equal(swarm?.requires_workspace, true);
  assert.equal(swarm?.expected_side_effects, "read_workspace");
});

test("applyStructuredRoutingPolicy downgrades unsafe chat and mutating full_swarm decisions", () => {
  const unsafeChat = applyStructuredRoutingPolicy({
    mode: "chat",
    confidence: 0.93,
    reason: "Need to inspect files",
    requires_workspace: true,
    expected_side_effects: "read_workspace",
    needs_parallelism: false,
    fallback_mode: "chat"
  });
  assert.equal(unsafeChat.mode, "coding_loop");
  assert.equal(unsafeChat.confidence, 0.75);
  assert.equal(unsafeChat.fallback_mode, "coding_loop");
  assert.match(unsafeChat.reason, /selected chat/);

  const mutatingSwarm = applyStructuredRoutingPolicy({
    mode: "full_swarm",
    confidence: 0.96,
    reason: "Use a team to edit files",
    requires_workspace: true,
    expected_side_effects: "modify_workspace",
    needs_parallelism: true,
    parallelism_reason: "Multiple files",
    swarm_value: "Independent roles",
    fallback_mode: "coding_loop"
  });
  assert.equal(mutatingSwarm.mode, "coding_loop");
  assert.equal(mutatingSwarm.confidence, 0.8);
  assert.match(mutatingSwarm.reason, /modify the workspace/);

  const readOnlySwarm = applyStructuredRoutingPolicy({
    mode: "full_swarm",
    confidence: 0.9,
    reason: "Broad audit",
    requires_workspace: true,
    expected_side_effects: "read_workspace",
    needs_parallelism: true,
    fallback_mode: "coding_loop"
  });
  assert.equal(readOnlySwarm.mode, "full_swarm");
});

test("routeExecution parses provider JSON, repairs invalid JSON, and falls back conservatively on provider failure", async () => {
  const validProvider = providerStub([
    JSON.stringify({
      mode: "chat",
      confidence: 0.88,
      reason: "Conceptual discussion",
      requires_workspace: false,
      expected_side_effects: "none",
      needs_parallelism: false,
      risk: "low",
      fallback_mode: "chat"
    })
  ]);
  const valid = await routeExecution("Discuss agent orchestration tradeoffs", validProvider);
  assert.equal(valid.mode, "chat");
  assert.equal(valid.confidence, 0.88);
  assert.equal(validProvider.calls.length, 1);
  assert.equal(validProvider.calls[0].usage?.purpose, "execution_router");

  const repairProvider = providerStub([
    "not json",
    JSON.stringify({
      mode: "full_swarm",
      confidence: 0.91,
      reason: "Parallel read-only review",
      requires_workspace: true,
      expected_side_effects: "read_workspace",
      needs_parallelism: true,
      parallelism_reason: "Independent reviewers",
      swarm_value: "Map-reduce review",
      risk: "low",
      fallback_mode: "coding_loop"
    })
  ]);
  const repaired = await routeExecution("Review several independent design documents", repairProvider);
  assert.equal(repaired.mode, "full_swarm");
  assert.equal(repairProvider.calls.length, 2);
  assert.equal(repairProvider.calls[1].usage?.purpose, "execution_router_repair");

  const failingProvider = providerStub([new Error("provider offline")]);
  const fallback = await routeExecution("Ambiguous work", failingProvider);
  assert.equal(fallback.mode, "coding_loop");
  assert.equal(fallback.confidence, 0);
  assert.equal(fallback.requires_workspace, true);
  assert.equal(fallback.expected_side_effects, "unknown");
  assert.match(fallback.reason, /conservative local coding loop fallback/);
});

function providerStub(outputs: Array<string | Error>): OpenAIProvider & {
  calls: Array<{
    usage?: { purpose?: string };
  }>;
} {
  const calls: Array<{ usage?: { purpose?: string } }> = [];
  return {
    workerModel: "test-model",
    calls,
    async generateText(input: { usage?: { purpose?: string } }) {
      calls.push({ usage: input.usage });
      const output = outputs.shift();
      if (output instanceof Error) {
        throw output;
      }
      if (output === undefined) {
        throw new Error("No stubbed output.");
      }
      return output;
    }
  } as OpenAIProvider & { calls: typeof calls };
}
