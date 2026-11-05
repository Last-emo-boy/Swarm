/**
 * Pairing with a code. A short code (`K7QM-4ZX2`) names a mailbox at the relay (its first two characters) and a password
 * (the other six, which the relay never sees); a direct invite (`swarm-mesh:…`) carries the inviting node's addresses and
 * a long password. Either way the two devices run CPace over the stream: both derive a curve point from the password and
 * the session, and only a device that knows the password ends with the same key. They confirm the key, then exchange who
 * they are sealed with it, and keep a pair key derived from it.
 *
 * One code joins the whole swarm: the inviter hands the joiner every member it is paired with, each with a fresh key for
 * the new pair and a voucher sealed with the key the inviter shares with that member. The joiner's first link to a member
 * opens with that voucher; the member opens it, trusts its own peer's word, and the TLS handshake that follows uses the
 * new key.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import type { Duplex } from "node:stream";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { advertisedAddresses } from "./card.js";
import { OPENER } from "./link.js";
import { parseListen } from "./listen.js";
import { CODE_ALPHABET, codeCharacters, openMailbox, relayDial } from "./relay.js";
import {
  DEFAULT_RELAY, INVITE_MINUTES, dropInvite, isInviteCode, liveInvite, meshHome, parseInvite, readMesh, relayName, relayOf, savePeer, type MeshState, type Peer
} from "./state.js";

/** Wrong codes one invite takes before it is cancelled. */
export const ATTEMPTS = 3;
const STEP_MS = 20_000;
const LINE_MAX = 512 * 1024;
const VOUCHER_DAYS = 30;
const DSI = "swarm-mesh/pair/v1";

export interface PairingCode { mailbox: string; password: string; relay?: string }

/** Reads a short code as a person may type it: any case, with or without the dash, O for 0 and I or L for 1. */
export function parseCode(text: string): PairingCode | undefined {
  const [body = "", host] = text.trim().split("@");
  const normalized = body.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (normalized.length !== 8 || [...normalized].some((character) => !CODE_ALPHABET.includes(character))) return undefined;
  return { mailbox: normalized.slice(0, 2), password: normalized.slice(2),
    ...(host ? { relay: host.includes("://") ? host.replace(/\/$/, "") : `wss://${host}` } : {}) };
}

export const formatCode = (mailbox: string, password: string, relay?: string): string => {
  const code = `${mailbox}${password}`;
  return `${code.slice(0, 4)}-${code.slice(4)}${relay ? `@${relay.replace(/^wss:\/\//, "")}` : ""}`;
};

/** What two pairing devices tell each other about themselves. */
interface NodeInfo { id: string; name: string; addresses: string[]; relay?: string; relayName: string }
/** A member the inviter hands the joiner. */
interface Member extends NodeInfo { key: string; voucher: string }

async function nodeInfo(state: MeshState): Promise<NodeInfo> {
  const relay = relayOf(state.node);
  return { id: state.node.id, name: state.node.name, addresses: await advertisedAddresses(state.node), ...(relay ? { relay } : {}),
    relayName: relayName(state.node.keys.publicKey) };
}

const peerOf = (info: NodeInfo, key: string, extra: Partial<Peer> = {}): Peer => ({
  id: info.id, name: info.name, key, addresses: info.addresses, ...(info.relay ? { relay: info.relay } : {}), relayName: info.relayName,
  pairedAt: new Date().toISOString(), ...extra
});

/** Newline-delimited JSON messages over a stream. */
class Lines {
  private buffer = "";
  private readonly queue: string[] = [];
  private waiter?: (line: string | Error) => void;
  private ended?: Error;

  constructor(private readonly stream: Duplex) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > LINE_MAX) return void this.fail(new Error("The other device sent too much"));
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(line); } else this.queue.push(line);
      }
    });
    stream.on("close", () => this.fail(new Error("The other device closed the connection")));
    stream.on("error", (error) => this.fail(error));
    // A stream paused after its opener was read stays paused until told otherwise.
    stream.resume();
  }

  private fail(error: Error): void {
    this.ended ??= error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(error);
  }

  async next<T = Record<string, unknown>>(): Promise<T> {
    const line = this.queue.shift() ?? await new Promise<string | Error>((resolve) => {
      if (this.ended) return resolve(this.ended);
      this.waiter = resolve;
      setTimeout(() => { if (this.waiter === resolve) { this.waiter = undefined; resolve(new Error("The other device stopped answering")); } }, STEP_MS).unref();
    });
    if (line instanceof Error) throw line;
    const message = JSON.parse(line) as T & { error?: string };
    if (message.error) throw new Error(message.error);
    return message;
  }

  send(message: unknown): void {
    this.stream.write(`${JSON.stringify(message)}\n`);
  }
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64 = (text: unknown): Buffer => Buffer.from(typeof text === "string" ? text : "", "base64url");
/** Fields joined so that no two different lists of fields give the same bytes. */
const framed = (...fields: (string | Uint8Array)[]): Buffer =>
  Buffer.concat(fields.flatMap((field) => { const bytes = typeof field === "string" ? Buffer.from(field) : Buffer.from(field); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes]; }));

const Fn = ristretto255.Point.Fn;
function cpaceStart(password: string, mailbox: string, sid: Buffer): { secret: bigint; share: Uint8Array } {
  const generator = ristretto255_hasher.hashToCurve(framed(DSI, mailbox, password, sid));
  let secret = 0n;
  while (secret === 0n) secret = BigInt(`0x${randomBytes(64).toString("hex")}`) % Fn.ORDER;
  return { secret, share: generator.multiply(secret).toBytes() };
}

/** The session key from this side's secret and the other side's share; a share that is no valid point, or the identity, is refused. */
function cpaceKey(secret: bigint, other: Buffer, sid: Buffer, inviterShare: Uint8Array, joinerShare: Uint8Array): Buffer {
  const point = ristretto255.Point.fromBytes(other);
  if (point.equals(ristretto255.Point.ZERO)) throw new Error("The other device sent an invalid share");
  return createHash("sha512").update(framed(`${DSI}/key`, sid, inviterShare, joinerShare, point.multiply(secret).toBytes())).digest().subarray(0, 32);
}

const confirmation = (key: Buffer, role: "inviter" | "joiner"): string => createHmac("sha256", key).update(`${DSI}/confirm/${role}`).digest("base64url");
const same = (a: string, b: unknown): boolean => typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const derive = (key: Buffer | string, label: string): Buffer => Buffer.from(hkdfSync("sha256", typeof key === "string" ? Buffer.from(key, "base64url") : key, Buffer.alloc(0), `${DSI}/${label}`, 32));

function seal(key: Buffer, value: unknown, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return b64(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

function open<T>(key: Buffer, sealed: unknown, aad = ""): T {
  const bytes = unb64(sealed);
  if (bytes.length < 29) throw new Error("A sealed message is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8")) as T;
}

export class WrongCode extends Error {
  constructor() {
    super("The code is wrong");
  }
}

/**
 * The inviting side, after the opener: CPace with `password`, then the joiner's details for this node's and its members'.
 * Returns the joiner once it has stored what it was given. A wrong code throws WrongCode.
 */
export async function answerPairing(stream: Duplex, password: string, mailbox: string, home = meshHome()): Promise<Peer> {
  const lines = new Lines(stream);
  try {
    const hello = await lines.next<{ nonce?: string }>();
    const nonce = randomBytes(16);
    const sid = Buffer.concat([nonce, unb64(hello.nonce)]);
    const mine = cpaceStart(password, mailbox, sid);
    lines.send({ nonce: b64(nonce), share: b64(mine.share) });
    const reply = await lines.next<{ share?: string; confirm?: string }>();
    const theirs = unb64(reply.share);
    const key = cpaceKey(mine.secret, theirs, sid, mine.share, theirs);
    if (!same(confirmation(key, "joiner"), reply.confirm)) {
      lines.send({ error: "The code is wrong" });
      throw new WrongCode();
    }
    lines.send({ confirm: confirmation(key, "inviter") });
    const toJoiner = derive(key, "inviter-to-joiner");
    const joiner = open<{ node: NodeInfo }>(derive(key, "joiner-to-inviter"), (await lines.next<{ sealed: string }>()).sealed).node;
    const state = readMesh(home);
    if (joiner.id === state.node.id) {
      lines.send({ sealed: seal(toJoiner, { error: "This is this device's own code; join it from another device" }) });
      throw new Error("A device tried its own code");
    }
    // A member's id is its own: a device that claims one, even with the code, would take over that member's links.
    const member = state.peers.find((peer) => peer.id === joiner.id);
    if (member) {
      lines.send({ sealed: seal(toJoiner, { error: `This device is already in the swarm as ${member.name}; remove it with swarm mesh remove ${member.name} to pair it again` }) });
      throw new Error(`${member.name} tried to join again`);
    }
    const members: Member[] = state.peers.filter((peer) => peer.id !== joiner.id).map((peer) => {
      const pairKey = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + VOUCHER_DAYS * 86_400_000).toISOString();
      const voucher = b64(Buffer.from(JSON.stringify({ by: state.node.id,
        box: seal(derive(peer.key, "voucher"), { node: joiner, key: pairKey, issuedAt: new Date().toISOString(), expiresAt }, state.node.id) })));
      return { id: peer.id, name: peer.name, addresses: peer.addresses, ...(peer.relay ? { relay: peer.relay } : {}), relayName: peer.relayName ?? "", key: pairKey, voucher };
    });
    // Saved before the joiner hears back, so it may call this node the moment it has stored the answer.
    const peer = peerOf(joiner, derive(key, "pair-key").toString("base64url"));
    savePeer(peer, home);
    lines.send({ sealed: seal(toJoiner, { node: await nodeInfo(state), members }) });
    await lines.next<{ stored?: boolean }>();
    return peer;
  } finally {
    stream.end();
  }
}

/** The joining side, after its opener: CPace with `password`, then this node's details for the inviter's and its members'. */
export async function joinPairing(stream: Duplex, password: string, mailbox: string, home = meshHome()): Promise<{ inviter: Peer; members: Peer[] }> {
  const lines = new Lines(stream);
  try {
    const nonce = randomBytes(16);
    lines.send({ nonce: b64(nonce) });
    const hello = await lines.next<{ nonce?: string; share?: string }>();
    const sid = Buffer.concat([unb64(hello.nonce), nonce]);
    const mine = cpaceStart(password, mailbox, sid);
    const theirs = unb64(hello.share);
    const key = cpaceKey(mine.secret, theirs, sid, theirs, mine.share);
    lines.send({ share: b64(mine.share), confirm: confirmation(key, "joiner") });
    const confirmed = await lines.next<{ confirm?: string }>().catch((error: Error) => { throw error.message === "The code is wrong" ? new WrongCode() : error; });
    if (!same(confirmation(key, "inviter"), confirmed.confirm)) throw new Error("The other device could not prove it knows the code");
    const state = readMesh(home);
    lines.send({ sealed: seal(derive(key, "joiner-to-inviter"), { node: await nodeInfo(state) }) });
    const answer = open<{ node?: NodeInfo; members?: Member[]; error?: string }>(derive(key, "inviter-to-joiner"), (await lines.next<{ sealed: string }>()).sealed);
    if (answer.error || !answer.node) throw new Error(answer.error ?? "The other device sent no details");
    const inviter = peerOf(answer.node, derive(key, "pair-key").toString("base64url"));
    savePeer(inviter, home);
    const members = (answer.members ?? []).filter((member) => member.id !== state.node.id).map((member) => {
      const { key: pairKey, voucher, ...info } = member;
      const peer = peerOf(info, pairKey, { introducedBy: inviter.id, voucher });
      savePeer(peer, home);
      return peer;
    });
    lines.send({ stored: true });
    return { inviter, members };
  } finally {
    stream.end();
  }
}

/**
 * A member's side of an introduction: opens the voucher with the key it shares with the introducer, and pairs with the
 * device it vouches for. Anything amiss (an introducer that is no longer a peer, an expired voucher, a device removed
 * after the voucher was issued) leaves the state as it is, and the TLS handshake that follows decides. A member that
 * re-admits a removed device issues new vouchers, which count.
 */
export function acceptVoucher(voucher: string, home = meshHome()): boolean {
  try {
    const { by, box } = JSON.parse(unb64(voucher).toString("utf8")) as { by?: string; box?: string };
    const state = readMesh(home);
    const introducer = state.peers.find((peer) => peer.id === by);
    if (!introducer) return false;
    const { node, key, issuedAt, expiresAt } = open<{ node: NodeInfo; key: string; issuedAt: string; expiresAt: string }>(derive(introducer.key, "voucher"), box, introducer.id);
    if (expiresAt <= new Date().toISOString() || node.id === state.node.id || state.removed.some((item) => item.id === node.id && item.at >= issuedAt)) return false;
    if (state.peers.some((peer) => peer.id === node.id && peer.key === key)) return true;
    savePeer(peerOf(node, key, { introducedBy: introducer.id }), home);
    return true;
  } catch {
    return false;
  }
}

/** Answers a device that uses one of this node's direct invites; a wrong secret counts against the invite. */
const failedAttempts = new Map<string, number>();
export async function answerDirectInvite(stream: Duplex, inviteId: string, home = meshHome(), onJoin: (peer: Peer) => void = () => {}): Promise<void> {
  const invite = liveInvite(inviteId, home);
  if (!invite) {
    new Lines(stream).send({ error: "The invite is unknown, used or expired; make a new one with swarm mesh invite" });
    stream.end();
    return;
  }
  try {
    const peer = await answerPairing(stream, invite.secret, invite.id, home);
    dropInvite(invite.id, home);
    onJoin(peer);
  } catch (error) {
    if (!(error instanceof WrongCode)) throw error;
    const failures = (failedAttempts.get(invite.id) ?? 0) + 1;
    failedAttempts.set(invite.id, failures);
    if (failures >= ATTEMPTS) dropInvite(invite.id, home);
    throw error;
  }
}

/** Reads the opener a pairing stream starts with, and hands back what follows it. */
function readOpener(stream: Duplex): Promise<string> {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error("No opener")); }, STEP_MS);
    const cleanup = (): void => { clearTimeout(timer); stream.off("data", onData); };
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const at = head.indexOf(10);
      if (at < 0) { if (head.length > 4096) { cleanup(); reject(new Error("No opener")); } return; }
      cleanup();
      stream.pause();
      const rest = head.subarray(at + 1);
      if (rest.length) stream.unshift(rest);
      resolve(head.subarray(0, at).toString("utf8"));
    };
    stream.on("data", onData);
  });
}

export interface Invitation {
  code: string;
  expiresAt: Date;
  /** Settles when the invite ends: it expired, was cancelled after wrong codes, or `close` was called. */
  ended: Promise<string>;
  close(): void;
}

/**
 * Opens a short pairing code at the relay for `minutes`: every device that joins with it is paired with this node and
 * introduced to its members, and reported to `onJoin`. Three wrong codes cancel it.
 */
export async function inviteWithCode(options: { home?: string; minutes?: number; onJoin?: (peer: Peer) => void; onRefused?: (left: number) => void; log?: (message: string) => void } = {}): Promise<Invitation> {
  const home = options.home ?? meshHome();
  const minutes = options.minutes ?? INVITE_MINUTES;
  const relay = relayOf(readMesh(home).node);
  if (!relay) throw new Error("The relay is off here, so a short code cannot work; swarm mesh invite --direct makes a code with this node's address");
  const password = codeCharacters(6);
  let failures = 0;
  let cancel: (reason: string) => void = () => {};
  const cancelled = new Promise<string>((resolve) => { cancel = resolve; });
  const mailbox = await openMailbox(relay, minutes, (stream) => {
    void (async () => {
      const opener = await readOpener(stream);
      if (opener !== `${OPENER}pair ${mailboxName}`) return void stream.destroy();
      try {
        const peer = await answerPairing(stream, password, mailboxName, home);
        options.onJoin?.(peer);
      } catch (error) {
        if (!(error instanceof WrongCode)) return void options.log?.(`pairing failed: ${error instanceof Error ? error.message : String(error)}`);
        failures += 1;
        options.onRefused?.(ATTEMPTS - failures);
        if (failures >= ATTEMPTS) { mailbox.close(); cancel("Someone tried wrong codes three times, so the code was cancelled"); }
      }
    })().catch((error: Error) => options.log?.(`pairing: ${error.message}`));
  }, options.log);
  const mailboxName = mailbox.mailbox;
  const timer = setTimeout(() => mailbox.close(), minutes * 60_000);
  timer.unref();
  const ended = Promise.race([cancelled, mailbox.closed.then((reason) => reason === "The invite ended" ? `The code expired after ${minutes} minutes` : reason)]);
  void ended.then(() => clearTimeout(timer));
  return {
    // A code for any relay but the default one says which, so the joining device needs no setting to use it.
    code: formatCode(mailboxName, password, relay === DEFAULT_RELAY ? undefined : relay),
    expiresAt: new Date(Date.now() + minutes * 60_000), ended,
    close: () => { mailbox.close(); cancel("The invite was closed"); }
  };
}

/** Opens a raw TCP stream to the first of `addresses` that answers. */
async function dialAny(addresses: string[]): Promise<Duplex> {
  const errors: string[] = [];
  for (const address of addresses) {
    try {
      return await new Promise<Duplex>((resolve, reject) => {
        const { host, port } = parseListen(address);
        const socket = tcpConnect({ host, port });
        const timer = setTimeout(() => socket.destroy(new Error("timed out")), 8000);
        socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
    } catch (error) {
      errors.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`The inviting device is unreachable: ${errors.join("; ")}`);
}

/**
 * Joins with a short code (through the relay) or a direct invite (to the address it carries): pairs with the inviting
 * node and stores the members it introduced.
 */
export async function joinWithCode(text: string, home = meshHome()): Promise<{ inviter: Peer; members: Peer[] }> {
  if (isInviteCode(text)) {
    const invite = parseInvite(text);
    if (invite.expiresAt <= new Date().toISOString()) throw new Error("The invite expired; make a new one with swarm mesh invite");
    const stream = await dialAny(invite.addresses);
    stream.write(`${OPENER}pair ${invite.invite}\n`);
    return joinPairing(stream, invite.secret, invite.invite, home);
  }
  const code = parseCode(text);
  if (!code) throw new Error(`"${text}" is not a pairing code: it looks like K7QM-4ZX2`);
  const relay = code.relay ?? relayOf(readMesh(home).node);
  if (!relay) throw new Error("The relay is off here; turn it on with swarm mesh relay on, or join with the inviting device's swarm-mesh: code");
  const stream = await relayDial(relay, `code:${code.mailbox}`).catch((error: Error) => {
    throw new Error(/No device is waiting/.test(error.message) ? "No device is waiting for this code: it expired, was used up, or has a typo" : `Could not reach the relay: ${error.message}`);
  });
  stream.write(`${OPENER}pair ${code.mailbox}\n`);
  return joinPairing(stream, code.password, code.mailbox, home);
}
