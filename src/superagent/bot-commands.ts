/**
 * Bot commands: a person's Feishu message to the agent that starts with a slash after the mentions that address it, such as
 * `/me`. The host carries each out itself before any model reads the message, records it once so a Source that reads it
 * again finds it known, and answers in the conversation. The router runs some of them for a person whose message asks for
 * what one does (`perform`, see `AGENT_COMMANDS`), as their built-in tools. It also holds back a sender's messages beyond
 * their role's requests per hour, and new requests beyond their open tickets, with an answer that says so.
 */
import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { UserError, key, latestReport, liveTicket, threadKey, type ActorRef, type ChannelRef, type ReceiveResult, type Role, type Ticket, type Trigger,
  type WriteLevel } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { chatterOf } from "./chatter.js";
import { WorktreeNameSchema } from "./messages.js";
import { AUTHORIZATIONS_URL, githubApp, installUrl, linkOf, namedRepository, type GithubApp, type GithubLinks, type LinkView } from "./github-link.js";
import { KV } from "./kv.js";
import { addressable, allowedWrite, atLeast, capabilityOf, ceilingOf, limitOf, roleOf, steers, watchedRepository } from "./policy.js";
import type { AgentCommand } from "./prompts.js";
import { RoleSchema, WriteLevelSchema, settingsPath, updateSettings, type Settings } from "./settings.js";
import { SOURCE as FEISHU, feishuUserChannel } from "./sources/feishu-trigger.js";
import { sameName } from "./text.js";
import { patchPath } from "./ticket-tools.js";

const HOUR_MS = 3_600_000;
export const COMMANDS = ["help", "me", "link", "unlink", "repo", "role", "listen", "ceiling", "chatter", "takeover"] as const;
export type CommandName = typeof COMMANDS[number];
export interface Command { name: CommandName; args: string[]; mentions: { id: string; name: string }[] }

const MentionsSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const short = (id: string): string => id.slice(0, 8);
const HELP = "Commands: /me shows your role and limits; /link links your GitHub account (its code comes in a direct message), /unlink removes it, "
  + "/repo [owner/name] lists or sets your default repository; /takeover [ticket] opens a pull request from a local ticket's patch. "
  + "You can also ask for these in your own words. "
  + "Owners: /role @name owner|maintainer|everyone|none, /listen all|mentions|off and /chatter on|off in a group, /ceiling read-only|local|github.";
/** How many repositories an answer names before it says how many more there are. */
const LISTED_REPOS = 8;
const repoList = (link: LinkView): string => {
  const names = link.repos.map((repo) => repo === link.defaultRepo ? `${repo} (default)` : repo);
  return names.length > LISTED_REPOS ? `${names.slice(0, LISTED_REPOS).join(", ")} and ${names.length - LISTED_REPOS} more` : names.join(", ");
};
const NOT_LINKED = "Link your GitHub account first: send /link.";
const CODE_SENT = "I sent you a direct message with a code to link your GitHub account. If none arrives, send me a direct message saying /link.";
const CODE_WAITS = "Enter the code I sent you in a direct message, or wait until it expires to ask for another.";
/** How long a wanted pull request waits for its person to link and for its ticket's patch. */
const WANTED_MS = 7 * 24 * HOUR_MS;

const failure = (error: unknown): string => `That did not work: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);

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

export interface BotCommandsOptions {
  /** The host's linked accounts; without them /link, /unlink and /repo say linking is not set up. */
  links?: GithubLinks;
  log?: (message: string) => void;
}

export class BotCommands {
  private readonly lifetime = new AbortController();
  /** The people whose device flow waits for them to enter its code. */
  private readonly flows = new Set<string>();
  constructor(private readonly client: SuperagentClient, private readonly options: BotCommandsOptions = {}) {}

  /** Stops the device flows that still wait for people to enter their codes. */
  close(): void { this.lifetime.abort(); }

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
    let text: string | undefined;
    try {
      text = this.run(command, trigger, settings);
    } catch (error) {
      text = failure(error);
    }
    if (text) this.answer(trigger, text, key("command", trigger.id));
    return result;
  }
  /**
   * Runs a command the router chose for a person's message as if they had typed it, which answers in the conversation as
   * the command does; a take-over decides the message.
   */
  perform(trigger: Trigger, name: AgentCommand, args: readonly string[]): void {
    let text: string | undefined;
    try {
      text = trigger.source !== FEISHU ? "Bot commands work in Feishu."
        : this.run({ name, args: [...args], mentions: MentionsSchema.catch([]).parse(trigger.meta.mentions) }, trigger, this.client.settings());
    } catch (error) {
      text = failure(error);
    }
    if (text) this.answer(trigger, text, key("command", trigger.id));
  }

  /** Runs a command that answers once GitHub has; its failure is its answer. */
  private later(trigger: Trigger, work: () => Promise<string>): undefined {
    void work().catch(failure).then((text) => this.answer(trigger, text, key("command", trigger.id)),
      (error: unknown) => this.options.log?.(`superagent: a bot command failed: ${String(error)}`));
    return undefined;
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

  /** A command's answer, or undefined for one that answers later. */
  private run(command: Command, trigger: Trigger, settings: Settings): string | undefined {
    switch (command.name) {
      case "help": return HELP;
      case "me": return this.me(trigger, settings);
      case "link": return this.link(trigger, settings);
      case "unlink": return this.unlink(trigger, settings);
      case "repo": return this.repo(command, trigger, settings);
      case "role": return this.role(command, trigger, settings);
      case "listen": return this.listen(command, trigger, settings);
      case "ceiling": return this.ceiling(command, trigger, settings);
      case "chatter": return this.chatter(command, trigger, settings);
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
    const link = githubApp(settings) ? linkOf(this.client.store, trigger.actor) : undefined;
    const github = !githubApp(settings) ? "" : !link ? " GitHub: not linked; send /link."
      : link.broken ? ` GitHub: @${link.login}, but the link stopped working; send /link again.`
      : trigger.meta.direct !== true ? ` GitHub: @${link.login}.`
      : ` GitHub: @${link.login}, working on ${link.repos.length ? repoList(link) : "no repository yet"}.`;
    return `Your role: ${role}. Open tickets: ${of(this.openTickets(trigger).length, limitOf(settings, role, "openTickets"))}. `
      + `Requests in the last hour: ${of(requests, limitOf(settings, role, "requestsPerHour"))}. Work asked for here writes ${ceiling} at most.${github}`;
  }

  /** The GitHub App and the host's links, for the commands that need both. */
  private linking(settings: Settings): { app: GithubApp; links: GithubLinks } {
    const app = githubApp(settings);
    const { links } = this.options;
    if (!app || !links) throw new Error("linking GitHub accounts is not set up here");
    return { app, links };
  }

  /**
   * `/link`: the device flow's code, then, once the person entered it on GitHub, the account and the repositories they may
   * work on, in a direct message. Asked in a group, both go to their direct messages, since whoever enters the code links
   * their own account to the person who asked.
   */
  private link(trigger: Trigger, settings: Settings): string | undefined {
    this.linking(settings);
    const direct = trigger.meta.direct === true;
    if (!this.startLink(trigger.actor, direct && trigger.channel ? trigger.channel : feishuUserChannel(trigger.actor.id), trigger.id)) return CODE_WAITS;
    return direct ? undefined : CODE_SENT;
  }
  /**
   * Starts the device flow of a person, whose code and outcome go to `channel`, a direct message with them; none starts while
   * theirs still waits for its code. Once they linked, the pull requests they wanted are opened.
   * @returns whether it started one.
   */
  private startLink(actor: ActorRef, channel: ChannelRef, id: string): boolean {
    const { app, links } = this.linking(this.client.settings());
    const flow = `${actor.source}:${actor.id}`;
    if (this.flows.has(flow)) return false;
    this.flows.add(flow);
    const say = (text: string, part: string) => this.client.outbox.send({ id: key("link", id, part), channel, text, kind: "reply" });
    void (async () => {
      const device = await links.start(app);
      say(`Open ${device.verification_uri} and enter ${device.user_code} within ${Math.round(device.expires_in / 60)} minutes to link your GitHub account.`, "code");
      const link = await links.link(actor, await links.authorized(app, device, this.lifetime.signal), channel);
      say(link.repos.length ? `Linked as @${link.login}. You can work on ${repoList(link)}. Install the app on more repositories at ${installUrl(app)}.`
        : `Linked as @${link.login}, but the app is not installed on a repository you can push to: install it at ${installUrl(app)}, then send /repo.`, "linked");
      this.takeOverWanted();
    })().catch((error: unknown) => say(failure(error), "failed"))
      .catch((error: unknown) => this.options.log?.(`superagent: linking a GitHub account failed: ${String(error)}`))
      .finally(() => this.flows.delete(flow));
    return true;
  }

  /** `/unlink`: removes the person's link, after which their tickets cannot act as them. */
  private unlink(trigger: Trigger, settings: Settings): string | undefined {
    const { app, links } = this.linking(settings);
    return this.later(trigger, async () => await links.unlink(app, trigger.actor)
      ? `Unlinked. To revoke the app's access on GitHub too, go to ${AUTHORIZATIONS_URL}.` : "You have no linked GitHub account.");
  }

  /** `/repo [owner/name]`: reads again which repositories the person may work on, and sets their default. */
  private repo(command: Command, trigger: Trigger, settings: Settings): string | undefined {
    if (trigger.meta.direct !== true) return "Send /repo to me in a direct message.";
    const { app, links } = this.linking(settings);
    if (!linkOf(this.client.store, trigger.actor)) return NOT_LINKED;
    return this.later(trigger, async () => {
      const link = await links.refreshRepos(app, trigger.actor);
      if (!link) return "Your GitHub link stopped working: send /link to me in a direct message.";
      const wanted = command.args[0] && namedRepository(command.args[0], link.repos);
      if (command.args[0] && !wanted) {
        return `@${link.login} cannot push to ${command.args[0]} through the app: install it there at ${installUrl(app)}, then send /repo again.`;
      }
      const now = wanted ? links.setDefault(trigger.actor, wanted)! : link;
      return now.repos.length ? `You can work on ${repoList(now)}.` : `The app is not installed on a repository you can push to: install it at ${installUrl(app)}.`;
    });
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
      // The agent joins a conversation on its own only where it reads all of it.
      if (mode !== "all" && next.chatter) next.chatter = { ...next.chatter, chats: next.chatter.chats.filter((chat) => chat !== chatId) };
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
   * `/chatter on|off`, in a group an owner listed with /listen all: whether the agent joins the conversation there on its
   * own; without an argument, whether it does.
   */
  private chatter(command: Command, trigger: Trigger, settings: Settings): string {
    const chatId = String(trigger.meta.chatId ?? "");
    const on = chatterOf(settings).chats.includes(chatId);
    if (trigger.meta.direct === true) return "/chatter works in a group chat.";
    const mode = command.args[0];
    if (!mode) return on ? `I join the conversation here now and then, at most ${chatterOf(settings).perHour} times an hour.` : "I speak here only when someone mentions me.";
    this.owner(trigger, settings);
    if (mode !== "on" && mode !== "off") return "Usage: /chatter on|off";
    const listed = z.array(z.looseObject({ chatId: z.string(), listen: z.string().optional() })).catch([]).parse(settings.sources[FEISHU]?.config.chats);
    if (mode === "on" && listed.find((chat) => chat.chatId === chatId)?.listen !== "all") return "First send /listen all here: I need to read the whole conversation.";
    updateSettings((next) => {
      const current = chatterOf(next);
      next.chatter = { ...current, chats: mode === "on" ? [...new Set([...current.chats, chatId])] : current.chats.filter((chat) => chat !== chatId) };
      return next;
    }, settingsPath(this.client.stateDir));
    return mode === "on" ? "I'll join the conversation here now and then." : "I'll speak here only when someone mentions me.";
  }

  /**
   * `/takeover [ticket]`: a ticket that kept its work local, named or the latest on this Thread, goes on as a new ticket of the
   * sender's, which applies its patch and opens a pull request; the old one ends. Its requester, a maintainer, or, for work
   * nobody asked for, anyone who may write to GitHub here may take it over.
   */
  private takeover(command: Command, trigger: Trigger, settings: Settings): string {
    const ticket = this.ticketNamed(command.args[0], trigger);
    if (!ticket) return "Name the ticket: /takeover <ticket id>, or send /takeover in its thread.";
    return this.takeOver(ticket, trigger, settings);
  }
  /**
   * Takes a local ticket over for the sender of `trigger`, whose message decides the new ticket. Until they linked an account
   * and the ticket has its patch, the take-over waits for both (see `takeOverWanted`), and a sender who has not linked yet
   * gets the code to link in a direct message.
   */
  private takeOver(ticket: Ticket, trigger: Trigger, settings: Settings): string {
    const { client } = this;
    const name = short(ticket.id);
    if (ticket.mandate.capability?.write !== "local") return `Ticket ${name} does not keep its work local, so there is nothing to take over.`;
    const taker = client.store.tickets.list().find((item) => item.mandate.capability?.from === ticket.id);
    if (taker) return `Ticket ${name} was taken over as ticket ${short(taker.id)} already.`;
    if (ticket.mandate.strength !== "inferred" && !steers(settings, ticket.mandate, trigger.actor)) {
      return `Only the person who asked for ticket ${name} or a maintainer can take it over.`;
    }
    const scope = client.sources.scope(trigger);
    const row = scope.listened ? scope.row : undefined;
    const addressed = trigger.addressed === "direct" ? "direct" as const : "mention" as const;
    const mandate = { strength: "explicit" as const, actor: trigger.actor,
      basis: { via: "addressed" as const, addressed, source: trigger.source, ...(row === undefined ? {} : { row }) } };
    // A local ticket's patch is on the watched repository, where the taker opens the pull request as themselves.
    const watched = watchedRepository(settings);
    const patched = existsSync(patchPath(client.stateDir, ticket));
    const link = linkOf(client.store, trigger.actor);
    if (!link || link.broken) {
      if (!githubApp(settings) || !this.options.links || allowedWrite(settings, mandate) !== "github") return NOT_LINKED;
      this.want(ticket, trigger);
      const direct = trigger.meta.direct === true && !!trigger.channel;
      const started = this.startLink(trigger.actor, direct ? trigger.channel! : feishuUserChannel(trigger.actor.id), trigger.id);
      return `Link your GitHub account first: enter the code ${started && direct ? "I'm sending you here" : "I sent you in a direct message"}. `
        + `Once it is linked${patched ? "" : ` and ticket ${name} reports ready`}, I'll open the pull request as you.`;
    }
    const would = capabilityOf(settings, mandate, link, { repository: watched });
    if (would?.write !== "github" || !sameName(would.repository ?? "", watched)) {
      return `You cannot open pull requests on ${watched} from here (your role: ${roleOf(settings, trigger.actor)}, GitHub: @${link.login}).`;
    }
    if (!patched) {
      this.want(ticket, trigger);
      return `Ticket ${name} has no patch yet: I'll open the pull request as @${link.login} once it reports ready.`;
    }
    const limit = limitOf(settings, roleOf(settings, trigger.actor), "openTickets");
    const mine = this.openTickets(trigger).filter((item) => item.id !== ticket.id).length;
    if (limit !== undefined && mine >= limit) return `You have ${mine} open tickets, as many as your role allows: take this over once one finishes.`;
    const request = client.store.triggers.get(ticket.origin.triggerId)?.text ?? "";
    const worktree = WorktreeNameSchema.safeParse(ticket.execution?.name.replace(/-[0-9a-f]{12}$/, "")).data ?? "takeover";
    const decision = client.store.atomic(() => {
      const decided = client.engine.decide(trigger.id, { kind: "accept", title: ticket.title, scope: ticket.mandate.scope,
        reason: { code: "takeover", values: { ticket: ticket.id } }, from: ticket.id, name: worktree, repository: watched,
        note: `Takes over ticket ${ticket.id}, whose request was: ${request.slice(0, 1000)}` });
      if (decided.ticketId && liveTicket(client.store.tickets.get(ticket.id)!)) client.engine.stopTicket(ticket.id, `Taken over as ticket ${decided.ticketId}`);
      return decided;
    });
    if (!decision.ticketId) throw new UserError("notAdmissible", { reason: "the take-over was not accepted" });
    client.store.delete(KV.links.wanted(ticket.id));
    return `Ticket ${short(decision.ticketId)} takes over ticket ${name}: it applies the patch and opens a pull request.`;
  }
  /** Remembers that the sender of `trigger` wants a pull request from a local ticket, which `takeOverWanted` opens. */
  private want(ticket: Ticket, trigger: Trigger): void {
    this.client.store.set(KV.links.wanted(ticket.id), { triggerId: trigger.id, at: new Date().toISOString() });
  }
  /**
   * After the router accepted work from someone who wants a pull request from it but cannot open one yet, as their GitHub
   * account is not linked: the ticket, kept local, is taken over once they linked it and it reported ready, and they get
   * the code to link in a direct message (see `takeOver`).
   */
  wantPullRequest(trigger: Trigger, ticketId: string): void {
    const ticket = this.client.store.tickets.get(ticketId);
    if (!ticket || trigger.source !== FEISHU) return;
    try {
      this.takeOver(ticket, trigger, this.client.settings());
    } catch (error) {
      this.options.log?.(`superagent: a wanted pull request failed: ${String(error)}`);
    }
  }
  /**
   * Opens the pull requests people wanted from local tickets, once they linked an account and the ticket reported ready with
   * its patch (which ends a local ticket), as a take-over their message decides, and tells them in its conversation how it
   * went; forgets one whose message is gone, whose ticket ended otherwise, or that waited longer than `WANTED_MS`. The host
   * calls it on each pass, and a link once linked.
   */
  takeOverWanted(): void {
    const { store } = this.client;
    for (const name of store.keys(KV.links.wanted)) {
      const wanted = store.get(name);
      const ticket = store.tickets.get(name.slice(KV.links.wanted.prefix.length));
      const trigger = wanted && store.triggers.get(wanted.triggerId);
      const patched = !!ticket && latestReport(ticket)?.state === "ready" && existsSync(patchPath(this.client.stateDir, ticket));
      if (!wanted || !ticket || !trigger || (!liveTicket(ticket) && !patched) || Date.now() - Date.parse(wanted.at) > WANTED_MS) {
        store.delete(name);
        continue;
      }
      const link = linkOf(store, trigger.actor);
      if (!patched || !link || link.broken) continue;
      store.delete(name);
      let text: string;
      try {
        text = this.takeOver(ticket, trigger, this.client.settings());
      } catch (error) {
        text = failure(error);
      }
      this.answer(trigger, text, key("wanted", ticket.id, trigger.id));
    }
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
