/**
 * The tools a ticket's worker works with, served to its Swarm coding loop by an MCP server process of its own
 * (`swarm superagent mcp --ticket <id>`): read the ticket's context, acknowledge a request, report, hand a message back,
 * and follow or drop a Thread (from dsh-superagent's app/tools/executor.ts). Each runs as an Engine command, which checks it.
 */
import { z } from "zod/v4";
import { key, latestReport, liveTicket, reached, threadKey, ticketStage, type Ticket, type Trigger } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { textPage, ticketCard } from "./cards.js";
import { inputMessage, triggerMessage } from "./messages.js";
import { feishuRef } from "./sources/feishu-trigger.js";
import { feishuRead } from "./sources/feishu-read.js";
import { feishuSettings } from "./sources/feishu.js";
import { readGithub } from "./sources/github-read.js";
import { claimPull, readPull } from "./sources/github-pull.js";
import { githubKind } from "./sources/github.js";
import { sourceContextOf } from "./sources/context.js";
import { IM_WORDS, checkedImText, wordCount } from "./text.js";

export interface TicketTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

const AcknowledgementSchema = z.string().trim().min(1)
  .refine((text) => wordCount(text) <= IM_WORDS, `At most ${IM_WORDS} words; write one short sentence.`);

/** Whether a ticket's worker may read a Trigger: one that reached it, started it, or is on a Thread it follows. */
const readable = (client: SuperagentClient, ticket: Ticket, trigger: Trigger): boolean =>
  reached(ticket, trigger, (thread) => client.store.threads.get(thread))
  || ticket.origin.triggerIds.includes(trigger.id)
  || trigger.threads.some((ref) => ticket.follows?.some((follow) => follow.thread === threadKey(ref)));

export function ticketTools(client: SuperagentClient, ticketId: string): TicketTool[] {
  const snapshots = new Map<string, string>();
  const ticket = (): Ticket => {
    const found = client.store.tickets.get(ticketId);
    if (!found) throw new Error(`Unknown ticket ${ticketId}`);
    return found;
  };
  const trigger = (id: string): Trigger => {
    const found = client.store.triggers.get(id);
    if (!found || !readable(client, ticket(), found)) throw new Error("This trigger did not reach this ticket");
    return found;
  };
  /** A text page of a resource; offset 0 reads afresh and later offsets the same snapshot. */
  const page = async (resource: string, offset: number, limit: number | undefined, fetch: () => Promise<unknown> | unknown) => {
    const body = offset === 0 ? JSON.stringify(await fetch()) : snapshots.get(resource);
    if (body === undefined) throw new Error("Read this resource from offset 0 first");
    if (offset === 0) snapshots.set(resource, body);
    return textPage(resource, body, offset, Math.min(limit ?? 4000, 8000));
  };
  const read = (resource: string): unknown => {
    const own = `ticket/${ticketId}`;
    if (resource === own) {
      const current = ticket();
      return {
        ...ticketCard(current), stage: ticketStage(current), mandate: { strength: current.mandate.strength, scope: current.mandate.scope, rules: current.mandate.basis.rules ?? [] },
        origin: current.origin.triggerId, follows: current.follows ?? [], latest_report: latestReport(current) ?? null, attention: current.attention ?? null,
        inputs: current.inputs.slice(-20).reverse().map((input) => ({ id: key(input.id), kind: input.kind, at: input.at,
          ...(input.kind === "trigger" ? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` } : {}) }))
      };
    }
    if (resource === `${own}/assignment`) return { assignment: ticket().execution?.assignment ?? "" };
    if (resource.startsWith(`${own}/input/`)) {
      const wanted = resource.slice(`${own}/input/`.length);
      const input = ticket().inputs.find((item) => key(item.id) === wanted);
      if (!input) throw new Error("Unknown input of this ticket");
      const source = input.kind === "trigger" ? client.store.triggers.get(input.triggerId) : undefined;
      return { input: inputMessage(input, source ? triggerMessage(source, source.url ? { source_url: source.url } : {}) : undefined) ?? null };
    }
    if (resource.startsWith("ticket/")) throw new Error("A worker reads only its own ticket");
    if (resource.startsWith("trigger/")) {
      const found = trigger(resource.slice("trigger/".length));
      return { ...triggerMessage(found, found.url ? { source_url: found.url } : {}), text: found.text };
    }
    if (resource.startsWith("thread/")) {
      const threadId = resource.slice("thread/".length);
      const thread = client.store.threads.get(threadId);
      const current = ticket();
      if (!thread || !(thread.subscriptions.includes(ticketId) || current.follows?.some((follow) => follow.thread === threadId))) {
        throw new Error("Unknown thread, or one this ticket does not follow");
      }
      return { thread: threadId, label: thread.meta.label ?? null, url: thread.meta.url ?? null,
        triggers: client.store.read.threadTriggers(threadId, 50).reverse().map((item) => ({ trigger_id: item.id, from: item.actor.id, at: item.at,
          human: item.human, preview: item.text.replace(/\s+/g, " ").slice(0, 160), read: `trigger/${item.id}` })) };
    }
    return undefined;
  };
  return [
    {
      name: "read",
      description: "Read one page of a resource of this ticket: ticket/<id> (its card, inputs and latest report), ticket/<id>/assignment, ticket/<id>/input/<id>, trigger/<id>, thread/<key>, github/... as the GitHub section says, or feishu/<trigger-id>/... as the Feishu section says. Follow next_offset.",
      input: {
        resource: z.string().min(1),
        offset: z.number().int().min(0).default(0).describe("Copy next_offset from the previous page."),
        limit: z.number().int().min(1).max(8000).optional().describe("Characters of the page, 4000 by default.")
      },
      readOnly: true,
      run: async (args) => {
        const resource = String(args.resource);
        const offset = Number(args.offset ?? 0);
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        if (resource.startsWith("github/")) return page(resource, offset, limit, () => readGithub(client.commands, resource));
        if (resource.startsWith("feishu/")) {
          const source = trigger(resource.slice("feishu/".length).split("/")[0]!);
          const ref = feishuRef(source);
          if (!ref) throw new Error("A Feishu source trigger is required");
          return page(resource, offset, limit, () => feishuRead(client.commands, ref, resource, feishuSettings(client.sources).readPageSize));
        }
        const found = read(resource);
        if (found === undefined) throw new Error("Unknown resource");
        return page(resource, offset, limit, () => found);
      }
    },
    {
      name: "ack",
      description: "Acknowledge one original human request before substantial work, as the Replies section says; it posts as a reply to that message.",
      input: { trigger_id: z.string(), text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`) },
      readOnly: false,
      run: async (args) => {
        const reply = client.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: String(args.trigger_id), text: String(args.text) });
        return { trigger_id: args.trigger_id, acknowledgement: client.store.replyStatus(reply.id) ?? reply.status, reused: reply.reused };
      }
    },
    {
      name: "thread_unrelated",
      description: "Stop following an attached thread that is not about this ticket, as the Work section says; its own threads cannot be dropped.",
      input: { thread: z.string().min(1).describe("The thread key, such as github:<number>."), reason: z.string().trim().min(1).max(300) },
      readOnly: false,
      run: async (args) => {
        client.engine.markUnrelated(ticketId, String(args.thread), String(args.reason));
        return { removed: true, thread: args.thread };
      }
    },
    {
      name: "thread_follow",
      description: "Follow a related thread, such as an Issue or another PR, for context only.",
      input: { thread: z.string().describe("Thread key, such as github:<number>."), reason: z.string().trim().min(1).max(300) },
      readOnly: false,
      run: async (args) => {
        const thread = String(args.thread);
        const at = thread.indexOf(":");
        if (at < 1 || at === thread.length - 1) throw new Error("A thread key is <source>:<id>, such as github:<number>");
        return { followed: client.engine.followForContext(ticketId, { source: thread.slice(0, at), id: thread.slice(at + 1) }), thread };
      }
    },
    {
      name: "handback",
      description: "Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket's to decide.",
      input: { trigger_id: z.string().min(1), reason: z.string().trim().min(1).max(300).describe("One sentence on what it asks for beyond this ticket.") },
      readOnly: false,
      run: async (args) => ({ trigger_id: args.trigger_id, queued: client.engine.handback(ticketId, String(args.trigger_id), String(args.reason)) })
    },
    {
      name: "report",
      description: "Report progress, ready, blocked, failed or dropped, as the Work and Handoff sections say. With ready, a human_action question or reply_to_trigger_id, `message` is the one short message the person reads.",
      input: {
        state: z.enum(["progress", "ready", "blocked", "failed", "dropped"]),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe("One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it."),
        question_for_trigger_id: z.string().optional().describe("With human_action: the human message that raised the question, which is asked where that person wrote."),
        pr_number: z.number().int().positive().nullish().describe("The ticket's PR: its source PR, or one by the agent account from a branch named after this ticket (SWARM_TICKET_NAME)."),
        reply_to_trigger_id: z.string().optional().describe("The explicit human question this report answers; never for ordinary progress."),
        message: z.string().trim().min(1).optional().describe(`What the person reads, at most ${IM_WORDS} words, in the language of the source conversation.`)
      },
      readOnly: false,
      run: async (args) => {
        const current = ticket();
        if (!liveTicket(current)) throw new Error("Ticket ended (its PR closed or the work finished); do not resume it");
        const message = typeof args.message === "string" ? checkedImText(args.message) : undefined;
        const prNumber = typeof args.pr_number === "number" ? args.pr_number : undefined;
        const github = prNumber ? sourceContextOf({
          store: client.store, outbox: client.outbox, engine: client.engine, commands: client.commands, sources: client.sources,
          get deployment() { return client.deployment(); }, ready: Promise.resolve(), configured: () => true, receive: (trigger) => client.engine.receive(trigger)
        }, githubKind) : undefined;
        const pull = github && prNumber ? await readPull(github, prNumber) : undefined;
        const question = args.human_action === null ? null : typeof args.human_action === "string" ? args.human_action : undefined;
        return client.store.atomic(() => {
          const refused = github && pull && claimPull(github, ticketId, pull);
          if (refused) throw new Error(refused);
          const report = {
            state: args.state as "progress" | "ready" | "blocked" | "failed" | "dropped", summary: String(args.summary),
            ...(question !== undefined ? { question } : {}),
            ...(typeof args.question_for_trigger_id === "string" ? { askedBy: args.question_for_trigger_id } : {}),
            ...(typeof args.reply_to_trigger_id === "string" ? { answers: args.reply_to_trigger_id } : {})
          };
          const updated = client.engine.report(ticketId, report);
          const posted: string[] = [];
          if (report.question && updated.attention) {
            client.engine.reply({ purpose: "attention", ticketId, question: updated.attention.question, text: message ?? updated.attention.question });
            posted.push("attention");
          } else if (report.state === "ready" && message) {
            client.engine.reply({ purpose: "result", ticketId, text: message });
            posted.push("result");
          }
          if (report.answers && message && !report.question) {
            client.engine.reply({ purpose: "answer", ticketId, triggerId: report.answers, text: message });
            posted.push("answer");
          }
          return { reported: true, posted, ...(updated.attention ? { attention: updated.attention } : {}), ended: !liveTicket(updated) };
        });
      }
    }
  ];
}

/** Serves the ticket tools over stdio MCP until the worker's runtime closes the connection. */
export async function serveTicketTools(client: SuperagentClient, ticketId: string): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = new McpServer({ name: "swarm-ticket", version: "1.0.0" });
  for (const tool of ticketTools(client, ticketId)) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false }
    }, async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await tool.run(args)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}
