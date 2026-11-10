/**
 * The tools a ticket's worker works with, served to its Swarm coding loop by an MCP server process of its own
 * (`swarm superagent mcp --ticket <id>`): read the ticket's context, acknowledge a request, report, hand a message back,
 * and follow or drop a Thread (from dsh-superagent's app/tools/executor.ts). Each runs as an Engine command, which checks it.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { key, latestReport, liveTicket, reached, threadKey, ticketStage, type Ticket, type Trigger } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { textPage, ticketCard } from "./cards.js";
import { watchedRepository } from "./policy.js";
import { fromName, inputMessage, sourceTrigger, triggerMessage } from "./messages.js";
import { KV } from "./kv.js";
import { chatLog, chatName, chatsOf, findPeople, peopleIn } from "./people.js";
import { noticeChannel, progressDue, stoppedId } from "./notices.js";
import { feishuRef } from "./sources/feishu-trigger.js";
import { feishuRead } from "./sources/feishu-read.js";
import { feishuSettings } from "./sources/feishu.js";
import { readGithub } from "./sources/github-read.js";
import { claimPull, readPull } from "./sources/github-pull.js";
import { githubKind } from "./sources/github.js";
import { sourceContextOf } from "./sources/context.js";
import { IM_WORDS, checkedImText, sameName, wordCount } from "./text.js";

export interface TicketTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

const exec = promisify(execFile);
/** The largest patch a local ticket's ready report sends; a larger change is beyond a ticket kept local. */
export const PATCH_BYTES = 1024 * 1024;
/**
 * A ready report's patch, as the worker's directory gives it: its commits that no remote branch has, their size in bytes (the
 * text is empty beyond `PATCH_BYTES`), and whether tracked files have uncommitted changes.
 */
export const PatchSchema = z.object({ text: z.string().max(PATCH_BYTES), bytes: z.number().int().min(0), uncommitted: z.boolean() }).strict();
export type Patch = z.infer<typeof PatchSchema>;
/** Where the host keeps a local ticket's patch, named after the ticket, which its result carries and a take-over applies. */
export const patchPath = (stateDir: string, ticket: Pick<Ticket, "id" | "execution">): string =>
  join(stateDir, "patches", `${(ticket.execution?.name ?? ticket.id).replace(/[^A-Za-z0-9_-]/g, "_")}.patch`);

/** The patch of the work in `directory`, or undefined where it is no git repository with remote branches to compare with. */
export async function directoryPatch(directory: string): Promise<Patch | undefined> {
  const git = async (...args: string[]) => (await exec("git", args, { cwd: directory, timeout: 60_000, maxBuffer: PATCH_BYTES * 4 })).stdout;
  try {
    if (!(await git("for-each-ref", "--count=1", "refs/remotes")).trim()) return undefined;
    const text = await git("format-patch", "--stdout", "HEAD", "--not", "--remotes");
    const bytes = Buffer.byteLength(text);
    return { text: bytes > PATCH_BYTES ? "" : text, bytes, uncommitted: (await git("status", "--porcelain", "--untracked-files=no")).trim() !== "" };
  } catch {
    return undefined;
  }
}
/** The ticket tools with a ready report that also carries the patch of the worker's directory, which the host keeps for a local ticket. */
export const withPatch = (tools: readonly TicketTool[], directory: string): TicketTool[] => tools.map((tool) => tool.name !== "report" ? tool : {
  ...tool,
  run: async (args) => {
    const patch = args.state === "ready" ? await directoryPatch(directory) : undefined;
    return tool.run({ ...args, ...(patch ? { patch } : {}) });
  }
});

const AcknowledgementSchema = z.string().trim().min(1)
  .refine((text) => wordCount(text) <= IM_WORDS, `At most ${IM_WORDS} words; write one short sentence.`);

/** Whether a ticket's worker may read a Trigger: one that reached it, started it, or is on a Thread it follows. */
const readable = (client: SuperagentClient, ticket: Ticket, trigger: Trigger): boolean =>
  reached(ticket, trigger, (thread) => client.store.threads.get(thread))
  || ticket.origin.triggerIds.includes(trigger.id)
  || trigger.threads.some((ref) => ticket.follows?.some((follow) => follow.thread === threadKey(ref)));

/** How far back, and how many messages, a worker's chat/<chat-id> read goes. */
const CHAT_DAYS = 7, CHAT_MESSAGES = 50;

/** The ticket tools as a worker's model sees them; `ticketTools` runs them on the ticket's store. */
const TOOLS = {
  read: {
    description: "Read one page of a resource of this ticket: ticket/<id> (its card, inputs and latest report), ticket/<id>/assignment, ticket/<id>/input/<id>, trigger/<id>, thread/<key>, github/... as the GitHub section says, or feishu/<trigger-id>/... and chat/<chat-id> as the Feishu section says. Follow next_offset.",
    input: {
      resource: z.string().min(1),
      offset: z.number().int().min(0).default(0).describe("Copy next_offset from the previous page."),
      limit: z.number().int().min(1).max(8000).optional().describe("Characters of the page, 4000 by default.")
    },
    readOnly: true
  },
  people: {
    description: "Who is who on Feishu, from the bot's records: with no arguments, the chats the bot is in; with chat, that chat's people and bots; with name, the people whose name contains it and the chats they are in.",
    input: { chat: z.string().trim().min(1).optional().describe("A chat id from the chat list, such as oc_..."), name: z.string().trim().min(1).max(100).optional() },
    readOnly: true
  },
  ack: {
    description: "Acknowledge one original human request before substantial work, as the Replies section says; it posts as a reply to that message.",
    input: { trigger_id: z.string(), text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`) },
    readOnly: false
  },
  thread_unrelated: {
    description: "Stop following an attached thread that is not about this ticket, as the Work section says; its own threads cannot be dropped.",
    input: { thread: z.string().min(1).describe("The thread key, such as github:<number>."), reason: z.string().trim().min(1).max(300) },
    readOnly: false
  },
  thread_follow: {
    description: "Follow a related thread, such as an Issue or another PR, for context only.",
    input: { thread: z.string().describe("Thread key, such as github:<number>."), reason: z.string().trim().min(1).max(300) },
    readOnly: false
  },
  handback: {
    description: "Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket's to decide.",
    input: { trigger_id: z.string().min(1), reason: z.string().trim().min(1).max(300).describe("One sentence on what it asks for beyond this ticket.") },
    readOnly: false
  },
  report: {
    description: "Report progress, ready, blocked, failed or dropped, as the Work and Handoff sections say. This tool is the only report: your final JSON reaches nobody. With ready, a human_action question or reply_to_trigger_id, `message_for_person` is the one short message the person reads.",
    input: {
      state: z.enum(["progress", "ready", "blocked", "failed", "dropped"]),
      summary: z.string().min(1),
      human_action: z.string().trim().min(1).max(1000).nullish().describe("One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it."),
      question_for_trigger_id: z.string().optional().describe("With human_action: the human message that raised the question, which is asked where that person wrote."),
      pr_number: z.number().int().positive().nullish().describe("The ticket's PR: its source PR, or one by the agent account from a branch named after this ticket (SWARM_TICKET_NAME)."),
      reply_to_trigger_id: z.string().optional().describe("The explicit human question this report answers; never for ordinary progress."),
      message_for_person: z.string().trim().min(1).optional().describe(`What the person reads, at most ${IM_WORDS} words, in the language of the source conversation. `
        + "With progress, one sentence at a milestone they would care about, never for a routine step; the host sends at most one every few minutes.")
    },
    readOnly: false
  }
} satisfies Record<string, Omit<TicketTool, "name" | "run">>;
type ToolName = keyof typeof TOOLS;

const withRuns = (run: (name: ToolName) => TicketTool["run"]): TicketTool[] =>
  (Object.keys(TOOLS) as ToolName[]).map((name) => ({ name, ...TOOLS[name], run: run(name) }));

/** The ticket tools of a worker on another node: the same tools, each run by the node that owns the ticket. */
export const proxiedTicketTools = (call: (name: string, args: Record<string, unknown>) => Promise<unknown>): TicketTool[] =>
  withRuns((name) => (args) => call(name, args));

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
        triggers: client.store.read.threadTriggers(threadId, 50).reverse().map((item) => ({ trigger_id: item.id, from: item.actor.id, ...fromName(item), at: item.at,
          human: item.human, preview: item.text.replace(/\s+/g, " ").slice(0, 160), read: `trigger/${item.id}` })) };
    }
    if (resource.startsWith("chat/")) {
      // Any group the bot is in, and this ticket's own chats; never someone else's direct messages.
      const chatId = resource.slice("chat/".length);
      const direct = client.store.get(KV.feishu.chats)?.[chatId];
      const own = ticket().channels.some((channel) => channel.source === "feishu" && channel.address.chatId === chatId);
      if (!own && direct !== false && chatName(client.store, chatId) === undefined) throw new Error("Unknown chat, or another person's direct messages");
      return { chat: chatId, name: chatName(client.store, chatId) ?? null, messages: chatLog(client.store, chatId,
        { since: new Date(Date.now() - CHAT_DAYS * 86_400_000).toISOString(), limit: CHAT_MESSAGES, chars: 600, self: client.resolvedDeployment()?.feishu?.name ?? "" }) };
    }
    return undefined;
  };
  const runs: Record<ToolName, TicketTool["run"]> = {
    read: async (args) => {
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
    },
    people: async (args) => {
      if (typeof args.name === "string") return { people: findPeople(client.store, args.name) };
      if (typeof args.chat === "string") return { chat: args.chat, name: chatName(client.store, args.chat) ?? null, people: peopleIn(client.store, args.chat, 500) };
      return { chats: chatsOf(client.store) };
    },
    ack: async (args) => {
      const reply = client.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: String(args.trigger_id), text: String(args.text) });
      return { trigger_id: args.trigger_id, acknowledgement: client.store.replyStatus(reply.id) ?? reply.status, reused: reply.reused };
    },
    thread_unrelated: async (args) => {
      client.engine.markUnrelated(ticketId, String(args.thread), String(args.reason));
      return { removed: true, thread: args.thread };
    },
    thread_follow: async (args) => {
      const thread = String(args.thread);
      const at = thread.indexOf(":");
      if (at < 1 || at === thread.length - 1) throw new Error("A thread key is <source>:<id>, such as github:<number>");
      return { followed: client.engine.followForContext(ticketId, { source: thread.slice(0, at), id: thread.slice(at + 1) }), thread };
    },
    handback: async (args) => ({ trigger_id: args.trigger_id, queued: client.engine.handback(ticketId, String(args.trigger_id), String(args.reason)) }),
    report: async (args) => fileReport(client, ticketId, {
      state: args.state as ReportArgs["state"],
      summary: String(args.summary),
      ...(args.human_action === null ? { human_action: null } : typeof args.human_action === "string" ? { human_action: args.human_action } : {}),
      ...(typeof args.question_for_trigger_id === "string" ? { question_for_trigger_id: args.question_for_trigger_id } : {}),
      ...(typeof args.pr_number === "number" ? { pr_number: args.pr_number } : {}),
      ...(typeof args.reply_to_trigger_id === "string" ? { reply_to_trigger_id: args.reply_to_trigger_id } : {}),
      ...(typeof args.message_for_person === "string" ? { message_for_person: args.message_for_person } : {}),
      ...(args.patch ? { patch: PatchSchema.parse(args.patch) } : {})
    })
  };
  return withRuns((name) => runs[name]);
}

export interface ReportArgs {
  state: "progress" | "ready" | "blocked" | "failed" | "dropped";
  summary: string;
  /** A question for a person; null clears an open one, absent keeps it. */
  human_action?: string | null;
  question_for_trigger_id?: string;
  pr_number?: number;
  reply_to_trigger_id?: string;
  message_for_person?: string;
  /** With a ready report, the patch of the worker's directory: see `withPatch`. */
  patch?: Patch;
}

/** What a local ticket's result says when its worker gave no message: the patch is the result. */
const PATCH_RESULT = "The change is ready as the attached patch; nothing was pushed.";

/**
 * Files a worker's report and posts what it says to the person: its question, its ready result or its answer, each under
 * the Engine's reply rules. The report tool and the worker's fallback for an unreported turn both file through it.
 */
export async function fileReport(client: SuperagentClient, ticketId: string, args: ReportArgs) {
  const current = client.store.tickets.get(ticketId);
  if (!current || !liveTicket(current)) throw new Error("Ticket ended (its PR closed or the work finished); do not resume it");
  // A local ticket's result is its commits as a patch, which the host keeps and sends with the result.
  const local = current.mandate.capability?.write === "local" && args.state === "ready" && args.patch ? args.patch : undefined;
  if (local?.uncommitted) throw new Error("Tracked files have uncommitted changes: commit the change on this ticket's branch first, since the person gets its commits as a patch.");
  if (local && local.bytes > PATCH_BYTES) {
    throw new Error(`The commits of this ticket make a patch of ${Math.ceil(local.bytes / 1024)} KB, more than ${PATCH_BYTES / 1024} KB: keep generated and large files out of them.`);
  }
  const attachment = local?.text ? keepPatch(client.stateDir, current, local.text) : undefined;
  const given = args.message_for_person ? checkedImText(args.message_for_person) : undefined;
  const message = given ?? (attachment ? PATCH_RESULT : undefined);
  // The host follows pull requests on the repository the GitHub Source watches; a ticket on another one names its PR in its message.
  const elsewhere = current.mandate.capability?.repository;
  const watched = watchedRepository(client.settings());
  if (args.pr_number && elsewhere && !sameName(elsewhere, watched)) {
    throw new Error(`The host follows pull requests on ${watched || "no repository"} only: omit pr_number for ${elsewhere}, and put the pull request's link in message_for_person.`);
  }
  const github = args.pr_number ? sourceContextOf({
    store: client.store, outbox: client.outbox, engine: client.engine, commands: client.commands, sources: client.sources,
    get deployment() { return client.deployment(); }, ready: Promise.resolve(), configured: () => true, receive: (trigger) => client.engine.receive(trigger)
  }, githubKind) : undefined;
  const pull = github && args.pr_number ? await readPull(github, args.pr_number) : undefined;
  return client.store.atomic(() => {
    const refused = github && pull && claimPull(github, ticketId, pull);
    if (refused) throw new Error(refused);
    const report = {
      state: args.state, summary: args.summary,
      ...(args.human_action !== undefined ? { question: args.human_action } : {}),
      ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
      ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {})
    };
    const updated = client.engine.report(ticketId, report);
    const posted: string[] = [];
    const answering = !!report.answers && !!message && !report.question;
    // An answer posted where the ticket started is its result too, so the person reads the message once, as upstream's main
    // Session sent one; asked elsewhere, both conversations get it.
    const asked = answering ? client.store.triggers.get(report.answers!)?.channel : undefined;
    const origin = sourceTrigger(client, updated)?.channel ?? updated.channels[0];
    const answerIsResult = !!asked && !!origin && asked.source === origin.source && asked.thread === origin.thread;
    // An update at a milestone, and the worker's own words when its work stops, go where the ticket started (notices.ts).
    const notice = !report.question && !report.answers && given ? noticeChannel(client.store, updated) : undefined;
    const at = latestReport(updated)!.at;
    if (report.question && updated.attention) {
      client.engine.reply({ purpose: "attention", ticketId, question: updated.attention.question, text: message ?? updated.attention.question });
      posted.push("attention");
    } else if (notice && report.state === "progress") {
      if (progressDue(client.store, updated)) {
        client.outbox.send({ id: key("progress", ticketId, at), channel: notice, text: given!, kind: "reply", ticketId });
        posted.push("progress");
      }
    } else if (notice && (report.state === "blocked" || report.state === "failed")) {
      client.outbox.send({ id: stoppedId(ticketId, at, report.state), channel: notice, text: given!, kind: "reply", ticketId });
      posted.push("notice");
    } else if (report.state === "ready" && message && !answerIsResult) {
      client.engine.reply({ purpose: "result", ticketId, text: message, ...(attachment ? { attachment } : {}) });
      posted.push("result");
    }
    if (answering) {
      client.engine.reply({ purpose: "answer", ticketId, triggerId: report.answers, text: message, ...(attachment && answerIsResult ? { attachment } : {}) });
      posted.push("answer");
    }
    return { reported: true, posted, ...(updated.attention ? { attention: updated.attention } : {}), ended: !liveTicket(updated) };
  });
}

/** How long the host keeps a local ticket's patch after it last changed. */
export const PATCH_DAYS = 30;
/** Deletes the patches the host kept longer than `PATCH_DAYS`. */
export function prunePatches(stateDir: string, now = Date.now()): void {
  const dir = join(stateDir, "patches");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (now - statSync(path).mtimeMs > PATCH_DAYS * 86_400_000) rmSync(path, { force: true });
  }
}

/** Writes a local ticket's patch where the host keeps it (owner-only), and returns its path. */
function keepPatch(stateDir: string, ticket: Ticket, text: string): string {
  const path = patchPath(stateDir, ticket);
  mkdirSync(join(stateDir, "patches"), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Serves the ticket tools over stdio MCP until the worker's runtime closes the connection. */
export async function serveTicketTools(tools: readonly TicketTool[]): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = new McpServer({ name: "swarm-ticket", version: "1.0.0" });
  for (const tool of tools) {
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
