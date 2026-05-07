import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentCard, BlackboardEntry, ReviewResult, RunAttemptStatus, SwarmEnvelope, SwarmPolicy, SwarmSession, WorkItem, WorkSnapshot } from "../protocol/types.js";
import { createEnvelope } from "../protocol/envelope.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { SessionStore } from "../storage/session-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { WorkerStateStore } from "../storage/worker-state-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
import { ApprovalStore } from "../storage/approval-store.js";
import { AuditStore } from "../storage/audit-store.js";
import { TaskGraphStore, type TaskGraph } from "../storage/task-graph-store.js";
import { UsageStore } from "../storage/usage-store.js";
import { RunAttemptStore } from "../storage/run-attempt-store.js";
import { WorkspaceLeaseStore } from "../storage/workspace-lease-store.js";
import { OpenAIProvider } from "../providers/openai-provider.js";
import { ensureSwarmHome, getSwarmPaths, loadSwarmSettings, type SwarmSettings } from "../config/settings.js";
import { builtinAgents } from "./builtin-agents.js";
import { RuntimeEvents } from "./events.js";
import { AgentRegistry } from "./registry.js";
import { EnvelopeRouter } from "./router.js";
import { PlanGenerator } from "./plan-generator.js";
import { Orchestrator, type ExecutionResult, type PlannedSession, type ToolApprovalHandler } from "./orchestrator.js";
import { getDebugLogger, type DebugLogger } from "./debug-logger.js";
import { CodingAgentLoop } from "./coding-agent-loop.js";
import type { ExecutionRoute, RunOptions } from "./execution-router.js";
import { SwarmController } from "./swarm-controller.js";
import { createSelfReview, type SelfReviewResult } from "./self-review.js";
import {
  getAgentSpec,
  listAgentSpecs,
  renderAgentSpec,
  type AgentInvocationMode,
  type AgentInvocationRequest,
  type AgentSpawnDecision,
  type AgentSpec,
  type AgentTaskPacket
} from "./agent-specs.js";
import type { FileLockEvent, ToolResult, WorkspaceChangeMetadata } from "../tools/types.js";
import { riskClassForAction } from "../tools/permissions.js";
import { normalizeToolAction } from "../tools/local-tools.js";
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

export class SwarmRuntime {
  readonly events = new RuntimeEvents();
  readonly database: SwarmDatabase;
  readonly registry: AgentRegistry;
  readonly router: EnvelopeRouter;
  readonly orchestrator: Orchestrator;
  readonly sessionStore: SessionStore;
  readonly taskStateStore: TaskStateStore;
  readonly traceStore: TraceStore;
  readonly workerStateStore: WorkerStateStore;
  readonly handoffStore: HandoffStore;
  readonly blackboardStore: BlackboardStore;
  readonly approvalStore: ApprovalStore;
  readonly auditStore: AuditStore;
  readonly taskGraphStore: TaskGraphStore;
  readonly usageStore: UsageStore;
  readonly runAttemptStore: RunAttemptStore;
  readonly workspaceLeaseStore: WorkspaceLeaseStore;
  readonly artifactStore: ArtifactStore;
  readonly settings: SwarmSettings;
  readonly debug: DebugLogger | null;
  readonly debugSessionId?: string;
  private readonly provider: OpenAIProvider;
  private readonly workspace: string;
  private readonly approvalHandler?: ToolApprovalHandler;
  private readonly controller: SwarmController;
  private activeCodingLoop?: CodingAgentLoop;
  private activeCodingLoopSessionId?: string;
  private activeSwarmSession?: SwarmSession;
  private readonly sessionWorkspaceOverrides = new Map<string, string>();
  private readonly children: ChildProcess[] = [];
  private disposed = false;

  constructor(options: { databasePath?: string; workspace?: string; approvalHandler?: ToolApprovalHandler; debugSessionId?: string } = {}) {
    ensureSwarmHome();
    const workspace = options.workspace ?? process.cwd();
    this.workspace = workspace;
    this.approvalHandler = options.approvalHandler;
    this.debugSessionId = options.debugSessionId ?? process.env.SWARM_DEBUG_SESSION_ID;
    this.settings = loadSwarmSettings(workspace);
    this.debug = getDebugLogger(getSwarmPaths().logsDir, { sessionId: this.debugSessionId });
    this.debug?.info("runtime", `SwarmRuntime init. workspace=${workspace} pid=${process.pid}`);
    this.database = new SwarmDatabase(options.databasePath ?? this.settings.runtime.databasePath);
    const traceStore = new TraceStore(this.database);
    this.traceStore = traceStore;
    const sessionStore = new SessionStore(this.database);
    this.sessionStore = sessionStore;
    const taskStateStore = new TaskStateStore(this.database);
    this.taskStateStore = taskStateStore;
    this.workerStateStore = new WorkerStateStore(this.database);
    this.handoffStore = new HandoffStore(this.database);
    const blackboardStore = new BlackboardStore(this.database);
    this.blackboardStore = blackboardStore;
    this.approvalStore = new ApprovalStore(this.database);
    this.auditStore = new AuditStore(this.database);
    this.usageStore = new UsageStore(this.database);
    this.runAttemptStore = new RunAttemptStore(this.database);
    this.workspaceLeaseStore = new WorkspaceLeaseStore(this.database);
    this.taskGraphStore = new TaskGraphStore(this.database, taskStateStore);
    const artifactStore = new ArtifactStore(this.database);
    this.artifactStore = artifactStore;
    this.registry = new AgentRegistry(this.events);
    this.router = new EnvelopeRouter(this.registry, traceStore, this.events);
    const provider = new OpenAIProvider();
    this.provider = provider;
    this.orchestrator = new Orchestrator(
      this.router,
      sessionStore,
      blackboardStore,
      artifactStore,
      taskStateStore,
      new PlanGenerator(provider),
      this.events,
      this.settings,
      workspace,
      options.approvalHandler
    );
    this.controller = new SwarmController(provider, this.events, {
      executeRoute: (objective, route) => this.executeRoute(objective, route),
      handleLiveMessage: (content) => this.handleLiveUserMessage(content),
      handleInterrupt: (content) => this.handleInterrupt(content)
    });
    this.spawnBuiltins(workspace);
    this.events.onEvent((event) => this.recordRuntimeEvent(event));

    if (this.debug) {
      this.events.onEvent((event) => {
        if (event.type === "envelope") {
          const env = event.envelope;
          this.debug?.debug("envelope", `${env.type} ${env.from.agent_id ?? "?"} → ${Array.isArray(env.to) ? env.to.map((a) => a.agent_id ?? a.capability ?? "?").join(",") : env.to.agent_id ?? env.to.capability ?? "?"}`, {
            id: env.id,
            type: env.type,
            intent: env.intent,
            task_id: env.task_id,
            correlation_id: env.correlation_id,
            reply_to: env.reply_to
          });
        } else if (event.type === "task") {
          this.debug?.debug("task", `${event.status} ${event.task_id} "${event.title}"`);
        } else if (event.type === "task_attempt") {
          this.debug?.debug("task", `${event.status} ${event.task_id} attempt=${event.attempt} "${event.title}"`);
        } else if (event.type === "tool_result") {
          this.debug?.debug("tool", `${event.task_id} attempt=${event.attempt ?? "?"} status=${event.status ?? "unknown"} ${event.summary}`, {
            outputRef: event.outputRef,
            recoverySuggestion: event.recoverySuggestion
          });
        } else if (event.type === "log") {
          this.debug?.log(event.level, "runtime", event.message);
        } else if (event.type === "plan") {
          this.debug?.debug("plan", `session=${event.plan.objective.slice(0, 80)}, ${event.plan.tasks.length} tasks`);
        } else if (event.type === "blackboard") {
          this.debug?.debug("blackboard", `${event.entry.type} ${event.entry.key}`);
        } else if (event.type === "final") {
          this.debug?.info("final", `session=${event.session_id} changed=${event.outcome?.changed_files.length ?? 0} artifact=${event.artifact_path ?? "none"}`, {
            changedFiles: event.outcome?.changed_files,
            testsRun: event.outcome?.tests_run,
            intermediateArtifacts: event.outcome?.intermediate_artifacts
          });
        } else if (event.type === "error") {
          this.debug?.error("runtime", event.message);
        } else if (event.type === "agent") {
          this.debug?.debug("agent", `${event.card.agent_id} (${event.card.role})`);
        } else if (event.type === "approval") {
          this.debug?.debug("approval", `${event.status} ${event.request.summary}`);
        } else if (event.type === "live_message") {
          this.debug?.debug("live", `${event.status} ${event.id}: ${event.content.slice(0, 120)}`);
        } else if (event.type === "control") {
          this.debug?.debug("control", `${event.action}: ${event.reason}`, { instruction: event.instruction, message_id: event.message_id });
        } else if (event.type === "controller") {
          this.debug?.debug("controller", `${event.action}: ${event.reason}`, { confidence: event.confidence, instruction: event.instruction, details: event.details });
        } else if (event.type === "queue") {
          this.debug?.debug("queue", `${event.operation} ${event.id ?? ""} priority=${event.priority ?? ""} size=${event.size}`);
        } else if (event.type === "worker") {
          this.debug?.debug("worker", `${event.worker.worker_id} ${event.status}: ${event.message ?? event.worker.objective}`);
        } else if (event.type === "agent_spawn_decision") {
          this.debug?.debug("agent-spawn", `${event.worker_id} ${event.decision.agent_spec_id}/${event.decision.invocation_mode}: ${event.decision.reason}`, {
            taskPacket: event.task_packet
          });
        } else if (event.type === "agent_run_started") {
          this.debug?.debug("agent-run", `${event.worker.worker_id} started as ${event.worker.agent_spec_id ?? event.worker.capability}`);
        } else if (event.type === "agent_run_completed") {
          this.debug?.debug("agent-run", `${event.worker.worker_id} completed: ${event.result.slice(0, 160)}`);
        } else if (event.type === "handoff_started") {
          this.debug?.debug("handoff", `${event.handoff.handoff_id} -> ${event.handoff.target_agent_spec_id}: ${event.handoff.reason}`);
        } else if (event.type === "handoff_message") {
          this.debug?.debug("handoff", `${event.handoff_id}: ${event.message}`);
        } else if (event.type === "handoff_returned") {
          this.debug?.debug("handoff", `${event.handoff.handoff_id} returned: ${event.result.slice(0, 160)}`);
        } else if (event.type === "handoff_taken_back") {
          this.debug?.debug("handoff", `${event.handoff.handoff_id} taken back`);
        } else if (event.type === "workspace_change") {
          this.debug?.debug("change", `${event.session_id}: ${event.change.operation} ${event.change.path}`, event.change);
        } else if (event.type === "file_lock") {
          this.debug?.debug("lock", `${event.event.status} ${event.event.path}: ${event.event.reason ?? event.event.holder ?? ""}`, event.event);
        } else if (event.type === "review_started") {
          this.debug?.debug("review", `${event.session_id}: ${event.objective.slice(0, 120)}`);
        } else if (event.type === "review_completed") {
          this.debug?.debug("review", `${event.session_id}: ${event.result.verdict} score=${event.result.score} ${event.result.summary}`);
        } else if (event.type === "verification_started") {
          this.debug?.debug("verify", `${event.session_id}: ${event.objective.slice(0, 120)}`);
        } else if (event.type === "verification_completed") {
          this.debug?.debug("verify", `${event.session_id}: ${event.result.status} ${event.result.summary}`);
        } else if (event.type === "self_review") {
          this.debug?.info("self-review", event.summary, { findings: event.findings, recommendations: event.recommendations });
        } else if (event.type === "eval_result") {
          this.debug?.debug("eval", `${event.status} ${event.name}: ${event.message}`);
        }
      });
    }

    if (!provider.enabled) {
      this.events.emitEvent({
        type: "log",
        level: "warn",
        message: "No usable model provider is configured. Run swarm onboard or configure ~/.swarm/config.json."
      });
    }
  }

  workspaceRoot(): string {
    return this.workspace;
  }

  async createPlan(objective: string): Promise<PlannedSession> {
    const planned = await this.orchestrator.createPlan(objective);
    const lease = this.workspaceLeaseStore.createForLocalSession({
      session_id: planned.session.session_id,
      workspace: this.workspace
    });
    this.sessionStore.updateMetadata(planned.session.session_id, {
      source: planned.session.source,
      workspace_lease_id: lease.lease_id
    });
    this.events.emitEvent({
      type: "session",
      session_id: planned.session.session_id,
      status: this.sessionStore.get(planned.session.session_id)?.status ?? planned.session.status,
      objective: planned.session.objective
    });
    return planned;
  }

  execute(planned: PlannedSession): Promise<ExecutionResult> {
    return this.orchestrator.execute(planned);
  }

  async run(objective: string, options: RunOptions = {}): Promise<ExecutionResult> {
    return this.controller.run(objective, options);
  }

  ensureTuiChatSession(sessionId: string): void {
    const row = this.sessionStore.get(sessionId);
    if (row) {
      const existingLease = row.workspace_lease_id
        ? this.workspaceLeaseStore.get(row.workspace_lease_id)
        : this.workspaceLeaseStore.getBySession(sessionId);
      if (!existingLease) {
        const lease = this.workspaceLeaseStore.createForLocalSession({
          session_id: sessionId,
          workspace: this.workspace
        });
        this.sessionStore.updateMetadata(sessionId, { workspace_lease_id: lease.lease_id });
      }
      return;
    }
    this.ensureLoopSession(sessionId, "Interactive TUI chat session", undefined, {
      labels: ["interactive", "tui"],
      mode: "tui_chat"
    });
  }

  async executeWorkSession(input: {
    session_id: string;
    prompt: string;
    workspace_path?: string;
    maxTurns?: number;
    maxToolCalls?: number;
  }): Promise<ExecutionResult> {
    const row = this.sessionStore.get(input.session_id);
    if (!row) {
      throw new Error(`Unknown session: ${input.session_id}`);
    }
    const workspace = input.workspace_path
      ?? (row.workspace_lease_id ? this.workspaceLeaseStore.get(row.workspace_lease_id)?.workspace_path : undefined)
      ?? this.workspaceLeaseStore.getBySession(input.session_id)?.workspace_path
      ?? this.workspace;
    this.sessionStore.setStatus(input.session_id, "running");
    const loop = new CodingAgentLoop({
      workspace,
      settings: this.settings,
      provider: this.provider,
      events: this.events,
      approvalHandler: this.approvalHandler,
      workerStore: this.workerStateStore,
      invokeAgent: (request) => this.invokeAgent(request),
      sessionId: input.session_id,
      maxTurns: input.maxTurns,
      maxToolCalls: input.maxToolCalls,
      onSessionStart: (sessionId, loopObjective) => {
        this.events.emitEvent({ type: "session", session_id: sessionId, status: "running", objective: loopObjective });
        this.usageStore.append({
          session_id: sessionId,
          kind: "wall_time",
          amount: 0,
          unit: "ms",
          metadata: { event: "session_resume", existing_work_session: true }
        });
      },
      onWorkspaceChange: (change) => this.recordWorkspaceChange(change.sessionId ?? input.session_id, change),
      onFileLock: (event) => this.recordFileLock(event)
    });
    this.activeCodingLoop = loop;
    this.activeCodingLoopSessionId = input.session_id;
    this.sessionWorkspaceOverrides.set(input.session_id, workspace);
    try {
      const result = await loop.run(input.prompt);
      if (result.status === "stopped") {
        this.sessionStore.setStatus(input.session_id, "cancelled");
        this.events.emitEvent({ type: "session", session_id: input.session_id, status: "cancelled", objective: row.objective });
        return result;
      }
      this.sessionStore.setFinalOutput(input.session_id, result.content);
      this.events.emitEvent({ type: "session", session_id: input.session_id, status: "completed", objective: row.objective });
      return result;
    } catch (error) {
      this.sessionStore.setStatus(input.session_id, "failed");
      this.events.emitEvent({ type: "session", session_id: input.session_id, status: "failed", objective: row.objective });
      throw error;
    } finally {
      if (this.activeCodingLoop === loop) {
        this.activeCodingLoop = undefined;
        this.activeCodingLoopSessionId = undefined;
      }
      this.sessionWorkspaceOverrides.delete(input.session_id);
    }
  }

  interruptWorkSession(sessionId: string, reason = "Work session cancellation requested. Stop at the next safe boundary."): boolean {
    if (this.activeCodingLoop && this.activeCodingLoop.isSession(sessionId)) {
      this.activeCodingLoop.requestStop(reason);
      this.events.emitEvent({ type: "log", level: "warn", message: `Cancellation requested for active WorkSession ${sessionId}: ${reason}` });
      return true;
    }
    if (this.activeCodingLoopSessionId === sessionId && this.activeCodingLoop) {
      this.activeCodingLoop.requestStop(reason);
      this.events.emitEvent({ type: "log", level: "warn", message: `Cancellation requested for active WorkSession ${sessionId}: ${reason}` });
      return true;
    }
    this.events.emitEvent({ type: "log", level: "warn", message: `No active coding loop found for WorkSession ${sessionId} cancellation.` });
    return false;
  }

  private async executeRoute(objective: string, route: ExecutionRoute): Promise<ExecutionResult> {
    this.events.emitEvent({
      type: "log",
      level: "info",
      message: `Execution route: ${route.mode} (${Math.round(route.confidence * 100)}%) - ${route.reason}`
    });
    if (route.mode === "full_swarm") {
      const planned = await this.createPlan(objective);
      this.activeSwarmSession = planned.session;
      try {
        const result = await this.execute(planned);
        this.events.emitEvent({
          type: "session",
          session_id: planned.session.session_id,
          status: this.sessionStore.get(planned.session.session_id)?.status ?? "completed",
          objective: planned.session.objective
        });
        return result;
      } catch (error) {
        this.events.emitEvent({
          type: "session",
          session_id: planned.session.session_id,
          status: this.sessionStore.get(planned.session.session_id)?.status ?? "failed",
          objective: planned.session.objective
        });
        throw error;
      } finally {
        if (this.activeSwarmSession?.session_id === planned.session.session_id) {
          this.activeSwarmSession = undefined;
        }
      }
    }
    if (route.mode === "chat") {
      const sessionId = `chat_${randomUUID()}`;
      this.ensureLoopSession(sessionId, objective);
      const content = await this.provider.generateText({
        model: this.provider.workerModel,
        system: [
          "You are Swarm, a local coding CLI assistant.",
          "Answer the user's question directly.",
          "Do not claim you inspected or modified workspace files unless tool results were provided.",
          "Keep the answer concise and practical."
        ].join(" "),
        user: objective
      });
      const result = {
        session_id: sessionId,
        content,
        outcome: {
          changed_files: [],
          intermediate_artifacts: [],
          tests_run: [],
          final_summary: content.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "Completed"
        }
      } satisfies ExecutionResult;
      this.sessionStore.setFinalOutput(sessionId, content);
      this.events.emitEvent({ type: "session", session_id: sessionId, status: "completed", objective });
      this.events.emitEvent({ type: "final", session_id: result.session_id, content, outcome: result.outcome });
      return result;
    }
    const loop = new CodingAgentLoop({
      workspace: this.workspace,
      settings: this.settings,
      provider: this.provider,
      events: this.events,
      approvalHandler: this.approvalHandler,
      workerStore: this.workerStateStore,
      invokeAgent: (request) => this.invokeAgent(request),
      onSessionStart: (sessionId, loopObjective) => this.ensureLoopSession(sessionId, loopObjective),
      onWorkspaceChange: (change) => this.recordWorkspaceChange(change.sessionId ?? "unknown", change),
      onFileLock: (event) => this.recordFileLock(event)
    });
    this.activeCodingLoop = loop;
    this.activeCodingLoopSessionId = undefined;
    try {
      const result = await loop.run(objective);
      this.sessionStore.setFinalOutput(result.session_id, result.content);
      const postCheck = await this.runPostChangeChecks(result.session_id, objective, result.outcome);
      if (!postCheck) {
        this.events.emitEvent({ type: "session", session_id: result.session_id, status: "completed", objective });
        return result;
      }
      const content = [
        result.content,
        "",
        "Swarm Review",
        postCheck.review.summary,
        "",
        "Swarm Verification",
        postCheck.verification.summary
      ].join("\n");
      const baseOutcome = result.outcome ?? { changed_files: [], intermediate_artifacts: [], tests_run: [], final_summary: firstLine(content) };
      const outcome = {
        ...baseOutcome,
        tests_run: [...new Set([...baseOutcome.tests_run, postCheck.verification.summary])]
      };
      this.events.emitEvent({ type: "final", session_id: result.session_id, content, outcome });
      this.sessionStore.setFinalOutput(result.session_id, content);
      this.events.emitEvent({ type: "session", session_id: result.session_id, status: "completed", objective });
      return { ...result, content, outcome };
    } finally {
      if (this.activeCodingLoop === loop) {
        this.activeCodingLoop = undefined;
        this.activeCodingLoopSessionId = undefined;
      }
    }
  }

  async sendUserMessage(content: string): Promise<void> {
    await this.controller.submitUserMessage(content);
  }

  private async handleLiveUserMessage(content: string): Promise<void> {
    if (this.activeCodingLoop) {
      await this.activeCodingLoop.submitUserMessage(content);
      return;
    }
    if (this.activeSwarmSession) {
      const id = `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.events.emitEvent({ type: "live_message", id, session_id: this.activeSwarmSession.session_id, content, status: "processing" });
      const decision = await this.decideLiveControl(content, this.activeSwarmSession);
      this.events.emitEvent({ type: "control", message_id: id, ...decision });
      if (decision.action === "interrupt_and_redirect") {
        for (const handoff of this.handoffStore.listRecent(20).filter((item) => item.parent_session_id === this.activeSwarmSession?.session_id && item.status === "active")) {
          this.takeBackHandoff(handoff.handoff_id);
        }
      }
      this.orchestrator.recordLiveMessage(this.activeSwarmSession, {
        message_id: id,
        content,
        decision
      });
      this.events.emitEvent({ type: "live_message", id, session_id: this.activeSwarmSession.session_id, content, status: "applied" });
      return;
    }
    this.events.emitEvent({
      type: "log",
      level: "warn",
      message: "No active coding loop is available to receive a live message. The message will be handled by the next user turn."
    });
  }

  interrupt(content = "User requested an interrupt. Reassess the current work before continuing."): void {
    this.controller.interrupt(content);
  }

  stopWorker(workerId: string): void {
    const worker = this.workerStateStore.requestStop(workerId);
    this.events.emitEvent({ type: "worker", worker, status: worker.status, message: "Stop requested." });
  }

  listAgentSpecs(): AgentSpec[] {
    return listAgentSpecs();
  }

  renderAgentSpec(id: string): string | undefined {
    const spec = getAgentSpec(id);
    return spec ? renderAgentSpec(spec) : undefined;
  }

  listHandoffs(limit = 20): HandoffSessionRecord[] {
    return this.handoffStore.listRecent(limit);
  }

  getHandoff(handoffId: string): HandoffSessionRecord | undefined {
    return this.handoffStore.get(handoffId);
  }

  takeBackHandoff(handoffId: string): HandoffSessionRecord {
    const existing = this.handoffStore.get(handoffId);
    if (!existing) {
      throw new Error(`Unknown handoff: ${handoffId}`);
    }
    if (existing.status !== "active") {
      return existing;
    }
    const handoff = this.handoffStore.takeBack(handoffId);
    const worker = this.workerStateStore.requestStop(handoff.worker_id);
    this.events.emitEvent({ type: "worker", worker, status: worker.status, message: "Handoff taken back by main Swarm." });
    this.events.emitEvent({ type: "handoff_taken_back", handoff });
    return handoff;
  }

  async continueAgent(workerId: string, message: string): Promise<ToolResult> {
    const worker = this.workerStateStore.get(workerId);
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    return this.invokeAgent({
      parent_session_id: worker.parent_session_id,
      requested_by: "main_swarm",
      capability: worker.capability,
      task: message,
      context: [
        `Continuation of worker ${worker.worker_id}.`,
        worker.agent_spec_id ? `Previous agent spec: ${worker.agent_spec_id}.` : undefined,
        worker.invocation_mode ? `Previous invocation mode: ${worker.invocation_mode}.` : undefined,
        worker.handoff_id ? `Previous handoff: ${worker.handoff_id}.` : undefined,
        worker.task_packet ? `Previous task packet:\n${JSON.stringify(worker.task_packet, null, 2)}` : undefined,
        worker.last_result ? `Previous result:\n${worker.last_result}` : undefined
      ].filter(Boolean).join("\n\n"),
      preferred_agent_spec_id: worker.agent_spec_id,
      preferred_mode: worker.invocation_mode === "handoff" ? "handoff" : "call_subagent",
      file_scope: worker.file_scope,
      spawn_reason: `Continuation requested for ${worker.worker_id}`
    });
  }

  async selfReview(): Promise<SelfReviewResult> {
    const result = await createSelfReview({
      paths: getSwarmPaths(),
      sessions: this.sessionStore.listRecent(20)
    });
    this.events.emitEvent({ type: "self_review", ...result });
    return result;
  }

  async improveSelf(): Promise<ExecutionResult> {
    const review = await this.selfReview();
    const objective = [
      "Improve Swarm itself based on the following self-review evidence.",
      "Keep changes focused, verify with npm run check, npm run build, and npm run evals when feasible.",
      "Do not modify Swarm.md unless the user explicitly asks.",
      "",
      JSON.stringify(review, null, 2)
    ].join("\n");
    return this.executeRoute(objective, { mode: "coding_loop", confidence: 1, reason: "self-improvement command" });
  }

  listBlackboardEntries(sessionId?: string, query: { type?: BlackboardEntry["type"]; tag?: string; keyPrefix?: string; taskId?: string; agentId?: string } = {}): BlackboardEntry[] {
    if (!sessionId) {
      return this.blackboardStore.listRecent(80).filter((entry) => blackboardEntryMatches(entry, query));
    }
    return this.blackboardStore.query(sessionId, query);
  }

  listWorkspaceChanges(sessionId?: string): BlackboardEntry[] {
    const entries = sessionId ? this.blackboardStore.query(sessionId, { tag: "workspace-change" }) : this.blackboardStore.listRecent(100);
    return entries.filter((entry) => (entry.tags ?? []).includes("workspace-change"));
  }

  getTaskGraph(sessionId: string): TaskGraph {
    return this.taskGraphStore.get(sessionId);
  }

  getTaskDetail(sessionId: string, taskId: string): {
    task?: ReturnType<TaskGraphStore["get"]>["tasks"][number];
    attempts: ReturnType<RunAttemptStore["listByTask"]>;
    blackboard: BlackboardEntry[];
    trace: SwarmEnvelope[];
    audit: ReturnType<AuditStore["list"]>;
    usage: ReturnType<UsageStore["list"]>;
  } {
    return {
      task: this.taskGraphStore.get(sessionId).tasks.find((task) => task.task_id === taskId),
      attempts: this.runAttemptStore.listByTask(sessionId, taskId),
      blackboard: this.blackboardStore.query(sessionId, { taskId }),
      trace: this.traceStore.list(sessionId).filter((envelope) => envelope.task_id === taskId),
      audit: this.auditStore.list(sessionId, 200).filter((record) => record.task_id === taskId),
      usage: this.usageStore.list(sessionId, 200).filter((record) => record.task_id === taskId)
    };
  }

  getWorkSnapshot(sessionId: string): WorkSnapshot {
    const row = this.sessionStore.get(sessionId);
    if (!row) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const graph = this.getTaskGraph(sessionId);
    const blackboard = this.blackboardStore.list(sessionId);
    const attempts = this.runAttemptStore.list(sessionId);
    const workspace = row.workspace_lease_id
      ? this.workspaceLeaseStore.get(row.workspace_lease_id)
      : this.workspaceLeaseStore.getBySession(sessionId);
    const workers = this.workerStateStore.listByParent(sessionId);
    const finalOutcome = row.final_outcome_json
      ? JSON.parse(row.final_outcome_json) as WorkSnapshot["final_outcome"]
      : undefined;
    const reviewEntry = [...blackboard].reverse().find((entry) => entry.type === "critique" && (entry.tags ?? []).includes("review"));
    const verificationEntry = [...blackboard].reverse().find((entry) => entry.type === "evidence" && (entry.tags ?? []).includes("verify"));
    const changedFiles = finalOutcome?.changed_files ?? uniqueStrings(
      blackboard
        .filter((entry) => (entry.tags ?? []).includes("workspace-change"))
        .map((entry) => isRecord(entry.value) && typeof entry.value.path === "string" ? entry.value.path : undefined)
    );
    const checks = finalOutcome?.tests_run ?? uniqueStrings([
      ...attempts
        .filter((attempt) => attempt.kind === "verification" || attempt.kind === "tool_call")
        .map((attempt) => typeof attempt.metadata.summary === "string" ? attempt.metadata.summary : undefined),
      ...blackboard
        .filter((entry) => (entry.tags ?? []).some((tag) => ["verify", "code.test", "code.lint", "git.diff"].includes(tag)))
        .map((entry) => isRecord(entry.value) && typeof entry.value.summary === "string" ? entry.value.summary : undefined)
    ]);
    const counts: Record<string, number> = {};
    for (const entry of blackboard) {
      counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    }
    return {
      session: {
        session_id: row.session_id,
        swarm_id: row.swarm_id,
        objective: row.objective,
        status: row.status,
        source: row.source_json ? JSON.parse(row.source_json) as WorkItem : undefined,
        parent_session_id: row.parent_session_id ?? undefined,
        workspace_lease_id: row.workspace_lease_id ?? workspace?.lease_id,
        created_at: row.created_at,
        updated_at: row.updated_at
      },
      workspace,
      attempts,
      workers,
      graph,
      blackboard_counts: counts,
      changed_files: changedFiles,
      checks,
      review: reviewEntry?.value as ReviewResult | undefined,
      verification: verificationEntry?.value,
      usage_summary: this.usageStore.summarize(sessionId),
      final_outcome: finalOutcome
    };
  }

  replaySession(sessionId: string): string {
    const snapshot = this.getWorkSnapshot(sessionId);
    const approvals = this.approvalStore.list(sessionId, 100);
    const audit = this.auditStore.list(sessionId, 100);
    const trace = this.traceStore.list(sessionId);
    return [
      `Source: ${snapshot.session.source?.source ?? "user"}${snapshot.session.source?.human_id ? ` ${snapshot.session.source.human_id}` : ""}`,
      `${snapshot.session.session_id} [${snapshot.session.status}]`,
      snapshot.session.objective,
      "",
      "Workspace",
      snapshot.workspace ? `${snapshot.workspace.workspace_path} boundary=${snapshot.workspace.write_boundary}` : "(none)",
      "",
      `Attempts: ${snapshot.attempts.length}`,
      ...snapshot.attempts.map((attempt) => `${attempt.started_at} ${attempt.kind} ${attempt.task_id ?? attempt.runner_id ?? "-"} [${attempt.status}] #${attempt.attempt} ${attempt.title ?? ""}${attempt.terminal_reason ? ` - ${attempt.terminal_reason}` : ""}`),
      "",
      `Tasks: ${snapshot.graph.tasks.length}`,
      ...snapshot.graph.tasks.map((task) => `${task.task_id} [${task.status}] #${task.attempt} ${task.title}`),
      "",
      `Workers: ${snapshot.workers.length}`,
      ...snapshot.workers.map((worker) => isRecord(worker) ? `${String(worker.worker_id ?? "-")} [${String(worker.status ?? "-")}] ${String(worker.agent_spec_id ?? worker.capability ?? "")}` : JSON.stringify(worker)),
      "",
      `Changes: ${snapshot.changed_files.length}`,
      ...(snapshot.changed_files.length ? snapshot.changed_files : ["(none)"]),
      "",
      `Verification: ${snapshot.checks.length}`,
      ...(snapshot.checks.length ? snapshot.checks : ["(none)"]),
      "",
      `Review: ${snapshot.review ? `${snapshot.review.verdict} ${snapshot.review.score} - ${snapshot.review.summary}` : "(none)"}`,
      "",
      `Approvals: ${approvals.length}`,
      ...approvals.slice(0, 20).map((approval) => `${approval.approval_id} [${approval.status}/${approval.risk_class}] ${approval.summary}`),
      "",
      `Audit: ${audit.length}`,
      ...audit.slice(0, 30).map((record) => `${record.created_at} ${record.decision} ${record.action} ${record.task_id ?? ""}`),
      "",
      `Trace envelopes: ${trace.length}`,
      ...trace.slice(-30).map((env) => `${env.created_at} ${env.type} ${env.task_id ?? ""} ${env.intent}`),
      "",
      `Usage: ${JSON.stringify(snapshot.usage_summary)}`,
      "",
      `Final: ${snapshot.final_outcome?.final_summary ?? "(none)"}`
    ].join("\n");
  }

  async forkSession(sessionId: string, message?: string): Promise<PlannedSession> {
    const row = this.sessionStore.get(sessionId);
    if (!row) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const objective = [
      `Fork of ${sessionId}: ${row.objective}`,
      message ? `New instruction: ${message}` : undefined,
      "",
      "Use the previous session as context, but create a fresh plan and do not assume previous side effects should be repeated."
    ].filter(Boolean).join("\n");
    const planned = await this.createPlan(objective);
    this.writeBlackboardEvidence(planned.session.session_id, {
      key: `fork.source.${sessionId}`,
      type: "decision",
      value: {
        source_session_id: sessionId,
        source_status: row.status,
        message,
        source_final_output: row.final_output?.slice(0, 4000)
      },
      tags: ["fork", sessionId],
      created_by: { agent_id: "main_swarm", role: "controller" }
    });
    return planned;
  }

  private recordRuntimeEvent(event: Parameters<RuntimeEvents["emitEvent"]>[0]): void {
    try {
      if (event.type === "plan") {
        this.taskGraphStore.storePlan(event.session_id, event.plan);
        return;
      }
      if (event.type === "approval") {
        this.approvalStore.upsert(event.request, event.status);
        this.usageStore.append({
          session_id: event.request.session_id,
          task_id: event.request.task_id,
          kind: "approval",
          amount: 1,
          unit: "count",
          metadata: { status: event.status, action: event.request.action, risk_class: event.request.risk_class }
        });
        this.auditStore.append({
          session_id: event.request.session_id,
          task_id: event.request.task_id,
          actor_type: event.status === "pending" ? "policy" : "user",
          actor_id: event.status === "pending" ? "policy_engine" : "local_user",
          action: event.request.action,
          resource: event.request,
          risk_class: event.request.risk_class,
          decision: event.status === "pending" ? "requested" : event.status,
          reason: event.request.why_now
        });
        return;
      }
      if (event.type === "session") {
        if (event.parent_session_id) {
          this.sessionStore.updateMetadata(event.session_id, { parent_session_id: event.parent_session_id });
        }
        return;
      }
      if (event.type === "task_attempt" && event.session_id) {
        this.runAttemptStore.upsert({
          session_id: event.session_id,
          task_id: event.task_id,
          runner_id: event.task_id.startsWith("worker_loop_") ? "worker" : event.task_id.startsWith("coding_turn") ? "main_swarm" : undefined,
          kind: event.task_id.startsWith("coding_turn") || event.task_id.includes("_turn_") ? "coding_turn" : "swarm_task",
          status: normalizeAttemptStatus(event.status),
          attempt: event.attempt,
          title: event.title,
          terminal_reason: event.status === "failed" ? event.title : undefined,
          workspace_path: this.workspaceForSession(event.session_id)
        });
        return;
      }
      if (event.type === "tool_result") {
        if (event.session_id) {
          const row = this.sessionStore.get(event.session_id);
          this.taskGraphStore.upsertSyntheticTool({
            session_id: event.session_id,
            swarm_id: row?.swarm_id ?? `swarm_${event.session_id}`,
            task_id: event.task_id,
            title: event.title,
            action: event.action,
            status: event.status === "failed" ? "failed" : "completed",
            attempt: event.attempt
          });
          this.usageStore.append({
            session_id: event.session_id,
            task_id: event.task_id,
            kind: "tool_call",
            amount: 1,
            unit: "count",
            metadata: { action: event.action, status: event.status ?? "success", summary: event.summary }
          });
          this.auditStore.append({
            session_id: event.session_id,
            task_id: event.task_id,
            trace_id: event.session_id,
            actor_type: "tool",
            actor_id: event.action,
            action: event.action,
            resource: { summary: event.summary, outputRef: event.outputRef, errorCode: event.errorCode, recoverySuggestion: event.recoverySuggestion },
            risk_class: riskClassForActionName(event.action),
            decision: event.status === "failed" ? "failed" : "executed",
            reason: event.summary
          });
          this.runAttemptStore.upsert({
            session_id: event.session_id,
            task_id: event.task_id,
            runner_id: event.action,
            kind: "tool_call",
            status: event.status === "failed" ? "failed" : "completed",
            attempt: event.attempt ?? 0,
            title: event.title,
            terminal_reason: event.summary,
            workspace_path: this.workspaceForSession(event.session_id),
            error_code: event.errorCode,
            recovery_suggestion: event.recoverySuggestion,
            metadata: {
              action: event.action,
              summary: event.summary,
              outputRef: event.outputRef,
              recoverySuggestion: event.recoverySuggestion,
              status: event.status ?? "success"
            }
          });
        }
        return;
      }
      if (event.type === "workspace_change") {
        this.auditStore.append({
          session_id: event.session_id,
          task_id: event.change.taskId,
          trace_id: event.session_id,
          actor_type: "tool",
          actor_id: "tool.file",
          action: `file.${event.change.operation}`,
          resource: event.change,
          risk_class: "r1",
          decision: "executed",
          reason: `${event.change.operation} ${event.change.path}`
        });
        return;
      }
      if (event.type === "agent_run_started") {
        this.runAttemptStore.upsert({
          session_id: event.worker.parent_session_id,
          task_id: event.worker.worker_id,
          runner_id: event.worker.agent_spec_id ?? event.worker.capability,
          kind: "worker_run",
          status: "started",
          attempt: 1,
          title: event.worker.objective,
          workspace_path: this.workspaceForSession(event.worker.parent_session_id),
          metadata: {
            worker_id: event.worker.worker_id,
            agent_spec_id: event.worker.agent_spec_id,
            invocation_mode: event.worker.invocation_mode,
            task_packet: event.task_packet
          }
        });
        this.usageStore.append({
          session_id: event.worker.parent_session_id,
          task_id: event.worker.worker_id,
          kind: "worker_spawn",
          amount: 1,
          unit: "count",
          metadata: { agent_spec_id: event.worker.agent_spec_id, capability: event.worker.capability }
        });
        this.auditStore.append({
          session_id: event.worker.parent_session_id,
          task_id: event.worker.worker_id,
          trace_id: event.worker.parent_session_id,
          actor_type: "runtime",
          actor_id: "main_swarm",
          action: "agent.spawn",
          resource: { worker_id: event.worker.worker_id, task_packet: event.task_packet },
          risk_class: "r1",
          decision: "executed",
          reason: event.worker.spawn_reason
        });
        return;
      }
      if (event.type === "agent_run_completed") {
        this.runAttemptStore.upsert({
          session_id: event.worker.parent_session_id,
          task_id: event.worker.worker_id,
          runner_id: event.worker.agent_spec_id ?? event.worker.capability,
          kind: "worker_run",
          status: event.worker.status === "failed" ? "failed" : event.worker.status === "stopped" ? "stopped" : "completed",
          attempt: 1,
          title: event.worker.objective,
          terminal_reason: firstLine(event.result),
          workspace_path: this.workspaceForSession(event.worker.parent_session_id),
          metadata: {
            result: event.result,
            outcome: event.worker.outcome
          }
        });
        return;
      }
      if (event.type === "review_started" || event.type === "verification_started") {
        this.runAttemptStore.upsert({
          session_id: event.session_id,
          task_id: event.type === "review_started" ? "review.coding_loop" : "verification.coding_loop",
          runner_id: event.type === "review_started" ? "reviewer" : "verifier",
          kind: event.type === "review_started" ? "review" : "verification",
          status: "started",
          attempt: 1,
          title: event.objective,
          workspace_path: this.workspaceForSession(event.session_id)
        });
        return;
      }
      if (event.type === "review_completed") {
        this.runAttemptStore.upsert({
          session_id: event.session_id,
          task_id: "review.coding_loop",
          runner_id: "reviewer",
          kind: "review",
          status: event.result.verdict === "reject" ? "failed" : "completed",
          attempt: 1,
          title: "Post-change review",
          terminal_reason: event.result.summary,
          workspace_path: this.workspaceForSession(event.session_id),
          metadata: { result: event.result }
        });
        return;
      }
      if (event.type === "verification_completed") {
        this.runAttemptStore.upsert({
          session_id: event.session_id,
          task_id: "verification.coding_loop",
          runner_id: "verifier",
          kind: "verification",
          status: event.result.status === "failed" ? "failed" : "completed",
          attempt: 1,
          title: "Post-change verification",
          terminal_reason: event.result.summary,
          workspace_path: this.workspaceForSession(event.session_id),
          metadata: { result: event.result }
        });
        return;
      }
      if (event.type === "final") {
        if (event.outcome) {
          this.sessionStore.setFinalOutcome(event.session_id, event.outcome);
        }
        this.runAttemptStore.upsert({
          session_id: event.session_id,
          task_id: "final",
          runner_id: "main_swarm",
          kind: event.session_id.startsWith("chat_") ? "chat_response" : "coding_turn",
          status: "completed",
          attempt: 0,
          title: "Final response",
          terminal_reason: event.outcome?.final_summary ?? firstLine(event.content),
          workspace_path: this.workspaceForSession(event.session_id),
          metadata: {
            artifact_path: event.artifact_path,
            outcome: event.outcome
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debug?.warn("runtime", `failed to persist runtime event ${event.type}: ${message}`);
    }
  }

  private async invokeAgent(request: AgentInvocationRequest): Promise<ToolResult> {
    this.checkWorkerBudget(request.parent_session_id);
    const workerId = `worker_${randomUUID()}`;
    const decision = await this.decideAgentSpawn(request);
    const spec = getAgentSpec(decision.agent_spec_id) ?? getAgentSpec("researcher");
    if (!spec) {
      throw new Error("No built-in agent specs are available.");
    }
    const taskPacket = buildAgentTaskPacket(request, spec, decision);
    const handoffId = decision.invocation_mode === "handoff" ? `handoff_${randomUUID()}` : undefined;
    const worker = this.workerStateStore.create({
      worker_id: workerId,
      parent_session_id: request.parent_session_id,
      capability: request.capability,
      objective: request.task,
      agent_spec_id: spec.id,
      invocation_mode: decision.invocation_mode,
      handoff_id: handoffId,
      file_scope: taskPacket.file_scope,
      tool_budget: taskPacket.budget,
      persona_snapshot: taskPacket.persona_snapshot,
      task_packet: taskPacket,
      output_contract: taskPacket.expected_output,
      spawn_reason: decision.reason || request.spawn_reason,
      requested_by: request.requested_by
    });
    this.events.emitEvent({ type: "agent_spawn_decision", worker_id: workerId, decision, task_packet: taskPacket });
    this.writeBlackboardEvidence(request.parent_session_id, {
      key: `decision.spawn.${workerId}`,
      type: "decision",
      value: { worker_id: workerId, decision, task_packet: taskPacket },
      tags: ["decision", "spawn", spec.id, decision.invocation_mode],
      created_by: { agent_id: "main_swarm", role: "controller" }
    });
    this.events.emitEvent({ type: "agent_run_started", worker, task_packet: taskPacket });
    this.events.emitEvent({ type: "worker", worker, status: worker.status, message: `${spec.id}/${decision.invocation_mode}: ${request.task}` });

    let handoff: HandoffSessionRecord | undefined;
    if (handoffId) {
      handoff = this.handoffStore.create({
        handoff_id: handoffId,
        worker_id: workerId,
        parent_session_id: request.parent_session_id,
        source_agent: request.requested_by,
        target_agent_spec_id: spec.id,
        reason: decision.reason,
        task_packet: taskPacket
      });
      this.events.emitEvent({ type: "handoff_started", handoff });
    }

    const workerLoop = new CodingAgentLoop({
      workspace: this.workspaceForSession(request.parent_session_id),
      settings: this.settings,
      provider: this.provider,
      events: this.events,
      approvalHandler: this.approvalHandler,
      role: "worker",
      parentSessionId: request.parent_session_id,
      workerId,
      workerStore: this.workerStateStore,
      delegateDepth: 0,
      maxTurns: taskPacket.budget.max_turns,
      maxToolCalls: taskPacket.budget.max_tool_calls,
      emitFinal: false,
      emitProgress: false,
      agentInstructions: renderAgentRuntimeInstructions(spec, decision, taskPacket),
      allowedTools: taskPacket.allowed_tools,
      writePolicy: taskPacket.write_policy,
      onSessionStart: (sessionId, loopObjective) => this.ensureLoopSession(sessionId, loopObjective, request.parent_session_id),
      onWorkspaceChange: (change) => this.recordWorkspaceChange(change.sessionId ?? request.parent_session_id, change),
      onFileLock: (event) => this.recordFileLock(event)
    });

    try {
      const result = await workerLoop.run(renderAgentTaskPrompt(taskPacket, decision));
      const latestWorker = this.workerStateStore.get(workerId);
      const latestHandoff = handoff ? this.handoffStore.get(handoff.handoff_id) : undefined;
      const stopped = latestWorker?.status === "stopped" || latestHandoff?.status === "taken_back";
      const status = stopped ? "stopped" : "completed";
      const finalRecord = this.workerStateStore.setResult({
        worker_id: workerId,
        status,
        worker_session_id: result.session_id,
        last_result: result.content,
        outcome: result.outcome
      });
      this.events.emitEvent({ type: "worker", worker: finalRecord, status: finalRecord.status, message: firstLine(result.content) });
      this.events.emitEvent({ type: "agent_run_completed", worker: finalRecord, result: result.content });

      let finalHandoff = latestHandoff;
      if (handoff && latestHandoff?.status !== "taken_back") {
        finalHandoff = this.handoffStore.finish({ handoff_id: handoff.handoff_id, status: "returned", result: result.content });
        this.events.emitEvent({ type: "handoff_returned", handoff: finalHandoff, result: result.content });
      }

      return {
        action: "agent.delegate",
        status: status === "completed" ? "success" : "partial",
        summary: `${spec.name} ${status}: ${firstLine(result.content)}`,
        content: result.content,
        data: {
          worker_id: workerId,
          worker_session_id: result.session_id,
          agent_spec_id: spec.id,
          invocation_mode: decision.invocation_mode,
          handoff_id: finalHandoff?.handoff_id,
          capability: request.capability,
          outcome: result.outcome,
          worker_status: status
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRecord = this.workerStateStore.setResult({
        worker_id: workerId,
        status: "failed",
        last_result: message
      });
      this.events.emitEvent({ type: "worker", worker: failedRecord, status: failedRecord.status, message });
      if (handoff) {
        const failedHandoff = this.handoffStore.finish({ handoff_id: handoff.handoff_id, status: "failed", result: message });
        this.events.emitEvent({ type: "handoff_returned", handoff: failedHandoff, result: message });
      }
      return {
        action: "agent.delegate",
        status: "failed",
        summary: `${spec.name} failed: ${message}`,
        content: message,
        errorCode: "AGENT_RUN_FAILED",
        recoverable: true,
        data: {
          worker_id: workerId,
          agent_spec_id: spec.id,
          invocation_mode: decision.invocation_mode,
          handoff_id: handoff?.handoff_id,
          capability: request.capability
        }
      };
    }
  }

  private workspaceForSession(sessionId: string): string {
    const override = this.sessionWorkspaceOverrides.get(sessionId);
    if (override) {
      return override;
    }
    const row = this.sessionStore.get(sessionId);
    const lease = row?.workspace_lease_id
      ? this.workspaceLeaseStore.get(row.workspace_lease_id)
      : this.workspaceLeaseStore.getBySession(sessionId);
    return lease?.workspace_path ?? this.workspace;
  }

  private ensureLoopSession(
    sessionId: string,
    objective: string,
    parentSessionId?: string,
    options: { labels?: string[]; mode?: string } = {}
  ): void {
    const timestamp = new Date().toISOString();
    const policy = createLocalPolicy(this.settings);
    const source: WorkItem = {
      source: parentSessionId ? "worker" : sessionId.startsWith("chat_") ? "user" : "user",
      source_id: parentSessionId,
      human_id: sessionId,
      title: firstLine(objective) || objective.slice(0, 120),
      description: objective,
      labels: options.labels ?? (parentSessionId ? ["worker"] : ["interactive"]),
      state: "active",
      metadata: {
        parent_session_id: parentSessionId,
        mode: options.mode ?? (sessionId.startsWith("chat_") || sessionId.startsWith("chat-")
          ? "chat"
          : sessionId.startsWith("worker_loop_")
            ? "worker_loop"
            : "coding_loop")
      }
    };
    const lease = this.workspaceLeaseStore.createForLocalSession({
      session_id: sessionId,
      workspace: parentSessionId ? this.workspaceForSession(parentSessionId) : this.workspace,
      parent_session_id: parentSessionId
    });
    const session: SwarmSession = {
      swarm_id: parentSessionId ? `swarm_${parentSessionId}` : `swarm_${sessionId}`,
      session_id: sessionId,
      user_request_id: parentSessionId ?? `user_req_${randomUUID()}`,
      source,
      parent_session_id: parentSessionId,
      workspace_lease_id: lease.lease_id,
      objective,
      status: "running",
      coordinator: { agent_id: "main_swarm", role: parentSessionId ? "worker-controller" : "controller" },
      participants: [],
      created_at: timestamp,
      updated_at: timestamp,
      policy
    };
    this.sessionStore.createIfMissing(session);
    this.sessionStore.updateMetadata(sessionId, { source, parent_session_id: parentSessionId, workspace_lease_id: lease.lease_id });
    this.events.emitEvent({ type: "session", session_id: sessionId, status: "running", objective, parent_session_id: parentSessionId });
    this.usageStore.append({
      session_id: sessionId,
      kind: "wall_time",
      amount: 0,
      unit: "ms",
      metadata: { event: "session_start", parent_session_id: parentSessionId }
    });
  }

  private checkWorkerBudget(parentSessionId: string): void {
    const row = this.sessionStore.get(parentSessionId);
    const policy = row ? JSON.parse(row.policy_json) as SwarmPolicy : createLocalPolicy(this.settings);
    const maxAgents = policy.budget?.max_agents ?? policy.max_agents ?? this.settings.runtime.maxAgents;
    const running = this.workerStateStore.listByParent(parentSessionId).filter((worker) => worker.status === "running").length;
    if (running >= maxAgents) {
      this.auditStore.append({
        session_id: parentSessionId,
        actor_type: "policy",
        actor_id: "resource_manager",
        action: "agent.spawn",
        resource: { running, max_agents: maxAgents },
        risk_class: "r1",
        decision: "blocked",
        reason: `Worker budget exceeded: ${running}/${maxAgents}`
      });
      throw new Error(`Worker budget exceeded for ${parentSessionId}: ${running}/${maxAgents}`);
    }
  }

  private recordWorkspaceChange(sessionId: string, change: WorkspaceChangeMetadata): void {
    const normalizedSessionId = sessionId || change.sessionId || "unknown";
    this.events.emitEvent({ type: "workspace_change", session_id: normalizedSessionId, change });
    this.writeBlackboardEvidence(normalizedSessionId, {
      key: `change.${sanitizeKey(change.path)}.${change.taskId ?? "tool"}`,
      type: "evidence",
      value: change,
      tags: ["workspace-change", change.operation, change.path],
      created_by: { agent_id: "tool.file", role: "tool" }
    });
  }

  private recordFileLock(event: FileLockEvent): void {
    this.events.emitEvent({ type: "file_lock", event });
    if (!event.sessionId) {
      return;
    }
    this.writeBlackboardEvidence(event.sessionId, {
      key: `lock.${sanitizeKey(event.path)}.${event.status}.${event.taskId ?? "tool"}`,
      type: "decision",
      value: event,
      tags: ["file-lock", event.status, event.path],
      created_by: { agent_id: "tool.file", role: "tool" }
    });
  }

  private async runPostChangeChecks(
    sessionId: string,
    objective: string,
    outcome?: { changed_files: string[]; tests_run: string[]; intermediate_artifacts: string[] }
  ): Promise<{ review: ReviewResult; verification: { status: "success" | "partial" | "failed"; summary: string; content?: string; worker_id?: string } } | undefined> {
    if (!outcome?.changed_files.length) {
      return undefined;
    }
    const context = JSON.stringify({
      objective,
      changed_files: outcome.changed_files,
      tests_run: outcome.tests_run,
      intermediate_artifacts: outcome.intermediate_artifacts,
      recent_changes: this.listWorkspaceChanges(sessionId).slice(-20).map((entry) => entry.value)
    }, null, 2);

    this.events.emitEvent({ type: "review_started", session_id: sessionId, objective });
    const reviewTool = await this.invokeAgent({
      parent_session_id: sessionId,
      requested_by: "main_swarm",
      capability: "code.review",
      task: "Review the current workspace changes for correctness, regressions, missing tests, and user-goal fit. Return a clear verdict.",
      context,
      preferred_agent_spec_id: "reviewer",
      preferred_mode: "call_subagent",
      spawn_reason: "automatic post-change review"
    });
    const review = await this.normalizeReviewResult(reviewTool, sessionId);
    this.events.emitEvent({ type: "review_completed", session_id: sessionId, result: review });
    this.writeBlackboardEvidence(sessionId, {
      key: `review.coding_loop.${Date.now()}`,
      type: "critique",
      value: review,
      tags: ["review", review.verdict],
      created_by: { agent_id: "reviewer", role: "reviewer" }
    });

    this.events.emitEvent({ type: "verification_started", session_id: sessionId, objective });
    const verificationTool = await this.invokeAgent({
      parent_session_id: sessionId,
      requested_by: "main_swarm",
      capability: "verify",
      task: "Verify the workspace changes. Prefer existing check/build/test scripts; if no command is suitable, run git.diff and state the verification gap.",
      context: [
        context,
        "",
        "Review result:",
        JSON.stringify(review, null, 2)
      ].join("\n"),
      preferred_agent_spec_id: "verifier",
      preferred_mode: "call_subagent",
      spawn_reason: "automatic post-change verification"
    });
    const verification = {
      status: verificationTool.status ?? "success",
      summary: verificationTool.summary,
      content: verificationTool.content,
      worker_id: isRecord(verificationTool.data) && typeof verificationTool.data.worker_id === "string" ? verificationTool.data.worker_id : undefined
    };
    this.events.emitEvent({ type: "verification_completed", session_id: sessionId, result: verification });
    this.writeBlackboardEvidence(sessionId, {
      key: `verify.coding_loop.${Date.now()}`,
      type: "evidence",
      value: verification,
      tags: ["verify", verification.status],
      created_by: { agent_id: "verifier", role: "verifier" }
    });
    return { review, verification };
  }

  private async normalizeReviewResult(tool: ToolResult, sessionId: string): Promise<ReviewResult> {
    try {
      const response = await this.provider.generateText({
        model: this.provider.workerModel,
        system: [
          "Convert an internal Swarm review-agent result into exactly one JSON object.",
          "Keys: target_task_id, reviewer, verdict, score, issues, summary.",
          "verdict must be approve, reject, or needs_revision.",
          "score must be a number from 0 to 100.",
          "issues must be an array of {severity, message, evidence, suggested_fix}.",
          "Do not include Markdown fences or prose outside JSON."
        ].join(" "),
        user: JSON.stringify({ session_id: sessionId, tool }, null, 2)
      });
      const parsed = parseJsonObject(response);
      return normalizeReviewJson(parsed, sessionId);
    } catch {
      return {
        target_task_id: "coding_loop",
        reviewer: { agent_id: "reviewer", role: "reviewer" },
        verdict: tool.status === "failed" ? "reject" : "needs_revision",
        score: tool.status === "failed" ? 0 : 70,
        issues: tool.status === "failed" ? [{ severity: "high", message: tool.summary }] : undefined,
        summary: tool.summary
      };
    }
  }

  private writeBlackboardEvidence(
    sessionId: string,
    input: {
      key: string;
      type: BlackboardEntry["type"];
      value: unknown;
      tags: string[];
      created_by: BlackboardEntry["created_by"];
      task_id?: string;
    }
  ): BlackboardEntry {
    const row = this.sessionStore.get(sessionId);
    const entry = this.blackboardStore.write({
      swarm_id: row?.swarm_id ?? `swarm_${sessionId}`,
      session_id: sessionId,
      task_id: input.task_id,
      key: input.key,
      type: input.type,
      value: input.value,
      created_by: input.created_by,
      tags: input.tags
    });
    this.events.emitEvent({ type: "blackboard", entry });
    return entry;
  }

  private async decideAgentSpawn(request: AgentInvocationRequest): Promise<AgentSpawnDecision> {
    try {
      const response = await this.provider.generateText({
        model: this.provider.workerModel,
        system: [
          "You are the main Swarm controller deciding how to dispatch an internal agent request.",
          "The user only talks to the main Swarm. Subagents and handoffs are internal implementation details.",
          "Choose the best agent persona and invocation mode using the available specs.",
          "Return exactly one JSON object with keys: agent_spec_id, invocation_mode, reason, confidence.",
          "invocation_mode must be one of: call_subagent, handoff, parallel.",
          "Use handoff only when a focused specialist should own a segment across multiple tool turns.",
          "Use call_subagent for bounded research, review, implementation, or verification whose result returns to main Swarm.",
          "Use parallel only when the request describes independent side work that can run concurrently with other internal work; if concurrency is not actually available at this call site, it will be executed as a bounded subagent call.",
          "Prefer read_only agents for exploration, review, critique, and verification.",
          "Choose scoped_write or workspace_write agents only when the task genuinely requires edits and the request includes an appropriate file_scope or the task is explicitly self-improvement.",
          "Do not escalate a read-only request to a writer agent just because the target capability is vague.",
          "Respect preferred_agent_spec_id or preferred_mode when it is appropriate, but explain the choice.",
          "Do not include Markdown fences or prose outside JSON."
        ].join(" "),
        user: JSON.stringify({
          request,
          available_agent_specs: listAgentSpecs().map((spec) => ({
            id: spec.id,
            role: spec.role,
            description: spec.description,
            when_to_use: spec.when_to_use,
            capabilities: spec.capabilities,
            write_policy: spec.write_policy,
            budget: spec.default_budget,
            output_contract: spec.output_contract
          }))
        }, null, 2)
      });
      return normalizeAgentSpawnDecision(parseJsonObject(response), request);
    } catch (error) {
      const preferred = request.preferred_agent_spec_id && getAgentSpec(request.preferred_agent_spec_id)
        ? request.preferred_agent_spec_id
        : "researcher";
      return {
        agent_spec_id: preferred,
        invocation_mode: request.preferred_mode ?? "call_subagent",
        reason: `LLM dispatch decision failed; using fallback spec ${preferred}: ${error instanceof Error ? error.message : String(error)}`,
        confidence: 0
      };
    }
  }

  private handleInterrupt(content: string): void {
    if (this.activeCodingLoop) {
      this.activeCodingLoop.requestInterrupt(content);
      return;
    }
    this.events.emitEvent({ type: "log", level: "warn", message: "No active coding loop to interrupt." });
  }

  private async decideLiveControl(content: string, session: SwarmSession): Promise<{
    action: "continue_current" | "inject_next_turn" | "interrupt_and_redirect" | "ask_clarification";
    reason: string;
    instruction: string;
  }> {
    const response = await this.provider.generateText({
      model: this.provider.workerModel,
      system: [
        "You are Swarm's live control plane for a full swarm run.",
        "The user is always talking to the main Swarm. Decide how the active swarm should incorporate this message.",
        "Return exactly one JSON object with keys: action, reason, instruction.",
        "action must be one of: continue_current, inject_next_turn, interrupt_and_redirect, ask_clarification.",
        "Do not include Markdown fences or prose outside JSON."
      ].join(" "),
      user: JSON.stringify({
        objective: session.objective,
        session_status: session.status,
        active_handoffs: this.handoffStore.listRecent(20).filter((item) => item.parent_session_id === session.session_id && item.status === "active"),
        live_message: content
      }, null, 2)
    });
    const parsed = parseJsonObject(response);
    const action = parsed.action === "continue_current" ||
      parsed.action === "inject_next_turn" ||
      parsed.action === "interrupt_and_redirect" ||
      parsed.action === "ask_clarification"
      ? parsed.action
      : "inject_next_turn";
    return {
      action,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 500) : "Swarm control decision.",
      instruction: typeof parsed.instruction === "string" && parsed.instruction.trim() ? parsed.instruction.trim() : content
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const child of this.children) {
      child.removeAllListeners("message");
      child.kill();
    }
    this.database.close();
  }

  private spawnBuiltins(workspace: string): void {
    const childEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../agents/child-entry.js");
    for (const card of builtinAgents) {
      this.spawnAgent(card, childEntry, workspace);
    }
  }

  private spawnAgent(card: AgentCard, childEntry: string, workspace: string): void {
    const child = fork(childEntry, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        SWARM_AGENT_SPEC: JSON.stringify(card),
        SWARM_WORKSPACE: workspace,
        SWARM_DEBUG: process.env.SWARM_DEBUG ?? "",
        SWARM_DEBUG_LEVEL: process.env.SWARM_DEBUG_LEVEL ?? "",
        SWARM_DEBUG_SESSION_ID: this.debugSessionId ?? ""
      }
    });

    child.on("message", (message: unknown) => {
      if (this.disposed) {
        return;
      }
      const envelope = message as SwarmEnvelope;
      if (isChildDispatchedEnvelope(envelope)) {
        this.router.dispatch(envelope).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.events.emitEvent({ type: "error", message: reason });
          child.send(
            createEnvelope({
              swarm_id: envelope.swarm_id,
              session_id: envelope.session_id,
              task_id: envelope.task_id,
              from: { agent_id: "runtime", role: "router" },
              to: envelope.from,
              type: "error",
              intent: "router.dispatch_failed",
              payload: {
                error_code: "CAPABILITY_NOT_FOUND",
                message: reason,
                retryable: false,
                failed_task_id: envelope.task_id,
                recovery_suggestion: "abort_swarm"
              },
              correlation_id: envelope.correlation_id ?? envelope.id,
              reply_to: envelope.id
            })
          );
        });
        return;
      }

      this.router.receive(envelope);
      this.forwardToAddressedAgent(envelope);
    });
    child.on("exit", (code) => {
      this.registry.updateStatus(card.agent_id, "offline");
      this.events.emitEvent({
        type: "log",
        level: code === 0 ? "info" : "warn",
        message: `${card.agent_id} exited with code ${code ?? "unknown"}`
      });
    });
    child.on("error", (error) => {
      this.registry.updateStatus(card.agent_id, "degraded");
      this.events.emitEvent({ type: "error", message: `${card.agent_id}: ${error.message}` });
    });

    this.children.push(child);
    this.registry.register({ ...card, status: "idle", load: { ...card.load, running_tasks: 0 } }, child);
  }

  private forwardToAddressedAgent(envelope: SwarmEnvelope): void {
    const addresses = Array.isArray(envelope.to) ? envelope.to : [envelope.to];
    for (const address of addresses) {
      if (!address.agent_id || address.agent_id === "orchestrator") {
        continue;
      }
      const target = this.registry.get(address.agent_id);
      target?.process?.send(envelope);
    }
  }
}

function buildAgentTaskPacket(
  request: AgentInvocationRequest,
  spec: AgentSpec,
  decision: AgentSpawnDecision
): AgentTaskPacket {
  return {
    objective: request.task,
    agent_spec_id: spec.id,
    invocation_mode: decision.invocation_mode,
    persona_snapshot: spec.prompt,
    relevant_context: request.context,
    file_scope: request.file_scope ?? [],
    allowed_tools: spec.tools,
    write_policy: spec.write_policy,
    budget: spec.default_budget,
    expected_output: spec.output_contract,
    return_conditions: [
      "The delegated objective is complete.",
      "The task is blocked and the blocker is clearly explained.",
      "The tool or turn budget is exhausted.",
      "The main Swarm takes back the handoff."
    ]
  };
}

function renderAgentRuntimeInstructions(
  spec: AgentSpec,
  decision: AgentSpawnDecision,
  taskPacket: AgentTaskPacket
): string {
  return [
    spec.prompt,
    "",
    `Agent spec: ${spec.id} (${spec.role}).`,
    `Invocation mode: ${decision.invocation_mode}.`,
    `Dispatch reason: ${decision.reason}`,
    `Expected output: ${spec.output_contract}`,
    `Write policy: ${spec.write_policy}.`,
    taskPacket.file_scope.length
      ? `File scope: ${taskPacket.file_scope.join(", ")}. Stay inside this write scope unless the main Swarm explicitly expands it.`
      : "File scope is not predeclared. Read broadly as needed, but keep writes tightly connected to the delegated objective.",
    "You are an internal specialist. The main Swarm owns user-facing synthesis, interruption handling, and final responsibility."
  ].join("\n");
}

function renderAgentTaskPrompt(taskPacket: AgentTaskPacket, decision: AgentSpawnDecision): string {
  return [
    "Execute this internal Swarm agent task packet.",
    decision.invocation_mode === "handoff"
      ? "This is a handoff: own the focused task segment until done, blocked, or taken back by main Swarm."
      : "This is a subagent call: complete the bounded task and return evidence to main Swarm.",
    "Do not address the user directly.",
    "Return concrete evidence, changed files, checks, risks, and unresolved questions according to the output contract.",
    "",
    JSON.stringify(taskPacket, null, 2)
  ].join("\n");
}

function normalizeAgentSpawnDecision(parsed: Record<string, unknown>, request: AgentInvocationRequest): AgentSpawnDecision {
  const parsedSpecId = typeof parsed.agent_spec_id === "string" ? parsed.agent_spec_id.trim() : "";
  const preferredSpecId = request.preferred_agent_spec_id && getAgentSpec(request.preferred_agent_spec_id)
    ? request.preferred_agent_spec_id
    : "";
  let agentSpecId = getAgentSpec(parsedSpecId)
    ? parsedSpecId
    : preferredSpecId || "researcher";
  const selectedSpec = getAgentSpec(agentSpecId);
  let policyAdjustment: string | undefined;
  if (
    selectedSpec?.write_policy === "scoped_write" &&
    !request.file_scope?.length &&
    request.capability !== "code.edit" &&
    request.capability !== "code.implement" &&
    request.capability !== "bug.fix"
  ) {
    policyAdjustment = `Policy adjusted ${agentSpecId} to researcher because scoped_write requires a file_scope for this capability.`;
    agentSpecId = "researcher";
  }

  const parsedMode = typeof parsed.invocation_mode === "string" ? parsed.invocation_mode.trim() : "";
  const invocationMode = isAgentInvocationMode(parsedMode)
    ? parsedMode
    : request.preferred_mode ?? "call_subagent";

  const confidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 800)
    : "Main Swarm selected an internal agent based on the delegated task packet.";
  return {
    agent_spec_id: agentSpecId,
    invocation_mode: invocationMode,
    reason: policyAdjustment ? `${policyAdjustment} ${reason}` : reason,
    confidence
  };
}

function normalizeAttemptStatus(status: "started" | "completed" | "failed"): RunAttemptStatus {
  return status === "started" ? "started" : status === "failed" ? "failed" : "completed";
}

function isAgentInvocationMode(value: string): value is AgentInvocationMode {
  return value === "call_subagent" || value === "handoff" || value === "parallel";
}

function normalizeReviewJson(parsed: Record<string, unknown>, sessionId: string): ReviewResult {
  const verdict = parsed.verdict === "approve" || parsed.verdict === "reject" || parsed.verdict === "needs_revision"
    ? parsed.verdict
    : "needs_revision";
  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score)
    ? Math.max(0, Math.min(100, parsed.score))
    : verdict === "approve" ? 85 : verdict === "reject" ? 20 : 60;
  const reviewer = isRecord(parsed.reviewer) ? parsed.reviewer : {};
  return {
    target_task_id: typeof parsed.target_task_id === "string" ? parsed.target_task_id : "coding_loop",
    reviewer: {
      agent_id: typeof reviewer.agent_id === "string" ? reviewer.agent_id : "reviewer",
      role: typeof reviewer.role === "string" ? reviewer.role : "reviewer"
    },
    verdict,
    score,
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.filter(isRecord).map((issue) => ({
          severity: issue.severity === "high" || issue.severity === "medium" || issue.severity === "low" ? issue.severity : "medium",
          task_id: typeof issue.task_id === "string" ? issue.task_id : undefined,
          message: typeof issue.message === "string" ? issue.message : JSON.stringify(issue),
          evidence: typeof issue.evidence === "string" ? issue.evidence : undefined,
          suggested_fix: typeof issue.suggested_fix === "string" ? issue.suggested_fix : undefined
        }))
      : undefined,
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : `Review completed for ${sessionId}.`
  };
}

function createLocalPolicy(settings: SwarmSettings): SwarmPolicy {
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

function riskClassForActionName(action: string): "r0" | "r1" | "r2" | "r3" | "r4" {
  try {
    return riskClassForAction(normalizeToolAction({ action }));
  } catch {
    if (action.startsWith("file.write") || action.startsWith("file.edit")) return "r1";
    if (action.includes("shell") || action.includes("package") || action.includes("fetch")) return "r2";
    return "r0";
  }
}

function blackboardEntryMatches(entry: BlackboardEntry, query: { type?: BlackboardEntry["type"]; tag?: string; keyPrefix?: string; taskId?: string; agentId?: string }): boolean {
  if (query.type && entry.type !== query.type) return false;
  if (query.taskId && entry.task_id !== query.taskId) return false;
  if (query.keyPrefix && !entry.key.startsWith(query.keyPrefix)) return false;
  if (query.tag && !(entry.tags ?? []).includes(query.tag)) return false;
  if (query.agentId && entry.created_by.agent_id !== query.agentId) return false;
  return true;
}

function sanitizeKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/[^A-Za-z0-9._/-]+/g, "_").replace(/\//g, ".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort();
}

function isChildDispatchedEnvelope(envelope: SwarmEnvelope): boolean {
  return envelope.type === "task.assign" || envelope.type === "review.request";
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 240) ?? "";
}
