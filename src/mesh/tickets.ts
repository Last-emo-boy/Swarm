/**
 * Seeing and steering tickets across the mesh. A node serves its own tickets to its paired peers: the same rows, host
 * status and local replies its TUI shows, and the same request, say, stop and retry commands. What a peer reaches is its
 * grant's (surfaces.ts), which the mesh server checks before any of these run. An operator acts as this node's operator,
 * as a pairing did before grants; any other grant acts as the peer principal, so its work writes locally at most and its
 * sends count against the limits a person's message does. Another node's ticket is shown and addressed as `<device>:<id>`.
 */
import { randomUUID } from "node:crypto";
import { HttpError } from "../server/gateway-http.js";
import type { SuperagentClient } from "../superagent/client.js";
import type { CommandName } from "../superagent/command-table.js";
import { key, type Trigger } from "../superagent/core/index.js";
import { PEER_SOURCE } from "../superagent/policy.js";
import { localChannel, localOperator, localThread, localTrigger } from "../superagent/sources/local.js";
import { findTicket, hostStatus, localReplies, ticketMessages, ticketRow, ticketRows, type HostStatus, type TicketMessage, type TicketRow } from "../superagent/views.js";
import { callPeer } from "./client.js";
import { requireLease, useLease, withLease } from "./leases.js";
import type { MeshServer } from "./server.js";
import { grantOf, readMesh, type Peer } from "./state.js";
import { authorizes, type MeshSurface } from "./surfaces.js";

/** The commands a paired node may run on this one: reads only, a positive list, so a write added later cannot leak. */
export const PEER_READS = ["status", "tickets", "usage", "devices", "mesh", "me"] as const;

/** A message a peer posted to a local Thread, for the tickets list; a peer on an older version sends only these fields. */
export interface MeshReply { id: string; ticketId?: string; kind: string; text: string; status: string }
/** A message a peer queued for a ticket, with its delivery status and what it carries; a peer on an older version sends only the MeshReply fields. */
export type MeshTicketMessage = Pick<TicketMessage, "id" | "kind" | "text" | "status"> & Partial<TicketMessage>
export interface PeerTickets { rows: TicketRow[]; status: HostStatus; replies: MeshReply[] }

const text = (body: Record<string, unknown>): string => {
  const value = typeof body.text === "string" ? body.text.trim() : "";
  if (!value) throw new HttpError(400, "text is required");
  return value;
};

/** What serving requests needs of the host's command runner: read commands, and the limits a request passes like a person's. */
export interface MeshCommands {
  commandText(trigger: Trigger, name: CommandName, args: readonly string[]): Promise<string | undefined>;
  /** Why a paired node's request is held back by its role's limits, as a person's message would be; undefined takes it. */
  requestHeld(trigger: Trigger): string | undefined;
}

/**
 * A paired node's request as this node's Trigger: a local Thread of its own, its actor the peer. The mesh server checked
 * the surface before it gets here; `policy.ts` reads the peer from `meta.peer` and keeps its work's writes local.
 */
export function peerTrigger(peer: Peer, text: string): Trigger {
  const id = randomUUID();
  return {
    id: key(PEER_SOURCE, id),
    source: PEER_SOURCE,
    threads: [localThread(id)],
    actor: { source: PEER_SOURCE, id: peer.id, name: peer.name },
    human: true,
    addressed: "direct",
    at: new Date().toISOString(),
    text,
    channel: localChannel(id),
    meta: { requestId: id, peer: { id: peer.id, name: peer.name } }
  };
}

/** Serves this node's tickets on its mesh server. */
export function registerTicketRoutes(server: MeshServer, client: SuperagentClient, commands: MeshCommands): void {
  // The engine re-checks a paired node's Mandate against what this mesh lets that node do now (policy.ts `revalidate`).
  client.peerGrants = { reaches: (peerId, surface) => {
    const peer = readMesh(server.home).peers.find((item) => item.id === peerId);
    return !!peer && authorizes(grantOf(peer), surface as MeshSurface);
  } };
  server.route("POST", "/mesh/v1/command", async ({ body, peer }) => {
    const name = typeof body.name === "string" ? body.name : "";
    if (!(PEER_READS as readonly string[]).includes(name)) throw new HttpError(403, `A paired node may read only: ${PEER_READS.join(", ")}`);
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    const line = `/${name}${args.length ? ` ${args.join(" ")}` : ""}`;
    // An operator reads as this node's operator, as a pairing did before grants; any other grant reads as the peer
    // principal, so a command's own role gates (such as maintainer for /mesh) decide what it shows.
    const trigger = grantOf(peer) === "operator"
      ? localTrigger({ id: `mesh-${peer.id}-${Date.now()}`, text: line, actor: localOperator() })
      : peerTrigger(peer, line);
    const text = await commands.commandText(trigger, name as CommandName, args);
    return { text: text ?? "" };
  });
  const ticket = (handle: string) => {
    let found: ReturnType<typeof findTicket>;
    try { found = findTicket(client, handle); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
    if (!found) throw new HttpError(404, `No ticket ${handle}`);
    return found;
  };
  server.route("GET", "/mesh/v1/tickets", ({ query }): PeerTickets => ({
    rows: ticketRows(client, { ended: query.get("ended") === "1", limit: Math.min(Number(query.get("limit")) || 100, 200) }),
    status: hostStatus(client),
    replies: localReplies(client, 100)
  }));
  server.route("GET", "/mesh/v1/tickets/:handle", ({ params }) => {
    const found = ticket(params.handle!);
    return { row: ticketRow(client, found), messages: ticketMessages(client, found.id) };
  });
  server.route("POST", "/mesh/v1/requests", ({ body, peer }) => {
    // An operator files as this node's operator, as a pairing did before grants; any other grant files as the peer, whose
    // work writes locally at most and counts against its role's limits.
    if (grantOf(peer) === "operator") return { triggerId: client.request(text(body)).triggerId };
    const trigger = peerTrigger(peer, text(body));
    const held = commands.requestHeld(trigger);
    if (held) throw new HttpError(429, held);
    return { triggerId: client.receive(trigger).triggerId };
  });
  server.route("POST", "/mesh/v1/tickets/:handle/messages", ({ params, body, peer }) => {
    const found = ticket(params.handle!);
    // An operator speaks as this node's operator, as a pairing did before grants; any other grant speaks as the peer, whose
    // messages steer only the work it asked for (policy.ts `steers`).
    client.message(found.id, text(body), grantOf(peer) === "operator" ? localOperator() : { source: PEER_SOURCE, id: peer.id, name: peer.name });
    return { row: ticketRow(client, found) };
  });
  server.route("POST", "/mesh/v1/tickets/:handle/stop", ({ params, peer, headers }) => {
    const found = ticket(params.handle!);
    // Stopping ends work that cannot be had back, so it takes a lease on this one ticket.
    const lease = requireLease(peer, "tickets.stop", headers, (resource) => resource === found.id, server.home);
    client.stop(found.id, `Stopped from ${peer.name}`);
    if (lease) useLease(lease.id, server.home);
    return { row: ticketRow(client, client.store.tickets.get(found.id) ?? found) };
  });
  server.route("POST", "/mesh/v1/tickets/:handle/retry", ({ params }) => {
    const found = ticket(params.handle!);
    client.retry(found.id);
    return { row: ticketRow(client, client.store.tickets.get(found.id) ?? found) };
  });
}

/** Marks a peer's row as that device's: its handle becomes `<device>:<id>`. */
export const deviceRow = (row: TicketRow, device: string): TicketRow => ({ ...row, device, short: `${device}:${row.short}` });

/** Splits `<device>:<id>` into its parts; a handle without a device names this node's ticket. */
export function splitHandle(handle: string): { device?: string; id: string } {
  const at = handle.lastIndexOf(":");
  return at > 0 ? { device: handle.slice(0, at), id: handle.slice(at + 1) } : { id: handle };
}

export async function peerTickets(peer: Peer, timeoutMs = 4000): Promise<PeerTickets> {
  const answer = await callPeer<PeerTickets>(peer, "GET", "/mesh/v1/tickets?ended=1&limit=100", undefined, timeoutMs);
  return { ...answer, rows: answer.rows.map((row) => deviceRow(row, peer.name)) };
}

export async function peerTicket(peer: Peer, id: string): Promise<{ row: TicketRow; messages: MeshTicketMessage[] }> {
  const answer = await callPeer<{ row: TicketRow; messages: MeshTicketMessage[] }>(peer, "GET", `/mesh/v1/tickets/${encodeURIComponent(id)}`);
  return { ...answer, row: deviceRow(answer.row, peer.name) };
}

export async function peerAct(peer: Peer, id: string, action: "messages" | "stop" | "retry", body: Record<string, unknown> = {}): Promise<TicketRow> {
  const path = `/mesh/v1/tickets/${encodeURIComponent(id)}/${action}`;
  // A stop is leased on the ticket's full id, which the peer resolves from the handle first.
  const answer = action === "stop"
    ? await withLease(peer, "tickets.stop", (await peerTicket(peer, id)).row.id, (headers) => callPeer<{ row: TicketRow }>(peer, "POST", path, body, undefined, headers), "stop a ticket")
    : await callPeer<{ row: TicketRow }>(peer, "POST", path, body);
  return deviceRow(answer.row, peer.name);
}

export const peerRequest = (peer: Peer, request: string): Promise<{ triggerId: string }> =>
  callPeer<{ triggerId: string }>(peer, "POST", "/mesh/v1/requests", { text: request });

/** Runs one read command on a paired node, which answers from its own store through the same command table. */
export const peerCommand = async (peer: Peer, name: string, args: readonly string[] = []): Promise<string> =>
  (await callPeer<{ text: string }>(peer, "POST", "/mesh/v1/command", { name, args })).text;
