/**
 * A node's mesh server: plain JSON over HTTP, meant for a private network such as a tailnet, which encrypts the
 * traffic. Every route but `health` and `pair` needs the bearer token this node issued the calling peer. Later
 * features add their routes with `route()`, or with `endpoint()` when they write the response themselves.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod/v4";
import { HttpError, errorMessage, readJsonBody, sendJson } from "../server/gateway-http.js";
import { tailnetAddress, type NodeCard } from "./card.js";
import { parseListen } from "./listen.js";
import { hashToken, meshHome, newToken, peerByToken, readMesh, removePeer, savePeer, spendInvite, type Peer } from "./state.js";

export interface MeshRequest {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The paired peer that sent the request; undefined only on open routes. */
  peer?: Peer;
}
export type MeshHandler = (request: MeshRequest) => unknown;
/** Answers a request by writing the response itself, as a protocol with its own framing does. */
export type MeshEndpoint = (request: IncomingMessage, response: ServerResponse, peer: Peer) => Promise<void>;
interface Route { method: string; parts: string[]; handler: MeshHandler; open: boolean }

const PairSchema = z.object({
  secret: z.string().min(1),
  node: z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(64), url: z.string().url() }),
  /** The token the joining node issues this node, to call it with. */
  token: z.string().min(16)
});

export interface MeshServerOptions {
  home?: string;
  /** This node's card as peers read it now. */
  card: () => Promise<NodeCard>;
  log?: (message: string) => void;
}

export class MeshServer {
  readonly home: string;
  private readonly routes: Route[] = [];
  private readonly endpoints = new Map<string, MeshEndpoint>();
  private server?: Server;

  constructor(private readonly options: MeshServerOptions) {
    this.home = options.home ?? meshHome();
    this.route("GET", "/mesh/v1/health", () => ({ ok: true, id: readMesh(this.home).node.id }), { open: true });
    this.route("POST", "/mesh/v1/pair", (request) => this.pair(request.body), { open: true });
    this.route("GET", "/mesh/v1/node", () => this.options.card());
    this.route("GET", "/mesh/v1/peers", () => readMesh(this.home).peers.map(({ id, name, url, pairedAt }) => ({ id, name, url, pairedAt })));
    // A peer that unpairs tells this node, so both forget each other.
    this.route("POST", "/mesh/v1/unpair", (request) => { removePeer(request.peer!.id, this.home); return { removed: true }; });
  }

  /** Adds a route; `:name` segments become `params.name`. Open routes take requests from anyone who can reach the node. */
  route(method: string, path: string, handler: MeshHandler, options: { open?: boolean } = {}): void {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler, open: options.open ?? false });
  }

  /** Hands every request for `path`, whatever its method, to `handler`; only paired peers reach it. */
  endpoint(path: string, handler: MeshEndpoint): void {
    this.endpoints.set(path, handler);
  }

  async start(listen = readMesh(this.home).node.listen): Promise<{ url: string; port: number }> {
    const parsed = parseListen(listen);
    const host = parsed.host === "tailnet" ? await tailnetAddress() : parsed.host;
    if (!host) throw new Error("Tailscale is not running here, so there is no tailnet address to bind; start Tailscale or run swarm mesh listen <ip>:<port>");
    const { port } = parsed;
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    const bound = (server.address() as AddressInfo).port;
    return { url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}`, port: bound };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://mesh");
      const endpoint = this.endpoints.get(url.pathname);
      if (endpoint) return await endpoint(request, response, this.caller(request));
      const found = this.match(request.method ?? "GET", url.pathname);
      if (!found) throw new HttpError(404, `No mesh route ${request.method} ${url.pathname}`);
      const peer = found.route.open ? undefined : this.caller(request);
      const body = request.method === "GET" || request.method === "HEAD" ? {} : await readJsonBody(request);
      const result = await found.route.handler({ method: request.method ?? "GET", params: found.params, query: url.searchParams, body, ...(peer ? { peer } : {}) });
      sendJson(response, 200, result ?? {});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (status === 500) this.options.log?.(`mesh: ${errorMessage(error)}`);
      if (!response.headersSent) sendJson(response, status, { error: { status, message: status === 500 ? "The node failed to answer" : errorMessage(error) } });
      else response.end();
    }
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matches = true;
      for (const [index, part] of route.parts.entries()) {
        if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(parts[index]!);
        else if (part !== parts[index]) { matches = false; break; }
      }
      if (matches) return { route, params };
    }
    return undefined;
  }

  /** The peer whose token the request carries; anything else is refused. */
  private caller(request: IncomingMessage): Peer {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    const peer = token ? peerByToken(readMesh(this.home), token) : undefined;
    if (!peer) throw new HttpError(401, "Not a paired node: pair with swarm mesh invite and swarm mesh join first");
    return peer;
  }

  /** Spends the invite, records the joining node, and answers with this node's card and the token it issues the joiner. */
  private async pair(body: Record<string, unknown>): Promise<{ node: NodeCard; token: string }> {
    const request = PairSchema.parse(body);
    if (request.node.id === readMesh(this.home).node.id) throw new HttpError(400, "A node cannot pair with itself");
    if (!spendInvite(request.secret, this.home)) throw new HttpError(403, "The invite is unknown, used or expired; make a new one with swarm mesh invite");
    const token = newToken();
    savePeer({ id: request.node.id, name: request.node.name, url: request.node.url.replace(/\/$/, ""), token: request.token,
      tokenHash: hashToken(token), pairedAt: new Date().toISOString() }, this.home);
    this.options.log?.(`mesh: paired with ${request.node.name} (${request.node.url})`);
    return { node: await this.options.card(), token };
  }
}
