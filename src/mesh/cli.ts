/**
 * `swarm mesh`: pair this device with others and see them; `swarm node run`: the device daemon, which runs the
 * superagent host and the mesh server together so peers can reach this node.
 */
import { mcpToolName } from "../extensions/mcp.js";
import type { TicketRow } from "../superagent/views.js";
import { connect } from "node:net";
import { DEFAULT_RELAY, INVITE_MINUTES, createInvite, findPeer, hostPort, meshHome, readMesh, relayOf, updateMesh, type Lend, type Peer, type Pull } from "./state.js";
import { advertisedAddresses, detectAbilities, nodeCard, type NodeCard, type NodeLoad } from "./card.js";
import { closePeerLinks, peerHealth, removeFromSwarm } from "./client.js";
import { LEND_KINDS, lendFolders, lentTools, registerLending, stopLending, type LendKind } from "./lend.js";
import { parseListen } from "./listen.js";
import { inviteWithCode, joinWithCode } from "./pair.js";
import { RelayServer } from "./relay.js";
import { MeshServer } from "./server.js";

const USAGE = `Usage: swarm mesh <command>

Commands:
  invite [--minutes N]       Print a pairing code such as K7QM-4ZX2 and wait: each device that joins with it is
                             paired with this node and every member of its swarm
  invite --direct [--minutes N]
                             Print a long one-time code with this node's address, for when there is no relay
  join <code>                Join the swarm of the device that printed the code
  status [--json]            This node and its peers: how each is reached, version, abilities, load
  remove <peer>              Remove a device from the swarm: every member forgets it
  name <name>                Rename this node
  relay [<url>|on|off]       Where devices meet when they cannot reach each other directly; alone, shows it
  relay serve [--listen <host:port>]
                             Run a relay (put it behind a TLS proxy for wss://)
  listen <host:port>         Where this node takes direct links (0.0.0.0:38172 by default)
  advertise <host:port>|--clear
                             An address peers try first, such as a forwarded port
  lend [shell|files <dir>…]  Lend paired peers a shell or file access in these folders; alone, shows what is lent
  lend --stop shell|files [<dir>…]
                             Stop lending in these folders, or in all of them
  tools [peer] [--json]      What each peer lends; this node's sessions use it as mcp__<peer>__<tool>
  pull [on|off] [--repo <owner/name>…]
                             Take work that waits for a worker on paired nodes when this node has a free slot,
                             only work of these repositories when given; alone, shows the setting
  offer on|off               Whether paired nodes that pull may take this node's waiting work (on by default)

Run \`swarm node run\` on a device so its peers can reach it; a device without it still reaches them. Each pair
of devices shares a key that encrypts everything between them: direct on a shared network, through the relay
otherwise, which passes the bytes on without reading them. State lives in ${meshHome()}.`;

const NODE_USAGE = `Usage: swarm node run [--no-host]

Runs this device's node: the superagent host (tickets, Sources, workers) and the mesh server peers call,
directly and through the relay, which also serves the tools this node lends (swarm mesh lend).
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

/** Whether a node runs here: something takes connections on the port this node's mesh server binds. */
function serving(listen: string): Promise<boolean> {
  const { host, port } = parseListen(listen);
  return new Promise((resolve) => {
    const socket = connect({ host: host === "0.0.0.0" || host === "::" || host === "tailnet" ? "127.0.0.1" : host, port });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
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
  try {
    await meshCommand(input);
  } finally {
    closePeerLinks();
  }
}

async function meshCommand(input: string[]): Promise<void> {
  const args = [...input];
  const command = args.shift();
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "status" || command === "peers") return status(flag(args, "json"));
  if (command === "invite") {
    const direct = flag(args, "direct");
    return invite(Number(value(args, "minutes") ?? INVITE_MINUTES), direct);
  }
  if (command === "join") {
    const code = args.join(" ").trim();
    if (!code) throw new Error("Usage: swarm mesh join <code>");
    return join(code);
  }
  if (command === "remove") {
    const handle = args[0];
    if (!handle) throw new Error("Usage: swarm mesh remove <peer>");
    const peer = findPeer(readMesh(), handle);
    const { missed } = await removeFromSwarm(peer);
    console.log(`Removed ${peer.name} from the swarm.${missed.length ? ` ${missed.join(", ")} did not hear now and will still know it until removed there; ${peer.name}'s key here no longer works.` : " Every member forgot it."}`);
    return;
  }
  if (command === "relay") return relay(args);
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
    const address = args[0];
    if (!clear && !address) throw new Error("Usage: swarm mesh advertise <host:port>|--clear");
    if (address) parseListen(hostPort(address));
    updateMesh((state) => {
      const { advertise: _dropped, ...node } = state.node;
      return { ...state, node: clear ? node : { ...node, advertise: hostPort(address!) } };
    });
    console.log(clear ? "Peers will try the addresses this node detects, then the relay." : `Peers will try ${hostPort(address!)} first.`);
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
  const addresses = await advertisedAddresses(node);
  const relay = relayOf(node);
  const running = await serving(node.listen);
  const peers = await peerHealth();
  const hosts = state.peers.filter((peer) => peers.some((item) => item.peer.id === peer.id && item.card?.load));
  const pulled = await pulledWork(node.name, hosts);
  if (json) {
    console.log(JSON.stringify({ node: { id: node.id, name: node.name, listen: node.listen, addresses, relay: relay ?? null, serving: running, pull: node.pull }, peers, pulled }, null, 2));
    return;
  }
  console.log(`${node.name}  ${running ? "running" : "not running: start swarm node run so peers can reach it"}`);
  console.log(`  direct at ${addresses.join(", ") || "no address peers can reach"}; relay ${relay ?? "off"}`);
  for (const line of pullLines(node.pull)) console.log(`  ${line}`);
  if (!peers.length) console.log("No peers yet: run swarm mesh invite here and swarm mesh join <code> on the other device.");
  for (const item of peers) {
    console.log(item.reachable && item.card
      ? `  ${item.peer.name.padEnd(16)} ${String(item.ms).padStart(4)} ms  ${item.path}  ${cardLine(item.card)}`
      : `  ${item.peer.name.padEnd(16)} unreachable  ${item.error ?? ""}`);
  }
  if (pulled.length) console.log(`Pulled work:\n${pulled.map((row) => `  ${row.short}  ${row.label.padEnd(22)} ${row.title}  (pulled by ${row.pulledBy})`).join("\n")}`);
}

async function invite(minutes: number, direct: boolean): Promise<void> {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error("--minutes takes 1 to 60");
  const { node } = readMesh();
  if (direct) {
    const addresses = await advertisedAddresses(node);
    if (!addresses.length) throw new Error("This node has no address another device can reach; use a pairing code, or swarm mesh advertise <host:port>");
    console.log(createInvite(addresses, minutes));
    console.log(`\nOn the other device: swarm mesh join <the code above>. It works once, for ${minutes} minutes, at ${addresses.join(" or ")}.`);
    if (!await serving(node.listen)) console.log("No node runs here yet: start swarm node run, or the join fails.");
    return;
  }
  const invitation = await inviteWithCode({
    minutes,
    onJoin: (peer) => console.log(`${peer.name} joined.`),
    onRefused: (left) => console.log(`Someone tried a wrong code; ${left} more wrong ${left === 1 ? "try cancels" : "tries cancel"} it.`)
  });
  console.log(`Pairing code: ${invitation.code}`);
  console.log(`\nOn each device to add: swarm mesh join ${invitation.code}\nIt works for ${minutes} minutes, for any number of devices. Ctrl+C ends it sooner.`);
  process.once("SIGINT", () => invitation.close());
  console.log(await invitation.ended);
}

async function join(code: string): Promise<void> {
  const { inviter, members } = await joinWithCode(code);
  console.log(`Joined ${inviter.name}'s swarm${members.length ? `, with ${members.map((member) => member.name).join(", ")}` : ""}.`);
  // Each member takes this node's introduction on first contact, so reach them all now.
  for (const item of await peerHealth(undefined, 10_000)) {
    console.log(`  ${item.peer.name.padEnd(16)} ${item.reachable ? item.path : `not reachable now; it links up once both are online (${item.error})`}`);
  }
}

async function relay(args: string[]): Promise<void> {
  if (args[0] === "serve") {
    const listen = value(args, "listen") ?? "0.0.0.0:8443";
    const server = new RelayServer((message) => process.stderr.write(`${message}\n`));
    const { url } = await server.start(listen);
    console.log(`Swarm relay listening at ${url} (on ${listen}). Nodes use it with swarm mesh relay <its wss:// URL>. Ctrl+C stops it.`);
    await new Promise<void>((resolve) => {
      const stop = () => { void server.stop().then(resolve); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const setting = args[0];
  if (setting) {
    const relay = setting === "on" ? undefined : setting === "off" ? "off" : setting.includes("://") ? setting.replace(/\/$/, "") : `wss://${setting}`;
    if (relay && relay !== "off" && !/^wss?:\/\//.test(relay)) throw new Error("Usage: swarm mesh relay [<wss:// URL>|on|off]");
    updateMesh((state) => {
      const { relay: _dropped, ...node } = state.node;
      return { ...state, node: relay ? { ...node, relay } : node };
    });
  }
  const current = relayOf(readMesh().node);
  console.log(current ? `Devices meet at ${current}${current === DEFAULT_RELAY ? " (the default relay)" : ""} when they cannot reach each other directly.` : "The relay is off: devices link up only directly, and pairing takes a direct code (swarm mesh invite --direct).");
  if (setting) console.log("A node run with swarm node run uses it from its next start.");
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
  const relay = relayOf(node);
  await server.start(node.listen, relay ? { relay } : {});
  const addresses = await advertisedAddresses(node);
  console.log(`Swarm node "${node.name}" is up${withHost ? " with its superagent host" : ""}: direct links on ${node.listen}${addresses.length ? ` (${addresses.join(", ")})` : ""}, ${relay ? `and at the relay ${relay}` : "relay off"}. Ctrl+C stops it.`);
  if (relay) {
    setTimeout(() => {
      const at = server.relayStatus();
      if (at && !at.listening) console.log(`Not listening at the relay yet: ${at.error ?? "no answer"}. It keeps trying.`);
    }, 10_000).unref();
  }
  await new Promise<void>((resolve) => {
    const stop = () => { void server.stop().then(stopHost).then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
