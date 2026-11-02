/**
 * The TUI's link to the superagent: a client on its database, opened once the database exists or the operator files a
 * ticket, and a host run inside the TUI when no other host runs, so a ticket filed here gets worked on. A host the TUI
 * started stops with it; `swarm superagent run` keeps one running on its own. The superagent's modules load on first use,
 * so a TUI that never touches tickets starts as fast as before.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSwarmPaths } from "../../config/settings.js";
import type { Complete } from "../../superagent/assessor.js";
import type { SuperagentClient } from "../../superagent/client.js";
import type { SuperagentHost } from "../../superagent/host.js";
import type { HostStatus, TicketRow } from "../../superagent/views.js";

export interface TicketSnapshot { rows: TicketRow[]; status: HostStatus }
export interface TicketReply { id: string; ticketId?: string; kind: string; text: string }

type Views = typeof import("../../superagent/views.js");

export class TuiTickets {
  private client?: SuperagentClient;
  private views?: Views;
  private host?: SuperagentHost;
  private starting?: Promise<boolean>;
  private seen?: Set<string>;
  readonly stateDir: string;

  constructor(private readonly options: { stateDir?: string; complete?: () => Complete | undefined; log: (message: string) => void }) {
    this.stateDir = options.stateDir ?? process.env.SWARM_SUPERAGENT_HOME ?? join(getSwarmPaths().home, "superagent");
  }

  /** Whether there is anything to show: the superagent's database exists. */
  available(): boolean { return !!this.client || existsSync(join(this.stateDir, "superagent.db")); }
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

  /** The tickets and the host's state, while the superagent has a database. */
  async snapshot(): Promise<TicketSnapshot | undefined> {
    if (!this.available()) return undefined;
    const { client, views } = await this.open();
    return { rows: views.ticketRows(client, { ended: true, limit: 100 }), status: views.hostStatus(client) };
  }

  /** Replies posted to local Threads since the last call; the first call only notes what was there already. */
  async newReplies(): Promise<TicketReply[]> {
    if (!this.available()) return [];
    const { client, views } = await this.open();
    const replies = views.localReplies(client, 100);
    if (!this.seen) {
      this.seen = new Set(replies.map((reply) => reply.id));
      return [];
    }
    const fresh = replies.filter((reply) => !this.seen!.has(reply.id));
    for (const reply of fresh) this.seen.add(reply.id);
    return fresh;
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

  async request(text: string): Promise<{ triggerId: string }> { return (await this.open()).client.request(text); }
  async find(handle: string): Promise<TicketRow | undefined> {
    const { client, views } = await this.open();
    const ticket = views.findTicket(client, handle);
    return ticket ? views.ticketRow(client, ticket) : undefined;
  }
  async messages(ticketId: string): Promise<TicketReply[]> {
    const { client, views } = await this.open();
    return views.localReplies(client, 200).filter((reply) => reply.ticketId === ticketId);
  }
  async say(handle: string, text: string): Promise<TicketRow> {
    const row = await this.require(handle);
    (await this.open()).client.message(row.id, text);
    return row;
  }
  async stop(handle: string): Promise<TicketRow> {
    const row = await this.require(handle);
    (await this.open()).client.stop(row.id, "Stopped from the Swarm TUI");
    return row;
  }
  async retry(handle: string): Promise<TicketRow> {
    const row = await this.require(handle);
    (await this.open()).client.retry(row.id);
    return row;
  }
  private async require(handle: string): Promise<TicketRow> {
    const row = await this.find(handle);
    if (!row) throw new Error(`No ticket ${handle}`);
    return row;
  }

  async close(): Promise<void> {
    await this.host?.stop().catch((error: unknown) => { this.options.log(`ticket host stop failed: ${String(error)}`); });
    this.host = undefined;
    this.client?.close();
    this.client = undefined;
  }
}
