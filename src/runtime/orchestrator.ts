import { randomUUID } from "node:crypto";
import type { AgentResultPayload, BlackboardEntry, GeneratedPlan, ReviewResult, SwarmError, SwarmPolicy, SwarmSession, SwarmTask } from "../protocol/types.js";
import { createEnvelope, nowIso } from "../protocol/envelope.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SessionStore } from "../storage/session-store.js";
import { loadSwarmSettings, type SwarmSettings } from "../config/settings.js";
import { RuntimeEvents } from "./events.js";
import { EnvelopeRouter } from "./router.js";
import { PlanGenerator } from "./plan-generator.js";
import { normalizeToolAction } from "../tools/local-tools.js";
import { createToolApprovalRequest, toolRequiresApproval } from "../tools/permissions.js";
import type { ToolAction, ToolApprovalRequest } from "../tools/types.js";

export type PlannedSession = {
  session: SwarmSession;
  plan: GeneratedPlan;
};

export type ExecutionResult = {
  session_id: string;
  content: string;
  artifact_path?: string;
};

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export class Orchestrator {
  constructor(
    private readonly router: EnvelopeRouter,
    private readonly sessions: SessionStore,
    private readonly blackboard: BlackboardStore,
    private readonly artifacts: ArtifactStore,
    private readonly planGenerator: PlanGenerator,
    private readonly events: RuntimeEvents,
    private readonly settings: SwarmSettings,
    private readonly workspace: string,
    private readonly approvalHandler?: ToolApprovalHandler
  ) {}

  async createPlan(objective: string): Promise<PlannedSession> {
    const session = createSession(objective, this.settings);
    this.sessions.create(session);
    this.sessions.setStatus(session.session_id, "planning");
    this.events.emitEvent({ type: "log", level: "info", message: `Planning session ${session.session_id}` });

    const plan = await this.planGenerator.generate(objective);
    const normalizedPlan = {
      ...plan,
      final_artifact: {
        path: `${this.settings.runtime.projectArtifactDir.replace(/\\/g, "/")}/${session.session_id}.md`,
        format: "markdown" as const
      }
    };
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

  async execute(planned: PlannedSession): Promise<ExecutionResult> {
    const { session, plan } = planned;
    try {
      this.sessions.setStatus(session.session_id, "running");
      this.events.emitEvent({ type: "log", level: "info", message: `Executing ${plan.tasks.length} swarm tasks` });

      const completed = new Set<string>();
      const pending = new Map(plan.tasks.map((task) => [task.task_id, task]));

      while (pending.size > 0) {
        const ready = [...pending.values()]
          .filter((task) => (task.dependencies ?? []).every((dependency) => completed.has(dependency)))
          .slice(0, session.policy.max_parallel_tasks);

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
      const reviewResult = await this.review(session);

      if (reviewResult.verdict === "reject") {
        this.events.emitEvent({ type: "log", level: "warn", message: `Review rejected with score ${reviewResult.score}. Re-running tasks with new agents.` });
        const issueTasks = new Set(reviewResult.issues?.map((i) => i.message) ?? []);
        for (const task of plan.tasks) {
          if (issueTasks.size === 0 || issueTasks.has(task.title)) {
            completed.delete(task.task_id);
            pending.set(task.task_id, task);
          }
        }
        while (pending.size > 0) {
          const ready = [...pending.values()]
            .filter((task) => (task.dependencies ?? []).every((dependency) => completed.has(dependency)))
            .slice(0, session.policy.max_parallel_tasks);
          if (ready.length === 0) break;
          await Promise.all(
            ready.map(async (task) => {
              await this.runTask(session, task);
              completed.add(task.task_id);
              pending.delete(task.task_id);
            })
          );
        }
        const secondReview = await this.review(session);
        if (secondReview.verdict === "reject") {
          throw new Error(`Review rejected twice. Final verdict: ${secondReview.summary}`);
        }
      } else if (reviewResult.verdict === "needs_revision") {
        this.events.emitEvent({ type: "log", level: "info", message: `Review requested revisions. Feeding back to agents.` });
        const issueTitles = new Set((reviewResult.issues ?? []).map((i) => i.message));
        for (const task of plan.tasks) {
          if (issueTitles.size === 0 || issueTitles.has(task.title)) {
            const revisionNote = (reviewResult.issues ?? [])
              .filter((i) => i.message === task.title || issueTitles.size === 0)
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
          const ready = [...pending.values()]
            .filter((task) => (task.dependencies ?? []).every((dependency) => completed.has(dependency)))
            .slice(0, session.policy.max_parallel_tasks);
          if (ready.length === 0) break;
          await Promise.all(
            ready.map(async (task) => {
              await this.runTask(session, task);
              completed.add(task.task_id);
              pending.delete(task.task_id);
            })
          );
        }
        const followUpReview = await this.review(session);
        if (followUpReview.verdict === "reject") {
          throw new Error(`Revision was rejected: ${followUpReview.summary}`);
        }
      }

      this.sessions.setStatus(session.session_id, "aggregating");
      const finalContent = await this.aggregate(session, plan.objective);
      const artifactPath = await this.writeFinalArtifact(session, plan, finalContent);
      this.sessions.setFinalOutput(session.session_id, finalContent);
      this.sessions.setStatus(session.session_id, "completed");

      this.events.emitEvent({
        type: "final",
        session_id: session.session_id,
        content: finalContent,
        artifact_path: artifactPath
      });
      return { session_id: session.session_id, content: finalContent, artifact_path: artifactPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sessions.setStatus(session.session_id, "failed");
      this.events.emitEvent({ type: "log", level: "error", message: `Session ${session.session_id} failed: ${message}` });
      throw error;
    }
  }

  private async runTask(session: SwarmSession, task: SwarmTask, attempt = 0): Promise<void> {
    const capability = task.required_capabilities[0];
    this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "assigned" });
    await this.ensureToolApproval(task.inputs, capability);

    const context = task.dependencies?.length
      ? this.blackboard.listForTasks(session.session_id, task.dependencies)
      : this.blackboard.list(session.session_id);

    const envelope = createEnvelope({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      task_id: task.task_id,
      from: { agent_id: "orchestrator", role: "coordinator" },
      to: { capability },
      type: "task.assign",
      intent: capability,
      payload: {
        task,
        inputs: task.inputs,
        context
      }
    });

    const response = await this.router.request<AgentResultPayload>(envelope, {
      expect: ["task.result", "task.fail", "error"],
      timeout_ms: session.policy.timeout_ms
    });

    if (response.type === "task.result" && response.payload.status === "completed") {
      const entryType = task.type === "tool_call" ? "evidence" : "result";
      const entry = this.blackboard.write({
        swarm_id: session.swarm_id,
        session_id: session.session_id,
        task_id: task.task_id,
        key: `task.${task.task_id}.result`,
        type: entryType,
        value: response.payload,
        created_by: response.from,
        tags: [task.type, capability]
      });
      this.events.emitEvent({ type: "task", task_id: task.task_id, title: task.title, status: "completed" });
      this.events.emitEvent({ type: "blackboard", entry });
      return;
    }

    const errorPayload = response.payload as unknown as SwarmError & { message?: string };
    const recovery = errorPayload.recovery_suggestion ?? (response.type === "error" ? "retry_same_agent" : undefined);

    if (recovery === "retry_same_agent" && attempt < session.policy.retry.max_attempts) {
      this.events.emitEvent({ type: "log", level: "warn", message: `Retrying task ${task.task_id} (attempt ${attempt + 1})` });
      return this.runTask(session, task, attempt + 1);
    }

    if (recovery === "retry_different_agent") {
      const alternates = task.required_capabilities.filter((c) => c !== capability);
      if (alternates.length > 0 && attempt < session.policy.retry.max_attempts) {
        this.events.emitEvent({ type: "log", level: "warn", message: `Retrying task ${task.task_id} with alternate capability ${alternates[0]}` });
        task.required_capabilities = [alternates[0], ...alternates.slice(1)];
        return this.runTask(session, task, attempt + 1);
      }
    }

    if (recovery === "ask_human") {
      this.events.emitEvent({ type: "log", level: "error", message: `Task ${task.task_id} requires human intervention: ${errorPayload.message ?? "no details"}` });
      throw new Error(`Human intervention required for task "${task.title}": ${errorPayload.message ?? "unknown error"}`);
    }

    if (recovery === "abort_swarm") {
      this.sessions.setStatus(session.session_id, "cancelled");
      throw new Error(`Swarm aborted by agent recovery suggestion: ${errorPayload.message ?? task.task_id}`);
    }

    throw new Error(`Task failed: ${task.task_id}${errorPayload.message ? `: ${errorPayload.message}` : ""}`);
  }

  private async review(session: SwarmSession): Promise<ReviewResult> {
    const context = this.blackboard.list(session.session_id);
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
        context
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

  private async aggregate(session: SwarmSession, objective: string): Promise<string> {
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
        context: this.blackboard.list(session.session_id)
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
      key: "artifact.final_markdown",
      type: "artifact",
      value: { content },
      created_by: response.from,
      tags: ["artifact", "final"]
    });
    this.events.emitEvent({ type: "blackboard", entry });
    return content;
  }

  private async writeFinalArtifact(session: SwarmSession, plan: GeneratedPlan, content: string): Promise<string | undefined> {
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
      "tool.file.write"
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
      this.artifacts.create({
        session_id: session.session_id,
        path: artifactPath,
        type: plan.final_artifact?.format ?? "markdown",
        summary: response.payload.summary
      });
      return artifactPath;
    }
    return undefined;
  }

  private async ensureToolApproval(inputs: Record<string, unknown>, capability: string): Promise<void> {
    const action = this.tryNormalizeToolAction(inputs, capability);
    if (!action) {
      return;
    }

    const settings = loadSwarmSettings(this.workspace);
    if (!toolRequiresApproval(action, settings)) {
      return;
    }

    const request = createToolApprovalRequest(action);
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
    "tool.file.list", "tool.file.read", "tool.file.glob", "tool.file.grep",
    "tool.file.stat", "tool.file.write", "tool.file.edit", "tool.shell.exec",
    "web.search", "web.fetch",
    "code.test", "code.lint",
    "git.status", "git.diff", "git.log", "git.branch",
    "package.install", "solidity.compile", "agent.delegate"
  ]);

  private tryNormalizeToolAction(inputs: Record<string, unknown>, capability: string): ToolAction | undefined {
    if (!Orchestrator.TOOL_CAPABILITIES.has(capability) && !inputs.action) {
      return undefined;
    }
    return normalizeToolAction(inputs, capability);
  }
}

function createSession(objective: string, settings: SwarmSettings): SwarmSession {
  const sessionId = `sess_${randomUUID()}`;
  const swarmId = `swarm_${randomUUID()}`;
  const timestamp = nowIso();
  return {
    swarm_id: swarmId,
    session_id: sessionId,
    user_request_id: `user_req_${randomUUID()}`,
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
    timeout_ms: Number(process.env.SWARM_TASK_TIMEOUT_MS ?? settings.runtime.taskTimeoutMs),
    retry: { max_attempts: 1, backoff_ms: 1000 },
    require_review: true,
    consensus: "reviewer_approval",
    safety: {
      require_human_approval_for: [],
      forbidden_capabilities: ["credential.exfiltrate"],
      sandbox_required: false
    },
    memory: {
      allow_read: true,
      allow_write: true,
      retention: "session"
    },
    budget: {
      max_tool_calls: 50
    }
  };
}
