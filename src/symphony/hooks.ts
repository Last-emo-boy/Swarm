import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BlackboardEntry, RunAttempt, SwarmSession, WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { workItemKey } from "./work-item.js";
import type { WorkflowRuntimeConfig } from "./workflow.js";

export type SymphonyHookName = "after_create" | "before_run" | "after_run" | "before_remove";

export type SymphonyHookDecision = "allow" | "block" | "pass";

export type SymphonyHookResult = {
  hook: SymphonyHookName;
  status: "skipped" | "completed" | "failed" | "timeout";
  decision: SymphonyHookDecision;
  reason?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number | null;
  duration_ms: number;
  attempt?: RunAttempt;
  blackboard_entry?: BlackboardEntry;
};

export type SymphonyHookContext = {
  runtime: SwarmRuntime;
  session: SwarmSession;
  work_item: WorkItem;
  workspace_path: string;
  workspace_created_now?: boolean;
  config: WorkflowRuntimeConfig;
  result?: {
    status: "completed" | "failed" | "skipped" | "cancelled";
    error?: string;
    summary?: string;
  };
};

export async function runSymphonyHook(
  hook: SymphonyHookName,
  context: SymphonyHookContext
): Promise<SymphonyHookResult> {
  const script = context.config.hooks[hook];
  const start = Date.now();
  if (!script) {
    return { hook, status: "skipped", decision: "pass", duration_ms: 0 };
  }
  if (!isHookExecutionTrusted(context.workspace_path)) {
    return recordHookResult(context, {
      hook,
      status: "failed",
      decision: "block",
      reason: "Hook execution is disabled. Set SWARM_SYMPHONY_TRUST_HOOKS=1 to trust this workspace for Symphony hooks.",
      duration_ms: Date.now() - start
    });
  }
  if (!hookExecutionApproved(hook, context)) {
    return recordHookResult(context, {
      hook,
      status: "failed",
      decision: "block",
      reason: "Hook execution approval is required. Set SWARM_SYMPHONY_APPROVE_HOOKS=1 after reviewing WORKFLOW.md hooks.",
      duration_ms: Date.now() - start
    });
  }

  context.runtime.events.emitEvent({
    type: "log",
    level: "info",
    message: `Symphony hook ${hook} started for ${context.session.session_id}.`
  });
  const result = await executeHookScript({
    script,
    cwd: context.workspace_path,
    timeoutMs: context.config.hooks.timeout_ms,
    input: createHookInput(hook, context)
  });
  return recordHookResult(context, {
    hook,
    status: result.timed_out ? "timeout" : result.exit_code === 0 ? "completed" : "failed",
    decision: hookDecision(result),
    reason: hookReason(result),
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    exit_code: result.exit_code,
    duration_ms: Date.now() - start
  });
}

function hookExecutionApproved(hook: SymphonyHookName, context: SymphonyHookContext): boolean {
  const approved = process.env.SWARM_SYMPHONY_APPROVE_HOOKS === "1" || process.env.SWARM_SYMPHONY_APPROVE_HOOKS === "true";
  const request = createHookApprovalRequest(hook, context);
  context.runtime.events.emitEvent({ type: "approval", request, status: "pending" });
  context.runtime.auditStore.append({
    session_id: context.session.session_id,
    task_id: `symphony.hook.${hook}`,
    actor_type: "policy",
    actor_id: "symphony.hook",
    action: `hook.${hook}.approval`,
    resource: {
      hook,
      workspace_path: context.workspace_path,
      script: context.config.hooks[hook],
      approved_by_env: approved
    },
    risk_class: "r3",
    decision: approved ? "approved" : "blocked",
    reason: approved
      ? "SWARM_SYMPHONY_APPROVE_HOOKS is set."
      : "Hook execution requires explicit approval even after workspace trust is enabled."
  });
  context.runtime.events.emitEvent({ type: "approval", request, status: approved ? "approved" : "denied" });
  return approved;
}

function createHookApprovalRequest(hook: SymphonyHookName, context: SymphonyHookContext): ToolApprovalRequest {
  return {
    id: `approval_${randomUUID()}`,
    session_id: context.session.session_id,
    task_id: `symphony.hook.${hook}`,
    action: `symphony.hook.${hook}`,
    summary: `Run Symphony hook: ${hook}`,
    detail: [
      `Hook: ${hook}`,
      `Workspace: ${context.workspace_path}`,
      `Work item: ${context.work_item.human_id ?? context.work_item.source_id ?? context.work_item.title}`,
      "",
      context.config.hooks[hook] ?? ""
    ].join("\n"),
    risk: "shell",
    risk_class: "r3",
    target: context.workspace_path,
    why_now: `Symphony lifecycle hook ${hook} is configured in WORKFLOW.md.`,
    predicted_impact: "Runs repository-configured shell code in the Symphony workspace.",
    rollback_plan: "No automatic rollback is guaranteed; inspect hook output, audit logs, and workspace changes."
  };
}

export function isFatalHookResult(hook: SymphonyHookName, result: SymphonyHookResult): boolean {
  if (result.status === "skipped" || result.decision === "pass" || result.decision === "allow") {
    return false;
  }
  return hook === "after_create" || hook === "before_run";
}

function recordHookResult(
  context: SymphonyHookContext,
  result: Omit<SymphonyHookResult, "attempt" | "blackboard_entry">
): SymphonyHookResult {
  const attempt = context.runtime.runAttemptStore.upsert({
    session_id: context.session.session_id,
    task_id: `symphony.hook.${result.hook}`,
    runner_id: "symphony.hook",
    kind: "swarm_task",
    status: result.status === "completed" || result.status === "skipped"
      ? "completed"
      : result.status === "timeout"
        ? "failed"
        : "failed",
    attempt: 0,
    title: `Symphony hook ${result.hook}`,
    terminal_reason: result.reason,
    workspace_path: context.workspace_path,
    error_code: result.status === "timeout"
      ? "HOOK_TIMEOUT"
      : result.decision === "block" || result.status === "failed"
        ? "HOOK_FAILED"
        : undefined,
    recovery_suggestion: result.decision === "block" || result.status === "failed" || result.status === "timeout"
      ? "ask_human"
      : undefined,
    metadata: {
      hook: result.hook,
      decision: result.decision,
      status: result.status,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      work_item_key: workItemKey(context.work_item)
    }
  });
  const entry = context.runtime.blackboardStore.write({
    swarm_id: context.session.swarm_id,
    session_id: context.session.session_id,
    task_id: `symphony.hook.${result.hook}`,
    key: `symphony.hook.${result.hook}.${result.status}`,
    type: result.decision === "block" ? "decision" : "evidence",
    value: {
      hook: result.hook,
      status: result.status,
      decision: result.decision,
      reason: result.reason,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      work_item: context.work_item
    },
    created_by: { agent_id: "symphony", role: "hook" },
    tags: ["symphony", "hook", result.hook, result.status, "work-kernel"]
  });
  context.runtime.events.emitEvent({ type: "blackboard", entry });
  context.runtime.auditStore.append({
    session_id: context.session.session_id,
    task_id: `symphony.hook.${result.hook}`,
    actor_type: "runtime",
    actor_id: "symphony.hook",
    action: `hook.${result.hook}`,
    resource: {
      status: result.status,
      decision: result.decision,
      reason: result.reason,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms
    },
    risk_class: "r2",
    decision: result.decision === "block" || result.status === "failed" || result.status === "timeout" ? "blocked" : "executed",
    reason: result.reason
  });
  context.runtime.usageStore.append({
    session_id: context.session.session_id,
    task_id: `symphony.hook.${result.hook}`,
    kind: "wall_time",
    amount: result.duration_ms,
    unit: "ms",
    metadata: {
      hook: result.hook,
      status: result.status,
      decision: result.decision
    }
  });
  context.runtime.events.emitEvent({
    type: "log",
    level: result.status === "completed" || result.status === "skipped" ? "info" : "warn",
    message: `Symphony hook ${result.hook} ${result.status}: ${result.reason ?? result.decision}`
  });
  return { ...result, attempt, blackboard_entry: entry };
}

function isHookExecutionTrusted(workspacePath: string): boolean {
  if (process.env.SWARM_SYMPHONY_TRUST_HOOKS === "1" || process.env.SWARM_SYMPHONY_TRUST_HOOKS === "true") {
    return true;
  }
  const trustedRoot = process.env.SWARM_TRUSTED_WORKSPACE_ROOT;
  if (!trustedRoot) {
    return false;
  }
  const normalizedRoot = trustedRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/");
  return normalizedWorkspace === normalizedRoot || normalizedWorkspace.startsWith(`${normalizedRoot}/`);
}

async function executeHookScript(input: {
  script: string;
  cwd: string;
  timeoutMs: number;
  input: Record<string, unknown>;
}): Promise<{ stdout: string; stderr: string; exit_code: number | null; timed_out: boolean }> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "powershell.exe" : "sh";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", input.script]
      : ["-lc", input.script];
    const child = spawn(shell, args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        SWARM_SYMPHONY_HOOK_INPUT: JSON.stringify(input.input)
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({ stdout, stderr, exit_code: null, timed_out: true });
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || error.message, exit_code: null, timed_out: false });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code, timed_out: false });
    });
    child.stdin.end(`${JSON.stringify(input.input)}\n`);
  });
}

function createHookInput(hook: SymphonyHookName, context: SymphonyHookContext): Record<string, unknown> {
  return {
    hook,
    session_id: context.session.session_id,
    swarm_id: context.session.swarm_id,
    cwd: context.workspace_path,
    workspace_path: context.workspace_path,
    workspace_created_now: context.workspace_created_now ?? false,
    work_item: context.work_item,
    result: context.result
  };
}

function hookDecision(result: { timed_out: boolean; exit_code: number | null; stdout: string; stderr: string }): SymphonyHookDecision {
  if (result.timed_out || result.exit_code !== 0) {
    return "block";
  }
  const parsed = parseStructuredHookOutput(result.stdout);
  if (parsed?.decision === "block") {
    return "block";
  }
  if (parsed?.decision === "allow") {
    return "allow";
  }
  return "pass";
}

function hookReason(result: { timed_out: boolean; exit_code: number | null; stdout: string; stderr: string }): string | undefined {
  if (result.timed_out) {
    return "Hook timed out.";
  }
  const parsed = parseStructuredHookOutput(result.stdout);
  if (parsed?.reason) {
    return parsed.reason;
  }
  if (result.exit_code !== 0) {
    return firstLine(result.stderr || result.stdout) || `Hook exited with code ${result.exit_code}.`;
  }
  return firstLine(result.stdout);
}

function parseStructuredHookOutput(stdout: string): { decision?: "allow" | "block"; reason?: string } | undefined {
  const candidate = extractJsonObject(stdout);
  if (!candidate) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const decision = parsed.decision === "allow" || parsed.decision === "block" ? parsed.decision : undefined;
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined;
    return { decision, reason };
  } catch {
    return undefined;
  }
}

function extractJsonObject(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function truncate(value: string | undefined, max = 8_000): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > max ? `${value.slice(0, max)}\n[truncated ${value.length - max} chars]` : value;
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 240);
}
