import type { RunAttempt, WorkContractHandoff, WorkContractSnapshot, WorkContractWorker, WorkSnapshot } from "../protocol/types.js";
import type { RunSandboxMode } from "./execution-router.js";

export type ResumeHealth = {
  openAttempts: RunAttempt[];
  unresolvedFailures: RunAttempt[];
};

export type ResumePromptInput = {
  sessionId: string;
  snapshot: WorkSnapshot;
  instruction?: string;
  freshness: string;
  liveControlDirectives: string[];
  memory: string;
  replay: string;
};

export type ResumePreflightInput = {
  sessionId: string;
  snapshot: WorkSnapshot;
  instruction?: string;
  sandboxMode?: RunSandboxMode;
  command?: "resume" | "continue";
  route?: "stored_plan" | "coding_loop";
  hasStoredPlan: boolean;
  finalOutput?: string;
  freshness: string;
  liveControlDirectives: string[];
};

export function buildResumePrompt(input: ResumePromptInput): string {
  const instruction = input.instruction?.trim();
  return [
    `Continue the previous local Swarm WorkSession ${input.sessionId}.`,
    "",
    `Original objective: ${input.snapshot.session.objective}`,
    instruction ? `Newest user instruction: ${instruction}` : "Newest user instruction: continue from the previous session state.",
    "",
    input.freshness,
    "",
    "Live Control Directives",
    ...input.liveControlDirectives,
    "",
    "Use this Work Kernel snapshot and compacted session memory as context. Do not repeat completed work unless needed.",
    input.memory ? ["", "Compacted session memory", input.memory].join("\n") : undefined,
    "",
    input.replay.slice(0, 12_000)
  ].filter(Boolean).join("\n");
}

export function renderResumePreflight(input: ResumePreflightInput): string {
  const instruction = input.instruction?.trim();
  const route = input.route ?? (input.hasStoredPlan ? "stored_plan" : "coding_loop");
  const sandboxMode = input.sandboxMode ?? "workspace-write";
  const resumeHealth = buildResumeHealth(input.snapshot.attempts);
  const finalSummaryCandidate = input.snapshot.final_outcome?.final_summary ?? firstLine(input.finalOutput ?? "");
  const finalSummary = finalSummaryCandidate || "(none)";
  const memorySummary = input.snapshot.context_summary
    ? `entries=${input.snapshot.context_summary.entries} compactions=${input.snapshot.context_summary.compactions}${input.snapshot.context_summary.latest_compaction ? ` latest=${input.snapshot.context_summary.latest_compaction.compaction_id}` : ""}`
    : "(none)";
  return [
    "Resume Preflight",
    `${input.sessionId} [${input.snapshot.session.status}] command=${input.command ?? "resume"} route=${route} sandbox=${sandboxMode}`,
    `Objective: ${input.snapshot.session.objective}`,
    `Instruction: ${instruction || "continue from the previous session state."}`,
    `Stored plan: ${input.hasStoredPlan ? "yes" : "no"}`,
    `Last final summary: ${finalSummary}`,
    `Changed files: ${input.snapshot.changed_files.length}`,
    "",
    "Live Control Directives",
    ...input.liveControlDirectives,
    "",
    "Freshness",
    input.freshness,
    "",
    "Resume Health",
    ...formatResumeHealth(resumeHealth),
    "",
    "Resume Work Contracts",
    ...formatResumeWorkContracts(input.snapshot.work_contracts),
    "",
    "Context Memory",
    memorySummary
  ].join("\n");
}

export function buildResumeHealth(attempts: RunAttempt[]): ResumeHealth {
  const latestByTask = new Map<string, RunAttempt>();
  for (const attempt of attempts) {
    const key = attempt.task_id ?? attempt.runner_id ?? attempt.attempt_id;
    const current = latestByTask.get(key);
    if (!current || current.last_event_at <= attempt.last_event_at) {
      latestByTask.set(key, attempt);
    }
  }
  return {
    openAttempts: attempts.filter((attempt) => !isTerminalRunAttemptStatus(attempt.status)),
    unresolvedFailures: [...latestByTask.values()].filter((attempt) => attempt.status === "failed")
  };
}

export function formatResumeHealth(input: ResumeHealth): string[] {
  const lines: string[] = [];
  if (input.openAttempts.length === 0 && input.unresolvedFailures.length === 0) {
    return ["No open attempts or unresolved failed tool calls recorded."];
  }
  if (input.openAttempts.length > 0) {
    lines.push(`Open attempts: ${input.openAttempts.length}`);
    lines.push(...input.openAttempts.slice(0, 8).map((attempt) => `  ${attempt.task_id ?? attempt.runner_id ?? attempt.attempt_id} [${attempt.kind}/${attempt.status}] ${attempt.title ?? ""}`.trimEnd()));
  } else {
    lines.push("Open attempts: 0");
  }
  if (input.unresolvedFailures.length > 0) {
    lines.push(`Unresolved failures: ${input.unresolvedFailures.length}`);
    lines.push(...input.unresolvedFailures.slice(0, 8).map((attempt) => [
      `  ${attempt.task_id ?? attempt.runner_id ?? attempt.attempt_id} [${attempt.kind}/${attempt.status}]`,
      attempt.error_code ? ` error=${attempt.error_code}` : "",
      attempt.terminal_reason ? ` - ${attempt.terminal_reason}` : "",
      attempt.recovery_suggestion ? ` Recovery: ${attempt.recovery_suggestion}` : ""
    ].join("")));
    lines.push("Resume instruction: inspect unresolved failures before repeating work; prefer a narrow retry or continue from the last successful state.");
  } else {
    lines.push("Unresolved failures: 0");
  }
  return lines;
}

export function formatResumeWorkContracts(contracts: WorkContractSnapshot): string[] {
  const lines: string[] = [];
  if (
    contracts.active_workers.length === 0
    && contracts.resumable_workers.length === 0
    && contracts.active_handoffs.length === 0
  ) {
    return ["No active or resumable worker/handoff contracts recorded."];
  }
  lines.push(`Active workers: ${contracts.summary.active_workers} (running ${contracts.summary.running_workers}, pending ${contracts.summary.pending_workers})`);
  lines.push(...contracts.active_workers.slice(0, 6).map(formatResumeWorkerContract));
  lines.push(`Resumable workers: ${contracts.summary.resumable_workers}`);
  lines.push(...contracts.resumable_workers.slice(0, 6).map(formatResumeWorkerContract));
  lines.push(`Active handoffs: ${contracts.summary.active_handoffs}`);
  lines.push(...contracts.active_handoffs.slice(0, 6).map(formatResumeHandoffContract));
  return lines;
}

export function formatResumeWorkerContract(worker: WorkContractWorker): string {
  const agent = worker.agent_spec_id
    ? `${worker.agent_spec_id}${worker.invocation_mode ? `/${worker.invocation_mode}` : ""}`
    : worker.capability;
  return [
    `  ${worker.worker_id} [${worker.status}]`,
    agent,
    worker.write_policy ? `policy=${worker.write_policy}` : undefined,
    worker.file_scope.length ? `scope=${truncateResumeScope(worker.file_scope)}` : undefined,
    worker.handoff_id ? `handoff=${worker.handoff_id}` : undefined
  ].filter(Boolean).join(" ");
}

export function formatResumeHandoffContract(handoff: WorkContractHandoff): string {
  return [
    `  ${handoff.handoff_id} [${handoff.status}]`,
    `-> ${handoff.target_agent_spec_id}`,
    `worker=${handoff.worker_id}`,
    `policy=${handoff.write_policy}`,
    handoff.file_scope.length ? `scope=${truncateResumeScope(handoff.file_scope)}` : undefined
  ].filter(Boolean).join(" ");
}

function truncateResumeScope(paths: string[], limit = 3): string {
  if (paths.length <= limit) {
    return paths.join(",");
  }
  return `${paths.slice(0, limit).join(",")} +${paths.length - limit} more`;
}

function isTerminalRunAttemptStatus(status: RunAttempt["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "stopped";
}

function firstLine(value: string | undefined): string {
  return value?.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "";
}
