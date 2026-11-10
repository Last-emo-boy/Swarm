/**
 * The gateway of the ticket VMs: one listener per slot on 127.0.0.1, the only address a slot's VM may reach on this host
 * (the deployment's egress rules), which takes that slot's token alone. It serves the guest what the mesh's work routes
 * serve a paired node (src/mesh/work.ts): the ticket's start, reads, reports and tools, answered with this host's store;
 * and what stays on this host: the providers' keys, through the model proxy, and the requester's GitHub token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { loadSwarmSettings, resolveModelRef, type ProviderDefinition, type SwarmSettings } from "../../config/settings.js";
import { HttpError, errorMessage, readJsonBody, sendJson } from "../../server/gateway-http.js";
import { watchedRepository } from "../policy.js";
import { usageRecorder } from "../provider.js";
import { PatchSchema, patchPath, ticketTools, type TicketTool } from "../ticket-tools.js";
import { ReportSchema, workDelivered, workStart, workView } from "../work-link.js";
import { workerAccounts, type WorkerAccounts } from "../environment.js";
import { harnessProfiles, type HarnessProfile } from "../harness.js";
import { workerExited } from "../executor.js";
import type { Ticket } from "../core/index.js";
import type { Deployment } from "../setup.js";
import { sameName } from "../text.js";
import { proxyError, proxyModel } from "./model-proxy.js";
import type { VmSlot, VmWork } from "./vm-work.js";

/** What a guest needs to prepare its ticket and start its worker, which it reads first from its gateway. */
export interface GuestSpec {
  ticketId: string;
  assignmentId: string;
  /** The ticket's short name, which names its branch. */
  name: string;
  /** The ticket's directory, the same path in the guest as in this host's records. */
  directory: string;
  variables: Record<string, string>;
  /** The prepare command of a ticket of the watched repository. */
  prepare: string;
  /** The repository to clone instead, for a ticket of its requester's own one. */
  clone?: string;
  /** The ticket whose patch this one takes over, which the guest applies once prepared. */
  from?: string;
  /** Whose accounts the worker uses: with a GitHub account, the guest reads its token from the gateway. */
  accounts: WorkerAccounts;
  blockedCommands: string[];
  permissionMode: string;
  /** Swarm's models, and the providers they use, whose base URLs the guest points at its gateway. */
  models: SwarmSettings["models"];
  providers: Record<string, ProviderDefinition>;
  /** The model reference the worker works with: the executor's, or Swarm's worker model. */
  model: string;
  /** The OpenCode profile the ticket runs on, without its command and keys, which stay on this host. */
  harness?: { id: string; profile: HarnessProfile };
}

const exec = promisify(execFile);

type Handler = (request: GatewayRequest) => unknown;
interface GatewayRequest { slot: number; record: VmSlot; params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> }

/** The token a guest sends: as a bearer token, a provider's key header, or Gemini's key parameter. */
function tokenOf(request: IncomingMessage, url: URL): string {
  const bearer = /^Bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
  const header = request.headers["x-api-key"] ?? request.headers["x-goog-api-key"];
  return bearer ?? (typeof header === "string" ? header : url.searchParams.get("key") ?? "");
}

/**
 * Whose accounts a ticket's worker uses, as the executor gives them to a worker here: its requester's only with a
 * repository, and the agent's only on a host that has an agent account.
 */
function accountsOf(ticket: Ticket, deployment: Deployment): WorkerAccounts {
  const { capability } = ticket.mandate;
  const accounts = workerAccounts(capability, !!capability?.credential && !!capability.repository);
  return accounts === "agent" && !deployment.github ? "none" : accounts;
}

/** A harness profile as a guest gets it: its harness's command is the VM image's, and its keys stay on this host. */
const guestProfile = ({ command: _command, keys: _keys, ...rest }: HarnessProfile): HarnessProfile => ({ ...rest, keys: {} });

/** The providers Swarm's models use, whose definitions a guest needs. */
function usedProviders(settings: SwarmSettings, extra: (string | null | undefined)[]): Record<string, ProviderDefinition> {
  const refs = [settings.models.planner, settings.models.worker, settings.models.aggregator, ...extra].filter((ref): ref is string => !!ref);
  return Object.fromEntries(refs.flatMap((ref) => {
    const { providerId, provider } = resolveModelRef(ref, settings);
    return provider ? [[providerId, provider] as const] : [];
  }));
}

export class VmGateway {
  private readonly servers: Server[] = [];
  private readonly routes: { method: string; parts: string[]; handler: Handler }[] = [];
  private readonly toolsets = new Map<string, TicketTool[]>();
  private readonly onUsage = usageRecorder();

  constructor(private readonly work: VmWork) {
    this.register();
  }

  private get client() { return this.work.host.client; }

  /** Listens on `port` + slot on 127.0.0.1 for each of `slots` slots. */
  async listen(slots: number, port: number): Promise<void> {
    for (let slot = 0; slot < slots; slot++) {
      const server = createServer((request, response) => { void this.handle(slot, request, response); });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port + slot, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      this.servers.push(server);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
    this.servers.length = 0;
  }

  private route(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
  }

  private async handle(slot: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gateway");
    const record = this.work.authorized(slot, tokenOf(request, url));
    const model = /^\/v1\/model\/([\w.-]+)(\/.*)?$/.exec(url.pathname);
    if (model) {
      try {
        if (!record) throw new HttpError(401, "This token holds no ticket VM's lease");
        await proxyModel({ providerId: model[1]!, rest: model[2] ?? "", query: url.searchParams, ticketId: record.ticketId, onUsage: await this.onUsage }, request, response);
      } catch (error) {
        proxyError(response, error);
      }
      return;
    }
    try {
      if (!record) throw new HttpError(401, "This token holds no ticket VM's lease");
      const found = this.match(request.method ?? "GET", url.pathname);
      if (!found) throw new HttpError(404, `No gateway route ${request.method} ${url.pathname}`);
      const body = request.method === "GET" ? {} : await readJsonBody(request);
      sendJson(response, 200, await found.handler({ slot, record, params: found.params, query: url.searchParams, body }) ?? {});
    } catch (error) {
      // What the Engine or the tools refuse reaches the guest with their reason, as it reaches a worker here.
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 422;
      if (!response.headersSent) sendJson(response, status, { error: { status, message: errorMessage(error) } });
      else response.end();
    }
  }

  private match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (route.parts.every((part, index) => part.startsWith(":") ? (params[part.slice(1)] = decodeURIComponent(parts[index]!), true) : part === parts[index])) {
        return { handler: route.handler, params };
      }
    }
    return undefined;
  }

  /** The ticket the slot runs, while its Assignment is the one the slot holds. */
  private ticket({ record }: GatewayRequest) {
    const ticket = this.client.store.tickets.get(record.ticketId);
    if (!ticket) throw new HttpError(410, "The ticket is gone");
    return ticket;
  }

  private toolset(ticketId: string): TicketTool[] {
    let tools = this.toolsets.get(ticketId);
    if (!tools) {
      tools = ticketTools(this.client, ticketId);
      this.toolsets.set(ticketId, tools);
    }
    return tools;
  }

  private register(): void {
    const { client } = this;
    this.route("GET", "/v1/spec", (request) => this.spec(request));
    this.route("GET", "/v1/work", ({ record }) => ({ view: workView(client, record.ticketId, record.assignmentId) ?? null }));
    this.route("GET", "/v1/work/start", (request) => {
      const ticket = this.ticket(request);
      return workStart(client, this.work.host.deployment(), ticket, request.query.get("directory") || ticket.execution!.directory);
    });
    this.route("POST", "/v1/work/started", ({ slot, body }) => {
      this.work.started(slot, z.string().min(1).parse(body.directory));
      return { started: true };
    });
    this.route("POST", "/v1/work/heartbeat", ({ slot }) => ({ live: this.work.renew(slot) }));
    this.route("POST", "/v1/work/delivered", ({ record, body }) => {
      workDelivered(client, record.ticketId, record.assignmentId, z.array(z.string()).parse(body.inputIds));
      return {};
    });
    this.route("POST", "/v1/work/turn", ({ record }) => {
      client.engine.turnEnded(record.ticketId, record.assignmentId);
      return {};
    });
    this.route("POST", "/v1/work/report", ({ record, body }) => {
      client.engine.report(record.ticketId, ReportSchema.parse(body.report));
      return {};
    });
    this.route("POST", "/v1/work/tools/:tool", async ({ record, params, body }) => {
      const tool = this.toolset(record.ticketId).find((item) => item.name === params.tool);
      if (!tool) throw new HttpError(404, `No ticket tool ${params.tool}`);
      const args = (body.args ?? {}) as Record<string, unknown>;
      // The patch of a local ticket's ready report comes from the guest's directory, not from its model: see `withPatch`.
      const patch = tool.name === "report" && args.patch !== undefined ? { patch: PatchSchema.parse(args.patch) } : {};
      return { result: await tool.run({ ...z.object(tool.input).parse(args), ...patch }) };
    });
    this.route("POST", "/v1/work/exited", async ({ slot, record, body }) => {
      const code = z.number().int().nullable().parse(body.code ?? null);
      const stderr = String(body.stderr ?? "");
      if (code !== 0) this.work.host.log(`superagent: the worker of ticket ${record.ticketId.slice(0, 8)} in ticket VM ${slot} exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
      workerExited(client, record.ticketId, record.assignmentId, code, stderr, `ticket VM ${slot}`);
      this.toolsets.delete(record.ticketId);
      // The guest powers off next; the slot boots the ticket again on a follow-up.
      await this.work.release(slot);
      return {};
    });
    // The token of the GitHub account the worker uses: its requester's, or the agent's for work that may use the agent's.
    this.route("GET", "/v1/github", async (request) => {
      const ticket = this.ticket(request);
      const { capability } = ticket.mandate;
      const accounts = accountsOf(ticket, this.work.host.deployment());
      if (accounts === "requester") {
        const credential = await this.work.host.credential(ticket);
        if (!credential) throw new HttpError(409, `@${capability!.credential!.login}'s GitHub link does not work`);
        return { token: credential.token, login: credential.login, repository: capability!.repository };
      }
      const github = this.work.host.deployment().github;
      if (accounts !== "agent" || !github) throw new HttpError(403, "This ticket's worker uses no GitHub account");
      const { stdout } = await exec(github.cli, ["auth", "token"], { timeout: 30_000 });
      return { token: stdout.trim(), login: github.login };
    });
    this.route("GET", "/v1/takeover", (request) => {
      const from = this.ticket(request).mandate.capability?.from;
      const source = from ? client.store.tickets.get(from) : undefined;
      const path = source && patchPath(client.stateDir, source);
      if (!path || !existsSync(path)) throw new HttpError(404, "There is no patch to take over");
      return { patch: readFileSync(path, "utf8") };
    });
  }

  private spec(request: GatewayRequest): GuestSpec {
    const ticket = this.ticket(request);
    const settings = this.client.settings();
    const swarm = loadSwarmSettings();
    const { capability } = ticket.mandate;
    const directory = ticket.execution!.directory;
    const repository = capability?.repository;
    const harness = ticket.execution?.harness;
    const profile = harness ? harnessProfiles(settings.executor.harnesses)[harness] : undefined;
    return {
      ticketId: ticket.id, assignmentId: request.record.assignmentId, name: ticket.execution!.name, directory,
      variables: { ...this.work.host.environment(ticket), SWARM_TICKET_DIR: directory },
      prepare: settings.executor.prepare,
      ...(repository && !sameName(repository, watchedRepository(settings)) ? { clone: repository } : {}),
      ...(capability?.from ? { from: capability.from } : {}),
      accounts: accountsOf(ticket, this.work.host.deployment()), blockedCommands: settings.executor.blockedCommands, permissionMode: settings.executor.permissionMode,
      models: swarm.models, providers: usedProviders(swarm, [settings.executor.model]), model: settings.executor.model ?? swarm.models.worker,
      ...(harness && profile ? { harness: { id: harness, profile: guestProfile(profile) } } : {})
    };
  }
}
