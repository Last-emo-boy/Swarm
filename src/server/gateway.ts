import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { createEnvelope } from "../protocol/envelope.js";
import { approvalEnvelopeForRequest } from "../runtime/safety-governance.js";
import type { SwarmEnvelope, SwarmMessageType, SwarmSession, WorkItem } from "../protocol/types.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { SandboxWritePolicy } from "../runtime/sandbox-policy.js";
import { buildWorkRecordFromRuntimeEvent, type WorkProtocolRecord } from "../runtime/work-protocol.js";
import { buildSessionWorkBoard, buildWorkspaceWorkBoard } from "../runtime/work-board.js";
import { buildAgentWorkspaceProjection } from "../runtime/agent-workspace.js";
import type { ExecutionResult, PlannedSession, ToolApprovalHandler } from "../runtime/orchestrator.js";
import type { RunMode } from "../runtime/execution-router.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import type { SessionRow } from "../storage/session-store.js";
import { installPluginRoot, removePluginRoot, setCapabilityEnabled, setCapabilityModelVisible, setPluginEnabled } from "../config/settings.js";
import type { SymphonyScheduler } from "../symphony/scheduler.js";
import { SymphonyDaemonManager } from "../symphony/daemon.js";
import { createSymphonyActionFact, type SymphonyActionFact } from "../symphony/action-lifecycle.js";
import { SYMPHONY_SESSION_SOURCES, workItemKey } from "../symphony/work-item.js";
import type { CapabilityFilter } from "../extensions/types.js";
import { summarizeCapabilityCatalog, summarizeMcpCatalog, summarizePluginCatalog, summarizeSkillCatalog } from "../extensions/catalog-summary.js";
import { mcpSettingsSnapshot } from "../extensions/mcp-report.js";
import { skillSettingsSnapshot } from "../extensions/skill-report.js";
import { getGlobalLspManager } from "../lsp/manager.js";
import { handleSwarmMcpEndpoint } from "./mcp-endpoint.js";
import { buildSessionSnapshot, buildWorkspaceSnapshot } from "./session-view.js";
import {
  authorizeGatewayRequest,
  envFlag,
  gatewayCorsDecision,
  parseGatewayAllowedOrigins,
  validateGatewayBindHost
} from "./gateway-auth.js";
import {
  delay,
  errorMessage,
  HttpError,
  integerParam,
  optionalHeader,
  parseJson,
  readJsonBody,
  sendJson,
  setCommonHeaders,
  writeSse
} from "./gateway-http.js";

export type GatewayOptions = {
  host?: string;
  port?: number;
  workspace?: string;
  databasePath?: string;
  authToken?: string;
  allowRemote?: boolean;
  allowedOrigins?: string[];
};

type GatewayRunStatus = "starting" | "running" | "completed" | "failed";

type GatewayRun = {
  schema_version: typeof GATEWAY_RESPONSE_SCHEMA_VERSION;
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

type ApprovalQueueView = {
  session_id?: string;
  session_ids?: string[];
  pending_requests: ToolApprovalRequest[];
  actionable_approval_ids: string[];
  approvals: ApprovalRecord[];
  summary: {
    actionable_pending: number;
    persisted_pending: number;
    approved: number;
    denied: number;
  };
};

type SseClient = {
  id: string;
  sessionId?: string;
  protocol: "runtime" | "work";
  lastEventId?: number;
  replayWindow: number;
  missedEventsHint?: GatewayReplayMissedEventsHint;
  response: ServerResponse;
};

type GatewayEventBufferEntry = {
  id: number;
  at: string;
  event: RuntimeEvent;
  work: WorkProtocolRecord;
};

type SymphonyOperatorAction = "pause" | "resume" | "cancel" | "retry";

type GatewaySymphonyActionResult = {
  schema_version: typeof GATEWAY_RESPONSE_SCHEMA_VERSION;
  action_id: string;
  correlation_id: string;
  gateway_envelope_id?: string;
  action: SymphonyOperatorAction;
  status: "not_supported" | "already_terminal" | "cancelled";
  session_id: string;
  previous_status?: string;
  next_status?: string;
  work_item_key?: string;
  live_stop_requested?: boolean;
  action_fact: SymphonyActionFact;
  attempt: unknown;
  error?: {
    status: number;
    code: string;
    message: string;
  };
  recovery?: string;
  session?: Record<string, unknown>;
};

type GatewaySymphonyActionCacheEntry = {
  response: GatewaySymphonyActionResult;
  status: number;
};

type GatewayReplayMissedEventsHint = {
  requested_last_event_id?: number;
  oldest_replayable_event_id?: number;
  replay_window: number;
  missed: boolean;
};

type GatewayControlEnvelopeInput = {
  request?: IncomingMessage;
  body?: Record<string, unknown>;
  sessionId: string;
  swarmId?: string;
  taskId?: string;
  type: SwarmMessageType;
  intent: string;
  route: string;
  action: string;
  status?: string;
  payload?: Record<string, unknown>;
  to?: SwarmEnvelope["to"];
  requestId?: string;
  correlationId?: string;
  replyTo?: string;
  idempotencyKey?: string;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 38171;
const EVENT_BUFFER_LIMIT = 500;
const GATEWAY_ACTOR_ID = "gateway.local";
const GATEWAY_LEGACY_ACTOR_ID = "gateway";
const GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION = "swarm.gateway.control.v1";
const GATEWAY_RESPONSE_SCHEMA_VERSION = "swarm.gateway.response.v1";
const GATEWAY_STREAM_SCHEMA_VERSION = "swarm.gateway.stream.v1";
const PUBLIC_API_SURFACE = [
  "/",
  "/health",
  "/mcp",
  "/v1/live",
  "/v1/live/messages",
  "/v1/live/interrupt",
  "/v1/sessions",
  "/v1/runs",
  "/v1/checkpoints",
  "/v1/checkpoints/:id/revert",
  "/v1/work-board",
  "/v1/workbench",
  "/v1/workbench/cases",
  "/v1/workbench/cases/:id",
  "/v1/workbench/inbox",
  "/v1/agent-workspace",
  "/v1/agent-workspace/teammates",
  "/v1/agent-workspace/attention",
  "/v1/agent-workspace/activity",
  "/v1/agent-workspace/skills",
  "/v1/agent-workspace/capabilities",
  "/v1/agent-workspace/readiness",
  "/v1/agent-workspace/automations",
  "/v1/events",
  "/v1/work-events",
  "/v1/sessions/:id/events",
  "/v1/sessions/:id/work-events",
  "/v1/approvals",
  "/v1/approvals/:id/decision",
  "/v1/workers",
  "/v1/workers/:id",
  "/v1/workers/:id/stop",
  "/v1/workers/:id/continue",
  "/v1/handoffs",
  "/v1/handoffs/:id",
  "/v1/handoffs/:id/take-back",
  "/v1/capabilities",
  "/v1/capabilities/:id",
  "/v1/capabilities/:id/invoke",
  "/v1/capabilities/:id/enable",
  "/v1/capabilities/:id/disable",
  "/v1/capabilities/:id/show",
  "/v1/capabilities/:id/hide",
  "/v1/capabilities/refresh",
  "/v1/skills",
  "/v1/skills/:name/activate",
  "/v1/plugins",
  "/v1/plugins/:id",
  "/v1/plugins/:id/enable",
  "/v1/plugins/:id/disable",
  "/v1/mcp/servers",
  "/v1/mcp/servers/:id/refresh",
  "/v1/mcp/servers/:id/resources",
  "/v1/mcp/servers/:id/resources/read",
  "/v1/mcp/servers/:id/prompts",
  "/v1/mcp/servers/:id/prompts/get",
  "/v1/lsp/status",
  "/v1/symphony/preview",
  "/v1/symphony/tick",
  "/v1/symphony/status",
  "/v1/symphony/actions",
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
  private readonly eventBuffer: GatewayEventBufferEntry[] = [];
  private readonly symphonyActionCache = new Map<string, GatewaySymphonyActionCacheEntry>();
  private nextEventId = 1;
  private listening = false;

  constructor(private readonly options: GatewayOptions = {}) {
    const approvalHandler: ToolApprovalHandler = (request) => this.waitForApproval(request);
    this.runtime = new SwarmRuntime({
      workspace: options.workspace,
      databasePath: options.databasePath,
      approvalHandler
    });
    this.registerGatewayActors(options);
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
    const bindDecision = validateGatewayBindHost(this.host, this.securityOptions);
    if (!bindDecision.ok) {
      throw new HttpError(bindDecision.status, bindDecision.message);
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

  private get securityOptions(): {
    authToken?: string;
    allowRemote?: boolean;
    allowedOrigins?: string[];
  } {
    return {
      authToken: this.options.authToken ?? process.env.SWARM_GATEWAY_TOKEN,
      allowRemote: this.options.allowRemote ?? envFlag(process.env.SWARM_GATEWAY_ALLOW_REMOTE),
      allowedOrigins: this.options.allowedOrigins ?? parseGatewayAllowedOrigins(process.env.SWARM_GATEWAY_ALLOWED_ORIGINS)
    };
  }

  private registerGatewayActors(options: GatewayOptions): void {
    const card = {
      agent_id: GATEWAY_ACTOR_ID,
      name: "Swarm Gateway",
      role: "http_gateway",
      capabilities: ["gateway.http", "gateway.control", "events.stream", "symphony.control"],
      status: "idle" as const,
      load: { running_tasks: 0, max_tasks: 1 },
      reliability: { success_rate: 1, avg_latency_ms: 0 },
      metadata: {
        kind: "gateway",
        host: options.host,
        port: options.port,
        legacy_actor_id: GATEWAY_LEGACY_ACTOR_ID
      }
    };
    this.runtime.registry.register(card);
    this.runtime.agentActorStore.registerSystemActor({
      actor_id: GATEWAY_LEGACY_ACTOR_ID,
      kind: "gateway",
      name: "Swarm Gateway Legacy Alias",
      role: "http_gateway",
      capabilities: ["gateway.http", "events.stream", "symphony.control"],
      metadata: {
        host: options.host,
        port: options.port,
        alias_for: GATEWAY_ACTOR_ID
      }
    });
  }

  private emitGatewayControlEnvelope(input: GatewayControlEnvelopeInput): SwarmEnvelope<Record<string, unknown>> {
    const body = input.body ?? {};
    const httpRequestId = input.requestId ??
      optionalString(body.request_id ?? body.requestId) ??
      optionalHeader(input.request?.headers["x-swarm-request-id"]) ??
      optionalHeader(input.request?.headers["x-request-id"]);
    const correlationId = input.correlationId ??
      optionalString(body.correlation_id ?? body.correlationId) ??
      optionalHeader(input.request?.headers["x-correlation-id"]) ??
      httpRequestId ??
      `gateway_${input.action}_${randomUUID()}`;
    const replyTo = input.replyTo ??
      optionalString(body.reply_to ?? body.replyTo) ??
      optionalHeader(input.request?.headers["x-swarm-reply-to"]);
    const idempotencyKey = input.idempotencyKey ??
      optionalString(body.idempotency_key ?? body.idempotencyKey);
    const session = this.runtime.sessionStore.get(input.sessionId);
    const payload = stripUndefinedRecord({
      schema_version: "swarm.gateway.control_envelope.v1",
      route: input.route,
      action: input.action,
      status: input.status ?? "requested",
      http_method: input.request?.method,
      http_path: input.request?.url,
      http_request_id: httpRequestId,
      request_id: httpRequestId,
      correlation_id: correlationId,
      actor_id: GATEWAY_ACTOR_ID,
      ...input.payload
    });
    const envelope = createEnvelope<Record<string, unknown>>({
      swarm_id: input.swarmId ?? session?.swarm_id ?? `swarm_${input.sessionId}`,
      session_id: input.sessionId,
      task_id: input.taskId,
      from: { agent_id: GATEWAY_ACTOR_ID, role: "http_gateway" },
      to: input.to ?? { agent_id: "main_swarm", role: "coordinator" },
      type: input.type,
      intent: input.intent,
      payload,
      correlation_id: correlationId,
      reply_to: replyTo,
      idempotency_key: idempotencyKey,
      auth: {
        actor: gatewayAuthActor(input.request),
        scopes: ["gateway.http", `gateway.${input.action}`]
      },
      trace: {
        trace_id: correlationId,
        span_id: `span_gateway_${randomUUID()}`
      }
    });
    this.runtime.router.receive(envelope);
    this.runtime.agentActorStore.heartbeat(GATEWAY_ACTOR_ID, {
      status: "idle",
      current_task_id: input.taskId ?? null,
      current_worker_id: typeof input.payload?.worker_id === "string" ? input.payload.worker_id : null,
      current_session_id: input.sessionId,
      metadata: {
        last_action: input.action,
        last_route: input.route,
        last_envelope_id: envelope.id,
        last_correlation_id: correlationId
      }
    });
    return envelope;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCommonHeaders(response, request.headers.origin, this.securityOptions);
    const corsDecision = gatewayCorsDecision(optionalHeader(request.headers.origin), this.securityOptions);
    if (!corsDecision.ok) {
      sendJson(response, corsDecision.status, { error: { message: corsDecision.message, status: corsDecision.status } });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const authDecision = authorizeGatewayRequest({
      method: request.method,
      headers: request.headers,
      remoteAddress: request.socket.remoteAddress
    }, this.securityOptions);
    if (!authDecision.ok) {
      sendJson(response, authDecision.status, { error: { message: authDecision.message, status: authDecision.status } });
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

      if (url.pathname === "/mcp") {
        const body = request.method === "POST" ? await readJsonBody(request) : {};
        await handleSwarmMcpEndpoint({
          runtime: this.runtime,
          request,
          response,
          body,
          startRun: (objective, mode) => this.startRuntimeRun(objective, mode),
          interrupt: (sessionId, content, requestId) => this.runtime.requestInterrupt(content, { sessionId, requestId }),
          approvalDecision: (approvalId, approved) => this.applyApprovalDecision(approvalId, approved),
          listApprovals: (sessionId, limit) => this.approvalQueueView(sessionId, limit)
        });
        return;
      }

      if (request.method === "GET" && segments[0] === "v1" && segments[1] === "events") {
        this.openEventStream(request, response, undefined, "runtime");
        return;
      }

      if (request.method === "GET" && segments[0] === "v1" && segments[1] === "work-events") {
        this.openEventStream(request, response, undefined, "work");
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

    if (resource === "work-board" || resource === "work_board") {
      this.handleWorkBoard(request, response, url, id);
      return;
    }

    if (resource === "workbench") {
      this.handleWorkbench(request, response, url, id, child);
      return;
    }

    if (resource === "agent-workspace" || resource === "agent_workspace") {
      await this.handleAgentWorkspace(request, response, url, id);
      return;
    }

    if (resource === "checkpoints") {
      await this.handleCheckpoints(request, response, url, id, child);
      return;
    }

    if (resource === "live") {
      await this.handleLive(request, response, id);
      return;
    }

    if (resource === "approvals") {
      await this.handleApprovals(request, response, url, id, child);
      return;
    }

    if (resource === "workers") {
      await this.handleWorkers(request, response, url, id, child);
      return;
    }

    if (resource === "handoffs") {
      await this.handleHandoffs(request, response, url, id, child);
      return;
    }

    if (resource === "capabilities") {
      await this.handleCapabilities(request, response, url, id, child);
      return;
    }

    if (resource === "skills") {
      await this.handleSkills(request, response, id, child);
      return;
    }

    if (resource === "plugins") {
      await this.handlePlugins(request, response, id, child);
      return;
    }

    if (resource === "mcp") {
      await this.handleMcp(request, response, id, child, childId, segments[4]);
      return;
    }

    if (resource === "lsp") {
      await this.handleLsp(request, response, url, id);
      return;
    }

    if (resource === "symphony") {
      await this.handleSymphony(request, response, url, id, child);
      return;
    }

    throw new HttpError(404, "Unknown v1 route.");
  }

  private async handleCheckpoints(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    checkpointId?: string,
    action?: string
  ): Promise<void> {
    if (request.method === "GET" && !checkpointId) {
      const checkpoints = await this.runtime.listCheckpoints(integerParam(url, "limit", 20));
      sendJson(response, 200, { workspace: this.runtime.workspaceRoot(), checkpoints });
      return;
    }

    if (request.method === "POST" && !checkpointId) {
      const body = await readJsonBody(request);
      const checkpoint = await this.runtime.createCheckpoint(stringField(body, "name"), optionalString(body.reason));
      sendJson(response, 201, { workspace: this.runtime.workspaceRoot(), checkpoint });
      return;
    }

    if (request.method === "POST" && checkpointId && action === "revert") {
      const selector = checkpointId === "last" ? undefined : checkpointId;
      const checkpoint = await this.runtime.revertCheckpoint(selector);
      if (!checkpoint) {
        throw new HttpError(404, selector ? `Unknown checkpoint: ${selector}` : "No checkpoint found to revert.");
      }
      sendJson(response, 200, { workspace: this.runtime.workspaceRoot(), checkpoint });
      return;
    }

    throw new HttpError(404, "Unknown checkpoint route.");
  }

  private handleWorkBoard(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    sessionId?: string
  ): void {
    if (request.method !== "GET") {
      throw new HttpError(405, "Method not allowed.");
    }
    const targetSessionId = sessionId ?? optionalString(url.searchParams.get("session_id") ?? url.searchParams.get("session"));
    const limit = integerParam(url, "limit", 25);
    const board = targetSessionId
      ? buildSessionWorkBoard(this.runtime, targetSessionId)
      : buildWorkspaceWorkBoard(this.runtime, { limit });
    sendJson(response, 200, board);
  }

  private handleWorkbench(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    section?: string,
    caseId?: string
  ): void {
    if (request.method !== "GET") {
      throw new HttpError(405, "Method not allowed.");
    }
    const limit = integerParam(url, "limit", 50);
    if (!section) {
      sendJson(response, 200, this.runtime.buildGlobalCaseWorkbench(limit));
      return;
    }
    if (section === "cases") {
      if (caseId) {
        const detail = this.runtime.getCaseWorkbenchDetail(caseId, limit);
        if (!detail) {
          throw new HttpError(404, `Unknown case: ${caseId}`);
        }
        sendJson(response, 200, detail);
        return;
      }
      const projection = this.runtime.buildGlobalCaseWorkbench(limit);
      sendJson(response, 200, {
        schema_version: projection.schema_version,
        generated_at: projection.generated_at,
        scope: projection.scope,
        summary: projection.summary,
        cases: projection.cases
      });
      return;
    }
    if (section === "inbox") {
      const projection = this.runtime.buildGlobalCaseWorkbench(limit);
      sendJson(response, 200, {
        schema_version: projection.schema_version,
        generated_at: projection.generated_at,
        scope: projection.scope,
        summary: projection.summary,
        inbox: projection.inbox
      });
      return;
    }
    throw new HttpError(404, "Unknown workbench route.");
  }

  private async handleAgentWorkspace(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    section?: string
  ): Promise<void> {
    if (request.method !== "GET") {
      throw new HttpError(405, "Method not allowed.");
    }
    const targetSessionId = optionalString(url.searchParams.get("session_id") ?? url.searchParams.get("session"));
    const limit = integerParam(url, "limit", 25);
    const board = targetSessionId
      ? buildSessionWorkBoard(this.runtime, targetSessionId)
      : buildWorkspaceWorkBoard(this.runtime, { limit });
    const [capabilities, providers] = await Promise.all([
      this.runtime.listCapabilities({ includeDisabled: true }),
      this.runtime.listCapabilityProviders()
    ]);
    const { getSymphonyStatus } = await import("../symphony/status.js");
    const symphonyStatus = getSymphonyStatus({
      runtime: this.runtime,
      workflowPath: optionalString(url.searchParams.get("workflow_path") ?? url.searchParams.get("workflow")),
      limit: integerParam(url, "symphony_limit", 100)
    });
    const projection = buildAgentWorkspaceProjection({
      board,
      approvals: targetSessionId
        ? this.runtime.listApprovalsForSessionFamily(targetSessionId, limit)
        : this.runtime.listRecentApprovalsForWorkspace(limit),
      skills: this.runtime.listSkills(),
      capabilities,
      providers,
      symphonyStatus,
      daemons: this.symphonyDaemons.listRecords(),
      workspacePath: this.runtime.getWorkspacePath()
    });

    switch (section) {
      case undefined:
        sendJson(response, 200, projection);
        return;
      case "teammates":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, teammates: projection.teammates });
        return;
      case "attention":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, attention: projection.attention });
        return;
      case "activity":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, activity: projection.activity });
        return;
      case "skills":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, skills: projection.skills });
        return;
      case "capabilities":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, capabilities: projection.capabilities });
        return;
      case "readiness":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, readiness: projection.readiness });
        return;
      case "automations":
        sendJson(response, 200, { schema_version: projection.schema_version, generated_at: projection.generated_at, automations: projection.automations });
        return;
      default:
        throw new HttpError(404, "Unknown agent workspace route.");
    }
  }

  private async handleLsp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    action?: string
  ): Promise<void> {
    if (request.method === "GET" && (!action || action === "status")) {
      const provider = optionalString(url.searchParams.get("provider"));
      const report = await getGlobalLspManager(this.runtime.workspaceRoot()).status(provider);
      sendJson(response, 200, report);
      return;
    }

    throw new HttpError(404, "Unknown LSP route.");
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

    if (request.method === "POST" && (action === "actions" || action === "action")) {
      await this.handleSymphonyOperatorAction(request, response);
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
          session: item.session ? sessionSnapshot(this.runtime, item.session.session_id, this.approvalQueueView(item.session.session_id, 80)) : undefined,
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
          session: sessionSnapshot(this.runtime, item.session.session_id, this.approvalQueueView(item.session.session_id, 80)),
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

  private async handleSymphonyOperatorAction(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = await readJsonBody(request);
    const action = symphonyOperatorAction(body.action);
    const reason = optionalString(body.reason) ?? `operator_${action}`;
    const actionId = optionalString(body.action_id ?? body.actionId) ?? `symphony_${action}_${randomUUID()}`;
    const correlationId = optionalString(body.correlation_id ?? body.correlationId) ?? actionId;
    const idempotencyKey = optionalString(body.idempotency_key ?? body.idempotencyKey) ?? actionId;
    const cached = this.symphonyActionCache.get(idempotencyKey);
    if (cached) {
      sendJson(response, cached.status, cached.response);
      return;
    }
    const target = this.requireSymphonyActionTarget(body);
    const targetWorkItemKey = target.workItem ? workItemKey(target.workItem) : undefined;
    const requestedAt = new Date().toISOString();
    const gatewayEnvelope = this.emitGatewayControlEnvelope({
      request,
      body,
      sessionId: target.row.session_id,
      swarmId: target.row.swarm_id,
      taskId: `symphony.operator.${action}`,
      type: action === "cancel" ? "task.cancel" : "task.progress",
      intent: `gateway.symphony.${action}`,
      route: "/v1/symphony/actions",
      action: `symphony.${action}`,
      status: action === "cancel" ? "requested" : "not_supported",
      correlationId,
      idempotencyKey,
      payload: {
        action_id: actionId,
        action,
        reason,
        session_id: target.row.session_id,
        work_item_key: targetWorkItemKey,
        previous_status: target.row.status
      }
    });
    if (action !== "cancel") {
      const recovery = unsupportedSymphonyActionRecovery(action);
      const actionFact = createSymphonyActionFact({
        action_id: actionId,
        correlation_id: correlationId,
        gateway_envelope_id: gatewayEnvelope.id,
        action,
        status: "not_supported",
        target: {
          session_id: target.row.session_id,
          work_item_key: targetWorkItemKey
        },
        actor: { kind: "gateway", id: "gateway.symphony.operator" },
        reason,
        message: recovery.message,
        recovery: recovery.recovery,
        error_code: "SYMPHONY_ACTION_NOT_SUPPORTED",
        replay: [
          { status: "requested", at: requestedAt, message: reason },
          { status: "not_supported", at: requestedAt, message: recovery.message }
        ]
      });
      const attempt = this.runtime.runAttemptStore.upsert({
        session_id: target.row.session_id,
        task_id: `symphony.operator.${action}`,
        runner_id: "gateway.symphony.operator",
        kind: "swarm_task",
        status: "failed",
        attempt: 0,
        title: `Symphony operator ${action}`,
        terminal_reason: recovery.message,
        error_code: "SYMPHONY_ACTION_NOT_SUPPORTED",
        recovery_suggestion: recovery.recovery,
        metadata: {
          action_id: actionId,
          correlation_id: correlationId,
          gateway_envelope_id: gatewayEnvelope.id,
          action,
          action_status: actionFact.status,
          action_fact: actionFact,
          reason,
          work_item: target.workItem,
          work_item_key: targetWorkItemKey
        }
      });
      const persistedActionFact = { ...actionFact, attempt_id: attempt.attempt_id };
      const entry = this.runtime.blackboardStore.write({
        swarm_id: target.row.swarm_id,
        session_id: target.row.session_id,
        task_id: `symphony.operator.${action}`,
        key: `symphony.operator.${action}.${actionId}`,
        type: "decision",
        value: {
          action_id: actionId,
          correlation_id: correlationId,
          gateway_envelope_id: gatewayEnvelope.id,
          action,
          status: "not_supported",
          reason,
          message: recovery.message,
          recovery: recovery.recovery,
          action_fact: persistedActionFact,
          work_item: target.workItem,
          work_item_key: targetWorkItemKey,
          attempt
        },
        created_by: { agent_id: "gateway", role: "operator" },
        tags: ["gateway", "symphony", "operator", action, "not_supported"]
      });
      this.runtime.events.emitEvent({ type: "blackboard", entry });
      this.runtime.events.emitEvent({
        type: "tool_result",
        session_id: target.row.session_id,
        task_id: `symphony.operator.${action}`,
        title: `Symphony operator ${action}`,
        action: `symphony.${action}`,
        summary: recovery.message,
        content: recovery.recovery,
        status: "failed",
        errorCode: "SYMPHONY_ACTION_NOT_SUPPORTED",
        recoverySuggestion: recovery.recovery,
        metadata: {
          action_id: actionId,
          correlation_id: correlationId,
          gateway_envelope_id: gatewayEnvelope.id,
          action_fact: persistedActionFact
        }
      });
      const responseBody = {
        schema_version: GATEWAY_RESPONSE_SCHEMA_VERSION,
        action_id: actionId,
        correlation_id: correlationId,
        gateway_envelope_id: gatewayEnvelope.id,
        action,
        status: "not_supported",
        session_id: target.row.session_id,
        work_item_key: targetWorkItemKey,
        action_fact: persistedActionFact,
        attempt,
        error: {
          status: 501,
          code: "SYMPHONY_ACTION_NOT_SUPPORTED",
          message: recovery.message
        },
        recovery: recovery.recovery
      } satisfies GatewaySymphonyActionResult;
      this.symphonyActionCache.set(idempotencyKey, { response: responseBody, status: 501 });
      sendJson(response, 501, responseBody);
      return;
    }

    const alreadyTerminal = isTerminalSessionStatus(target.row.status);
    const liveStopRequested = alreadyTerminal
      ? false
      : this.runtime.interruptWorkSession(target.row.session_id, reason);
    if (!alreadyTerminal) {
      this.runtime.sessionStore.setStatus(target.row.session_id, "cancelled");
    }
    const appliedAt = new Date().toISOString();
    const actionFact = createSymphonyActionFact({
      action_id: actionId,
      correlation_id: correlationId,
      gateway_envelope_id: gatewayEnvelope.id,
      action,
      status: alreadyTerminal ? "rejected" : "applied",
      target: {
        session_id: target.row.session_id,
        work_item_key: targetWorkItemKey
      },
      actor: { kind: "gateway", id: "gateway.symphony.operator" },
      reason,
      message: alreadyTerminal
        ? `Symphony session ${target.row.session_id} is already ${target.row.status}.`
        : `Symphony session ${target.row.session_id} cancelled.`,
      previous_status: target.row.status,
      next_status: alreadyTerminal ? target.row.status : "cancelled",
      live_stop_requested: liveStopRequested,
      replay: [
        { status: "requested", at: requestedAt, message: reason },
        { status: "accepted", at: requestedAt, message: `Target session ${target.row.session_id} resolved.` },
        {
          status: alreadyTerminal ? "rejected" : "applied",
          at: appliedAt,
          message: alreadyTerminal ? `Session already terminal: ${target.row.status}.` : "Session status set to cancelled."
        }
      ]
    });
    const attempt = this.runtime.runAttemptStore.upsert({
      session_id: target.row.session_id,
      task_id: "symphony.operator.cancel",
      runner_id: "gateway.symphony.operator",
      kind: "swarm_task",
      status: "cancelled",
      attempt: 0,
      title: "Symphony operator cancel",
      terminal_reason: reason,
      metadata: {
        action_id: actionId,
        correlation_id: correlationId,
        gateway_envelope_id: gatewayEnvelope.id,
        action,
        action_status: actionFact.status,
        action_fact: actionFact,
        reason,
        previous_status: target.row.status,
        work_item: target.workItem,
        work_item_key: targetWorkItemKey,
        live_stop_requested: liveStopRequested,
        already_terminal: alreadyTerminal
      }
    });
    const persistedActionFact = { ...actionFact, attempt_id: attempt.attempt_id };
    const entry = this.runtime.blackboardStore.write({
      swarm_id: target.row.swarm_id,
      session_id: target.row.session_id,
      task_id: "symphony.operator.cancel",
      key: `symphony.operator.cancel.${actionId}`,
      type: "decision",
      value: {
        action_id: actionId,
        correlation_id: correlationId,
        gateway_envelope_id: gatewayEnvelope.id,
        action,
        reason,
        previous_status: target.row.status,
        next_status: alreadyTerminal ? target.row.status : "cancelled",
        status: actionFact.status,
        action_fact: persistedActionFact,
        work_item: target.workItem,
        work_item_key: targetWorkItemKey,
        live_stop_requested: liveStopRequested,
        attempt
      },
      created_by: { agent_id: "gateway", role: "operator" },
      tags: ["gateway", "symphony", "operator", "cancel"]
    });
    this.runtime.events.emitEvent({ type: "blackboard", entry });
    this.runtime.events.emitEvent({
      type: "tool_result",
      session_id: target.row.session_id,
      task_id: "symphony.operator.cancel",
      title: "Symphony operator cancel",
      action: "symphony.cancel",
      summary: alreadyTerminal
        ? `Symphony session ${target.row.session_id} is already ${target.row.status}.`
        : `Symphony session ${target.row.session_id} cancelled.`,
      content: reason,
      status: "success",
      metadata: {
        action_id: actionId,
        correlation_id: correlationId,
        gateway_envelope_id: gatewayEnvelope.id,
        action_fact: persistedActionFact
      }
    });
    if (!alreadyTerminal) {
      this.runtime.events.emitEvent({
        type: "session",
        session_id: target.row.session_id,
        status: "cancelled",
        objective: target.row.objective
      });
    }
    const responseBody = {
      schema_version: GATEWAY_RESPONSE_SCHEMA_VERSION,
      action_id: actionId,
      correlation_id: correlationId,
      gateway_envelope_id: gatewayEnvelope.id,
      action,
      status: alreadyTerminal ? "already_terminal" : "cancelled",
      session_id: target.row.session_id,
      previous_status: target.row.status,
      next_status: alreadyTerminal ? target.row.status : "cancelled",
      work_item_key: targetWorkItemKey,
      live_stop_requested: liveStopRequested,
      action_fact: persistedActionFact,
      attempt,
      session: sessionSnapshot(this.runtime, target.row.session_id, this.approvalQueueView(target.row.session_id, 80))
    } satisfies GatewaySymphonyActionResult & { session: Record<string, unknown> };
    this.symphonyActionCache.set(idempotencyKey, { response: responseBody, status: alreadyTerminal ? 200 : 202 });
    sendJson(response, alreadyTerminal ? 200 : 202, responseBody);
  }

  private requireSymphonyActionTarget(body: Record<string, unknown>): {
    row: SessionRow;
    workItem?: WorkItem;
  } {
    const sessionId = optionalString(body.session_id ?? body.sessionId);
    const targetKey = optionalString(body.work_item_key ?? body.workItemKey);
    if (sessionId) {
      const row = this.runtime.sessionStore.get(sessionId);
      const workItem = row ? parseWorkItem(row.source_json) : undefined;
      if (!row || !workItem || !SYMPHONY_SESSION_SOURCES.includes(workItem.source as typeof SYMPHONY_SESSION_SOURCES[number])) {
        throw new HttpError(404, `Unknown Symphony session: ${sessionId}`);
      }
      return { row, workItem };
    }
    if (targetKey) {
      const rows = this.runtime.sessionStore.listBySources([...SYMPHONY_SESSION_SOURCES], 1_000);
      for (const row of rows) {
        const workItem = parseWorkItem(row.source_json);
        if (workItem && workItemKey(workItem) === targetKey) {
          return { row, workItem };
        }
      }
      throw new HttpError(404, `Unknown Symphony work item: ${targetKey}`);
    }
    throw new HttpError(400, "Missing string field: session_id or work_item_key");
  }

  private async handleCapabilities(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    capabilityId?: string,
    action?: string
  ): Promise<void> {
    if (request.method === "GET" && !capabilityId) {
      const filter = capabilityFilterFromUrl(url);
      const [capabilities, providers] = await Promise.all([
        this.runtime.listCapabilities(filter),
        this.runtime.listCapabilityProviders()
      ]);
      sendJson(response, 200, { capabilities, providers, summary: summarizeCapabilityCatalog(capabilities, providers) });
      return;
    }

    if (request.method === "GET" && capabilityId && !action) {
      const capability = await this.runtime.getCapability(capabilityId);
      if (!capability) {
        throw new HttpError(404, `Unknown capability: ${capabilityId}`);
      }
      sendJson(response, 200, { capability });
      return;
    }

    if (request.method === "POST" && capabilityId && capabilityId !== "refresh") {
      const body = await readJsonBody(request);
      if (action === "enable" || action === "disable" || action === "show" || action === "hide") {
        if (action === "enable" || action === "disable") {
          setCapabilityEnabled(capabilityId, action === "enable");
        } else {
          setCapabilityModelVisible(capabilityId, action === "show");
        }
        this.runtime.reloadSettings();
        const providers = await this.runtime.refreshCapabilities();
        const capability = await this.runtime.getCapability(capabilityId);
        sendJson(response, 200, { capability, providers });
        return;
      }
      if (action !== "invoke") {
        throw new HttpError(404, "Unknown capabilities route.");
      }
      const capability = await this.runtime.getCapability(capabilityId);
      if (!capability) {
        throw new HttpError(404, `Unknown capability: ${capabilityId}`);
      }
      if (capability.trust === "disabled" || capability.status === "disabled") {
        throw new HttpError(409, `Capability is disabled: ${capabilityId}`);
      }
      const args = capabilityInvocationArguments(body);
      const sessionId = optionalString(body.session_id ?? body.sessionId);
      const taskId = optionalString(body.task_id ?? body.taskId) ?? `capability_${randomUUID()}`;
      const result = await this.runtime.invokeCapability(capability.id, args, sessionId, {
        taskId,
        title: `Gateway invoke ${capability.title ?? capability.name}`,
        source: "gateway",
        writePolicy: capabilityInvocationWritePolicy(body),
        fileScope: capabilityInvocationFileScope(body)
      });
      sendJson(response, result.status === "failed" ? 500 : 200, { capability, result });
      return;
    }

    if (request.method === "POST" && capabilityId === "refresh") {
      const body = await readJsonBody(request);
      const providerId = optionalString(body.provider_id ?? body.providerId ?? url.searchParams.get("provider_id") ?? url.searchParams.get("provider"));
      const providers = await this.runtime.refreshCapabilities(providerId);
      const capabilities = await this.runtime.listCapabilities(capabilityFilterFromUrl(url));
      sendJson(response, 200, { providers, capabilities, summary: summarizeCapabilityCatalog(capabilities, providers) });
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
      const skills = this.runtime.listSkills();
      const settings = skillSettingsSnapshot(this.runtime);
      sendJson(response, 200, { skills, settings, summary: summarizeSkillCatalog(skills, settings) });
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

  private async handlePlugins(
    request: IncomingMessage,
    response: ServerResponse,
    pluginId?: string,
    action?: string
  ): Promise<void> {
    if (request.method === "GET" && !pluginId) {
      const plugins = this.runtime.listPlugins();
      sendJson(response, 200, { plugins, summary: summarizePluginCatalog(plugins) });
      return;
    }

    if (request.method === "POST" && pluginId === "install") {
      const body = await readJsonBody(request);
      installPluginRoot(stringField(body, "path"));
      this.runtime.reloadSettings();
      const providers = await this.runtime.refreshCapabilities();
      sendJson(response, 200, { plugins: this.runtime.listPlugins(), providers });
      return;
    }

    if (request.method === "POST" && pluginId === "update") {
      this.runtime.reloadSettings();
      const providers = await this.runtime.refreshCapabilities();
      sendJson(response, 200, { plugins: this.runtime.listPlugins(), providers });
      return;
    }

    if (request.method === "POST" && pluginId === "remove-root") {
      const body = await readJsonBody(request);
      removePluginRoot(stringField(body, "path"));
      this.runtime.reloadSettings();
      const providers = await this.runtime.refreshCapabilities();
      sendJson(response, 200, { plugins: this.runtime.listPlugins(), providers });
      return;
    }

    if (request.method === "GET" && pluginId && !action) {
      const plugin = this.runtime.listPlugins().find((item) => item.id === pluginId);
      if (!plugin) {
        throw new HttpError(404, `Unknown plugin: ${pluginId}`);
      }
      const capabilities = await this.runtime.listCapabilities({ providerId: `plugin:${pluginId}`, includeDisabled: true });
      sendJson(response, 200, { plugin, capabilities });
      return;
    }

    if (request.method === "POST" && pluginId && (action === "enable" || action === "disable")) {
      setPluginEnabled(pluginId, action === "enable");
      this.runtime.reloadSettings();
      const providers = await this.runtime.refreshCapabilities();
      const plugins = this.runtime.listPlugins();
      sendJson(response, 200, { plugins, providers });
      return;
    }

    throw new HttpError(404, "Unknown plugins route.");
  }

  private async handleMcp(
    request: IncomingMessage,
    response: ServerResponse,
    resource?: string,
    serverId?: string,
    action?: string,
    subAction?: string
  ): Promise<void> {
    if (resource === "servers" && request.method === "GET" && !serverId) {
      const servers = this.runtime.listMcpServers();
      const settings = mcpSettingsSnapshot(this.runtime);
      sendJson(response, 200, { servers, settings, summary: summarizeMcpCatalog(servers, settings) });
      return;
    }

    if (resource === "servers" && request.method === "GET" && serverId) {
      const server = this.runtime.listMcpServers().find((item) => item.id === serverId);
      if (!server) {
        throw new HttpError(404, `Unknown MCP server: ${serverId}`);
      }
      const settings = mcpSettingsSnapshot(this.runtime);
      sendJson(response, 200, { server, settings, summary: summarizeMcpCatalog([server], settings) });
      return;
    }

    if (resource === "servers" && request.method === "POST" && serverId && action === "refresh") {
      const server = await this.runtime.refreshMcpServer(serverId);
      const capabilities = await this.runtime.listCapabilities({ providerId: `mcp:${serverId}`, includeDisabled: true });
      const settings = mcpSettingsSnapshot(this.runtime);
      sendJson(response, 200, { server, capabilities, settings, summary: summarizeMcpCatalog([server], settings) });
      return;
    }

    if (resource === "servers" && request.method === "GET" && serverId && action === "resources") {
      sendJson(response, 200, { server_id: serverId, resources: this.runtime.listMcpResources(serverId) });
      return;
    }

    if (resource === "servers" && request.method === "POST" && serverId && action === "resources" && (!subAction || subAction === "read")) {
      const body = await readJsonBody(request);
      const uri = stringField(body, "uri");
      const result = await this.runtime.readMcpResource(serverId, uri, optionalString(body.session_id ?? body.sessionId));
      sendJson(response, 200, { server_id: serverId, uri, result });
      return;
    }

    if (resource === "servers" && request.method === "GET" && serverId && action === "prompts") {
      sendJson(response, 200, { server_id: serverId, prompts: this.runtime.listMcpPrompts(serverId) });
      return;
    }

    if (resource === "servers" && request.method === "POST" && serverId && action === "prompts" && (!subAction || subAction === "get")) {
      const body = await readJsonBody(request);
      const name = stringField(body, "name");
      const args = isRecord(body.arguments) ? stringRecord(body.arguments) : undefined;
      const result = await this.runtime.getMcpPrompt(serverId, name, args, optionalString(body.session_id ?? body.sessionId));
      sendJson(response, 200, { server_id: serverId, name, result });
      return;
    }

    throw new HttpError(404, "Unknown MCP route.");
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

  private async handleLive(
    request: IncomingMessage,
    response: ServerResponse,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && !child) {
      const activeTarget = this.runtime.getActiveLiveTarget();
      sendJson(response, 200, activeTarget
        ? {
            schema_version: GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION,
            status: "active",
            active_target: activeTarget,
            controls: {
              reply: true,
              interrupt: true
            },
            session: sessionSnapshot(this.runtime, activeTarget.session_id, this.approvalQueueView(activeTarget.session_id, 80))
          }
        : {
            schema_version: GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION,
            status: "idle",
            active_target: null,
            controls: {
              reply: false,
              interrupt: false
            }
          });
      return;
    }

    if (request.method === "POST" && child === "messages") {
      const body = await readJsonBody(request);
      try {
        const content = stringField(body, "content");
        const requestId = optionalString(body.request_id ?? body.requestId);
        const correlationId = optionalString(body.correlation_id ?? body.correlationId) ?? requestId ?? `live_${randomUUID()}`;
        const target = await this.runtime.sendUserMessage(content, {
          requestId,
          correlationId,
          source: "gateway",
          sourceId: "http",
          sourceRoute: "/v1/live/messages",
          sourceMode: "live",
          sourceMetadata: {
            http_method: request.method,
            http_path: request.url,
            route: "/v1/live/messages",
            correlation_id: correlationId,
            actor_id: GATEWAY_ACTOR_ID
          }
        });
        sendJson(response, 200, {
          schema_version: GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION,
          correlation_id: correlationId,
          status: "applied",
          session_id: target.session_id,
          route: target.route,
          request_id: target.request_id ?? requestId,
          duplicate: target.duplicate === true,
          control: target.control
        });
      } catch (error) {
        throw liveReplyHttpError(error);
      }
      return;
    }

    if (request.method === "POST" && child === "interrupt") {
      const body = await readJsonBody(request);
      try {
        const content = optionalString(body.content) ?? "User requested an interrupt through the Swarm Gateway.";
        const requestId = optionalString(body.request_id ?? body.requestId);
        const correlationId = optionalString(body.correlation_id ?? body.correlationId) ?? requestId ?? `live_${randomUUID()}`;
        const target = this.runtime.requestInterrupt(content, {
          requestId,
          correlationId,
          source: "gateway",
          sourceId: "http",
          sourceRoute: "/v1/live/interrupt",
          sourceMode: "live",
          sourceMetadata: {
            http_method: request.method,
            http_path: request.url,
            route: "/v1/live/interrupt",
            correlation_id: correlationId,
            actor_id: GATEWAY_ACTOR_ID
          }
        });
        this.emitGatewayControlEnvelope({
          request,
          body,
          sessionId: target.session_id,
          taskId: target.control?.message_id ?? target.request_id ?? requestId,
          type: "task.cancel",
          intent: "gateway.live.interrupt",
          route: "/v1/live/interrupt",
          action: "live.interrupt",
          status: "applied",
          requestId,
          correlationId,
          payload: {
            content,
            route: target.route,
            request_id: target.request_id ?? requestId,
            duplicate: target.duplicate === true,
            control: target.control
          }
        });
        sendJson(response, 200, {
          schema_version: GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION,
          correlation_id: correlationId,
          status: "applied",
          session_id: target.session_id,
          route: target.route,
          request_id: target.request_id ?? requestId,
          duplicate: target.duplicate === true,
          control: target.control
        });
      } catch (error) {
        throw interruptHttpError(error);
      }
      return;
    }

    throw new HttpError(404, "Unknown route.");
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
      sendJson(response, 200, buildWorkspaceSnapshot(this.runtime, {
        limit,
        approvals: this.approvalQueueView(undefined, limit)
      }));
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
          sendJson(response, 202, { run, session: sessionSnapshot(this.runtime, planned.session.session_id, this.approvalQueueView(planned.session.session_id, 80)), plan: planned.plan });
        } else {
          sendJson(response, 201, { session: sessionSnapshot(this.runtime, planned.session.session_id, this.approvalQueueView(planned.session.session_id, 80)), plan: planned.plan });
        }
        return;
      }

      const run = await this.startRuntimeRun(objective, mode);
      sendJson(response, 202, { run, session: run.session_id ? sessionSnapshot(this.runtime, run.session_id, this.approvalQueueView(run.session_id, 80)) : undefined });
      return;
    }

    if (!sessionId) {
      throw new HttpError(404, "Session id is required.");
    }

    if (request.method === "GET" && !child) {
      sendJson(response, 200, sessionSnapshot(this.runtime, sessionId, this.approvalQueueView(sessionId, 80)));
      return;
    }

    if (request.method === "GET" && child === "events") {
      this.openEventStream(request, response, sessionId, "runtime");
      return;
    }

    if (request.method === "GET" && child === "work-events") {
      this.openEventStream(request, response, sessionId, "work");
      return;
    }

    if (request.method === "POST" && child === "messages") {
      const body = await readJsonBody(request);
      try {
        const content = stringField(body, "content");
        const requestId = optionalString(body.request_id ?? body.requestId);
        const correlationId = optionalString(body.correlation_id ?? body.correlationId) ?? requestId ?? `live_${randomUUID()}`;
        const target = await this.runtime.sendUserMessage(content, {
          sessionId,
          requestId,
          correlationId,
          source: "gateway",
          sourceId: "http",
          sourceRoute: `/v1/sessions/${sessionId}/messages`,
          sourceMode: "live",
          sourceMetadata: {
            http_method: request.method,
            http_path: request.url,
            route: `/v1/sessions/${sessionId}/messages`,
            requested_session_id: sessionId,
            correlation_id: correlationId,
            actor_id: GATEWAY_ACTOR_ID
          }
        });
        sendJson(response, 200, {
          schema_version: GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION,
          correlation_id: correlationId,
          status: "applied",
          session_id: target.session_id,
          route: target.route,
          request_id: target.request_id ?? requestId,
          duplicate: target.duplicate === true,
          control: target.control
        });
      } catch (error) {
        throw liveReplyHttpError(error);
      }
      return;
    }

    if (request.method === "POST" && child === "interrupt") {
      const body = await readJsonBody(request);
      try {
        const content = optionalString(body.content) ?? "User requested an interrupt through the Swarm Gateway.";
        const requestId = optionalString(body.request_id ?? body.requestId);
        const correlationId = optionalString(body.correlation_id ?? body.correlationId) ?? requestId ?? `live_${randomUUID()}`;
        const target = this.runtime.requestInterrupt(content, {
          sessionId,
          requestId,
          correlationId,
          source: "gateway",
          sourceId: "http",
          sourceRoute: `/v1/sessions/${sessionId}/interrupt`,
          sourceMode: "live",
          sourceMetadata: {
            http_method: request.method,
            http_path: request.url,
            route: `/v1/sessions/${sessionId}/interrupt`,
            requested_session_id: sessionId,
            correlation_id: correlationId,
            actor_id: GATEWAY_ACTOR_ID
          }
        });
        this.emitGatewayControlEnvelope({
          request,
          body,
          sessionId: target.session_id,
          taskId: target.control?.message_id ?? target.request_id ?? requestId,
          type: "task.cancel",
          intent: "gateway.live.interrupt",
          route: `/v1/sessions/${sessionId}/interrupt`,
          action: "live.interrupt",
          status: "applied",
          requestId,
          correlationId,
          payload: {
            content,
            requested_session_id: sessionId,
            route: target.route,
            request_id: target.request_id ?? requestId,
            duplicate: target.duplicate === true,
            control: target.control
          }
        });
        sendJson(response, 200, {
          schema_version: GATEWAY_CONTROL_RESPONSE_SCHEMA_VERSION,
          correlation_id: correlationId,
          status: "applied",
          session_id: target.session_id,
          route: target.route,
          request_id: target.request_id ?? requestId,
          duplicate: target.duplicate === true,
          control: target.control
        });
      } catch (error) {
        throw interruptHttpError(error);
      }
      return;
    }

    if (request.method === "POST" && child === "execute") {
      const planned = plannedSessionFromStore(this.runtime, sessionId);
      sendJson(response, 202, { run: this.startPlannedExecution(planned), session: sessionSnapshot(this.runtime, sessionId, this.approvalQueueView(sessionId, 80)) });
      return;
    }

    if (request.method === "POST" && child === "fork") {
      const body = await readJsonBody(request);
      const planned = await this.runtime.forkSession(sessionId, optionalString(body.message));
      sendJson(response, 201, { session: sessionSnapshot(this.runtime, planned.session.session_id, this.approvalQueueView(planned.session.session_id, 80)), plan: planned.plan });
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
      sendJson(response, 200, this.approvalQueueView(sessionId, integerParam(url, "limit", 80)));
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
    url: URL,
    approvalId?: string,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && !approvalId) {
      const sessionId = url.searchParams.get("session_id") ?? undefined;
      sendJson(response, 200, this.approvalQueueView(sessionId, integerParam(url, "limit", 100)));
      return;
    }

    if (!approvalId) {
      throw new HttpError(404, "Approval id is required.");
    }

    if (request.method === "GET" && !child) {
      sendJson(response, 200, this.approvalDetail(approvalId));
      return;
    }

    if (request.method === "POST" && child === "decision") {
      const body = await readJsonBody(request);
      const approved = body.approved === true || body.decision === "approved" || body.status === "approved";
      const decision = this.applyApprovalDecision(approvalId, approved);
      if (decision.session_id) {
        const approvalEnvelope = approvalEnvelopeForRequest(decision.request, decision.status, {
          actor_id: "gateway.local",
          actor_role: "http_gateway",
          decision_source: "gateway.approval.decision",
          swarm_id: this.runtime.sessionStore.get(decision.session_id)?.swarm_id,
          correlation_id: optionalString(body.correlation_id ?? body.correlationId),
          now: new Date().toISOString()
        });
        if (approvalEnvelope) {
          this.runtime.router.receive(approvalEnvelope);
        }
        this.emitGatewayControlEnvelope({
          request,
          body,
          sessionId: decision.session_id,
          taskId: approvalId,
          type: "blackboard.write",
          intent: "gateway.approval.decision",
          route: `/v1/approvals/${approvalId}/decision`,
          action: "approval.decision",
          status: decision.status,
          payload: {
            approval_id: approvalId,
            approved,
            decision: decision.status,
            session_id: decision.session_id,
            approval_envelope_id: approvalEnvelope?.id,
            governance: decision.request.governance
          }
        });
      }
      const { request: _request, ...responseBody } = decision;
      sendJson(response, 200, responseBody);
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
      const limit = integerParam(url, "limit", 50);
      const parent = url.searchParams.get("parent_session_id") ?? undefined;
      const workers = parent
        ? this.runtime.workerStateStore.listByParent(parent)
        : this.runtime.workerStateStore.listRecent(limit);
      const workerContracts = this.runtime.listWorkerContracts(parent, limit);
      sendJson(response, 200, {
        workers,
        worker_contracts: workerContracts,
        work_contract_summary: parent ? this.runtime.getWorkSnapshot(parent).work_contracts.summary : undefined
      });
      return;
    }

    if (request.method === "GET" && workerId && !child) {
      const worker = this.runtime.workerStateStore.get(workerId);
      if (!worker) {
        throw new HttpError(404, `Unknown worker: ${workerId}`);
      }
      const workerSession = worker.worker_session_id && this.runtime.sessionStore.get(worker.worker_session_id)
        ? sessionSnapshot(this.runtime, worker.worker_session_id, this.approvalQueueView(worker.worker_session_id, 80))
        : undefined;
      sendJson(response, 200, {
        worker,
        worker_contract: this.runtime.getWorkerContract(workerId),
        worker_session: workerSession
      });
      return;
    }

    if (request.method === "POST" && workerId && child === "stop") {
      const body = await readJsonBody(request);
      const worker = this.runtime.workerStateStore.get(workerId);
      if (!worker) {
        throw new HttpError(404, `Unknown worker: ${workerId}`);
      }
      const reason = optionalString(body.reason) ?? "Gateway stop requested.";
      this.emitGatewayControlEnvelope({
        request,
        body,
        sessionId: worker.parent_session_id,
        taskId: worker.worker_id,
        type: "task.cancel",
        intent: "gateway.worker.stop",
        route: `/v1/workers/${workerId}/stop`,
        action: "worker.stop",
        status: "requested",
        payload: {
          worker_id: worker.worker_id,
          worker_status: worker.status,
          worker_session_id: worker.worker_session_id,
          handoff_id: worker.handoff_id,
          reason
        }
      });
      this.runtime.stopWorker(workerId);
      sendJson(response, 202, { worker_id: workerId, status: "stop_requested" });
      return;
    }

    if (request.method === "POST" && workerId && child === "continue") {
      const body = await readJsonBody(request);
      const message = optionalString(body.message ?? body.instruction ?? body.prompt);
      if (!message) {
        throw new HttpError(400, "Missing string field: message");
      }
      const worker = this.runtime.workerStateStore.get(workerId);
      if (!worker) {
        throw new HttpError(404, `Unknown worker: ${workerId}`);
      }
      this.emitGatewayControlEnvelope({
        request,
        body,
        sessionId: worker.parent_session_id,
        taskId: worker.worker_id,
        type: "task.assign",
        intent: "gateway.worker.continue",
        route: `/v1/workers/${workerId}/continue`,
        action: "worker.continue",
        status: "requested",
        payload: {
          worker_id: worker.worker_id,
          worker_status: worker.status,
          worker_session_id: worker.worker_session_id,
          handoff_id: worker.handoff_id,
          message
        }
      });
      const result = await this.runtime.continueAgent(workerId, message);
      sendJson(response, 200, { worker_id: workerId, result });
      return;
    }

    throw new HttpError(404, "Unknown worker route.");
  }

  private async handleHandoffs(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    handoffId?: string,
    child?: string
  ): Promise<void> {
    if (request.method === "GET" && !handoffId) {
      const limit = integerParam(url, "limit", 50);
      const parent = url.searchParams.get("parent_session_id") ?? undefined;
      const handoffs = parent
        ? this.runtime.handoffStore.listByParent(parent)
        : this.runtime.listHandoffs(limit);
      sendJson(response, 200, {
        handoffs,
        handoff_contracts: this.runtime.listHandoffContracts(parent, limit),
        work_contract_summary: parent ? this.runtime.getWorkSnapshot(parent).work_contracts.summary : undefined
      });
      return;
    }

    if (request.method === "GET" && handoffId && !child) {
      const handoff = this.runtime.getHandoff(handoffId);
      if (!handoff) {
        throw new HttpError(404, `Unknown handoff: ${handoffId}`);
      }
      sendJson(response, 200, { handoff, handoff_contract: this.runtime.getHandoffContract(handoffId) });
      return;
    }

    if (request.method === "POST" && handoffId && child === "take-back") {
      const body = await readJsonBody(request);
      const existing = this.runtime.getHandoff(handoffId);
      if (!existing) {
        throw new HttpError(404, `Unknown handoff: ${handoffId}`);
      }
      if (existing.status !== "active") {
        sendJson(response, 202, existing);
        return;
      }
      const reason = optionalString(body.reason) ?? "Taken back through the Swarm Gateway.";
      const previousOwner = existing.owner_agent_id ?? `worker:${existing.worker_id}`;
      const envelope = this.emitGatewayControlEnvelope({
        request,
        body,
        sessionId: existing.parent_session_id,
        taskId: existing.handoff_id,
        type: "handoff.take_back",
        intent: "gateway.handoff.take_back",
        route: `/v1/handoffs/${handoffId}/take-back`,
        action: "handoff.take_back",
        status: "requested",
        replyTo: existing.accept_envelope_id ?? existing.request_envelope_id,
        correlationId: optionalString(body.correlation_id ?? body.correlationId) ?? existing.request_envelope_id ?? existing.accept_envelope_id ?? existing.handoff_id,
        to: { agent_id: previousOwner, role: "worker" },
        payload: {
          handoff_id: existing.handoff_id,
          worker_id: existing.worker_id,
          requester_agent_id: GATEWAY_ACTOR_ID,
          reason,
          previous_owner: previousOwner,
          resulting_owner: GATEWAY_ACTOR_ID,
          owner_agent_id: previousOwner,
          target_agent_spec_id: existing.target_agent_spec_id,
          protocol: "gateway_handoff_ownership_protocol"
        }
      });
      const handoff = this.runtime.handoffStore.takeBack(handoffId, {
        requester_agent_id: GATEWAY_ACTOR_ID,
        reason,
        envelope_id: envelope.id
      });
      const worker = this.runtime.workerStateStore.requestStop(handoff.worker_id);
      this.runtime.events.emitEvent({ type: "worker", worker, status: worker.status, message: "Handoff taken back through the Swarm Gateway." });
      this.runtime.events.emitEvent({ type: "handoff_taken_back", handoff });
      sendJson(response, 202, handoff);
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

  private pendingApprovalRequests(sessionId?: string, limit = 100): ToolApprovalRequest[] {
    const sessionIds = this.sessionScopeIds(sessionId);
    return [...this.pendingApprovals.values()]
      .filter((item) => !sessionId || (item.request.session_id ? sessionIds.has(item.request.session_id) : false))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((item) => item.request);
  }

  private approvalQueueView(sessionId?: string, limit = 100): ApprovalQueueView {
    const sessionIds = this.sessionScopeIds(sessionId);
    const pendingRequests = this.pendingApprovalRequests(sessionId, limit);
    const approvals = this.listApprovalsForSessions(sessionIds, limit);
    return {
      session_id: sessionId,
      session_ids: sessionId ? [...sessionIds] : undefined,
      pending_requests: pendingRequests,
      actionable_approval_ids: pendingRequests.map((request) => request.id),
      approvals,
      summary: {
        actionable_pending: pendingRequests.length,
        persisted_pending: approvals.filter((approval) => approval.status === "pending").length,
        approved: approvals.filter((approval) => approval.status === "approved").length,
        denied: approvals.filter((approval) => approval.status === "denied").length
      }
    };
  }

  private listApprovalsForSessions(sessionIds: Set<string>, limit: number): ApprovalRecord[] {
    if (sessionIds.size === 0) {
      return this.runtime.approvalStore.list(undefined, limit);
    }
    const records = [...sessionIds]
      .flatMap((sessionId) => this.runtime.approvalStore.list(sessionId, Math.max(limit * 2, limit)))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.approval_id.localeCompare(left.approval_id));
    const seen = new Set<string>();
    const deduped: ApprovalRecord[] = [];
    for (const record of records) {
      if (seen.has(record.approval_id)) {
        continue;
      }
      seen.add(record.approval_id);
      deduped.push(record);
      if (deduped.length >= limit) {
        break;
      }
    }
    return deduped;
  }

  private sessionScopeIds(sessionId?: string): Set<string> {
    if (!sessionId) {
      return new Set<string>();
    }
    return new Set(this.runtime.listSessionFamilySessionIds(sessionId, 1_000));
  }

  private eventMatchesSession(event: RuntimeEvent, sessionId?: string): boolean {
    if (!sessionId) {
      return true;
    }
    const eventId = eventSessionId(event);
    return eventId ? this.sessionScopeIds(sessionId).has(eventId) : false;
  }

  private approvalDetail(approvalId: string): {
    approval: ApprovalRecord;
    actionable: boolean;
    pending_request?: ToolApprovalRequest;
    gateway_pending_created_at?: string;
  } {
    const approval = this.runtime.approvalStore.get(approvalId);
    const pending = this.pendingApprovals.get(approvalId);
    if (!approval && !pending) {
      throw new HttpError(404, `Unknown approval: ${approvalId}`);
    }
    return {
      approval: approval ?? {
        approval_id: pending!.request.id,
        session_id: pending!.request.session_id,
        task_id: pending!.request.task_id,
        action: pending!.request.action,
        summary: pending!.request.summary,
        detail: pending!.request.detail,
        risk: pending!.request.risk,
        risk_class: pending!.request.risk_class,
        target: pending!.request.target,
        status: "pending",
        challenge: pending!.request,
        created_at: pending!.created_at,
        updated_at: pending!.created_at
      },
      actionable: Boolean(pending),
      pending_request: pending?.request,
      gateway_pending_created_at: pending?.created_at
    };
  }

  private applyApprovalDecision(approvalId: string, approved: boolean): {
    approval_id: string;
    status: "approved" | "denied";
    session_id?: string;
    request: ToolApprovalRequest;
  } {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      const approval = this.runtime.approvalStore.get(approvalId);
      if (!approval) {
        throw new HttpError(404, `Unknown approval: ${approvalId}`);
      }
      if (approval.status === "pending") {
        throw new HttpError(409, `Approval is recorded as pending but is not actionable in this gateway process: ${approvalId}`);
      }
      throw new HttpError(409, `Approval is not pending in this gateway process: ${approvalId} current_status=${approval.status}`);
    }
    pending.resolve(approved);
    this.pendingApprovals.delete(approvalId);
    return {
      approval_id: approvalId,
      status: approved ? "approved" : "denied",
      session_id: pending.request.session_id,
      request: pending.request
    };
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
    const at = new Date().toISOString();
    const work = buildWorkRecordFromRuntimeEvent(event, at);
    this.eventBuffer.push({ id, at, event, work });
    if (this.eventBuffer.length > EVENT_BUFFER_LIMIT) {
      this.eventBuffer.shift();
    }
    for (const client of this.clients.values()) {
      if (!this.eventMatchesSession(event, client.sessionId)) {
        continue;
      }
      client.replayWindow = this.eventBuffer.length;
      writeGatewayEvent(client, id, { at, event, work }, this.eventBuffer.length);
    }
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse, sessionId?: string, protocol: "runtime" | "work" = "runtime"): void {
    const requestedLastEventId = this.parseLastEventId(optionalHeader(request.headers["last-event-id"]));
    const replayState = this.computeReplayState(requestedLastEventId);
    const client: SseClient = {
      id: `sse_${randomUUID()}`,
      sessionId,
      protocol,
      lastEventId: replayState.lastEventId,
      replayWindow: replayState.replayWindow,
      missedEventsHint: replayState.missedEventsHint,
      response
    };
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    writeSse(response, 0, "ready", {
      schema_version: GATEWAY_STREAM_SCHEMA_VERSION,
      session_id: sessionId,
      protocol,
      message: "Swarm Gateway event stream connected.",
      last_event_id: replayState.lastEventId,
      replay_window: replayState.replayWindow,
      missed_events_hint: replayState.missedEventsHint
    });
    for (const item of replayState.replayedEvents) {
      if (!this.eventMatchesSession(item.event, sessionId)) {
        continue;
      }
      writeGatewayEvent(client, item.id, item, replayState.replayWindow, replayState.missedEventsHint);
    }
    this.clients.set(client.id, client);
    response.on("close", () => {
      this.clients.delete(client.id);
    });
  }

  private parseLastEventId(value: string | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
  }

  private computeReplayState(requestedLastEventId?: number): {
    lastEventId?: number;
    replayWindow: number;
    missedEventsHint?: GatewayReplayMissedEventsHint;
    replayedEvents: GatewayEventBufferEntry[];
  } {
    const replayWindow = this.eventBuffer.length ? this.eventBuffer[this.eventBuffer.length - 1]!.id - this.eventBuffer[0]!.id + 1 : 0;
    if (requestedLastEventId === undefined || !this.eventBuffer.length) {
      return {
        lastEventId: this.eventBuffer.at(-1)?.id,
        replayWindow,
        replayedEvents: this.eventBuffer
      };
    }
    const oldestId = this.eventBuffer[0]!.id;
    const newestId = this.eventBuffer.at(-1)!.id;
    const missed = requestedLastEventId < oldestId - 1;
    const replayedEvents = this.eventBuffer.filter((item) => item.id > requestedLastEventId);
    return {
      lastEventId: newestId,
      replayWindow,
      missedEventsHint: missed
        ? {
            requested_last_event_id: requestedLastEventId,
            oldest_replayable_event_id: oldestId,
            replay_window: replayWindow,
            missed: true
          }
        : undefined,
      replayedEvents
    };
  }
}

function sessionSnapshot(runtime: SwarmRuntime, sessionId: string, approvals?: Record<string, unknown>): Record<string, unknown> {
  try {
    const snapshot = buildSessionSnapshot(runtime, sessionId, { approvals });
    return approvals
      ? { ...snapshot, approvals }
      : snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Unknown session: ")) {
      throw new HttpError(404, message);
    }
    throw error;
  }
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
    schema_version: GATEWAY_RESPONSE_SCHEMA_VERSION,
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

function stripUndefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function gatewayAuthActor(request: IncomingMessage | undefined): string {
  if (!request) {
    return "gateway.local";
  }
  if (optionalHeader(request.headers.authorization)) {
    return "gateway.http.bearer";
  }
  if (optionalHeader(request.headers["x-swarm-gateway-token"])) {
    return "gateway.http.token";
  }
  if (optionalHeader(request.headers["x-swarm-local-control"])) {
    return "gateway.local.control";
  }
  return request.socket.remoteAddress ? `gateway.remote:${request.socket.remoteAddress}` : "gateway.http";
}

function symphonyOperatorAction(value: unknown): SymphonyOperatorAction {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "Missing string field: action");
  }
  const action = value.trim().toLowerCase();
  if (action === "pause" || action === "resume" || action === "cancel" || action === "retry") {
    return action;
  }
  throw new HttpError(400, `Invalid Symphony operator action: ${value}. Expected pause, resume, cancel, or retry.`);
}

function unsupportedSymphonyActionRecovery(action: Exclude<SymphonyOperatorAction, "cancel">): {
  message: string;
  recovery: string;
} {
  return {
    message: `Symphony operator action ${action} is not supported by this local gateway yet.`,
    recovery: "Use /status or GET /v1/symphony/status to inspect current state. Use action=cancel for local cancellation, or wait for the scheduled retry path instead of forcing this action."
  };
}

function parseWorkItem(value: string | null | undefined): WorkItem | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as WorkItem;
    return isWorkItem(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isWorkItem(value: unknown): value is WorkItem {
  return typeof value === "object" &&
    value !== null &&
    "source" in value &&
    "title" in value &&
    "labels" in value &&
    "metadata" in value &&
    typeof (value as { source?: unknown }).source === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    Array.isArray((value as { labels?: unknown }).labels) &&
    typeof (value as { metadata?: unknown }).metadata === "object" &&
    (value as { metadata?: unknown }).metadata !== null;
}

function isTerminalSessionStatus(value: string): boolean {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, next]) => [key, String(next)]));
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

function capabilityInvocationArguments(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.arguments ?? body.args ?? {};
  if (!isRecord(value)) {
    throw new HttpError(400, "Capability invocation arguments must be an object.");
  }
  return value;
}

function capabilityInvocationWritePolicy(body: Record<string, unknown>): SandboxWritePolicy | undefined {
  if (body.read_only === true || body.readOnly === true) {
    return "read_only";
  }
  const value = optionalString(body.write_policy ?? body.writePolicy ?? body.sandbox_mode ?? body.sandboxMode ?? body.sandbox);
  if (!value) {
    return undefined;
  }
  if (value === "workspace_write" || value === "workspace-write") {
    return "workspace_write";
  }
  if (value === "scoped_write" || value === "scoped-write") {
    return "scoped_write";
  }
  if (value === "read_only" || value === "read-only" || value === "readonly") {
    return "read_only";
  }
  throw new HttpError(400, "Capability invocation sandbox must be workspace_write, scoped_write, or read_only.");
}

function capabilityInvocationFileScope(body: Record<string, unknown>): string[] | undefined {
  const value = body.file_scope ?? body.fileScope;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "Capability invocation file_scope must be an array of relative paths.");
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (normalized.length !== value.length) {
    throw new HttpError(400, "Capability invocation file_scope must contain only non-empty strings.");
  }
  return normalized;
}

function positiveBodyInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function gatewayIndex(): Record<string, unknown> {
  return {
    service: "swarm-gateway",
    role: "local API and event-stream surface",
    product_ui: "CLI TUI only; run `swarm` and use `/kernel` or `/status` for the operator view.",
    routes: PUBLIC_API_SURFACE
  };
}

function writeGatewayEvent(
  client: SseClient,
  id: number,
  item: { at: string; event: RuntimeEvent; work: WorkProtocolRecord },
  replayWindow: number,
  missedEventsHint?: GatewayReplayMissedEventsHint
): void {
  if (client.protocol === "work") {
    writeSse(client.response, id, item.work.kind, {
      ...item.work,
      gateway_schema_version: GATEWAY_STREAM_SCHEMA_VERSION,
      sequence: id,
      last_event_id: id,
      replay_window: replayWindow,
      missed_events_hint: missedEventsHint
    });
    return;
  }
  writeSse(client.response, id, item.event.type, {
    schema_version: GATEWAY_STREAM_SCHEMA_VERSION,
    sequence: id,
    last_event_id: id,
    replay_window: replayWindow,
    missed_events_hint: missedEventsHint,
    at: item.at,
    event: item.event,
    work: item.work
  });
}

function liveReplyHttpError(error: unknown): HttpError {
  const message = errorMessage(error);
  if (message.includes("No active work is available to receive a live reply.")
    || message.startsWith("Active live target is ")) {
    return new HttpError(409, message);
  }
  return new HttpError(500, message);
}

function interruptHttpError(error: unknown): HttpError {
  const message = errorMessage(error);
  if (message.includes("No active work is available to interrupt.")
    || message.startsWith("Active live target is ")) {
    return new HttpError(409, message);
  }
  return new HttpError(500, message);
}
