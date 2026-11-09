/**
 * `swarm superagent`: run the ticket host, inspect tickets, file requests and answer, stop or retry tickets from the
 * terminal, and place a ticket's worker on a paired mesh node. `worker` and `mcp` are the host's own entry points for a
 * ticket's worker process and its tools; with `--remote` they serve a ticket that a paired node owns.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canRetry, latestAssignment } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { lockHolder } from "./host.js";
import { requestOn, updatePlacement, type NodeRef } from "./placement.js";
import { readSettings, settingsPath, superagentStateDir, updateSettings, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { findTicket, hostStatus, localReplies, ticketRow, ticketRows, type TicketRow } from "./views.js";
import type { WorkLink } from "./work-link.js";

const USAGE = `Usage: swarm superagent <command>

Commands:
  run                         Run the ticket host in the foreground: Sources, model judgements, workers, replies
  status [--json]             Whether a host runs, its health, and how many tickets wait where
  tickets [--all] [--all-devices] [--json]
                              Tickets, what waits for a person first; --all-devices adds paired mesh devices' tickets
  ticket <id> [--json]        One ticket with its latest report and messages; <device>:<id> for a paired device's
  request [--device <name> | --on <node>] [--harness <id>] <text...>
                              File a request as a new ticket from this terminal, or on a paired device;
                              --on keeps the ticket here and runs its worker on a paired node;
                              --harness runs its worker on an agent harness such as claude, codex, kimi or opencode
  say <id> <text...>          Send a message to a ticket, such as an answer to its question
  stop <id>                   Stop a ticket's work
  retry <id>                  Start a ticket again after it failed or blocked
  place <id> <node>|here      Run a ticket's next worker on a paired node, or here
  pause | resume              Pause or resume processing: new Evals, launches, deliveries and replies
  config [path|show|init]     The settings file: its path, its content, or a starting file
  harness list|check [<id>]   The agent harness profiles here: installed, signed in, keys set (also swarm harness)

Settings live in ${settingsPath()}; ticket directories default to <state>/work.`;

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

const rowLine = (row: TicketRow): string =>
  `${row.short}  ${row.label.padEnd(22)} ${row.source.padEnd(7)} ${row.title}${row.pr ? `  (PR #${row.pr})` : ""}${row.pulledBy ? `  (pulled by ${row.pulledBy})` : row.runsOn ? `  (on ${row.runsOn})` : ""}${row.harness ? `  (via ${row.harness})` : ""}${row.question ? `\n          ? ${row.question}` : ""}`;

/** A paired node by name, id or a unique start of either, as a placement names it. */
async function pairedNode(handle: string): Promise<NodeRef> {
  const { findPeer, meshPeers, readMesh } = await import("../mesh/state.js");
  if (!meshPeers().length) throw new Error(`No paired node "${handle}": pair one with swarm mesh invite and swarm mesh join`);
  const { id, name } = findPeer(readMesh(), handle);
  return { id, name };
}

/** What to add after placing work on a paired node when the host here would not place it there. */
function placeHint(client: SuperagentClient): string {
  if (!lockHolder(client.stateDir)) return " No host runs yet: start this device's node with `swarm node run`.";
  return hostStatus(client).health.mesh ? "" : " The host here is not a mesh node, so it runs workers itself: run it as `swarm node run` instead.";
}

export async function runSuperagentCommand(input: string[]): Promise<void> {
  const args = [...input];
  const command = args.shift();
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "run") return runHost();
  if (command === "worker") return runWorkerCommand(args);
  if (command === "mcp") return runMcpCommand(args);
  if (command === "config") return runConfig(args);
  if (command === "harness") return (await import("./harness-cli.js")).runHarnessCommand(args);
  if (command === "pause" || command === "resume") {
    updateSettings((settings) => ({ ...settings, paused: command === "pause" }));
    console.log(command === "pause" ? "Processing paused: no new Evals, launches, deliveries or replies until resume." : "Processing resumed.");
    return;
  }
  const json = flag(args, "json");
  if (await runOnDevice(command, args, json)) return;
  const client = new SuperagentClient();
  try {
    if (command === "status") {
      const status = hostStatus(client);
      if (json) { console.log(JSON.stringify(status, null, 2)); return; }
      console.log(status.running ? `Host running (pid ${status.pid})` : `No host running. Start one with: swarm superagent run`);
      const { person, working, queued, idle } = status.counts;
      console.log(`Tickets: ${person} need you, ${working} working, ${queued} queued, ${idle} idle`);
      // A stopped host's last snapshot says nothing about now.
      for (const [name, health] of Object.entries(status.running ? status.health : {})) {
        if (health.state === "error" || health.state === "starting") console.log(`  ${name}: ${health.state} ${health.detail}`.trimEnd());
      }
      const error = client.settingsError();
      if (error) console.log(`Settings: ${error}`);
      return;
    }
    if (command === "tickets") {
      const ended = flag(args, "all");
      const rows = flag(args, "all-devices") ? await allDeviceRows(client, ended) : ticketRows(client, { ended });
      if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
      console.log(rows.length ? rows.map(rowLine).join("\n") : "No open tickets.");
      return;
    }
    if (command === "request") {
      const on = value(args, "on");
      const harness = value(args, "harness");
      const text = args.join(" ").trim();
      if (!text) throw new Error("Usage: swarm superagent request [--on <node>] [--harness <id>] <text>");
      const via = harness ? ` on ${harness}` : "";
      if (on) {
        const node = await pairedNode(on);
        const { triggerId } = requestOn(client, text, node, harness);
        console.log(`Filed request ${triggerId.slice(0, 8)}; its worker runs${via} on ${node.name}.${placeHint(client)}`);
        return;
      }
      const { triggerId } = client.request(text, undefined, harness ? { harness } : {});
      console.log(`Filed request ${triggerId.slice(0, 8)}${harness ? `; its worker runs on ${harness}` : ""}.${lockHolder(client.stateDir) ? "" : " No host runs yet: start one with `swarm superagent run`."}`);
      return;
    }
    const handle = args.shift();
    if (!handle) throw new Error(`Usage: swarm superagent ${command} <ticket id>`);
    const ticket = findTicket(client, handle);
    if (!ticket) throw new Error(`No ticket ${handle}`);
    if (command === "ticket") {
      const row = ticketRow(client, ticket);
      const messages = localReplies(client, 200).filter((message) => message.ticketId === ticket.id);
      if (json) { console.log(JSON.stringify({ ...row, ticket, messages }, null, 2)); return; }
      console.log(rowLine(row));
      if (row.summary) console.log(`\nLatest report:\n${row.summary}`);
      for (const message of messages) console.log(`\n[${message.kind}] ${message.text}`);
      return;
    }
    if (command === "say") {
      const text = args.join(" ").trim();
      if (!text) throw new Error("Usage: swarm superagent say <ticket id> <text>");
      client.message(ticket.id, text);
      console.log(`Sent to ${ticket.id.slice(0, 8)}.`);
      return;
    }
    if (command === "stop") { client.stop(ticket.id); console.log(`Stopped ${ticket.id.slice(0, 8)}.`); return; }
    if (command === "retry") { client.retry(ticket.id); console.log(`Retrying ${ticket.id.slice(0, 8)}.`); return; }
    if (command === "place") {
      const where = args.shift();
      if (!where) throw new Error("Usage: swarm superagent place <ticket id> <node>|here");
      const on = where === "here" ? "here" as const : await pairedNode(where);
      updatePlacement(client, ticket.id, { on });
      const short = ticket.id.slice(0, 8);
      const next = canRetry(ticket) ? ` Retry it to start it there: swarm superagent retry ${short}.`
        : latestAssignment(ticket)?.state === "running" ? " Its current worker goes on where it runs." : "";
      console.log(`Ticket ${short}'s next worker runs ${on === "here" ? "here" : `on ${on.name}`}.${next}${on === "here" ? "" : placeHint(client)}`);
      return;
    }
    throw new Error(`Unknown command ${command}\n\n${USAGE}`);
  } finally {
    client.close();
  }
}

/**
 * The command line that starts this Swarm again, for a worker process: Node with its loader flags and the entry script.
 * A worker starts in its ticket's directory, so a loader named by package, such as `--import tsx`, is resolved here first.
 */
export function selfCommand(): string[] {
  const flags = process.execArgv.map((arg, index, all) => {
    const previous = all[index - 1];
    if ((previous === "--import" || previous === "--loader") && !/^(\.|\/|file:)/.test(arg)) return import.meta.resolve(arg);
    return arg;
  });
  return [process.execPath, ...flags, resolve(process.argv[1]!)];
}

/** This node's tickets and every reachable paired device's, newest first within each group. */
async function allDeviceRows(client: SuperagentClient, ended: boolean): Promise<TicketRow[]> {
  const { meshPeers } = await import("../mesh/state.js");
  const { peerTickets } = await import("../mesh/tickets.js");
  const remote = await Promise.all(meshPeers().map(async (peer) => {
    try { return (await peerTickets(peer)).rows.filter((row) => ended || row.group !== "ended"); }
    catch (error) { console.error(`${peer.name}: ${error instanceof Error ? error.message : String(error)}`); return []; }
  }));
  const order = ["person", "working", "queued", "idle", "ended"];
  return [...ticketRows(client, { ended }), ...remote.flat()]
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Runs a ticket command against a paired device: `request --device <name>`, or a `<device>:<id>` handle. */
async function runOnDevice(command: string, args: string[], json: boolean): Promise<boolean> {
  const device = command === "request" ? value(args, "device") : undefined;
  if (device && args.includes("--on")) throw new Error("Give --device to file on a paired device, or --on to run the worker on one, not both");
  if (device && args.includes("--harness")) throw new Error("A ticket filed on a paired device runs on that device's default harness; set executor.harness there instead of --harness");
  const handle = command === "ticket" || command === "say" || command === "stop" || command === "retry" ? args[0] : undefined;
  const { splitHandle } = await import("../mesh/tickets.js");
  const target = device ?? (handle ? splitHandle(handle).device : undefined);
  if (!target) return false;
  const { meshPeers } = await import("../mesh/state.js");
  const peer = meshPeers().find((item) => item.name === target || item.id === target);
  if (!peer) throw new Error(`No paired device "${target}"; see swarm mesh status`);
  const mesh = await import("../mesh/tickets.js");
  if (command === "request") {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Usage: swarm superagent request --device <name> <text>");
    console.log(`Filed request ${(await mesh.peerRequest(peer, text)).triggerId.slice(0, 8)} on ${peer.name}.`);
    return true;
  }
  const id = splitHandle(args.shift()!).id;
  if (command === "ticket") {
    const { row, messages } = await mesh.peerTicket(peer, id);
    if (json) { console.log(JSON.stringify({ ...row, messages }, null, 2)); return true; }
    console.log(rowLine(row));
    if (row.summary) console.log(`\nLatest report:\n${row.summary}`);
    for (const message of messages) console.log(`\n[${message.kind}] ${message.text}`);
    return true;
  }
  if (command === "say") {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Usage: swarm superagent say <device>:<ticket id> <text>");
    console.log(`Sent to ${(await mesh.peerAct(peer, id, "messages", { text })).short}.`);
    return true;
  }
  const row = await mesh.peerAct(peer, id, command as "stop" | "retry");
  console.log(`${command === "stop" ? "Stopped" : "Retrying"} ${row.short}.`);
  return true;
}

async function runHost(): Promise<void> {
  const { SuperagentHost } = await import("./host.js");
  const { providerComplete } = await import("./provider.js");
  const host = new SuperagentHost({ workerCommand: selfCommand(), complete: await providerComplete() });
  await host.start();
  console.log(`Superagent host running for ${host.stateDir} (pid ${process.pid}). Ctrl+C stops it.`);
  if (host.problem) console.log(`Setup: ${host.problem.detail}`);
  await new Promise<void>((resolve) => {
    const stop = () => { void host.stop().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function deploymentFromEnv(): Deployment {
  const raw = process.env.SWARM_SUPERAGENT_DEPLOYMENT;
  if (!raw) throw new Error("SWARM_SUPERAGENT_DEPLOYMENT is not set; the host starts this command");
  return JSON.parse(raw) as Deployment;
}

/** The paired node that owns a ticket whose worker runs here, by its id in this node's mesh state. */
async function ownerNode(id: string) {
  const { findPeer, readMesh } = await import("../mesh/state.js");
  return findPeer(readMesh(), id);
}

async function runWorkerCommand(args: string[]): Promise<void> {
  const ticketId = value(args, "ticket");
  const assignmentId = value(args, "assignment");
  const owner = value(args, "remote");
  if (!ticketId || !assignmentId) throw new Error("Usage: swarm superagent worker --ticket <id> --assignment <id> [--remote <node>]");
  let link: WorkLink;
  if (owner) {
    const { meshLink } = await import("../mesh/work-link.js");
    link = meshLink(await ownerNode(owner), ticketId, assignmentId, process.cwd());
  } else {
    const { localLink } = await import("./work-link.js");
    const deployment = deploymentFromEnv();
    link = localLink(new SuperagentClient({ stateDir: superagentStateDir(), deployment: () => deployment }), deployment, ticketId, assignmentId);
  }
  const { runWorker } = await import("./worker.js");
  process.exitCode = await runWorker({ ticketId, link, entry: selfCommand() });
}

async function runMcpCommand(args: string[]): Promise<void> {
  const ticketId = value(args, "ticket");
  const owner = value(args, "remote");
  const assignmentId = value(args, "assignment");
  if (!ticketId || (owner && !assignmentId)) throw new Error("Usage: swarm superagent mcp --ticket <id> [--remote <node> --assignment <id>]");
  const { serveTicketTools, ticketTools, withPatch } = await import("./ticket-tools.js");
  // The tools act as the agent's accounts; a worker that acts as its requester holds their token, which they never use.
  delete process.env.GH_TOKEN;
  delete process.env.GH_REPO;
  // The worker starts its tools in its ticket's directory, whose commits a local ticket's ready report sends as a patch.
  const directory = process.env.SWARM_TICKET_DIR || process.cwd();
  if (owner) {
    const { remoteTicketTools } = await import("../mesh/work-link.js");
    await serveTicketTools(withPatch(remoteTicketTools(await ownerNode(owner), ticketId, assignmentId!), directory));
    return;
  }
  const deployment = deploymentFromEnv();
  const client = new SuperagentClient({ deployment: () => deployment });
  await serveTicketTools(withPatch(ticketTools(client, ticketId), directory));
}

function runConfig(args: string[]): void {
  const action = args[0] ?? "path";
  const path = settingsPath();
  if (action === "path") { console.log(path); return; }
  if (action === "show") {
    const read = readSettings(path);
    console.log(JSON.stringify(read.settings, null, 2));
    if (read.error) console.error(read.error);
    return;
  }
  if (action === "init") {
    if (existsSync(path)) throw new Error(`${path} exists already`);
    writeSettings({
      sources: {
        github: { enabled: false, config: { repository: "owner/name", cli: "gh" } },
        feishu: { enabled: false, config: { cli: "lark-cli", chats: [] } }
      },
      policy: { sources: { github: { allowed: [] } } },
      eval: { mode: "observe" },
      executor: { maxWorkers: 2, prepare: "" }
    }, path);
    console.log(`Wrote ${path}. Set the GitHub repository and agent CLI, list who may ask, then enable the Source.`);
    return;
  }
  throw new Error("Usage: swarm superagent config [path|show|init]");
}
