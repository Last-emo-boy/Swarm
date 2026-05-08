import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentResultPayload, BlackboardEntry, GeneratedPlan, ReviewResult, SwarmError, SwarmPolicy, SwarmSession, SwarmTask } from "../protocol/types.js";
import { createEnvelope, nowIso } from "../protocol/envelope.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SessionStore } from "../storage/session-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { loadSwarmSettings, type SwarmSettings } from "../config/settings.js";
import { RuntimeEvents } from "./events.js";
import type { SessionOutcome } from "./events.js";
import { EnvelopeRouter } from "./router.js";
import { PlanGenerator } from "./plan-generator.js";
import { normalizeToolAction } from "../tools/local-tools.js";
import { createToolApprovalRequest, toolRequiresApproval } from "../tools/permissions.js";
import type { ToolAction, ToolApprovalRequest } from "../tools/types.js";
import { TaskScheduler } from "./scheduler.js";

export type PlannedSession = {
  session: SwarmSession;
  plan: GeneratedPlan;
};

export type ExecutionResult = {
  session_id: string;
  content: string;
  artifact_path?: string;
  outcome?: SessionOutcome;
  status?: "completed" | "failed" | "stopped";
};

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export class Orchestrator {
  constructor(
    private readonly router: EnvelopeRouter,
    private readonly sessions: SessionStore,
    private readonly blackboard: BlackboardStore,
    private readonly artifacts: ArtifactStore,
    private readonly taskStates: TaskStateStore,
    private readonly planGenerator: PlanGenerator,
    private readonly events: RuntimeEvents,
    private readonly settings: SwarmSettings,
    private readonly workspace: string,
    private readonly approvalHandler?: ToolApprovalHandler
  ) {}

  private taskTotal = 0;
  private taskCompleted = 0;
  private taskAttempts = new Map<string, number>();

  async createPlan(objective: string): Promise<PlannedSession> {
    const session = createSession(objective, this.settings);
    this.sessions.create(session);
    this.router.receive(createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      from: { agent_id: "gateway", role: "gateway" },
      to: { agent_id: "orchestrator", role: "coordinator" },
      type: "swarm.init",
      intent: "swarm.init",
      payload: { objective, policy: session.policy }
    }));
    this.sessions.setStatus(session.session_id, "planning");
    this.events.emitEvent({ type: "log", level: "info", message: `Planning session ${session.session_id}` });

    const normalizedPlan = await this.planGenerator.generate(objective);
    this.sessions.setPlan(session.session_id, normalizedPlan);
    const entry = this.blackboard.write({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      key: "swarm.plan",
      type: "plan",
      value: normalizedPlan,
      created_by: { agent_id: "orchestrator", role: "coordinator" },
      tags: ["plan"]
    });
    this.events.emitEvent({ type: "blackboard", entry });
    this.events.emitEvent({ type: "plan", session_id: session.session_id, plan: normalizedPlan });

    return { session, plan: normalizedPlan };
  }

  recordLiveMessage(
    session: SwarmSession,
    input: {
      message_id: string;
      content: string;
      decision?: {
        action: string;
        reason: string;
        instruction: string;
      };
    }
  ): void {
    const entry = this.blackboard.write({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      key: `user.live_message.${input.message_id}`,
      type: "decision",
      value: {
        content: input.content,
        decision: input.decision,
        created_at: nowIso()
      },
      created_by: { agent_id: "user", role: "user" },
      tags: ["user", "live-message"]
    });
    this.events.emitEvent({ type: "blackboard", entry });
  }

  async execute(planned: PlannedSession): Promise<ExecutionResult> {
    const { session, plan } = planned;
    this.taskTotal = plan.tasks.length;
    this.taskCompleted = 0;
    this.taskAttempts.clear();
    try {
      this.sessions.setStatus(session.session_id, "running");
      this.events.emitEvent({ type: "log", level: "info", message: `Executing ${plan.tasks.length} swarm tasks` });

      const completed = new Set(
        this.taskStates.list(session.session_id)
          .filter((state) => state.status === "completed")
          .map((state) => state.task_id)
      );
      this.taskCompleted = completed.size;
      if (this.taskCompleted > 0) {
        this.events.emitEvent({ type: "progress", completed: this.taskCompleted, total: this.taskTotal });
      }
      const pending = new Map(plan.tasks.filter((task) => !completed.has(task.task_id)).map((task) => [task.task_id, task]));
      const scheduler = new TaskScheduler(session.policy.max_parallel_tasks);

      while (pending.size > 0) {
        const ready = scheduler.selectReadyTasks(pending, completed);

        if (ready.length === 0) {
          throw new Error(`Task dependency deadlock: ${[...pending.keys()].join(", ")}`);
        }

        await Promise.all(
          ready.map(async (task) => {
            await this.runTask(session, task);
            completed.add(task.task_id);
            pending.delete(task.task_id);
          })
        );
      }

      this.sessions.setStatus(session.session_id, "reviewing");
      const reviewResult = this.applyReviewGuards(await this.review(session), plan, session);

      if (reviewResult.verdict === "reject") {
        this.events.emitEvent({ type: "log", level: "warn", message: `Review rejected with score ${reviewResult.score}. Re-running tasks with new agents.` });
        const issueTasks = resolveIssueTaskIds(reviewResult, plan);
        this.taskTotal += issueTasks.size || plan.tasks.length;
        for (const task of plan.tasks) {
          if (issueTasks.size === 0 || issueTasks.has(task.task_id)) {
            completed.delete(task.task_id);
            pending.set(task.task_id, task);
          }
        }
        while (pending.size > 0) {
          const ready = scheduler.selectReadyTasks(pending, completed);
          if (ready.length === 0) break;
          await Promise.all(
            ready.map(async (task) => {
              await this.runTask(session, task);
              completed.add(task.task_id);
              pending.delete(task.task_id);
            })
          );
        }
        const secondReview = this.applyReviewGuards(await this.review(session), plan, session);
        if (secondReview.verdict !== "approve") {
          throw new Error(`Review rejected twice. Final verdict: ${secondReview.summary}`);
        }
      } else if (reviewResult.verdict === "needs_revision") {
        this.events.emitEvent({ type: "log", level: "info", message: `Review requested revisions. Feeding back to agents.` });
        const issueTasks = resolveIssueTaskIds(reviewResult, plan);
        this.taskTotal += issueTasks.size || plan.tasks.length;
        for (const task of plan.tasks) {
          if (issueTasks.size === 0 || issueTasks.has(task.task_id)) {
            const revisionNote = (reviewResult.issues ?? [])
              .filter((i) => i.task_id === task.task_id || i.message === task.title || issueTasks.size === 0)
              .map((i) => i.suggested_fix ?? i.message)
              .join("; ");
            if (revisionNote) {
              task.inputs = { ...task.inputs, revision_feedback: revisionNote };
            }
            completed.delete(task.task_id);
            pending.set(task.task_id, task);
          }
        }
        while (pending.size > 0) {
          const ready = scheduler.selectReadyTasks(pending, completed);
          if (ready.length === 0) break;
          await Promise.all(
            ready.map(async (task) => {
              await this.runTask(session, task);
              completed.add(task.task_id);
              pending.delete(task.task_id);
            })
          );
        }
        const followUpReview = this.applyReviewGuards(await this.review(session), plan, session);
        if (followUpReview.verdict !== "approve") {
          throw new Error(`Revision was not approved: ${followUpReview.summary}`);
        }
      }

      this.sessions.setStatus(session.session_id, "aggregating");
      const preAggregateOutcome = this.collectSessionOutcome(session.session_id, "");
      const finalContent = await this.aggregate(session, plan.objective, preAggregateOutcome);
      const outcome = this.collectSessionOutcome(session.session_id, finalContent);
      const artifactPath = await this.writeFinalArtifactIfRequested(session, plan, finalContent, outcome);
      this.sessions.setFinalOutput(session.session_id, finalContent);
      this.sessions.setStatus(session.session_id, "completed");
      this.router.receive(createEnvelope({
        swarm_id: session.swarm_id,
        session_id: session.session_id,
        from: { agent_id: "orchestrator", role: "coordinator" },
        to: { agent_id: "runtime", role: "runtime" },
        type: "consensus.result",
        intent: "consensus.reviewer_approval",
        payload: {
          mode: session.policy.consensus,
          decision: "approve",
          outcome
        }
      }));
      this.router.receive(createEnvelope({
        swarm_id: session.swarm_id,
        session_id: session.session_id,
        from: { agent_id: "orchestrator", role: "coordinator" },
        to: { agent_id: "runtime", role: "runtime" },
        type: "swarm.shutdown",
        intent: "swarm.completed",
        payload: { status: "completed" }
      }));

      this.events.emitEvent({
        type: "final",
        session_id: session.session_id,
        content: finalContent,
        artifact_path: artifactPath,
        outcome
      });
      return { session_id: session.session_id, content: finalContent, artifact_path: artifactPath, outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sessions.setStatus(session.session_id, "failed");
      this.router.receive(createEnvelope({
        swarm_id: session.swarm_id,
        session_id: session.session_id,
        from: { agent_id: "orchestrator", role: "coordinator" },
        to: { agent_id: "runtime", role: "runtime" },
        type: "swarm.shutdown",
        intent: "swarm.failed",
        payload: { status: "failed", error: message }
      }));
      this.events.emitEvent({ type: "log", level: "error", message: `Session ${session.session_id} failed: ${message}` });
      throw error;
    }
  }

  private async runTask(session: SwarmSession, task: SwarmTask, attempt = 0): Promise<void> {
    const capability = routeableTaskCapability(task);
    const runAttempt = this.nextTaskAttempt(session, task);
    this.persistTaskState(session, task, "assigned", runAttempt);
    this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "assigned" });
    await this.ensureToolApproval(task.inputs, capability, session, task.task_id);

    const context = task.dependencies?.length
      ? this.blackboard.listForTasks(session.session_id, task.dependencies)
      : this.blackboard.list(session.session_id);

    const envelope = createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: task.task_id,
      attempt: runAttempt,
      from: { agent_id: "orchestrator", role: "coordinator" },
      to: { capability },
      type: "task.assign",
      intent: capability,
      payload: {
        task,
        inputs: task.inputs,
        context,
        attempt: runAttempt
      },
      trace: {
        trace_id: session.session_id,
        span_id: `task_${task.task_id}_${runAttempt}`
      }
    });
    this.persistTaskState(session, task, "running", runAttempt);
    this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "started" });

    // Listen for task.accept / task.start to emit running status
    let runningEmitted = false;
    const unsubRunning = this.events.onEvent((event) => {
      if (
        event.type === "envelope" &&
        event.envelope.task_id === task.task_id &&
        (event.envelope.attempt ?? runAttempt) === runAttempt &&
        (event.envelope.type === "task.accept" || event.envelope.type === "task.start") &&
        !runningEmitted
      ) {
        runningEmitted = true;
        this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "running" });
      }
    });

    let response;
    try {
      response = await this.router.request<AgentResultPayload>(envelope, {
        expect: ["task.result", "task.fail", "error"],
        timeout_ms: session.policy.timeout_ms
      });
    } finally {
      unsubRunning();
    }

    if (response.type === "task.result" && response.payload.status === "completed") {
      const payload = response.payload as AgentResultPayload;
      const entryType = task.type === "tool_call" ? "evidence" : "result";
      const entry = this.blackboard.write({
        swarm_id: session.swarm_id,
        session_id: session.session_id,
        task_id: task.task_id,
        key: `task.${task.task_id}.attempt.${runAttempt}.result`,
        type: entryType,
        value: payload,
        created_by: response.from,
        tags: [task.type, capability, `attempt:${runAttempt}`]
      });
      this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "completed" });
      this.persistTaskState(session, task, "completed", runAttempt);
      this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "completed" });
      this.events.emitEvent({ type: "blackboard", entry });
      if (task.type === "tool_call") {
        this.events.emitEvent({
          type: "tool_result",
          session_id: session.session_id,
          task_id: task.task_id,
          title: task.title,
          action: String(task.inputs?.action ?? capability),
          summary: payload.summary ?? "",
          content: payload.content,
          status: payload.toolStatus,
          outputRef: payload.outputRef,
          attempt: runAttempt,
          errorCode: payload.errorCode
        });
      }
      this.taskCompleted += 1;
      this.events.emitEvent({ type: "progress", completed: this.taskCompleted, total: this.taskTotal });
      return;
    }

    if (response.type === "task.result" && task.type === "tool_call") {
      const payload = response.payload as AgentResultPayload;
      this.events.emitEvent({
        type: "tool_result",
        session_id: session.session_id,
        task_id: task.task_id,
        title: task.title,
        action: String(task.inputs?.action ?? capability),
        summary: payload.summary ?? "Tool task failed",
        content: payload.content,
        status: payload.toolStatus,
        outputRef: payload.outputRef,
        attempt: runAttempt,
        errorCode: payload.errorCode
      });
    }

    const failedPayload = response.type === "task.result" ? response.payload as AgentResultPayload : undefined;
    const errorPayload = response.type === "task.result"
      ? {
          error_code: normalizeTaskErrorCode(failedPayload?.errorCode),
          message: failedPayload?.summary,
          retryable: failedPayload?.retryable ?? isRetryableTaskError(failedPayload?.errorCode),
          failed_task_id: task.task_id,
          recovery_suggestion: failedPayload?.recoverySuggestion ?? (failedPayload?.retryable === false ? undefined : "retry_same_agent" as const)
        }
      : response.payload as unknown as SwarmError & { message?: string };
    const recovery = errorPayload.recovery_suggestion ?? (response.type === "error" ? "retry_same_agent" : undefined);

    if (recovery === "retry_same_agent" && errorPayload.retryable !== false && attempt < session.policy.retry.max_attempts) {
      this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "failed" });
      this.persistTaskState(session, task, "failed", runAttempt, errorPayload.message);
      this.events.emitEvent({ type: "log", level: "warn", message: `Retrying task ${task.task_id} (attempt ${attempt + 1})` });
      return this.runTask(session, task, attempt + 1);
    }

    if (recovery === "retry_different_agent") {
      const alternates = task.required_capabilities.map((item) => item.trim()).filter((item) => item && item !== capability);
      if (alternates.length > 0 && attempt < session.policy.retry.max_attempts) {
        this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "failed" });
        this.persistTaskState(session, task, "failed", runAttempt, errorPayload.message);
        this.events.emitEvent({ type: "log", level: "warn", message: `Retrying task ${task.task_id} with alternate capability ${alternates[0]}` });
        task.required_capabilities = [alternates[0], ...alternates.slice(1)];
        return this.runTask(session, task, attempt + 1);
      }
    }

    if (recovery === "ask_human") {
      this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "failed" });
      this.persistTaskState(session, task, "failed", runAttempt, errorPayload.message);
      this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "failed" });
      this.taskCompleted += 1;
      this.events.emitEvent({ type: "progress", completed: this.taskCompleted, total: this.taskTotal });
      this.events.emitEvent({ type: "log", level: "error", message: `Task ${task.task_id} requires human intervention: ${errorPayload.message ?? "no details"}` });
      throw new Error(`Human intervention required for task "${task.title}": ${errorPayload.message ?? "unknown error"}`);
    }

    if (recovery === "abort_swarm") {
      this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "failed" });
      this.persistTaskState(session, task, "failed", runAttempt, errorPayload.message);
      this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "failed" });
      this.taskCompleted += 1;
      this.events.emitEvent({ type: "progress", completed: this.taskCompleted, total: this.taskTotal });
      this.sessions.setStatus(session.session_id, "cancelled");
      throw new Error(`Swarm aborted by agent recovery suggestion: ${errorPayload.message ?? task.task_id}`);
    }

    this.events.emitEvent({ type: "task_attempt", session_id: session.session_id, task_id: task.task_id, title: task.title, attempt: runAttempt, status: "failed" });
    this.persistTaskState(session, task, "failed", runAttempt, errorPayload.message);
    this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "failed" });
    this.taskCompleted += 1;
    this.events.emitEvent({ type: "progress", completed: this.taskCompleted, total: this.taskTotal });
    throw new Error(`Task failed: ${task.task_id}${errorPayload.message ? `: ${errorPayload.message}` : ""}`);
  }

  private nextTaskAttempt(session: SwarmSession, task: SwarmTask): number {
    const key = `${session.session_id}:${task.task_id}`;
    const next = (this.taskAttempts.get(key) ?? 0) + 1;
    this.taskAttempts.set(key, next);
    return next;
  }

  private persistTaskState(
    session: SwarmSession,
    task: SwarmTask,
    status: SwarmTask["status"],
    attempt: number,
    lastError?: string
  ): void {
    this.taskStates.upsert({
      session_id: session.session_id,
      swarm_id: session.swarm_id,
      task,
      status,
      attempt,
      last_error: lastError
    });
  }

  private applyReviewGuards(reviewResult: ReviewResult, plan: GeneratedPlan, session: SwarmSession): ReviewResult {
    const expectsWorkspaceChanges = plan.intent === "modify_workspace" || plan.intent === "create_project";
    if (!expectsWorkspaceChanges || reviewResult.verdict !== "approve") {
      return reviewResult;
    }
    const outcome = this.collectSessionOutcome(session.session_id, "");
    if (outcome.changed_files.length > 0) {
      if (outcome.tests_run.length > 0) {
        return reviewResult;
      }
      return {
        ...reviewResult,
        verdict: "needs_revision",
        score: Math.min(reviewResult.score, 70),
        summary: "Workspace changes were made, but no verification step was recorded.",
        issues: [
          ...(reviewResult.issues ?? []),
          {
            severity: "medium",
            message: "No verification command or git diff was recorded for a modify/create request.",
            suggested_fix: "Run a focused test, lint, build, or git.diff task after editing files."
          }
        ]
      };
    }
    return {
      ...reviewResult,
      verdict: "needs_revision",
      score: Math.min(reviewResult.score, 60),
      summary: "Workspace-change request produced no changed files.",
      issues: [
        ...(reviewResult.issues ?? []),
        {
          severity: "high",
          message: "No workspace files were changed for a modify/create request.",
          suggested_fix: "Add file.write or file.edit tasks that create or update the requested workspace files, then run verification."
        }
      ]
    };
  }

  private async review(session: SwarmSession): Promise<ReviewResult> {
    const context = this.blackboard.list(session.session_id);
    const outcome = this.collectSessionOutcome(session.session_id, "");
    const envelope = createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: "task_review_all",
      from: { agent_id: "orchestrator", role: "coordinator" },
      to: { capability: "review.general" },
      type: "review.request",
      intent: "review.swarm_results",
      payload: {
        target_task_id: "all",
        context,
        outcome
      }
    });

    const response = await this.router.request<ReviewResult>(envelope, {
      expect: ["review.result", "error"],
      timeout_ms: session.policy.timeout_ms
    });

    if (response.type !== "review.result") {
      throw new Error("Review failed");
    }

    const reviewResult = response.payload as ReviewResult;
    const entry = this.blackboard.write({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: "task_review_all",
      key: "review.final",
      type: "critique",
      value: reviewResult,
      created_by: response.from,
      tags: ["review"]
    });
    this.events.emitEvent({ type: "blackboard", entry });
    this.events.emitEvent({ type: "log", level: "info", message: `Review verdict: ${reviewResult.verdict} (score: ${reviewResult.score})` });
    return reviewResult;
  }

  private async aggregate(session: SwarmSession, objective: string, outcome: SessionOutcome): Promise<string> {
    const envelope = createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: "task_aggregate_final",
      from: { agent_id: "orchestrator", role: "coordinator" },
      to: { capability: "aggregation.summarize" },
      type: "task.assign",
      intent: "aggregation.summarize",
      payload: {
        objective,
        context: this.blackboard.list(session.session_id),
        outcome
      }
    });

    const response = await this.router.request<AgentResultPayload>(envelope, {
      expect: ["task.result", "error"],
      timeout_ms: session.policy.timeout_ms
    });

    if (response.type !== "task.result" || response.payload.status !== "completed") {
      throw new Error("Aggregation failed");
    }

    const content = response.payload.content ?? response.payload.summary;
    const entry = this.blackboard.write({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: "task_aggregate_final",
      key: "outcome.final_summary",
      type: "result",
      value: { content, outcome },
      created_by: response.from,
      tags: ["outcome", "final"]
    });
    this.events.emitEvent({ type: "blackboard", entry });
    return content;
  }

  private async writeFinalArtifactIfRequested(session: SwarmSession, plan: GeneratedPlan, content: string, outcome: SessionOutcome): Promise<string | undefined> {
    const artifactPath = plan.final_artifact?.path;
    if (!artifactPath) {
      return undefined;
    }
    await this.ensureToolApproval(
      {
        action: "file.write",
        path: artifactPath,
        content
      },
      "tool.file.write",
      session,
      "task_write_final_artifact"
    );

    const envelope = createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: "task_write_final_artifact",
      from: { agent_id: "orchestrator", role: "coordinator" },
      to: { capability: "tool.file.write" },
      type: "task.assign",
      intent: "tool.file.write",
      payload: {
        inputs: {
          action: "write_file",
          path: artifactPath,
          content
        }
      }
    });

    const response = await this.router.request<AgentResultPayload>(envelope, {
      expect: ["task.result", "error"],
      timeout_ms: session.policy.timeout_ms
    });

    if (response.type === "task.result") {
      if (!isSwarmInternalPath(artifactPath) && !outcome.changed_files.includes(artifactPath)) {
        outcome.changed_files.push(artifactPath);
      }
      return artifactPath;
    }
    return undefined;
  }

  private collectSessionOutcome(sessionId: string, finalSummary: string): SessionOutcome {
    const changedFiles = new Set<string>();
    const intermediateArtifacts = new Set<string>();
    const testsRun = new Set<string>();

    for (const entry of this.blackboard.list(sessionId)) {
      if ((entry.tags ?? []).some((tag) => ["code.test", "code.lint", "git.diff", "git.status"].includes(tag))) {
        testsRun.add((entry.tags ?? []).find((tag) => ["code.test", "code.lint", "git.diff", "git.status"].includes(tag)) ?? "verification");
      }
      const value = entry.value;
      if (isRecord(value)) {
        collectPathsFromValue(value.data, changedFiles, intermediateArtifacts, testsRun);
        collectPathsFromValue(value.artifacts, changedFiles, intermediateArtifacts, testsRun);
        if (typeof value.outputRef === "string") {
          intermediateArtifacts.add(value.outputRef);
        }
        if (isRecord(value.outcome)) {
          for (const path of arrayOfStrings(value.outcome.changed_files)) changedFiles.add(path);
          for (const path of arrayOfStrings(value.outcome.intermediate_artifacts)) intermediateArtifacts.add(path);
          for (const command of arrayOfStrings(value.outcome.tests_run)) testsRun.add(command);
        }
      }
    }

    return {
      changed_files: [...changedFiles].filter((path) => !isSwarmInternalPath(path)).sort(),
      intermediate_artifacts: [...intermediateArtifacts].sort(),
      tests_run: [...testsRun].sort(),
      final_summary: finalSummary
    };
  }

  private async ensureToolApproval(inputs: Record<string, unknown>, capability: string, session?: SwarmSession, taskId?: string): Promise<void> {
    const action = this.tryNormalizeToolAction(inputs, capability);
    if (!action) {
      return;
    }

    const settings = loadSwarmSettings(this.workspace);
    if (!toolRequiresApproval(action, settings, { workspace: this.workspace })) {
      return;
    }

    const request = createToolApprovalRequest(action);
    request.session_id = session?.session_id;
    request.task_id = taskId;
    if (action.type === "file.write" || action.type === "file.edit") {
      request.detail = [request.detail, await renderWritePreflight(action, this.workspace)].filter(Boolean).join("\n\n");
      request.summary_diff = request.detail;
    }
    this.events.emitEvent({ type: "approval", request, status: "pending" });
    if (!this.approvalHandler) {
      this.events.emitEvent({ type: "approval", request, status: "denied" });
      throw new Error(`Tool action requires approval but no approval handler is available: ${request.summary}`);
    }

    const approved = await this.approvalHandler(request);
    this.events.emitEvent({ type: "approval", request, status: approved ? "approved" : "denied" });
    if (!approved) {
      throw new Error(`Tool action denied: ${request.summary}`);
    }
  }

  private static readonly TOOL_CAPABILITIES = new Set([
    "LS", "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit",
    "TodoWrite", "Bash", "exec", "WebSearch", "WebFetch", "Agent", "Task",
    "BlackboardWrite", "BlackboardSearch", "BlackboardRead", "BlackboardList",
    "tool.file.list", "tool.file.read", "tool.file.glob", "tool.file.grep",
    "tool.file.stat", "tool.file.write", "tool.file.edit", "tool.shell.exec",
    "todo.write",
    "blackboard.write", "blackboard.search", "blackboard.read", "blackboard.list",
    "web.search", "web.fetch",
    "code.test", "code.lint",
    "git.status", "git.diff", "git.log", "git.branch",
    "package.install", "agent.delegate"
  ]);

  private tryNormalizeToolAction(inputs: Record<string, unknown>, capability: string): ToolAction | undefined {
    if (!Orchestrator.TOOL_CAPABILITIES.has(capability) && !inputs.action) {
      return undefined;
    }
    return normalizeToolAction(inputs, capability);
  }
}

function routeableTaskCapability(task: SwarmTask): string {
  const capability = task.required_capabilities.map((item) => item.trim()).find(Boolean);
  if (capability) {
    task.required_capabilities = [
      capability,
      ...task.required_capabilities.map((item) => item.trim()).filter((item) => item && item !== capability)
    ];
    return capability;
  }
  throw new Error(`Task ${task.task_id} has no routeable capability.`);
}

function createSession(objective: string, settings: SwarmSettings): SwarmSession {
  const sessionId = `sess_${randomUUID()}`;
  const swarmId = `swarm_${randomUUID()}`;
  const timestamp = nowIso();
  const source = {
    source: "user",
    human_id: sessionId,
    title: objective.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 160) ?? "Swarm objective",
    description: objective,
    labels: ["interactive", "full_swarm"],
    state: "active",
    metadata: { mode: "full_swarm" }
  };
  return {
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: `user_req_${randomUUID()}`,
    source,
    objective,
    status: "created",
    coordinator: { agent_id: "orchestrator", role: "coordinator" },
    participants: [],
    created_at: timestamp,
    updated_at: timestamp,
    policy: defaultPolicy(settings)
  };
}

function defaultPolicy(settings: SwarmSettings): SwarmPolicy {
  return {
    max_agents: settings.runtime.maxAgents,
    max_parallel_tasks: settings.runtime.maxParallelTasks,
    max_depth: 2,
    max_concurrency: settings.runtime.maxParallelTasks,
    timeout_ms: Number(process.env.SWARM_TASK_TIMEOUT_MS ?? settings.runtime.taskTimeoutMs),
    retry: { max_attempts: 1, backoff_ms: 1000 },
    require_review: true,
    consensus: "reviewer_approval",
    approval_mode: settings.permissions.defaultMode === "yolo"
      ? "yolo"
      : settings.permissions.defaultMode === "full-auto" || settings.permissions.defaultMode === "auto"
        ? "auto"
        : "on-request",
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

function resolveIssueTaskIds(reviewResult: ReviewResult, plan: GeneratedPlan): Set<string> {
  const validTaskIds = new Set(plan.tasks.map((task) => task.task_id));
  const taskIds = new Set<string>();

  for (const issue of reviewResult.issues ?? []) {
    if (issue.task_id && validTaskIds.has(issue.task_id)) {
      taskIds.add(issue.task_id);
      continue;
    }
    const byTitle = plan.tasks.find((task) => task.title === issue.message);
    if (byTitle) {
      taskIds.add(byTitle.task_id);
    }
  }

  return taskIds;
}

function normalizeTaskErrorCode(errorCode: string | undefined): SwarmError["error_code"] {
  if (errorCode === "PERMISSION_DENIED") {
    return "PERMISSION_DENIED";
  }
  if (errorCode === "INVALID_INPUT") {
    return "INVALID_PAYLOAD";
  }
  return "TASK_FAILED";
}

function isRetryableTaskError(errorCode: string | undefined): boolean {
  return !["FS_NOT_FOUND", "INVALID_INPUT", "PERMISSION_DENIED"].includes(errorCode ?? "");
}

async function renderWritePreflight(action: ToolAction, workspace: string): Promise<string> {
  if (action.type === "file.write") {
    const target = resolve(workspace, action.path);
    const before = await stat(target).then((info) => info.isFile() ? readFile(target, "utf8") : "").catch(() => "");
    return createSimpleDiffPreview(action.path, before, action.content);
  }
  if (action.type === "file.edit") {
    const target = resolve(workspace, action.path);
    const before = await readFile(target, "utf8").catch(() => "");
    let after = before;
    if (action.operation === "str_replace" && action.oldText) {
      after = before.replace(action.oldText, action.newText ?? "");
    } else if (action.operation === "insert") {
      after = `${before}${before.endsWith("\n") ? "" : "\n"}${action.content ?? action.newText ?? ""}`;
    }
    return createSimpleDiffPreview(action.path, before, after);
  }
  return "";
}

function createSimpleDiffPreview(path: string, before: string, after: string): string {
  if (before === after) {
    return "Diff preview: no textual change detected.";
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`Diff preview`, `--- ${path}`, `+++ ${path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  let emitted = 0;
  for (let index = 0; index < max && emitted < 80; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) {
      lines.push(`-${beforeLines[index]}`);
      emitted += 1;
    }
    if (afterLines[index] !== undefined) {
      lines.push(`+${afterLines[index]}`);
      emitted += 1;
    }
  }
  if (emitted >= 80) {
    lines.push("... diff preview truncated");
  }
  return lines.join("\n");
}

function isReadOnlyToolAction(action: ToolAction): boolean {
  if (action.type === "git.branch") {
    return !action.action || action.action === "list";
  }
  return [
    "file.list",
    "file.read",
    "file.glob",
    "file.grep",
    "file.stat",
    "web.search",
    "web.fetch",
    "code.test",
    "code.lint",
    "git.status",
    "git.diff",
    "git.log"
  ].includes(action.type);
}

function collectPathsFromValue(value: unknown, changedFiles: Set<string>, intermediateArtifacts: Set<string>, testsRun: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathsFromValue(item, changedFiles, intermediateArtifacts, testsRun);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const action = typeof value.action === "string" ? value.action : undefined;
  const operation = typeof value.operation === "string" ? value.operation : undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  const outputRef = isRecord(value.outputRef) && typeof value.outputRef.path === "string"
    ? value.outputRef.path
    : typeof value.outputRef === "string"
      ? value.outputRef
      : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const passed = typeof value.passed === "boolean" ? value.passed : undefined;

  if (path) {
    if (isSwarmInternalPath(path)) {
      intermediateArtifacts.add(path);
    } else if (action === "file.write" || action === "file.edit" || operation === "create" || operation === "update" || operation === "edit" || "beforeBytes" in value || "afterBytes" in value || "created" in value) {
      changedFiles.add(path);
    }
  }
  if (outputRef) {
    intermediateArtifacts.add(outputRef);
  }
  if (command || passed !== undefined || "exitCode" in value) {
    testsRun.add(command ?? String(value.exitCode ?? "tool verification"));
  }

  for (const key of ["data", "metadata", "artifact", "artifacts", "outputRef", "value"]) {
    if (key in value) {
      collectPathsFromValue(value[key], changedFiles, intermediateArtifacts, testsRun);
    }
  }
}

function isSwarmInternalPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/.swarm/") || normalized.startsWith(".swarm/") || normalized.includes("/.swarm-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
