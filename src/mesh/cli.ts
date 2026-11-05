/**
 * `swarm mesh`: pair this device with others and see them; `swarm node run`: the device daemon, which runs the
 * superagent host and the mesh server together so peers can reach this node.
 */
import { mcpToolName } from "../extensions/mcp.js";
import type { TicketRow } from "../superagent/views.js";
import { DEFAULT_MESH_PORT, createInvite, findPeer, meshHome, readMesh, updateMesh, type Lend, type Peer, type Pull } from "./state.js";
import { advertisedUrl, detectAbilities, nodeCard, tailnetAddress, type NodeCard, type NodeLoad } from "./card.js";
import { joinMesh, meshFetch, peerHealth, unpair } from "./client.js";
import { LEND_KINDS, lendFolders, lentTools, registerLending, stopLending, type LendKind } from "./lend.js";
import { parseListen } from "./listen.js";
import { MeshServer } from "./server.js";

const USAGE = `Usage: swarm mesh <command>

Commands:
  status [--json]            This node and its peers: reachable, version, abilities, load
  invite [--minutes N]       Print a one-time code that another device joins with
  join <code>                Pair with the device that printed the code
  remove <peer>              Unpair; the peer forgets this node too
  name <name>                Rename this node
  listen <host:port>         Where this node's mesh server binds; tailnet:38172 binds its Tailscale address
  advertise <url>|--clear    The URL peers call this node at; derived from Tailscale or the hostname when unset
  lend [shell|files <dir>…]  Lend paired peers a shell or file access in these folders; alone, shows what is lent
  lend --stop shell|files [<dir>…]
                             Stop lending in these folders, or in all of them
  tools [peer] [--json]      What each peer lends; this node's sessions use it as mcp__<peer>__<tool>
  pull [on|off] [--repo <owner/name>…]
                             Take work that waits for a worker on paired nodes when this node has a free slot,
                             only work of these repositories when given; alone, shows the setting
  offer on|off               Whether paired nodes that pull may take this node's waiting work (on by default)

Run \`swarm node run\` on each device so peers can reach it. Pair over a private network such as Tailscale:
the mesh speaks plain HTTP and relies on the network to encrypt it. State lives in ${meshHome()}.`;

const NODE_USAGE = `Usage: swarm node run [--no-host]

Runs this device's node: the superagent host (tickets, Sources, workers) and the mesh server peers call,
which also serves the tools this node lends (swarm mesh lend).
--no-host serves the mesh only, for a device that runs its ticket host elsewhere.`;

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const [, found] = args.splice(index, 2);
  return found;
}

const loopback = (host: string): boolean => host === "localhost" || host === "::1" || host.startsWith("127.");
/** Where this machine reaches its own mesh server, whatever address it binds. */
async function localUrl(listen: string): Promise<string> {
  const { host, port } = parseListen(listen);
  const reach = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host === "tailnet" ? await tailnetAddress() ?? "127.0.0.1" : host;
  return `http://${reach.includes(":") ? `[${reach}]` : reach}:${port}`;
}

const cardLine = (card: NodeCard): string => {
  const load = card.load ? `, ${card.load.running}/${card.load.slots} workers${card.load.queued ? `, ${card.load.queued} queued` : ""}` : "";
  const pull = card.pull ? `, pulls${card.pull.repositories.length ? ` ${card.pull.repositories.join(" ")}` : ""}` : "";
  return `${card.abilities.join(" ")}, swarm ${card.version}${card.repository ? `, ${card.repository}` : ""}${load}${pull}`;
};

const pullLines = (pull: Pull): string[] => [
  pull.enabled
    ? `Pulls waiting work from paired nodes when it has a free worker slot: ${pull.repositories.length ? `work of ${pull.repositories.join(", ")}` : "any repository's"}.`
    : "Does not pull work from paired nodes; swarm mesh pull on lets it.",
  pull.offer ? "Hands its own waiting work to paired nodes that pull." : "Keeps its own waiting work from paired nodes that pull."
];

export async function runMeshCommand(input: string[]): Promise<void> {
  const args = [...input];
  const command = args.shift();
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "status" || command === "peers") return status(flag(args, "json"));
  if (command === "invite") return invite(Number(value(args, "minutes") ?? 15));
  if (command === "join") {
    const code = args[0];
    if (!code) throw new Error("Usage: swarm mesh join <code>");
    const peer = await joinMesh(code);
    console.log(`Paired with ${peer.name} at ${peer.url}.`);
    return;
  }
  if (command === "remove") {
    const handle = args[0];
    if (!handle) throw new Error("Usage: swarm mesh remove <peer>");
    const peer = findPeer(readMesh(), handle);
    const told = await unpair(peer);
    console.log(told ? `Unpaired from ${peer.name}; it forgot this node too.` : `Forgot ${peer.name}. It was unreachable, so it still lists this node until you remove it there; its token here no longer works.`);
    return;
  }
  if (command === "name") {
    const name = args.join(" ").trim();
    if (!name) throw new Error("Usage: swarm mesh name <name>");
    updateMesh((state) => ({ ...state, node: { ...state.node, name } }));
    console.log(`This node is now "${name}". Peers see the new name on their next status.`);
    return;
  }
  if (command === "listen") {
    const listen = args[0];
    if (!listen) throw new Error("Usage: swarm mesh listen <host:port>");
    parseListen(listen);
    updateMesh((state) => ({ ...state, node: { ...state.node, listen } }));
    console.log(`The mesh server binds ${listen} from its next start.`);
    return;
  }
  if (command === "advertise") {
    const clear = flag(args, "clear");
    const url = args[0];
    if (!clear && !url) throw new Error("Usage: swarm mesh advertise <url>|--clear");
    updateMesh((state) => {
      const { advertise: _dropped, ...node } = state.node;
      return { ...state, node: clear ? node : { ...node, advertise: new URL(url!).toString().replace(/\/$/, "") } };
    });
    console.log(clear ? "Peers will reach this node at its tailnet or host name." : `Peers will reach this node at ${url}.`);
    return;
  }
  if (command === "lend") return lend(args);
  if (command === "tools") {
    const json = flag(args, "json");
    return tools(args[0] ?? "", json);
  }
  if (command === "pull") return pull(args);
  if (command === "offer") {
    const setting = args[0];
    if (setting !== "on" && setting !== "off") throw new Error("Usage: swarm mesh offer on|off");
    updateMesh((state) => ({ ...state, node: { ...state.node, pull: { ...state.node.pull, offer: setting === "on" } } }));
    console.log(setting === "on" ? "Paired nodes that pull may take this node's waiting work." : "This node keeps its waiting work; paired nodes that pull take none of it.");
    return;
  }
  throw new Error(`Unknown mesh command "${command}".\n\n${USAGE}`);
}

const lendLines = (lend: Lend | undefined): string[] =>
  LEND_KINDS.flatMap((kind) => lend?.[kind] ? [`${kind} (${lentTools({ [kind]: lend[kind] }).join(", ")}) in ${lend[kind].roots.join(", ")}`] : []);

function lend(args: string[]): void {
  const stop = flag(args, "stop");
  const [kind, ...folders] = args;
  if (!kind && !stop) {
    const lines = lendLines(readMesh().node.lend);
    console.log(lines.length ? `Paired peers may use:\n${lines.map((line) => `  ${line}`).join("\n")}` : "This node lends nothing. swarm mesh lend shell|files <dir> lends a shell or file access in a folder.");
    return;
  }
  if (!LEND_KINDS.includes(kind as LendKind)) throw new Error("Usage: swarm mesh lend [--stop] shell|files <dir>…");
  if (stop) {
    const left = stopLending(kind as LendKind, folders);
    console.log(left[kind as LendKind] ? `Still lending ${kind} in ${left[kind as LendKind]!.roots.join(", ")}.` : `No longer lending ${kind}.`);
    return;
  }
  if (!folders.length) throw new Error(`Usage: swarm mesh lend ${kind} <dir>…`);
  const lent = lendFolders(kind as LendKind, folders);
  console.log(`Lending ${kind} in ${lent[kind as LendKind]!.roots.join(", ")} to every paired peer, from the next request on.`);
  if (kind === "shell") console.log("A shell runs any command as this user; its folders bound where a command starts, not what it can reach.");
}

function pull(args: string[]): void {
  const repositories: string[] = [];
  for (let repository = value(args, "repo"); repository !== undefined; repository = value(args, "repo")) repositories.push(repository);
  const setting = args[0];
  if ((setting !== undefined && setting !== "on" && setting !== "off") || (setting !== "on" && repositories.length)) {
    throw new Error("Usage: swarm mesh pull [on|off] [--repo <owner/name>…]");
  }
  const odd = repositories.find((repository) => !/^[^/\s]+\/[^/\s]+$/.test(repository));
  if (odd) throw new Error(`--repo takes a repository as owner/name, not "${odd}"`);
  const state = setting ? updateMesh((current) => ({ ...current, node: { ...current.node,
    pull: { ...current.node.pull, enabled: setting === "on", ...(setting === "on" ? { repositories } : {}) } } })) : readMesh();
  console.log(pullLines(state.node.pull).join("\n"));
  if (setting === "on") console.log("A node run with swarm node run starts pulling at its next look.");
}

async function tools(handle: string, json: boolean): Promise<void> {
  const peer = handle ? findPeer(readMesh(), handle) : undefined;
  const peers = (await peerHealth()).filter((item) => !peer || item.peer.id === peer.id);
  if (json) {
    console.log(JSON.stringify(peers.map((item) => ({ peer: item.peer.name, reachable: item.reachable, tools: lentTools(item.card?.lend), lend: item.card?.lend ?? {},
      ...(item.error ? { error: item.error } : {}) })), null, 2));
    return;
  }
  if (!peers.length) console.log("No peers yet: run swarm mesh invite here and swarm mesh join <code> on the other device.");
  for (const item of peers) {
    const lines = lendLines(item.card?.lend);
    if (!item.reachable) console.log(`${item.peer.name}: unreachable  ${item.error ?? ""}`);
    else if (!lines.length) console.log(`${item.peer.name}: lends nothing`);
    else console.log(`${item.peer.name}: ${lines.join("; ")}\n  as ${lentTools(item.card?.lend).map((tool) => mcpToolName(item.peer.name, tool)).join(", ")}`);
  }
}

/**
 * Work pulled across the mesh that is not over: this node's tickets that paired nodes pulled, and the tickets of paired
 * nodes with a ticket host that this node pulled.
 */
async function pulledWork(name: string, hosts: Peer[]): Promise<TicketRow[]> {
  const { existsSync } = await import("node:fs");
  const { SuperagentClient, databasePath } = await import("../superagent/client.js");
  const { superagentStateDir } = await import("../superagent/settings.js");
  const { ticketRows } = await import("../superagent/views.js");
  const { peerTickets } = await import("./tickets.js");
  let own: TicketRow[] = [];
  if (existsSync(databasePath(superagentStateDir()))) {
    const client = new SuperagentClient();
    try { own = ticketRows(client).filter((row) => row.pulledBy); } finally { client.close(); }
  }
  const theirs = await Promise.all(hosts.map((peer) => peerTickets(peer).then((answer) => answer.rows, () => [])));
  return [...own, ...theirs.flat().filter((row) => row.pulledBy === name && row.group !== "ended")];
}

async function status(json: boolean): Promise<void> {
  const state = readMesh();
  const { node } = state;
  const url = await advertisedUrl(node);
  const serving = await meshFetch<{ id: string }>(await localUrl(node.listen), "/mesh/v1/health", { timeoutMs: 2000 }).then((answer) => answer.id === node.id, () => false);
  const peers = await peerHealth();
  const hosts = state.peers.filter((peer) => peers.some((item) => item.peer.id === peer.id && item.card?.load));
  const pulled = await pulledWork(node.name, hosts);
  if (json) {
    console.log(JSON.stringify({ node: { id: node.id, name: node.name, listen: node.listen, url, serving, pull: node.pull }, peers, pulled }, null, 2));
    return;
  }
  console.log(`${node.name}  ${url}  ${serving ? "serving" : `not serving: start swarm node run (binds ${node.listen})`}`);
  for (const line of pullLines(node.pull)) console.log(`  ${line}`);
  if (!peers.length) console.log("No peers yet: run swarm mesh invite here and swarm mesh join <code> on the other device.");
  for (const item of peers) {
    console.log(item.reachable && item.card
      ? `  ${item.peer.name.padEnd(16)} ${String(item.ms).padStart(4)} ms  ${cardLine(item.card)}`
      : `  ${item.peer.name.padEnd(16)} unreachable  ${item.error ?? ""}`);
  }
  if (pulled.length) console.log(`Pulled work:\n${pulled.map((row) => `  ${row.short}  ${row.label.padEnd(22)} ${row.title}  (pulled by ${row.pulledBy})`).join("\n")}`);
}

async function invite(minutes: number): Promise<void> {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new Error("--minutes takes 1 to 1440");
  const { node } = readMesh();
  const url = await advertisedUrl(node);
  const code = createInvite(url, minutes);
  console.log(code);
  console.log(`\nOn the other device: swarm mesh join <the code above>. It works once, for ${minutes} minutes, and reaches this node at ${url}.`);
  if (loopback(parseListen(node.listen).host)) {
    console.log(`This node binds ${node.listen}, which other devices cannot reach: run swarm mesh listen <tailnet-ip>:${parseListen(node.listen).port || DEFAULT_MESH_PORT} first.`);
  }
  const serving = await meshFetch(await localUrl(node.listen), "/mesh/v1/health", { timeoutMs: 2000 }).then(() => true, () => false);
  if (!serving) console.log("No mesh server runs here yet: start swarm node run, or the join fails.");
}

export async function runNodeCommand(input: string[]): Promise<void> {
  const args = [...input];
  const command = args.shift();
  if (command !== "run") {
    console.log(NODE_USAGE);
    return;
  }
  const withHost = !flag(args, "no-host");
  const home = meshHome();
  const abilities = await detectAbilities();
  let facts: () => { repository?: string; load?: NodeLoad } = () => ({});
  let stopHost = async (): Promise<void> => {};
  let serveHost = (_server: MeshServer): void => {};
  if (withHost) {
    const { SuperagentHost } = await import("../superagent/host.js");
    const { providerComplete } = await import("../superagent/provider.js");
    const { selfCommand } = await import("../superagent/cli.js");
    const host = new SuperagentHost({ workerCommand: selfCommand(), complete: await providerComplete() });
    const { MeshWork } = await import("./work.js");
    const work = new MeshWork(host, { home, abilities, workerCommand: selfCommand() });
    await host.start();
    if (host.problem) console.log(`Superagent setup: ${host.problem.detail}`);
    facts = () => {
      const settings = host.client.settings();
      const github = settings.sources.github;
      const repository = github?.enabled ? (github.config as { repository?: string }).repository : undefined;
      return { ...(repository ? { repository } : {}), load: work.load() };
    };
    stopHost = () => host.stop();
    const { registerTicketRoutes } = await import("./tickets.js");
    serveHost = (server) => { registerTicketRoutes(server, host.client); work.serve(server); };
  }
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities, ...facts() }), log: (message) => process.stderr.write(`${message}\n`) });
  serveHost(server);
  registerLending(server);
  const { node } = readMesh(home);
  const { url } = await server.start(node.listen);
  console.log(`Swarm node "${node.name}" serving the mesh at ${url}${withHost ? " with its superagent host" : ""}. Peers reach it at ${await advertisedUrl(node)}. Ctrl+C stops it.`);
  await new Promise<void>((resolve) => {
    const stop = () => { void server.stop().then(stopHost).then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
