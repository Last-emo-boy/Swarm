/**
 * A node's mesh server: JSON over HTTP inside the node's links (link.ts), which it takes directly on its listen address and
 * through the relay. Only paired peers get past a link's TLS, and the key they used tells which peer is calling, so every
 * route knows its caller. Later features add their routes with `route()`, or with `endpoint()` when they write the
 * response themselves.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { z } from "zod/v4";
import { HttpError, errorMessage, readJsonBody, sendJson } from "../server/gateway-http.js";
import { tailnetAddress, type NodeCard } from "./card.js";
import { LinkServer } from "./link.js";
import { parseListen } from "./listen.js";
import { acceptVoucher, answerDirectInvite, brokerPeer } from "./pair.js";
import { RelayListener } from "./relay.js";
import { forgetDevice, meshHome, readMesh, removePeer, tombstones, type Peer } from "./state.js";

export interface MeshRequest {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The paired peer that sent the request. */
  peer: Peer;
}
export type MeshHandler = (request: MeshRequest) => unknown;
/** Answers a request by writing the response itself, as a protocol with its own framing does. */
export type MeshEndpoint = (request: IncomingMessage, response: ServerResponse, peer: Peer) => Promise<void>;
interface Route { method: string; parts: string[]; handler: MeshHandler }

const ForgetSchema = z.object({ id: z.string().min(1), name: z.string().max(64).optional(), at: z.iso.datetime().optional() });

/** The most removal records one answer carries; a swarm that removed more carries the rest on a later pass. */
const TOMBSTONES_MAX = 500;

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
  private readonly http: Server;
  private readonly link: LinkServer;
  private readonly sockets = new Set<Socket>();
  private tcp?: TcpServer;
  private relays: RelayListener[] = [];

  constructor(private readonly options: MeshServerOptions) {
    this.home = options.home ?? meshHome();
    this.http = createServer((request, response) => { void this.handle(request, response); });
    this.link = new LinkServer(this.home, this.http, {
      pair: (stream, invite) => answerDirectInvite(stream, invite, this.home, (peer) => this.options.log?.(`mesh: paired with ${peer.name}`)),
      intro: (voucher) => { acceptVoucher(voucher, this.home); }
    });
    this.route("GET", "/mesh/v1/node", () => this.options.card());
    this.route("GET", "/mesh/v1/peers", () => readMesh(this.home).peers.map(({ id, name, addresses, pairedAt }) => ({ id, name, addresses, pairedAt })));
    // A peer that unpairs tells this node, so both forget each other.
    this.route("POST", "/mesh/v1/unpair", (request) => { removePeer(request.peer.id, this.home); return { removed: true }; });
    // A device removed from the swarm: every member forgets it and refuses introductions of it from then on.
    // A peer asks to be introduced to another of this node's peers: any common peer can bring two devices together,
    // so joining never depends on one particular node being online when the others are.
    this.route("POST", "/mesh/v1/broker", (request) => brokerPeer(request.body, request.peer.id, this.home));
    // A device removed from the swarm, told by the node that removed it: this node forgets it too and keeps the record under
    // its author, so a member that was offline learns of the removal from whichever peer it reaches first.
    this.route("POST", "/mesh/v1/forget", (request) => {
      const { id, name, at } = ForgetSchema.parse(request.body);
      if (id === request.peer.id) { removePeer(id, this.home); return { forgotten: true }; }
      const state = readMesh(this.home);
      forgetDevice({ id, name: name ?? state.peers.find((peer) => peer.id === id)?.name ?? id, at: at ?? new Date().toISOString(),
        by: request.peer.id }, this.home);
      return { forgotten: true };
    });
    // Every device this node refuses, each with its author: a peer converges its own refusals from here.
    this.route("GET", "/mesh/v1/removed", () => {
      const all = tombstones(readMesh(this.home));
      return all.length > TOMBSTONES_MAX ? { removed: all.slice(0, TOMBSTONES_MAX), truncated: true } : { removed: all };
    });
  }

  /** Adds a route; `:name` segments become `params.name`. */
  route(method: string, path: string, handler: MeshHandler): void {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
  }

  /** Hands every request for `path`, whatever its method, to `handler`. */
  endpoint(path: string, handler: MeshEndpoint): void {
    this.endpoints.set(path, handler);
  }

  /** Each relay this node listens at now, and why not where one does not; undefined when it listens at none. */
  relayStatus(): { relay: string; listening: boolean; error?: string }[] | undefined {
    return this.relays.length
      ? this.relays.map((listener) => ({ relay: listener.relay, listening: listener.listening, ...(listener.lastError ? { error: listener.lastError } : {}) }))
      : undefined;
  }

  /**
   * Takes links on `listen` (`tailnet:<port>` binds the Tailscale address) and, given a relay, listens there too. Returns
   * the address this machine reaches the node at.
   */
  async start(listen = readMesh(this.home).node.listen, options: { relay?: string; relays?: string[] } = {}): Promise<{ address: string; port: number }> {
    const parsed = parseListen(listen);
    const host = parsed.host === "tailnet" ? await tailnetAddress() : parsed.host;
    if (!host) throw new Error("Tailscale is not running here, so there is no tailnet address to bind; start Tailscale or run swarm mesh listen <ip>:<port>");
    const tcp = createTcpServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      this.link.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(parsed.port, host, () => { tcp.off("error", reject); resolve(); });
    });
    this.tcp = tcp;
    // One listener per relay: each reconnects on its own, so one dead relay never holds another back.
    const keys = readMesh(this.home).node.keys;
    for (const relay of [...new Set(options.relays ?? (options.relay ? [options.relay] : []))]) {
      const listener = new RelayListener(relay, keys, (stream) => this.link.accept(stream), this.options.log);
      listener.start();
      this.relays.push(listener);
    }
    const port = (tcp.address() as AddressInfo).port;
    const reach = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return { address: `${reach.includes(":") ? `[${reach}]` : reach}:${port}`, port };
  }

  async stop(): Promise<void> {
    for (const listener of this.relays) listener.close();
    this.relays = [];
    const tcp = this.tcp;
    this.tcp = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.http.closeAllConnections();
    if (tcp) await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://mesh");
      const endpoint = this.endpoints.get(url.pathname);
      if (endpoint) return await endpoint(request, response, this.caller(request));
      const found = this.match(request.method ?? "GET", url.pathname);
      if (!found) throw new HttpError(404, `No mesh route ${request.method} ${url.pathname}`);
      const peer = this.caller(request);
      const body = request.method === "GET" || request.method === "HEAD" ? {} : await readJsonBody(request);
      const result = await found.route.handler({ method: request.method ?? "GET", params: found.params, query: url.searchParams, body, peer });
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

  /**
   * The paired peer on the other end, as the link's TLS key named it, read afresh so a renamed or re-paired peer is seen as
   * it is now. One removed since it connected is refused.
   */
  private caller(request: IncomingMessage): Peer {
    const linked = this.link.caller(request.socket);
    const peer = linked && readMesh(this.home).peers.find((item) => item.id === linked.id && item.key === linked.key);
    if (!peer) throw new HttpError(401, "Not a paired node: pair with swarm mesh invite and swarm mesh join first");
    return peer;
  }
}
