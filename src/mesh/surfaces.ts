/**
 * The surfaces a paired node reaches on this node, in a positive table. A route is served only if this file names its
 * surface, so a route added without a line here cannot be reached at all; the presets below say what a peer's grant costs
 * it. The mesh server authorizes every request against these two tables (server.ts `authorize`).
 */
import { z } from "zod/v4";

/** What a peer's call can do here, named by its effect rather than its path. */
export const MESH_SURFACES = [
  "node.read", "node.peers", "tickets.read", "tickets.submit", "tickets.message", "tickets.steer",
  "tickets.stop", "tickets.retry", "commands.read", "work.claim", "work.offer", "work.lease",
  "lend.shell", "lend.files.read", "lend.files.write", "mesh.broker", "mesh.forget", "mesh.removed",
  "mesh.unpair", "mesh.lease"
] as const;
export type MeshSurface = (typeof MESH_SURFACES)[number];

/**
 * Every route this node serves and the surface it needs; `:name` segments are parameters, as in the server's matcher.
 * `tickets.steer` is named but not yet served: steering is part of the message route until leases split it off.
 */
export const MESH_ROUTES: readonly { method: string; path: string; surface: MeshSurface }[] = [
  { method: "GET", path: "/mesh/v1/node", surface: "node.read" },
  { method: "GET", path: "/mesh/v1/peers", surface: "node.peers" },
  { method: "GET", path: "/mesh/v1/usage", surface: "node.read" },
  { method: "POST", path: "/mesh/v1/unpair", surface: "mesh.unpair" },
  { method: "POST", path: "/mesh/v1/broker", surface: "mesh.broker" },
  { method: "POST", path: "/mesh/v1/forget", surface: "mesh.forget" },
  { method: "GET", path: "/mesh/v1/removed", surface: "mesh.removed" },
  { method: "POST", path: "/mesh/v1/leases", surface: "mesh.lease" },
  { method: "POST", path: "/mesh/v1/command", surface: "commands.read" },
  { method: "GET", path: "/mesh/v1/tickets", surface: "tickets.read" },
  { method: "GET", path: "/mesh/v1/tickets/:handle", surface: "tickets.read" },
  { method: "POST", path: "/mesh/v1/requests", surface: "tickets.submit" },
  { method: "POST", path: "/mesh/v1/tickets/:handle/messages", surface: "tickets.message" },
  { method: "POST", path: "/mesh/v1/tickets/:handle/stop", surface: "tickets.stop" },
  { method: "POST", path: "/mesh/v1/tickets/:handle/retry", surface: "tickets.retry" },
  { method: "GET", path: "/mesh/v1/work/open", surface: "work.claim" },
  { method: "POST", path: "/mesh/v1/work/claims", surface: "work.claim" },
  { method: "POST", path: "/mesh/v1/work/offers", surface: "work.offer" },
  { method: "POST", path: "/mesh/v1/work/offers/:ticket/stop", surface: "work.offer" },
  { method: "GET", path: "/mesh/v1/work/tickets/:ticket", surface: "work.lease" },
  { method: "GET", path: "/mesh/v1/work/tickets/:ticket/start", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/started", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/heartbeat", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/delivered", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/turn", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/report", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/tools/:tool", surface: "work.lease" },
  { method: "POST", path: "/mesh/v1/work/tickets/:ticket/exited", surface: "work.lease" }
];

const segments = (path: string): string[] => path.split("/").filter(Boolean);

/** The surface a route needs, or undefined for one no line of `MESH_ROUTES` names: such a route is refused at registration. */
export function surfaceOf(method: string, path: string): MeshSurface | undefined {
  const wanted = segments(path);
  return MESH_ROUTES.find((route) => {
    if (route.method !== method.toUpperCase()) return false;
    const pattern = segments(route.path);
    return pattern.length === wanted.length && pattern.every((part, index) => part.startsWith(":") || part === wanted[index]);
  })?.surface;
}

/** The strides a peer may be put on, weakest first; a grant names one, or the surfaces it lists one by one. */
export const GRANT_PRESETS = ["viewer", "member", "operator"] as const;
export type GrantPreset = (typeof GRANT_PRESETS)[number];
/**
 * What keeps the swarm itself together, which every grant reaches: reading a node's card and members, asking to be
 * introduced, unpairing, and asking for a lease. Each acts only on the caller's own pairing (pair.ts `brokerPeer`), so none
 * of them lends a capability. Removing another device from this node's swarm is `mesh.forget`, an operator's: a forget of
 * the caller itself is unpairing and passes as that (server.ts), and removals a peer carries count only from such a peer.
 */
const MEMBERSHIP: readonly MeshSurface[] = ["node.read", "node.peers", "mesh.broker", "mesh.removed", "mesh.unpair", "mesh.lease"];
/** What a viewer adds: seeing this node's tickets and its read commands, without changing either. */
const VIEWER: readonly MeshSurface[] = [...MEMBERSHIP, "tickets.read", "commands.read"];
/**
 * What each preset reaches. A member also files requests, takes waiting work, and works the lease it took (the lease
 * routes check that the caller holds that lease, work.ts `leased`); an operator keeps every surface, as a pairing once did.
 */
export const GRANT_SURFACES: Readonly<Record<GrantPreset, readonly MeshSurface[]>> = {
  viewer: VIEWER,
  member: [...VIEWER, "tickets.submit", "work.claim", "work.lease"],
  operator: MESH_SURFACES
};
/** What a peer may do here: one of the presets, or the surfaces it names itself. */
export type Grant = GrantPreset | { scopes: MeshSurface[] };
/** A peer record's grant as stored: a preset, or at least one surface of this version's table. */
export const GrantSchema = z.union([z.enum(GRANT_PRESETS), z.object({ scopes: z.array(z.enum(MESH_SURFACES)).min(1) })]);
export const authorizes = (grant: Grant, surface: MeshSurface): boolean =>
  (typeof grant === "string" ? GRANT_SURFACES[grant] : grant.scopes).includes(surface);
/** How a grant reads in a refusal and in `swarm mesh status`. */
export const describeGrant = (grant: Grant): string => typeof grant === "string" ? grant : `scopes: ${grant.scopes.join(", ")}`;
