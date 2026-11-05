/** Calling peers: requests with the token a peer issued this node, pairing with an invite code, and peer health. */
import { advertisedUrl, type NodeCard } from "./card.js";
import { hashToken, meshHome, newToken, parseInvite, readMesh, removePeer, savePeer, type Peer } from "./state.js";

const TIMEOUT_MS = 10_000;

export class MeshError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One JSON request to a node; an error answer or an unreachable node throws, with the node's message when it gave one. */
export async function meshFetch<T>(base: string, path: string, init: { method?: string; token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS)
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    throw new MeshError(0, `${base} is unreachable: ${cause}`);
  }
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    const message = (parsed as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
    throw new MeshError(response.status, message);
  }
  return parsed as T;
}

export const callPeer = <T>(peer: Peer, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
  meshFetch<T>(peer.url, path, { method, token: peer.token, ...(body !== undefined ? { body } : {}), ...(timeoutMs ? { timeoutMs } : {}) });

/**
 * Pairs with the node that printed `code`: sends it this node's identity, address and the token it may call this node
 * with, and keeps the token it answers with. Both sides then know each other.
 */
export async function joinMesh(code: string, home = meshHome()): Promise<Peer> {
  const invite = parseInvite(code);
  const { node } = readMesh(home);
  if (invite.id === node.id) throw new Error("This is this node's own invite; join it from the other device");
  if (invite.expiresAt <= new Date().toISOString()) throw new Error("The invite expired; make a new one with swarm mesh invite");
  const token = newToken();
  const answer = await meshFetch<{ node: NodeCard; token: string }>(invite.url, "/mesh/v1/pair", {
    method: "POST", body: { secret: invite.secret, node: { id: node.id, name: node.name, url: await advertisedUrl(node) }, token }
  });
  const peer: Peer = { id: answer.node.id, name: answer.node.name, url: invite.url.replace(/\/$/, ""), token: answer.token,
    tokenHash: hashToken(token), pairedAt: new Date().toISOString() };
  savePeer(peer, home);
  return peer;
}

export interface PeerHealth {
  peer: Pick<Peer, "id" | "name" | "url">;
  reachable: boolean;
  ms?: number;
  card?: NodeCard;
  error?: string;
}

/** Reads every peer's card at once; a peer that does not answer within the timeout is unreachable. */
export async function peerHealth(home = meshHome(), timeoutMs = 5000): Promise<PeerHealth[]> {
  return Promise.all(readMesh(home).peers.map(async (peer): Promise<PeerHealth> => {
    const started = Date.now();
    const about = { id: peer.id, name: peer.name, url: peer.url };
    try {
      const card = await callPeer<NodeCard>(peer, "GET", "/mesh/v1/node", undefined, timeoutMs);
      return { peer: about, reachable: true, ms: Date.now() - started, card };
    } catch (error) {
      return { peer: about, reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

/** Forgets a peer, telling it first so it forgets this node too; returns whether the peer heard. */
export async function unpair(peer: Peer, home = meshHome()): Promise<boolean> {
  const told = await callPeer(peer, "POST", "/mesh/v1/unpair", {}, 5000).then(() => true, () => false);
  removePeer(peer.id, home);
  return told;
}
