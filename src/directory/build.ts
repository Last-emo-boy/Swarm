/**
 * `buildDirectory`: the capability directory from the parts its readers gathered (read.ts). Pure, sorted and
 * deterministic, so the same state renders byte for byte the same and a prompt that holds it stays cached.
 */
import type { McpServerRecord } from "../extensions/mcp.js";
import { mcpToolName } from "../extensions/mcp.js";
import type { NodeCard } from "../mesh/card.js";
import { versionMismatch } from "../mesh/card.js";
import type { PeerHealth } from "../mesh/client.js";
import { borrowedServerId } from "../mesh/borrow.js";
import { lentTools, TOOL_SURFACE } from "../mesh/lend.js";
import { DEFAULT_GRANT, type Lend } from "../mesh/state.js";
import { authorizes, GrantSchema, type Grant } from "../mesh/surfaces.js";
import { PEER_READS } from "../mesh/tickets.js";
import { COMMAND_TABLE } from "../superagent/command-table.js";
import { HARNESS_KINDS, harnessAbility } from "../superagent/harness.js";
import type { Health } from "../superagent/health.js";
import { PERSON_COMMANDS } from "./person-commands.js";
import { DIRECTORY_SCHEMA, MAY_THERE, type CommandEntry, type Directory, type DirectorySection, type HarnessEntry, type NodeEntry, type PeerEntry,
  type SourceEntry, type ToolEntry, type WorkerCount } from "./types.js";

/** How long each part holds before the directory reports it stale. */
export const PART_TTL_MS = {
  /** The pass over the paired nodes, as the host's mesh view (`MESH_VIEW_MS`). */
  mesh: 30_000,
  /**
   * Harness sign-in checks: twice a node's own interval (`HARNESS_CHECK_MS`), since a check is written once it ends and the
   * host's view of it may be half a minute old, so a node that checks on time is never reported stale.
   */
  harnesses: 2 * 10 * 60_000,
  /** The host's health board, which a running host rewrites on every pass. */
  sources: 60_000
} as const;

/** This node as its reader found it. `harnesses` are the ones that run here, `harnessProblems` why the others do not. */
export interface HereFacts {
  id: string;
  name: string;
  host: Directory["here"]["host"];
  os?: string;
  arch?: string;
  version?: string;
  protocol?: number;
  machine: readonly string[];
  harnesses: readonly string[];
  harnessProblems?: Readonly<Record<string, string>>;
  workers?: WorkerCount;
  takesWork: boolean;
  pulls?: readonly string[];
  repository?: string;
  lend?: Lend;
}

/** What `buildDirectory` takes; a part that could not be read carries why instead. */
export interface DirectoryParts {
  at: string;
  here: HereFacts;
  /** This Swarm, which each peer's card is compared with. */
  own: { protocol: number; version: string; commit?: string };
  /** One pass over the paired nodes, when it was made, and this node's grant to each, by peer id. */
  mesh: { at: string; peers: readonly PeerHealth[]; given: Readonly<Record<string, Grant>> } | { error: string };
  /** The harness profiles configured here, the default one, and whether their sign-ins were checked and when. */
  harnesses: { at: string; signIn: boolean; default: string | null; profiles: readonly { id: string; kind: string; readOnly: boolean }[] } | { error: string };
  /** This process's MCP servers; absent where none run, such as on the host, whose lent tools come from the cards. */
  mcp?: { servers: readonly McpServerRecord[] } | { error: string };
  /** The host's health board, when a host state exists. */
  health?: { at: string; entries: Readonly<Record<string, Health>> };
  /** The model providers with a key set, and the primary one whether or not it has one. Names only, never values. */
  providers?: readonly { id: string; primary: boolean; configured: boolean; source: string }[];
}

export { PERSON_COMMANDS } from "./person-commands.js";

const byName = <T extends { name: string; id?: string }>(a: T, b: T): number => a.name.localeCompare(b.name) || (a.id ?? "").localeCompare(b.id ?? "");
const sorted = (items: readonly string[]): string[] => [...new Set(items)].sort();
const HARNESS = harnessAbility("");
const failed = <T extends object>(part: T | { error: string } | undefined): part is { error: string } => !!part && "error" in part;
const age = (at: string, now: string): number => Date.parse(now) - Date.parse(at);

/**
 * A node's lends as a directory lists them: folders, and the exact names its tools go by under `serverId`, those only that
 * `received`, its grant to this node, lets this node call; all of them while that grant is unknown, as the lender decides.
 */
function lendsOf(lend: Lend | undefined, serverId: string, received: Grant | "unknown" = "unknown"): NodeEntry["lends"] {
  const tools = lentTools(lend);
  if (!tools.length) return undefined;
  const callable = received === "unknown" ? tools : tools.filter((tool) => { const surface = TOOL_SURFACE[tool]; return !!surface && authorizes(received, surface); });
  return { ...(lend?.shell ? { shell: [...lend.shell.roots] } : {}), ...(lend?.files ? { files: [...lend.files.roots] } : {}),
    tools: callable.map((tool) => mcpToolName(serverId, tool)).sort() };
}

function peerEntry(health: PeerHealth, given: Grant, serverId: string, own: DirectoryParts["own"]): PeerEntry {
  const card: NodeCard | undefined = health.card;
  // A card is the peer's word, unchecked: a grant this version cannot read, such as a newer Swarm's preset, is unknown,
  // as a missing one is.
  const parsed = GrantSchema.safeParse(card?.yourGrant);
  const received: Grant | "unknown" = parsed.success ? parsed.data : "unknown";
  const base = { id: health.peer.id, name: health.peer.name, grant: { given, received },
    mayThere: received === "unknown" ? [] : MAY_THERE.filter((surface) => authorizes(received, surface)) };
  if (!health.reachable || !card) {
    return { ...base, online: false, state: "offline", machine: [], harnesses: [], takesWork: false, ...(health.error ? { error: health.error } : {}) };
  }
  const mismatch = versionMismatch(card, own);
  const load = card.load;
  const lends = lendsOf(card.lend, serverId, received);
  return {
    ...base, online: true, state: mismatch ? "degraded" : load && load.slots > 0 && load.running >= load.slots ? "busy" : "available",
    os: card.os, arch: card.arch, version: card.commit ? `${card.version} ${card.commit}` : card.version, protocol: card.protocol ?? 1,
    ...(mismatch ? { mismatch } : {}),
    machine: sorted(card.abilities.filter((ability) => !ability.startsWith(HARNESS))),
    harnesses: sorted(card.abilities.filter((ability) => ability.startsWith(HARNESS)).map((ability) => ability.slice(HARNESS.length))),
    ...(load ? { workers: { slots: load.slots, running: load.running, queued: load.queued, free: Math.max(0, load.slots - load.running) } } : {}),
    // A node with no ticket host (`swarm node run --no-host`) lists no workers and serves no work offers.
    takesWork: card.takesWork !== false && !!load,
    ...(card.pull ? { pulls: sorted(card.pull.repositories) } : {}),
    ...(card.repository ? { repository: card.repository } : {}),
    ...(lends ? { lends } : {}),
    ...(health.ms !== undefined ? { ms: health.ms } : {})
  };
}

function hereEntry(here: HereFacts): Directory["here"] {
  const lends = lendsOf(here.lend, here.name);
  return {
    id: here.id, name: here.name, host: here.host, online: true,
    state: here.workers && here.workers.slots > 0 && here.workers.free === 0 ? "busy" : "available",
    ...(here.os ? { os: here.os } : {}), ...(here.arch ? { arch: here.arch } : {}),
    ...(here.version ? { version: here.version } : {}), ...(here.protocol !== undefined ? { protocol: here.protocol } : {}),
    machine: sorted(here.machine), harnesses: sorted(here.harnesses),
    ...(here.workers ? { workers: here.workers } : {}),
    takesWork: here.takesWork,
    ...(here.pulls ? { pulls: sorted(here.pulls) } : {}),
    ...(here.repository ? { repository: here.repository } : {}),
    ...(lends ? { lends } : {})
  };
}

function harnessEntries(parts: DirectoryParts, peers: readonly PeerEntry[], cards: ReadonlyMap<string, NodeCard>): HarnessEntry[] {
  const configured = failed(parts.harnesses) ? undefined : parts.harnesses;
  const ids = new Set<string>([...configured?.profiles.map((profile) => profile.id) ?? [], ...parts.here.harnesses]);
  for (const peer of peers) for (const id of [...peer.harnesses, ...Object.keys(cards.get(peer.id)?.harnessProblems ?? {})]) ids.add(id);
  return [...ids].sort().map((id): HarnessEntry => {
    const profile = configured?.profiles.find((item) => item.id === id);
    const onPeers = peers.filter((peer) => peer.online && peer.harnesses.includes(id)).map((peer) => peer.name).sort();
    const here = parts.here.harnesses.includes(id);
    const problems = [
      ...!here && parts.here.harnessProblems?.[id] ? [{ node: parts.here.name, problem: parts.here.harnessProblems[id]! }] : [],
      ...peers.flatMap((peer) => {
        const problem = peer.online && !peer.harnesses.includes(id) ? cards.get(peer.id)?.harnessProblems?.[id] : undefined;
        return problem ? [{ node: peer.name, problem }] : [];
      })
    ].sort((a, b) => a.node.localeCompare(b.node));
    return { id, kind: profile?.kind ?? (id in HARNESS_KINDS ? id : "unknown"), isDefault: configured?.default === id,
      runsOn: [...here ? ["here"] : [], ...onPeers], problems, readOnly: profile?.readOnly ?? false };
  });
}

/** The paired node a borrowed MCP server reaches, by its id; undefined for a server of this process's own. */
const lentFrom = (server: Pick<McpServerRecord, "url">): string | undefined =>
  server.url?.startsWith("swarm-mesh://") ? new URL(server.url).hostname : undefined;
const byTool = (a: ToolEntry, b: ToolEntry): number => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

/** A process's MCP servers as tool entries; a borrowed one names the paired node it comes from. */
function recordEntries(servers: readonly McpServerRecord[], peers: readonly PeerEntry[]): ToolEntry[] {
  const nameOf = new Map(peers.map((peer) => [peer.id, peer.name]));
  return servers.map((server): ToolEntry => {
    const from = lentFrom(server);
    return { id: server.id, kind: from ? "lent" : "mcp", status: server.status, tools: server.toolCount,
      ...(from ? { via: nameOf.get(from) ?? from } : {}), ...(server.lastError ? { lastError: server.lastError } : {}) };
  }).sort(byTool);
}

/** Tool servers: this process's MCP servers when it has them, else what the paired nodes that answered lend. */
function toolEntries(parts: DirectoryParts, peers: readonly PeerEntry[], serverIds: ReadonlyMap<string, string>): ToolEntry[] {
  if (parts.mcp && !failed(parts.mcp)) return recordEntries(parts.mcp.servers, peers);
  return peers.flatMap((peer): ToolEntry[] => peer.online && peer.lends
    ? [{ id: serverIds.get(peer.id) ?? peer.name, kind: "lent", status: "connected", tools: peer.lends.tools.length, via: peer.name }] : []).sort(byTool);
}

/**
 * `dir` with the tool servers of the process that reads it, such as a session reading the host's directory: the host runs
 * no MCP servers, so its tool section is what the paired nodes lend, not what this process can call.
 */
export const withMcpServers = (dir: Directory, servers: readonly McpServerRecord[]): Directory => ({ ...dir, tools: recordEntries(servers, dir.peers) });

/**
 * Whether the paired nodes that lend tools now differ from the ones this process borrows servers from, so its MCP servers
 * should be loaded again: a node that came online or began to lend after they loaded, or one that went offline or stopped.
 * Undefined when they agree or the nodes could not be read; otherwise a key naming both sets, the same while they stay.
 */
export function lendersChange(dir: Directory, servers: readonly McpServerRecord[]): string | undefined {
  if (dir.stale.some((item) => item.section === "nodes")) return undefined;
  const lending = dir.peers.filter((peer) => peer.online && peer.lends).map((peer) => peer.id).sort();
  const loaded = [...new Set(servers.flatMap((server) => lentFrom(server) ?? []))].sort();
  return lending.join(",") === loaded.join(",") ? undefined : `${lending.join(",")}|${loaded.join(",")}`;
}

function sourceEntries(parts: DirectoryParts): SourceEntry[] {
  const health = Object.entries(parts.health?.entries ?? {}).map(([name, entry]): SourceEntry => ({ name, state: entry.state, detail: entry.detail }));
  const providers = (parts.providers ?? []).flatMap((provider): SourceEntry[] => provider.configured
    ? [{ name: `provider:${provider.id}`, state: "ready", detail: `${provider.primary ? "primary; " : ""}key from ${provider.source}` }]
    : provider.primary ? [{ name: `provider:${provider.id}`, state: "error", detail: `primary, but no key is set: swarm auth set-key ${provider.id} <api-key>` }] : []);
  return [...health, ...providers].sort((a, b) => a.name.localeCompare(b.name));
}

/** Each harness kind's own sign-in, which a person runs in a terminal as the user Swarm runs as. */
const SIGN_INS: CommandEntry[] = Object.entries(HARNESS_KINDS).map(([id, kind]) =>
  ({ name: `sign in ${id}`, effect: "write", how: `${kind.program} ${kind.signedIn.login}`, about: `sign ${kind.label} in on this machine`, who: ["person"] }));

/** Every command, chat commands first in table order: who may run each, and how. Fixed by the code, so it never goes stale. */
export function commandEntries(): CommandEntry[] {
  const reads = new Set<string>(PEER_READS);
  const chat = COMMAND_TABLE.map((command): CommandEntry => ({
    name: command.name, effect: command.effect, about: command.about, how: `/${command.name}`,
    who: [...reads.has(command.name) ? ["main" as const] : [], ...command.router ? ["router" as const] : [], ...reads.has(command.name) ? ["peer" as const] : [], "person"]
  }));
  return [...chat, ...PERSON_COMMANDS.map(({ dispatcher: _dispatcher, subcommand: _subcommand, ...entry }): CommandEntry => ({ ...entry, who: ["person"] })), ...SIGN_INS];
}

/** The directory of `parts`, at `parts.at`; each part that failed or outlived its TTL is listed in `stale` with why. */
export function buildDirectory(parts: DirectoryParts): Directory {
  const stale: Directory["stale"] = [];
  const note = (section: DirectorySection, why: string) => stale.push({ section, why });
  let peers: PeerEntry[] = [];
  const cards = new Map<string, NodeCard>();
  const serverIds = new Map<string, string>();
  if (failed(parts.mesh)) note("nodes", `the paired nodes could not be read: ${parts.mesh.error}`);
  else {
    const mesh = parts.mesh;
    const all = mesh.peers.map((health) => health.peer);
    for (const health of mesh.peers) {
      serverIds.set(health.peer.id, borrowedServerId(health.peer, all));
      if (health.card) cards.set(health.peer.id, health.card);
    }
    peers = mesh.peers.map((health) => peerEntry(health, mesh.given[health.peer.id] ?? DEFAULT_GRANT, serverIds.get(health.peer.id)!, parts.own)).sort(byName);
    if (age(mesh.at, parts.at) > PART_TTL_MS.mesh) note("nodes", `the paired nodes were read over ${PART_TTL_MS.mesh / 1000} s before`);
  }
  if (failed(parts.harnesses)) note("harnesses", `the harness profiles could not be read: ${parts.harnesses.error}`);
  else if (!parts.harnesses.signIn) note("harnesses", "sign-ins here were not checked, only installs: `swarm harness check` checks them");
  else if (age(parts.harnesses.at, parts.at) > PART_TTL_MS.harnesses) note("harnesses", `sign-ins here were checked over ${PART_TTL_MS.harnesses / 60_000} min before`);
  if (failed(parts.mcp)) note("tools", `this process's MCP servers could not be read: ${parts.mcp.error}`);
  if (!parts.health) note("sources", "no superagent host state here: Sources are unknown");
  else if (parts.here.host !== "running") note("sources", "no host runs: its health is from when one last ran");
  else if (age(parts.health.at, parts.at) > PART_TTL_MS.sources) note("sources", `the host's health was written over ${PART_TTL_MS.sources / 1000} s before`);
  return {
    schema: DIRECTORY_SCHEMA,
    at: parts.at,
    here: hereEntry(parts.here),
    peers,
    harnesses: harnessEntries(parts, peers, cards),
    tools: toolEntries(parts, peers, serverIds),
    sources: sourceEntries(parts),
    commands: commandEntries(),
    stale,
    ...(!failed(parts.harnesses) && parts.harnesses.signIn ? { signInsAt: parts.harnesses.at } : {})
  };
}

/**
 * Why work cannot be placed on `on` now, or undefined when it can: a paired node must answer, take work put on it, have
 * what the work needs of its machine and the harness it runs on, and let this node offer it work (`work.offer`). `here`
 * is the node that owns the ticket, which takes its own work whenever it has what the work needs and runs its harness:
 * a worker pinned here is never moved to a node that has them. The host's placement and the node's grant still decide;
 * this only refuses up front what would fail.
 */
export function placementProblem(dir: Directory, on: string, work: { needs?: readonly string[]; harness?: string } = {}): string | undefined {
  if (on === "here" || on === dir.here.name) {
    const missing = (work.needs ?? []).filter((need) => !dir.here.machine.includes(need));
    if (missing.length) return `this node lacks ${missing.join(", ")}`;
    if (work.harness && !dir.here.harnesses.includes(work.harness)) {
      const problem = dir.harnesses.find((harness) => harness.id === work.harness)?.problems.find((item) => item.node === dir.here.name)?.problem;
      return `this node does not run ${work.harness}${problem ? `: ${problem}` : ""}`;
    }
    return undefined;
  }
  const named = dir.peers.filter((peer) => peer.name === on || peer.id === on);
  if (named.length > 1) return `${named.length} paired nodes are called ${on}: name it by its id`;
  const peer = named[0];
  if (!peer) return `No paired node is called ${on}: the paired nodes are ${dir.peers.map((item) => item.name).join(", ") || "none"}`;
  if (!peer.online) return `${peer.name} is offline`;
  if (!peer.workers) return `${peer.name} runs no ticket host, so it takes no work put on it`;
  if (!peer.takesWork) return `${peer.name} takes no work put on it`;
  // A peer whose grant is unknown, as on an older Swarm, may still take it: the host's offer tries it, and its grant decides.
  if (peer.grant.received !== "unknown" && !peer.mayThere.includes("work.offer")) return `${peer.name}'s grant to this node (${typeof peer.grant.received === "string" ? peer.grant.received : "scopes"}) does not allow work.offer`;
  const missing = (work.needs ?? []).filter((need) => !peer.machine.includes(need));
  if (missing.length) return `${peer.name} lacks ${missing.join(", ")}`;
  if (work.harness && !peer.harnesses.includes(work.harness)) {
    const problem = dir.harnesses.find((harness) => harness.id === work.harness)?.problems.find((item) => item.node === peer.name)?.problem;
    return `${peer.name} does not run ${work.harness}${problem ? `: ${problem}` : ""}`;
  }
  return undefined;
}

/** A node's worker slots left over by its running and waiting work, as the host's placement (`fittest`, mesh/work.ts) counts them. */
const freeSlots = (workers: WorkerCount | undefined): number => workers ? workers.slots - workers.running - workers.queued : 0;

/**
 * The paired nodes work can be placed on now, by name. With `free`, only those with a free slot: the host's placement of
 * work no node is named for passes a full node over, and runs the work here.
 */
export const placeableNodes = (dir: Directory, work: { needs?: readonly string[]; harness?: string } = {}, options: { free?: boolean } = {}): string[] =>
  dir.peers.filter((peer) => placementProblem(dir, peer.id, work) === undefined && (!options.free || freeSlots(peer.workers) > 0)).map((peer) => peer.name);
