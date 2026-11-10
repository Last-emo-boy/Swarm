/**
 * Ticket VMs: with `executor.isolation` set to `vm`, each ticket's worker runs in a VM of its own instead of as a process of
 * the host's account, so it reads none of the host's keys, tokens or other tickets. The deployment provides the VMs as
 * systemd units `swarm-ticket@<slot>`, each booting a fresh root disk with the ticket's own data disk, and reaching only
 * its slot's gateway on this host (gateway.ts), which serves the worker's ticket, its model calls and its requester's token.
 *
 * Like a paired node, a slot holds a lease on the Assignment while its guest renews it; a lease that lapses, as when the
 * host was down, is treated as work a restart interrupted. A VM powers off once its worker's turn ends, and boots again
 * on a follow-up; its data disk is deleted when the ticket ends.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { latestAssignment, liveTicket, waitsForPerson, type Ticket } from "../core/index.js";
import type { SuperagentClient } from "../client.js";
import { Later } from "../effects.js";
import type { HealthEntry } from "../health.js";
import type { RemoteWork } from "../executor.js";
import type { Credential } from "../github-link.js";
import { KV } from "../kv.js";
import type { Deployment } from "../setup.js";
import { VmGateway } from "./gateway.js";

const exec = promisify(execFile);

/** How long a lease holds without a heartbeat once the guest runs, and while its VM boots. */
export const LEASE_MS = 60_000, BOOT_MS = 3 * 60_000;
/** How many boots in a row may end before their guest started the worker, before the ticket fails. */
const MAX_BOOTS = 3;

/** The ticket a VM slot runs, under the lease its guest renews, or ran last. */
export interface VmSlot {
  ticketId: string;
  assignmentId: string;
  /** The SHA-256 of the slot's token, which the guest presents to its gateway; empty once the slot let the ticket go. */
  tokenHash: string;
  at: string;
  expiresAt: string;
  /** The guest's ticket directory, once it started the worker. */
  directory?: string;
  /** How many times in a row the slot booted this Assignment without its guest starting the worker. */
  boots?: number;
}

/** Starts and stops the VMs, which the deployment lets the host's account do for these units only. */
export interface VmControl {
  /** Boots slot `slot`'s VM, which reads its ticket and token from the slot's directory, stopping one that still runs. */
  start(slot: number): Promise<void>;
  stop(slot: number): Promise<void>;
  /** Deletes the data disks of the tickets named in the `ended` directory, unless a VM runs one. */
  collect(): Promise<void>;
}
export const systemdControl: VmControl = {
  // A VM that still powers off after its last ticket is stopped first.
  start: async (slot) => { await exec("systemctl", ["restart", "--no-block", `swarm-ticket@${slot}.service`]); },
  stop: async (slot) => { await exec("systemctl", ["stop", "--no-block", `swarm-ticket@${slot}.service`]); },
  collect: async () => { await exec("systemctl", ["start", "--no-block", "swarm-ticket-gc.service"]); }
};

export interface VmHost {
  readonly client: SuperagentClient;
  readonly stateDir: string;
  deployment(): Deployment;
  /** The ticket's execution variables. */
  environment(ticket: Ticket): Record<string, string>;
  /** The token of the account a ticket writes to GitHub as, while that person's link works. */
  credential(ticket: Ticket): Promise<Credential | undefined>;
  log(message: string): void;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class VmWork implements RemoteWork {
  readonly gateway: VmGateway;
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private health?: HealthEntry;
  /** Why no VM can run, such as gateways that could not listen: the work waits rather than runs outside a VM. */
  private unavailable?: string;
  private closing = false;

  /** `inner` places work on paired nodes, as the mesh does; what it keeps here runs in a VM. */
  constructor(readonly host: VmHost, private readonly inner?: RemoteWork, private readonly control: VmControl = systemdControl) {
    this.gateway = new VmGateway(this);
    this.timer = setInterval(() => this.lapse(), Math.max(250, Math.floor(LEASE_MS / 4)));
    this.timer.unref();
    this.unsubscribe = host.client.subscribe((event) => { if (event.type === "ticket.ended") this.ended(event.data.ticketId); });
  }

  private get client() { return this.host.client; }
  private settings() { return this.client.settings().executor.vm; }
  /** The slot's directory, where it finds the ticket and token its VM boots with. */
  slotDir(slot: number): string { return join(this.host.stateDir, "vm", String(slot)); }

  /** Listens on every slot's gateway port. */
  async start(): Promise<void> {
    const { slots, port } = this.settings();
    this.health = this.client.health.claim("vm", { state: "starting", detail: "Opening the ticket VMs' gateways" });
    try {
      await this.gateway.listen(slots, port);
      this.health.set({ state: "ready", detail: `Runs each ticket's worker in a VM of its own, ${slots} at once` });
    } catch (error) {
      await this.gateway.close();
      this.unavailable = `their gateways could not listen on 127.0.0.1:${port}-${port + slots - 1}: ${error instanceof Error ? error.message : String(error)}`;
      this.health.set({ state: "error", detail: `Ticket VMs are unavailable: ${this.unavailable}` });
      this.host.log(`superagent: ticket VMs are unavailable: ${this.unavailable}`);
    }
  }

  slot(slot: number): VmSlot | undefined { return this.client.store.get(KV.vm.slot(String(slot))); }
  private live(record: VmSlot | undefined): boolean { return !!record?.tokenHash && Date.parse(record.expiresAt) > Date.now(); }
  /** The slot whose token this is: the one presented to that slot's gateway. */
  authorized(slot: number, token: string): VmSlot | undefined {
    const record = this.slot(slot);
    return record && this.live(record) && sameHash(record.tokenHash, hashToken(token)) ? record : undefined;
  }
  private slots(): { slot: number; record: VmSlot | undefined }[] {
    return Array.from({ length: this.settings().slots }, (_, slot) => ({ slot, record: this.slot(slot) }));
  }
  private holding(ticketId: string, assignmentId?: string): number | undefined {
    return this.slots().find(({ record }) => this.live(record) && record?.ticketId === ticketId && (!assignmentId || record.assignmentId === assignmentId))?.slot;
  }

  async run(ticket: Ticket, assignmentId: string): Promise<boolean> {
    if (this.closing) throw new Later("The host is stopping");
    if (await this.inner?.run(ticket, assignmentId)) return true;
    if (this.unavailable) throw new Later(`Ticket VMs are unavailable: ${this.unavailable}`);
    if (ticket.execution?.harness) throw new Error("Ticket VMs run Swarm's own coding loop, not agent harnesses: set executor.isolation to process to run harness work");
    // A requester whose link stopped working gets the executor's question to link again; nothing boots.
    if (ticket.mandate.capability?.credential && !await this.host.credential(ticket)) return false;
    // A guest that runs the Assignment takes new Inputs by itself.
    if (this.holding(ticket.id, assignmentId) !== undefined) return true;
    // The slot that ran the ticket last boots it again, after its VM powered off, so two VMs never share its disk.
    const slots = this.slots().filter(({ record }) => !this.live(record));
    const free = slots.find(({ record }) => record?.ticketId === ticket.id)
      ?? slots.find(({ record }) => !record || !this.idleTicket(record.ticketId)) ?? slots[0];
    if (!free) throw new Later(`All ${this.settings().slots} ticket VMs are busy`);
    const previous = free.record;
    const boots = previous?.ticketId === ticket.id && previous.assignmentId === assignmentId && !previous.directory ? (previous.boots ?? 1) + 1 : 1;
    if (boots > MAX_BOOTS) throw new Error(`The ticket VM stopped ${MAX_BOOTS} times before its worker started; see the host's log`);
    const token = randomBytes(32).toString("base64url");
    const dir = this.slotDir(free.slot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "ticket"), `${ticket.id}\n`);
    writeFileSync(join(dir, "token"), token, { mode: 0o600 });
    const at = new Date().toISOString();
    this.client.store.set(KV.vm.slot(String(free.slot)), { ticketId: ticket.id, assignmentId, tokenHash: hashToken(token), at,
      expiresAt: new Date(Date.now() + BOOT_MS).toISOString(), boots });
    try {
      await this.control.start(free.slot);
    } catch (error) {
      await this.release(free.slot);
      throw new Error(`The ticket VM did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.host.log(`superagent: ticket ${ticket.id.slice(0, 8)} runs in ticket VM ${free.slot}`);
    return true;
  }

  holds(ticketId: string, assignmentId: string): boolean {
    return !!this.inner?.holds(ticketId, assignmentId) || this.holding(ticketId, assignmentId) !== undefined;
  }

  async stop(ticketId: string, assignmentId: string): Promise<void> {
    await this.inner?.stop(ticketId, assignmentId);
    const slot = this.holding(ticketId, assignmentId);
    if (slot !== undefined) await this.release(slot);
  }

  /** Whether a ticket is open with its VM off, which a follow-up would boot again in the slot that ran it last. */
  private idleTicket(ticketId: string): boolean {
    const ticket = this.client.store.tickets.get(ticketId);
    return !!ticket && liveTicket(ticket) && this.holding(ticketId) === undefined;
  }

  /** Ends a slot's lease and powers its VM off; the slot remembers the ticket, to boot it again with the same disk. */
  async release(slot: number): Promise<void> {
    const record = this.slot(slot);
    if (record) this.client.store.set(KV.vm.slot(String(slot)), { ...record, tokenHash: "", expiresAt: new Date(0).toISOString() });
    rmSync(join(this.slotDir(slot), "token"), { force: true });
    await this.control.stop(slot).catch((error: unknown) => this.host.log(`superagent: stopping ticket VM ${slot} failed: ${String(error)}`));
  }

  /** Renews a slot's lease while its Assignment still runs the ticket, and ends it otherwise; returns whether it holds. */
  renew(slot: number): boolean {
    const record = this.slot(slot);
    if (!record || !this.live(record)) return false;
    const ticket = this.client.store.tickets.get(record.ticketId);
    const latest = ticket && liveTicket(ticket) ? latestAssignment(ticket) : undefined;
    if (latest?.id !== record.assignmentId || latest.state === "ended") {
      void this.release(slot);
      return false;
    }
    this.client.store.set(KV.vm.slot(String(slot)), { ...record, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() });
    return true;
  }

  /** The guest started the worker in `directory`: a pending Assignment runs, and an idle one's worker woke. */
  started(slot: number, directory: string): void {
    const record = this.slot(slot);
    if (!record) return;
    this.client.store.set(KV.vm.slot(String(slot)), { ...record, directory, boots: 0 });
    const ticket = this.client.store.tickets.get(record.ticketId);
    if (ticket?.assignments.find((item) => item.id === record.assignmentId)?.state === "pending") this.client.engine.assignmentStarted(record.ticketId, record.assignmentId);
  }

  /** Leases whose guest stopped renewing them: their Assignment is treated as one a restart interrupted, and runs again. */
  private lapse(): void {
    if (this.closing) return;
    try {
      for (const { slot, record } of this.slots()) {
        if (!record?.tokenHash || this.live(record)) continue;
        void this.release(slot);
        const ticket = this.client.store.tickets.get(record.ticketId);
        const latest = ticket && liveTicket(ticket) ? latestAssignment(ticket) : undefined;
        if (!ticket || latest?.id !== record.assignmentId) continue;
        this.host.log(`superagent: ticket VM ${slot} stopped renewing its lease on ticket ${record.ticketId.slice(0, 8)}; its work runs again`);
        if (latest.state === "running") this.client.engine.assignmentInterrupted(ticket.id, latest.id);
        else if (latest.state === "pending" && !waitsForPerson(ticket)) this.client.effects.enqueue("launch", latest.id, { ticketId: ticket.id, assignmentId: latest.id });
      }
    } catch (error) {
      this.host.log(`superagent: checking ticket VM leases failed: ${String(error)}`);
    }
  }

  /** A ticket that ended no longer needs its data disk, which the deployment deletes once no VM runs it. */
  private ended(ticketId: string): void {
    try {
      const dir = join(this.host.stateDir, "vm", "ended");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, ticketId), "");
      void this.control.collect().catch((error: unknown) => this.host.log(`superagent: collecting ticket disks failed: ${String(error)}`));
    } catch (error) {
      this.host.log(`superagent: marking ticket ${ticketId.slice(0, 8)}'s disk for deletion failed: ${String(error)}`);
    }
  }

  /** On host stop: no more boots or lease checks; VMs keep running, and their leases lapse unless the host comes back. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.health?.release();
    await this.gateway.close();
    await this.inner?.close();
  }
}
