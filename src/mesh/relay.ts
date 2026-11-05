/**
 * The relay: where nodes that cannot reach each other directly meet. A node listens under its relay name, which only the
 * holder of the key it hashes may do; an inviter listens under a pairing code's mailbox. Anyone may dial a name, and the
 * relay pipes the dialer's stream to the listener. What flows is TLS keyed by the secret the two nodes share, or a pairing
 * handshake whose code the relay never sees, so the relay learns names, timing and sizes, never content.
 *
 * Protocol, over WebSocket: `/v1/listen?name=node:…` answers a challenge with the node's signature, `/v1/listen?mailbox=1`
 * gets a mailbox; either then hears `{"stream": id}` for each dialer and takes it with `/v1/accept?stream=id`. A dialer
 * opens `/v1/dial?name=…`, waits for the text frame `ready`, and from then on binary frames are the stream's bytes.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, createWebSocketStream, type ClientOptions, type RawData } from "ws";
import { loadSwarmVersion } from "../runtime/headless-artifacts.js";
import { parseListen } from "./listen.js";
import { relayName } from "./state.js";

/** Characters of pairing codes and mailboxes: Crockford's base32, which leaves out I, L, O and U. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAILBOX_LENGTH = 2;
const MAX_MAILBOXES = CODE_ALPHABET.length ** MAILBOX_LENGTH;
/** The longest a mailbox stays open, whatever its inviter asked for. */
const MAX_MAILBOX_MINUTES = 60;
/** How long a dialer waits for the listener to take its stream. */
const ACCEPT_MS = 10_000;
/** A piped stream with no bytes either way for this long is closed. */
const IDLE_MS = 10 * 60_000;
/** Pings keep sockets alive through proxies that drop quiet WebSockets, and find dead ones. */
const PING_MS = 30_000;
const STREAMS_PER_NAME = 64;
/** Requests one address may make per minute, by kind. */
const PER_MINUTE = { dial: 240, listen: 30 };
/** Frames in flight towards one side before the other side is paused. */
const HIGH_WATER = 64;

/**
 * How every connection to a relay introduces itself. A relay behind Cloudflare needs it: Cloudflare challenges a WebSocket
 * from a server's address that names no client, as ws sends none, and a node cannot answer a challenge meant for browsers.
 */
const clientOptions = (timeoutMs: number): ClientOptions => ({ handshakeTimeout: timeoutMs, headers: { "user-agent": `Swarm/${loadSwarmVersion()} (mesh relay client)` } });

const listenMessage = (challenge: string, name: string): Buffer => Buffer.from(`swarm-relay/listen/v1|${challenge}|${name}`);

/** Random characters from the code alphabet; 256 is a multiple of 32, so every character is equally likely. */
export const codeCharacters = (count: number): string => Array.from(randomBytes(count), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");

interface Listener { socket: WebSocket; expires?: NodeJS.Timeout }
interface Waiting { dialer: WebSocket; name: string; timer: NodeJS.Timeout }

export interface RelayStats { listeners: number; mailboxes: number; streams: number; waiting: number }

export class RelayServer {
  private readonly listeners = new Map<string, Listener>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly streams = new Map<string, number>();
  private readonly rates = new Map<string, { minute: number; dial: number; listen: number }>();
  private readonly sockets = new Set<WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private server?: Server;
  private pinger?: NodeJS.Timeout;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  async start(listen: string): Promise<{ url: string; port: number }> {
    const { host, port } = parseListen(listen);
    const server = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...this.stats() }));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" }).end("A Swarm mesh relay: swarm mesh relay <url> points a node here.\n");
    });
    server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.pinger.unref();
    const bound = (server.address() as { port: number }).port;
    return { url: `ws://${host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host}:${bound}`, port: bound };
  }

  async stop(): Promise<void> {
    if (this.pinger) clearInterval(this.pinger);
    for (const socket of this.sockets) socket.terminate();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  stats(): RelayStats {
    const names = [...this.listeners.keys()];
    return { listeners: names.filter((name) => name.startsWith("node:")).length, mailboxes: names.filter((name) => name.startsWith("code:")).length,
      streams: [...this.streams.values()].reduce((sum, count) => sum + count, 0), waiting: this.waiting.size };
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://relay");
    const kind = url.pathname === "/v1/dial" || url.pathname === "/v1/accept" ? "dial" : url.pathname === "/v1/listen" ? "listen" : undefined;
    if (!kind) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
    if (!this.allow(clientAddress(request), kind)) return void socket.end("HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n");
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.sockets.add(ws);
      (ws as WebSocket & { alive?: boolean }).alive = true;
      ws.on("pong", () => { (ws as WebSocket & { alive?: boolean }).alive = true; });
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("error", () => ws.terminate());
      if (url.pathname === "/v1/listen") this.listen(ws, url.searchParams);
      else if (url.pathname === "/v1/dial") this.dial(ws, url.searchParams.get("name") ?? "");
      else this.accept(ws, url.searchParams.get("stream") ?? "");
    });
  }

  /** A node proves it holds the key its name hashes; a mailbox needs no proof and lives for its minutes. */
  private listen(ws: WebSocket, query: URLSearchParams): void {
    if (query.get("mailbox")) {
      const mailbox = this.freeMailbox();
      if (!mailbox) return ws.close(4429, "The relay has no free mailbox; try again in a minute");
      const minutes = Math.min(Number(query.get("minutes")) || 15, MAX_MAILBOX_MINUTES);
      const name = `code:${mailbox}`;
      const expires = setTimeout(() => ws.close(4410, "The pairing code expired"), minutes * 60_000);
      this.register(name, { socket: ws, expires });
      ws.send(JSON.stringify({ mailbox }));
      return;
    }
    const name = query.get("name") ?? "";
    if (!/^node:[\w-]{16,64}$/.test(name)) return ws.close(4400, "Listen under a node name");
    const challenge = randomBytes(24).toString("base64url");
    ws.send(JSON.stringify({ challenge }));
    ws.once("message", (data) => {
      try {
        const answer = JSON.parse(String(data)) as { publicKey?: string; signature?: string };
        const key = createPublicKey({ key: Buffer.from(answer.publicKey ?? "", "base64"), format: "der", type: "spki" });
        if (relayName(answer.publicKey ?? "") !== name || !verify(null, listenMessage(challenge, name), key, Buffer.from(answer.signature ?? "", "base64"))) {
          return ws.close(4403, "The signature does not match the name");
        }
      } catch {
        return ws.close(4403, "The signature does not match the name");
      }
      this.register(name, { socket: ws });
      ws.send(JSON.stringify({ ok: true }));
    });
  }

  /** Takes over a name; a node that reconnects replaces its old listen connection. */
  private register(name: string, listener: Listener): void {
    const previous = this.listeners.get(name);
    this.listeners.set(name, listener);
    if (previous) previous.socket.close(4409, "Listening from another connection");
    listener.socket.on("close", () => {
      if (listener.expires) clearTimeout(listener.expires);
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    });
  }

  private freeMailbox(): string | undefined {
    if ([...this.listeners.keys()].filter((name) => name.startsWith("code:")).length >= MAX_MAILBOXES) return undefined;
    for (;;) {
      const mailbox = codeCharacters(MAILBOX_LENGTH);
      if (!this.listeners.has(`code:${mailbox}`)) return mailbox;
    }
  }

  private dial(dialer: WebSocket, name: string): void {
    const listener = this.listeners.get(name);
    if (!listener) return dialer.close(4404, name.startsWith("code:") ? "No device is waiting for this code" : "The node is not listening at the relay");
    if ((this.streams.get(name) ?? 0) >= STREAMS_PER_NAME) return dialer.close(4429, "Too many streams to this node");
    const stream = randomBytes(18).toString("base64url");
    const timer = setTimeout(() => {
      this.waiting.delete(stream);
      dialer.close(4504, "The node did not take the stream");
    }, ACCEPT_MS);
    this.waiting.set(stream, { dialer, name, timer });
    dialer.on("close", () => { if (this.waiting.get(stream)?.dialer === dialer) { clearTimeout(timer); this.waiting.delete(stream); } });
    listener.socket.send(JSON.stringify({ stream }));
  }

  private accept(taker: WebSocket, stream: string): void {
    const waiting = this.waiting.get(stream);
    if (!waiting) return taker.close(4404, "No such stream");
    clearTimeout(waiting.timer);
    this.waiting.delete(stream);
    const { dialer, name } = waiting;
    this.streams.set(name, (this.streams.get(name) ?? 0) + 1);
    let idle = setTimeout(() => close(4408, "Idle"), IDLE_MS);
    const touch = (): void => { clearTimeout(idle); idle = setTimeout(() => close(4408, "Idle"), IDLE_MS); };
    let closed = false;
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      this.streams.set(name, (this.streams.get(name) ?? 1) - 1);
      if (!this.streams.get(name)) this.streams.delete(name);
      for (const socket of [dialer, taker]) if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    };
    pipe(dialer, taker, touch);
    pipe(taker, dialer, touch);
    dialer.on("close", () => close(1000, "The other side closed"));
    taker.on("close", () => close(1000, "The other side closed"));
    dialer.send("ready");
  }

  private allow(address: string, kind: "dial" | "listen"): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const rate = this.rates.get(address);
    const current = rate?.minute === minute ? rate : { minute, dial: 0, listen: 0 };
    current[kind] += 1;
    this.rates.set(address, current);
    if (this.rates.size > 10_000) for (const [key, value] of this.rates) if (value.minute !== minute) this.rates.delete(key);
    return current[kind] <= PER_MINUTE[kind];
  }

  private ping(): void {
    for (const socket of this.sockets) {
      const tracked = socket as WebSocket & { alive?: boolean };
      if (tracked.alive === false) { socket.terminate(); continue; }
      tracked.alive = false;
      socket.ping();
    }
  }
}

/** The address a request came from: behind Cloudflare and a reverse proxy, the one they report. */
function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || "unknown";
}

/** Forwards binary frames from one socket to the other, pausing the sender while too many are in flight. */
function pipe(from: WebSocket, to: WebSocket, touch: () => void): void {
  let inFlight = 0;
  from.on("message", (data: RawData, binary: boolean) => {
    if (!binary || to.readyState !== WebSocket.OPEN) return;
    touch();
    inFlight += 1;
    if (inFlight >= HIGH_WATER) from.pause();
    to.send(data, { binary: true }, () => {
      inFlight -= 1;
      if (inFlight < HIGH_WATER / 2 && from.isPaused) from.resume();
    });
  });
}

/** Lets a stream over the relay hold the process open, or not, like a TCP socket; the client's keep-alive pool uses it. */
export type RelayStream = Duplex & { ref(): void; unref(): void };

function relayStream(ws: WebSocket): RelayStream {
  const stream = createWebSocketStream(ws) as RelayStream;
  // ws keeps its TCP socket private; reaching it is the only way to let an idle pooled stream not hold the process open.
  const tcp = (): Socket | undefined => (ws as unknown as { _socket?: Socket })._socket;
  stream.ref = () => { tcp()?.ref(); };
  stream.unref = () => { tcp()?.unref(); };
  return stream;
}

const closeReason = (code: number, reason: Buffer): string => reason.length ? reason.toString() : `the relay closed the connection (${code})`;

export class RelayError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** Opens a stream to whoever listens under `name` at the relay; it fails when nobody does. */
export function relayDial(relay: string, name: string, timeoutMs = 15_000): Promise<RelayStream> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${relay}/v1/dial?name=${encodeURIComponent(name)}`, clientOptions(timeoutMs));
    const timer = setTimeout(() => { ws.terminate(); reject(new RelayError(0, `the relay did not connect within ${timeoutMs} ms`)); }, timeoutMs);
    ws.once("message", (data, binary) => {
      clearTimeout(timer);
      if (binary || String(data) !== "ready") { ws.terminate(); reject(new RelayError(0, "the relay answered out of turn")); return; }
      ws.removeAllListeners("close");
      ws.removeAllListeners("error");
      resolve(relayStream(ws));
    });
    ws.once("close", (code, reason) => { clearTimeout(timer); reject(new RelayError(code, closeReason(code, reason))); });
    ws.once("error", (error) => { clearTimeout(timer); reject(new RelayError(0, `the relay is unreachable: ${error.message}`)); });
  });
}

/** Takes a stream the relay announced, as a Duplex. */
function acceptStream(relay: string, stream: string): Promise<RelayStream> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${relay}/v1/accept?stream=${encodeURIComponent(stream)}`, clientOptions(ACCEPT_MS));
    ws.once("open", () => { ws.removeAllListeners("error"); resolve(relayStream(ws)); });
    ws.once("error", reject);
  });
}

function onStreams(ws: WebSocket, relay: string, onStream: (stream: Duplex) => void, log: (message: string) => void): void {
  ws.on("message", (data, binary) => {
    if (binary) return;
    const { stream } = JSON.parse(String(data)) as { stream?: string };
    if (stream) acceptStream(relay, stream).then(onStream, (error: Error) => log(`relay: could not take a stream: ${error.message}`));
  });
}

/**
 * Listens under this node's name at the relay for as long as it runs, reconnecting with growing pauses when the
 * connection drops, and hands each stream a peer dials to `onStream`.
 */
export class RelayListener {
  private ws?: WebSocket;
  private closed = false;
  private pause = 1000;
  private timer?: NodeJS.Timeout;
  /** Whether the relay accepted this node's name on the current connection. */
  listening = false;
  lastError?: string;

  constructor(private readonly relay: string, private readonly keys: { publicKey: string; privateKey: string },
    private readonly onStream: (stream: Duplex) => void, private readonly log: (message: string) => void = () => {}) {}

  get name(): string { return relayName(this.keys.publicKey); }

  start(): void {
    if (this.closed) return;
    const name = this.name;
    const ws = new WebSocket(`${this.relay}/v1/listen?name=${encodeURIComponent(name)}`, clientOptions(15_000));
    this.ws = ws;
    ws.once("message", (data) => {
      const { challenge } = JSON.parse(String(data)) as { challenge: string };
      const privateKey = createPrivateKey({ key: Buffer.from(this.keys.privateKey, "base64"), format: "der", type: "pkcs8" });
      ws.send(JSON.stringify({ publicKey: this.keys.publicKey, signature: sign(null, listenMessage(challenge, name), privateKey).toString("base64") }));
      ws.once("message", () => {
        this.listening = true;
        this.lastError = undefined;
        this.pause = 1000;
        onStreams(ws, this.relay, this.onStream, this.log);
      });
    });
    ws.on("close", (code, reason) => {
      this.listening = false;
      if (this.closed) return;
      this.lastError = closeReason(code, reason);
      this.timer = setTimeout(() => this.start(), this.pause);
      this.pause = Math.min(this.pause * 2, 30_000);
    });
    ws.on("error", (error) => { this.lastError = error.message; });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.terminate();
  }
}

/** Opens a pairing code's mailbox at the relay for `minutes`; streams dialed to it go to `onStream` until it closes. */
export function openMailbox(relay: string, minutes: number, onStream: (stream: Duplex) => void, log: (message: string) => void = () => {}):
  Promise<{ mailbox: string; closed: Promise<string>; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${relay}/v1/listen?mailbox=1&minutes=${minutes}`, clientOptions(15_000));
    const closed = new Promise<string>((done) => ws.on("close", (code, reason) => done(closeReason(code, reason))));
    ws.once("message", (data) => {
      const { mailbox } = JSON.parse(String(data)) as { mailbox?: string };
      if (!mailbox) { ws.terminate(); reject(new Error("the relay gave no mailbox")); return; }
      onStreams(ws, relay, onStream, log);
      resolve({ mailbox, closed, close: () => ws.close(1000, "The invite ended") });
    });
    ws.once("close", (code, reason) => reject(new RelayError(code, closeReason(code, reason))));
    ws.once("error", (error) => reject(new RelayError(0, `the relay is unreachable: ${error.message}`)));
  });
}
