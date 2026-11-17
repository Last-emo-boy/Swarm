/**
 * Seeing and steering tickets across the mesh. A node serves its own tickets to its paired peers: the same rows, host
 * status and local replies its TUI shows, and the same request, say, stop and retry commands. A paired peer acts as
 * this node's operator: pairing is the trust decision, so its requests pass the local Source's gate like this node's.
 * Another node's ticket is shown and addressed as `<device>:<id>`.
 */
import { HttpError } from "../server/gateway-http.js";
import type { SuperagentClient } from "../superagent/client.js";
import { findTicket, hostStatus, localReplies, ticketMessages, ticketRow, ticketRows, type HostStatus, type TicketMessage, type TicketRow } from "../superagent/views.js";
import { callPeer } from "./client.js";
import { localOperator, localTrigger } from "../superagent/sources/local.js";

/** The commands a paired node may run on this one: reads only, a positive list, so a write added later cannot leak. */
export const PEER_READS = ["status", "tickets", "usage", "devices", "mesh", "me"] as const;
import type { MeshServer } from "./server.js";
import type { Peer } from "./state.js";

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

/** Serves this node's tickets on its mesh server. */
export function registerTicketRoutes(server: MeshServer, client: SuperagentClient,
  commands?: { commandText(trigger: import("../superagent/core/index.js").Trigger, name: never, args: readonly string[]): string | undefined }): void {
  if (commands) server.route("POST", "/mesh/v1/command", ({ body, peer }) => {
    const name = typeof body.name === "string" ? body.name : "";
    if (!(PEER_READS as readonly string[]).includes(name)) throw new HttpError(403, `A paired node may read only: ${PEER_READS.join(", ")}`);
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    // The peer speaks as this node's operator, the trust pairing already grants it; the command's own role gates still apply.
    const trigger = localTrigger({ id: `mesh-${peer?.id ?? "peer"}-${Date.now()}`, text: `/${name}${args.length ? ` ${args.join(" ")}` : ""}`, actor: localOperator() });
    const text = commands.commandText(trigger, name as never, args);
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
  server.route("POST", "/mesh/v1/requests", ({ body }) => ({ triggerId: client.request(text(body)).triggerId }));
  server.route("POST", "/mesh/v1/tickets/:handle/messages", ({ params, body }) => {
    const found = ticket(params.handle!);
    client.message(found.id, text(body));
    return { row: ticketRow(client, found) };
  });
  server.route("POST", "/mesh/v1/tickets/:handle/stop", ({ params, peer }) => {
    const found = ticket(params.handle!);
    client.stop(found.id, `Stopped from ${peer?.name ?? "a paired node"}`);
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
  const answer = await callPeer<{ row: TicketRow }>(peer, "POST", `/mesh/v1/tickets/${encodeURIComponent(id)}/${action}`, body);
  return deviceRow(answer.row, peer.name);
}

export const peerRequest = (peer: Peer, request: string): Promise<{ triggerId: string }> =>
  callPeer<{ triggerId: string }>(peer, "POST", "/mesh/v1/requests", { text: request });

/** Runs one read command on a paired node, which answers from its own store through the same command table. */
export const peerCommand = async (peer: Peer, name: string, args: readonly string[] = []): Promise<string> =>
  (await callPeer<{ text: string }>(peer, "POST", "/mesh/v1/command", { name, args })).text;
