/**
 * The superagent host: the one Swarm process that carries out what the Engine queues (from dsh-superagent's app/runtime.ts).
 * It holds the state directory's lock, resolves the accounts, polls the Sources, runs the effects (model judgements, worker
 * launches and deliveries, replies), applies settings-file changes as Policy changes, and writes a health snapshot that
 * other Swarm processes show. `swarm superagent run` starts it; the TUI can start one when none runs.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { key, liveTicket, waitsForPerson, type Ticket } from "./core/index.js";
import { ModelAssessor, type Complete } from "./assessor.js";
import { Journal, journaled } from "./journal.js";
import { BotCommands } from "./bot-commands.js";
import { ChatterRoom } from "./chatter.js";
import { Memories } from "./memories.js";
import { sweepStale } from "./notices.js";
import { GithubLinks, githubApp, linkKey, type Credential, type LinkView } from "./github-link.js";
import { SuperagentClient } from "./client.js";
import { devicesOf, type Devices } from "./devices.js";
import { writeEnvironment, verifyEnvironment, workerBin } from "./environment.js";
import { SwarmExecutor, type RemoteWork } from "./executor.js";
import { KV } from "./kv.js";
import type { MeshView } from "./placement.js";
import { policyEffects } from "./policy.js";
import { policyVersion, settingsPath, superagentStateDir, type Settings } from "./settings.js";
import { SETUP_FIELDS, SetupError, commandProbe, defaultMachine, resolveFeishuBot, resolveGithub, type Deployment, type SetupProblem } from "./setup.js";
import { sourceContextOf, type SourceContextDeps } from "./sources/context.js";
import type { SourceKind } from "./sources/kind.js";
import { sourceTrigger } from "./messages.js";
import { prunePatches } from "./ticket-tools.js";
import { sameName } from "./text.js";
import { ticketVariables, variableValues } from "./variables.js";
import type { VmControl } from "./vm/vm-work.js";
import { buildDirectory } from "../directory/build.js";
import { DIRECTORY_MS, freshDirectory, harnessPart, hereFacts, hereHarnesses, meshPart, readPeers, readProviders } from "../directory/read.js";
import type { Directory } from "../directory/types.js";
import { thisSwarm } from "../mesh/card.js";
import type { PeerHealth } from "../mesh/client.js";
import { meshHome, meshPeers, readMesh } from "../mesh/state.js";
import { hostStatus } from "./views.js";

const PASS_MS = 2000;
/** How often the host deletes the patches it kept too long. */
const PRUNE_MS = 3_600_000;
/** How often the host looks for tickets that waited on a person too long (notices.ts). */
const SWEEP_MS = 60_000;
/** How often the host deletes the journal rows it kept too long. */
const JOURNAL_PRUNE_MS = 3_600_000;
/** How long the router and `/devices` reuse what the paired nodes answered, rather than asking each of them again. */
const MESH_VIEW_MS = 30_000;
/** How often a Source's sign-in check runs; it is one cheap call, never on every pass. */
const CHECK_MS = 5 * 60_000;
/** How often a host that is no mesh node checks its harnesses' installs and sign-ins, as a mesh node checks its own. */
const HARNESS_CHECK_MS = 10 * 60_000;

export interface HostOptions {
  stateDir?: string;
  /** How a worker process starts: the Node binary and the Swarm entry point. */
  workerCommand: readonly string[];
  /** The model call behind routing and assessments. */
  complete: Complete;
  log?: (message: string) => void;
  /** How ticket VMs start and stop, with `executor.isolation` set to vm: the deployment's systemd units by default. */
  vmControl?: VmControl;
  /** Extra Source kinds to register beside the built-in ones, as `SuperagentClient` takes them. */
  kinds?: readonly SourceKind[];
  /**
   * Whether a host that is no mesh node runs its harnesses' sign-in checks itself, every `HARNESS_CHECK_MS`, as a mesh
   * node runs its own; they start the harnesses' status commands. Without them only installs are checked, and the
   * directory lists no harness as running here, since one whose sign-in lapsed would fail the work put on it.
   */
  checkHarnesses?: boolean;
}

/** Who holds a state directory's lock, when a live process does. */
export function lockHolder(stateDir: string): { pid: number; startedAt: string } | undefined {
  try {
    const held = JSON.parse(readFileSync(join(stateDir, "host.lock"), "utf8")) as { pid: number; startedAt: string };
    process.kill(held.pid, 0);
    return held;
  } catch {
    return undefined;
  }
}

function acquireLock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "host.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { rmSync(path); } catch { /* Already gone. */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = lockHolder(stateDir);
      if (holder) throw new Error(`Another superagent host runs for ${stateDir} (pid ${holder.pid}, since ${holder.startedAt})`);
      // The process that held it is gone.
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not lock ${stateDir}`);
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => [settings.sources[id]?.enabled, ...keys.map((key) => settings.sources[id]?.config[key] ?? "")]));

/**
 * Queues a `checkback` effect for every open ticket whose worker asked to be woken by now. Runs on the host's pass, so a
 * check-back that fell due while the host was down fires on the first pass after it starts; the ticket row keeps what is
 * due, so the effect row is only a timer. A ticket that waits for a person keeps its check-back until they reply, since a
 * blocked or failed ticket takes no automatic Input meanwhile; if they never do, the stale clock ends it and the end drops it.
 * The handler makes the same call again, on a ticket read later, so a waiting ticket it finds keeps its request too.
 */
export function dueCheckBacks(client: Pick<SuperagentClient, "store" | "effects">, now = new Date().toISOString()): number {
  let queued = 0;
  for (const ticket of client.store.tickets.open()) {
    const due = ticket.checkBack;
    if (!due || due.at > now || waitsForPerson(ticket) || client.effects.pending("checkback", ticket.id)) continue;
    client.store.atomic(() => client.effects.enqueue("checkback", ticket.id, { ticketId: ticket.id }));
    queued++;
  }
  return queued;
}

export class SuperagentHost {
  readonly stateDir: string;
  readonly client: SuperagentClient;
  /** The same command implementation every surface reaches, for a paired node that answers a read from this one. */
  get commands(): BotCommands { return this.botCommands; }
  private readonly executor: SwarmExecutor;
  private readonly assessor: ModelAssessor;
  private readonly botCommands: BotCommands;
  private readonly chatter: ChatterRoom;
  private readonly memories: Memories;
  private readonly journal: Journal;
  private readonly links: GithubLinks;
  private release?: () => void;
  private prunedAt = 0;
  private journalPrunedAt = 0;
  private sweptAt = 0;
  private deployment?: Deployment;
  problem?: SetupProblem;
  /** Where tickets placed on paired nodes run; a mesh node sets it before it starts the host (src/mesh/work.ts). */
  remote?: RemoteWork;
  /**
   * This node and its paired nodes with their abilities, which the router says work runs on; a mesh node sets it
   * (src/mesh/cli.ts). It is given the host's own pass over the paired nodes, so it asks none of them again.
   */
  meshView?: (pass: readonly PeerHealth[]) => Promise<MeshView>;
  private meshRead?: { at: number; view: Promise<MeshView> };
  private peersRead?: { at: number; pass: Promise<PeerHealth[]> };
  private harnessesRead?: { at: number; checks: ReturnType<typeof hereHarnesses> };
  private timer?: NodeJS.Timeout;
  private closing = false;
  private passing = false;
  private appliedSetup = "";
  private readonly watchers = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** When each Source's sign-in check last ran, so a pass only asks the ones whose turn it is. */
  private readonly checkedAt = new Map<string, number>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: HostOptions) {
    this.stateDir = options.stateDir ?? superagentStateDir();
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.release = acquireLock(this.stateDir);
    try {
      this.client = new SuperagentClient({ stateDir: this.stateDir, deployment: () => this.deployment, ...options.kinds ? { kinds: options.kinds } : {},
        onError: (error) => this.log(`superagent: a follow-up after a commit failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`) });
      this.links = new GithubLinks({ store: this.client.store, key: () => linkKey(this.stateDir), broken: (actor, link) => this.linkBroken(link) });
      // The talking paths record what they asked the model and what became of it (journal.ts): one wrapper around the one model call.
      this.journal = new Journal(this.client.store);
      this.client.journal = this.journal;
      const complete = journaled(this.journal, options.complete);
      this.executor = new SwarmExecutor({
        client: this.client,
        deployment: () => this.requireDeployment(),
        workerCommand: options.workerCommand,
        environment: (ticket) => this.variables(ticket),
        closing: () => this.closing,
        log: this.log,
        remote: () => this.remote,
        credential: (ticket) => this.credential(ticket)
      });
      // A ticket waking itself when its worker asked to be is a ticket command, not a launch: the row is only a timer, and
      // the pass re-queues a due one from the ticket row after a restart.
      this.client.effects.handle("checkback", async ({ ticketId }) => { this.client.engine.fireCheckBack(ticketId); },
        { limit: () => this.client.settings().paused ? 0 : 4, retry: [15_000, 300_000] });
      this.botCommands = new BotCommands(this.client, { links: this.links, log: this.log, devices: () => this.devices() });
      this.assessor = new ModelAssessor({ client: this.client, complete, configured: () => !!this.deployment, commands: this.botCommands,
        mesh: () => this.mesh(), directory: () => this.sharedDirectory(), log: this.log });
      this.assessor.install();
      this.chatter = new ChatterRoom({ client: this.client, complete, log: this.log });
      this.chatter.install();
      this.memories = new Memories({ client: this.client, complete, log: this.log });
      this.memories.install();
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private requireDeployment(): Deployment {
    if (!this.deployment) throw new Error(`The superagent is waiting for setup: ${this.problem?.detail ?? "setup has not run"}`);
    return this.deployment;
  }
  private variables(ticket: Ticket): Record<string, string> {
    const trigger = sourceTrigger({ store: this.client.store }, ticket);
    return variableValues(ticketVariables({ deployment: this.requireDeployment(), sources: this.client.sources, settings: this.client.settings(),
      ticket, ...(trigger ? { trigger } : {}) }));
  }

  /** The token of the account a ticket writes to GitHub as, while that person's link still is that account and works. */
  private async credential(ticket: Ticket): Promise<Credential | undefined> {
    const app = githubApp(this.client.settings());
    const wanted = ticket.mandate.capability?.credential;
    const credential = app && wanted ? await this.links.credential(app, ticket.mandate.actor) : undefined;
    return credential && sameName(credential.login, wanted!.login) ? credential : undefined;
  }
  /** A link that stopped working tells its person where they linked it. */
  private linkBroken(link: LinkView): void {
    if (!link.channel) return;
    this.client.outbox.send({ id: key("link-broken", link.login, link.linkedAt), channel: link.channel, kind: "reply",
      text: `Your GitHub link (@${link.login}) stopped working: ${link.broken}. Send /link here to link again.` });
  }

  /** Resolves the accounts the Sources act as and writes the workers' environment; a problem leaves those Sources off. */
  async setup(): Promise<void> {
    const settings = this.client.settings();
    const machine = defaultMachine(this.stateDir);
    const probe = commandProbe(this.stateDir);
    const exclude = workerBin(this.stateDir);
    this.problem = undefined;
    let github: Awaited<ReturnType<typeof resolveGithub>>;
    try {
      github = settings.sources.github?.enabled ? await resolveGithub(settings.sources.github.config, probe, exclude) : undefined;
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      this.problem = error.problem;
      github = undefined;
    }
    let feishu: Awaited<ReturnType<typeof resolveFeishuBot>>;
    try {
      feishu = settings.sources.feishu?.enabled ? await resolveFeishuBot(settings.sources.feishu.config, probe, exclude) : undefined;
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      this.problem ??= error.problem;
      feishu = undefined;
    }
    const deployment: Deployment = { ...machine, repository: github?.repository ?? "", ...(github ? { github: github.github } : {}), ...(feishu ? { feishu } : {}) };
    writeEnvironment(deployment, settings.executor.blockedCommands);
    this.deployment = deployment;
    await verifyEnvironment(deployment);
    this.appliedSetup = setupFields(settings);
  }

  async start(): Promise<void> {
    await this.setup().catch((error: unknown) => { this.log(`superagent setup failed: ${error instanceof Error ? error.message : String(error)}`); });
    const { store } = this.client;
    if (!store.get(KV.host.applied)) {
      const settings = this.client.settings();
      store.set(KV.host.applied, { policyVersion: policyVersion(settings), settings });
    }
    // Ticket VMs take the work this node keeps; isolation applies from the host's start.
    if (this.client.settings().executor.isolation === "vm") {
      const { VmWork } = await import("./vm/vm-work.js");
      const vm = new VmWork({ client: this.client, stateDir: this.stateDir, deployment: () => this.requireDeployment(),
        environment: (ticket) => this.variables(ticket), credential: (ticket) => this.credential(ticket), log: this.log }, this.remote, this.options.vmControl);
      await vm.start();
      this.remote = vm;
    }
    this.executor.resume();
    this.client.effects.start();
    this.restartSources();
    this.timer = setInterval(() => { void this.pass(); }, PASS_MS);
    await this.pass();
  }

  /** One pass: apply settings changes, start due Evals, kick the effect queue for rows other processes queued, report health. */
  async pass(): Promise<void> {
    if (this.passing || this.closing) return;
    this.passing = true;
    try {
      const settings = this.client.settings();
      this.applyPolicy(settings);
      if (setupFields(settings) !== this.appliedSetup) {
        await this.setup().catch((error: unknown) => { this.log(`superagent setup failed: ${String(error)}`); });
        this.restartSources();
      }
      this.syncSources(settings);
      if (Date.now() - this.prunedAt > PRUNE_MS) { prunePatches(this.stateDir); this.prunedAt = Date.now(); }
      if (Date.now() - this.journalPrunedAt > JOURNAL_PRUNE_MS) { this.journal.prune(); this.journalPrunedAt = Date.now(); }
      this.client.engine.evaluateDue();
      if (!settings.paused) {
        dueCheckBacks(this.client);
        this.chatter.pass();
        this.memories.pass();
        if (Date.now() - this.sweptAt > SWEEP_MS) { this.sweptAt = Date.now(); sweepStale(this.client); }
        this.botCommands.takeOverWanted();
      }
      this.client.effects.kick();
      await this.checks(settings);
      // Workers and other processes read what the host runs work on and who can do what from its snapshots, which stay
      // at most a minute old; the directory reads the devices too, from the same pass over the paired nodes.
      // A mesh node's meetings hand it a pass a minute, after which it writes the directory; its own pass is the fallback.
      if (Date.now() - this.devicesAt > (this.peersNoted ? 1.5 * DIRECTORY_MS : DIRECTORY_MS)) {
        this.devicesAt = Date.now();
        void this.directory().catch((error: unknown) => { this.log(`superagent: could not read the directory: ${String(error)}`); });
      }
      this.client.store.set(KV.host.owner, { pid: process.pid, startedAt: this.startedAt, heartbeatAt: new Date().toISOString() });
      this.client.store.set(KV.host.health, { at: new Date().toISOString(), entries: {
        ...this.client.health.all,
        ...(this.problem ? { setup: { state: "error", detail: this.problem.detail } } : {}),
        ...(this.client.settingsError() ? { settings: { state: "error", detail: this.client.settingsError()! } } : {}),
        workers: { state: "ready", detail: `${this.executor.running().length} running` }
      } });
    } catch (error) {
      this.log(`superagent pass failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    } finally {
      this.passing = false;
    }
  }
  private readonly startedAt = new Date().toISOString();
  private devicesAt = 0;

  /** Whether a mesh node's meetings hand this host their passes over the paired nodes (`notePeers`). */
  private peersNoted = false;

  /**
   * A pass over the paired nodes made elsewhere in this process, such as a mesh node's meeting with them: the mesh view,
   * the devices and the directory use it as their own, and the next host pass writes the directory from it, so the
   * paired nodes are asked for their cards once a minute rather than twice.
   */
  notePeers(pass: readonly PeerHealth[]): void {
    this.peersNoted = true;
    this.peersRead = { at: Date.now(), pass: Promise.resolve([...pass]) };
    this.meshRead = undefined;
    this.devicesAt = 0;
  }

  /** Worker processes running here now. */
  runningWorkers(): number { return this.executor.running().length; }

  /**
   * One read of every paired node's card, at most `MESH_VIEW_MS` old, which the mesh view, the devices and the directory
   * share, so a minute of them asks each peer once rather than once for each.
   */
  private peers(): Promise<PeerHealth[]> {
    if (!this.peersRead || Date.now() - this.peersRead.at > MESH_VIEW_MS) {
      const pass = readPeers(meshHome(), 3000);
      this.peersRead = { at: Date.now(), pass };
      // A read that failed is not reused.
      pass.catch(() => { if (this.peersRead?.pass === pass) this.peersRead = undefined; });
    }
    return this.peersRead.pass;
  }
  /**
   * The harnesses that run here and why the others do not, on a host that is no mesh node (a mesh node's own checks come
   * with its view): read as `readDirectory` reads them, with sign-ins checked when `checkHarnesses` asks, every
   * `HARNESS_CHECK_MS`, and installs alone otherwise.
   */
  private ownHarnesses(): ReturnType<typeof hereHarnesses> {
    if (!this.harnessesRead || Date.now() - this.harnessesRead.at > (this.options.checkHarnesses ? HARNESS_CHECK_MS : MESH_VIEW_MS)) {
      const checks = hereHarnesses(this.client.settings().executor, settingsPath(this.stateDir), new Date().toISOString(), { signIn: !!this.options.checkHarnesses });
      this.harnessesRead = { at: Date.now(), checks };
      // A check that failed is not reused.
      checks.catch(() => { if (this.harnessesRead?.checks === checks) this.harnessesRead = undefined; });
    }
    return this.harnessesRead.checks;
  }
  /** This node and its paired nodes, as `meshView` read them at most `MESH_VIEW_MS` ago; none on a host that is no mesh node. */
  private async mesh(): Promise<MeshView | undefined> {
    if (!this.meshView) return undefined;
    if (!this.meshRead || Date.now() - this.meshRead.at > MESH_VIEW_MS) {
      const meshView = this.meshView;
      const view = this.peers().then((pass) => meshView(pass));
      this.meshRead = { at: Date.now(), view };
      // A read that failed is not reused.
      view.catch(() => { if (this.meshRead?.view === view) this.meshRead = undefined; });
    }
    return this.meshRead.view;
  }
  /** What this host runs its tickets' work on now: its node, its paired nodes and its free workers (devices.ts). */
  async devices(): Promise<Devices> {
    const devices = devicesOf({ settings: this.client.settings(), store: this.client.store, view: await this.mesh(), running: this.runningWorkers() });
    this.client.store.set(KV.host.devices, { at: new Date().toISOString(), devices });
    return devices;
  }
  /**
   * Who can do what now (src/directory), from the same pass over the paired nodes as the devices, written for readers in
   * other processes and ticket VMs. A host has no MCP servers of its own: the tools it lists are what paired nodes lend.
   */
  async directory(): Promise<Directory> {
    const home = meshHome();
    // A pass that failed leaves the nodes stale in the directory rather than leaving no directory at all.
    const [pass, view, providers] = await Promise.all([
      this.peers().then((peers) => ({ peers }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
      this.mesh().catch(() => undefined), readProviders()]);
    const devices = view || !this.meshView ? await this.devices()
      : devicesOf({ settings: this.client.settings(), store: this.client.store, running: this.runningWorkers() });
    const settings = this.client.settings();
    const at = new Date().toISOString();
    const own = thisSwarm();
    const node = meshPeers(home).length || view ? readMesh(home).node : undefined;
    const health = this.client.store.get(KV.host.health);
    // A mesh node checks its harnesses every few minutes and says so in its view; a host that is no mesh node checks its own.
    const ownChecks = this.meshView ? undefined : await this.ownHarnesses().catch(() => undefined);
    const checks = view?.harnessChecks ?? (ownChecks?.checkedAt ? { at: ownChecks.checkedAt, problems: ownChecks.problems } : undefined);
    const problems = view?.harnessChecks?.problems ?? ownChecks?.problems;
    const here = hereFacts({ ...(node ? { node } : {}), settings, devices, queued: hostStatus(this.client).counts.queued, host: "running",
      ...(problems ? { harnessProblems: { ...problems } } : {}), own });
    const directory = buildDirectory({
      at, own, providers,
      // A host that is no mesh node lists what its own check found running here: none when only installs were checked.
      here: this.meshView ? here : { ...here, harnesses: [...ownChecks?.harnesses ?? []] },
      mesh: "error" in pass ? pass : meshPart(pass.peers, at, home),
      harnesses: harnessPart(settings.executor, checks?.at ?? at, !!checks),
      ...(health ? { health } : {})
    });
    this.client.store.set(KV.host.directory, directory);
    return directory;
  }

  /** The directory the router reads: the one this host wrote while it is fresh, else one built now from the shared pass. */
  private async sharedDirectory(): Promise<Directory> {
    return freshDirectory(this.client.store) ?? this.directory();
  }

  /** A changed Policy version discards running Evals and tells the live tickets it bears on, as a settings save did upstream. */
  private applyPolicy(settings: Settings): void {
    const { store, engine, sources } = this.client;
    const applied = store.get(KV.host.applied);
    const version = policyVersion(settings);
    if (!applied || applied.policyVersion === version) return;
    const old = applied.settings as Settings;
    const effects = policyEffects(store.tickets.open().filter(liveTicket), old, settings,
      (scoped) => ({ scope: (input) => sources.scope(input, scoped) }));
    store.atomic(() => {
      engine.policyChanged(applied.policyVersion, version, effects);
      store.set(KV.host.applied, { policyVersion: version, settings });
    });
  }

  private deps(): SourceContextDeps {
    const host = this;
    const { client } = this;
    return {
      store: client.store, outbox: client.outbox, engine: client.engine, commands: client.commands, sources: client.sources,
      get deployment() { return host.requireDeployment(); },
      ready: Promise.resolve(),
      configured: () => !!host.deployment,
      get setupProblem() { return host.problem; },
      // A bot command, or a message the sender's limits hold back, stops here; anything else goes to the Engine.
      receive: (trigger) => {
        const result = this.botCommands.receive(trigger);
        void this.pass();
        return result;
      }
    };
  }
  /**
   * Runs each enabled Source's sign-in check whose turn it is (`CHECK_MS`), before the health snapshot is written; the
   * registry reports the outcome on the kind's own check entry. A failure is swallowed here — the entry carries its
   * message — so one signed-out Source never stops a pass.
   */
  private async checks(settings: Settings): Promise<void> {
    for (const instance of this.client.sources.instances(settings)) {
      const kind = this.client.sources.kind(instance.id);
      if (!kind?.check || !instance.enabled) continue;
      if (Date.now() - (this.checkedAt.get(instance.id) ?? 0) < CHECK_MS) continue;
      const health = await this.client.sources.check(instance.id, this.client.commands, this.deployment)
        .catch((error: unknown) => { this.log(`superagent ${instance.id} check failed to run: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
      // Stamped only when the check actually ran: no deployment yet means nothing was asked, so the next pass tries again.
      if (health) this.checkedAt.set(instance.id, Date.now());
    }
  }
  /** Starts the polling loop of every Source that is on and has one, and stops the loops of Sources switched off. */
  private syncSources(settings: Settings): void {
    for (const instance of this.client.sources.instances(settings)) {
      const kind = this.client.sources.kind(instance.id);
      const running = this.watchers.get(instance.id);
      if (!kind?.watch || !instance.enabled) {
        if (running) { running.controller.abort(); this.watchers.delete(instance.id); }
        // Only a Source that is off says "Off": a kind with no watch loop (one that receives messages another way) keeps
        // the entry its own check writes, which syncSources used to overwrite with "Off" on every pass.
        if (kind && !instance.enabled) for (const entry of this.client.sources.healthEntries(kind.health).values()) entry.set({ state: "paused", detail: "Off" });
        continue;
      }
      if (running) continue;
      const controller = new AbortController();
      const context = sourceContextOf(this.deps(), kind);
      const done = kind.watch(context, controller.signal).catch((error: unknown) => {
        this.log(`superagent ${kind.kind} source stopped: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.watchers.set(instance.id, { controller, done });
    }
  }
  private restartSources(): void {
    for (const watcher of this.watchers.values()) watcher.controller.abort();
    this.watchers.clear();
    this.syncSources(this.client.settings());
  }

  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers.values()) watcher.controller.abort();
    this.botCommands.close();
    await Promise.allSettled([...this.watchers.values()].map((watcher) => watcher.done));
    await this.remote?.close();
    await this.executor.shutdown();
    await this.client.effects.drain();
    this.client.store.delete(KV.host.owner);
    this.client.close();
    this.release?.();
    this.release = undefined;
  }
}
