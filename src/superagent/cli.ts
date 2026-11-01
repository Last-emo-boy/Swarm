/**
 * `swarm superagent`: run the ticket host, inspect tickets, file requests and answer, stop or retry tickets from the
 * terminal. `worker` and `mcp` are the host's own entry points for a ticket's worker process and its tools.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SuperagentClient } from "./client.js";
import { lockHolder } from "./host.js";
import { readSettings, settingsPath, superagentStateDir, updateSettings, writeSettings } from "./settings.js";
import type { Deployment } from "./setup.js";
import { findTicket, hostStatus, localReplies, ticketRow, ticketRows, type TicketRow } from "./views.js";

const USAGE = `Usage: swarm superagent <command>

Commands:
  run                         Run the ticket host in the foreground: Sources, model judgements, workers, replies
  status [--json]             Whether a host runs, its health, and how many tickets wait where
  tickets [--all] [--json]    Tickets, what waits for a person first
  ticket <id> [--json]        One ticket with its latest report and messages
  request <text...>           File a request as a new ticket from this terminal
  say <id> <text...>          Send a message to a ticket, such as an answer to its question
  stop <id>                   Stop a ticket's work
  retry <id>                  Start a ticket again after it failed or blocked
  pause | resume              Pause or resume processing: new Evals, launches, deliveries and replies
  config [path|show|init]     The settings file: its path, its content, or a starting file

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
  `${row.short}  ${row.label.padEnd(22)} ${row.source.padEnd(7)} ${row.title}${row.pr ? `  (PR #${row.pr})` : ""}${row.question ? `\n          ? ${row.question}` : ""}`;

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
  if (command === "pause" || command === "resume") {
    updateSettings((settings) => ({ ...settings, paused: command === "pause" }));
    console.log(command === "pause" ? "Processing paused: no new Evals, launches, deliveries or replies until resume." : "Processing resumed.");
    return;
  }
  const json = flag(args, "json");
  const client = new SuperagentClient();
  try {
    if (command === "status") {
      const status = hostStatus(client);
      if (json) { console.log(JSON.stringify(status, null, 2)); return; }
      console.log(status.running ? `Host running (pid ${status.pid})` : `No host running. Start one with: swarm superagent run`);
      const { person, working, queued, idle } = status.counts;
      console.log(`Tickets: ${person} need you, ${working} working, ${queued} queued, ${idle} idle`);
      for (const [name, health] of Object.entries(status.health)) {
        if (health.state !== "ready") console.log(`  ${name}: ${health.state} ${health.detail}`);
      }
      const error = client.settingsError();
      if (error) console.log(`Settings: ${error}`);
      return;
    }
    if (command === "tickets") {
      const rows = ticketRows(client, { ended: flag(args, "all") });
      if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
      console.log(rows.length ? rows.map(rowLine).join("\n") : "No open tickets.");
      return;
    }
    if (command === "request") {
      const text = args.join(" ").trim();
      if (!text) throw new Error("Usage: swarm superagent request <text>");
      const { triggerId } = client.request(text);
      console.log(`Filed request ${triggerId.slice(0, 8)}.${lockHolder(client.stateDir) ? "" : " No host runs yet: start one with `swarm superagent run`."}`);
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

async function runHost(): Promise<void> {
  const { SuperagentHost } = await import("./host.js");
  const { OpenAIProvider } = await import("../providers/openai-provider.js");
  const provider = new OpenAIProvider();
  const host = new SuperagentHost({
    workerCommand: selfCommand(),
    complete: ({ purpose, system, user, model }) => provider.generateText({
      model: model ?? provider.workerModel, system: [{ text: system, cache: true }], user,
      responseFormat: "json_object", maxOutputTokens: 4000, usage: { purpose }
    })
  });
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

async function runWorkerCommand(args: string[]): Promise<void> {
  const ticketId = value(args, "ticket");
  const assignmentId = value(args, "assignment");
  if (!ticketId || !assignmentId) throw new Error("Usage: swarm superagent worker --ticket <id> --assignment <id>");
  const { runWorker } = await import("./worker.js");
  process.exitCode = await runWorker({ ticketId, assignmentId, stateDir: superagentStateDir(), deployment: deploymentFromEnv(), entry: selfCommand() });
}

async function runMcpCommand(args: string[]): Promise<void> {
  const ticketId = value(args, "ticket");
  if (!ticketId) throw new Error("Usage: swarm superagent mcp --ticket <id>");
  const { serveTicketTools } = await import("./ticket-tools.js");
  const deployment = deploymentFromEnv();
  const client = new SuperagentClient({ deployment: () => deployment });
  await serveTicketTools(client, ticketId);
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
