/**
 * What a ticket's worker reads and tells about its ticket, wherever it runs. On the node that owns the ticket the worker
 * reads that node's store directly; on a paired node it reaches the owner over the mesh (src/mesh/work-link.ts), whose
 * routes answer with these same functions, so the owner stays the only process that writes its store.
 */
import { liveTicket, runningAssignment, type Ticket, type Trigger, type WorkerReport, type WriteLevel } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { mandateInstructions, sourceTrigger } from "./messages.js";
import { watchedRepository } from "./policy.js";
import { workerPrompt } from "./prompts.js";
import type { Deployment } from "./setup.js";
import { fileReport, type ReportArgs } from "./ticket-tools.js";
import { ticketVariables, variableLines } from "./variables.js";

/** A ticket as its worker reads it at one moment: the ticket and the Triggers the worker reads with it. */
export interface WorkView { ticket: Ticket; triggers: Record<string, Trigger> }
/**
 * How a worker starts: its directory, what is added to its prompt, the commands it may not run, its model for conclusions, and
 * how far its ticket's capability lets it write.
 */
export interface WorkStart { directory: string; prompt: string; blockedCommands: string[]; model?: string; write?: WriteLevel }
/** The arguments after the Swarm entry point that start the worker's ticket tools, and their environment. */
export interface ToolServer { args: string[]; env: Record<string, string> }

export interface WorkLink {
  /** The ticket while it is open and this Assignment runs it; undefined once it does not. */
  view(): Promise<WorkView | undefined>;
  start(): Promise<WorkStart>;
  /** Inputs reached the worker's Session, which takes them into a step at once: delivered and read. */
  delivered(inputIds: readonly string[]): Promise<void>;
  turnEnded(): Promise<void>;
  /** A report the worker files itself, such as failed or waiting. */
  report(report: WorkerReport): Promise<void>;
  /** A report as the report tool files it, with the message it posts to the person. */
  fileReport(args: ReportArgs): Promise<void>;
  readonly tools: ToolServer;
  close(): void;
}

/** The ticket and the Triggers its worker reads: its batch, its waiting Inputs' and a person's latest message. */
export function workView(client: SuperagentClient, ticketId: string, assignmentId: string): WorkView | undefined {
  const ticket = client.store.tickets.get(ticketId);
  if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return undefined;
  const person = [...ticket.inputs].reverse().find((input) => input.kind === "trigger" && input.human && !input.context);
  const ids = new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds, ...person?.kind === "trigger" ? [person.triggerId] : []]);
  for (const input of ticket.inputs) if (input.kind === "trigger" && ticket.undelivered.includes(input.id)) ids.add(input.triggerId);
  const triggers = Object.fromEntries([...ids].flatMap((id) => {
    const trigger = client.store.triggers.get(id);
    return trigger ? [[id, trigger] as const] : [];
  }));
  return { ticket, triggers };
}

/** How the ticket's worker starts in `directory`: its execution variables name that directory. */
export function workStart(client: SuperagentClient, deployment: Deployment, ticket: Ticket, directory: string): WorkStart {
  const settings = client.settings();
  const origin = sourceTrigger({ store: client.store }, ticket);
  const placed: Ticket = { ...ticket, execution: { ...ticket.execution!, directory } };
  const variables = ticketVariables({ deployment, sources: client.sources, settings, ticket: placed, ...(origin ? { trigger: origin } : {}) });
  const sources = [...new Set([origin?.source, ...ticket.channels.map((channel) => channel.source)].filter((value): value is string => !!value))];
  const write = ticket.mandate.capability?.write;
  return {
    directory, blockedCommands: settings.executor.blockedCommands, ...(settings.executor.model ? { model: settings.executor.model } : {}),
    ...(write ? { write } : {}),
    prompt: workerPrompt({ stateDir: client.stateDir, environment: variableLines(variables), mandate: mandateInstructions(ticket.mandate, watchedRepository(settings)), sources,
      github: !!deployment.github, ...(write ? { write } : {}) })
  };
}

export function workDelivered(client: SuperagentClient, ticketId: string, assignmentId: string, inputIds: readonly string[]): void {
  client.engine.inputsDelivered(ticketId, assignmentId, [...inputIds]);
  const triggers = inputIds.filter((id) => client.store.tickets.get(ticketId)?.inputs.find((input) => input.id === id)?.kind === "trigger");
  if (triggers.length) client.engine.inputsRead(ticketId, triggers);
}

/** A worker's link to its ticket in this node's store. */
export function localLink(client: SuperagentClient, deployment: Deployment, ticketId: string, assignmentId: string): WorkLink {
  return {
    view: async () => workView(client, ticketId, assignmentId),
    start: async () => {
      const ticket = client.store.tickets.get(ticketId)!;
      return workStart(client, deployment, ticket, ticket.execution!.directory);
    },
    delivered: async (inputIds) => workDelivered(client, ticketId, assignmentId, inputIds),
    turnEnded: async () => client.engine.turnEnded(ticketId, assignmentId),
    report: async (report) => { client.engine.report(ticketId, report); },
    fileReport: async (args) => { await fileReport(client, ticketId, args); },
    tools: {
      args: ["superagent", "mcp", "--ticket", ticketId],
      env: { SWARM_SUPERAGENT_HOME: client.stateDir, SWARM_SUPERAGENT_DEPLOYMENT: JSON.stringify(deployment) }
    },
    close: () => client.close()
  };
}
