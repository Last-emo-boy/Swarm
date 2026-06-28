import type { RunOptions } from "./execution-router.js";
import type { RunAttemptStatus } from "../protocol/types.js";
import type { AgentInvocationMode } from "./agent-specs.js";
import type { ExecutionResult } from "./orchestrator.js";
import type { ToolResult } from "../tools/types.js";

export function hasRunToolPolicy(options: RunOptions): boolean {
  return Boolean(options.allowedTools?.length || options.disallowedTools?.length);
}

export function hasRunWorkspaceReadPolicy(options: RunOptions): boolean {
  return Boolean(options.additionalReadDirectories?.length);
}

export function hasRunPromptCustomization(options: RunOptions): boolean {
  return Boolean(options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined);
}

export function hasRunSkillActivation(options: RunOptions): boolean {
  return Boolean(options.skills?.length);
}

export function hasRunSandboxPolicy(options: RunOptions): boolean {
  return options.sandboxMode === "read-only";
}

export function normalizeAttemptStatus(status: "started" | "completed" | "failed"): RunAttemptStatus {
  return status === "started" ? "started" : status === "failed" ? "failed" : "completed";
}

export function isAgentInvocationMode(value: string): value is AgentInvocationMode {
  return value === "call_subagent" || value === "handoff" || value === "parallel";
}

export function slashCommandRunMode(args: Record<string, unknown>): RunOptions["mode"] {
  const value = args.mode ?? args.runMode ?? args.run_mode;
  return value === "chat" || value === "coding_loop" || value === "full_swarm" || value === "auto" ? value : "auto";
}

export function slashCommandSandboxMode(args: Record<string, unknown>): RunOptions["sandboxMode"] {
  const value = args.sandboxMode ?? args.sandbox_mode ?? args.sandbox;
  return value === "read-only" || value === "workspace-write" ? value : undefined;
}

export function positiveRunIntegerArg(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function toolStatusFromExecutionStatus(status: ExecutionResult["status"]): ToolResult["status"] {
  if (status === "failed") {
    return "failed";
  }
  if (status === "stopped") {
    return "partial";
  }
  return "success";
}

export function governanceAuditDecision(status: "requested" | "granted" | "denied" | "evidence"): "requested" | "approved" | "denied" | "executed" {
  if (status === "granted") {
    return "approved";
  }
  if (status === "evidence") {
    return "executed";
  }
  return status;
}
