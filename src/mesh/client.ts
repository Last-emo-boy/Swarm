/** Calling peers over their links, pairing with a code, peer health, and leaving or removing devices. */
import type { NodeCard } from "./card.js";
import { MeshError, describePath, pathTo, peerRequest } from "./link.js";
import { joinWithCode, nodeInfo, peerOf, type Member } from "./pair.js";
import { meshHome, readMesh, removePeer, savePeer, updateMesh, type Peer } from "./state.js";

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

/** How many introductions one pass asks for, so a large swarm cannot make a pass long. */
const BROKERS_PER_MEET = 4;

/**
 * One pass of keeping the swarm current: read every peer's card, so an address that changed is taken up, then ask a peer
 * that knows a member this node lacks to introduce it — any shared peer will do, so a joiner reaches everyone whether or
 * not the device it joined through is online now. A device both sides lack lets the smaller id ask, so two nodes never mint
 * different keys for the same pair in one pass. The introductions a peer has not accepted yet are sent again by each
 * handshake, which is how a member that was offline at pairing time catches up.
 */
export async function meet(home = meshHome(), timeoutMs = 3000): Promise<PeerHealth[]> {
  const health = await peerHealth(home, timeoutMs);
  const reached = new Set(health.flatMap((item) => item.reachable ? [item.peer.id] : []));
  const state = readMesh(home);
  const known = new Set(state.peers.map((peer) => peer.id));
  const gone = new Set(state.removed.map((item) => item.id));
  let asked = 0;
  let added = 0;
  const self = await nodeInfo(state);
  for (const broker of state.peers) {
    if (asked >= BROKERS_PER_MEET || !reached.has(broker.id)) continue;
    let listed: { id: string }[];
    try { listed = await callPeer<{ id: string }[]>(broker, "GET", "/mesh/v1/peers", undefined, timeoutMs); } catch { continue }
    for (const candidate of listed) {
      if (asked >= BROKERS_PER_MEET) break;
      if (candidate.id === state.node.id || known.has(candidate.id) || gone.has(candidate.id)) continue;
      // One side asks: two devices must not mint different keys for the same pair at the same time.
      if (state.node.id > candidate.id) continue;
      try {
        const member = await callPeer<Member>(broker, "POST", "/mesh/v1/broker", { id: candidate.id, node: self }, timeoutMs);
        const { key, voucher, ...info } = member;
        savePeer(peerOf(info, key, { introducedBy: broker.id, voucher }), home);
        known.add(member.id);
        asked += 1;
        added += 1;
      } catch { /* It may have been removed, or that peer may no longer know it. */ }
    }
  }
  return added ? peerHealth(home, timeoutMs) : health;
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
