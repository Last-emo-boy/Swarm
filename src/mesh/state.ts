/**
 * A Swarm node's mesh state in `<SWARM_HOME>/mesh/state.json`: its own identity and signing key, the peers it paired with,
 * the devices removed from its swarm, and the direct invites it handed out. Each pair of nodes shares one secret key:
 * every connection between them is TLS keyed with it, so only the two of them can talk on it (see link.ts).
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { getSwarmPaths } from "../config/settings.js";

export const DEFAULT_MESH_PORT = 38172;
/** How long an invite code stays valid by default. */
export const INVITE_MINUTES = 15;
/** The relay nodes meet at when they cannot reach each other directly; `swarm mesh relay` changes it, `off` turns it off. */
export const DEFAULT_RELAY = "wss://swarm-relay.w33d.xyz";

export const meshHome = (): string => process.env.SWARM_MESH_HOME ?? join(getSwarmPaths().home, "mesh");

const LentFoldersSchema = z.object({ roots: z.array(z.string().min(1)).min(1) });
/** What this node lends its paired peers, as the real paths of the folders each kind works in; nothing by default. */
const LendSchema = z.object({ shell: LentFoldersSchema.optional(), files: LentFoldersSchema.optional() });
/**
 * Pulling work: whether this node takes waiting work from its paired nodes when it has free worker slots (off by default),
 * only work of these repositories when it names any, and whether paired nodes that pull may take this node's own waiting
 * work (on by default: pairing already lets a peer run this node's work when it is placed there).
 */
const PullSchema = z.object({
  enabled: z.boolean().default(false),
  repositories: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "a repository as owner/name")).default([]),
  offer: z.boolean().default(true)
});
/** The node's Ed25519 key pair (DER, base64): the relay lets only its holder listen under the node's relay name. */
const KeysSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
const NodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  keys: KeysSchema.default(newKeys),
  /** host:port the mesh server binds; only paired peers get past its TLS, so it may face any network. */
  listen: z.string().default(`0.0.0.0:${DEFAULT_MESH_PORT}`),
  /** An address peers try first, as host:port, such as a forwarded port; the node also offers what it detects. */
  advertise: z.string().optional(),
  /** The relay's WebSocket URL, or `off`; unset means SWARM_MESH_RELAY or the default relay. */
  relay: z.string().optional(),
  lend: LendSchema.default({}),
  pull: PullSchema.default({ enabled: false, repositories: [], offer: true })
});
const PeerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The secret this node and the peer share (32 bytes, base64url). */
  key: z.string().min(43),
  /** The relay the peer listens at, and its name there. */
  relay: z.string().optional(),
  relayName: z.string().min(1).optional(),
  /** host:port addresses that may reach the peer directly, as its card last gave them. */
  addresses: z.array(z.string()).default([]),
  /** The member that introduced this pair, when one node joined the swarm through it. */
  introducedBy: z.string().optional(),
  /** The introduction this node shows the peer when it first calls it; dropped once the peer has accepted it. */
  voucher: z.string().optional(),
  pairedAt: z.string()
});
/** Peers paired before nodes shared keys had bearer tokens; they cannot be called any more and are left out. */
const PeersSchema = z.array(z.unknown()).default([])
  .transform((items) => items.flatMap((item) => { const peer = PeerSchema.safeParse(item); return peer.success ? [peer.data] : []; }));
/** A device removed from the swarm: its introductions are refused. */
const RemovedSchema = z.object({ id: z.string().min(1), name: z.string(), at: z.string() });
/** A direct invite this node answers itself, by its id: one pairing, until it expires. */
const InviteSchema = z.object({ id: z.string().min(1), secret: z.string().min(16), expiresAt: z.string() });
const StateSchema = z.object({
  node: NodeSchema,
  peers: PeersSchema,
  removed: z.array(RemovedSchema).default([]),
  invites: z.array(z.unknown()).default([])
    .transform((items) => items.flatMap((item) => { const invite = InviteSchema.safeParse(item); return invite.success ? [invite.data] : []; }))
});
export type Lend = z.infer<typeof LendSchema>;
export type Pull = z.infer<typeof PullSchema>;
export type MeshNode = z.infer<typeof NodeSchema>;
export type Peer = z.infer<typeof PeerSchema>;
export type MeshState = z.infer<typeof StateSchema>;
export type Removed = z.infer<typeof RemovedSchema>;

/** A direct invite: the addresses of the node that answers it, which invite, and its secret. */
const InviteCodeSchema = z.object({
  v: z.literal(2), addresses: z.array(z.string()).min(1), invite: z.string().min(1), name: z.string().min(1),
  secret: z.string().min(16), expiresAt: z.string()
});
export type InviteCode = z.infer<typeof InviteCodeSchema>;
const INVITE_PREFIX = "swarm-mesh:";

function newKeys(): z.infer<typeof KeysSchema> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}

/** A node's name at the relay: a hash of its public key, so only the key's holder can listen under it. */
export const relayName = (publicKey: string): string => `node:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64url").slice(0, 32)}`;

export const newPairKey = (): string => randomBytes(32).toString("base64url");
/** The name both ends of a pair give TLS for their shared key; it reveals neither node. */
export const pskIdentity = (key: string): string => createHmac("sha256", Buffer.from(key, "base64url")).update("swarm-mesh/psk-identity").digest("hex").slice(0, 32);

/** The relay this node uses, or undefined when it is off. */
export function relayOf(node: MeshNode): string | undefined {
  const relay = node.relay ?? process.env.SWARM_MESH_RELAY ?? DEFAULT_RELAY;
  return relay && relay !== "off" ? relay.replace(/\/$/, "") : undefined;
}

const statePath = (home: string): string => join(home, "state.json");

/**
 * The node's state, created with a fresh identity named after the host the first time. State from before nodes had keys
 * gets its key pair here, and is written back so the relay name stays the same.
 */
export function readMesh(home = meshHome()): MeshState {
  const path = statePath(home);
  if (!existsSync(path)) {
    const fresh = StateSchema.parse({ node: { id: randomUUID(), name: hostname().replace(/\.local$/, "") } });
    writeMesh(fresh, home);
    return fresh;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as { node?: { keys?: unknown } };
  const state = StateSchema.parse(raw);
  if (!raw.node?.keys) writeMesh(state, home);
  return state;
}

/** The paired peers, without creating mesh state on a device that never joined a mesh. */
export function meshPeers(home = meshHome()): Peer[] {
  return existsSync(statePath(home)) ? readMesh(home).peers : [];
}

/** Writes the state atomically, readable by its owner only: it holds the node's private key and the keys of its pairs. */
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

/**
 * Records a one-time direct invite that this node's running mesh server answers at `addresses`, and returns its code. A
 * short pairing code (pair.ts) needs no running server and no address; this one works without a relay.
 */
export function createInvite(addresses: string | string[], minutes = INVITE_MINUTES, home = meshHome(), now = new Date()): string {
  const invite = { id: randomBytes(9).toString("base64url"), secret: randomBytes(24).toString("base64url"),
    expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString() };
  const state = updateMesh((current) => ({
    ...current, invites: [...current.invites.filter((item) => item.expiresAt > now.toISOString()), invite]
  }), home);
  const code: InviteCode = { v: 2, addresses: [addresses].flat().map(hostPort), invite: invite.id, name: state.node.name, secret: invite.secret, expiresAt: invite.expiresAt };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(code)).toString("base64url");
}

export const isInviteCode = (text: string): boolean => text.trim().startsWith(INVITE_PREFIX);

export function parseInvite(text: string): InviteCode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error("Not a Swarm mesh invite code");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("The invite code is damaged; copy it again");
  }
  if ((parsed as { v?: unknown }).v === 1) throw new Error("The invite was made by an older Swarm; make a new one with swarm mesh invite");
  const code = InviteCodeSchema.safeParse(parsed);
  if (!code.success) throw new Error("The invite code is damaged; copy it again");
  return code.data;
}

/** A live direct invite by its id; expired ones are not. */
export function liveInvite(id: string, home = meshHome(), now = new Date()): { id: string; secret: string } | undefined {
  return readMesh(home).invites.find((invite) => invite.id === id && invite.expiresAt > now.toISOString());
}

/** Ends an invite, used or not, and drops expired ones on the way. */
export function dropInvite(id: string, home = meshHome(), now = new Date()): void {
  updateMesh((state) => ({ ...state, invites: state.invites.filter((invite) => invite.id !== id && invite.expiresAt > now.toISOString()) }), home);
}

/** Adds or replaces a peer: pairing again with the same node renews its key and addresses. A removed device comes back. */
export function savePeer(peer: Peer, home = meshHome()): MeshState {
  return updateMesh((state) => ({ ...state, peers: [...state.peers.filter((item) => item.id !== peer.id), peer],
    removed: state.removed.filter((item) => item.id !== peer.id) }), home);
}

/**
 * Forgets a peer; `tombstone` also refuses later introductions of it, for a device removed from the swarm, under the name
 * the remover gave when this node never met it.
 */
export function removePeer(id: string, home = meshHome(), tombstone: false | { name?: string } = false): MeshState {
  return updateMesh((state) => {
    const peer = state.peers.find((item) => item.id === id);
    const name = peer?.name ?? (tombstone ? tombstone.name : undefined) ?? id;
    return { ...state, peers: state.peers.filter((item) => item.id !== id),
      removed: tombstone ? [...state.removed.filter((item) => item.id !== id), { id, name, at: new Date().toISOString() }] : state.removed };
  }, home);
}

/** The peer that shares the key TLS named, if any. */
export function peerByIdentity(state: MeshState, identity: string): Peer | undefined {
  return state.peers.find((peer) => pskIdentity(peer.key) === identity);
}

/** `host:port` from either form a person may give: an address, or a URL such as an older advertised one. */
export function hostPort(address: string): string {
  if (!address.includes("://")) return address;
  const url = new URL(address);
  return `${url.hostname}:${url.port || DEFAULT_MESH_PORT}`;
}
