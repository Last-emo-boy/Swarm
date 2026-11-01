/**
 * A ticket's worker process: Swarm's coding loop on the ticket's Work Kernel session, in the ticket's directory, with the
 * ticket's tools served by `swarm superagent mcp`. It runs turns while Inputs wait for it and exits once its turn ends with
 * nothing left, so an idle ticket holds no process. A person's message that arrives during a turn reaches the loop as a
 * live message at its next step, as upstream's 5-second shell limit let a DSH worker take one.
 */
import { createLocalPolicy } from "../runtime/policy-configuration.js";
import type { SwarmSession } from "../protocol/types.js";
import type { ExecutionResult } from "../runtime/orchestrator.js";
import { listBackgroundProcesses } from "../tools/background-processes.js";
import { latestReport, liveTicket, runningAssignment, waitsForPerson, type Ticket } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { batchLine, batchOf, inputMessage, inputResource, mandateInstructions, sourceTrigger, transient, triggerMessage,
  workerSessionId } from "./messages.js";
import { workerPrompt } from "./prompts.js";
import type { Deployment } from "./setup.js";
import { ticketVariables, variableLines } from "./variables.js";

const ASSIGNMENT_CHARS = 1500;
const DELIVERY_POLL_MS = 2000;
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000;
/** How long a worker's background processes may run on after its turn ended before it reports waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000;
const RETRIED = "A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.";

export interface WorkerOptions {
  ticketId: string;
  assignmentId: string;
  stateDir: string;
  deployment: Deployment;
  /** How to start the ticket tools' MCP server: the Node binary and the Swarm entry point. */
  entry: readonly string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read };

/** Whether the worker handed off to a person: its result, a question or a blocked/failed report, with nothing delivered since. */
function handedOff(ticket: Ticket): boolean {
  const assignment = runningAssignment(ticket);
  const report = assignment?.report;
  const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at;
  return ((report?.state === "ready" || !!ticket.attention) && !since) || waitsForPerson(ticket);
}

export async function runWorker(options: WorkerOptions): Promise<number> {
  const { ticketId, assignmentId } = options;
  const client = new SuperagentClient({ stateDir: options.stateDir, deployment: () => options.deployment });
  const current = (): Ticket | undefined => {
    const ticket = client.store.tickets.get(ticketId);
    return ticket && liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined;
  };
  const start = current();
  if (!start) { client.close(); return 0; }
  const directory = start.execution!.directory;
  const sessionId = workerSessionId(ticketId);
  const settings = client.settings();
  const origin = sourceTrigger({ store: client.store }, start);
  const variables = ticketVariables({ deployment: options.deployment, sources: client.sources, settings, ticket: start, ...(origin ? { trigger: origin } : {}) });
  const sources = [...new Set([origin?.source, ...start.channels.map((channel) => channel.source)].filter((value): value is string => !!value))];
  const appendSystemPrompt = workerPrompt({ stateDir: client.stateDir, environment: variableLines(variables), mandate: mandateInstructions(start.mandate), sources });

  const [node, ...entry] = options.entry;
  const { SwarmRuntime } = await import("../runtime/runtime.js");
  const runtime = new SwarmRuntime({
    workspace: directory,
    mcpConfig: { sources: [{ source: "json", bytes: 0, serverIds: ["ticket"], servers: { ticket: {
      transport: "stdio", command: node!, args: [...entry, "superagent", "mcp", "--ticket", ticketId], trust: "user", alwaysLoad: true,
      env: { SWARM_SUPERAGENT_HOME: client.stateDir, SWARM_SUPERAGENT_DEPLOYMENT: JSON.stringify(options.deployment) },
      toolRiskOverrides: { read: "r0", ack: "r1", report: "r1", handback: "r1", thread_follow: "r1", thread_unrelated: "r1" },
      timeoutMs: 120_000
    } } }] },
    approvalHandler: async (request) => {
      throw new Error(`This ticket's worker runs unattended, and ${request.summary} needs a person's approval. Choose another way, or report blocked with human_action naming the approval it needs.`);
    }
  });
  for (const name of settings.executor.blockedCommands) runtime.settings.permissions.deny.push(`Bash(${name})`, `Bash(${name} *)`);
  // Without its tools a worker can neither report nor reply, so it fails at once with why rather than run blind.
  const tools = await runtime.listCapabilities({ modelVisible: true });
  if (!tools.some((tool) => tool.name === "mcp__ticket__report" && tool.status === "available")) {
    const servers = runtime.listMcpServers();
    const ticketServer = servers.find((server) => server.id === "ticket");
    const why = ticketServer?.diagnostics?.map((item) => item.message).join("; ") || ticketServer?.status || "the ticket tools server did not start";
    runtime.dispose();
    client.engine.report(ticketId, { state: "failed", summary: `The worker's ticket tools are unavailable: ${why}` });
    client.close();
    return 0;
  }
  if (!runtime.sessionStore.get(sessionId)) {
    const lease = runtime.workspaceLeaseStore.createForLocalSession({ session_id: sessionId, workspace: directory });
    const now = new Date().toISOString();
    const session: SwarmSession = {
      swarm_id: `swarm_${sessionId}`, session_id: sessionId, user_request_id: ticketId,
      source: { source: "superagent", source_id: ticketId, human_id: start.execution?.name ?? ticketId, title: start.title, labels: ["superagent", "ticket"],
        state: "active", metadata: { ticket_id: ticketId, mode: "superagent_worker" } },
      workspace_lease_id: lease.lease_id, objective: start.title, status: "running",
      coordinator: { agent_id: "superagent", role: "ticket-worker" }, participants: [], created_at: now, updated_at: now,
      policy: createLocalPolicy(runtime.settings)
    };
    runtime.sessionStore.createIfMissing(session);
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    runtime.requestStopActiveWork("The ticket's host stopped this worker.");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  /** The first message of this Assignment: the whole assignment on a ticket's first, what is new on a later one. */
  const assignmentMessage = (ticket: Ticket): string | undefined => {
    const assignment = runningAssignment(ticket)!;
    if (assignment.deliveredAt) return undefined;
    const later = ticket.assignments.length > 1;
    const retried = ticket.assignments.at(-2)?.endedReason === "retried" ? { note: RETRIED } : {};
    if (later) return JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried });
    const source = sourceTrigger({ store: client.store }, ticket);
    const brief = capped(ticket.execution?.assignment ?? "", ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`);
    const batch = batchOf({ store: client.store }, ticket).map(batchLine);
    return JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief.text ? { assignment: brief.text } : {}),
      ...("read" in brief ? { assignment_chars: brief.chars, assignment_read: brief.read } : {}),
      ...(source ? { trigger: triggerMessage(source, source.url ? { source_url: source.url } : {}) } : {}),
      ...(batch.length ? { batch } : {}), ...retried });
  };
  /** Waiting Inputs as the worker reads them, each with its id. */
  const waiting = (ticket: Ticket, skip: ReadonlySet<string>) => ticket.undelivered.filter((id) => !skip.has(id)).flatMap((id) => {
    const input = ticket.inputs.find((item) => item.id === id);
    if (!input) return [];
    const source = input.kind === "trigger" ? client.store.triggers.get(input.triggerId) : undefined;
    const note = input.kind === "trigger" ? input.note : undefined;
    const message = inputMessage(input, source ? triggerMessage(source, source.url ? { source_url: source.url } : {}, note) : undefined);
    if (message === undefined) return [];
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message;
    return [{ id, text, trigger: input.kind === "trigger" }];
  });

  let exitCode = 0;
  let tries = 0;
  let retryNote: string | undefined;
  try {
    for (;;) {
      const ticket = current();
      if (!ticket || stopping) break;
      const first = assignmentMessage(ticket);
      const inputs = waiting(ticket, new Set());
      if (!first && !inputs.length && !retryNote) break;
      const prompt = [first, ...inputs.map((input) => input.text), retryNote].filter(Boolean).join("\n\n");
      retryNote = undefined;
      const delivered = new Set(inputs.map((input) => input.id));
      client.engine.inputsDelivered(ticketId, assignmentId, [...delivered]);
      let result: ExecutionResult | undefined;
      const live = setInterval(() => {
        const now = current();
        if (!now) return;
        for (const input of waiting(now, delivered)) {
          void runtime.sendUserMessage(input.text, { sessionId, source: "superagent", sourceId: input.id }).then(() => {
            delivered.add(input.id);
            client.engine.inputsDelivered(ticketId, assignmentId, [input.id]);
          }, () => { /* Between steps there is no live target; the next turn takes it. */ });
        }
      }, DELIVERY_POLL_MS);
      try {
        result = await runtime.executeWorkSession({ session_id: sessionId, prompt, workspace_path: directory, appendSystemPrompt });
        tries = 0;
      } catch (error) {
        if (transient(error) && tries < TRANSIENT_TRIES && !stopping) {
          tries += 1;
          await sleep(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1));
          retryNote = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`;
          continue;
        }
        throw error;
      } finally {
        clearInterval(live);
      }
      const reads = [...delivered].filter((id) => client.store.tickets.get(ticketId)?.inputs.find((input) => input.id === id)?.kind === "trigger");
      if (reads.length) client.engine.inputsRead(ticketId, reads);
      if (stopping || !current()) break;
      const after = current()!;
      if (handedOff(after)) { client.engine.turnEnded(ticketId, assignmentId); break; }
      // Background processes the turn left running hold the ticket's slot until they end, for at most the limit.
      const ended = await settleBackground(sessionId, () => stopping || !current());
      if (stopping || !current()) break;
      if (ended.length) retryNote = `Your background processes ended: ${ended.join(", ")}. Read their output with the process tools.`;
      client.engine.turnEnded(ticketId, assignmentId);
      const next = current()!;
      if (retryNote || waiting(next, new Set()).length) continue;
      if (!handedOff(next)) {
        const said = (result?.outcome?.final_summary ?? result?.content ?? "").trim().slice(0, 4000);
        const before = latestReport(next)?.summary ?? "";
        client.engine.report(ticketId, { state: "waiting", summary: said || before || "The worker ended its turn without a status report." });
      }
      break;
    }
  } catch (error) {
    const ticket = current();
    if (ticket && !stopping) client.engine.report(ticketId, { state: "failed", summary: `The worker failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000) });
    else exitCode = stopping ? 0 : 1;
  } finally {
    try { runtime.dispose(); } catch { /* The process exits next; a failed cleanup changes nothing the ticket records. */ }
    client.close();
  }
  return exitCode;
}

/** Waits until the session's background processes end, for at most the limit; returns the ones that ended meanwhile. */
async function settleBackground(sessionId: string, stopped: () => boolean): Promise<string[]> {
  const running = async () => (await listBackgroundProcesses({ sessionId }).catch(() => [])).filter((process) => process.status === "running");
  const first = await running();
  if (!first.length) return [];
  const deadline = Date.now() + BACKGROUND_LIMIT_MS;
  while (Date.now() < deadline && !stopped()) {
    await sleep(5000);
    if (!(await running()).length) break;
  }
  const still = new Set((await running()).map((process) => process.processId));
  return first.filter((process) => !still.has(process.processId)).map((process) => `${process.processId} (${process.command.slice(0, 60)})`);
}
