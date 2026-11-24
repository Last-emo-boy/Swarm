/**
 * What each agent sees of the capability directory: the main session a short prompt block (`mainSummary`), the router a
 * card section (`routerCard`), a ticket's worker its `directory` tool's answer (`workerView`). Which nodes there are and
 * what each runs is for maintainers and owners (`seesNodes`); everyone else gets counts, as the devices card gives.
 * Nothing here carries a timestamp or a latency, so the same state renders the same text and a prompt holding it caches.
 */
import { placeableNodes } from "./build.js";
import type { CommandEntry, Directory, NodeEntry, PeerEntry, WorkerCount } from "./types.js";

/** About 300 tokens: the summary names what is ready and what is not; the SwarmDirectory tool has the rest. */
export const SUMMARY_CHARS = 1400;
const DETAIL_CHARS = 120;

const clip = (text: string, chars = DETAIL_CHARS): string => text.length > chars ? `${text.slice(0, chars - 3)}...` : text;
const free = (workers: WorkerCount | undefined): string => workers ? `${workers.free} of ${workers.slots} workers free${workers.queued ? `, ${workers.queued} queued` : ""}` : "workers unknown";
const grantText = (grant: PeerEntry["grant"]["received"]): string => grant === "unknown" ? "unknown" : typeof grant === "string" ? grant : `scopes ${grant.scopes.join(", ")}`;
/** The tools and Sources that are not ready, with why; ones a person switched off are not news. */
function notReady(dir: Directory): string[] {
  return [
    ...dir.tools.filter((tool) => tool.status === "failed" || tool.status === "pending")
      .map((tool) => `${tool.kind} ${tool.id}${tool.via ? ` (from ${tool.via})` : ""}: ${tool.status}${tool.lastError ? `, ${clip(tool.lastError)}` : ""}`),
    ...dir.sources.filter((source) => source.state === "error" || source.state === "starting")
      .map((source) => `${source.name}: ${source.state}${source.detail ? `, ${clip(source.detail)}` : ""}`)
  ];
}
const harnessProblems = (dir: Directory, node: string): Record<string, string> =>
  Object.fromEntries(dir.harnesses.flatMap((harness) => harness.problems.filter((item) => item.node === node).map((item) => [harness.id, clip(item.problem)])));
const readsFor = (dir: Directory, who: CommandEntry["who"][number]): CommandEntry[] =>
  dir.commands.filter((command) => command.effect === "read" && command.who.includes(who));

/** Each node's line is cut to this, so a node that runs much leaves the rest of the block room. */
const NODE_CHARS = 320;
/** A list on one of the summary's fixed lines names this many, then how many more, so the line stays short in a large swarm. */
const LISTED = 6;
const few = (items: readonly string[]): string => items.length > LISTED ? `${items.slice(0, LISTED).join(", ")}, +${items.length - LISTED} more` : items.join(", ");

/**
 * The main session's prompt block. What it chooses from comes first, always, each line short whatever the swarm's size:
 * this node, where work can be placed, the ready harnesses, what is not ready and stale, and the reads; then one line for
 * each node with its lent tools by their exact names, while the block has room.
 */
export function mainSummary(dir: Directory): string {
  const here = dir.here;
  const online = dir.peers.filter((peer) => peer.online);
  const offline = dir.peers.filter((peer) => !peer.online).map((peer) => peer.name);
  const node = (peer: PeerEntry): string => clip([
    `- ${peer.name}: ${free(peer.workers)}, ${peer.takesWork ? "takes work" : "takes no work"}`,
    ...peer.harnesses.length ? [`harnesses ${peer.harnesses.join(", ")}`] : [],
    `its grant to you ${grantText(peer.grant.received)}`,
    ...peer.lends?.tools.length ? [`lends ${peer.lends.tools.join(", ")}`] : [],
    ...peer.mismatch ? [peer.mismatch] : []
  ].join("; "), NODE_CHARS);
  const ready = dir.harnesses.filter((harness) => harness.runsOn.length);
  const unready = dir.harnesses.filter((harness) => !harness.runsOn.length);
  const problems = notReady(dir);
  const kept = [
    `This node ${here.name}: ${free(here.workers)}, ${here.takesWork ? "takes work" : "takes no work"}, host ${here.host}.`,
    `Can place work on: ${few(placeableNodes(dir)) || "no paired node"}.`,
    `Harnesses ready: ${ready.map((harness) => `${harness.id}${harness.isDefault ? " (default)" : ""} on ${few(harness.runsOn)}`).join("; ") || "none"}.`,
    ...unready.length ? [`Harnesses on no node: ${few(unready.map((harness) => harness.id))}.`] : [],
    ...problems.slice(0, LISTED).map((line) => `Not ready: ${line}.`),
    ...problems.length > LISTED ? [`Not ready: +${problems.length - LISTED} more.`] : [],
    ...dir.stale.map((item) => `Stale ${item.section}: ${clip(item.why)}.`),
    `Reads: ${readsFor(dir, "main").map((command) => command.name).join(", ")}.`,
    ...offline.length ? [`Offline: ${few(offline)}.`] : []
  ];
  let size = kept.reduce((total, line) => total + line.length + 1, 0);
  for (const line of online.map(node)) {
    if (size + line.length + 1 > SUMMARY_CHARS) { kept.push("... (SwarmDirectory has the rest)"); break; }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join("\n");
}

/** A node as a card lists it for someone who may see it. */
const nodeCard = (node: NodeEntry): Record<string, unknown> => ({
  name: node.name, online: node.online,
  ...node.online ? { machine: node.machine, harnesses: node.harnesses, ...(node.workers ? { workers: node.workers } : {}), takes_work: node.takesWork } : {}
});
const counts = (dir: Directory) => ({ total: dir.peers.length, online: dir.peers.filter((peer) => peer.online).length });
const HIDDEN = "only maintainers and owners see which nodes these are and what each runs: give this requester counts";

/**
 * The router's card section: every node with free slots, lends, what it may ask there, or that its grant is unknown, and
 * harness problems, for `seesNodes`; counts otherwise. When the paired nodes could not be read, it says why, so the router
 * tells a person it cannot see them rather than that there are none.
 */
export function routerCard(dir: Directory, seesNodes: boolean): Record<string, unknown> {
  const commands = Object.fromEntries(dir.commands.filter((command) => command.who.includes("router")).map((command) => [command.name, command.about]));
  const nodes = dir.stale.find((item) => item.section === "nodes");
  const unknown = nodes ? { nodes_unknown: clip(nodes.why) } : {};
  if (!seesNodes) return { paired_nodes: counts(dir), ...(dir.here.workers ? { ticket_workers: dir.here.workers } : {}), commands, node_names: HIDDEN, ...unknown };
  const problems = harnessProblems(dir, dir.here.name);
  return {
    this_node: { ...nodeCard(dir.here), ...(Object.keys(problems).length ? { harness_problems: problems } : {}) },
    paired_nodes: dir.peers.map((peer) => {
      const own = harnessProblems(dir, peer.name);
      // A grant the node does not say leaves may_there empty, which must not read as one that forbids the work.
      return { ...nodeCard(peer), ...peer.online ? { lends: peer.lends?.tools ?? [], may_there: peer.mayThere,
        ...(peer.grant.received === "unknown" ? { grant_unknown: true } : {}),
        ...(Object.keys(own).length ? { harness_problems: own } : {}) } : {} };
    }),
    not_ready: notReady(dir),
    commands,
    ...unknown
  };
}

/** A lent tool's name as the ticket `mesh` tool takes it, which calls it on the node by name: `shell` for `mcp__gpu__shell`. */
const meshName = (tool: string): string => tool.slice(tool.lastIndexOf("__") + 2);

/** A ticket worker's `directory` tool: the devices with lends, grants received, harness problems, what is not ready and the reads. */
export function workerView(dir: Directory, seesNodes: boolean): Record<string, unknown> {
  const reads = Object.fromEntries(readsFor(dir, "person").map((command) => [command.how, command.about]));
  const stale = dir.stale.map((item) => `${item.section}: ${item.why}`);
  if (!seesNodes) {
    return { as_of: dir.at, paired_nodes: counts(dir), ...(dir.here.workers ? { ticket_workers: dir.here.workers } : {}), node_names: HIDDEN,
      commands_people_can_send: reads, ...(stale.length ? { stale } : {}) };
  }
  return {
    as_of: dir.at,
    this_node: { ...nodeCard(dir.here), harness_problems: harnessProblems(dir, dir.here.name) },
    paired_nodes: dir.peers.map((peer) => ({ ...nodeCard(peer),
      ...peer.online ? { lends: { ...peer.lends, tools: (peer.lends?.tools ?? []).map(meshName) }, grant_received: grantText(peer.grant.received), may_there: peer.mayThere,
        harness_problems: harnessProblems(dir, peer.name) } : { ...(peer.error ? { error: clip(peer.error) } : {}) } })),
    harnesses: dir.harnesses.map((harness) => ({ id: harness.id, runs_on: harness.runsOn, ...(harness.isDefault ? { default: true } : {}) })),
    not_ready: notReady(dir),
    commands_people_can_send: reads,
    ...(stale.length ? { stale } : {})
  };
}
