/**
 * Leases for what cannot be undone. A grant says which surfaces a peer reaches; for the three whose effect stays after the
 * call (running a lent shell, putting work on this node, stopping a ticket) the peer also asks this node for a lease on the
 * one resource it acts on, and names that lease on the call. Only the node that is acted on mints a lease, only for a
 * surface the asker's grant reaches, for a short time, and every lease is kept so it can be seen and ended.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { HttpError } from "../server/gateway-http.js";
import { callPeer, MeshError } from "./client.js";
import { grantOf, meshHome, readMesh, updateMesh, type MeshLease, type Peer } from "./state.js";
import { authorizes, describeGrant, type MeshSurface } from "./surfaces.js";

/** The surfaces a call reaches only with a lease, each on one resource: a lent shell's folder, a ticket's work, a ticket. */
export const LEASED_SURFACES = ["lend.shell", "work.offer", "tickets.stop"] as const satisfies readonly MeshSurface[];
export type LeasedSurface = (typeof LEASED_SURFACES)[number];
/** The header a call names its lease in. */
export const LEASE_HEADER = "x-swarm-lease";
/**
 * The header every call of a Swarm that knows leases carries (link.ts). A call without it comes from a node of the version
 * before leases, which cannot ask for one: an operator's such call is taken without a lease, as an operator could mint any
 * lease it named, so this lets nothing through that its grant does not already reach.
 */
export const LEASES_HEADER = "x-swarm-leases";
/** How long a lease holds unless the asker names less, the longest it may, and how many one peer may hold at once. */
export const LEASE_MINUTES = 30, LEASE_MAX_MINUTES = 60, LEASES_PER_PEER = 8;
/** How long a held lease must still run to be handed out again rather than replaced. */
const FRESH_MS = 2 * 60_000;

export const LeaseRequestSchema = z.object({
  surface: z.enum(LEASED_SURFACES),
  resource: z.string().min(1).max(1024),
  ttlMinutes: z.number().int().min(1).max(LEASE_MAX_MINUTES).optional(),
  reason: z.string().max(200).optional()
});
/** What a peer gets back: the lease to name on its call, and until when it holds. */
export interface LeaseAnswer { leaseId: string; surface: LeasedSurface; resource: string; expiresAt: string }

const live = (lease: MeshLease, now = Date.now()): boolean => Date.parse(lease.expiresAt) > now;

/**
 * Mints a lease for `peer` on this node: its grant must reach the surface, and it may hold only so many at once. Asking
 * again for a surface and resource it holds a live lease on answers that lease, so a retried call does not pile them up.
 */
export function mintLease(peer: Peer, body: unknown, home = meshHome()): LeaseAnswer {
  const asked = LeaseRequestSchema.parse(body);
  const grant = grantOf(peer);
  if (!authorizes(grant, asked.surface)) throw new HttpError(403, `${peer.name}'s grant (${describeGrant(grant)}) does not allow ${asked.surface}, so no lease for it`);
  let answer: LeaseAnswer | undefined;
  updateMesh((state) => {
    const now = Date.now();
    const leases = state.leases.filter((lease) => live(lease, now));
    // A lease about to end is not handed out again: the asker treats one with less than its margin left as gone.
    const held = leases.find((lease) => lease.by === peer.id && lease.surface === asked.surface && lease.resource === asked.resource
      && Date.parse(lease.expiresAt) - now > FRESH_MS);
    if (held) {
      answer = { leaseId: held.id, surface: asked.surface, resource: held.resource, expiresAt: held.expiresAt };
      return { ...state, leases };
    }
    if (leases.filter((lease) => lease.by === peer.id && lease.surface === asked.surface).length >= LEASES_PER_PEER) {
      throw new HttpError(429, `${peer.name} holds ${LEASES_PER_PEER} ${asked.surface} leases here already; one ends when it is used or expires`);
    }
    const lease: MeshLease = { id: randomUUID(), surface: asked.surface, resource: asked.resource, by: peer.id, at: new Date(now).toISOString(),
      expiresAt: new Date(now + (asked.ttlMinutes ?? LEASE_MINUTES) * 60_000).toISOString(), ...(asked.reason ? { reason: asked.reason } : {}) };
    answer = { leaseId: lease.id, surface: asked.surface, resource: lease.resource, expiresAt: lease.expiresAt };
    return { ...state, leases: [...leases, lease] };
  }, home);
  return answer!;
}

/**
 * The lease a call names, checked: live, minted for this peer, on this surface, and on a resource `covers` accepts. A call
 * without one, or with one that does not fit, is refused with what to ask for. Returns the lease, for the audit.
 */
export function requireLease(peer: Peer, surface: LeasedSurface, headers: Record<string, string | string[] | undefined>, covers: (resource: string) => boolean,
  home = meshHome()): MeshLease | undefined {
  if (!headers[LEASES_HEADER] && grantOf(peer, home) === "operator") return undefined;
  const header = headers[LEASE_HEADER];
  const id = Array.isArray(header) ? header[0] : header;
  const ask = `ask for one with POST /mesh/v1/leases {"surface":"${surface}"}`;
  if (!id) throw new HttpError(403, `${surface} needs a lease from this node: ${ask}`);
  const lease = readMesh(home).leases.find((item) => item.id === id);
  if (!lease || lease.by !== peer.id) throw new HttpError(403, `No lease ${id} of ${peer.name} here: ${ask}`);
  if (!live(lease)) throw new HttpError(403, `The lease ${id} expired at ${lease.expiresAt}: ${ask}`);
  if (lease.surface !== surface) throw new HttpError(403, `The lease ${id} is for ${lease.surface}, not ${surface}`);
  if (!covers(lease.resource)) throw new HttpError(403, `The lease ${id} is for ${lease.resource}, which this call does not act on`);
  return lease;
}

/** Ends a lease once the call it covered has done what cannot be undone: a stop or an offer is used once. */
export function useLease(id: string, home = meshHome()): void {
  updateMesh((state) => ({ ...state, leases: state.leases.filter((lease) => lease.id !== id) }), home);
}

/** Leases this process holds on peers, by peer, surface and resource, until a minute before each expires. */
const held = new Map<string, LeaseAnswer>();
/**
 * Runs `call` with a lease from `peer` on `surface` and `resource`, asking for one first unless this process holds a live
 * one. A peer from before leases has no such route: then the call goes without one, as that peer asks for none.
 */
export async function withLease<T>(peer: Peer, surface: LeasedSurface, resource: string, call: (headers: Record<string, string>) => Promise<T>,
  reason?: string): Promise<T> {
  const key = `${peer.id}\u0000${surface}\u0000${resource}`;
  // A stop or an offer uses its lease up, so only a shell's lease is kept for the next call.
  const once = surface !== "lend.shell";
  let lease = held.get(key);
  if (!lease || Date.parse(lease.expiresAt) - 60_000 <= Date.now()) {
    try {
      lease = await callPeer<LeaseAnswer>(peer, "POST", "/mesh/v1/leases", { surface, resource, ...(reason ? { reason: reason.slice(0, 200) } : {}) }, 10_000);
      held.set(key, lease);
    } catch (error) {
      if (error instanceof MeshError && error.status === 404) return call({});
      throw error;
    }
  }
  try {
    const answer = await call({ [LEASE_HEADER]: lease.leaseId });
    if (once) held.delete(key);
    return answer;
  } catch (error) {
    // A lease the peer no longer knows (it was used, the pair was made again, or the state restored) is asked for once more.
    if (error instanceof MeshError && error.status === 403 && /lease/.test(error.message)) {
      held.delete(key);
      const fresh = await callPeer<LeaseAnswer>(peer, "POST", "/mesh/v1/leases", { surface, resource }, 10_000);
      if (!once) held.set(key, fresh);
      return call({ [LEASE_HEADER]: fresh.leaseId });
    }
    throw error;
  }
}
