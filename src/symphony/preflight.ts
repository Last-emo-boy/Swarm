import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { workItemToTemplateIssue } from "./kernel.js";
import { workItemKey } from "./work-item.js";
import { renderWorkflowPrompt, type WorkflowDefinition, type WorkflowRuntimeConfig } from "./workflow.js";

export type SymphonyPreflightSeverity = "error" | "warning";

export type SymphonyPreflightIssue = {
  code: string;
  severity: SymphonyPreflightSeverity;
  message: string;
  field?: string;
  work_item_key?: string;
};

export type SymphonyPreflightResult = {
  ok: boolean;
  issues: SymphonyPreflightIssue[];
};

export function runSymphonyPreflight(input: {
  runtime: SwarmRuntime;
  workflow: WorkflowDefinition;
  config: WorkflowRuntimeConfig;
  candidates: WorkItem[];
}): SymphonyPreflightResult {
  const issues: SymphonyPreflightIssue[] = [
    ...validateWorkSource(input.config),
    ...validateWorkspace(input.config),
    ...validateHooks(input.config),
    ...validateTemplates(input.workflow, input.candidates)
  ];
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues
  };
}

export function persistSymphonyPreflight(input: {
  runtime: SwarmRuntime;
  workflow: WorkflowDefinition;
  result: SymphonyPreflightResult;
}): void {
  const status = input.result.ok ? "completed" : "failed";
  input.runtime.runAttemptStore.upsert({
    session_id: "symphony.preflight",
    task_id: "symphony.preflight",
    runner_id: "symphony.scheduler",
    kind: "swarm_task",
    status,
    attempt: 0,
    title: "Symphony workflow preflight",
    terminal_reason: input.result.ok ? "Preflight passed." : input.result.issues.find((issue) => issue.severity === "error")?.message,
    workspace_path: dirname(input.workflow.path),
    error_code: input.result.ok ? undefined : "SYMPHONY_PREFLIGHT_FAILED",
    recovery_suggestion: input.result.ok ? undefined : "ask_human",
    metadata: {
      workflow_path: input.workflow.path,
      issues: input.result.issues
    }
  });
  input.runtime.auditStore.append({
    session_id: "symphony.preflight",
    task_id: "symphony.preflight",
    actor_type: "policy",
    actor_id: "symphony.preflight",
    action: "workflow.preflight",
    resource: {
      workflow_path: input.workflow.path,
      issues: input.result.issues
    },
    risk_class: "r1",
    decision: input.result.ok ? "executed" : "blocked",
    reason: input.result.ok ? "Preflight passed." : "Preflight failed."
  });
}

function validateWorkSource(config: WorkflowRuntimeConfig): SymphonyPreflightIssue[] {
  const issues: SymphonyPreflightIssue[] = [];
  if (config.work_source.kind && config.work_source.kind !== "fake" && config.work_source.kind !== "local") {
    issues.push({
      code: "UNSUPPORTED_WORK_SOURCE",
      severity: "error",
      field: "work_source.kind",
      message: `Unsupported work source kind: ${config.work_source.kind}.`
    });
  }
  if (config.work_source.active_states.length === 0) {
    issues.push({
      code: "NO_ACTIVE_STATES",
      severity: "error",
      field: "work_source.active_states",
      message: "At least one active work item state is required."
    });
  }
  return issues;
}

function validateWorkspace(config: WorkflowRuntimeConfig): SymphonyPreflightIssue[] {
  const issues: SymphonyPreflightIssue[] = [];
  if (!config.workspace.root) {
    issues.push({
      code: "WORKSPACE_ROOT_REQUIRED",
      severity: "error",
      field: "workspace.root",
      message: "workspace.root is required."
    });
    return issues;
  }
  if (!isAbsolute(config.workspace.root)) {
    issues.push({
      code: "WORKSPACE_ROOT_RELATIVE",
      severity: "warning",
      field: "workspace.root",
      message: `workspace.root is relative: ${config.workspace.root}.`
    });
  }
  if (existsSync(config.workspace.root)) {
    try {
      if (!statSync(config.workspace.root).isDirectory()) {
        issues.push({
          code: "WORKSPACE_ROOT_NOT_DIRECTORY",
          severity: "error",
          field: "workspace.root",
          message: `workspace.root exists but is not a directory: ${config.workspace.root}.`
        });
      }
    } catch (error) {
      issues.push({
        code: "WORKSPACE_ROOT_STAT_FAILED",
        severity: "error",
        field: "workspace.root",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return issues;
}

function validateHooks(config: WorkflowRuntimeConfig): SymphonyPreflightIssue[] {
  const issues: SymphonyPreflightIssue[] = [];
  if (config.hooks.timeout_ms <= 0) {
    issues.push({
      code: "HOOK_TIMEOUT_INVALID",
      severity: "error",
      field: "hooks.timeout_ms",
      message: "hooks.timeout_ms must be positive."
    });
  }
  for (const name of ["after_create", "before_run", "after_run", "before_remove"] as const) {
    const script = config.hooks[name];
    if (script && !isHookTrustConfigured()) {
      issues.push({
        code: "HOOKS_REQUIRE_TRUST",
        severity: "warning",
        field: `hooks.${name}`,
        message: `hooks.${name} is configured but hook execution is not trusted; set SWARM_SYMPHONY_TRUST_HOOKS=1 or SWARM_TRUSTED_WORKSPACE_ROOT.`
      });
    }
  }
  return issues;
}

function validateTemplates(workflow: WorkflowDefinition, candidates: WorkItem[]): SymphonyPreflightIssue[] {
  const issues: SymphonyPreflightIssue[] = [];
  for (const item of candidates) {
    try {
      renderWorkflowPrompt({
        workflow,
        issue: workItemToTemplateIssue(item),
        attempt: null
      });
    } catch (error) {
      issues.push({
        code: "TEMPLATE_RENDER_FAILED",
        severity: "error",
        work_item_key: workItemKey(item),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return issues;
}

function isHookTrustConfigured(): boolean {
  return process.env.SWARM_SYMPHONY_TRUST_HOOKS === "1" ||
    process.env.SWARM_SYMPHONY_TRUST_HOOKS === "true" ||
    Boolean(process.env.SWARM_TRUSTED_WORKSPACE_ROOT);
}
