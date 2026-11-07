/** Calling peers over their links, pairing with a code, peer health, and leaving or removing devices. */
import type { NodeCard } from "./card.js";
import { MeshError, describePath, pathTo, peerRequest } from "./link.js";
import { joinWithCode } from "./pair.js";
import { meshHome, readMesh, removePeer, updateMesh, type Peer } from "./state.js";

export { MeshError, closePeerLinks } from "./link.js";

export const callPeer = <T>(peer: Peer, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
  peerRequest<T>(peer, method, path, body, timeoutMs);

/**
 * Pairs with the device that gave out `code`, a short pairing code or a direct invite, and stores the members of its
 * swarm it introduced. Returns the inviting device.
 */
export async function joinMesh(code: string, home = meshHome()): Promise<Peer> {
  return (await joinWithCode(code, home)).inviter;
}

export interface PeerHealth {
  peer: Pick<Peer, "id" | "name" | "addresses">;
  reachable: boolean;
  /** How this process reached it, when it did. */
  path?: string;
  ms?: number;
  card?: NodeCard;
  error?: string;
}

/**
 * Reads every peer's card at once; a peer that does not answer within the timeout is unreachable. What a card says about
 * where to reach its node is kept, and an introduction a peer has accepted is not shown to it again.
 */
export async function peerHealth(home = meshHome(), timeoutMs = 5000): Promise<PeerHealth[]> {
  const health = await Promise.all(readMesh(home).peers.map(async (peer): Promise<PeerHealth> => {
    const started = Date.now();
    const about = { id: peer.id, name: peer.name, addresses: peer.addresses };
    try {
      const card = await callPeer<NodeCard>(peer, "GET", "/mesh/v1/node", undefined, timeoutMs);
      // Another node's card means the record leads somewhere else: taking its addresses would point the record there for good.
      if (card.id !== peer.id) return { peer: about, reachable: false, error: `it answered as ${card.name}, another node: this record of ${peer.name} leads elsewhere, so pair again` };
      return { peer: about, reachable: true, path: describePath(pathTo(peer.id)), ms: Date.now() - started, card };
    } catch (error) {
      return { peer: about, reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const reached = new Map(health.flatMap((item) => item.card ? [[item.peer.id, item.card] as const] : []));
  if (reached.size) {
    updateMesh((state) => ({ ...state, peers: state.peers.map((peer) => {
      const card = reached.get(peer.id);
      if (!card) return peer;
      const { voucher: _accepted, ...rest } = peer;
      return { ...rest, name: card.name, addresses: card.addresses, relayName: card.relayName, ...(card.relay ? { relay: card.relay } : {}) };
    }) }), home);
  }
  return health;
}

/** Forgets a peer, telling it first so it forgets this node too; returns whether the peer heard. */
export async function unpair(peer: Peer, home = meshHome()): Promise<boolean> {
  const told = await callPeer(peer, "POST", "/mesh/v1/unpair", {}, 5000).then(() => true, () => false);
  removePeer(peer.id, home);
  return told;
}

/**
 * Removes a device from the swarm: it is told to forget this node, every other member is told to forget it, and this
 * node keeps a tombstone so introductions of it are refused. Says whether the device heard, and which members did not.
 */
export async function removeFromSwarm(peer: Peer, home = meshHome()): Promise<{ told: boolean; missed: string[] }> {
  const others = readMesh(home).peers.filter((item) => item.id !== peer.id);
  const [told, ...heard] = await Promise.all([
    callPeer(peer, "POST", "/mesh/v1/unpair", {}, 5000).then(() => true, () => false),
    ...others.map((other) => callPeer(other, "POST", "/mesh/v1/forget", { id: peer.id, name: peer.name }, 5000).then(() => true, () => false))
  ]);
  removePeer(peer.id, home, { name: peer.name });
  return { told: told!, missed: others.filter((_, index) => !heard[index]).map((other) => other.name) };
}
