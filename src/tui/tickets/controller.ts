/**
 * The TUI's link to the superagent: a client on its database, opened once the database exists or the operator files a
 * ticket, and a host run inside the TUI when no other host runs, so a ticket filed here gets worked on. A host the TUI
 * started stops with it; `swarm superagent run` keeps one running on its own. The superagent's modules load on first use,
 * so a TUI that never touches tickets starts as fast as before. With paired mesh devices, their tickets join this node's
 * in every view, as `<device>:<id>`, and what the operator does to one goes to the device that owns it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSwarmPaths } from "../../config/settings.js";
import type { Complete } from "../../superagent/assessor.js";
import type { SuperagentClient } from "../../superagent/client.js";
import type { SuperagentHost } from "../../superagent/host.js";
import type { HostStatus, TicketRow } from "../../superagent/views.js";
import { meshPeers, type Peer } from "../../mesh/state.js";
import type { PeerTickets } from "../../mesh/tickets.js";
import { paneOrder } from "./view-model.js";

export interface TicketSnapshot {
  rows: TicketRow[];
  status: HostStatus;
  /** Paired devices that did not answer the last refresh; their tickets are left out until they do. */
  unreachable?: string[];
}
export interface TicketReply { id: string; ticketId?: string; kind: string; text: string; device?: string }

type Views = typeof import("../../superagent/views.js");
type MeshTickets = typeof import("../../mesh/tickets.js");
/** How often paired devices' tickets are read again while the TUI polls. */
const REMOTE_EVERY_MS = 4000;

function mergedStatus(local: HostStatus | undefined, remote: readonly HostStatus[]): HostStatus {
  const counts = { person: 0, working: 0, queued: 0, idle: 0, ended: 0, ...local?.counts };
  for (const status of remote) for (const [group, count] of Object.entries(status.counts)) counts[group as keyof typeof counts] += count;
  return { ...(local ?? { health: {} }), running: !!local?.running || remote.some((status) => status.running), counts };
}

export class TuiTickets {
  private client?: SuperagentClient;
  private views?: Views;
  private host?: SuperagentHost;
  private starting?: Promise<boolean>;
  /** Reply ids already shown, per device ("" for this node), so a device's first read only notes what it had. */
  private readonly seen = new Map<string, Set<string>>();
  private remote = new Map<string, PeerTickets>();
  private unreachable: string[] = [];
  private refreshing?: Promise<void>;
  private refreshedAt = 0;
  private mesh?: MeshTickets;
  readonly stateDir: string;

  constructor(private readonly options: { stateDir?: string; meshHome?: string; complete?: () => Complete | undefined; log: (message: string) => void }) {
    this.stateDir = options.stateDir ?? process.env.SWARM_SUPERAGENT_HOME ?? join(getSwarmPaths().home, "superagent");
  }

  /** Whether this node has a superagent database. */
  private local(): boolean { return !!this.client || existsSync(join(this.stateDir, "superagent.db")); }
  private peers(): Peer[] { return meshPeers(this.options.meshHome); }
  /** Whether there is anything to show: this node's tickets or a paired device's. */
  available(): boolean { return this.local() || this.peers().length > 0; }
  /** Whether this TUI runs the host. */
  hosting(): boolean { return !!this.host; }

  private async open(): Promise<{ client: SuperagentClient; views: Views }> {
    if (!this.client || !this.views) {
      const [{ SuperagentClient }, views] = await Promise.all([import("../../superagent/client.js"), import("../../superagent/views.js")]);
      this.client ??= new SuperagentClient({ stateDir: this.stateDir });
      this.views = views;
    }
    return { client: this.client, views: this.views };
  }

  private async meshModule(): Promise<MeshTickets> {
    this.mesh ??= await import("../../mesh/tickets.js");
    return this.mesh;
  }

  /** Reads every paired device's tickets once; a device that does not answer is left out until it does. */
  async refreshRemote(): Promise<void> {
    this.refreshing ??= (async () => {
      const { peerTickets } = await this.meshModule();
      const answers = await Promise.all(this.peers().map(async (peer) => [peer.name, await peerTickets(peer).catch(() => undefined)] as const));
      this.remote = new Map(answers.filter((answer): answer is readonly [string, PeerTickets] => !!answer[1]));
      this.unreachable = answers.filter(([, tickets]) => !tickets).map(([name]) => name);
      this.refreshedAt = Date.now();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** This node's tickets and those of its paired devices, with the hosts' state, while there is any. */
  async snapshot(): Promise<TicketSnapshot | undefined> {
    if (this.peers().length && Date.now() - this.refreshedAt > REMOTE_EVERY_MS) void this.refreshRemote();
    const local = this.local() ? await this.open().then(({ client, views }) => ({
      rows: views.ticketRows(client, { ended: true, limit: 100 }), status: views.hostStatus(client)
    })) : undefined;
    const remote = [...this.remote.values()];
    if (!local && !remote.length && !this.unreachable.length) return undefined;
    const rows = [...local?.rows ?? [], ...remote.flatMap((tickets) => tickets.rows)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { rows: paneOrder(rows), status: mergedStatus(local?.status, remote.map((tickets) => tickets.status)),
      ...(this.unreachable.length ? { unreachable: [...this.unreachable] } : {}) };
  }

  /** Replies posted to local Threads, here and on paired devices, since the last call; a device's first read only notes what it had. */
  async newReplies(): Promise<TicketReply[]> {
    const sources: [string, TicketReply[]][] = [...this.remote].map(([device, tickets]) => [device, tickets.replies.map((reply) => ({ ...reply, device }))]);
    if (this.local()) {
      const { client, views } = await this.open();
      sources.unshift(["", views.localReplies(client, 100)]);
    }
    const fresh: TicketReply[] = [];
    for (const [device, replies] of sources) {
      const seen = this.seen.get(device);
      if (!seen) { this.seen.set(device, new Set(replies.map((reply) => reply.id))); continue; }
      for (const reply of replies) if (!seen.has(reply.id)) { seen.add(reply.id); fresh.push(reply); }
    }
    return fresh;
  }

  private peer(device: string): Peer {
    const peer = this.peers().find((item) => item.name === device || item.id === device);
    if (!peer) throw new Error(`No paired device "${device}"; see swarm mesh status`);
    return peer;
  }

  /** Where a handle's ticket lives: `<device>:<id>`, this node's ticket, or a paired device's ticket by its id alone. */
  private async locate(handle: string): Promise<{ row: TicketRow; peer?: Peer } | undefined> {
    const { splitHandle, peerTicket } = await this.meshModule();
    const { device, id } = splitHandle(handle);
    if (device) {
      const peer = this.peer(device);
      return { row: (await peerTicket(peer, id)).row, peer };
    }
    if (this.local()) {
      const { client, views } = await this.open();
      const ticket = views.findTicket(client, id);
      if (ticket) return { row: views.ticketRow(client, ticket) };
    }
    const matches = [...this.remote.values()].flatMap((tickets) => tickets.rows).filter((row) => row.id.startsWith(id));
    if (matches.length > 1) throw new Error(`${handle} names tickets on ${matches.map((row) => row.device).join(", ")}; give it as <device>:<id>`);
    const [row] = matches;
    return row ? { row, peer: this.peer(row.device!) } : undefined;
  }

  /** Starts a host in this TUI unless one runs; returns whether this call started it. */
  async ensureHost(): Promise<boolean> {
    const { lockHolder } = await import("../../superagent/host.js");
    if (this.host || lockHolder(this.stateDir)) return false;
    this.starting ??= (async () => {
      const [{ SuperagentHost }, { selfCommand }, { providerComplete }] = await Promise.all([
        import("../../superagent/host.js"), import("../../superagent/cli.js"), import("../../superagent/provider.js")
      ]);
      const complete = this.options.complete?.() ?? await providerComplete();
      const host = new SuperagentHost({ stateDir: this.stateDir, workerCommand: selfCommand(), complete, log: this.options.log });
      await host.start();
      this.host = host;
      return true;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Files a request here, on the agent harness `harness` when one is given, or on a paired device, which then owns the ticket. */
  async request(text: string, device?: string, harness?: string): Promise<{ triggerId: string }> {
    if (device) return (await this.meshModule()).peerRequest(this.peer(device), text);
    return (await this.open()).client.request(text, undefined, harness ? { harness } : {});
  }
  /** Files a request here whose worker runs on a paired node; `mesh` says whether a mesh node's host runs here to place it. */
  async requestOn(text: string, node: string, harness?: string): Promise<{ triggerId: string; placed: string; mesh: boolean }> {
    const { id, name } = this.peer(node);
    const [{ client, views }, { requestOn }] = await Promise.all([this.open(), import("../../superagent/placement.js")]);
    const { triggerId } = requestOn(client, text, { id, name }, harness);
    const status = views.hostStatus(client);
    return { triggerId, placed: name, mesh: status.running && !!status.health.mesh };
  }
  async find(handle: string): Promise<TicketRow | undefined> { return (await this.locate(handle))?.row; }
  async messages(handle: string): Promise<TicketReply[]> {
    const found = await this.require(handle);
    if (found.peer) return (await (await this.meshModule()).peerTicket(found.peer, found.row.id)).messages.map((reply) => ({ ...reply, device: found.peer!.name }));
    const { client, views } = await this.open();
    return views.localReplies(client, 200).filter((reply) => reply.ticketId === found.row.id);
  }
  async say(handle: string, text: string): Promise<TicketRow> {
    const { row, peer } = await this.require(handle);
    if (peer) return (await this.meshModule()).peerAct(peer, row.id, "messages", { text });
    (await this.open()).client.message(row.id, text);
    return row;
  }
  async stop(handle: string): Promise<TicketRow> {
    const { row, peer } = await this.require(handle);
    if (peer) return (await this.meshModule()).peerAct(peer, row.id, "stop");
    (await this.open()).client.stop(row.id, "Stopped from the Swarm TUI");
    return row;
  }
  async retry(handle: string): Promise<TicketRow> {
    const { row, peer } = await this.require(handle);
    if (peer) return (await this.meshModule()).peerAct(peer, row.id, "retry");
    (await this.open()).client.retry(row.id);
    return row;
  }
  private async require(handle: string): Promise<{ row: TicketRow; peer?: Peer }> {
    const found = await this.locate(handle);
    if (!found) throw new Error(`No ticket ${handle}`);
    return found;
  }

  async close(): Promise<void> {
    await this.host?.stop().catch((error: unknown) => { this.options.log(`ticket host stop failed: ${String(error)}`); });
    this.host = undefined;
    this.client?.close();
    this.client = undefined;
  }
}
