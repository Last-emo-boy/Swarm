import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentCard, SwarmEnvelope } from "../protocol/types.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { BlackboardStore } from "../storage/blackboard-store.js";
import { SwarmDatabase } from "../storage/database.js";
import { SessionStore } from "../storage/session-store.js";
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

export class SwarmRuntime {
  readonly events = new RuntimeEvents();
  readonly database: SwarmDatabase;
  readonly registry: AgentRegistry;
  readonly router: EnvelopeRouter;
  readonly orchestrator: Orchestrator;
  readonly sessionStore: SessionStore;
  readonly settings: SwarmSettings;
  readonly debug: DebugLogger | null;
  private readonly children: ChildProcess[] = [];
  private disposed = false;

  constructor(options: { databasePath?: string; workspace?: string; approvalHandler?: ToolApprovalHandler } = {}) {
    ensureSwarmHome();
    const workspace = options.workspace ?? process.cwd();
    this.settings = loadSwarmSettings(workspace);
    this.debug = getDebugLogger(getSwarmPaths().logsDir);
    this.debug?.info("runtime", `SwarmRuntime init. workspace=${workspace} pid=${process.pid}`);
    this.database = new SwarmDatabase(options.databasePath ?? this.settings.runtime.databasePath);
    const traceStore = new TraceStore(this.database);
    const sessionStore = new SessionStore(this.database);
    this.sessionStore = sessionStore;
    const blackboardStore = new BlackboardStore(this.database);
    const artifactStore = new ArtifactStore(this.database);
    this.registry = new AgentRegistry(this.events);
    this.router = new EnvelopeRouter(this.registry, traceStore, this.events);
    const provider = new OpenAIProvider();
    this.orchestrator = new Orchestrator(
      this.router,
      sessionStore,
      blackboardStore,
      artifactStore,
      new PlanGenerator(provider),
      this.events,
      this.settings,
      workspace,
      options.approvalHandler
    );
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
        } else if (event.type === "log") {
          this.debug?.log(event.level, "runtime", event.message);
        } else if (event.type === "plan") {
          this.debug?.debug("plan", `session=${event.plan.objective.slice(0, 80)}, ${event.plan.tasks.length} tasks`);
        } else if (event.type === "blackboard") {
          this.debug?.debug("blackboard", `${event.entry.type} ${event.entry.key}`);
        } else if (event.type === "final") {
          this.debug?.info("final", `session=${event.session_id} artifact=${event.artifact_path ?? "none"}`);
        } else if (event.type === "error") {
          this.debug?.error("runtime", event.message);
        } else if (event.type === "agent") {
          this.debug?.debug("agent", `${event.card.agent_id} (${event.card.role})`);
        } else if (event.type === "approval") {
          this.debug?.debug("approval", `${event.status} ${event.request.summary}`);
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

  dispose(): void {
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
        SWARM_DEBUG_LEVEL: process.env.SWARM_DEBUG_LEVEL ?? ""
      }
    });

    child.on("message", (message: unknown) => {
      if (this.disposed) {
        return;
      }
      this.router.receive(message as SwarmEnvelope);
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
}
