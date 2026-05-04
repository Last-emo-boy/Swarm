import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentCard, SwarmEnvelope, SwarmSession } from "../protocol/types.js";
import { createEnvelope } from "../protocol/envelope.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { SessionStore } from "../storage/session-store.js";
import { TaskStateStore } from "../storage/task-state-store.js";
import { TraceStore } from "../storage/trace-store.js";
import { WorkerStateStore } from "../storage/worker-state-store.js";
import { HandoffStore } from "../storage/handoff-store.js";
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
import type { ToolResult } from "../tools/types.js";
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
  readonly settings: SwarmSettings;
  readonly debug: DebugLogger | null;
  readonly debugSessionId?: string;
  private readonly provider: OpenAIProvider;
  private readonly workspace: string;
  private readonly approvalHandler?: ToolApprovalHandler;
  private readonly controller: SwarmController;
  private activeCodingLoop?: CodingAgentLoop;
  private activeSwarmSession?: SwarmSession;
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
    const artifactStore = new ArtifactStore(this.database);
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
            outputRef: event.outputRef
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
          this.debug?.debug("controller", `${event.action}: ${event.reason}`, { confidence: event.confidence, instruction: event.instruction });
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

  createPlan(objective: string): Promise<PlannedSession> {
    return this.orchestrator.createPlan(objective);
  }

  execute(planned: PlannedSession): Promise<ExecutionResult> {
    return this.orchestrator.execute(planned);
  }

  async run(objective: string, options: RunOptions = {}): Promise<ExecutionResult> {
    return this.controller.run(objective, options);
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
        return await this.execute(planned);
      } finally {
        if (this.activeSwarmSession?.session_id === planned.session.session_id) {
          this.activeSwarmSession = undefined;
        }
      }
    }
    if (route.mode === "chat") {
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
        session_id: `chat_${Date.now()}`,
        content,
        outcome: {
          changed_files: [],
          intermediate_artifacts: [],
          tests_run: [],
          final_summary: content.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "Completed"
        }
      } satisfies ExecutionResult;
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
      invokeAgent: (request) => this.invokeAgent(request)
    });
    this.activeCodingLoop = loop;
    try {
      return await loop.run(objective);
    } finally {
      if (this.activeCodingLoop === loop) {
        this.activeCodingLoop = undefined;
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

  private async invokeAgent(request: AgentInvocationRequest): Promise<ToolResult> {
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
      workspace: this.workspace,
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
      writePolicy: taskPacket.write_policy
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
          "Use parallel when independent side work can run concurrently with other internal work.",
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
  const agentSpecId = getAgentSpec(parsedSpecId)
    ? parsedSpecId
    : preferredSpecId || "researcher";

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
    reason,
    confidence
  };
}

function isAgentInvocationMode(value: string): value is AgentInvocationMode {
  return value === "call_subagent" || value === "handoff" || value === "parallel";
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
