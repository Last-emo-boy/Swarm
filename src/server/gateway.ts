import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { SwarmSession } from "../protocol/types.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { ExecutionResult, PlannedSession, ToolApprovalHandler } from "../runtime/orchestrator.js";
import type { RunMode } from "../runtime/execution-router.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import type { SymphonyScheduler } from "../symphony/scheduler.js";
import { SymphonyDaemonManager } from "../symphony/daemon.js";
import type { CapabilityFilter } from "../extensions/types.js";

export type GatewayOptions = {
  host?: string;
  port?: number;
  workspace?: string;
  databasePath?: string;
};

type GatewayRunStatus = "starting" | "running" | "completed" | "failed";

type GatewayRun = {
  run_id: string;
  session_id?: string;
  objective: string;
  mode: RunMode;
  status: GatewayRunStatus;
  error?: string;
  result?: ExecutionResult;
  created_at: string;
  updated_at: string;
};

type PendingApproval = {
  request: ToolApprovalRequest;
  resolve: (approved: boolean) => void;
  created_at: string;
};

type SseClient = {
  id: string;
  sessionId?: string;
  response: ServerResponse;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 38171;
const MAX_BODY_BYTES = 1_000_000;
const EVENT_BUFFER_LIMIT = 500;
const PUBLIC_API_SURFACE = [
  "/",
  "/health",
  "/v1/sessions",
  "/v1/runs",
  "/v1/events",
  "/v1/sessions/:id/events",
  "/v1/approvals",
  "/v1/approvals/:id/decision",
  "/v1/workers",
  "/v1/handoffs",
  "/v1/capabilities",
  "/v1/capabilities/:id",
  "/v1/capabilities/refresh",
  "/v1/skills",
  "/v1/skills/:name/activate",
  "/v1/symphony/preview",
  "/v1/symphony/tick",
  "/v1/symphony/status",
  "/v1/symphony/cleanup",
  "/v1/symphony/daemon",
  "/v1/symphony/daemon/start",
  "/v1/symphony/daemon/stop"
] as const;

export class SwarmGatewayServer {
  readonly runtime: SwarmRuntime;
  private readonly server: Server;
  private readonly runs = new Map<string, GatewayRun>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly clients = new Map<string, SseClient>();
  private readonly symphonySchedulers = new Map<string, SymphonyScheduler>();
  private readonly symphonyDaemons: SymphonyDaemonManager;
  private readonly eventBuffer: { id: number; event: RuntimeEvent }[] = [];
  private nextEventId = 1;
  private listening = false;

  constructor(private readonly options: GatewayOptions = {}) {
    const approvalHandler: ToolApprovalHandler = (request) => this.waitForApproval(request);
    this.runtime = new SwarmRuntime({
      workspace: options.workspace,
      databasePath: options.databasePath,
      approvalHandler
    });
    this.symphonyDaemons = new SymphonyDaemonManager(this.runtime);
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.runtime.events.onEvent((event) => this.recordAndBroadcast(event));
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.listening) {
      const address = this.server.address();
      const port = typeof address === "object" && address ? address.port : this.port;
      return { host: this.host, port, url: `http://${this.host}:${port}` };
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    this.listening = true;
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.port;
    return { host: this.host, port, url: `http://${this.host}:${port}` };
  }

  async stop(): Promise<void> {
    await this.symphonyDaemons.stopAll("gateway_shutdown", true);
    for (const client of this.clients.values()) {
      client.response.end();
    }
    this.clients.clear();
    this.runtime.dispose();
    if (!this.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    this.listening = false;
  }

  private get host(): string {
    return this.options.host ?? process.env.SWARM_GATEWAY_HOST ?? DEFAULT_HOST;
  }

  private get port(): number {
    const raw = this.options.port ?? Number(process.env.SWARM_GATEWAY_PORT ?? DEFAULT_PORT);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PORT;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCommonHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (request.method === "GET" && url.pathname === "/") {
        sendJson(response, 200, gatewayIndex());
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "swarm-gateway", routes: PUBLIC_API_SURFACE });
        return;
      }

      if (request.method === "GET" && segments[0] === "v1" && segments[1] === "events") {
        this.openEventStream(response);
        return;
      }

      if (segments[0] !== "v1") {
        throw new HttpError(404, "Unknown route.");
      }

      await this.handleV1(request, response, url, segments.slice(1));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, status, { error: { message, status } });
    }
  }

  private async handleV1(request: IncomingMessage, response: ServerResponse, url: URL, segments: string[]): Promise<void> {
    const [resource, id, child, childId] = segments;

    if (resource === "runs") {
      if (request.method === "GET" && !id) {
        sendJson(response, 200, { runs: [...this.runs.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) });
        return;
      }
      if (request.method === "GET" && id) {
        sendJson(response, 200, requireRun(this.runs, id));
        return;
      }
    }

    if (resource === "sessions") {
      await this.handleSessions(request, response, url, id, child, childId);
      return;
    }

    if (resource === "approvals") {
      await this.handleApprovals(request, response, id, child);
      return;
    }

    if (resource === "workers") {
      await this.handleWorkers(request, response, url, id, child);
      return;
    }

    if (resource === "handoffs") {
      await this.handleHandoffs(request, response, id, child);
      return;
    }

    if (resource === "capabilities") {
      await this.handleCapabilities(request, response, url, id);
      return;
    }

    if (resource === "skills") {
      await this.handleSkills(request, response, id, child);
      return;
    }

    if (resource === "symphony") {
      await this.handleSymphony(request, response, url, id, child);
      return;
    }

    throw new HttpError(404, "Unknown v1 route.");
  }

  private async handleSymphony(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    action?: string,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && (!action || action === "status")) {
      const { getSymphonyStatus } = await import("../symphony/status.js");
      const result = getSymphonyStatus({
        runtime: this.runtime,
        workflowPath: optionalString(url.searchParams.get("workflow_path") ?? url.searchParams.get("workflow")),
        limit: integerParam(url, "limit", 100)
      });
      if (!result.workflow.ok) {
        throw new HttpError(400, `${result.workflow.error.code}: ${result.workflow.error.message}`);
      }
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && action === "cleanup") {
      const body = await readJsonBody(request);
      const { cleanupSymphonyWorkspaces } = await import("../symphony/cleanup.js");
      const result = await cleanupSymphonyWorkspaces({
        runtime: this.runtime,
        workflowPath: optionalString(body.workflow_path),
        execute: body.execute === true,
        limit: positiveBodyInteger(body.limit)
      });
      if (!result.workflow.ok) {
        throw new HttpError(400, `${result.workflow.error.code}: ${result.workflow.error.message}`);
      }
      sendJson(response, result.execute ? 202 : 200, result);
      return;
    }

    if (request.method === "POST" && (action === "tick" || action === "run-once")) {
      const body = await readJsonBody(request);
      const scheduler = await this.getSymphonyScheduler({
        workflowPath: optionalString(body.workflow_path),
        createWorkspace: body.create_workspace !== false,
        execute: action === "run-once" || body.execute === true,
        maxRunnerTurns: positiveBodyInteger(body.max_runner_turns ?? body.max_turns),
        maxRunnerToolCalls: positiveBodyInteger(body.max_runner_tool_calls ?? body.max_tool_calls)
      });
      const result = await scheduler.tick();
      if (!result.workflow.ok) {
        throw new HttpError(400, `${result.workflow.error.code}: ${result.workflow.error.message}`);
      }
      sendJson(response, 202, {
        workflow: result.workflow.workflow,
        candidates: result.candidates,
        dispatched: result.dispatched.map((item) => ({
          status: item.status,
          reason: item.reason,
          work_item: item.work_item,
          session: item.session ? sessionSnapshot(this.runtime, item.session.session_id) : undefined,
          workspace_path: item.workspace_path,
          prompt: item.prompt,
          attempt: item.attempt
        })),
        skipped: result.skipped,
        failed: result.failed,
        preflight: result.preflight,
        runs: result.runs,
        scheduler: result.snapshot
      });
      return;
    }

    if (request.method === "POST" && action === "preview") {
      const body = await readJsonBody(request);
      const { createSymphonyPreview } = await import("../symphony/preview.js");
      const result = await createSymphonyPreview({
        runtime: this.runtime,
        workflowPath: optionalString(body.workflow_path),
        createWorkspace: body.create_workspace !== false
      });
      if (!result.workflow.ok) {
        throw new HttpError(400, `${result.workflow.error.code}: ${result.workflow.error.message}`);
      }
      sendJson(response, 201, {
        workflow: result.workflow.workflow,
        items: result.items,
        sessions: result.sessions.map((item) => ({
          session: sessionSnapshot(this.runtime, item.session.session_id),
          workspace_path: item.workspace_path,
          prompt: item.prompt
        }))
      });
      return;
    }

    if (action === "daemon") {
      await this.handleSymphonyDaemon(request, response, url, child);
      return;
    }

    throw new HttpError(404, "Unknown symphony route.");
  }

  private async handleCapabilities(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    capabilityId?: string
  ): Promise<void> {
    if (request.method === "GET" && !capabilityId) {
      const filter = capabilityFilterFromUrl(url);
      const [capabilities, providers] = await Promise.all([
        this.runtime.listCapabilities(filter),
        this.runtime.listCapabilityProviders()
      ]);
      sendJson(response, 200, { capabilities, providers });
      return;
    }

    if (request.method === "GET" && capabilityId) {
      const capability = await this.runtime.getCapability(capabilityId);
      if (!capability) {
        throw new HttpError(404, `Unknown capability: ${capabilityId}`);
      }
      sendJson(response, 200, { capability });
      return;
    }

    if (request.method === "POST" && capabilityId === "refresh") {
      const body = await readJsonBody(request);
      const providerId = optionalString(body.provider_id ?? body.providerId ?? url.searchParams.get("provider_id") ?? url.searchParams.get("provider"));
      const providers = await this.runtime.refreshCapabilities(providerId);
      const capabilities = await this.runtime.listCapabilities(capabilityFilterFromUrl(url));
      sendJson(response, 200, { providers, capabilities });
      return;
    }

    throw new HttpError(404, "Unknown capabilities route.");
  }

  private async handleSkills(
    request: IncomingMessage,
    response: ServerResponse,
    skillName?: string,
    action?: string
  ): Promise<void> {
    if (request.method === "GET" && !skillName) {
      sendJson(response, 200, { skills: this.runtime.listSkills() });
      return;
    }

    if (request.method === "GET" && skillName) {
      const skill = this.runtime.listSkills().find((item) => item.name === skillName && !item.shadowedBy);
      if (!skill) {
        throw new HttpError(404, `Unknown skill: ${skillName}`);
      }
      sendJson(response, 200, { skill });
      return;
    }

    if (request.method === "POST" && skillName && action === "activate") {
      const body = await readJsonBody(request);
      const skill = this.runtime.activateSkill(
        skillName,
        optionalString(body.session_id ?? body.sessionId),
        optionalString(body.reason)
      );
      sendJson(response, 200, { skill });
      return;
    }

    throw new HttpError(404, "Unknown skills route.");
  }

  private async handleSymphonyDaemon(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    action?: string
  ): Promise<void> {
    if (request.method === "GET" && !action) {
      const daemonId = optionalString(url.searchParams.get("daemon_id") ?? url.searchParams.get("id"));
      sendJson(response, 200, daemonId
        ? { daemon: this.requireSymphonyDaemonRecord(daemonId) }
        : { daemons: this.symphonyDaemons.listRecords() });
      return;
    }

    if (request.method === "POST" && action === "start") {
      const body = await readJsonBody(request);
      const result = await this.symphonyDaemons.start({
        workflowPath: optionalString(body.workflow_path),
        createWorkspace: body.create_workspace !== false,
        execute: body.execute === true,
        maxRunnerTurns: positiveBodyInteger(body.max_runner_turns ?? body.max_turns),
        maxRunnerToolCalls: positiveBodyInteger(body.max_runner_tool_calls ?? body.max_tool_calls),
        maxTicks: positiveBodyInteger(body.max_ticks)
      });
      if (!result.ok) {
        throw new HttpError(400, `${result.error.code}: ${result.error.message}`);
      }
      sendJson(response, result.created ? 202 : 200, { daemon: result.daemon });
      return;
    }

    if (request.method === "POST" && action === "stop") {
      const body = await readJsonBody(request);
      const daemonId = optionalString(body.daemon_id) ?? optionalString(url.searchParams.get("daemon_id") ?? url.searchParams.get("id"));
      const stopped = this.symphonyDaemons.requestStop({
        daemonId,
        reason: optionalString(body.reason) ?? "operator_stop",
        cancelRunning: body.cancel_running === true
      });
      sendJson(response, 202, { daemons: stopped });
      return;
    }

    throw new HttpError(404, "Unknown symphony daemon route.");
  }

  private async getSymphonyScheduler(input: {
    workflowPath?: string;
    createWorkspace?: boolean;
    execute?: boolean;
    maxRunnerTurns?: number;
    maxRunnerToolCalls?: number;
  }): Promise<SymphonyScheduler> {
    const key = JSON.stringify({
      workflowPath: input.workflowPath ?? "WORKFLOW.md",
      createWorkspace: input.createWorkspace !== false,
      execute: input.execute === true,
      maxRunnerTurns: input.maxRunnerTurns,
      maxRunnerToolCalls: input.maxRunnerToolCalls
    });
    const existing = this.symphonySchedulers.get(key);
    if (existing) {
      return existing;
    }
    const { SymphonyScheduler } = await import("../symphony/scheduler.js");
    const scheduler = new SymphonyScheduler({
      runtime: this.runtime,
      workflowPath: input.workflowPath,
      createWorkspace: input.createWorkspace !== false,
      execute: input.execute === true,
      maxRunnerTurns: input.maxRunnerTurns,
      maxRunnerToolCalls: input.maxRunnerToolCalls
    });
    this.symphonySchedulers.set(key, scheduler);
    return scheduler;
  }

  private requireSymphonyDaemonRecord(daemonId: string): unknown {
    const daemon = this.symphonyDaemons.getRecord(daemonId);
    if (!daemon) {
      throw new HttpError(404, `Unknown Symphony daemon: ${daemonId}`);
    }
    return daemon;
  }

  private async handleSessions(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    sessionId?: string,
    child?: string,
    childId?: string
  ): Promise<void> {
    if (request.method === "GET" && !sessionId) {
      const limit = integerParam(url, "limit", 25);
      sendJson(response, 200, { sessions: this.runtime.sessionStore.listRecent(limit) });
      return;
    }

    if (request.method === "POST" && !sessionId) {
      const body = await readJsonBody(request);
      const objective = stringField(body, "objective");
      const mode = runModeField(body.mode);
      const execute = body.execute !== false && body.plan_only !== true;
      if (!execute || mode === "full_swarm") {
        const planned = await this.runtime.createPlan(objective);
        if (execute) {
          const run = this.startPlannedExecution(planned);
          sendJson(response, 202, { run, session: sessionSnapshot(this.runtime, planned.session.session_id), plan: planned.plan });
        } else {
          sendJson(response, 201, { session: sessionSnapshot(this.runtime, planned.session.session_id), plan: planned.plan });
        }
        return;
      }

      const run = await this.startRuntimeRun(objective, mode);
      sendJson(response, 202, { run, session: run.session_id ? sessionSnapshot(this.runtime, run.session_id) : undefined });
      return;
    }

    if (!sessionId) {
      throw new HttpError(404, "Session id is required.");
    }

    if (request.method === "GET" && !child) {
      sendJson(response, 200, sessionSnapshot(this.runtime, sessionId));
      return;
    }

    if (request.method === "GET" && child === "events") {
      this.openEventStream(response, sessionId);
      return;
    }

    if (request.method === "POST" && child === "messages") {
      const body = await readJsonBody(request);
      await this.runtime.sendUserMessage(stringField(body, "content"));
      sendJson(response, 202, { status: "queued", session_id: sessionId });
      return;
    }

    if (request.method === "POST" && child === "interrupt") {
      const body = await readJsonBody(request);
      this.runtime.interrupt(optionalString(body.content) ?? "User requested an interrupt through the Swarm Gateway.");
      sendJson(response, 202, { status: "interrupt_queued", session_id: sessionId });
      return;
    }

    if (request.method === "POST" && child === "execute") {
      const planned = plannedSessionFromStore(this.runtime, sessionId);
      sendJson(response, 202, { run: this.startPlannedExecution(planned), session: sessionSnapshot(this.runtime, sessionId) });
      return;
    }

    if (request.method === "POST" && child === "fork") {
      const body = await readJsonBody(request);
      const planned = await this.runtime.forkSession(sessionId, optionalString(body.message));
      sendJson(response, 201, { session: sessionSnapshot(this.runtime, planned.session.session_id), plan: planned.plan });
      return;
    }

    if (request.method === "GET" && child === "replay") {
      sendJson(response, 200, { session_id: sessionId, replay: this.runtime.replaySession(sessionId) });
      return;
    }

    if (request.method === "GET" && child === "graph") {
      sendJson(response, 200, this.runtime.getTaskGraph(sessionId));
      return;
    }

    if (request.method === "GET" && child === "tasks" && childId) {
      sendJson(response, 200, this.runtime.getTaskDetail(sessionId, childId));
      return;
    }

    if (request.method === "GET" && child === "trace") {
      sendJson(response, 200, { session_id: sessionId, trace: this.runtime.traceStore.list(sessionId) });
      return;
    }

    if (request.method === "GET" && child === "blackboard") {
      sendJson(response, 200, { session_id: sessionId, entries: this.runtime.listBlackboardEntries(sessionId) });
      return;
    }

    if (request.method === "GET" && child === "approvals") {
      sendJson(response, 200, { session_id: sessionId, approvals: this.runtime.approvalStore.list(sessionId, integerParam(url, "limit", 80)) });
      return;
    }

    if (request.method === "GET" && child === "audit") {
      sendJson(response, 200, { session_id: sessionId, audit: this.runtime.auditStore.list(sessionId, integerParam(url, "limit", 100)) });
      return;
    }

    if (request.method === "GET" && child === "usage") {
      sendJson(response, 200, {
        session_id: sessionId,
        usage: this.runtime.usageStore.list(sessionId, integerParam(url, "limit", 100)),
        summary: this.runtime.usageStore.summarize(sessionId)
      });
      return;
    }

    throw new HttpError(404, "Unknown session route.");
  }

  private async handleApprovals(
    request: IncomingMessage,
    response: ServerResponse,
    approvalId?: string,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && !approvalId) {
      sendJson(response, 200, {
        pending: [...this.pendingApprovals.values()].map((item) => item.request),
        approvals: this.runtime.approvalStore.list(undefined, 100)
      });
      return;
    }

    if (!approvalId) {
      throw new HttpError(404, "Approval id is required.");
    }

    if (request.method === "GET" && !child) {
      const approval = this.runtime.approvalStore.get(approvalId);
      if (!approval) {
        throw new HttpError(404, `Unknown approval: ${approvalId}`);
      }
      sendJson(response, 200, approval);
      return;
    }

    if (request.method === "POST" && child === "decision") {
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) {
        throw new HttpError(409, `Approval is not pending in this gateway process: ${approvalId}`);
      }
      const body = await readJsonBody(request);
      const approved = body.approved === true || body.decision === "approved" || body.status === "approved";
      pending.resolve(approved);
      this.pendingApprovals.delete(approvalId);
      sendJson(response, 200, { approval_id: approvalId, status: approved ? "approved" : "denied" });
      return;
    }

    throw new HttpError(404, "Unknown approval route.");
  }

  private async handleWorkers(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    workerId?: string,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && !workerId) {
      const parent = url.searchParams.get("parent_session_id") ?? undefined;
      const workers = parent
        ? this.runtime.workerStateStore.listByParent(parent)
        : this.runtime.workerStateStore.listRecent(integerParam(url, "limit", 50));
      sendJson(response, 200, { workers });
      return;
    }

    if (request.method === "POST" && workerId && child === "stop") {
      this.runtime.stopWorker(workerId);
      sendJson(response, 202, { worker_id: workerId, status: "stop_requested" });
      return;
    }

    throw new HttpError(404, "Unknown worker route.");
  }

  private async handleHandoffs(
    request: IncomingMessage,
    response: ServerResponse,
    handoffId?: string,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && !handoffId) {
      sendJson(response, 200, { handoffs: this.runtime.listHandoffs(50) });
      return;
    }

    if (request.method === "POST" && handoffId && child === "take-back") {
      sendJson(response, 202, this.runtime.takeBackHandoff(handoffId));
      return;
    }

    throw new HttpError(404, "Unknown handoff route.");
  }

  private async startRuntimeRun(objective: string, mode: RunMode): Promise<GatewayRun> {
    this.assertNoActiveRun();
    const run = createRun(objective, mode);
    this.runs.set(run.run_id, run);

    const sessionPromise = this.waitForNextSession(objective);
    const execution = this.runtime.run(objective, { mode });
    void execution.then((result) => {
      finishRun(run, "completed", result);
    }).catch((error: unknown) => {
      finishRun(run, "failed", undefined, errorMessage(error));
      this.runtime.events.emitEvent({ type: "error", message: errorMessage(error) });
    });

    const started = await Promise.race([
      sessionPromise.then((event) => ({ type: "session" as const, event })),
      execution.then((result) => ({ type: "final" as const, result })).catch((error: unknown) => ({ type: "error" as const, error })),
      delay(15_000).then(() => ({ type: "timeout" as const }))
    ]);

    if (started.type === "session") {
      run.session_id = started.event.session_id;
      run.status = started.event.status === "created" ? "starting" : "running";
      run.updated_at = new Date().toISOString();
    } else if (started.type === "final") {
      run.session_id = started.result.session_id;
      finishRun(run, "completed", started.result);
    } else if (started.type === "error") {
      finishRun(run, "failed", undefined, errorMessage(started.error));
      throw new HttpError(500, run.error ?? "Run failed before a session was created.");
    }

    return run;
  }

  private startPlannedExecution(planned: PlannedSession): GatewayRun {
    this.assertNoActiveRun();
    const run = createRun(planned.session.objective, "full_swarm");
    run.session_id = planned.session.session_id;
    run.status = "running";
    run.updated_at = new Date().toISOString();
    this.runs.set(run.run_id, run);
    void this.runtime.execute(planned).then((result) => {
      finishRun(run, "completed", result);
      this.runtime.events.emitEvent({
        type: "session",
        session_id: planned.session.session_id,
        status: this.runtime.sessionStore.get(planned.session.session_id)?.status ?? "completed",
        objective: planned.session.objective
      });
    }).catch((error: unknown) => {
      finishRun(run, "failed", undefined, errorMessage(error));
      this.runtime.events.emitEvent({ type: "error", message: errorMessage(error) });
    });
    return run;
  }

  private assertNoActiveRun(): void {
    const active = [...this.runs.values()].find((run) => run.status === "starting" || run.status === "running");
    if (active) {
      throw new HttpError(409, `Swarm Gateway already has an active run: ${active.run_id}`);
    }
  }

  private waitForApproval(request: ToolApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(request.id, {
        request,
        resolve,
        created_at: new Date().toISOString()
      });
    });
  }

  private waitForNextSession(objective: string): Promise<Extract<RuntimeEvent, { type: "session" }>> {
    return new Promise((resolve) => {
      const unsubscribe = this.runtime.events.onEvent((event) => {
        if (event.type === "session" && (!event.objective || event.objective === objective)) {
          unsubscribe();
          resolve(event);
        }
      });
    });
  }

  private recordAndBroadcast(event: RuntimeEvent): void {
    const id = this.nextEventId++;
    this.eventBuffer.push({ id, event });
    if (this.eventBuffer.length > EVENT_BUFFER_LIMIT) {
      this.eventBuffer.shift();
    }
    for (const client of this.clients.values()) {
      if (client.sessionId && eventSessionId(event) !== client.sessionId) {
        continue;
      }
      writeSse(client.response, id, event.type, event);
    }
  }

  private openEventStream(response: ServerResponse, sessionId?: string): void {
    const client: SseClient = {
      id: `sse_${randomUUID()}`,
      sessionId,
      response
    };
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    writeSse(response, 0, "ready", { session_id: sessionId, message: "Swarm Gateway event stream connected." });
    for (const item of this.eventBuffer) {
      if (sessionId && eventSessionId(item.event) !== sessionId) {
        continue;
      }
      writeSse(response, item.id, item.event.type, item.event);
    }
    this.clients.set(client.id, client);
    response.on("close", () => {
      this.clients.delete(client.id);
    });
  }
}

function sessionSnapshot(runtime: SwarmRuntime, sessionId: string): Record<string, unknown> {
  const row = runtime.sessionStore.get(sessionId);
  if (!row) {
    throw new HttpError(404, `Unknown session: ${sessionId}`);
  }
  return {
    ...row,
    policy: parseJson(row.policy_json),
    participants: parseJson(row.participants_json),
    plan: row.plan_json ? parseJson(row.plan_json) : undefined,
    graph: runtime.getTaskGraph(sessionId),
    usage_summary: runtime.usageStore.summarize(sessionId),
    work_snapshot: runtime.getWorkSnapshot(sessionId)
  };
}

function plannedSessionFromStore(runtime: SwarmRuntime, sessionId: string): PlannedSession {
  const row = runtime.sessionStore.get(sessionId);
  if (!row) {
    throw new HttpError(404, `Unknown session: ${sessionId}`);
  }
  if (!row.plan_json) {
    throw new HttpError(409, `Session has no stored plan: ${sessionId}`);
  }
  const session: SwarmSession = {
    session_id: row.session_id,
    swarm_id: row.swarm_id,
    user_request_id: `gateway_${row.session_id}`,
    objective: row.objective,
    status: row.status,
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: parseJson(row.participants_json) as SwarmSession["participants"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    policy: parseJson(row.policy_json) as SwarmSession["policy"]
  };
  return {
    session,
    plan: parseJson(row.plan_json) as PlannedSession["plan"]
  };
}

function createRun(objective: string, mode: RunMode): GatewayRun {
  const now = new Date().toISOString();
  return {
    run_id: `run_${randomUUID()}`,
    objective,
    mode,
    status: "starting",
    created_at: now,
    updated_at: now
  };
}

function finishRun(run: GatewayRun, status: GatewayRunStatus, result?: ExecutionResult, error?: string): void {
  run.status = status;
  run.result = result;
  run.session_id = result?.session_id ?? run.session_id;
  run.error = error;
  run.updated_at = new Date().toISOString();
}

function requireRun(runs: Map<string, GatewayRun>, runId: string): GatewayRun {
  const run = runs.get(runId);
  if (!run) {
    throw new HttpError(404, `Unknown run: ${runId}`);
  }
  return run;
}

function eventSessionId(event: RuntimeEvent): string | undefined {
  if ("session_id" in event && typeof event.session_id === "string") {
    return event.session_id;
  }
  if (event.type === "envelope") return event.envelope.session_id;
  if (event.type === "blackboard") return event.entry.session_id;
  if (event.type === "approval") return event.request.session_id;
  if (event.type === "worker") return event.worker.parent_session_id;
  if (event.type === "agent_run_started" || event.type === "agent_run_completed") return event.worker.parent_session_id;
  if (event.type === "handoff_started" || event.type === "handoff_returned" || event.type === "handoff_taken_back") return event.handoff.parent_session_id;
  if (event.type === "file_lock") return event.event.sessionId;
  if (event.type === "agent_spawn_decision") return undefined;
  return undefined;
}

function runModeField(value: unknown): RunMode {
  if (value === "chat" || value === "coding_loop" || value === "full_swarm") {
    return value;
  }
  return "auto";
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `Missing string field: ${key}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") {
    return true;
  }
  if (value === false || value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function capabilityFilterFromUrl(url: URL): CapabilityFilter {
  return {
    kind: optionalString(url.searchParams.get("kind")),
    source: optionalString(url.searchParams.get("source")),
    trust: optionalString(url.searchParams.get("trust")),
    providerId: optionalString(url.searchParams.get("provider_id") ?? url.searchParams.get("provider")),
    modelVisible: optionalBoolean(url.searchParams.get("model_visible") ?? url.searchParams.get("modelVisible")),
    userVisible: optionalBoolean(url.searchParams.get("user_visible") ?? url.searchParams.get("userVisible")),
    includeDisabled: optionalBoolean(url.searchParams.get("include_disabled") ?? url.searchParams.get("includeDisabled")),
    query: optionalString(url.searchParams.get("q") ?? url.searchParams.get("query"))
  };
}

function positiveBodyInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function integerParam(url: URL, key: string, fallback: number): number {
  const parsed = Number(url.searchParams.get(key));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 500) : fallback;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function gatewayIndex(): Record<string, unknown> {
  return {
    service: "swarm-gateway",
    role: "local API and event-stream surface",
    product_ui: "CLI TUI only; run `swarm` and use `/kernel` or `/status` for the operator view.",
    routes: PUBLIC_API_SURFACE
  };
}

function writeSse(response: ServerResponse, id: number, eventName: string, value: unknown): void {
  response.write(`id: ${id}\n`);
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
