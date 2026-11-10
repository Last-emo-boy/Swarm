/**
 * Running a ticket's worker on another paired node. The node that accepted the ticket owns it and stays its record: it
 * chooses where the worker runs, offers that node the Assignment, and answers the worker's reads and reports over the mesh,
 * so it remains the only process that writes its store. The node that runs the worker prepares the ticket's directory with
 * its own prepare command and credentials and holds a lease on the Assignment, which it renews with heartbeats; a lease
 * that lapses is treated like a worker the owner lost in a restart, so the work can be placed again.
 *
 * A node that pulls asks its paired nodes for work that waits there for a worker and claims what fits it. The owner still
 * decides: it hands the work to the first valid claim through the same offer and lease, and refuses the others.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { HttpError, errorMessage } from "../server/gateway-http.js";
import { latestAssignment, liveTicket, ticketStage, waitsForPerson, type Ticket, type WriteLevel } from "../superagent/core/index.js";
import { Later } from "../superagent/effects.js";
import { sealed, verifyEnvironment, workerBin, workerEnvironment, writeEnvironment } from "../superagent/environment.js";
import { WORKER_SHELL_AUTO_BACKGROUND_MS, prepareDirectory, workerExited, type RemoteWork } from "../superagent/executor.js";
import type { HealthEntry } from "../superagent/health.js";
import type { SuperagentHost } from "../superagent/host.js";
import { KV } from "../superagent/kv.js";
import { sourceTrigger } from "../superagent/messages.js";
import { leaseOf, placementOf, updatePlacement, workNeeds, type Lease, type NodeRef, type Placement } from "../superagent/placement.js";
import { WriteLevelSchema, settingsPath } from "../superagent/settings.js";
import { SetupError, commandProbe, defaultMachine, resolveGithub, type Deployment } from "../superagent/setup.js";
import { PatchSchema, ticketTools, type TicketTool } from "../superagent/ticket-tools.js";
import { ticketVariables, variableValues } from "../superagent/variables.js";
import { hostStatus } from "../superagent/views.js";
import { ReportSchema, workDelivered, workStart, workView } from "../superagent/work-link.js";
import type { NodeCard, NodeLoad } from "./card.js";
import { callPeer, MeshError, peerHealth } from "./client.js";
import type { MeshHandler, MeshRequest, MeshServer } from "./server.js";
import { readMesh, type Peer, type Pull } from "./state.js";
import { workPath } from "./work-link.js";

/** How long a lease holds without a heartbeat, and how often a node renews the leases it holds. */
export const LEASE_MS = 60_000, HEARTBEAT_MS = 15_000;
/** How long a stop waits for a worker process to exit before killing it. */
const STOP_GRACE_MS = 10_000;
/** How often a node that pulls looks for waiting work; while none is open it looks less often, down to 8 times as rarely. */
export const PULL_MS = 15_000;

const OfferSchema = z.object({
  ticketId: z.string().min(1).max(128),
  assignmentId: z.string().min(1).max(128),
  /** The ticket's short name, which names its directory. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  repository: z.string(),
  /** The agent's GitHub account the worker acts as, when the owner works on a GitHub repository. */
  github: z.object({ login: z.string().min(1) }).optional(),
  /** The ticket's execution variables on the owner; the node that runs it names its own directory in them. */
  variables: z.record(z.string(), z.string()),
  blockedCommands: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/).refine((name) => name !== "." && name !== "..")),
  permissionMode: z.enum(["full-auto", "yolo"]),
  leaseMs: z.number().int().min(1000).max(3_600_000),
  /** How far the ticket's capability lets its work write: a sealed one gets no agent accounts (see `sealed`). */
  write: WriteLevelSchema.optional()
});
type Offer = z.infer<typeof OfferSchema>;
const ClaimSchema = z.object({ ticketId: z.string().min(1).max(128), assignmentId: z.string().min(1).max(128) });

export interface MeshWorkOptions {
  /** This node's mesh state directory. */
  home: string;
  /** This node's abilities: work that needs no more runs here. */
  abilities: readonly string[];
  /** How a worker process starts: the Node binary and the Swarm entry point. */
  workerCommand: readonly string[];
  leaseMs?: number;
  heartbeatMs?: number;
  pullMs?: number;
  log?: (message: string) => void;
}

/** An Assignment that waits for a worker on the node that owns its ticket, which a paired node that pulls may claim. */
export interface OpenWork {
  ticketId: string;
  assignmentId: string;
  title: string;
  /** The repository the owner's tickets work on; empty when it has none. */
  repository: string;
  /** What the work needs of the machine its worker runs on, such as gpu. */
  needs: string[];
  /** When the Assignment began to wait. */
  since: string;
}

/** The worker of a paired node's ticket that this node runs, under the lease it holds on the Assignment. */
interface Held {
  owner: Peer;
  ticketId: string;
  assignmentId: string;
  directory: string;
  /** This node's environment for the owner's tickets: its own state directory, shims and credentials. */
  deployment: Deployment;
  /** The ticket's execution variables, naming this node's directory. */
  variables: Record<string, string>;
  permissionMode: string;
  write?: WriteLevel;
  leaseMs: number;
  /** Until when the lease holds by this node's clock: from each heartbeat the owner answered. */
  expires: number;
  /** Whether the directory is prepared and the owner knows the Assignment started. */
  ready: boolean;
  worker?: { process: ChildProcess; exited: Promise<void>; stopping?: boolean };
}

const heldKey = (owner: string, ticketId: string): string => `${owner}/${ticketId}`;

/** The node whose abilities cover what the work needs, with the most free worker slots; a node without a ticket host has none. */
export function fittest(needs: readonly string[], cards: readonly NodeCard[]): NodeCard | undefined {
  const free = (card: NodeCard): number => card.load ? card.load.slots - card.load.running - card.load.queued : 0;
  return cards.filter((card) => needs.every((need) => card.abilities.includes(need)) && free(card) > 0)
    .sort((a, b) => free(b) - free(a))[0];
}

/**
 * Why a node with these abilities, pulling work of these repositories (any when none), may not take the work; undefined
 * when it may.
 */
export function unfit(work: Pick<OpenWork, "needs" | "repository">, abilities: readonly string[], repositories: readonly string[]): string | undefined {
  const missing = work.needs.filter((need) => !abilities.includes(need));
  if (missing.length) return `it lacks ${missing.join(", ")}, which the work needs`;
  if (repositories.length && !repositories.includes(work.repository)) return `it pulls only work of ${repositories.join(", ")}`;
  return undefined;
}

/** A route a worker on a paired node calls: what the owner's Engine or tools refuse reaches it with their reason, as here. */
const forWorkers = (handler: MeshHandler): MeshHandler => async (request) => {
  try {
    return await handler(request);
  } catch (error) {
    throw error instanceof HttpError || error instanceof z.ZodError ? error : new HttpError(422, errorMessage(error));
  }
};

/**
 * A mesh node's part in running tickets across the mesh: as the owner of tickets, it places their workers on paired nodes
 * and answers them; as a node peers place work on, it runs their workers. It attaches itself to the host before the host
 * starts, so leases that outlive a restart of the host keep running.
 */
export class MeshWork implements RemoteWork {
  private readonly held = new Map<string, Held>();
  private readonly toolsets = new Map<string, TicketTool[]>();
  private readonly leaseMs: number;
  private readonly timers: NodeJS.Timeout[];
  private readonly health: HealthEntry;
  /** Tickets whose Assignment a paired node that pulls is being offered now. */
  private readonly claiming = new Set<string>();
  private readonly pullMs: number;
  private pullDelay: number;
  private pullTimer?: NodeJS.Timeout;
  private closing = false;
  private beating = false;

  constructor(private readonly host: SuperagentHost, private readonly options: MeshWorkOptions) {
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    host.remote = this;
    this.health = host.client.health.claim("mesh", { state: "ready", detail: "Places tickets' workers on paired nodes and runs theirs" });
    this.timers = [
      setInterval(() => this.lapse(), Math.max(250, Math.floor(this.leaseMs / 4))),
      setInterval(() => { void this.beat(); }, options.heartbeatMs ?? HEARTBEAT_MS)
    ];
    for (const timer of this.timers) timer.unref();
    this.pullMs = this.pullDelay = options.pullMs ?? PULL_MS;
    this.nextPull();
  }

  private get client() { return this.host.client; }
  private name(): string { return readMesh(this.options.home).node.name; }
  private log(message: string): void {
    (this.options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); }))(`mesh: ${message}`);
  }

  /** Workers this node runs for paired nodes now, preparing or running. */
  hosting(): number { return [...this.held.values()].filter((work) => !work.ready || work.worker).length; }

  /** How busy this node is, for its card: its own worker processes and those it runs for paired nodes. */
  load(): NodeLoad {
    return { running: this.host.runningWorkers() + this.hosting(), queued: hostStatus(this.client).counts.queued,
      slots: this.client.settings().executor.maxWorkers };
  }

  // The owner: placing this node's tickets on paired nodes

  private lease(ticketId: string): Lease | undefined { return leaseOf(this.client, ticketId); }
  private live(lease: Lease | undefined): lease is Lease { return !!lease && Date.parse(lease.expiresAt) > Date.now(); }
  private saveLease(ticketId: string, lease: Lease): void { this.client.store.set(KV.mesh.lease(ticketId), lease); }
  private dropLease(ticketId: string): void {
    this.client.store.delete(KV.mesh.lease(ticketId));
    this.toolsets.delete(ticketId);
  }

  holds(ticketId: string, assignmentId: string): boolean {
    const lease = this.lease(ticketId);
    return this.live(lease) && lease.assignmentId === assignmentId;
  }

  async run(ticket: Ticket, assignmentId: string): Promise<boolean> {
    if (this.closing) throw new Later("The node is stopping");
    // A ticket that acts as its requester runs on this node, which keeps their token.
    if (ticket.mandate.capability?.credential) return false;
    // The offer of a claim decides where it runs.
    if (this.claiming.has(ticket.id)) throw new Later("A paired node that pulls is taking the work");
    const lease = this.lease(ticket.id);
    let node: Peer | undefined;
    if (this.live(lease) && lease.assignmentId === assignmentId) node = this.peer(lease.node);
    else {
      const placement = placementOf(this.client, ticket);
      // An Assignment that started here goes on here; one whose node let its lease lapse is placed again.
      const assignment = ticket.assignments.find((item) => item.id === assignmentId);
      if (assignment?.state === "running" && placement?.ran?.assignmentId !== assignmentId) return false;
      node = await this.choose(placement, workNeeds(ticket, placement));
    }
    if (!node) return false;
    await this.offer(node, ticket, assignmentId);
    return true;
  }

  private peer(ref: NodeRef): Peer {
    const peer = readMesh(this.options.home).peers.find((item) => item.id === ref.id);
    if (!peer) throw new Error(`${ref.name} is no longer a paired node; place the ticket elsewhere with swarm superagent place`);
    return peer;
  }

  /** The paired node a placement names, or the one fit for what the work needs; undefined to run it here. */
  private async choose(placement: Placement | undefined, needs: string[]): Promise<Peer | undefined> {
    if (placement?.on === "here") return undefined;
    if (placement?.on) return this.peer(placement.on);
    // Work this node is fit for runs here; other work on the paired node fit for it with the most free slots.
    if (needs.every((need) => this.options.abilities.includes(need))) return undefined;
    const cards = (await peerHealth(this.options.home, 3000)).flatMap((health) => health.card ? [health.card] : []);
    const card = fittest(needs, cards);
    if (card) return this.peer(card);
    // A paired node fit for it that pulls takes it once it has a free slot; until then it waits here, open to that node.
    const repository = this.client.deployment().repository;
    const puller = cards.find((item) => item.pull && !unfit({ needs, repository }, item.abilities, item.pull.repositories));
    if (puller && this.pulls().offer) throw new Later(`The work waits for ${puller.name}, which has ${needs.join(", ")}, to pull it`);
    return undefined;
  }

  /** Offers the Assignment to `node`, which takes it, or wakes its worker for new Inputs when it holds it already. */
  private async offer(node: Peer, ticket: Ticket, assignmentId: string): Promise<void> {
    const { client } = this;
    const deployment = client.deployment();
    const settings = client.settings();
    const trigger = sourceTrigger({ store: client.store }, ticket);
    const previous = this.lease(ticket.id);
    const same = previous?.assignmentId === assignmentId && previous.node.id === node.id ? previous : undefined;
    // The lease exists before the node hears of the work, so the worker it may start at once finds it.
    this.saveLease(ticket.id, { ...same ?? { assignmentId, node: { id: node.id, name: node.name }, at: new Date().toISOString() },
      expiresAt: new Date(Date.now() + this.leaseMs).toISOString() });
    const write = ticket.mandate.capability?.write;
    try {
      await callPeer(node, "POST", "/mesh/v1/work/offers", {
        ticketId: ticket.id, assignmentId, name: ticket.execution!.name, repository: deployment.repository,
        ...(deployment.github && !sealed(write) ? { github: { login: deployment.github.login } } : {}),
        variables: variableValues(ticketVariables({ deployment, sources: client.sources, settings, ticket, ...(trigger ? { trigger } : {}) })),
        blockedCommands: settings.executor.blockedCommands, permissionMode: settings.executor.permissionMode, leaseMs: this.leaseMs,
        ...(write ? { write } : {})
      }, 30_000);
    } catch (error) {
      if (this.live(previous)) this.saveLease(ticket.id, previous);
      else this.dropLease(ticket.id);
      if (error instanceof MeshError && error.status === 503) throw new Later(error.message);
      throw new Error(`${node.name} did not take the work: ${errorMessage(error)}`);
    }
  }

  async stop(ticketId: string, assignmentId: string): Promise<void> {
    const lease = this.lease(ticketId);
    if (lease?.assignmentId !== assignmentId) return;
    this.dropLease(ticketId);
    try {
      await callPeer(this.peer(lease.node), "POST", `/mesh/v1/work/offers/${encodeURIComponent(ticketId)}/stop`, { assignmentId }, 10_000);
    } catch { /* A node that does not hear it learns it at its next heartbeat, or its lease lapses. */ }
  }

  /** Leases whose node stopped renewing them: their Assignment is treated as one a restart interrupted, so it is placed again. */
  private lapse(): void {
    if (this.closing) return;
    try {
      const { client } = this;
      for (const key of client.store.keys(KV.mesh.lease)) {
        const lease = client.store.get(key);
        if (!lease || Date.parse(lease.expiresAt) > Date.now()) continue;
        const ticketId = key.slice(KV.mesh.lease.prefix.length);
        this.dropLease(ticketId);
        // A pulled Assignment whose node went silent is open again.
        if (client.store.get(KV.mesh.placement(ticketId))?.pulled?.assignmentId === lease.assignmentId) updatePlacement(client, ticketId, { pulled: undefined });
        const ticket = client.store.tickets.get(ticketId);
        const latest = ticket && liveTicket(ticket) ? latestAssignment(ticket) : undefined;
        if (!ticket || latest?.id !== lease.assignmentId) continue;
        this.log(`${lease.node.name} stopped renewing its lease on ticket ${ticketId.slice(0, 8)}; its work is placed again`);
        if (latest.state === "running") client.engine.assignmentInterrupted(ticketId, latest.id);
        else if (latest.state === "pending" && !waitsForPerson(ticket)) client.effects.enqueue("launch", latest.id, { ticketId, assignmentId: latest.id });
      }
    } catch (error) {
      this.log(`checking leases failed: ${errorMessage(error)}`);
    }
  }

  private pulls(): Pull { return readMesh(this.options.home).node.pull; }

  /** The repository of the work this node hands out now; undefined while it stops or pauses, or before its setup resolved. */
  private offering(): string | undefined {
    if (this.closing || this.client.settings().paused) return undefined;
    try {
      return this.client.deployment().repository;
    } catch {
      // A host without a deployment starts no work, so it hands out none either.
      return undefined;
    }
  }

  /**
   * The ticket's Assignment when it waits for a worker and a paired node may pull it: it waits in the launch queue, which is
   * not starting it now, for a slot or for a node with what it needs. Work placed on a node or held under a lease is not
   * open, and neither is a ticket that waits for a person.
   */
  private waiting(ticket: Ticket, repository: string): OpenWork | undefined {
    const latest = latestAssignment(ticket);
    const stage = ticketStage(ticket);
    if (!ticket.execution || latest?.state !== "pending" || stage.stage !== "working" || stage.action !== "queued") return undefined;
    if (this.live(this.lease(ticket.id))) return undefined;
    const placement = placementOf(this.client, ticket);
    if (placement?.on) return undefined;
    const { effects } = this.client;
    if (!effects.pending("launch", latest.id) || effects.running("launch", latest.id)) return undefined;
    return { ticketId: ticket.id, assignmentId: latest.id, title: ticket.title, repository, needs: workNeeds(ticket, placement), since: latest.createdAt };
  }

  /** This node's Assignments that wait for a worker and that paired nodes may pull, oldest first. */
  openWork(): OpenWork[] {
    const repository = this.offering();
    if (repository === undefined) return [];
    return this.client.store.tickets.open().flatMap((ticket) => this.waiting(ticket, repository) ?? []).sort((a, b) => a.since.localeCompare(b.since));
  }

  /**
   * A paired node that pulls claims an open Assignment. Nothing waits between the check that the work is still open and the
   * lease that takes it, so the first valid claim wins, and the executor here, which would see the lease, cannot start it in
   * between. The claimer then gets the work through the offer placement uses; when it does not take it, the work is open again.
   */
  private async claim(peer: Peer, body: Record<string, unknown>): Promise<{ claimed: true }> {
    const { ticketId, assignmentId } = ClaimSchema.parse(body);
    const short = ticketId.slice(0, 8);
    const node = this.name();
    if (!this.pulls().offer) throw new HttpError(403, `${node} does not hand its waiting work to nodes that pull`);
    const card = await callPeer<NodeCard>(peer, "GET", "/mesh/v1/node", undefined, 5000).catch((error: unknown) => {
      throw new HttpError(409, `${node} could not read ${peer.name}'s card: ${errorMessage(error)}`);
    });
    const ticket = this.client.store.tickets.get(ticketId);
    const repository = this.offering();
    const work = ticket && repository !== undefined ? this.waiting(ticket, repository) : undefined;
    if (!ticket || work?.assignmentId !== assignmentId) throw new HttpError(409, `The work of ticket ${short} is no longer open on ${node}`);
    const reason = unfit(work, card.abilities, card.pull?.repositories ?? []);
    if (reason) throw new HttpError(409, `${peer.name} cannot take ticket ${short}: ${reason}`);
    const by = { id: peer.id, name: peer.name };
    this.claiming.add(ticketId);
    try {
      this.client.store.atomic(() => {
        const at = new Date().toISOString();
        this.saveLease(ticketId, { assignmentId, node: by, at, expiresAt: new Date(Date.now() + this.leaseMs).toISOString() });
        updatePlacement(this.client, ticketId, { pulled: { ...by, assignmentId } });
      });
      await this.offer(peer, ticket, assignmentId);
    } catch (error) {
      this.client.store.atomic(() => {
        this.dropLease(ticketId);
        updatePlacement(this.client, ticketId, { pulled: undefined });
      });
      throw new HttpError(409, errorMessage(error));
    } finally {
      this.claiming.delete(ticketId);
    }
    this.log(`${peer.name} pulled ticket ${short}`);
    return { claimed: true };
  }

  /** The lease the calling node holds on the ticket's Assignment that the request names; any other caller is refused. */
  private leased({ peer, params, query, body }: MeshRequest): { ticketId: string; assignmentId: string; lease: Lease } {
    const ticketId = params.ticket!;
    const assignmentId = query.get("assignment") ?? String(body.assignmentId ?? "");
    const lease = this.lease(ticketId);
    if (!lease || lease.node.id !== peer!.id || lease.assignmentId !== assignmentId) {
      throw new HttpError(403, `${peer!.name} does not hold the work of ticket ${ticketId.slice(0, 8)}`);
    }
    return { ticketId, assignmentId, lease };
  }

  /** Renews the calling node's lease while its Assignment still runs the ticket, and ends it otherwise; returns whether it holds. */
  private renew({ peer, params, body }: MeshRequest): boolean {
    const ticketId = params.ticket!;
    const lease = this.lease(ticketId);
    if (!this.live(lease) || lease.node.id !== peer!.id || lease.assignmentId !== body.assignmentId) return false;
    const ticket = this.client.store.tickets.get(ticketId);
    const latest = ticket && liveTicket(ticket) ? latestAssignment(ticket) : undefined;
    if (latest?.id !== lease.assignmentId || latest.state === "ended") {
      this.dropLease(ticketId);
      return false;
    }
    this.saveLease(ticketId, { ...lease, expiresAt: new Date(Date.now() + this.leaseMs).toISOString() });
    return true;
  }

  /** The ticket tools a remote worker calls, kept per ticket so a resource's later pages read the same snapshot. */
  private toolset(ticketId: string): TicketTool[] {
    let tools = this.toolsets.get(ticketId);
    if (!tools) {
      tools = ticketTools(this.client, ticketId);
      this.toolsets.set(ticketId, tools);
    }
    return tools;
  }

  /**
   * Registers the routes paired nodes call: this node's open work and claims on it, offers of work for this node to run,
   * and, for the workers that run this node's tickets elsewhere, the ticket's reads, reports and tools.
   */
  serve(server: MeshServer): void {
    const { client } = this;
    server.route("GET", "/mesh/v1/work/open", () => {
      if (!this.pulls().offer) throw new HttpError(403, `${this.name()} does not hand its waiting work to nodes that pull`);
      return { work: this.openWork() };
    });
    server.route("POST", "/mesh/v1/work/claims", ({ peer, body }) => this.claim(peer!, body));
    server.route("POST", "/mesh/v1/work/offers", ({ peer, body }) => this.accept(peer!, body));
    server.route("POST", "/mesh/v1/work/offers/:ticket/stop", async ({ peer, params, body }) => {
      const work = this.held.get(heldKey(peer!.id, params.ticket!));
      const stopped = !!work && work.assignmentId === body.assignmentId;
      if (stopped) await this.release(work);
      return { stopped };
    });

    const ticket = "/mesh/v1/work/tickets/:ticket";
    // A caller without the lease reads nothing, as a worker whose Assignment ended reads no ticket.
    server.route("GET", ticket, (request) => {
      try {
        const { ticketId, assignmentId } = this.leased(request);
        return { view: workView(client, ticketId, assignmentId) ?? null };
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) return { view: null };
        throw error;
      }
    });
    // The worker's environment names its directory on the node that runs it.
    server.route("GET", `${ticket}/start`, forWorkers((request) => {
      const { ticketId, lease } = this.leased(request);
      const found = client.store.tickets.get(ticketId)!;
      return workStart(client, client.deployment(), found, request.query.get("directory") || lease.directory || found.execution!.directory);
    }));
    server.route("POST", `${ticket}/started`, forWorkers((request) => {
      const { ticketId, assignmentId, lease } = this.leased(request);
      const directory = z.string().min(1).parse(request.body.directory);
      this.saveLease(ticketId, { ...lease, directory });
      updatePlacement(client, ticketId, { ran: { ...lease.node, assignmentId, directory } });
      client.engine.assignmentStarted(ticketId, assignmentId);
      return { started: true };
    }));
    server.route("POST", `${ticket}/heartbeat`, (request) => ({ live: this.renew(request) }));
    server.route("POST", `${ticket}/delivered`, forWorkers((request) => {
      const { ticketId, assignmentId } = this.leased(request);
      workDelivered(client, ticketId, assignmentId, z.array(z.string()).parse(request.body.inputIds));
      return {};
    }));
    server.route("POST", `${ticket}/turn`, forWorkers((request) => {
      const { ticketId, assignmentId } = this.leased(request);
      client.engine.turnEnded(ticketId, assignmentId);
      return {};
    }));
    server.route("POST", `${ticket}/report`, forWorkers((request) => {
      const { ticketId } = this.leased(request);
      client.engine.report(ticketId, ReportSchema.parse(request.body.report));
      return {};
    }));
    server.route("POST", `${ticket}/tools/:tool`, forWorkers(async (request) => {
      const { ticketId } = this.leased(request);
      const tool = this.toolset(ticketId).find((item) => item.name === request.params.tool);
      if (!tool) throw new HttpError(404, `No ticket tool ${request.params.tool}`);
      const args = (request.body.args ?? {}) as Record<string, unknown>;
      // The patch of a local ticket's ready report comes from the worker's directory, not from its model: see `withPatch`.
      const patch = tool.name === "report" && args.patch !== undefined ? { patch: PatchSchema.parse(args.patch) } : {};
      return { result: await tool.run({ ...z.object(tool.input).parse(args), ...patch }) };
    }));
    server.route("POST", `${ticket}/exited`, forWorkers((request) => {
      const { ticketId, assignmentId, lease } = this.leased(request);
      const code = z.number().int().nullable().parse(request.body.code ?? null);
      const stderr = String(request.body.stderr ?? "");
      if (code !== 0) this.log(`the worker of ticket ${ticketId.slice(0, 8)} on ${lease.node.name} exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
      workerExited(client, ticketId, assignmentId, code, stderr, lease.node.name);
      return {};
    }));
  }

  // A node peers place work on: running their tickets' workers

  /** Takes an Assignment a paired node offers, or wakes the worker of one this node holds for that node's new Inputs. */
  private async accept(owner: Peer, body: Record<string, unknown>): Promise<{ accepted: true }> {
    const offer = OfferSchema.parse(body);
    const key = heldKey(owner.id, offer.ticketId);
    const held = this.held.get(key);
    if (held?.assignmentId === offer.assignmentId) {
      // A running worker takes new Inputs by itself; an idle one starts again.
      if (held.ready && !held.worker) this.startWorker(held);
      return { accepted: true };
    }
    if (this.closing) throw new HttpError(503, `${this.name()} is stopping`);
    if (this.load().running >= this.client.settings().executor.maxWorkers) throw new HttpError(503, `${this.name()} has no free worker slot`);
    const work = await this.environment(owner, offer);
    if (this.held.get(key)?.assignmentId === offer.assignmentId) return { accepted: true };
    // A later Assignment of the ticket replaces the one this node ran before.
    const replaced = this.held.get(key);
    if (replaced) await this.release(replaced);
    this.held.set(key, work);
    void this.begin(work);
    return { accepted: true };
  }

  /**
   * This node's environment for a paired node's ticket: a directory, worker shims and credentials of its own, under its
   * state directory. A ticket of a GitHub repository needs this node's agent GitHub CLI, signed in as the owner's agent.
   */
  private async environment(owner: Peer, offer: Offer): Promise<Held> {
    const settings = this.client.settings();
    const stateDir = join(this.host.stateDir, "remote", owner.id);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const node = this.name();
    let github: Deployment["github"];
    if (offer.github) {
      const { login } = offer.github;
      const fix = `A node that runs ${offer.repository} tickets needs the agent account's GitHub CLI signed in as ${login}: name it in sources.github.config.cli of ${settingsPath(this.host.stateDir)} on ${node}; its GitHub Source can stay off.`;
      const cli = String(settings.sources.github?.config.cli ?? "").trim();
      if (!cli) throw new HttpError(409, `${node} has no agent GitHub CLI. ${fix}`);
      try {
        github = (await resolveGithub({ repository: offer.repository, cli }, commandProbe(stateDir), workerBin(stateDir)))?.github;
      } catch (error) {
        if (error instanceof SetupError) throw new HttpError(409, `${node}: ${error.message} ${fix}`);
        throw error;
      }
      if (github?.login !== login) throw new HttpError(409, `${node}'s agent GitHub CLI acts as ${github?.login ?? "nobody"}, not ${login}. ${fix}`);
    }
    const deployment: Deployment = { ...defaultMachine(stateDir), repository: offer.repository, ...(github ? { github } : {}) };
    const blocked = [...new Set([...offer.blockedCommands, ...settings.executor.blockedCommands])];
    try {
      writeEnvironment(deployment, blocked);
      await verifyEnvironment(deployment);
    } catch (error) {
      if (error instanceof SetupError) throw new HttpError(409, `${node}: ${error.message}`);
      throw error;
    }
    const directory = join(stateDir, "work", offer.name);
    return {
      owner, ticketId: offer.ticketId, assignmentId: offer.assignmentId, directory, deployment,
      variables: { ...offer.variables, SWARM_TICKET_DIR: directory, SWARM_TICKET_BLOCKED_COMMANDS: blocked.join(" ") },
      permissionMode: offer.permissionMode, ...(offer.write ? { write: offer.write } : {}), leaseMs: offer.leaseMs,
      expires: Date.now() + offer.leaseMs, ready: false
    };
  }

  private holding(work: Held): boolean { return this.held.get(heldKey(work.owner.id, work.ticketId)) === work; }
  private call<T>(work: Held, path: string, body: Record<string, unknown> = {}): Promise<T> {
    return callPeer<T>(work.owner, "POST", `${workPath(work.ticketId)}/${path}`, { assignmentId: work.assignmentId, ...body });
  }

  /** Prepares the ticket's directory once with this node's prepare command, tells the owner it started, and starts its worker. */
  private async begin(work: Held): Promise<void> {
    try {
      if (!existsSync(work.directory)) {
        await prepareDirectory(work.directory, this.client.settings().executor.prepare,
          workerEnvironment(work.deployment, work.variables, process.env, sealed(work.write) ? "none" : "agent"));
      }
      if (!this.holding(work)) return;
      await this.call(work, "started", { directory: work.directory });
      if (!this.holding(work)) return;
      work.ready = true;
      this.startWorker(work);
    } catch (error) {
      if (!this.holding(work)) return;
      const summary = `${this.name()} could not start the worker: ${errorMessage(error)}`.slice(0, 4000);
      this.log(`ticket ${work.ticketId.slice(0, 8)} of ${work.owner.name}: ${summary}`);
      // The failed report waits for a person on the owner, which does not place it again when the lease lapses.
      await this.call(work, "report", { report: { state: "failed", summary } }).catch(() => undefined);
      await this.release(work);
    }
  }

  private startWorker(work: Held): void {
    const [program, ...prefix] = this.options.workerCommand;
    const env = workerEnvironment(work.deployment, {
      ...work.variables,
      SWARM_SUPERAGENT_HOME: this.host.stateDir,
      SWARM_MESH_HOME: this.options.home,
      SWARM_PERMISSION_MODE: work.permissionMode,
      SWARM_SHELL_AUTO_BACKGROUND_MS: String(WORKER_SHELL_AUTO_BACKGROUND_MS)
    }, process.env, sealed(work.write) ? "none" : "agent");
    const child = spawn(program!, [...prefix, "superagent", "worker", "--ticket", work.ticketId, "--assignment", work.assignmentId, "--remote", work.owner.id],
      { cwd: work.directory, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let code: number | null = null;
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    const exited = new Promise<void>((resolve) => {
      child.on("exit", (exit) => { code = exit; resolve(); });
      child.on("error", (error) => { stderr += String(error); code = -1; resolve(); });
    });
    const worker: NonNullable<Held["worker"]> = { process: child, exited };
    work.worker = worker;
    void exited.then(async () => {
      if (work.worker === worker) delete work.worker;
      if (worker.stopping || !this.holding(work)) return;
      // The owner decides what the exit means; when it does not hear of it, the lease lapses and it places the work again.
      await this.call(work, "exited", { code, stderr: stderr.slice(-2000) }).catch(() => this.release(work));
    });
  }

  /** Stops the worker this node runs under a lease, and forgets the lease. */
  private async release(work: Held): Promise<void> {
    if (this.holding(work)) this.held.delete(heldKey(work.owner.id, work.ticketId));
    const worker = work.worker;
    if (!worker) return;
    worker.stopping = true;
    worker.process.kill("SIGTERM");
    const timer = setTimeout(() => { worker.process.kill("SIGKILL"); }, STOP_GRACE_MS);
    timer.unref();
    await worker.exited;
    clearTimeout(timer);
  }

  /** Renews every lease this node holds; a lease its owner ended, or that lapsed unrenewed, stops its worker. */
  private async beat(): Promise<void> {
    if (this.beating || this.closing) return;
    this.beating = true;
    try {
      await Promise.all([...this.held.values()].map(async (work) => {
        const sent = Date.now();
        try {
          const { live } = await this.call<{ live: boolean }>(work, "heartbeat");
          if (!this.holding(work)) return;
          if (live) work.expires = sent + work.leaseMs;
          else await this.release(work);
        } catch {
          if (!this.holding(work) || Date.now() < work.expires) return;
          this.log(`${work.owner.name} did not renew the lease on its ticket ${work.ticketId.slice(0, 8)}; its worker here stops`);
          await this.release(work);
        }
      }));
    } finally {
      this.beating = false;
    }
  }

  /** Worker slots that neither run a worker nor wait for this node's own queued tickets. */
  private free(): number {
    const { running, queued, slots } = this.load();
    return slots - running - queued;
  }

  private nextPull(): void {
    if (this.closing) return;
    this.pullTimer = setTimeout(() => { void this.pull(); }, this.pullDelay);
    this.pullTimer.unref();
  }

  /**
   * While this node pulls and has free worker slots, it asks each paired node for its open work, keeps what its abilities
   * and repositories fit, and claims it oldest first; each owner decides whose claim wins. It looks again soon after it
   * found work, and less often while none fits.
   */
  private async pull(): Promise<void> {
    let found = true;
    try {
      const { node, peers } = readMesh(this.options.home);
      if (!node.pull.enabled || this.client.settings().paused || this.free() <= 0) return;
      const offered = await Promise.all(peers.map(async (peer) => {
        try {
          const { work } = await callPeer<{ work: OpenWork[] }>(peer, "GET", "/mesh/v1/work/open", undefined, 3000);
          return work.map((item) => ({ peer, work: item }));
        } catch {
          // Unreachable, without a ticket host, or keeping its work: nothing to take there now.
          return [];
        }
      }));
      const fitting = offered.flat()
        .filter(({ peer, work }) => !this.held.has(heldKey(peer.id, work.ticketId)) && !unfit(work, this.options.abilities, node.pull.repositories))
        .sort((a, b) => a.work.since.localeCompare(b.work.since));
      found = fitting.length > 0;
      for (const { peer, work } of fitting) {
        if (this.closing || this.free() <= 0) break;
        const ticket = `ticket ${work.ticketId.slice(0, 8)} (${work.title})`;
        try {
          await callPeer(peer, "POST", "/mesh/v1/work/claims", { ticketId: work.ticketId, assignmentId: work.assignmentId }, 60_000);
          this.log(`pulled ${ticket} from ${peer.name}`);
        } catch (error) {
          // Another node or the owner itself took it first; the next look sees what is still open.
          this.log(`${peer.name} kept ${ticket}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      this.log(`pulling work failed: ${errorMessage(error)}`);
    } finally {
      this.pullDelay = found ? this.pullMs : Math.min(this.pullDelay * 2, this.pullMs * 8);
      this.nextPull();
    }
  }

  /** On host stop: no more placing or renewing; the workers this node runs for paired nodes stop, and their leases lapse. */
  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.timers) clearInterval(timer);
    clearTimeout(this.pullTimer);
    this.health.release();
    await Promise.all([...this.held.values()].map((work) => this.release(work)));
  }
}
