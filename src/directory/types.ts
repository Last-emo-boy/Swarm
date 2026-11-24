/**
 * The capability directory: one plain-data snapshot of who can do what right now (this node and its paired nodes, the
 * agent harnesses, tool servers, Sources and providers, and commands). The superagent host writes it to the store
 * (`KV.host.directory`); the main session, the router and ticket workers each read it through a renderer of their own
 * (render.ts). It only says which existing path will succeed: grants, leases, the capability broker, the ticket's
 * mandate and the host's placement still decide every action.
 */
import type { CapabilityDirectoryHealthState as State } from "../extensions/capability-directory.js";
import type { Grant, MeshSurface } from "../mesh/surfaces.js";

export const DIRECTORY_SCHEMA = "swarm.directory.v1";

export interface Directory {
  schema: typeof DIRECTORY_SCHEMA;
  at: string;
  /**
   * `offersWork` is false when this node keeps its own waiting work from paired nodes that pull (`swarm mesh offer off`);
   * absent, it hands that work to them, as `pull.offer` does by default.
   */
  here: NodeEntry & { host: "running" | "stopped" | "none"; offersWork?: false };
  peers: PeerEntry[];
  harnesses: HarnessEntry[];
  /** Local MCP servers, borrowed (lent) servers and LSP servers. */
  tools: ToolEntry[];
  /** Superagent Sources, setup, settings, workers and model providers. */
  sources: SourceEntry[];
  commands: CommandEntry[];
  /** Sections that could not be read or are older than their TTL, with the reason. */
  stale: { section: DirectorySection; why: string }[];
  /**
   * When this node's harness sign-ins were checked, which can be long before `at`, so a reader that reuses the checks ages
   * them from when they ran; absent when they were not checked, and in directories from before the field.
   */
  signInsAt?: string;
}

export type DirectorySection = "nodes" | "harnesses" | "tools" | "sources" | "commands";

/** How many ticket workers a node runs at once, how many run and wait now, and how many are free. */
export interface WorkerCount { slots: number; running: number; queued: number; free: number }

export interface NodeEntry {
  id: string;
  name: string;
  online: boolean;
  state: State;
  os?: string;
  arch?: string;
  version?: string;
  protocol?: number;
  /** How its Swarm differs from this one, as `versionMismatch` says it. */
  mismatch?: string;
  /** What kind of machine it is: its OS, `docker`, `gpu`. */
  machine: string[];
  /** The harnesses installed and signed in there. */
  harnesses: string[];
  /**
   * The harnesses installed there whose sign-in was never checked, so not in `harnesses` and not ready: work may still go
   * on one, as the host checks its sign-in when it runs the work. Absent when every install was checked.
   */
  unchecked?: string[];
  workers?: WorkerCount;
  takesWork: boolean;
  /** The repositories whose waiting work it pulls from paired nodes; [] pulls any. Absent when it pulls none. */
  pulls?: string[];
  repository?: string;
  /**
   * The folders it lends a shell and file access in, and the lent tools its grant to this node lets this node call, by
   * their exact `mcp__<node>__<tool>` names: every one it lends while that grant is unknown.
   */
  lends?: { shell?: string[]; files?: string[]; tools: string[] };
}

/** The surfaces a received grant is read for: what this node may ask of that one beyond keeping the swarm together. */
export const MAY_THERE: readonly MeshSurface[] = ["tickets.submit", "work.offer", "lend.shell", "lend.files.read", "lend.files.write", "commands.read"];

export interface PeerEntry extends NodeEntry {
  /**
   * `given` is this node's grant to the peer; `received` the peer's to this node, unknown on a peer from before the field
   * and when its card says one this version cannot read.
   */
  grant: { given: Grant; received: Grant | "unknown" };
  /** The surfaces of `MAY_THERE` that `received` reaches on that node now. */
  mayThere: MeshSurface[];
  ms?: number;
  error?: string;
}

export interface HarnessEntry {
  id: string;
  kind: string;
  isDefault: boolean;
  /** "here" and the names of the paired nodes that run it now. */
  runsOn: string[];
  /** Why it does not run on a node: not installed, signed out, a key not set, or a check that failed. */
  problems: { node: string; problem: string }[];
  /** Whether Swarm can keep a turn on it read-only, which a read-only ticket needs. */
  readOnly: boolean;
}

export interface ToolEntry {
  id: string;
  kind: "mcp" | "lent" | "lsp";
  status: "connected" | "pending" | "failed" | "disabled";
  tools: number;
  /** The paired node a lent server is borrowed from. */
  via?: string;
  lastError?: string;
}

export interface SourceEntry { name: string; state: "starting" | "ready" | "paused" | "error"; detail: string }

export type CommandActor = "main" | "router" | "worker" | "peer" | "person";

export interface CommandEntry {
  name: string;
  effect: "read" | "write";
  about: string;
  /** The exact invocation: a chat command such as `/status`, or a command line such as `swarm mesh grant <peer> <grant>`. */
  how: string;
  who: CommandActor[];
}
