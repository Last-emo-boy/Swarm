import { fork, type ChildProcess } from "node:child_process";
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

export class SwarmRuntime {
  readonly events = new RuntimeEvents();
  readonly database: SwarmDatabase;
  readonly registry: AgentRegistry;
  readonly router: EnvelopeRouter;
  readonly orchestrator: Orchestrator;
  readonly sessionStore: SessionStore;
  readonly taskStateStore: TaskStateStore;
  readonly traceStore: TraceStore;
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
      approvalHandler: this.approvalHandler
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
