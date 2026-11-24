/**
 * The capability directory as the main session uses it: the `swarm_directory` prompt block, and the SwarmDirectory,
 * SwarmRead and Dispatch tools. A session reads the directory the host wrote while it is fresh, with its own MCP servers
 * in the tool section, and otherwise builds one itself; either is held for `HOLD_MS`. SwarmRead runs one of the reads a
 * paired node may run here (`PEER_READS`) as the local operator, the same path `/mesh/v1/command` takes. Dispatch files
 * work as `swarm superagent request [--on <node>] [--harness <id>]` does from this terminal, so the host gives the ticket
 * the terminal actor's mandate; it only refuses up front what the directory says would fail.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { McpServerRecord } from "../extensions/mcp.js";
import { PEER_READS } from "../mesh/tickets.js";
import type { CommandName } from "../superagent/command-table.js";
import type { SuperagentClient } from "../superagent/client.js";
import type { requestOn as RequestOn } from "../superagent/placement.js";
import type { SwarmDirectoryAction, SwarmDispatchAction, SwarmReadAction, SwarmToolsContext, ToolResult } from "../tools/types.js";
import { lendersChange, PART_TTL_MS, placeableNodes, placementProblem, pullingNodes, withMcpServers } from "./build.js";
import type { ReadOptions, SignIns } from "./read.js";
import { mainSummary } from "./render.js";
import { DIRECTORY_SCHEMA, type Directory, type DirectorySection, type PeerEntry } from "./types.js";

/** How long a session holds a directory before it reads one again: as long as the pass over the paired nodes holds. */
export const HOLD_MS = PART_TTL_MS.mesh;
/** A SwarmDirectory refresh reads the nodes, harnesses and Sources again at most this often; one sooner gets the held directory. */
export const REFRESH_MS = 10_000;

export interface SessionDirectoryOptions {
  /** The superagent state directory, whose host's directory, tickets and settings are read; the default one when absent. */
  stateDir?: string;
  home?: string;
  /** This process's MCP servers, which the tool section lists in place of the host's. */
  mcp?: () => readonly McpServerRecord[];
  /**
   * Loads this process's borrowed MCP servers again, and only those (`CapabilityPlane.refreshBorrowedMcp`). Absent where
   * no servers are borrowed, such as under a strict MCP config.
   */
  refreshMcp?: () => Promise<unknown>;
  now?: () => number;
  /** The directory the host wrote, while it is fresh; read from the superagent store by default. */
  written?: () => Promise<Directory | undefined>;
  /**
   * The sign-in checks this node's host or mesh node ran last, from the directory it wrote however old, which a directory
   * built here reuses while they hold; read from the superagent store by default.
   */
  signIns?: () => Promise<SignIns | undefined>;
  /** Builds a directory in this process; `readDirectory` by default. */
  build?: (options: ReadOptions) => Promise<Directory>;
  /** Files a request whose worker runs on a paired node; `requestOn` by default. */
  requestOn?: typeof RequestOn;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The directory a session sees, held for `HOLD_MS`. The prompt block never waits for a read: it gets the held directory,
 * which is read again in the background once it is old, and on a session's first turn only the host's written one, else
 * a note that it is being read. Reading it also loads borrowed MCP servers again once the lenders changed in two directories.
 */
export class SessionDirectory {
  private held?: { dir: Directory; at: number };
  private loading?: Promise<Directory>;
  /** Why the last read failed, until one succeeds. */
  private failed?: string;
  private refreshedAt?: number;
  /** The lenders the borrowed MCP servers were last loaded again for, so one change loads them once. */
  private lenders?: string;
  /**
   * A change of the lenders seen by one read, and the time of the directory it was seen in, which a newer directory must
   * show too before they load again: a node that flaps loads nothing.
   */
  private seen?: { change: string; at: string };
  private readonly now: () => number;

  constructor(private readonly options: SessionDirectoryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The held directory while it is young; with `refresh`, one read again now, at most once per `REFRESH_MS`. */
  async current(options: { refresh?: boolean } = {}): Promise<Directory> {
    const now = this.now();
    if (options.refresh) {
      if (this.held && this.refreshedAt !== undefined && now - this.refreshedAt < REFRESH_MS) return this.held.dir;
      this.refreshedAt = now;
      return this.load(true);
    }
    if (this.held && now - this.held.at < HOLD_MS) return this.held.dir;
    return this.load(false);
  }

  /**
   * The directory for the prompt block, without waiting for a read of the paired nodes or harnesses: the held one, read
   * again in the background once it is old; with none held, the host's written one, else none while a read starts.
   */
  async glance(): Promise<{ dir?: Directory; failed?: string }> {
    if (!this.held) {
      const written = await (this.options.written ?? (() => this.writtenByHost()))().catch(() => undefined);
      if (written) this.hold(written);
    }
    if (!this.held || this.now() - this.held.at >= HOLD_MS) this.load(false).catch(() => {});
    return this.held ? { dir: this.held.dir } : { ...(this.failed ? { failed: this.failed } : {}) };
  }

  private hold(found: Directory): Directory {
    const mcp = this.options.mcp;
    const dir = mcp ? withMcpServers(found, mcp()) : found;
    if (mcp) this.syncLenders(dir, mcp());
    this.held = { dir, at: this.now() };
    this.failed = undefined;
    return dir;
  }

  private load(refresh: boolean): Promise<Directory> {
    this.loading ??= (async () => {
      const mcp = this.options.mcp;
      const written = refresh ? undefined : await (this.options.written ?? (() => this.writtenByHost()))();
      if (written) return this.hold(written);
      const signIns = await (this.options.signIns ?? (() => this.signInsByHost()))().catch(() => undefined);
      return this.hold(await (this.options.build ?? (async (read) => (await import("./read.js")).readDirectory(read)))({
        ...(this.options.stateDir ? { stateDir: this.options.stateDir } : {}), ...(this.options.home ? { home: this.options.home } : {}),
        ...(mcp ? { mcp: mcp() } : {}), ...(signIns ? { signIns } : {}) }));
    })().catch((error: unknown) => { this.failed = message(error); throw error; }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  /**
   * Loads the borrowed MCP servers again, in the background, once a change of the lenders has held for two directories,
   * and once only for each change; a change that ends, such as a lender that went offline again, is forgotten.
   */
  private syncLenders(dir: Directory, servers: readonly McpServerRecord[]): void {
    const change = this.options.refreshMcp ? lendersChange(dir, servers) : undefined;
    if (!change) { this.lenders = this.seen = undefined; return; }
    if (change === this.lenders) return;
    if (change !== this.seen?.change) { this.seen = { change, at: dir.at }; return; }
    // The host's written directory is read again until it writes the next one: the same one twice is one look, not two.
    if (dir.at === this.seen.at) return;
    this.lenders = change;
    this.seen = undefined;
    this.options.refreshMcp!().catch(() => {});
  }

  /** This node's last sign-in checks, from the directory its host wrote however old, while they hold. */
  private async signInsByHost(): Promise<SignIns | undefined> {
    const stateDir = await this.stateDir();
    if (!existsSync(stateDir)) return undefined;
    const [{ SuperagentClient }, { KV }, { signInsOf }] = await Promise.all([import("../superagent/client.js"), import("../superagent/kv.js"), import("./read.js")]);
    const client = new SuperagentClient({ stateDir });
    try {
      const written = client.store.get(KV.host.directory);
      return written?.schema === DIRECTORY_SCHEMA ? signInsOf(written) : undefined;
    } finally {
      client.close();
    }
  }

  private async writtenByHost(): Promise<Directory | undefined> {
    const stateDir = await this.stateDir();
    if (!existsSync(stateDir)) return undefined;
    const [{ SuperagentClient }, { freshDirectory }] = await Promise.all([import("../superagent/client.js"), import("./read.js")]);
    const client = new SuperagentClient({ stateDir });
    try { return freshDirectory(client.store, this.now()); } finally { client.close(); }
  }

  async stateDir(): Promise<string> {
    return this.options.stateDir ?? (await import("../superagent/settings.js")).superagentStateDir();
  }

  /**
   * Opens the superagent state, as `swarm superagent` does from a terminal, for one use. Its deployment is the machine
   * alone: resolving the Sources' accounts would launch their CLIs, and the reads and requests here use none of them.
   */
  async withClient<T>(use: (client: SuperagentClient) => T | Promise<T>): Promise<T> {
    const [{ SuperagentClient }, { defaultMachine }] = await Promise.all([import("../superagent/client.js"), import("../superagent/setup.js")]);
    const stateDir = await this.stateDir();
    const deployment = { ...defaultMachine(stateDir), repository: "" };
    const client = new SuperagentClient({ stateDir, deployment: () => deployment });
    try { return await use(client); } finally { client.close(); }
  }
}

/** One section of the directory, with when it was read and what of it is stale. */
function section(dir: Directory, name: DirectorySection): Record<string, unknown> {
  const stale = dir.stale.filter((item) => item.section === name);
  const body = name === "nodes" ? { here: dir.here, peers: dir.peers } : { [name]: dir[name] };
  return { at: dir.at, ...body, ...(stale.length ? { stale } : {}) };
}

function overview(dir: Directory): string {
  const online = dir.peers.filter((peer) => peer.online).length;
  const ready = dir.harnesses.filter((harness) => harness.runsOn.length).length;
  return `Swarm directory at ${dir.at}: ${dir.peers.length} paired node${dir.peers.length === 1 ? "" : "s"} (${online} online), `
    + `${ready} of ${dir.harnesses.length} harnesses ready${dir.stale.length ? `; stale: ${[...new Set(dir.stale.map((item) => item.section))].join(", ")}` : ""}.`;
}

/** The main session's swarm tools over `directory`, and the prompt block (`summary`). */
export class SessionSwarmTools implements SwarmToolsContext {
  constructor(readonly source: SessionDirectory, private readonly fileOn?: typeof RequestOn) {}

  /** The `swarm_directory` prompt block, which never waits for the paired nodes; a directory that cannot be read says so instead. */
  async summary(): Promise<string> {
    const { dir, failed } = await this.source.glance();
    if (dir) return mainSummary(dir);
    return failed ? `The swarm directory could not be read: ${failed}` : "The swarm directory is being read: call SwarmDirectory to wait for it.";
  }

  async directory(action: SwarmDirectoryAction): Promise<ToolResult> {
    const dir = await this.source.current({ refresh: action.refresh === true });
    const body = action.section ? section(dir, action.section) : dir;
    return { action: "swarm.directory", status: "success", summary: overview(dir), content: JSON.stringify(body, null, 2), data: body };
  }

  async read(action: SwarmReadAction): Promise<ToolResult> {
    if (!(PEER_READS as readonly string[]).includes(action.name)) {
      throw new Error(`SwarmRead runs only the read commands ${PEER_READS.join(", ")}, not ${action.name}`);
    }
    const args = action.args ?? [];
    const line = `/${action.name}${args.length ? ` ${args.join(" ")}` : ""}`;
    if (!existsSync(await this.source.stateDir())) {
      const host = (await this.source.current()).here.host;
      return { action: "swarm.read", status: "success", summary: `No superagent state on this device, so ${line} has nothing to read: host ${host}.`,
        content: `host: ${host}\nStart a host with \`swarm superagent run\`, or \`swarm node run\` on a mesh node.`, data: { host } };
    }
    const [{ BotCommands }, { KV }, { localOperator, localTrigger }] = await Promise.all([
      import("../superagent/bot-commands.js"), import("../superagent/kv.js"), import("../superagent/sources/local.js")]);
    const text = await this.source.withClient(async (client) => {
      const written = client.store.get(KV.host.devices);
      const commands = new BotCommands(client, written ? { devices: async () => written.devices } : {});
      try {
        const trigger = localTrigger({ id: `swarm-read-${randomUUID()}`, text: line, actor: localOperator() });
        return await commands.commandText(trigger, action.name as CommandName, args);
      } finally {
        commands.close();
      }
    });
    return { action: "swarm.read", status: "success", summary: `${line} answered${text ? "" : " nothing"}.`, content: text ?? "", data: { command: line } };
  }

  async dispatch(action: SwarmDispatchAction): Promise<ToolResult> {
    const dir = await this.source.current();
    const here = action.on === "here" || action.on === dir.here.name;
    // The ticket runs on the harness named, else on the default one, which wherever it runs must run as well.
    const runsOn = action.harness ?? dir.harnesses.find((item) => item.isDefault)?.id;
    const harness = runsOn ? dir.harnesses.find((item) => item.id === runsOn) : undefined;
    const named = action.harness ?? `the default harness ${runsOn}`;
    // Installed here with a sign-in never checked, as when no host checked in the last 20 minutes: not ready, but no known
    // problem either, so work that may run here is filed and the host checks the sign-in when it runs it.
    const unchecked = (!action.on || here) && !!harness && !harness.runsOn.includes("here") && !!dir.here.unchecked?.includes(harness.id);
    let node: PeerEntry | undefined;
    let onPeers: string[] = [];
    let pullers: string[] = [];
    if (action.on && !here) {
      const problem = placementProblem(dir, action.on, runsOn ? { harness: runsOn } : {});
      if (problem) throw new Error(`Dispatch refused: ${problem}. SwarmDirectory section nodes lists where work can go.`);
      node = dir.peers.find((item) => item.name === action.on || item.id === action.on)!;
    } else if (harness && !harness.runsOn.includes("here") && !unchecked) {
      // With no node named, the host puts work on a harness this node lacks on a paired node that runs it, takes work put
      // on it and has a free worker (`fittest`, mesh/work.ts); with none free, it waits for one that pulls such work; it
      // runs any other here, where that harness fails.
      onPeers = here ? [] : placeableNodes(dir, { harness: harness.id }, { free: true });
      pullers = here || onPeers.length ? [] : pullingNodes(dir, { harness: harness.id });
      if (!onPeers.length && !pullers.length) {
        const why = harness.problems.map((item) => `${item.node}: ${item.problem}`).join("; ");
        const elsewhere = harness.runsOn.filter((item) => item !== "here");
        const full = here ? [] : placeableNodes(dir, { harness: harness.id });
        const where = here ? "not here now" : full.length ? `only on ${full.join(", ")}, where no worker is free now: name the node as on to wait for one`
          : elsewhere.length ? `only on ${elsewhere.join(", ")}, where work cannot be placed now` : "on no node now";
        throw new Error(`Dispatch refused: ${named} runs ${where}${why ? ` (${why})` : ""}`);
      }
    }
    // Work for a paired node needs a host that places work on paired nodes: a mesh node's. Any other runs it here.
    // Pullers are asked only when no node is free, so the work is for one list of the two at most.
    const peers = [...onPeers, ...pullers];
    // A harness unchecked here may turn out signed out when the host checks it; a mesh node's host then puts the work on a
    // paired node that runs it, so name those, and the host that can.
    const alsoOn = unchecked && !here ? placeableNodes(dir, { harness: harness!.id }, { free: true }) : [];
    const forPeer = node ? `the work is for ${node.name}` : peers.length ? `${named} runs only on ${peers.join(", ")}` : undefined;
    const options = action.harness ? { harness: action.harness } : {};
    const [{ requestOn, updatePlacement }, { hostStatus }] = await Promise.all([import("../superagent/placement.js"), import("../superagent/views.js")]);
    return this.source.withClient((client) => {
      const status = hostStatus(client);
      if (forPeer && status.running && !status.health.mesh) {
        throw new Error(`Dispatch refused: ${forPeer}, but the host here is not a mesh node, so it runs every worker itself: run it as \`swarm node run\` instead.`);
      }
      let filed: { triggerId: string };
      if (node) {
        filed = (this.fileOn ?? requestOn)(client, action.text, { id: node.id, name: node.name }, action.harness);
      } else if (here) {
        // Pinned here, as `swarm superagent place <ticket> here` pins one: the host does not move its worker to a paired node.
        filed = client.store.atomic(() => {
          const request = client.request(action.text, undefined, options);
          updatePlacement(client, request.triggerId, { on: "here" });
          return request;
        });
      } else {
        filed = client.request(action.text, undefined, options);
      }
      const on = node ? node.name : here ? "here" : undefined;
      const hint = !status.running ? (forPeer || alsoOn.length ? " No host runs yet: start this device's node with `swarm node run`."
        : " No host runs yet: start one with `swarm superagent run`, or `swarm node run` on a mesh node.")
        : node?.grant.received === "unknown" ? ` ${node.name} does not say its grant to this node, as an older Swarm does not, so it may refuse the work.` : "";
      // What the work waits for that the directory cannot vouch for now.
      const note = unchecked ? ` The sign-in of ${named} here was not checked: the host checks it when it runs the work${alsoOn.length ? `, and a mesh node's host puts it on ${alsoOn.join(" or ")} if it does not run here` : ""}.`
        : pullers.length ? ` It waits for ${pullers.join(" or ")} to pull it: no worker is free there now.` : "";
      const short = filed.triggerId.slice(0, 8);
      return { action: "swarm.dispatch", status: "success",
        summary: `Filed request ${short}; its worker runs${action.harness ? ` on ${action.harness}` : ""}${on === "here" ? " here" : on ? ` on ${on}` : ""}.${note}${hint}`,
        content: `Filed request ${short} as this terminal's operator.${note}${hint} Watch it with SwarmRead tickets.`,
        data: { triggerId: filed.triggerId, ...(on ? { on } : {}), ...(action.harness ? { harness: action.harness } : {}) } };
    });
  }
}

/** The main session's swarm tools, reading the directory with `options`. */
export const sessionSwarmTools = (options: SessionDirectoryOptions = {}): SessionSwarmTools =>
  new SessionSwarmTools(new SessionDirectory(options), options.requestOn);
