/**
 * Links between paired nodes. Every connection is a byte stream, made directly (TCP to an address the peer advertised) or
 * through the relay, carrying TLS keyed with the secret the two nodes share: only they can finish the handshake, and the
 * key TLS names tells the receiving node which peer is calling. The mesh's HTTP routes run inside.
 *
 * A stream's first byte tells the receiving node what it carries: a TLS handshake, or one opener line, `SWARM/1 pair <id>`
 * (a device pairing with a code, pair.ts) or `SWARM/1 intro <voucher>` (a member introduced by another, then TLS).
 */
import { Agent, request as httpRequest, type ClientRequestArgs, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import { Duplex, Readable } from "node:stream";
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket, type Server as TlsServer } from "node:tls";
import { parseListen } from "./listen.js";
import { RelayError, relayDial, type RelayStream } from "./relay.js";
import { meshHome, peerByIdentity, pskIdentity, readMesh, type Peer } from "./state.js";

const TLS = { ciphers: "ECDHE-PSK-CHACHA20-POLY1305", minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;
export const OPENER = "SWARM/1 ";
/** How long direct addresses get before the relay is tried as well. */
const DIRECT_HEAD_START_MS = 700;
const CONNECT_MS = 8_000;
const HANDSHAKE_MS = 10_000;
const OPENER_MAX = 64 * 1024;
const REQUEST_MS = 10_000;

/** How a link reached its peer. */
export type LinkPath = { kind: "direct"; address: string } | { kind: "relay"; relay: string };
export const describePath = (path: LinkPath | undefined): string =>
  !path ? "not reached yet" : path.kind === "direct" ? `direct (${path.address})` : "via relay";

export class MeshError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * A stream that first yields `head`, then whatever `stream` yields; what is written goes to `stream`. Lets a node read a
 * stream's first bytes and still hand the whole stream on. A TCP socket must go through it too: TLS reads a raw socket's
 * handle directly and would miss bytes already read.
 */
function rewind(stream: Duplex, head: Buffer): Duplex {
  const out = new Duplex({
    read() { stream.resume(); },
    write(chunk: Buffer, encoding, callback) { stream.write(chunk, encoding, callback); },
    final(callback) { stream.end(); callback(); },
    destroy(error, callback) { stream.destroy(error ?? undefined); callback(error); }
  });
  if (head.length) out.push(head);
  stream.on("data", (chunk: Buffer) => { if (!out.push(chunk)) stream.pause(); });
  stream.on("end", () => out.push(null));
  stream.on("error", (error) => out.destroy(error));
  stream.on("close", () => out.destroy());
  return out;
}

export interface LinkHandlers {
  /** Answers a device pairing with the invite or code mailbox `argument` names. */
  pair(stream: Duplex, argument: string): Promise<void>;
  /** Takes an introduction; whether or not it holds, the TLS handshake that follows decides who may talk. */
  intro(voucher: string): void;
}

/** The receiving side: sorts incoming streams and finishes TLS for paired peers, handing their sockets to `http`. */
export class LinkServer {
  private readonly tls: TlsServer;
  private readonly callers = new WeakMap<object, Peer>();

  constructor(private readonly home: string, private readonly http: HttpServer, private readonly handlers: LinkHandlers) {
    this.tls = createTlsServer({
      ...TLS,
      pskCallback: (socket: TLSSocket, identity: string) => {
        const peer = peerByIdentity(readMesh(this.home), identity);
        if (!peer) return null;
        this.callers.set(socket, peer);
        return Buffer.from(peer.key, "base64url");
      }
    }, (socket) => this.http.emit("connection", socket));
    // A caller that is not a paired peer fails the handshake; there is nothing more to do about it.
    this.tls.on("tlsClientError", () => {});
  }

  /** The paired peer on the other end of a socket the HTTP server got from this link server. */
  caller(socket: object): Peer | undefined {
    return this.callers.get(socket);
  }

  accept(stream: Duplex): void {
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => stream.destroy(), HANDSHAKE_MS);
    const done = (rest: Buffer, next: (stream: Duplex) => void): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.pause();
      next(rewind(stream, rest));
    };
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      if (head[0] === 0x16) return done(head, (whole) => this.tls.emit("connection", whole));
      const newline = head.indexOf(10);
      if (newline < 0) {
        if (head.length > OPENER_MAX || !OPENER.startsWith(head.subarray(0, OPENER.length).toString("latin1"))) { clearTimeout(timer); stream.destroy(); }
        return;
      }
      const line = head.subarray(0, newline).toString("utf8");
      done(head.subarray(newline + 1), (rest) => this.opener(rest, line));
    };
    stream.on("data", onData);
    stream.on("error", () => stream.destroy());
  }

  private opener(stream: Duplex, line: string): void {
    if (!line.startsWith(OPENER)) return void stream.destroy();
    const [verb, argument = ""] = line.slice(OPENER.length).split(" ");
    if (verb === "pair") {
      this.handlers.pair(stream, argument).catch(() => stream.destroy());
      return;
    }
    if (verb === "intro") {
      this.handlers.intro(argument);
      this.tls.emit("connection", stream);
      return;
    }
    stream.destroy();
  }
}

/** Opens a raw stream to `host:port`. */
function dialDirect(address: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const { host, port } = parseListen(address);
    const socket = tcpConnect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("timed out")), CONNECT_MS);
    socket.once("connect", () => { clearTimeout(timer); socket.off("error", reject); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

/** TLS for a pair over `raw`, after the peer's introduction when this node still carries one. */
function handshake(peer: Peer, raw: Duplex): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    if (peer.voucher) raw.write(`${OPENER}intro ${peer.voucher}\n`);
    const socket = tlsConnect({
      socket: raw, ...TLS, checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: Buffer.from(peer.key, "base64url"), identity: pskIdentity(peer.key) })
    });
    const timer = setTimeout(() => socket.destroy(new Error("the TLS handshake timed out")), HANDSHAKE_MS);
    socket.once("secureConnect", () => { clearTimeout(timer); socket.off("error", reject); resolve(socket); });
    // Only the peer's own refusal says it does not know the key; anything else, such as a proxy that took the connection
    // and dropped it, is just a path that did not work.
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      raw.destroy();
      reject(error.code === "ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY" ? new HandshakeRefused(error.message) : error);
    });
  });
}

class HandshakeRefused extends Error {}

const paths = new Map<string, LinkPath>();
/** How this process last reached a peer. */
export const pathTo = (peerId: string): LinkPath | undefined => paths.get(peerId);

/**
 * Connects to a peer: its direct addresses at once, the relay where it listens shortly after, and the first link whose TLS
 * handshake finishes wins. A peer that answers but refuses the handshake no longer shares this node's key. The relay dial
 * is signed with the key of the node whose mesh home the peer record came from.
 */
export function connectPeer(peer: Peer): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const open = new Set<Duplex>();
    const failures: string[] = [];
    let pending = 0;
    let settled = false;
    let refused = false;
    let relayStarted = false;
    const attempt = (path: LinkPath, dial: () => Promise<Duplex>): void => {
      pending += 1;
      void (async () => {
        let raw: Duplex | undefined;
        try {
          raw = await dial();
          if (settled) return void raw.destroy();
          open.add(raw);
          const socket = await handshake(peer, raw);
          if (settled) return void socket.destroy();
          if (path.kind === "relay") relayUnder.set(socket, raw as RelayStream);
          settled = true;
          clearTimeout(relayTimer);
          for (const other of open) if (other !== raw) other.destroy();
          paths.set(peer.id, path);
          resolve(socket);
        } catch (error) {
          if (raw) open.delete(raw);
          if (error instanceof HandshakeRefused) refused = true;
          failures.push(`${path.kind === "direct" ? path.address : "relay"}: ${error instanceof RelayError || error instanceof Error ? error.message : String(error)}`);
        } finally {
          pending -= 1;
          if (!settled && pending === 0) {
            if (!relayStarted) startRelay();
            if (pending === 0) finish();
          }
        }
      })();
    };
    const startRelay = (): void => {
      if (relayStarted || settled) return;
      relayStarted = true;
      if (peer.relay && peer.relayName) {
        attempt({ kind: "relay", relay: peer.relay }, () => relayDial(peer.relay!, peer.relayName!, readMesh(peer.home ?? meshHome()).node.keys));
      }
    };
    const finish = (): void => {
      settled = true;
      clearTimeout(relayTimer);
      reject(new MeshError(0, refused
        ? `${peer.name} answered but no longer knows this node; pair again`
        : `${peer.name} is unreachable: ${failures.join("; ") || "no address or relay to reach it at"}`));
    };
    // Not unref'd: while it waits it may be all that keeps a command alive, as for a peer with no direct address.
    const relayTimer = setTimeout(startRelay, peer.addresses.length ? DIRECT_HEAD_START_MS : 0);
    for (const address of peer.addresses) attempt({ kind: "direct", address }, () => dialDirect(address));
    if (!peer.addresses.length && !(peer.relay && peer.relayName)) finish();
  });
}

/** A keep-alive pool per peer, so calls after the first reuse its link instead of shaking hands again. */
class PeerAgent extends Agent {
  constructor(public peer: Peer) {
    super({ keepAlive: true, maxSockets: 8 });
    // An idle link over the relay must not hold the process open, as an idle TCP socket in the pool does not.
    this.on("free", (socket: Duplex) => underlying(socket)?.unref());
  }

  override createConnection(_options: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): Duplex | undefined {
    connectPeer(this.peer).then((socket) => callback?.(null, socket), (error: Error) => callback?.(error, undefined as unknown as Duplex));
    return undefined;
  }

  override reuseSocket(socket: Duplex, request: Parameters<Agent["reuseSocket"]>[1]): void {
    super.reuseSocket(socket as Socket, request);
    underlying(socket)?.ref();
  }
}

/** The relay stream under a TLS socket, when its link goes through the relay. */
const relayUnder = new WeakMap<object, RelayStream>();
const underlying = (socket: Duplex): RelayStream | undefined => relayUnder.get(socket);

const agents = new Map<string, PeerAgent>();
function agentFor(peer: Peer): PeerAgent {
  const key = `${peer.id}|${peer.key}`;
  let agent = agents.get(key);
  if (!agent) agents.set(key, agent = new PeerAgent(peer));
  agent.peer = peer;
  return agent;
}

/** Closes every pooled link, so a command that is done can exit. */
export function closePeerLinks(): void {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

/** One JSON request to a peer; an error answer or an unreachable peer throws a MeshError, with the peer's message when it gave one. */
export function peerRequest<T>(peer: Peer, method: string, path: string, body?: unknown, timeoutMs = REQUEST_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      agent: agentFor(peer), method, path, host: "mesh",
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {}
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => reject(new MeshError(0, `${peer.name} is unreachable: ${error.message}`)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: { message: text } }; }
        const status = response.statusCode ?? 500;
        if (status >= 400) reject(new MeshError(status, (parsed as { error?: { message?: string } }).error?.message ?? `HTTP ${status}`));
        else resolve(parsed as T);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    request.on("error", (error) => reject(error instanceof MeshError ? error : new MeshError(0, `${peer.name} is unreachable: ${error.message}`)));
    request.end(payload);
  });
}

const responseHeaders = (headers: IncomingHttpHeaders): Headers => {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) for (const item of [value ?? []].flat()) out.append(name, item);
  return out;
};

/** A `fetch` that reaches the peer over its link, whatever host the URL names; the MCP client borrows tools through it. */
export function peerFetch(find: () => Peer): typeof fetch {
  return async (input, init) => {
    const peer = find();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    const body = init?.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ agent: agentFor(peer), method, path: `${url.pathname}${url.search}`, host: "mesh",
        headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (response) => {
        const status = response.statusCode ?? 502;
        const empty = method === "HEAD" || [101, 204, 205, 304].includes(status);
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream, { status, headers: responseHeaders(response.headers) }));
      });
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) return void request.destroy(signal.reason as Error);
        signal.addEventListener("abort", () => request.destroy(signal.reason as Error), { once: true });
      }
      request.on("error", (error) => reject(new MeshError(0, `${peer.name} is unreachable: ${error.message}`)));
      request.end(body);
    });
  };
}
