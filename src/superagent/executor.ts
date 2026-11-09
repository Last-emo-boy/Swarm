/**
 * The host's side of execution: one worker process per running ticket, in the ticket's own directory, started from the
 * launch and delivery effects (from dsh-superagent's executor/dsh.ts). A worker process runs Swarm's coding loop on the
 * ticket's Work Kernel session and exits when its turn ends, so an idle ticket holds no process; a person's message wakes it
 * with a new process. A ticket holds a slot while its worker starts or runs, and one extra slot is kept for a person's message.
 * A ticket placed on a paired mesh node runs its worker there instead (`RemoteWork`), while this host keeps its record.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson, type Ticket } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { Later } from "./effects.js";
import { verifyDirectory, workerEnvironment } from "./environment.js";
import { patchPath } from "./ticket-tools.js";
import type { Deployment } from "./setup.js";

const exec = promisify(execFile);
/** Maximum runtime of a ticket directory's prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000;
/** How long a stop waits for a worker process to exit before killing it. */
const STOP_GRACE_MS = 10_000;
/**
 * A worker's foreground command moves to a background process after this long, so a person's message reaches the worker
 * at its next step instead of waiting for a long build or test run (upstream moved shell commands after 5 seconds).
 */
export const WORKER_SHELL_AUTO_BACKGROUND_MS = 30_000;

/** True when an input comes from a person: a human Trigger that is not context only, or text such as a status request. */
const fromPerson = (ticket: Ticket): boolean => ticket.undelivered.some((id) => {
  const input = ticket.inputs.find((item) => item.id === id);
  return input?.kind === "trigger" ? !!input.human && !input.context : input?.kind === "text";
});

/** Worker slots: running workers and starting reservations, with one extra slot for a person's message. */
export class WorkerSlots {
  private readonly starting = new Map<string, "launch" | "wake" | "person">();
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size; }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== "launch" ? [ticketId] : []);
    return this.max() - new Set([...this.running(), ...wakes]).size;
  }
  /** Reserves a start slot; a wake for a person's message may use one extra slot. @throws Later when no slot is free. */
  reserve(ticketId: string, by: "launch" | "wake" | "person"): void {
    if (this.starting.has(ticketId)) return;
    if (this.used() >= this.max() + (by === "person" ? 1 : 0)) throw new Later("No worker slot is free");
    this.starting.set(ticketId, by);
  }
  free(ticketId: string): void { this.starting.delete(ticketId); }
}

class PrepareFailed extends Error {}

/**
 * Runs a new ticket directory's prepare command in its parent, with the ticket's variables in `env`, then verifies the
 * directory as the worker's git sees it. A failed command throws; an empty directory it left is removed.
 */
export async function prepareDirectory(directory: string, command: string, env: NodeJS.ProcessEnv): Promise<void> {
  mkdirSync(dirname(directory), { recursive: true });
  if (command.trim()) {
    await exec("sh", ["-c", command.trim()], { cwd: dirname(directory), env, timeout: PREPARE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
      .catch((error: { stderr?: string; message?: string }) => {
        try { rmdirSync(directory); } catch { /* Absent, or holding what the command wrote, which its output explains. */ }
        throw new PrepareFailed(`The prepare command failed: ${(error.stderr || error.message || String(error)).slice(0, 2000)}`);
      });
  }
  mkdirSync(directory, { recursive: true });
  await verifyDirectory(directory, env);
}

/**
 * Applies a patch of commits to a prepared ticket directory with `git am`, committing as the agent's account, or as Swarm
 * without one; a patch that does not apply leaves the directory as it was and throws why.
 */
export async function applyPatch(directory: string, patch: string, env: NodeJS.ProcessEnv, variables: Record<string, string>): Promise<void> {
  const name = variables.SWARM_TICKET_GITHUB_ACCOUNT || "Swarm", email = variables.SWARM_TICKET_GITHUB_COMMIT_EMAIL || "swarm@localhost";
  const git = (...args: string[]) => exec("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args],
    { cwd: directory, env, timeout: PREPARE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  await git("am", "--3way", patch).catch(async (error: { stderr?: string; message?: string }) => {
    await git("am", "--abort").catch(() => undefined);
    throw new PrepareFailed(`The patch of the ticket taken over does not apply: ${(error.stderr || error.message || String(error)).slice(0, 2000)}`);
  });
}

/**
 * A worker process that ended its own turn leaves the Inputs that came since for the next; one that crashed fails its ticket.
 * `node` names the paired node it ran on.
 */
export function workerExited(client: SuperagentClient, ticketId: string, assignmentId: string, code: number | null, stderr: string, node?: string): void {
  const ticket = client.store.tickets.get(ticketId);
  const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined;
  if (!ticket || assignment?.id !== assignmentId) return;
  if (code !== 0) {
    const where = node ? ` on ${node}` : "";
    client.engine.report(ticketId, { state: "failed", summary: `The worker process${where} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}` });
    return;
  }
  if (ticket.undelivered.length) client.effects.enqueue("delivery", ticketId, { ticketId });
}

/**
 * Running a ticket's worker on a paired node instead of here: the mesh's side of the Executor (src/mesh/work.ts). The node
 * that runs it holds a lease on the Assignment while it renews it; this host keeps the ticket's record.
 */
export interface RemoteWork {
  /**
   * Runs the Assignment's worker on the node that holds its lease or that the ticket's placement chooses, which also wakes
   * an idle one for its Inputs, and returns true; returns false when it runs here. Throws `Later` while that node has no free
   * slot, and an error when it does not take the work.
   */
  run(ticket: Ticket, assignmentId: string): Promise<boolean>;
  /** Whether a paired node holds a live lease on the Assignment. */
  holds(ticketId: string, assignmentId: string): boolean;
  /** Ends the Assignment's worker on the node that holds it, and the lease. */
  stop(ticketId: string, assignmentId: string): Promise<void>;
  /** On host stop: stops placing work and renewing leases. */
  close(): Promise<void>;
}

export interface ExecutorHost {
  readonly client: SuperagentClient;
  deployment(): Deployment;
  /** The command that starts a worker process: the Node binary and the Swarm entry point before its arguments. */
  readonly workerCommand: readonly string[];
  /** Variables of a ticket's execution environment for its prepare command and worker. */
  environment(ticket: Ticket): Record<string, string>;
  closing(): boolean;
  log(message: string): void;
  /** Where tickets placed on paired nodes run, on a host that is a mesh node. */
  remote(): RemoteWork | undefined;
}

interface Worker { process: ChildProcess; assignmentId: string; exited: Promise<number | null>; stopping?: boolean }

export class SwarmExecutor {
  private readonly workers = new Map<string, Worker>();
  readonly slots: WorkerSlots;
  constructor(private readonly host: ExecutorHost) {
    const { client } = host;
    this.slots = new WorkerSlots(() => [...this.workers.keys()], () => client.settings().executor.maxWorkers);
    const paused = () => client.settings().paused;
    client.effects.handle("launch", (payload) => this.launch(payload.ticketId, payload.assignmentId),
      { limit: () => paused() ? 0 : Math.max(0, this.slots.launches()), retry: [5000, 300_000] });
    client.effects.handle("delivery", (payload) => this.wake(payload.ticketId), { limit: () => paused() ? 0 : 4, quiet: true });
    client.effects.handle("stop", (payload, assignmentId) => this.stop(payload.ticketId, assignmentId), { limit: () => 4 });
  }

  /** Tickets with a worker process right now. */
  running(): string[] { return [...this.workers.keys()]; }

  /** Starts a pending Assignment: prepares the ticket's directory once, then its worker process. */
  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    const { client } = this.host;
    const ticket = client.store.tickets.get(ticketId);
    const assignment = ticket && latestAssignment(ticket);
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== "pending") return;
    if (this.host.closing()) throw new Later("The host is stopping");
    try {
      if (await this.host.remote()?.run(ticket, assignmentId)) return;
    } catch (error) {
      if (error instanceof Later) throw error;
      this.failed(ticketId, assignmentId, error instanceof Error ? error.message : String(error));
      return;
    }
    this.slots.reserve(ticketId, "launch");
    try {
      const directory = ticket.execution?.directory ?? "";
      if (!directory) throw new PrepareFailed("The ticket has no directory");
      if (!existsSync(directory)) await this.prepare(ticket);
      client.engine.assignmentStarted(ticketId, assignmentId);
      this.spawnWorker(ticketId, assignmentId);
    } catch (error) {
      if (error instanceof Later) throw error;
      this.failed(ticketId, assignmentId, error instanceof Error ? error.message : String(error));
    } finally {
      this.slots.free(ticketId);
    }
  }

  /**
   * Prepares a ticket's new directory with the prepare command, and applies the patch of the ticket it takes over; a failed
   * command or a patch that does not apply fails the ticket.
   */
  private async prepare(ticket: Ticket): Promise<void> {
    const variables = this.host.environment(ticket);
    const env = workerEnvironment(this.host.deployment(), variables, process.env, ticket.mandate.capability?.write);
    const { directory } = ticket.execution!;
    await prepareDirectory(directory, this.host.client.settings().executor.prepare, env);
    const from = ticket.mandate.capability?.from;
    if (from) await applyPatch(directory, this.takenOver(from), env, variables);
  }
  /** The patch of the ticket a take-over carries on with. */
  private takenOver(ticketId: string): string {
    const { client } = this.host;
    const source = client.store.tickets.get(ticketId);
    const path = source && patchPath(client.stateDir, source);
    if (!path || !existsSync(path)) throw new PrepareFailed(`Ticket ${ticketId} left no patch to take over`);
    return path;
  }

  /** Wakes an idle ticket's worker for the Inputs waiting for it; a running worker takes them by itself. */
  private async wake(ticketId: string): Promise<void> {
    const { client } = this.host;
    const ticket = client.store.tickets.get(ticketId);
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined;
    if (!ticket || !assignment || !ticket.undelivered.length) return;
    if (this.workers.has(ticketId)) return;
    // A blocked or failed ticket takes automatic Inputs only once a person wrote, which the Engine already filtered.
    if (waitsForPerson(ticket) && !fromPerson(ticket)) return;
    if (this.host.closing()) throw new Later("The host is stopping");
    try {
      if (await this.host.remote()?.run(ticket, assignment.id)) return;
    } catch (error) {
      if (error instanceof Later) throw error;
      // The ticket shows the Inputs that did not reach its worker, until a delivery succeeds or a person retries it.
      client.engine.deliveryFailed(ticketId, assignment.id, error instanceof Error ? error.message : String(error));
      return;
    }
    this.slots.reserve(ticketId, fromPerson(ticket) ? "person" : "wake");
    try {
      // An Assignment that ran on a paired node whose lease lapsed has no directory here yet.
      if (!existsSync(ticket.execution?.directory ?? "")) await this.prepare(ticket);
      this.spawnWorker(ticketId, assignment.id);
    } catch (error) {
      client.engine.deliveryFailed(ticketId, assignment.id, error instanceof Error ? error.message : String(error));
    } finally { this.slots.free(ticketId); }
  }

  private spawnWorker(ticketId: string, assignmentId: string): void {
    const { client } = this.host;
    const ticket = client.store.tickets.get(ticketId)!;
    const [program, ...prefix] = this.host.workerCommand;
    const env = workerEnvironment(this.host.deployment(), {
      ...this.host.environment(ticket),
      SWARM_SUPERAGENT_HOME: client.stateDir,
      SWARM_SUPERAGENT_DEPLOYMENT: JSON.stringify(this.host.deployment()),
      SWARM_PERMISSION_MODE: client.settings().executor.permissionMode,
      SWARM_SHELL_AUTO_BACKGROUND_MS: String(WORKER_SHELL_AUTO_BACKGROUND_MS)
    }, process.env, ticket.mandate.capability?.write);
    const child = spawn(program!, [...prefix, "superagent", "worker", "--ticket", ticketId, "--assignment", assignmentId],
      { cwd: ticket.execution!.directory, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", (error) => { stderr += String(error); resolve(-1); });
    });
    const worker: Worker = { process: child, assignmentId, exited };
    this.workers.set(ticketId, worker);
    void exited.then((code) => {
      if (this.workers.get(ticketId) === worker) this.workers.delete(ticketId);
      this.exited(ticketId, assignmentId, code, stderr, worker.stopping === true);
      // Inputs that arrived after the worker's last look wait for the next one.
      if (!this.host.closing()) client.effects.kick();
    });
  }

  /** A worker process that ended its own turn reports; one that crashed without a report fails its ticket. */
  private exited(ticketId: string, assignmentId: string, code: number | null, stderr: string, stopped: boolean): void {
    if (stopped || this.host.closing()) return;
    if (code !== 0) this.host.log(`superagent worker for ${ticketId} exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
    workerExited(this.host.client, ticketId, assignmentId, code, stderr);
  }

  private failed(ticketId: string, assignmentId: string, summary: string): void {
    const { client } = this.host;
    const ticket = client.store.tickets.get(ticketId);
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return;
    client.engine.report(ticketId, { state: "failed", summary });
  }

  /**
   * Ends an Assignment's worker: terminates the process, then kills it after a grace period. A worker whose last word was
   * a ready or dropped report finishes its own turn instead.
   */
  private async stop(ticketId: string, assignmentId: string): Promise<void> {
    const worker = this.workers.get(ticketId);
    const here = worker?.assignmentId === assignmentId;
    const remote = this.host.remote();
    if (!here && !remote?.holds(ticketId, assignmentId)) return;
    const ticket = this.host.client.store.tickets.get(ticketId);
    const assignment = ticket?.assignments.find((item) => item.id === assignmentId);
    const report = assignment?.report;
    const busy = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at;
    if ((report?.state === "ready" || report?.state === "dropped") && !busy) return;
    if (here) await this.terminate(worker!);
    else await remote!.stop(ticketId, assignmentId);
  }

  private async terminate(worker: Worker): Promise<void> {
    worker.stopping = true;
    worker.process.kill("SIGTERM");
    const timer = setTimeout(() => { worker.process.kill("SIGKILL"); }, STOP_GRACE_MS);
    timer.unref();
    await worker.exited;
    clearTimeout(timer);
  }

  /**
   * On host start: an Assignment left running by an earlier host has no worker now, so the Engine restarts it or keeps its
   * report; one whose worker a paired node runs under a live lease keeps running there.
   */
  resume(): void {
    const { client } = this.host;
    const remote = this.host.remote();
    for (const ticket of client.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket);
      if (running && !this.workers.has(ticket.id) && !remote?.holds(ticket.id, running.id)) client.engine.assignmentInterrupted(ticket.id, running.id);
      else if (latestAssignment(ticket)?.state === "pending" && !waitsForPerson(ticket)) {
        client.effects.enqueue("launch", latestAssignment(ticket)!.id, { ticketId: ticket.id, assignmentId: latestAssignment(ticket)!.id });
      }
    }
  }

  /** On host stop: stops every worker process; their Assignments restart with a recovery note on the next start. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => this.terminate(worker)));
    this.workers.clear();
  }
}

