/**
 * The superagent host: the one Swarm process that carries out what the Engine queues (from dsh-superagent's app/runtime.ts).
 * It holds the state directory's lock, resolves the accounts, polls the Sources, runs the effects (model judgements, worker
 * launches and deliveries, replies), applies settings-file changes as Policy changes, and writes a health snapshot that
 * other Swarm processes show. `swarm superagent run` starts it; the TUI can start one when none runs.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { key, liveTicket, type Ticket } from "./core/index.js";
import { ModelAssessor, type Complete } from "./assessor.js";
import { BotCommands } from "./bot-commands.js";
import { ChatterRoom } from "./chatter.js";
import { GithubLinks, githubApp, linkKey, type Credential, type LinkView } from "./github-link.js";
import { SuperagentClient } from "./client.js";
import { writeEnvironment, verifyEnvironment, workerBin } from "./environment.js";
import { SwarmExecutor, type RemoteWork } from "./executor.js";
import { KV } from "./kv.js";
import { policyEffects } from "./policy.js";
import { policyVersion, superagentStateDir, type Settings } from "./settings.js";
import { SETUP_FIELDS, SetupError, commandProbe, defaultMachine, resolveFeishuBot, resolveGithub, type Deployment, type SetupProblem } from "./setup.js";
import { sourceContextOf, type SourceContextDeps } from "./sources/context.js";
import { sourceTrigger } from "./messages.js";
import { prunePatches } from "./ticket-tools.js";
import { sameName } from "./text.js";
import { ticketVariables, variableValues } from "./variables.js";

const PASS_MS = 2000;
/** How often the host deletes the patches it kept too long. */
const PRUNE_MS = 3_600_000;

export interface HostOptions {
  stateDir?: string;
  /** How a worker process starts: the Node binary and the Swarm entry point. */
  workerCommand: readonly string[];
  /** The model call behind routing and assessments. */
  complete: Complete;
  log?: (message: string) => void;
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

export class SuperagentHost {
  readonly stateDir: string;
  readonly client: SuperagentClient;
  private readonly executor: SwarmExecutor;
  private readonly assessor: ModelAssessor;
  private readonly botCommands: BotCommands;
  private readonly chatter: ChatterRoom;
  private readonly links: GithubLinks;
  private release?: () => void;
  private prunedAt = 0;
  private deployment?: Deployment;
  problem?: SetupProblem;
  /** Where tickets placed on paired nodes run; a mesh node sets it before it starts the host (src/mesh/work.ts). */
  remote?: RemoteWork;
  private timer?: NodeJS.Timeout;
  private closing = false;
  private passing = false;
  private appliedSetup = "";
  private readonly watchers = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: HostOptions) {
    this.stateDir = options.stateDir ?? superagentStateDir();
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.release = acquireLock(this.stateDir);
    try {
      this.client = new SuperagentClient({ stateDir: this.stateDir, deployment: () => this.deployment });
      this.links = new GithubLinks({ store: this.client.store, key: () => linkKey(this.stateDir), broken: (actor, link) => this.linkBroken(link) });
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
      this.assessor = new ModelAssessor({ client: this.client, complete: options.complete, configured: () => !!this.deployment });
      this.assessor.install();
      this.botCommands = new BotCommands(this.client, { links: this.links, log: this.log });
      this.chatter = new ChatterRoom({ client: this.client, complete: options.complete, configured: () => !!this.deployment?.feishu });
      this.chatter.install();
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
    await verifyEnvironment(deployment);
    this.deployment = deployment;
    this.appliedSetup = setupFields(settings);
  }

  async start(): Promise<void> {
    await this.setup().catch((error: unknown) => { this.log(`superagent setup failed: ${error instanceof Error ? error.message : String(error)}`); });
    const { store } = this.client;
    if (!store.get(KV.host.applied)) {
      const settings = this.client.settings();
      store.set(KV.host.applied, { policyVersion: policyVersion(settings), settings });
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
      this.client.engine.evaluateDue();
      if (!settings.paused) this.chatter.pass();
      this.client.effects.kick();
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

  /** Worker processes running here now. */
  runningWorkers(): number { return this.executor.running().length; }

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
  /** Starts the polling loop of every Source that is on and has one, and stops the loops of Sources switched off. */
  private syncSources(settings: Settings): void {
    for (const instance of this.client.sources.instances(settings)) {
      const kind = this.client.sources.kind(instance.id);
      const running = this.watchers.get(instance.id);
      if (!kind?.watch || !instance.enabled) {
        if (running) { running.controller.abort(); this.watchers.delete(instance.id); }
        // A Source that is off is healthy: it says so instead of staying "starting".
        if (kind) for (const entry of this.client.sources.healthEntries(kind.health).values()) entry.set({ state: "paused", detail: "Off" });
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
