/**
 * The relay: where nodes that cannot reach each other directly meet. A node listens under its relay name, which only the
 * holder of the key it hashes may do; an inviter listens under a pairing code's mailbox. A dial to a node is signed with
 * the dialing node's key, so the relay holds each node to its limits as well as each address; a device that is pairing
 * dials a code's mailbox unsigned, under a tighter limit per address. The relay pipes the dialer's stream to the listener.
 * What flows is TLS keyed by the secret the two nodes share, or a pairing handshake whose code the relay never sees, so
 * the relay learns names, timing and sizes, never content.
 *
 * Protocol, over WebSocket: `/v1/listen?name=node:…` answers a challenge with the node's signature, `/v1/listen?mailbox=1`
 * gets a mailbox; either then hears `{"stream": id}` for each dialer and takes it with `/v1/accept?stream=id`. A dialer
 * opens `/v1/dial?name=…`, answers a challenge with its own node's signature when the name is a node's, waits for the
 * text frame `ready`, and from then on binary frames are the stream's bytes. A client the relay turns away, or that hits
 * a limit, is closed with a reason that says so. `/v1/health` answers counts as JSON.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, createWebSocketStream, type ClientOptions, type RawData } from "ws";
import { loadSwarmVersion } from "../runtime/headless-artifacts.js";
import { parseListen } from "./listen.js";
import { relayName, type MeshNode } from "./state.js";

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
/** How long a client has to answer the relay's challenge. */
const ANSWER_MS = 10_000;
/** What clients may do, per minute unless said otherwise. */
export const RELAY_LIMITS = {
  /** Dials to nodes, and streams taken, from one address. */
  dialsPerAddress: 240,
  /** Listens, under a node's name or a mailbox, from one address. */
  listensPerAddress: 30,
  /** Dials to pairing codes' mailboxes from one address: a person pairing needs a few. */
  codeDialsPerAddress: 20,
  /** Dials one node's key signs. */
  dialsPerKey: 120,
  /** Streams to one listener at a time, waiting to be taken or piped. */
  streamsPerListener: 64
};
export type RelayLimits = typeof RELAY_LIMITS;
/** Frames in flight towards one side before the other side is paused. */
const HIGH_WATER = 64;

/**
 * How every connection to a relay introduces itself. A relay behind Cloudflare needs it: Cloudflare challenges a WebSocket
 * from a server's address that names no client, as ws sends none, and a node cannot answer a challenge meant for browsers.
 */
const clientOptions = (timeoutMs: number): ClientOptions => ({ handshakeTimeout: timeoutMs, headers: { "user-agent": `Swarm/${loadSwarmVersion()} (mesh relay client)` } });

const NODE_NAME = /^node:[\w-]{16,64}$/;
const listenMessage = (challenge: string, name: string): Buffer => Buffer.from(`swarm-relay/listen/v1|${challenge}|${name}`);
const dialMessage = (challenge: string, name: string): Buffer => Buffer.from(`swarm-relay/dial/v1|${challenge}|${name}`);

/** Random characters from the code alphabet; 256 is a multiple of 32, so every character is equally likely. */
export const codeCharacters = (count: number): string => Array.from(randomBytes(count), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");

interface Listener { socket: WebSocket; expires?: NodeJS.Timeout }
interface Waiting { dialer: WebSocket; name: string; timer: NodeJS.Timeout }

/** Counts only: clients turned away for a signature that did not hold, and for a limit. */
export interface RelayStats { listeners: number; mailboxes: number; streams: number; waiting: number; refused: { signature: number; limit: number } }

export class RelayServer {
  private readonly listeners = new Map<string, Listener>();
  private readonly waiting = new Map<string, Waiting>();
  /** Streams to each listener's name, waiting to be taken or piped. */
  private readonly streams = new Map<string, number>();
  private readonly rates = new Map<string, { minute: number; count: number }>();
  private readonly sockets = new Set<WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly limits: RelayLimits;
  private readonly refused = { signature: 0, limit: 0 };
  private server?: Server;
  private pinger?: NodeJS.Timeout;

  constructor(private readonly log: (message: string) => void = () => {}, limits: Partial<RelayLimits> = {}) {
    this.limits = { ...RELAY_LIMITS, ...limits };
  }

  async start(listen: string): Promise<{ url: string; port: number }> {
    const { host, port } = parseListen(listen);
    const server = createServer((request, response) => {
      // `/healthz` is for checks on the relay's own machine: a proxy in front of it may answer that path itself.
      const path = request.url?.split("?")[0];
      if (path === "/v1/health" || path === "/healthz") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok: true, ...this.stats() }));
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
    const streams = [...this.streams.values()].reduce((sum, count) => sum + count, 0);
    return { listeners: names.filter((name) => name.startsWith("node:")).length, mailboxes: names.filter((name) => name.startsWith("code:")).length,
      streams: streams - this.waiting.size, waiting: this.waiting.size, refused: { ...this.refused } };
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://relay");
    const name = url.searchParams.get("name") ?? "";
    const counted = url.pathname === "/v1/listen" ? { kind: "listens", limit: this.limits.listensPerAddress }
      : url.pathname === "/v1/dial" && name.startsWith("code:") ? { kind: "pairing attempts", limit: this.limits.codeDialsPerAddress }
      : url.pathname === "/v1/dial" || url.pathname === "/v1/accept" ? { kind: "dials", limit: this.limits.dialsPerAddress } : undefined;
    if (!counted) return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
    const address = clientAddress(request);
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.sockets.add(ws);
      (ws as WebSocket & { alive?: boolean }).alive = true;
      ws.on("pong", () => { (ws as WebSocket & { alive?: boolean }).alive = true; });
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("error", () => ws.terminate());
      if (!this.allow(`${counted.kind} from ${address}`, counted.limit)) {
        return this.refuse(ws, 4429, `Too many ${counted.kind} from this address this minute; the relay allows ${counted.limit}`);
      }
      if (url.pathname === "/v1/listen") this.listen(ws, url.searchParams);
      else if (url.pathname === "/v1/dial") this.dial(ws, name);
      else this.accept(ws, url.searchParams.get("stream") ?? "");
    });
  }

  /** Turns a client away with a reason, counting it: 4403 for a signature that does not hold, 4429 for a limit. */
  private refuse(ws: WebSocket, code: 4403 | 4429, reason: string): void {
    this.refused[code === 4403 ? "signature" : "limit"] += 1;
    ws.close(code, reason);
  }

  /** Sends a fresh challenge; `then` hears the relay name of the key whose signature answered it, or undefined. */
  private prove(ws: WebSocket, message: (challenge: string) => Buffer, then: (signer: string | undefined) => void): void {
    const challenge = randomBytes(24).toString("base64url");
    const timer = setTimeout(() => ws.close(4408, "No answer to the relay's challenge"), ANSWER_MS);
    ws.once("close", () => clearTimeout(timer));
    ws.once("message", (data) => {
      clearTimeout(timer);
      then(signerOf(data, message(challenge)));
    });
    ws.send(JSON.stringify({ challenge }));
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
    if (!NODE_NAME.test(name)) return ws.close(4400, "Listen under a node name");
    this.prove(ws, (challenge) => listenMessage(challenge, name), (signer) => {
      if (signer !== name) return this.refuse(ws, 4403, "The signature does not match the name");
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

  /**
   * A dial to a pairing code's mailbox goes straight on; one to any other name must be signed by a node's key, and counts
   * against that key's limit. Only a signed dial learns whether a node listens.
   */
  private dial(dialer: WebSocket, name: string): void {
    if (name.startsWith("code:")) return this.connect(dialer, name);
    this.prove(dialer, (challenge) => dialMessage(challenge, name), (signer) => {
      if (!signer) return this.refuse(dialer, 4403, "A dial to a node must be signed by the dialing node's key");
      if (!this.allow(`dials by ${signer}`, this.limits.dialsPerKey)) {
        return this.refuse(dialer, 4429, `Too many dials signed by this node this minute; the relay allows ${this.limits.dialsPerKey}`);
      }
      this.connect(dialer, name);
    });
  }

  /** Announces a dialer's stream to whoever listens under `name`, who has a while to take it. */
  private connect(dialer: WebSocket, name: string): void {
    const listener = this.listeners.get(name);
    if (!listener) return dialer.close(4404, name.startsWith("code:") ? "No device is waiting for this code" : "The node is not listening at the relay");
    if ((this.streams.get(name) ?? 0) >= this.limits.streamsPerListener) {
      return this.refuse(dialer, 4429, `Too many streams to this ${name.startsWith("code:") ? "code" : "node"} at the relay; it allows ${this.limits.streamsPerListener} at a time`);
    }
    const stream = randomBytes(18).toString("base64url");
    this.count(name, 1);
    const timer = setTimeout(() => {
      this.waiting.delete(stream);
      this.count(name, -1);
      dialer.close(4504, "The node did not take the stream");
    }, ACCEPT_MS);
    this.waiting.set(stream, { dialer, name, timer });
    dialer.on("close", () => { if (this.waiting.get(stream)?.dialer === dialer) { clearTimeout(timer); this.waiting.delete(stream); this.count(name, -1); } });
    listener.socket.send(JSON.stringify({ stream }));
  }

  private count(name: string, change: number): void {
    const count = (this.streams.get(name) ?? 0) + change;
    if (count > 0) this.streams.set(name, count);
    else this.streams.delete(name);
  }

  private accept(taker: WebSocket, stream: string): void {
    const waiting = this.waiting.get(stream);
    if (!waiting) return taker.close(4404, "No such stream");
    clearTimeout(waiting.timer);
    this.waiting.delete(stream);
    const { dialer, name } = waiting;
    let idle = setTimeout(() => close(4408, "Idle"), IDLE_MS);
    const touch = (): void => { clearTimeout(idle); idle = setTimeout(() => close(4408, "Idle"), IDLE_MS); };
    let closed = false;
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      this.count(name, -1);
      for (const socket of [dialer, taker]) if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    };
    pipe(dialer, taker, touch);
    pipe(taker, dialer, touch);
    dialer.on("close", () => close(1000, "The other side closed"));
    taker.on("close", () => close(1000, "The other side closed"));
    dialer.send("ready");
  }

  /** Counts one more request under `key` this minute; false once that makes more than `limit`. */
  private allow(key: string, limit: number): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const rate = this.rates.get(key);
    const count = rate?.minute === minute ? rate.count + 1 : 1;
    this.rates.set(key, { minute, count });
    if (this.rates.size > 10_000) for (const [other, value] of this.rates) if (value.minute !== minute) this.rates.delete(other);
    return count <= limit;
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

/** The relay name of the node key whose signature over `message` a client answered with, when its answer holds one. */
function signerOf(reply: RawData, message: Buffer): string | undefined {
  try {
    const { publicKey, signature } = JSON.parse(String(reply)) as { publicKey?: unknown; signature?: unknown };
    if (typeof publicKey !== "string" || typeof signature !== "string") return undefined;
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && verify(null, message, key, Buffer.from(signature, "base64")) ? relayName(publicKey) : undefined;
  } catch {
    return undefined;
  }
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

/** What a plain HTTP answer where the relay's WebSocket should be means, as an error of one line. */
function httpAnswer(relay: string, response: IncomingMessage): RelayError {
  const status = response.statusCode ?? 0;
  const cloudflare = response.headers.server === "cloudflare" || "cf-ray" in response.headers;
  const hint = response.headers["cf-mitigated"] === "challenge" ? "Cloudflare in front of it asks for a browser challenge, which a node cannot answer"
    : status === 403 ? `${cloudflare ? "a Cloudflare challenge or block rule" : "a proxy or firewall"} in front of the relay refused this connection`
    : status === 429 ? "something in front of the relay limits this address; try again in a minute"
    : status >= 500 ? `${cloudflare ? "Cloudflare" : "the proxy in front of it"} cannot reach the relay, or the relay is down`
    : status === 404 ? "no relay answers at that path; check the relay's URL"
    : "something other than a Swarm relay answered; check the relay's URL";
  return new RelayError(0, `the relay at ${relay} answered HTTP ${status}: ${hint}`);
}

/**
 * Opens a WebSocket to the relay. When something in front of it, such as Cloudflare or a reverse proxy, answers with a
 * plain HTTP response instead, `fail` hears what that answer means, rather than the bare close that follows it.
 */
function openSocket(relay: string, path: string, timeoutMs: number, fail: (error: RelayError) => void): WebSocket {
  const ws = new WebSocket(`${relay}${path}`, clientOptions(timeoutMs));
  ws.once("unexpected-response", (_request, response) => {
    response.resume();
    fail(httpAnswer(relay, response));
    ws.terminate();
  });
  return ws;
}

/** A node's answer to the relay's challenge: its public key and its signature over `message`. */
function answer(keys: MeshNode["keys"], message: Buffer): string {
  const privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), format: "der", type: "pkcs8" });
  return JSON.stringify({ publicKey: keys.publicKey, signature: sign(null, message, privateKey).toString("base64") });
}

const challengeIn = (text: string): string | undefined => {
  try {
    const { challenge } = JSON.parse(text) as { challenge?: unknown };
    return typeof challenge === "string" ? challenge : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Opens a stream to whoever listens under `name` at the relay; it fails when nobody does. A dial to a node is signed
 * with `keys`, the dialing node's own; one to a pairing code's mailbox needs none.
 */
export function relayDial(relay: string, name: string, keys?: MeshNode["keys"], timeoutMs = 15_000): Promise<RelayStream> {
  return new Promise((resolve, reject) => {
    const fail = (error: RelayError): void => { clearTimeout(timer); reject(error); };
    const ws = openSocket(relay, `/v1/dial?name=${encodeURIComponent(name)}`, timeoutMs, fail);
    const timer = setTimeout(() => { ws.terminate(); fail(new RelayError(0, `the relay did not connect within ${timeoutMs} ms`)); }, timeoutMs);
    const onMessage = (data: RawData, binary: boolean): void => {
      const text = binary ? "" : String(data);
      if (text === "ready") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.removeAllListeners("close");
        ws.removeAllListeners("error");
        resolve(relayStream(ws));
        return;
      }
      const challenge = challengeIn(text);
      if (challenge && keys) return void ws.send(answer(keys, dialMessage(challenge, name)));
      ws.terminate();
      fail(new RelayError(0, challenge ? "the relay takes only dials signed by a node's key, and this one has none" : "the relay answered out of turn"));
    };
    ws.on("message", onMessage);
    ws.once("close", (code, reason) => fail(new RelayError(code, closeReason(code, reason))));
    ws.once("error", (error) => fail(new RelayError(0, `the relay is unreachable: ${error.message}`)));
  });
}

/** Takes a stream the relay announced, as a Duplex. */
function acceptStream(relay: string, stream: string): Promise<RelayStream> {
  return new Promise((resolve, reject) => {
    const ws = openSocket(relay, `/v1/accept?stream=${encodeURIComponent(stream)}`, ACCEPT_MS, reject);
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

  constructor(private readonly relay: string, private readonly keys: MeshNode["keys"],
    private readonly onStream: (stream: Duplex) => void, private readonly log: (message: string) => void = () => {}) {}

  get name(): string { return relayName(this.keys.publicKey); }

  start(): void {
    if (this.closed) return;
    const name = this.name;
    // Why this connection failed, when it says more than the close that follows.
    let failure: string | undefined;
    const ws = openSocket(this.relay, `/v1/listen?name=${encodeURIComponent(name)}`, 15_000, (error) => { failure = error.message; });
    this.ws = ws;
    ws.once("message", (data) => {
      const { challenge } = JSON.parse(String(data)) as { challenge: string };
      ws.send(answer(this.keys, listenMessage(challenge, name)));
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
      this.lastError = failure ?? closeReason(code, reason);
      this.timer = setTimeout(() => this.start(), this.pause);
      this.pause = Math.min(this.pause * 2, 30_000);
    });
    ws.on("error", (error) => { this.lastError = failure ??= `the relay is unreachable: ${error.message}`; });
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
    const ws = openSocket(relay, `/v1/listen?mailbox=1&minutes=${minutes}`, 15_000, reject);
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
