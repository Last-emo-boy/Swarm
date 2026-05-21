import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { SwarmSession } from "../protocol/types.js";
import { SwarmRuntime } from "../runtime/runtime.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { SandboxWritePolicy } from "../runtime/sandbox-policy.js";
import { buildWorkRecordFromRuntimeEvent, type WorkProtocolRecord } from "../runtime/work-protocol.js";
import type { ExecutionResult, PlannedSession, ToolApprovalHandler } from "../runtime/orchestrator.js";
import type { RunMode } from "../runtime/execution-router.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import { installPluginRoot, removePluginRoot, setCapabilityEnabled, setCapabilityModelVisible, setPluginEnabled } from "../config/settings.js";
import type { SymphonyScheduler } from "../symphony/scheduler.js";
import { SymphonyDaemonManager } from "../symphony/daemon.js";
import type { CapabilityFilter } from "../extensions/types.js";
import { summarizeCapabilityCatalog, summarizeMcpCatalog, summarizePluginCatalog, summarizeSkillCatalog } from "../extensions/catalog-summary.js";
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
  response: ServerResponse;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 38171;
const EVENT_BUFFER_LIMIT = 500;
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
  private readonly eventBuffer: { id: number; at: string; event: RuntimeEvent; work: WorkProtocolRecord }[] = [];
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
        this.openEventStream(response, undefined, "runtime");
        return;
      }

      if (request.method === "GET" && segments[0] === "v1" && segments[1] === "work-events") {
        this.openEventStream(response, undefined, "work");
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
      sendJson(response, 200, { skills, summary: summarizeSkillCatalog(skills) });
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
      sendJson(response, 200, { servers, summary: summarizeMcpCatalog(servers) });
      return;
    }

    if (resource === "servers" && request.method === "GET" && serverId) {
      const server = this.runtime.listMcpServers().find((item) => item.id === serverId);
      if (!server) {
        throw new HttpError(404, `Unknown MCP server: ${serverId}`);
      }
      sendJson(response, 200, { server, summary: summarizeMcpCatalog([server]) });
      return;
    }

    if (resource === "servers" && request.method === "POST" && serverId && action === "refresh") {
      const server = await this.runtime.refreshMcpServer(serverId);
      const capabilities = await this.runtime.listCapabilities({ providerId: `mcp:${serverId}`, includeDisabled: true });
      sendJson(response, 200, { server, capabilities, summary: summarizeMcpCatalog([server]) });
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
            status: "active",
            active_target: activeTarget,
            controls: {
              reply: true,
              interrupt: true
            },
            session: sessionSnapshot(this.runtime, activeTarget.session_id, this.approvalQueueView(activeTarget.session_id, 80))
          }
        : {
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
        const target = await this.runtime.sendUserMessage(stringField(body, "content"), {
          requestId: optionalString(body.request_id ?? body.requestId)
        });
        sendJson(response, 200, { status: "applied", session_id: target.session_id, route: target.route, request_id: target.request_id, duplicate: target.duplicate === true, control: target.control });
      } catch (error) {
        throw liveReplyHttpError(error);
      }
      return;
    }

    if (request.method === "POST" && child === "interrupt") {
      const body = await readJsonBody(request);
      try {
        const target = this.runtime.requestInterrupt(optionalString(body.content) ?? "User requested an interrupt through the Swarm Gateway.", {
          requestId: optionalString(body.request_id ?? body.requestId)
        });
        sendJson(response, 200, { status: "applied", session_id: target.session_id, route: target.route, request_id: target.request_id, duplicate: target.duplicate === true, control: target.control });
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
      this.openEventStream(response, sessionId, "runtime");
      return;
    }

    if (request.method === "GET" && child === "work-events") {
      this.openEventStream(response, sessionId, "work");
      return;
    }

    if (request.method === "POST" && child === "messages") {
      const body = await readJsonBody(request);
      try {
        const target = await this.runtime.sendUserMessage(stringField(body, "content"), {
          sessionId,
          requestId: optionalString(body.request_id ?? body.requestId)
        });
        sendJson(response, 200, { status: "applied", session_id: target.session_id, route: target.route, request_id: target.request_id, duplicate: target.duplicate === true, control: target.control });
      } catch (error) {
        throw liveReplyHttpError(error);
      }
      return;
    }

    if (request.method === "POST" && child === "interrupt") {
      const body = await readJsonBody(request);
      try {
        const target = this.runtime.requestInterrupt(optionalString(body.content) ?? "User requested an interrupt through the Swarm Gateway.", {
          sessionId,
          requestId: optionalString(body.request_id ?? body.requestId)
        });
        sendJson(response, 200, { status: "applied", session_id: target.session_id, route: target.route, request_id: target.request_id, duplicate: target.duplicate === true, control: target.control });
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
      sendJson(response, 200, this.applyApprovalDecision(approvalId, approved));
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
      session_id: pending.request.session_id
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
      writeGatewayEvent(client, id, { at, event, work });
    }
  }

  private openEventStream(response: ServerResponse, sessionId?: string, protocol: "runtime" | "work" = "runtime"): void {
    const client: SseClient = {
      id: `sse_${randomUUID()}`,
      sessionId,
      protocol,
      response
    };
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    writeSse(response, 0, "ready", { session_id: sessionId, protocol, message: "Swarm Gateway event stream connected." });
    for (const item of this.eventBuffer) {
      if (!this.eventMatchesSession(item.event, sessionId)) {
        continue;
      }
      writeGatewayEvent(client, item.id, item);
    }
    this.clients.set(client.id, client);
    response.on("close", () => {
      this.clients.delete(client.id);
    });
  }
}

function sessionSnapshot(runtime: SwarmRuntime, sessionId: string, approvals?: Record<string, unknown>): Record<string, unknown> {
  try {
    return approvals
      ? { ...buildSessionSnapshot(runtime, sessionId), approvals }
      : buildSessionSnapshot(runtime, sessionId);
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
  item: { at: string; event: RuntimeEvent; work: WorkProtocolRecord }
): void {
  if (client.protocol === "work") {
    writeSse(client.response, id, item.work.kind, item.work);
    return;
  }
  writeSse(client.response, id, item.event.type, {
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
