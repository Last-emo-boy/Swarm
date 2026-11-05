/**
 * A Swarm node's mesh state in `<SWARM_HOME>/mesh/state.json`: its own identity, the peers it paired with, and the
 * invites it handed out. Each pairing gives each side a bearer token of its own: a node keeps the token a peer issued
 * it (to call that peer) and only the hash of the token it issued the peer (to recognise it).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { getSwarmPaths } from "../config/settings.js";

export const DEFAULT_MESH_PORT = 38172;
/** How long an invite code stays valid by default. */
export const INVITE_MINUTES = 15;

export const meshHome = (): string => process.env.SWARM_MESH_HOME ?? join(getSwarmPaths().home, "mesh");

const NodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  /** host:port the mesh server binds; loopback until the device is put on a private network. */
  listen: z.string().default(`127.0.0.1:${DEFAULT_MESH_PORT}`),
  /** The URL peers call this node at, such as its tailnet name; derived from the network when unset. */
  advertise: z.string().url().optional()
});
const PeerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  /** The token this peer issued us: we send it when we call the peer. */
  token: z.string().min(1),
  /** The hash of the token we issued this peer: it sends that token when it calls us. */
  tokenHash: z.string().length(64),
  pairedAt: z.string()
});
const InviteSchema = z.object({ secretHash: z.string().length(64), expiresAt: z.string() });
const StateSchema = z.object({
  node: NodeSchema,
  peers: z.array(PeerSchema).default([]),
  invites: z.array(InviteSchema).default([])
});
export type MeshNode = z.infer<typeof NodeSchema>;
export type Peer = z.infer<typeof PeerSchema>;
export type MeshState = z.infer<typeof StateSchema>;

const InviteCodeSchema = z.object({
  v: z.literal(1), url: z.string().url(), id: z.string().min(1), name: z.string().min(1), secret: z.string().min(16),
  expiresAt: z.string()
});
export type InviteCode = z.infer<typeof InviteCodeSchema>;
const INVITE_PREFIX = "swarm-mesh:";

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (): string => randomBytes(32).toString("base64url");

/** Whether `token` hashes to `hash`, compared in constant time. */
export function tokenMatches(token: string, hash: string): boolean {
  const presented = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(hash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

const statePath = (home: string): string => join(home, "state.json");

/** The node's state, created with a fresh identity named after the host the first time. */
export function readMesh(home = meshHome()): MeshState {
  const path = statePath(home);
  if (!existsSync(path)) {
    const fresh = StateSchema.parse({ node: { id: randomUUID(), name: hostname().replace(/\.local$/, "") } });
    writeMesh(fresh, home);
    return fresh;
  }
  return StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The paired peers, without creating mesh state on a device that never joined a mesh. */
export function meshPeers(home = meshHome()): Peer[] {
  return existsSync(statePath(home)) ? readMesh(home).peers : [];
}

/** Writes the state atomically, readable by its owner only: it holds the tokens peers issued this node. */
export function writeMesh(state: MeshState, home = meshHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = statePath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(StateSchema.parse(state), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function updateMesh(change: (state: MeshState) => MeshState, home = meshHome()): MeshState {
  const next = change(readMesh(home));
  writeMesh(next, home);
  return next;
}

/** Finds a peer by id, by name, or by a unique prefix of either. */
export function findPeer(state: MeshState, handle: string): Peer {
  const exact = state.peers.find((peer) => peer.id === handle || peer.name === handle);
  if (exact) return exact;
  const matches = state.peers.filter((peer) => peer.id.startsWith(handle) || peer.name.startsWith(handle));
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `"${handle}" matches ${matches.map((peer) => peer.name).join(", ")}` : `No peer "${handle}"`);
}

/** Records a one-time invite and returns its code, which carries this node's address, identity and secret. */
export function createInvite(url: string, minutes = INVITE_MINUTES, home = meshHome(), now = new Date()): string {
  const secret = newToken();
  const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  const state = updateMesh((current) => ({
    ...current,
    invites: [...current.invites.filter((invite) => invite.expiresAt > now.toISOString()), { secretHash: hashToken(secret), expiresAt }]
  }), home);
  const code: InviteCode = { v: 1, url, id: state.node.id, name: state.node.name, secret, expiresAt };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(code)).toString("base64url");
}

export function parseInvite(text: string): InviteCode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error("Not a Swarm mesh invite code");
  try {
    return InviteCodeSchema.parse(JSON.parse(Buffer.from(trimmed.slice(INVITE_PREFIX.length), "base64url").toString("utf8")));
  } catch {
    throw new Error("The invite code is damaged; copy it again");
  }
}

/**
 * Spends an invite: true once for a live secret, which is then gone, and false for an unknown, used or expired one.
 * Expired invites are dropped on the way.
 */
export function spendInvite(secret: string, home = meshHome(), now = new Date()): boolean {
  let spent = false;
  updateMesh((state) => ({
    ...state,
    invites: state.invites.filter((invite) => {
      if (invite.expiresAt <= now.toISOString()) return false;
      if (!spent && tokenMatches(secret, invite.secretHash)) { spent = true; return false; }
      return true;
    })
  }), home);
  return spent;
}

/** Adds or replaces a peer: pairing again with the same node renews its tokens and address. */
export function savePeer(peer: Peer, home = meshHome()): MeshState {
  return updateMesh((state) => ({ ...state, peers: [...state.peers.filter((item) => item.id !== peer.id), peer] }), home);
}

export function removePeer(id: string, home = meshHome()): MeshState {
  return updateMesh((state) => ({ ...state, peers: state.peers.filter((peer) => peer.id !== id) }), home);
}

/** The peer a bearer token belongs to, if any. */
export function peerByToken(state: MeshState, token: string): Peer | undefined {
  return state.peers.find((peer) => tokenMatches(token, peer.tokenHash));
}
