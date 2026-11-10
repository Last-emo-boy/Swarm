/**
 * Ticket VMs: with `executor.isolation` set to `vm`, each ticket's worker runs in a VM of its own instead of as a process of
 * the host's account, so it reads none of the host's keys, tokens or other tickets. The deployment provides the VMs as
 * systemd units `swarm-ticket@<slot>`, each booting a fresh root disk with the ticket's own data disk, and reaching only
 * its slot's gateway on this host (gateway.ts), which serves the worker's ticket, its model calls and its requester's token.
 *
 * Its worker runs Swarm's coding loop, or OpenCode for a ticket on an OpenCode profile: the VM image has OpenCode, which
 * calls Swarm's worker model through the gateway too (guest.ts). Other harnesses run on paired nodes that have them.
 *
 * Like a paired node, a slot holds a lease on the Assignment while its guest renews it; a lease that lapses, as when the
 * host was down, is treated as work a restart interrupted. A VM powers off once its worker's turn ends, and boots again
 * on a follow-up; its data disk is deleted when the ticket ends.
 *
 * With `executor.vm.kube`, a Kubernetes cluster's slots (kube-control.ts) take tickets once this host's are full. A ticket
 * keeps to the kind of slot it first booted in, where its data disk is. A cluster VM starts in the background: the
 * launch returns once the slot holds the ticket, and a start that fails ends the slot's lease early, so the ticket
 * launches again as after any boot that never reached its gateway.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { latestAssignment, liveTicket, waitsForPerson, type Ticket } from "../core/index.js";
import type { SuperagentClient } from "../client.js";
import { Later } from "../effects.js";
import type { KubeVm } from "../settings.js";
import type { HealthEntry } from "../health.js";
import type { RemoteWork } from "../executor.js";
import type { Credential } from "../github-link.js";
import { harnessProfiles, type HarnessProfile } from "../harness.js";
import { KV } from "../kv.js";
import type { Deployment } from "../setup.js";
import { VmGateway } from "./gateway.js";
import { KubeControl, podName, type ClusterControl } from "./kube-control.js";

const exec = promisify(execFile);

/**
 * How long a lease holds without a heartbeat once the guest runs, and while its VM boots: on this host, or in the cluster,
 * which may first add a node and pull the runner image.
 */
export const LEASE_MS = 60_000, BOOT_MS = 3 * 60_000, CLUSTER_BOOT_MS = 15 * 60_000;
/** How many boots in a row may end before their guest started the worker, before the ticket fails. */
const MAX_BOOTS = 3;
/** How long after a cluster VM's start failed, times the boots so far, its ticket launches again. */
const BOOT_RETRY_MS = 30_000;

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
  /** A cluster slot's pod for this boot. */
  pod?: string;
  /** Why the last start of a cluster VM failed. */
  error?: string;
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

/** The harness profiles a ticket VM runs: OpenCode's, which its image has. */
export const vmHarnessIds = (configured: Readonly<Record<string, HarnessProfile>>): string[] =>
  Object.entries(harnessProfiles(configured)).filter(([, profile]) => profile.kind === "opencode").map(([id]) => id);

/** Where a slot's VM runs: on this host, or as the cluster's slot `index`; the port of its gateway; and its key in the store. */
interface Place { cluster: boolean; index: number; port: number; key: string }

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class VmWork implements RemoteWork {
  readonly gateway: VmGateway;
  private readonly timer: NodeJS.Timeout;
  private health?: HealthEntry;
  /** Why no VM can run, such as gateways that could not listen: the work waits rather than runs outside a VM. */
  private unavailable?: string;
  private closing = false;
  private readonly cluster: ClusterControl;
  /** The ended tickets whose cluster volumes are being deleted. */
  private readonly discarding = new Set<string>();

  /** `inner` places work on paired nodes, as the mesh does; what it keeps here runs in a VM. */
  constructor(readonly host: VmHost, private readonly inner?: RemoteWork, private readonly control: VmControl = systemdControl, cluster?: ClusterControl) {
    this.gateway = new VmGateway(this);
    this.cluster = cluster ?? new KubeControl(() => this.kube());
    this.timer = setInterval(() => { this.lapse(); this.collect(); this.guard(); }, Math.max(250, Math.floor(LEASE_MS / 4)));
    this.timer.unref();
  }

  private get client() { return this.host.client; }
  private settings() { return this.client.settings().executor.vm; }
  private kube(): KubeVm {
    const { kube } = this.settings();
    if (!kube) throw new Error("executor.vm.kube is not set");
    return kube;
  }
  /** The slot's directory, where it finds the ticket and token its VM boots with. */
  slotDir(slot: number): string { return join(this.host.stateDir, "vm", String(slot)); }
  /** This host's slots come first, then the cluster's. */
  private place(slot: number): Place {
    const { slots, port, kube } = this.settings();
    if (slot < slots) return { cluster: false, index: slot, port: port + slot, key: String(slot) };
    const index = slot - slots;
    return { cluster: true, index, port: (kube?.port ?? 0) + index, key: `c${index}` };
  }
  private count(): number { return this.settings().slots + (this.settings().kube?.slots ?? 0); }

  /** Listens on every slot's gateway port. */
  async start(): Promise<void> {
    const { slots, kube } = this.settings();
    const ports = Array.from({ length: this.count() }, (_, slot) => this.place(slot).port);
    this.health = this.client.health.claim("vm", { state: "starting", detail: "Opening the ticket VMs' gateways" });
    try {
      await this.gateway.listen(ports);
      this.health.set({ state: "ready", detail: `Runs each ticket's worker in a VM of its own, ${slots} at once${kube ? ` and ${kube.slots} more in the cluster` : ""}` });
    } catch (error) {
      await this.gateway.close();
      this.unavailable = `their gateways could not listen on 127.0.0.1 ports ${ports.join(", ")}: ${error instanceof Error ? error.message : String(error)}`;
      this.health.set({ state: "error", detail: `Ticket VMs are unavailable: ${this.unavailable}` });
      this.host.log(`superagent: ticket VMs are unavailable: ${this.unavailable}`);
    }
  }

  slot(slot: number): VmSlot | undefined { return this.client.store.get(KV.vm.slot(this.place(slot).key)); }
  private setSlot(slot: number, record: VmSlot): void { this.client.store.set(KV.vm.slot(this.place(slot).key), record); }
  private live(record: VmSlot | undefined): boolean { return !!record?.tokenHash && Date.parse(record.expiresAt) > Date.now(); }
  /** The slot whose token this is: the one presented to that slot's gateway. */
  authorized(slot: number, token: string): VmSlot | undefined {
    const record = this.slot(slot);
    return record && this.live(record) && sameHash(record.tokenHash, hashToken(token)) ? record : undefined;
  }
  private slots(): { slot: number; record: VmSlot | undefined }[] {
    return Array.from({ length: this.count() }, (_, slot) => ({ slot, record: this.slot(slot) }));
  }
  private holding(ticketId: string, assignmentId?: string): number | undefined {
    return this.slots().find(({ record }) => this.live(record) && record?.ticketId === ticketId && (!assignmentId || record.assignmentId === assignmentId))?.slot;
  }

  async run(ticket: Ticket, assignmentId: string): Promise<boolean> {
    if (this.closing) throw new Later("The host is stopping");
    if (await this.inner?.run(ticket, assignmentId)) return true;
    if (this.unavailable) throw new Later(`Ticket VMs are unavailable: ${this.unavailable}`);
    const harness = ticket.execution?.harness;
    if (harness && !vmHarnessIds(this.client.settings().executor.harnesses).includes(harness)) {
      throw new Error(`Ticket VMs run Swarm's own coding loop and OpenCode, not ${harness}: run it on a paired node that has it, or set executor.isolation to process`);
    }
    // A requester whose link stopped working gets the executor's question to link again; nothing boots.
    if (ticket.mandate.capability?.credential && !await this.host.credential(ticket)) return false;
    // A guest that runs the Assignment takes new Inputs by itself.
    if (this.holding(ticket.id, assignmentId) !== undefined) return true;
    // The slot that ran the ticket last boots it again, after its VM powered off, so two VMs never share its disk; a ticket
    // with a disk stays on its side, this host's or the cluster's, and a new one takes this host's slots first.
    const disk = !!this.client.store.get(KV.vm.disk(ticket.id)), cluster = !!this.client.store.get(KV.vm.cluster(ticket.id));
    const slots = this.slots().filter(({ slot, record }) => !this.live(record) && (!disk || this.place(slot).cluster === cluster));
    const free = slots.find(({ record }) => record?.ticketId === ticket.id)
      ?? slots.find(({ record }) => !record || !this.idleTicket(record.ticketId)) ?? slots[0];
    if (!free) throw new Later(`All ${disk ? `${cluster ? "cluster" : "local"} ` : ""}ticket VMs are busy`);
    const place = this.place(free.slot);
    const previous = free.record;
    const boots = previous?.ticketId === ticket.id && previous.assignmentId === assignmentId && !previous.directory ? (previous.boots ?? 1) + 1 : 1;
    if (boots > MAX_BOOTS) {
      throw new Error(`The ticket VM stopped ${MAX_BOOTS} times before its worker started${previous?.error ? `: ${previous.error}` : "; see the host's log"}`);
    }
    const token = randomBytes(32).toString("base64url");
    if (!place.cluster) {
      const dir = this.slotDir(free.slot);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "ticket"), `${ticket.id}\n`);
      writeFileSync(join(dir, "token"), token, { mode: 0o600 });
    }
    const at = new Date().toISOString();
    if (!disk) {
      this.client.store.set(KV.vm.disk(ticket.id), at);
      if (place.cluster) this.client.store.set(KV.vm.cluster(ticket.id), at);
    }
    const pod = place.cluster ? podName(place.index) : undefined;
    this.setSlot(free.slot, { ticketId: ticket.id, assignmentId, tokenHash: hashToken(token), at,
      expiresAt: new Date(Date.now() + (place.cluster ? CLUSTER_BOOT_MS : BOOT_MS)).toISOString(), boots, ...pod ? { pod } : {} });
    if (pod) {
      void this.boot(free.slot, pod, ticket.id, token);
      this.host.log(`superagent: ticket ${ticket.id.slice(0, 8)} starts in cluster ticket VM ${place.index}`);
      return true;
    }
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

  /**
   * Starts a cluster slot's VM, in the background of the launch that took the slot. A start that fails ends this boot's
   * lease after a while, so lapse() lets the slot go and launches the ticket again, until its boots run out.
   */
  private async boot(slot: number, pod: string, ticketId: string, token: string): Promise<void> {
    const { index } = this.place(slot);
    try {
      await this.cluster.start(index, pod, ticketId, token);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.host.log(`superagent: cluster ticket VM ${index} did not start for ticket ${ticketId.slice(0, 8)}: ${message}`);
      const record = this.slot(slot);
      // The slot may have let this boot go, or taken another, meanwhile.
      if (!record || record.pod !== pod || !this.live(record)) return;
      this.setSlot(slot, { ...record, error: message, expiresAt: new Date(Date.now() + BOOT_RETRY_MS * (record.boots ?? 1)).toISOString() });
    }
  }

  /** Whether a ticket is open with its VM off, which a follow-up would boot again in the slot that ran it last. */
  private idleTicket(ticketId: string): boolean {
    const ticket = this.client.store.tickets.get(ticketId);
    return !!ticket && liveTicket(ticket) && this.holding(ticketId) === undefined;
  }

  /** Ends a slot's lease and powers its VM off; the slot remembers the ticket, to boot it again with the same disk. */
  async release(slot: number): Promise<void> {
    const record = this.slot(slot), place = this.place(slot);
    if (record) this.setSlot(slot, { ...record, tokenHash: "", expiresAt: new Date(0).toISOString() });
    if (place.cluster) {
      if (record?.pod) void this.cluster.stop(record.pod).catch((error: unknown) => this.host.log(`superagent: stopping cluster ticket VM ${place.index} failed: ${String(error)}`));
      return;
    }
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
    this.setSlot(slot, { ...record, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() });
    return true;
  }

  /** The guest started the worker in `directory`: a pending Assignment runs, and an idle one's worker woke. */
  started(slot: number, directory: string): void {
    const record = this.slot(slot);
    if (!record) return;
    this.setSlot(slot, { ...record, directory, boots: 0, error: undefined });
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

  /**
   * Tickets that ended, wherever they were ended (a terminal or a TUI ends them in its own process), no longer need their
   * data disks, which the deployment deletes once no VM runs them; the cluster's volumes are deleted from here.
   */
  private collect(): void {
    if (this.closing) return;
    const ended = (family: typeof KV.vm.disk) => this.client.store.keys(family).map((key) => key.slice(family.prefix.length)).filter((ticketId) => {
      const ticket = this.client.store.tickets.get(ticketId);
      return !ticket || !liveTicket(ticket);
    });
    try {
      const local = ended(KV.vm.disk);
      if (local.length) {
        const dir = join(this.host.stateDir, "vm", "ended");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const ticketId of local) {
          if (!this.client.store.get(KV.vm.cluster(ticketId))) writeFileSync(join(dir, ticketId), "");
          this.client.store.delete(KV.vm.disk(ticketId));
        }
        void this.control.collect().catch((error: unknown) => this.host.log(`superagent: collecting ticket disks failed: ${String(error)}`));
      }
      for (const ticketId of ended(KV.vm.cluster)) {
        if (this.discarding.has(ticketId)) continue;
        this.discarding.add(ticketId);
        void this.cluster.discard(ticketId).then(() => this.client.store.delete(KV.vm.cluster(ticketId)),
          (error: unknown) => this.host.log(`superagent: deleting ticket ${ticketId.slice(0, 8)}'s cluster volume failed: ${String(error)}`))
          .finally(() => this.discarding.delete(ticketId));
      }
    } catch (error) {
      this.host.log(`superagent: marking ended tickets' disks for deletion failed: ${String(error)}`);
    }
  }

  /** While cluster VMs run, keeps them from the nodes' public addresses, which change as the cluster adds nodes for them. */
  private guard(): void {
    if (this.closing || !this.slots().some(({ slot, record }) => this.place(slot).cluster && this.live(record))) return;
    void this.cluster.guard().catch((error: unknown) => this.host.log(`superagent: updating the cluster ticket VMs' egress rules failed: ${String(error)}`));
  }

  /** On host stop: no more boots or lease checks; VMs keep running, and their leases lapse unless the host comes back. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    this.health?.release();
    await this.gateway.close();
    await this.inner?.close();
  }
}
