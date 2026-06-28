import type { SwarmSettings } from "../config/settings.js";
import type { SwarmPolicy } from "../protocol/types.js";
import { riskClassForAction } from "../tools/permissions.js";
import { normalizeToolAction } from "../tools/local-tools.js";

export function createLocalPolicy(settings: SwarmSettings): SwarmPolicy {
  const mode = settings.permissions.defaultMode === "yolo"
    ? "yolo"
    : settings.permissions.defaultMode === "full-auto" || settings.permissions.defaultMode === "auto"
      ? "auto"
      : "on-request";
  return {
    max_agents: settings.runtime.maxAgents,
    max_parallel_tasks: settings.runtime.maxParallelTasks,
    max_depth: 2,
    max_concurrency: settings.runtime.maxParallelTasks,
    timeout_ms: settings.runtime.taskTimeoutMs,
    retry: { max_attempts: 1, backoff_ms: 1000 },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: mode,
    network_access: settings.tools.webSearch ? "allow" : "deny",
    allow_domains: [],
    human_approval_for: settings.permissions.ask,
    safety: {
      require_human_approval_for: settings.permissions.ask,
      forbidden_capabilities: ["credential.exfiltrate"],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    },
    budget: {
      max_tool_calls: 50,
      max_agents: settings.runtime.maxAgents
    }
  };
}

export function riskClassForActionName(action: string): "r0" | "r1" | "r2" | "r3" | "r4" {
  try {
    return riskClassForAction(normalizeToolAction({ action }));
  } catch {
    if (action.startsWith("file.write") || action.startsWith("file.edit")) return "r1";
    if (action.includes("shell") || action.includes("package") || action.includes("fetch")) return "r2";
    return "r0";
  }
}

export function mcpMaterialPolicy(kind: "resource" | "prompt", artifact: { bytes: number; lines: number }): {
  read_only: true;
  risk_class: "r0";
  cache_policy: {
    cachePolicy: "stable_summary" | "dynamic_context";
    ttlSeconds: number;
    stablePrefixEligible: boolean;
    reason: string;
  };
  context_impact: {
    segment: "stable_prefix" | "dynamic_context";
    bytes: number;
    lines: number;
    promptCacheImpact: "low" | "medium";
    recommendation: string;
  };
  activation_reason: string;
} {
  const isResource = kind === "resource";
  return {
    read_only: true,
    risk_class: "r0",
    cache_policy: {
      cachePolicy: isResource ? "stable_summary" : "dynamic_context",
      ttlSeconds: isResource ? 3600 : 0,
      stablePrefixEligible: isResource,
      reason: isResource
        ? "Read-only MCP resources can be summarized into the stable prefix until TTL expiry."
        : "MCP prompts are materialized per invocation and stay in the dynamic context segment."
    },
    context_impact: {
      segment: isResource ? "stable_prefix" : "dynamic_context",
      bytes: artifact.bytes,
      lines: artifact.lines,
      promptCacheImpact: isResource ? "low" : "medium",
      recommendation: isResource
        ? "Reuse the artifact summary instead of reinjecting the full resource on every turn."
        : "Keep prompt materialization near the turn that requested it to avoid prefix churn."
    },
    activation_reason: `MCP ${kind} materialized as a read-only r0 artifact with ${isResource ? "stable summary" : "dynamic context"} cache policy.`
  };
}
