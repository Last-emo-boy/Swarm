/**
 * Bot commands: a person's Feishu message to the agent that starts with a slash after the mentions that address it, such as
 * `/me`. The host carries each out itself before any model reads the message, records it once so a Source that reads it
 * again finds it known, and answers in the conversation. It also holds back a sender's messages beyond their role's requests
 * per hour, and new requests beyond their open tickets, with an answer that says so.
 */
import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { UserError, key, liveTicket, threadKey, type ReceiveResult, type Role, type Ticket, type Trigger, type WriteLevel } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { WorktreeNameSchema } from "./messages.js";
import { addressable, atLeast, capabilityOf, ceilingOf, limitOf, roleOf, steers } from "./policy.js";
import { RoleSchema, WriteLevelSchema, settingsPath, updateSettings, type Settings } from "./settings.js";
import { SOURCE as FEISHU } from "./sources/feishu-trigger.js";
import { patchPath } from "./ticket-tools.js";

const HOUR_MS = 3_600_000;
export const COMMANDS = ["help", "me", "role", "listen", "ceiling", "takeover"] as const;
export type CommandName = typeof COMMANDS[number];
export interface Command { name: CommandName; args: string[]; mentions: { id: string; name: string }[] }

const MentionsSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const short = (id: string): string => id.slice(0, 8);
const HELP = "Commands: /me shows your role and limits; /takeover [ticket] opens a pull request from a local ticket's patch. "
  + "Owners: /role @name owner|maintainer|everyone|none, /listen all|mentions|off in a group, /ceiling read-only|local|github.";

/** The bot command a person's Feishu message to the agent gives, after the mentions it starts with, if it gives one. */
export function commandOf(trigger: Trigger): Command | undefined {
  if (trigger.source !== FEISHU || !trigger.human || !trigger.addressed) return undefined;
  const mentions = MentionsSchema.catch([]).parse(trigger.meta.mentions);
  let text = trigger.text.trim();
  for (let mention = mentions.find((item) => text.startsWith(`@${item.name}`)); mention; mention = mentions.find((item) => text.startsWith(`@${item.name}`))) {
    text = text.slice(mention.name.length + 1).trimStart();
  }
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text);
  const name = COMMANDS.find((item) => item === match?.[1]);
  if (!name) return undefined;
  return { name, args: (match![2] ?? "").trim().split(/\s+/).filter(Boolean), mentions };
}

export class BotCommands {
  constructor(private readonly client: SuperagentClient) {}

  /**
   * Takes in a Source's Trigger: a bot command, or a message the sender's limits hold back, is recorded and answered here;
   * anything else, and anything from a sender the gate would not take, goes to the Engine.
   */
  receive(trigger: Trigger): ReceiveResult {
    const { engine, store, sources } = this.client;
    if (store.triggers.get(trigger.id)) return engine.receive(trigger);
    const settings = this.client.settings();
    if (!trigger.human || !trigger.addressed || !addressable(settings, sources, trigger)) return engine.receive(trigger);
    const command = commandOf(trigger);
    const held = this.held(trigger, settings, !command);
    if (held) {
      const result = engine.receiveCommand(trigger, "limit");
      // One answer per sender and hour says so; the messages after it go unanswered.
      const hour = Math.floor(Date.parse(trigger.at) / HOUR_MS);
      if (result === "stored") this.answer(trigger, held, key("limit", trigger.actor.source, trigger.actor.id, String(hour), held));
      return result;
    }
    if (!command) return engine.receive(trigger);
    const result = engine.receiveCommand(trigger, command.name);
    if (result !== "stored") return result;
    let text: string;
    try {
      text = this.run(command, trigger, settings);
    } catch (error) {
      text = `That did not work: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    }
    this.answer(trigger, text, key("command", trigger.id));
    return result;
  }

  /** Why a sender's message is held back: beyond their requests per hour, or, for one that starts new work, their open tickets. */
  private held(trigger: Trigger, settings: Settings, request: boolean): string | undefined {
    const { store } = this.client;
    const role = roleOf(settings, trigger.actor);
    const perHour = limitOf(settings, role, "requestsPerHour");
    const from = new Date(Date.parse(trigger.at) - HOUR_MS).toISOString();
    if (perHour !== undefined && store.read.requests(trigger.actor, from, trigger.at) >= perHour) {
      return `You sent ${perHour} requests in the last hour, as many as your role allows, so I did not take this one in. Try again later.`;
    }
    const open = limitOf(settings, role, "openTickets");
    // A message on a Thread without tickets starts new work; one on a ticket's Thread follows it up.
    const thread = store.threads.get(threadKey(trigger.threads[0]!));
    if (!request || open === undefined || thread?.subscriptions.length) return undefined;
    const mine = this.openTickets(trigger).length;
    return mine >= open ? `You have ${mine} open tickets, as many as your role allows. Reply in one of their threads, or wait until one finishes.` : undefined;
  }

  private openTickets(trigger: Trigger): Ticket[] {
    return this.client.store.tickets.open().filter((ticket) => liveTicket(ticket) && ticket.mandate.actor.source === trigger.actor.source
      && ticket.mandate.actor.id === trigger.actor.id);
  }

  private answer(trigger: Trigger, text: string, id: string): void {
    if (trigger.channel) this.client.outbox.send({ id, channel: trigger.channel, text, kind: "reply" });
  }

  private run(command: Command, trigger: Trigger, settings: Settings): string {
    switch (command.name) {
      case "help": return HELP;
      case "me": return this.me(trigger, settings);
      case "role": return this.role(command, trigger, settings);
      case "listen": return this.listen(command, trigger, settings);
      case "ceiling": return this.ceiling(command, trigger, settings);
      case "takeover": return this.takeover(command, trigger, settings);
    }
  }

  private me(trigger: Trigger, settings: Settings): string {
    const role = roleOf(settings, trigger.actor);
    if (!settings.access) return `Your role: ${role}. The access model is off, so everyone on the list may do everything.`;
    const of = (count: number, limit: number | undefined) => limit === undefined ? String(count) : `${count} of ${limit}`;
    const from = new Date(Date.parse(trigger.at) - HOUR_MS).toISOString();
    const requests = this.client.store.read.requests(trigger.actor, from, trigger.at);
    const scope = this.client.sources.scope(trigger);
    const ceiling = ceilingOf(settings, trigger.source, scope.listened ? scope.row : undefined);
    return `Your role: ${role}. Open tickets: ${of(this.openTickets(trigger).length, limitOf(settings, role, "openTickets"))}. `
      + `Requests in the last hour: ${of(requests, limitOf(settings, role, "requestsPerHour"))}. Work asked for here writes ${ceiling} at most.`;
  }

  private owner(trigger: Trigger, settings: Settings): void {
    if (!atLeast(roleOf(settings, trigger.actor), "owner")) throw new Error("only an owner can do that");
  }

  /** `/role @name… <role>`: an owner gives the people the message mentions a role, or with `none` takes theirs away. */
  private role(command: Command, trigger: Trigger, settings: Settings): string {
    this.owner(trigger, settings);
    const wanted = command.args.at(-1) ?? "";
    const role = wanted === "none" ? undefined : RoleSchema.safeParse(wanted).data;
    const bot = this.client.deployment().feishu?.botId;
    const rest = trigger.text.slice(trigger.text.indexOf("/role"));
    const people = command.mentions.filter((mention) => mention.id !== bot && rest.includes(`@${mention.name}`));
    if ((wanted !== "none" && !role) || !people.length) return "Usage: /role @name owner|maintainer|everyone|none";
    updateSettings((next) => {
      const part = next.policy.sources[FEISHU] ??= { allowed: [], admission: {} };
      const roles: Record<string, Role> = { ...part.roles };
      for (const person of people) {
        if (role) roles[person.id] = role;
        else delete roles[person.id];
      }
      if (!Object.values(roles).includes("owner")) throw new Error("someone must stay an owner");
      part.roles = roles;
      return next;
    }, settingsPath(this.client.stateDir));
    const names = people.map((person) => person.name).join(", ");
    return role ? `${names}: ${role} from now on.` : `${names}: no role from now on.`;
  }

  /** `/listen all|mentions|off`, in a group: an owner lists the chat with what the agent reads there, or takes it off the list. */
  private listen(command: Command, trigger: Trigger, settings: Settings): string {
    this.owner(trigger, settings);
    const mode = command.args[0];
    const chatId = String(trigger.meta.chatId ?? "");
    if (trigger.meta.direct === true) return "/listen works in a group chat.";
    if (mode !== "all" && mode !== "mentions" && mode !== "off") return "Usage: /listen all|mentions|off";
    updateSettings((next) => {
      const source = next.sources[FEISHU] ??= { enabled: true, config: {} };
      const chats = z.array(z.looseObject({ chatId: z.string() })).catch([]).parse(source.config.chats);
      const kept = chats.find((chat) => chat.chatId === chatId);
      const others = chats.filter((chat) => chat.chatId !== chatId);
      source.config = { ...source.config, chats: mode === "off" ? others : [...others, { ...kept, chatId, listen: mode }] };
      return next;
    }, settingsPath(this.client.stateDir));
    return mode === "off" ? "This chat is off the list now; an owner can list it again in the settings file."
      : mode === "all" ? "I read every message in this chat now." : "I read only messages that mention me in this chat now.";
  }

  /** `/ceiling <level>`: an owner sets how far work asked for in this conversation's receiving scope may write. */
  private ceiling(command: Command, trigger: Trigger, settings: Settings): string {
    this.owner(trigger, settings);
    const level: WriteLevel | undefined = WriteLevelSchema.safeParse(command.args[0]).data;
    const scope = this.client.sources.scope(trigger);
    if (!level) return "Usage: /ceiling read-only|local|github";
    if (!scope.listened || scope.row === undefined) return "I cannot set a ceiling for this conversation.";
    const row = scope.row;
    updateSettings((next) => {
      const part = next.policy.sources[FEISHU] ??= { allowed: [], admission: {} };
      part.ceilings = { ...part.ceilings, [row]: level };
      return next;
    }, settingsPath(this.client.stateDir));
    return `Work asked for here writes ${level} at most from now on.`;
  }

  /**
   * `/takeover [ticket]`: a ticket that kept its work local, named or the latest on this Thread, goes on as a new ticket of the
   * sender's, which applies its patch and opens a pull request; the old one ends. Its requester, a maintainer, or, for work
   * nobody asked for, anyone who may write to GitHub here may take it over.
   */
  private takeover(command: Command, trigger: Trigger, settings: Settings): string {
    const { client } = this;
    const ticket = this.ticketNamed(command.args[0], trigger);
    if (!ticket) return "Name the ticket: /takeover <ticket id>, or send /takeover in its thread.";
    const name = short(ticket.id);
    if (ticket.mandate.capability?.write !== "local") return `Ticket ${name} does not keep its work local, so there is nothing to take over.`;
    if (!existsSync(patchPath(client.stateDir, ticket))) return `Ticket ${name} has no patch yet: take it over once it reports ready.`;
    if (ticket.mandate.strength !== "inferred" && !steers(settings, ticket.mandate, trigger.actor)) {
      return `Only the person who asked for ticket ${name} or a maintainer can take it over.`;
    }
    const scope = client.sources.scope(trigger);
    const row = scope.listened ? scope.row : undefined;
    const addressed = trigger.addressed === "direct" ? "direct" as const : "mention" as const;
    const would = capabilityOf(settings, { strength: "explicit", actor: trigger.actor,
      basis: { via: "addressed", addressed, source: trigger.source, ...(row === undefined ? {} : { row }) } });
    if (would?.write !== "github") return `You cannot open pull requests from here (your role: ${roleOf(settings, trigger.actor)}).`;
    const limit = limitOf(settings, roleOf(settings, trigger.actor), "openTickets");
    const mine = this.openTickets(trigger).length;
    if (limit !== undefined && mine >= limit) return `You have ${mine} open tickets, as many as your role allows: take this over once one finishes.`;
    const request = client.store.triggers.get(ticket.origin.triggerId)?.text ?? "";
    const worktree = WorktreeNameSchema.safeParse(ticket.execution?.name.replace(/-[0-9a-f]{12}$/, "")).data ?? "takeover";
    const decision = client.store.atomic(() => {
      const decided = client.engine.decide(trigger.id, { kind: "accept", title: ticket.title, scope: ticket.mandate.scope,
        reason: { code: "takeover", values: { ticket: ticket.id } }, from: ticket.id, name: worktree,
        note: `Takes over ticket ${ticket.id}, whose request was: ${request.slice(0, 1000)}` });
      if (decided.ticketId && liveTicket(client.store.tickets.get(ticket.id)!)) client.engine.stopTicket(ticket.id, `Taken over as ticket ${decided.ticketId}`);
      return decided;
    });
    if (!decision.ticketId) throw new UserError("notAdmissible", { reason: "the take-over was not accepted" });
    return `Ticket ${short(decision.ticketId)} takes over ticket ${name}: it applies the patch and opens a pull request.`;
  }

  /** The ticket `/takeover` names: by its id's start or its name, else the latest local ticket on the message's Threads. */
  private ticketNamed(name: string | undefined, trigger: Trigger): Ticket | undefined {
    const { store } = this.client;
    if (name) {
      if (name.length < 6) return undefined;
      return store.tickets.list().find((ticket) => ticket.id.startsWith(name) || ticket.execution?.name === name);
    }
    const ids = trigger.threads.flatMap((ref) => store.threads.get(threadKey(ref))?.subscriptions ?? []);
    return ids.flatMap((id) => store.tickets.get(id) ?? []).filter((ticket) => ticket.mandate.capability?.write === "local")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
}
