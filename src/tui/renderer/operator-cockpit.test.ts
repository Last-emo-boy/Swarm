import { strict as assert } from "node:assert";
import test from "node:test";
import { buildRendererOperatorCockpit } from "./operator-cockpit.js";

test("operator cockpit keeps cache and LSP visible while surfacing recovery actions", () => {
  const rows = buildRendererOperatorCockpit({
    cache: {
      status: "cache_miss",
      hitRate: 0,
      cacheMode: "prefix-structured",
      missReason: "changed_tools"
    },
    gateway: "failed",
    symphony: "degraded",
    swarm: "ready",
    lsp: {
      health: "fallback",
      providers: 2,
      readyProviders: 1,
      fallbackProviders: 1,
      partialProviders: 0,
      unavailableProviders: 0,
      failedProviders: 0,
      semanticGraphHealth: "fallback",
      semanticEvidenceSources: ["typescript_semantic_fallback"],
      staleReasons: [],
      fallbackReasons: ["provider_unavailable"],
      nextActions: ["fall back to file.read"],
      semanticPlanningState: "degraded",
      semanticPlanningEvidenceSources: ["lsp.workspace_symbols"],
      semanticPlanningDegradedReason: "References are unavailable.",
      semanticPlanningNextAction: "fall back to file.read"
    },
    route: "coding_loop",
    activeWorkItem: "TASK-005",
    recoveryAction: "/debug latest"
  });

  assert.equal(rows.find((row) => row.id === "cache")?.visible, true);
  assert.equal(rows.find((row) => row.id === "lsp")?.visible, true);
  assert.equal(rows.find((row) => row.id === "gateway")?.severity, "error");
  assert.match(rows.find((row) => row.id === "gateway")?.summary ?? "", /recovery=\/debug latest/);
  assert.match(rows.find((row) => row.id === "swarm")?.summary ?? "", /route=coding_loop/);
});
