/**
 * The readers of the capability directory's parts (build.ts), one per part, and where a built directory is kept. The
 * superagent host writes one to the store every `DIRECTORY_MS` (`KV.host.directory`); a process that finds it fresh
 * reads it and never dials a peer, and one that finds none builds its own with `readDirectory`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerRecord } from "../extensions/mcp.js";
import type { PeerHealth } from "../mesh/client.js";
import { grantOf, meshHome, meshPeers, readMesh, type MeshNode } from "../mesh/state.js";
import type { Grant } from "../mesh/surfaces.js";
import type { SuperagentClient } from "../superagent/client.js";
import type { Devices, Workers } from "../superagent/devices.js";
import { HARNESS_KINDS, harnessIds, harnessProfiles, harnessStatus, readOnlyProblem } from "../superagent/harness.js";
import type { Health } from "../superagent/health.js";
import { KV } from "../superagent/kv.js";
import type { Settings } from "../superagent/settings.js";
import { buildDirectory, PART_TTL_MS, type DirectoryParts, type HereFacts } from "./build.js";
import { DIRECTORY_SCHEMA, type Directory, type WorkerCount } from "./types.js";

/** How often the host writes the directory, and how old a written one may grow before a reader builds its own. */
export const DIRECTORY_MS = 60_000;
export const DIRECTORY_FRESH_MS = 2 * DIRECTORY_MS;

/** The directory the host wrote, while it is fresh; undefined when none was written, it is old, or it is of another schema. */
export function freshDirectory(store: Pick<SuperagentClient["store"], "get">, now = Date.now()): Directory | undefined {
  const written = store.get(KV.host.directory);
  if (!written || written.schema !== DIRECTORY_SCHEMA || now - Date.parse(written.at) > DIRECTORY_FRESH_MS) return undefined;
  return written;
}

/** One pass over every paired node's card; none on a device that never joined a mesh, so no mesh state is created. */
export async function readPeers(home = meshHome(), timeoutMs = 3000): Promise<PeerHealth[]> {
  if (!meshPeers(home).length) return [];
  const { peerHealth } = await import("../mesh/client.js");
  return peerHealth(home, timeoutMs);
}

/** The mesh part from a pass made at `at`, with this node's grant to each peer. */
export function meshPart(pass: readonly PeerHealth[], at: string, home = meshHome()): DirectoryParts["mesh"] {
  const given: Record<string, Grant> = {};
  for (const peer of meshPeers(home)) given[peer.id] = grantOf(peer, home);
  return { at, peers: pass, given };
}

/** The harness profiles of `executor`, which is default, and whether Swarm keeps each read-only; `signIn` says whether sign-ins were checked at `at`. */
export function harnessPart(executor: Settings["executor"], at: string, signIn: boolean): DirectoryParts["harnesses"] {
  const profiles = Object.entries(harnessProfiles(executor.harnesses)).map(([id, profile]) =>
    ({ id, kind: profile.kind, readOnly: readOnlyProblem({ id, kind: HARNESS_KINDS[profile.kind], args: profile.args }) === undefined }));
  return { at, signIn, default: executor.harness, profiles };
}

/**
 * Which harness profiles run on this machine and why the others do not. Without `signIn` only installs and keys are
 * checked, which starts no harness process; with it each harness's sign-in status command runs, as `swarm harness check`.
 */
export async function localHarnesses(executor: Settings["executor"], where: string, options: { signIn: boolean; base?: NodeJS.ProcessEnv }):
  Promise<{ harnesses: string[]; problems: Record<string, string> }> {
  const statuses = await Promise.all(harnessIds(executor.harnesses).map((id) =>
    harnessStatus(id, executor.harnesses, where, { signIn: options.signIn, ...(options.base ? { base: options.base } : {}) })
      .catch((error: unknown) => ({ id, problem: String(error) }))));
  return {
    harnesses: statuses.flatMap((status) => status.problem ? [] : [status.id]),
    problems: Object.fromEntries(statuses.flatMap((status) => status.problem ? [[status.id, status.problem]] : []))
  };
}

/** The ticket workers of `workers` as one count, VM slots here and in the cluster together. */
export function workerCount(workers: Workers, queued: number): WorkerCount {
  const slots = workers.isolation === "process" ? [workers.slots] : [workers.local, ...workers.cluster ? [workers.cluster] : []];
  const sum = (field: "total" | "busy" | "free") => slots.reduce((total, slot) => total + slot[field], 0);
  return { slots: sum("total"), running: sum("busy"), queued, free: sum("free") };
}

/** This node's facts from its mesh state, the host's settings and devices, and the harness checks that ran here. */
export function hereFacts(input: { node?: MeshNode; settings: Settings; devices: Devices; queued: number; host: HereFacts["host"];
  harnessProblems?: Record<string, string>; own: { protocol: number; version: string; commit?: string } }): HereFacts {
  const { node, settings, devices } = input;
  const github = settings.sources.github;
  const repository = github?.enabled ? (github.config as { repository?: string }).repository : undefined;
  return {
    id: node?.id ?? "here", name: node?.name ?? devices.here.name ?? "here", host: input.host,
    os: process.platform, arch: process.arch, version: input.own.commit ? `${input.own.version} ${input.own.commit}` : input.own.version, protocol: input.own.protocol,
    machine: devices.here.machine, harnesses: devices.here.harnesses,
    ...(input.harnessProblems && Object.keys(input.harnessProblems).length ? { harnessProblems: input.harnessProblems } : {}),
    workers: workerCount(devices.workers, input.queued),
    // A node that runs its tickets in VMs takes no work put on it, as its card tells its peers.
    takesWork: settings.executor.isolation !== "vm",
    ...(node?.pull.enabled ? { pulls: node.pull.repositories } : {}),
    ...(repository ? { repository } : {}),
    ...(node && Object.keys(node.lend).length ? { lend: node.lend } : {})
  };
}

/** The model providers with a key, and the primary one: names and where each key comes from, as `swarm auth status` says, never a value. */
export async function readProviders(): Promise<NonNullable<DirectoryParts["providers"]>> {
  const { loadSwarmConfig, loadSwarmSettings } = await import("../config/settings.js");
  const config = loadSwarmConfig();
  const settings = loadSwarmSettings();
  return Object.values(settings.providers).flatMap((provider) => {
    const source = config.providerApiKeys[provider.id] ? "the config file" : provider.apiKeyEnv && process.env[provider.apiKeyEnv] ? provider.apiKeyEnv : undefined;
    const primary = provider.id === config.primaryProvider;
    return source || primary ? [{ id: provider.id, primary, configured: !!source, source: source ?? "nowhere" }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export interface ReadOptions {
  /** The superagent state directory; its host's health, settings and workers are read when it exists. */
  stateDir?: string;
  home?: string;
  timeoutMs?: number;
  /** Run each harness's sign-in check, which starts harness processes; off, only installs and keys are checked. */
  signIn?: boolean;
  /** The environment harness checks read keys and PATH from. */
  base?: NodeJS.ProcessEnv;
  /** This process's MCP servers, when it runs any. */
  mcp?: readonly McpServerRecord[];
  /** The machine's abilities (its OS, docker, gpu); detected when absent. */
  machine?: readonly string[];
  /**
   * The sign-in checks run here last, when no new ones run (`signIn` off): a harness installed now counts as running here
   * only when that check found it signed in. Without them, an installed harness whose sign-in was never checked runs
   * nowhere in the directory, so no agent picks one that fails at its sign-in.
   */
  signIns?: SignIns;
  now?: () => Date;
}

/** The harness sign-in checks of one node at `at`: the profiles that ran there, and why each other one did not. */
export interface SignIns { at: string; harnesses: readonly string[]; problems: Readonly<Record<string, string>> }

/** This node's sign-in checks as `dir` holds them, when its harnesses were checked and not too long ago. */
export function signInsOf(dir: Directory): SignIns | undefined {
  if (dir.stale.some((item) => item.section === "harnesses")) return undefined;
  const problems = Object.fromEntries(dir.harnesses.flatMap((harness) => harness.problems.filter((item) => item.node === dir.here.name).map((item) => [harness.id, item.problem])));
  return { at: dir.at, harnesses: dir.here.harnesses, problems };
}

/**
 * Which harnesses run here: with ticket VMs the ones VMs run, which the host checks nothing for; else the installs found
 * now, narrowed to what the sign-in checks found, run now (`signIn`) or the last ones (`signIns`) while they hold.
 */
export async function hereHarnesses(executor: Settings["executor"], where: string, at: string, options: ReadOptions):
  Promise<{ harnesses: string[]; problems: Record<string, string>; checkedAt?: string }> {
  if (executor.isolation === "vm") {
    const { vmHarnessIds } = await import("../superagent/vm/vm-work.js");
    return { harnesses: vmHarnessIds(executor.harnesses), problems: {}, checkedAt: at };
  }
  const last = options.signIns && Date.parse(at) - Date.parse(options.signIns.at) <= PART_TTL_MS.harnesses ? options.signIns : undefined;
  const checked = await localHarnesses(executor, where, { signIn: !!options.signIn, ...(options.base ? { base: options.base } : {}) });
  if (options.signIn) return { ...checked, checkedAt: at };
  const unchecked = (id: string) => last?.problems[id] ?? (last ? "not signed in when last checked" : "installed, but its sign-in was not checked: `swarm harness check` checks it");
  return {
    harnesses: checked.harnesses.filter((id) => last?.harnesses.includes(id)),
    problems: { ...checked.problems, ...Object.fromEntries(checked.harnesses.filter((id) => !last?.harnesses.includes(id)).map((id) => [id, unchecked(id)])) },
    ...(last ? { checkedAt: last.at } : {})
  };
}

/** This machine's abilities, detected once per process: detecting them spawns `nvidia-smi`, and a machine does not change kind while Swarm runs. */
let machineOnce: Promise<string[]> | undefined;

/** Builds the directory in this process, for a reader that found no fresh one: `swarm directory`, or a session with no host. */
export async function readDirectory(options: ReadOptions = {}): Promise<Directory> {
  const home = options.home ?? meshHome();
  const { superagentStateDir, readSettings, settingsPath } = await import("../superagent/settings.js");
  const { devicesOf } = await import("../superagent/devices.js");
  const { thisSwarm, detectAbilities } = await import("../mesh/card.js");
  const stateDir = options.stateDir ?? superagentStateDir();
  const own = thisSwarm();
  const [pass, machine, providers] = await Promise.all([
    readPeers(home, options.timeoutMs).then((peers) => ({ peers }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
    options.machine ? Promise.resolve([...options.machine]) : (machineOnce ??= detectAbilities().catch((error: unknown) => { machineOnce = undefined; throw error; })).then((found) => [...found]),
    readProviders()
  ]);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const where = settingsPath(stateDir);
  // A device that never joined a mesh has no node yet, and reading one would create it.
  const node = existsSync(join(home, "state.json")) ? readMesh(home).node : undefined;
  let host: HereFacts["host"] = "none";
  let health: { at: string; entries: Record<string, Health> } | undefined;
  let settings: Settings;
  let queued = 0;
  let running = 0;
  let store: Pick<SuperagentClient["store"], "get"> = { get: () => undefined };
  let close = (): void => {};
  if (existsSync(stateDir)) {
    const { SuperagentClient } = await import("../superagent/client.js");
    const { hostStatus } = await import("../superagent/views.js");
    const client = new SuperagentClient({ stateDir });
    close = () => client.close();
    const status = hostStatus(client);
    host = status.running ? "running" : "stopped";
    health = client.store.get(KV.host.health);
    settings = client.settings();
    queued = status.counts.queued;
    running = status.counts.working;
    store = client.store;
  } else {
    settings = readSettings(where).settings;
  }
  try {
    const checked = await hereHarnesses(settings.executor, where, at, options);
    const devices = devicesOf({ settings, store, running,
      view: { here: { name: node?.name ?? "here", abilities: [...machine, ...checked.harnesses.map((id) => `harness:${id}`)] }, peers: [] } });
    const here = hereFacts({ ...(node ? { node } : {}), settings, devices, queued, host, harnessProblems: checked.problems, own });
    return buildDirectory({
      at, here, own,
      mesh: "error" in pass ? pass : meshPart(pass.peers, at, home),
      harnesses: harnessPart(settings.executor, checked.checkedAt ?? at, checked.checkedAt !== undefined),
      ...(options.mcp ? { mcp: { servers: options.mcp } } : {}),
      ...(health ? { health } : {}),
      providers
    });
  } finally {
    close();
  }
}
