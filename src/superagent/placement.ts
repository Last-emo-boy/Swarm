/**
 * Where a ticket's worker runs: on the node that accepted the ticket, or on a paired mesh node that a person chose or whose
 * abilities match what the router said the work needs. The accepting node owns the ticket and keeps its record; the node
 * that runs its worker holds a lease on the Assignment, which lapses when that node stops renewing it (see src/mesh/work.ts).
 */
import { latestAssignment, type Ticket } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { KV } from "./kv.js";

/** A paired node by its id, with the name it had when it was chosen. */
export interface NodeRef { id: string; name: string }

export interface Placement {
  /** The node a person chose: a paired node, or `here` for the node that owns the ticket. */
  on?: NodeRef | "here";
  /** What the router said the work needs of its machine, such as `gpu`, matched against paired nodes' abilities. */
  needs?: string[];
  /** The paired node that ran or runs an Assignment of the ticket, and the ticket's directory there. */
  ran?: NodeRef & { assignmentId: string; directory?: string };
  /** The paired node that pulled an Assignment of the ticket while it waited here for a worker. */
  pulled?: NodeRef & { assignmentId: string };
  at: string;
}

/** A paired node's hold on the Assignment whose worker it runs; it lapses at `expiresAt` unless the node renews it. */
export interface Lease {
  assignmentId: string;
  node: NodeRef;
  /** The ticket's directory on that node, once the node prepared it. */
  directory?: string;
  at: string;
  expiresAt: string;
}

type Records = Pick<SuperagentClient, "store">;

/** Changes the placement of a ticket, or of a request before it becomes one; an undefined field is removed. */
export function updatePlacement(client: Records, id: string, change: Partial<Omit<Placement, "at">>): void {
  client.store.set(KV.mesh.placement(id), { ...client.store.get(KV.mesh.placement(id)), ...change, at: new Date().toISOString() });
}

/** A ticket's placement: what its request was filed with, overridden by what was placed on the ticket itself. */
export function placementOf(client: Records, ticket: Ticket): Placement | undefined {
  const records = [...ticket.origin.triggerIds, ticket.id].flatMap((id) => client.store.get(KV.mesh.placement(id)) ?? []);
  return records.length ? Object.assign({}, ...records) as Placement : undefined;
}

export const leaseOf = (client: Records, ticketId: string): Lease | undefined => client.store.get(KV.mesh.lease(ticketId));

/**
 * Files a request whose worker runs on a paired node, on the harness profile `harness` when one is given; the request and
 * its placement are recorded together.
 */
export function requestOn(client: SuperagentClient, text: string, node: NodeRef, harness?: string): { triggerId: string; thread: string } {
  return client.store.atomic(() => {
    const filed = client.request(text, undefined, harness ? { harness } : {});
    updatePlacement(client, filed.triggerId, { on: node });
    return filed;
  });
}

/** The paired node a ticket's worker runs on, ran on last, or is placed on to start; undefined when that is the owner. */
export function workerNode(client: Records, ticket: Ticket): string | undefined {
  const lease = leaseOf(client, ticket.id);
  if (lease) return lease.node.name;
  const placement = placementOf(client, ticket);
  const latest = latestAssignment(ticket);
  if (placement?.ran && placement.ran.assignmentId === latest?.id) return placement.ran.name;
  return typeof placement?.on === "object" && !ticket.ended && (!latest || latest.state === "pending") ? placement.on.name : undefined;
}

/** The paired node that pulled the ticket's latest Assignment from this node, when one did. */
export function pulledBy(client: Records, ticket: Ticket): string | undefined {
  const pulled = client.store.get(KV.mesh.placement(ticket.id))?.pulled;
  return pulled && pulled.assignmentId === latestAssignment(ticket)?.id ? pulled.name : undefined;
}
