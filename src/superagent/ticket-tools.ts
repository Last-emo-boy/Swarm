/**
 * The tools a ticket's worker works with, served to its Swarm coding loop by an MCP server process of its own
 * (`swarm superagent mcp --ticket <id>`): read the ticket's context, acknowledge a request, report, hand a message back,
 * and follow or drop a Thread (from dsh-superagent's app/tools/executor.ts). Each runs as an Engine command, which checks it.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { CHECK_BACK_MAX_MINUTES, CHECK_BACK_MIN_MINUTES, UserError, key, latestAssignment, latestReport, liveTicket, reached, runningAssignment, threadKey, ticketStage, type Ticket, type TicketInput, type Trigger } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import type { SourceRegistry } from "./sources/registry.js";
import { textPage, ticketCard } from "./cards.js";
import { seesNodes, watchedRepository } from "./policy.js";
import { fromName, inputMessage, sourceTrigger, triggerMessage } from "./messages.js";
import { KV } from "./kv.js";
import { devicesCard } from "./devices.js";
import { workerView } from "../directory/render.js";
import { DIRECTORY_SCHEMA } from "../directory/types.js";
import { workerNode } from "./placement.js";
import { callLent, lentByPeers } from "../mesh/borrow.js";
import { addressee, channelTo, chatGroups, chatLog, chatName, findPeople, mentionsFor, peopleIn } from "./people.js";
import { feishuChatKind } from "./sources/feishu-chat.js";
import { SOURCE as FEISHU } from "./sources/feishu-trigger.js";
import { metaOf } from "./sources/meta.js";
import { NOTE_CHARS, NOTE_KINDS, SELF, applyOps, chatSubject, memoryOf, noteLine, notesCard, personSubject, subjectsOf, type NoteKind } from "./memories.js";
import { noticeChannel, progressDue, stoppedId } from "./notices.js";
import { TEXT_CHARS } from "./sources/feishu-attachment.js";
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
/** The lent tools a read-only ticket may call on a paired node: they read, and nothing else a node lends does. */
const MESH_READS: ReadonlySet<string> = new Set(["list_files", "read_file"]);
/** Why the mesh tool gives a worker for a requester below maintainer counts of the paired nodes and reaches none of them. */
const MESH_HIDDEN = "Only maintainers' and owners' tickets see the paired nodes and use what they lend: this ticket's requester gets counts, so do the work here";
/** The largest patch a local ticket's ready report sends; a larger change is beyond a ticket kept local. */
export const PATCH_BYTES = 1024 * 1024;
/**
 * A report's patch, as the worker's directory gives it: its commits that no remote branch has, their size in bytes (the
 * text is empty beyond `PATCH_BYTES`), and whether tracked files have uncommitted changes.
 */
export const PatchSchema = z.object({ text: z.string().max(PATCH_BYTES), bytes: z.number().int().min(0), uncommitted: z.boolean() }).strict();
export type Patch = z.infer<typeof PatchSchema>;
/** Where the host keeps a ticket's patch, named after the ticket: a local ticket's result carries it and a take-over applies it. */
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
/** The largest report of stopped work that carries its patch: a ticket VM's gateway and a paired node's owner read a request of 1,000,000 bytes at most. */
export const STOPPED_REPORT_BYTES = 950_000;
/**
 * The ticket tools with a report that also carries the patch of the worker's directory when it is ready, blocked or failed:
 * the host keeps a local ticket's as its result, and that of work that stopped so its commits outlast its directory. Work
 * that stopped must still be reported, so a patch that would make its report too large to send goes without its text, as
 * one over `PATCH_BYTES` does.
 */
export const withPatch = (tools: readonly TicketTool[], directory: string): TicketTool[] => tools.map((tool) => tool.name !== "report" ? tool : {
  ...tool,
  run: async (args) => {
    const patch = ["ready", "blocked", "failed"].includes(String(args.state)) ? await directoryPatch(directory) : undefined;
    const fits = args.state === "ready" || !patch || Buffer.byteLength(JSON.stringify({ ...args, patch })) <= STOPPED_REPORT_BYTES;
    return tool.run({ ...args, ...(patch ? { patch: fits ? patch : { ...patch, text: "" } } : {}) });
  }
});

/** Where a worker's ticket tools save the attachments it reads: in its directory, out of git's way. */
export const ATTACHMENTS_DIR = ".swarm-attachments";
/**
 * The ticket tools with an attachment read that saves the file into the worker's directory, where its own tools reach it,
 * rather than handing its model the bytes: the host runs the read and passes the bytes on wherever the worker runs.
 */
export const withAttachments = (tools: readonly TicketTool[], directory: string): TicketTool[] => tools.map((tool) => tool.name !== "attachment" ? tool : {
  ...tool,
  run: async (args) => {
    const result = await tool.run(args) as { base64?: unknown; temp_path?: unknown; file_key?: unknown; name?: unknown };
    if (typeof result?.base64 === "string") {
      const { base64, ...read } = result;
      return { ...read, saved_to: saveAttachment(directory, String(read.file_key), String(read.name), Buffer.from(base64, "base64")) };
    }
    // A file too big to pass on as bytes is still saved where the worker's own tools reach it.
    if (typeof result?.temp_path === "string") {
      const { temp_path, ...read } = result;
      const saved = saveAttachment(directory, String(read.file_key), String(read.name), readFileSync(temp_path));
      rmSync(dirname(temp_path), { recursive: true, force: true });
      return { ...read, saved_to: saved };
    }
    return result;
  }
});
/** Writes an attachment as `<directory>/.swarm-attachments/<file key>/<its name>`, and returns its path. */
function saveAttachment(directory: string, fileKey: string, name: string, data: Buffer): string {
  const root = join(directory, ATTACHMENTS_DIR);
  const safeKey = fileKey.replace(/[^A-Za-z0-9_-]/g, "_");
  mkdirSync(join(root, safeKey), { recursive: true });
  // It keeps everything in it, itself too, out of the ticket's commits.
  writeFileSync(join(root, ".gitignore"), "*\n");
  const file = basename(name).replace(/[\u0000-\u001f\\/]/g, "_");
  const path = join(root, safeKey, file === "" || file === "." || file === ".." ? safeKey : file);
  writeFileSync(path, data);
  return path;
}

const AcknowledgementSchema = z.string().trim().min(1)
  .refine((text) => wordCount(text) <= IM_WORDS, `At most ${IM_WORDS} words; write one short sentence.`);

/**
 * Whether a ticket's worker may read a Trigger: one that reached it, started it, is on a Thread it follows, or was said in a
 * chat the ticket already answers in — a ticket about a chat reads what people put there, mention or not.
 */
const readable = (client: SuperagentClient, ticket: Ticket, trigger: Trigger): boolean =>
  reached(ticket, trigger, (thread) => client.store.threads.get(thread))
  || ticket.origin.triggerIds.includes(trigger.id)
  || trigger.threads.some((ref) => ticket.follows?.some((follow) => follow.thread === threadKey(ref)))
  || sameChat(ticket, trigger);
/** Whether `trigger` was said in a chat one of the ticket's channels answers in. */
const sameChat = (ticket: Ticket, trigger: Trigger): boolean => {
  const chatId = typeof trigger.meta.chatId === "string" ? trigger.meta.chatId : undefined;
  return chatId !== undefined && ticket.channels.some((channel) => channel.source === trigger.source && channel.address.chatId === chatId);
};

/** How far back, and how many messages, a worker's chat/<chat-id> read goes. */
const CHAT_DAYS = 7, CHAT_MESSAGES = 50;
/** How many notes one recall returns. */
const RECALLED = 30;
/** The subjects a ticket's worker names: its requester, a person by id, the ticket's chat, or the agent itself. */
const subjectFor = (sources: SourceRegistry, origin: Trigger | undefined) => (name: string): string | undefined => {
  const meta = origin ? metaOf(origin) : undefined;
  const chatId = meta && !meta.direct ? meta.chatId : undefined;
  const chatSource = chatId && origin ? origin.source : undefined;
  if (name === SELF) return SELF;
  if (name === "chat") return chatId ? chatSubject(chatId, chatSource) : undefined;
  if (name === "requester") return origin && sources.chatKind(origin.source) ? personSubject(origin.actor.id, origin.source) : undefined;
  // An id names its own Source through the kind whose directory holds it; one no installed kind knows is nobody here.
  const person = sources.sourceOfPerson(name);
  if (person) return personSubject(name, person);
  const chat = sources.sourceOfChat(name);
  return chat ? chatSubject(name, chat) : undefined;
};
/** The longest a command a ticket's worker runs on a paired node may take: within the 110 seconds a ticket tool may. */
const MESH_SHELL_MS = 100_000;
/** How much of each call's arguments, and how many calls, a ticket keeps for the record. */
const MESH_ARGS_CHARS = 500, MESH_CALLS_KEPT = 100;
/** How many messages to people a ticket's worker may send in an hour. */
const MESSAGES_PER_HOUR = 10;

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
  attachment: {
    description: `Read a file or image someone attached to a message this ticket can read: without file_key, the message's attachments; with one, that file, downloaded by the host and saved into your directory (saved_to), with its text where the host can extract it (plain text, Markdown, JSON, CSV, HTML, .docx, PDF), cut to its first ${TEXT_CHARS} characters. You see an image only if your model takes images.`,
    input: {
      trigger_id: z.string().min(1).describe("The message's trigger_id, as your messages and trigger/<id> reads give it"),
      file_key: z.string().trim().min(1).max(200).optional().describe("A key from the message's attachments, such as file_v3_... or img_v3_...")
    },
    readOnly: false
  },
  people: {
    description: "Who is who on Feishu, from the bot's records: with no arguments, the chats the bot is in; with chat, that chat's people and bots; with name, the people whose name contains it and the chats they are in.",
    input: { chat: z.string().trim().min(1).optional().describe("A chat id from the chat list, such as oc_..."), name: z.string().trim().min(1).max(100).optional() },
    readOnly: true
  },
  devices: {
    description: "What the agent runs tickets' work on now, from the host's records: its own node, its paired nodes with what each runs, and how many ticket workers are free. Answer questions about the agent's devices or mesh from it: where you run, such as a ticket VM, `swarm mesh` shows only that machine.",
    input: {},
    readOnly: true
  },
  directory: {
    description: "Who can do what in the agent's swarm now, from the host's records: this node and its paired nodes with their free ticket workers, whether each takes work, the tools each lends by the names mesh takes with that node's name, the grant each gives this node and what it may ask there, and why a harness does not run there; the agent harnesses and where each runs; tool servers, Sources and model providers that are not ready; and the commands people can send. Read it before using mesh, and to answer what the agent can run where; devices gives the shorter list of machines.",
    input: {},
    readOnly: true
  },
  mesh: {
    description: "Use what the agent's paired devices lend, through the host's mesh, wherever you run: without node, each paired node, whether it answers, and what it lends (a shell and file access in some folders); with node and tool, call that tool there with args: shell {command, cwd?, timeout_ms?}, list_files {path?}, read_file {path, offset?} or write_file {path, content}. A shell command stops after at most 100 seconds; a read-only ticket may only list_files and read_file, and a ticket whose requester is below maintainer only learns how many nodes there are. What you run acts on that machine for real, as the user it lends as, and every call is recorded on this ticket.",
    input: {
      node: z.string().trim().min(1).max(64).optional().describe("A paired node's name, as the list gives it"),
      tool: z.string().trim().min(1).max(64).optional().describe("A tool that node lends: shell, list_files, read_file or write_file"),
      args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments")
    },
    readOnly: false
  },
  message: {
    description: "Send a message on Feishu to someone other than this ticket's requester, as a direct message, or into a chat the bot is in: to tell or ask them something for this ticket. The requester's own updates and answers go with report.",
    input: {
      to: z.string().trim().min(1).max(200).describe("A person's id or name, or a chat's id or name, as the people tool lists them."),
      text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words, in the language its reader uses; say who it is for when it is on someone's behalf.`),
      mentions: z.array(z.string().trim().min(1).max(64)).max(10).optional().describe("Ids of people to @, each written as @name in the text; all for everyone in the chat, only when asked.")
    },
    readOnly: false
  },
  remember: {
    description: "Keep a note for later conversations and tickets, as the Memory section says: about the requester, a person by id, this ticket's chat, or yourself.",
    input: {
      about: z.string().trim().min(1).max(100).describe("requester, a person's id such as ou_..., chat, or self"),
      kind: z.enum(NOTE_KINDS).default("fact"),
      text: z.string().trim().min(1).max(NOTE_CHARS),
      due: z.string().optional().describe("Promises only: when it falls due, an ISO time with its offset")
    },
    readOnly: false
  },
  recall: {
    description: "Look up what you remember: notes whose text contains query, the notes about one subject (requester, a person's id, chat or self), or without either, about this ticket's requester, chat and yourself.",
    input: { query: z.string().trim().min(1).max(100).optional(), about: z.string().trim().min(1).max(100).optional() },
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
  },
  check_back: {
    description: "Ask this ticket to wake you later, when you wait for something outside Swarm that will change on its own: a CI run, a review, someone's reply elsewhere. Report progress or waiting now, then leave one; the host wakes this ticket then, from its own clock, and your next turn starts with the note.",
    input: {
      after_minutes: z.number().int().min(CHECK_BACK_MIN_MINUTES).max(CHECK_BACK_MAX_MINUTES)
        .describe("From now, in minutes; the host sets the time by its own clock, wherever you run."),
      note: z.string().trim().min(1).max(300).describe("Why you want to be woken, so the next turn knows what it waited for.")
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

/**
 * The ticket tools of a worker. `assignmentId` names the Assignment the caller runs it for, which only the node that
 * started the worker knows: the tools read it from the worker's command line, so a worker process whose Assignment was
 * replaced cannot write to the ticket the newer one runs.
 */
export function ticketTools(client: SuperagentClient, ticketId: string, assignmentId?: string): TicketTool[] {
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
        origin: current.origin.triggerId, follows: current.follows ?? [], latest_report: latestReport(current) ?? null, attention: current.attention ?? null, check_back: current.checkBack ?? null,
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
      const source = client.sources.sourceOfChat(chatId) ?? FEISHU;
      const known = chatGroups(client.store, client.sources.chatKind(source) ?? feishuChatKind).find((chat) => chat.chat_id === chatId);
      const own = ticket().channels.some((channel) => channel.source === source && channel.address.chatId === chatId);
      // A known group is anyone's to read; a direct chat only this ticket's, and then only with no one else's id.
      if (!own && (known === undefined || known.direct)) throw new Error("Unknown chat, or another person's direct messages");
      return { chat: chatId, name: chatName(client.store, chatId, source) ?? null, messages: chatLog(client.store, chatId,
        { since: new Date(Date.now() - CHAT_DAYS * 86_400_000).toISOString(), limit: CHAT_MESSAGES, chars: 600, self: client.sources.agent(source, client.resolvedDeployment())?.name ?? "" }, source) };
    }
    return undefined;
  };
  const runs: Record<ToolName, TicketTool["run"]> = {
    read: async (args) => {
      const resource = String(args.resource);
      const offset = Number(args.offset ?? 0);
      const limit = args.limit === undefined ? undefined : Number(args.limit);
      if (resource.startsWith("github/")) return page(resource, offset, limit, () => readGithub(client.commands, resource));
      // A kind's own resource reads (such as feishu/<trigger-id>/thread) route by the prefix it declares; the trigger the
      // resource names must be one this ticket may read, and a prefix whose kind has no files falls through as unknown.
      const [prefix, named] = resource.split("/", 2);
      const source = named ? client.store.triggers.get(named) : undefined;
      const files = source && prefix === client.sources.files(source.source)?.prefix ? client.sources.files(source.source) : undefined;
      if (files) return page(resource, offset, limit, () => files.readResource(client.commands, trigger(named!), resource));
      const found = read(resource);
      if (found === undefined) throw new Error("Unknown resource");
      return page(resource, offset, limit, () => found);
    },
    attachment: async (args) => {
      const named = trigger(String(args.trigger_id));
      const files = client.sources.files(named.source);
      if (!files) throw new Error(`${client.sources.chatKind(named.source)?.platform ?? named.source} messages have no attachments this worker can read`);
      // A reply often carries no file itself: the file is on the message it answers, when this worker may read that one too.
      const replied = client.sources.repliesTo(named);
      const parent = replied === undefined ? undefined : client.store.triggers.get(replied);
      const onParent = !files.attachments(named).length && !!parent && readable(client, ticket(), parent);
      const source = onParent ? parent! : named;
      const attachments = files.attachments(source);
      const fromParent = source.id !== named.id;
      if (typeof args.file_key !== "string") return { trigger_id: named.id, ...(fromParent ? { read_from: source.id, note: "This message carries no file of its own: these are the ones on the message it replies to." } : {}),
        attachments, ...(attachments.length || fromParent ? {} : { note: "This message has no file or image" }) };
      const attachment = attachments.find((item) => item.file_key === args.file_key);
      if (!attachment) throw new Error(`${args.file_key} is not attached to ${fromParent ? `the message it replies to (${source.id})` : "this message"}: list its attachments without file_key`);
      return { trigger_id: source.id, ...await files.read(client.commands, source, attachment) };
    },
    devices: async () => {
      const snapshot = client.store.get(KV.host.devices);
      if (!snapshot) throw new Error("The host has not read its devices yet: try again in a minute");
      // Which nodes these are is for a requester who may see them, as /devices tells them.
      const requester = sourceTrigger(client, ticket())?.actor;
      return { as_of: snapshot.at, ...devicesCard(snapshot.devices, !!requester && seesNodes(client.settings(), requester)) };
    },
    directory: async () => {
      // The host's snapshot, which a worker in a ticket VM or on a paired node reads through the owner like every ticket tool.
      const snapshot = client.store.get(KV.host.directory);
      if (snapshot?.schema !== DIRECTORY_SCHEMA) throw new Error("The host has not written its directory yet: try again in a minute");
      // Which nodes these are is for a requester who may see them, as for devices.
      const requester = sourceTrigger(client, ticket())?.actor;
      return workerView(snapshot, !!requester && seesNodes(client.settings(), requester));
    },
    mesh: async (args) => {
      // Which nodes there are and what they lend is for a requester who may see them, as for devices and directory, and
      // this tool reaches no node its requester may not know of (a process-isolated worker's shell still runs as this
      // user and is not confined by it; a worker in a ticket VM is).
      const requester = sourceTrigger(client, ticket())?.actor;
      if (!requester || !seesNodes(client.settings(), requester)) {
        if (typeof args.node === "string" && typeof args.tool === "string") throw new Error(MESH_HIDDEN);
        const nodes = await lentByPeers();
        return { paired_nodes: { total: nodes.length, online: nodes.filter((node) => node.online).length }, node_names: MESH_HIDDEN };
      }
      if (typeof args.node !== "string" || typeof args.tool !== "string") return { nodes: await lentByPeers() };
      // This is the one place the tools Swarm offers any harness or worker reach a peer through, so a read-only ticket's
      // ceiling is kept here: harnesses let their MCP servers act outside their own read-only turns. A process-isolated
      // worker with a shell runs as this user and can reach peers with `swarm capabilities` outside it, which only VM
      // isolation stops.
      if (ticket().mandate.capability?.write === "read-only" && !MESH_READS.has(args.tool))
        throw new Error(`This ticket's work is read-only: on a paired node it may only ${[...MESH_READS].join(" and ")}, not ${args.tool}`);
      const call = { ...(args.args && typeof args.args === "object" ? args.args as Record<string, unknown> : {}) };
      // A command runs within the time a ticket tool may take.
      if (args.tool === "shell") call.timeout_ms = Math.min(Number(call.timeout_ms) || MESH_SHELL_MS, MESH_SHELL_MS);
      // The call is recorded once it ends, with how it went, so the ticket's report can say what ran where and what failed.
      const started = Date.now();
      const entry = { at: new Date().toISOString(), node: args.node, tool: args.tool, args: JSON.stringify(call).slice(0, MESH_ARGS_CHARS) };
      const record = (outcome: { ok: boolean; error?: string }) => {
        const calls = client.store.get(KV.mesh.calls(ticketId)) ?? [];
        client.store.set(KV.mesh.calls(ticketId), [...calls, { ...entry, ...outcome, ms: Date.now() - started }].slice(-MESH_CALLS_KEPT));
      };
      try {
        const result = await callLent(args.node, args.tool, call, MESH_SHELL_MS + 5000, undefined, `ticket ${ticketId.slice(0, 8)}`);
        record({ ok: true });
        return { node: args.node, tool: args.tool, result };
      } catch (error) {
        record({ ok: false, error: String(error).slice(0, 300) });
        throw error;
      }
    },
    people: async (args) => {
      if (typeof args.name === "string") {
        const name = args.name;
        return { people: client.sources.chatKinds().flatMap((kind) => findPeople(client.store, name, 20, kind)) };
      }
      if (typeof args.chat === "string") {
        const kind = client.sources.chatKind(client.sources.sourceOfChat(args.chat) ?? FEISHU) ?? feishuChatKind;
        return { chat: args.chat, name: chatName(client.store, args.chat, kind.source) ?? null, people: peopleIn(client.store, args.chat, 500, kind) };
      }
      const kinds = client.sources.chatKinds();
      return { chats: kinds.flatMap((kind) => chatGroups(client.store, kind)).map(({ source, ...chat }) => kinds.length > 1 ? { source, ...chat } : chat) };
    },
    message: async (args) => {
      // Messages go out over the chat kind this ticket came by; a ticket from elsewhere (or one stopped early) uses the
      // first chat kind that is on, as its people and chats have always come from a chat kind's records.
      const from = sourceTrigger(client, ticket());
      const enabledChats = client.sources.chatKinds().filter((kind) => client.sources.instance(kind.source)?.enabled);
      const home = (from ? client.sources.chatKind(from.source) : undefined) ?? enabledChats[0] ?? feishuChatKind;
      // The ticket's own kind first, but a name that is nobody there is looked for in the other chats it may speak in: a
      // request filed from the terminal still tells a person it names where else the agent talks to them.
      const first = addressee(client.store, String(args.to), home);
      const other = "problem" in first ? enabledChats.find((kind) => kind.source !== home.source) : undefined;
      const tried = other ? addressee(client.store, String(args.to), other) : undefined;
      const chat = other && tried && !("problem" in tried) ? other : home;
      const target = chat === home ? first : tried!;
      const source = chat.source;
      if (!client.sources.instance(source)?.enabled) throw new Error(`Messages go out only on ${chat.platform}, which is off here`);
      if ("problem" in target) throw new Error(target.problem);
      const mentions = mentionsFor(client.store, Array.isArray(args.mentions) ? args.mentions.map(String) : [], source);
      if ("problem" in mentions) throw new Error(mentions.problem);
      const text = checkedImText(String(args.text));
      const now = Date.now();
      const sent = (client.store.get(KV.people.sent(ticketId)) ?? []).filter((at) => now - Date.parse(at) < 3_600_000);
      if (sent.length >= MESSAGES_PER_HOUR) throw new Error(`This ticket sent ${MESSAGES_PER_HOUR} messages in the last hour: wait, or report what is left`);
      const channel = channelTo(target, chat);
      client.store.atomic(() => {
        client.outbox.send({ id: key("message", ticketId, JSON.stringify(channel.address), text), channel, text, kind: "notice", ticketId, ...(mentions.length ? { mentions } : {}) });
        client.store.set(KV.people.sent(ticketId), [...sent, new Date(now).toISOString()]);
      });
      return { sent: true, to: "person" in target ? target.person.name : target.chat.name };
    },
    remember: async (args) => {
      if (!memoryOf(client.settings())) throw new Error("The agent's memory is off here");
      const origin = sourceTrigger(client, ticket());
      const problem = applyOps(client.store, [{ op: "add", about: String(args.about), kind: args.kind as NoteKind ?? "fact", text: String(args.text),
        ...(typeof args.due === "string" ? { due: args.due } : {}) }], { subjects: subjectFor(client.sources, origin), shown: new Set() },
        { ticketId, ...(origin && metaOf(origin).chatId ? { chatId: metaOf(origin).chatId } : {}), ...(origin && metaOf(origin).direct ? { direct: true } : {}) });
      if (problem) throw new Error(problem);
      return { remembered: true };
    },
    recall: async (args) => {
      if (!memoryOf(client.settings())) throw new Error("The agent's memory is off here");
      const origin = sourceTrigger(client, ticket());
      if (typeof args.query === "string") return { notes: client.store.memory.search(args.query, RECALLED).map((note) => noteLine(client.store, note)) };
      if (typeof args.about === "string") {
        const about = subjectFor(client.sources, origin)(args.about);
        if (!about) throw new Error(`${args.about} is not someone or something here: use requester, a person's id, chat or self`);
        return { notes: client.store.memory.about(about, RECALLED).map((note) => noteLine(client.store, note)) };
      }
      return { notes: origin && client.sources.chatKind(origin.source) ? notesCard(client.store, subjectsOf(origin), RECALLED, RECALLED) : notesCard(client.store, [SELF], RECALLED, RECALLED) };
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
    }),
    // The worker's own limits are the schema's: a direct call checks them here, and the engine clamps whatever reaches it.
    check_back: async (args) => {
      const { after_minutes, note } = z.object(TOOLS.check_back.input).parse(args);
      // A stale worker of an ended Assignment still reaches the shared store: it may not reschedule the live one's wake.
      // This is the check `Assignments.report` makes, before or after its own launch ends.
      const current = ticket(), assignment = latestAssignment(current);
      if (assignmentId !== undefined && (!assignment || assignment.id !== assignmentId || assignment.state === "ended")) throw new UserError("assignmentEnded");
      const { at, rescheduled } = client.engine.checkBack(ticketId, after_minutes, note);
      return { scheduled: at, ...(rescheduled ? { rescheduled: true } : {}) };
    }
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
  /** With a ready, blocked or failed report, the patch of the worker's directory: see `withPatch`. */
  patch?: Patch;
}

/**
 * The arguments of a report the worker files itself when its work stops, with the patch of its directory as `withPatch`
 * gives the report tool's blocked and failed reports: the commits outlast the directory, as a ticket VM's disk does not.
 * A directory whose patch cannot be read still reports, without it.
 */
export async function withStoppedPatch(directory: string, args: ReportArgs): Promise<ReportArgs> {
  if (args.state !== "blocked" && args.state !== "failed") return args;
  const patch = await directoryPatch(directory);
  if (!patch) return args;
  const fits = Buffer.byteLength(JSON.stringify({ ...args, patch })) <= STOPPED_REPORT_BYTES;
  return { ...args, patch: fits ? patch : { ...patch, text: "" } };
}

/** What a local ticket's result says when its worker gave no message: the patch is the result. */
const PATCH_RESULT = "The change is ready as the attached patch; nothing was pushed.";

/**
 * Files a worker's report and posts what it says to the person: its question, its ready result or its answer, each under
 * the Engine's reply rules. The report tool and the worker's fallback for an unreported turn both file through it.
 */
/**
 * Gives the ticket's running worker the messages of people who steer it that wait for it, other than the one its report
 * answers, and returns them as the worker reads them. They came during its turn: a harness takes no message until its turn
 * ends, so a report that ends the ticket would let them go, and the router would start the work again for them.
 */
function handOver(client: SuperagentClient, ticket: Ticket, answers?: string): string[] {
  const assignment = runningAssignment(ticket);
  if (!assignment) return [];
  const inputs = ticket.inputs.filter((input): input is Extract<TicketInput, { kind: "trigger" }> => input.kind === "trigger" && !!input.human
    && !input.context && !input.advisory && input.triggerId !== answers && ticket.undelivered.includes(input.id));
  if (!inputs.length) return [];
  const ids = inputs.map((input) => input.id);
  client.engine.inputsDelivered(ticket.id, assignment.id, ids);
  client.engine.inputsRead(ticket.id, ids);
  return inputs.flatMap((input) => {
    const trigger = client.store.triggers.get(input.triggerId);
    const message = inputMessage(input, trigger ? triggerMessage(trigger, trigger.url ? { source_url: trigger.url } : {}, input.note) : undefined);
    return message === undefined ? [] : [message];
  });
}

/**
 * One line of where a ticket's work ran, for its report: the node and harness its worker ran on, and what it ran on paired
 * nodes, written by the process that files the report rather than the worker's model.
 */
export function ranWhere(records: Parameters<typeof workerNode>[0], ticket: Ticket): string {
  const node = workerNode(records, ticket);
  const harness = ticket.execution?.harness;
  const where = node ? `Ran on ${node}` : "Ran on this node";
  const calls = records.store.get(KV.mesh.calls(ticket.id)) ?? [];
  const failed = calls.filter((call) => call.ok === false).length;
  const mesh = calls.length ? `; mesh: ${calls.length} call${calls.length === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}` : "";
  return `${where}${harness ? ` (${harness})` : ""}${mesh}`;
}

export async function fileReport(client: SuperagentClient, ticketId: string, args: ReportArgs) {
  const current = client.store.tickets.get(ticketId);
  if (!current || !liveTicket(current)) throw new Error("Ticket ended (its PR closed or the work finished); do not resume it");
  // A report that ends the ticket waits for what a person wrote meanwhile, which its worker takes into the same answer.
  if (args.state === "ready" || args.state === "dropped") {
    const waiting = handOver(client, current, args.reply_to_trigger_id);
    if (waiting.length) {
      throw new Error(`Not filed: a person wrote while you worked, which you had not read. Take it into this answer, then report again: ready with one message_for_person that covers it too, after any more work it asks for; if it only confirms what you did, say nothing more about it.\n${waiting.join("\n")}`);
    }
  }
  // A local ticket's result is its commits as a patch, which the host keeps and sends with the result.
  const local = current.mandate.capability?.write === "local" && args.state === "ready" && args.patch ? args.patch : undefined;
  if (local?.uncommitted) throw new Error("Tracked files have uncommitted changes: commit the change on this ticket's branch first, since the person gets its commits as a patch.");
  if (local && local.bytes > PATCH_BYTES) {
    throw new Error(`The commits of this ticket make a patch of ${Math.ceil(local.bytes / 1024)} KB, more than ${PATCH_BYTES / 1024} KB: keep generated and large files out of them.`);
  }
  const attachment = local?.text ? keepPatch(client.stateDir, current, local.text) : undefined;
  // Work that stops keeps its commits too, as they are: a ticket VM's data disk is deleted when its ticket ends, so commits
  // never pushed would be lost when a stuck ticket is closed.
  if ((args.state === "blocked" || args.state === "failed") && args.patch?.text) keepPatch(client.stateDir, current, args.patch.text);
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
    // Every report ends with one host-written line of where the work ran; the worker's own words stay above it.
    const ran = ranWhere({ store: client.store }, current);
    const report = {
      state: args.state, summary: `${args.summary.trimEnd()}\n\n${ran}`,
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

/** How long the host keeps a ticket's patch after it last changed. */
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

/** The note a ticket gets when its own kept patch, from work that stopped, could not be applied to its prepared directory. */
export const keptPatchNote = (path: string, why: string): string =>
  `The commits this ticket made before it stopped are kept as a patch at ${path}, which did not apply to its new directory, so the directory starts without them. Restore them by hand if the work needs them: ${why.slice(0, 500)}`;

/** Writes a ticket's patch where the host keeps it (owner-only), and returns its path. */
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
