/**
 * `swarm superagent`: run the ticket host, inspect tickets, file requests and answer, stop or retry tickets from the
 * terminal, send a request that could not be routed again, and place a ticket's worker on a paired mesh node. `worker` and `mcp` are the host's own entry points for a
 * ticket's worker process and its tools; with `--remote` they serve a ticket that a paired node owns, and with `--gateway`
 * one in a ticket VM, whose supervisor `guest` starts them (vm/guest.ts).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canRetry, latestAssignment } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { lockHolder } from "./host.js";
import { requestOn, updatePlacement, type NodeRef } from "./placement.js";
import { readSettings, settingsPath, superagentStateDir, updateSettings, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import type { TicketTool } from "./ticket-tools.js";
import { dismissUnrouted, findTicket, hostStatus, routeAgain, ticketMessages, ticketRow, ticketRows, whyReport, whyText, type TicketMessage, type TicketRow } from "./views.js";
import type { WorkLink } from "./work-link.js";

const USAGE = `Usage: swarm superagent <command>

Commands:
  run                         Run the ticket host in the foreground: Sources, model judgements, workers, replies
  status [--json]             Whether a host runs, its health, how many tickets wait where, and what waits to be delivered
  tickets [--all] [--all-devices] [--json]
                              Tickets, what waits for a person first; --all-devices adds paired mesh devices' tickets
  ticket <id> [--json]        One ticket with its latest report and every message queued for it, whatever its Source;
                              <device>:<id> for a paired device's
  why <ticket|message> [--json]
                              Why a ticket or a message was handled as it was: how it was routed, the ticket's work, the
                              messages queued for it, and what the agent considered and why it spoke or stayed silent
  request [--device <name> | --on <node>] [--harness <id>] <text...>
                              File a request as a new ticket from this terminal, or on a paired device;
                              --on keeps the ticket here and runs its worker on a paired node;
                              --harness runs its worker on an agent harness such as claude, codex, kimi or opencode
  say <id> <text...>          Send a message to a ticket, such as an answer to its question
  stop <id>                   Stop a ticket's work
  retry <id>                  Start a ticket again after it failed or blocked
  again <message id>          Send a request that could not be routed to the router again; status lists them
  dismiss <message id>        Drop one from status without sending it again; its Decision's id names it too
  place <id> <node>|here      Run a ticket's next worker on a paired node, or here
  pause | resume              Pause or resume processing: new Evals, launches, deliveries and replies
  config [path|show|init]     The settings file: its path, its content, or a starting file
  harness list|check [<id>]   The agent harness profiles here: installed, signed in, keys set (also swarm harness)
  replay export|run|diff|grade ...
                              Replay recorded chats: export cases, run them, diff the cards, grade the runs
                              (see replay help; cases stay under <state>/replay, never in a repository)

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

/** One queued message of a ticket: its kind, how its delivery stands, and what it says; its attachment on a line of its own. */
export const messageLines = (message: Partial<TicketMessage> & Pick<TicketMessage, "kind" | "text" | "status">): string[] => {
  const when = message.sentAt ?? message.dropped?.at;
  const tried = message.attempts ? ` (${message.attempts} failed ${message.attempts === 1 ? "try" : "tries"})` : "";
  const platform = message.platformMessageId ? `  ${message.platformMessageId}` : "";
  const lines = [`\n[${message.kind}  ${message.status}${when ? ` ${new Date(when).toLocaleString()}` : ""}${tried}${platform}] ${message.text}`];
  if (message.dropped) lines.push(`  dropped: ${message.dropped.reason}`);
  if (message.error) lines.push(`  last error: ${message.error}`);
  if (message.attachment) lines.push(`  attachment: ${message.attachment}`);
  return lines;
};
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
  if (command === "guest") {
    const { runGuest } = await import("./vm/guest.js");
    process.exitCode = await runGuest(selfCommand());
    return;
  }
  if (command === "config") return runConfig(args);
  if (command === "harness") return (await import("./harness-cli.js")).runHarnessCommand(args);
  if (command === "pause" || command === "resume") {
    updateSettings((settings) => ({ ...settings, paused: command === "pause" }));
    console.log(command === "pause" ? "Processing paused: no new Evals, launches, deliveries or replies until resume." : "Processing resumed.");
    return;
  }
  if (command === "replay") return (await import("./replay/cli.js")).runReplayCommand(args);
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
      if (status.unrouted.length) {
        console.log(`${status.unrouted.length} request${status.unrouted.length > 1 ? "s" : ""} could not be routed:`);
        for (const request of status.unrouted) console.log(`  ${request.triggerId.slice(0, 8)}  ${new Date(request.at).toLocaleString()}  ${request.text}`);
        console.log("  Send one again with `swarm superagent again <id>`, or drop it from this list with `swarm superagent dismiss <id>`.");
      }
      // What did not reach anyone: a reply whose delivery keeps failing, one dropped, and tickets whose replies wait on a Source that is off.
      if (status.replies.failing.length) {
        console.log(`${status.replies.failing.length} repl${status.replies.failing.length === 1 ? "y" : "ies"} failing to deliver:`);
        for (const reply of status.replies.failing) {
          console.log(`  ${reply.id.slice(0, 8)}${reply.ticketId ? `  ticket ${reply.ticketId.slice(0, 8)}` : ""}  ${reply.attempts} failed ${reply.attempts === 1 ? "try" : "tries"}  ${reply.error}`);
        }
      }
      if (status.replies.dropped.length) {
        console.log(`${status.replies.dropped.length} repl${status.replies.dropped.length === 1 ? "y" : "ies"} dropped:`);
        for (const reply of status.replies.dropped) {
          console.log(`  ${reply.id.slice(0, 8)}${reply.ticketId ? `  ticket ${reply.ticketId.slice(0, 8)}` : ""}  ${new Date(reply.at).toLocaleString()}  ${reply.reason}`);
        }
      }
      if (status.waitingOnOff.length) {
        console.log(`Replies waiting on a Source that is off:`);
        for (const waiting of status.waitingOnOff) console.log(`  ${waiting.ticketId ? `ticket ${waiting.ticketId.slice(0, 8)}` : "no ticket"}  ${waiting.source}  ${waiting.messages} message${waiting.messages === 1 ? "" : "s"}`);
      }
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
    // These two name a message, as status lists it, not a ticket.
    if (command === "again" || command === "dismiss") {
      const id = args.shift();
      if (!id) throw new Error(`Usage: swarm superagent ${command} <message id>`);
      if (command === "dismiss") {
        dismissUnrouted(client, id);
        console.log(`Dismissed ${id}: the request leaves the status and is not sent again.`);
        return;
      }
      const { trigger, queued, dismissed } = routeAgain(client, id);
      const short = trigger.id.slice(0, 8);
      const host = lockHolder(client.stateDir) ? "" : " No host runs yet: start one with `swarm superagent run`.";
      // A message the status did not list may be decided already, as one that became a ticket is: its fresh Eval then ignores it.
      console.log(`${!queued ? `Request ${short} is with the router already: an Eval holds it, so nothing changed.`
        : dismissed ? `Sent request ${short} to the router again, and took it off the list in status.`
        : `Queued message ${short} for the router again; it was not on the list in status.`}${host}`);
      return;
    }
    if (command === "why") {
      const handle = args.shift();
      if (!handle) throw new Error("Usage: swarm superagent why <ticket|message> [--json]");
      const report = await whyReport(client, handle);
      console.log(json ? JSON.stringify(report, null, 2) : `${report.handle}\n${whyText(client, report)}`);
      return;
    }
    const handle = args.shift();
    if (!handle) throw new Error(`Usage: swarm superagent ${command} <ticket id>`);
    const ticket = findTicket(client, handle);
    if (!ticket) throw new Error(`No ticket ${handle}`);
    if (command === "ticket") {
      const row = ticketRow(client, ticket);
      // Every message queued for it, whatever the Source it goes to, with its delivery status and what it carries.
      const messages = ticketMessages(client, ticket.id);
      if (json) { console.log(JSON.stringify({ ...row, ticket, messages }, null, 2)); return; }
      console.log(rowLine(row));
      if (row.summary) console.log(`\nLatest report:\n${row.summary}`);
      for (const message of messages) console.log(messageLines(message).join("\n"));
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
    for (const message of messages) console.log(messageLines(message).join("\n"));
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
  const gateway = flag(args, "gateway");
  if (!ticketId || !assignmentId) throw new Error("Usage: swarm superagent worker --ticket <id> --assignment <id> [--remote <node> | --gateway]");
  let link: WorkLink;
  if (gateway) {
    const { gatewayFromEnv, gatewayLink } = await import("./vm/gateway-link.js");
    link = gatewayLink(gatewayFromEnv(), ticketId);
  } else if (owner) {
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
  const gateway = flag(args, "gateway");
  if (!ticketId || (owner && !assignmentId)) throw new Error("Usage: swarm superagent mcp --ticket <id> [--remote <node> --assignment <id> | --gateway]");
  const { serveTicketTools, ticketTools, withAttachments, withPatch } = await import("./ticket-tools.js");
  // The tools act as the agent's accounts; a worker that acts as its requester holds their token, which they never use.
  delete process.env.GH_TOKEN;
  delete process.env.GH_REPO;
  // The worker starts its tools in its ticket's directory, whose commits a local ticket's ready report sends as a patch.
  const directory = process.env.SWARM_TICKET_DIR || process.cwd();
  // An attachment the worker reads is saved there too, wherever the tools run.
  const serve = (tools: TicketTool[]) => serveTicketTools(withAttachments(withPatch(tools, directory), directory));
  if (gateway) {
    const { gatewayFromEnv, gatewayTicketTools } = await import("./vm/gateway-link.js");
    await serve(gatewayTicketTools(gatewayFromEnv()));
    return;
  }
  if (owner) {
    const { remoteTicketTools } = await import("../mesh/work-link.js");
    await serve(remoteTicketTools(await ownerNode(owner), ticketId, assignmentId!));
    return;
  }
  const deployment = deploymentFromEnv();
  const client = new SuperagentClient({ deployment: () => deployment });
  await serve(ticketTools(client, ticketId));
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
