/**
 * `swarm mesh`: pair this device with others and see them; `swarm node run`: the device daemon, which runs the
 * superagent host and the mesh server together so peers can reach this node.
 */
import { DEFAULT_MESH_PORT, createInvite, findPeer, meshHome, readMesh, updateMesh } from "./state.js";
import { advertisedUrl, detectAbilities, nodeCard, type NodeCard, type NodeLoad } from "./card.js";
import { joinMesh, meshFetch, peerHealth, unpair } from "./client.js";
import { MeshServer, parseListen } from "./server.js";

const USAGE = `Usage: swarm mesh <command>

Commands:
  status [--json]            This node and its peers: reachable, version, abilities, load
  invite [--minutes N]       Print a one-time code that another device joins with
  join <code>                Pair with the device that printed the code
  remove <peer>              Unpair; the peer forgets this node too
  name <name>                Rename this node
  listen <host:port>         Where this node's mesh server binds, such as its tailnet address
  advertise <url>|--clear    The URL peers call this node at; derived from Tailscale or the hostname when unset

Run \`swarm node run\` on each device so peers can reach it. Pair over a private network such as Tailscale:
the mesh speaks plain HTTP and relies on the network to encrypt it. State lives in ${meshHome()}.`;

const NODE_USAGE = `Usage: swarm node run [--no-host]

Runs this device's node: the superagent host (tickets, Sources, workers) and the mesh server peers call.
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
const localUrl = (listen: string): string => {
  const { host, port } = parseListen(listen);
  const reach = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${reach.includes(":") ? `[${reach}]` : reach}:${port}`;
};

const cardLine = (card: NodeCard): string => {
  const load = card.load ? `, ${card.load.running}/${card.load.slots} workers${card.load.queued ? `, ${card.load.queued} queued` : ""}` : "";
  return `${card.abilities.join(" ")}, swarm ${card.version}${card.repository ? `, ${card.repository}` : ""}${load}`;
};

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
  throw new Error(`Unknown mesh command "${command}".\n\n${USAGE}`);
}

async function status(json: boolean): Promise<void> {
  const { node } = readMesh();
  const url = await advertisedUrl(node);
  const serving = await meshFetch<{ id: string }>(localUrl(node.listen), "/mesh/v1/health", { timeoutMs: 2000 }).then((answer) => answer.id === node.id, () => false);
  const peers = await peerHealth();
  if (json) {
    console.log(JSON.stringify({ node: { id: node.id, name: node.name, listen: node.listen, url, serving }, peers }, null, 2));
    return;
  }
  console.log(`${node.name}  ${url}  ${serving ? "serving" : `not serving: start swarm node run (binds ${node.listen})`}`);
  if (!peers.length) console.log("No peers yet: run swarm mesh invite here and swarm mesh join <code> on the other device.");
  for (const item of peers) {
    console.log(item.reachable && item.card
      ? `  ${item.peer.name.padEnd(16)} ${String(item.ms).padStart(4)} ms  ${cardLine(item.card)}`
      : `  ${item.peer.name.padEnd(16)} unreachable  ${item.error ?? ""}`);
  }
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
  const serving = await meshFetch(localUrl(node.listen), "/mesh/v1/health", { timeoutMs: 2000 }).then(() => true, () => false);
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
  if (withHost) {
    const { SuperagentHost } = await import("../superagent/host.js");
    const { providerComplete } = await import("../superagent/provider.js");
    const { selfCommand } = await import("../superagent/cli.js");
    const { hostStatus } = await import("../superagent/views.js");
    const host = new SuperagentHost({ workerCommand: selfCommand(), complete: await providerComplete() });
    await host.start();
    if (host.problem) console.log(`Superagent setup: ${host.problem.detail}`);
    facts = () => {
      const settings = host.client.settings();
      const github = settings.sources.github;
      const repository = github?.enabled ? (github.config as { repository?: string }).repository : undefined;
      const { counts } = hostStatus(host.client);
      return { ...(repository ? { repository } : {}), load: { running: counts.working, queued: counts.queued, slots: settings.executor.maxWorkers } };
    };
    stopHost = () => host.stop();
  }
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities, ...facts() }), log: (message) => process.stderr.write(`${message}\n`) });
  const { node } = readMesh(home);
  const { url } = await server.start(node.listen);
  console.log(`Swarm node "${node.name}" serving the mesh at ${url}${withHost ? " with its superagent host" : ""}. Peers reach it at ${await advertisedUrl(node)}. Ctrl+C stops it.`);
  await new Promise<void>((resolve) => {
    const stop = () => { void server.stop().then(stopHost).then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
