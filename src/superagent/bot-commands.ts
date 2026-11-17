/**
 * Bot commands: a person's Feishu message to the agent that starts with a slash after the mentions that address it, such as
 * `/me`. The host carries each out itself before any model reads the message, records it once so a Source that reads it
 * again finds it known, and answers in the conversation. The router runs some of them for a person whose message asks for
 * what one does (`perform`, see `AGENT_COMMANDS`), as their built-in tools. It also holds back a sender's messages beyond
 * their role's requests per hour, and new requests beyond their open tickets, with an answer that says so.
 */
import { z } from "zod/v4";
import { key, liveTicket, threadKey, type ActorRef, type ChannelRef, type ReceiveResult, type Role, type Ticket, type Trigger, type WriteLevel } from "./core/index.js";
import type { SuperagentClient } from "./client.js";
import { chatterOf } from "./chatter.js";
import { devicesText, type Devices } from "./devices.js";
import { WorktreeNameSchema } from "./messages.js";
import { AUTHORIZATIONS_URL, githubApp, installUrl, linkOf, namedRepository, type GithubApp, type GithubLinks, type LinkView } from "./github-link.js";
import { openTicketsOf, patchReady, takeOverTicket, ticketNamed, wantPullRequest as wantPullRequestFor, type TakeOverOutcome } from "./github-commands.js";
import { KV } from "./kv.js";
import { memoryOf, personSubject } from "./memories.js";
import { addressable, allowedWrite, atLeast, ceilingOf, limitOf, roleOf, seesNodes, watchedRepository } from "./policy.js";
import type { AgentCommand } from "./prompts.js";
import { RoleSchema, WriteLevelSchema, settingsPath, updateSettings, type Settings } from "./settings.js";
import { metaOf } from "./sources/meta.js";
import type { ChatKind } from "./sources/chat.js";
import { hostStatus, ticketRows, whyReport, whyText, usageSummary } from "./views.js";
import { inChinese, sayIn, wordCount, type Say } from "./text.js";

const HOUR_MS = 3_600_000;
import { COMMANDS } from "./command-table.js";
export { COMMANDS, FORWARDED } from "./command-table.js";
export type CommandName = typeof COMMANDS[number];
export interface Command { name: CommandName; args: string[]; mentions: { id: string; name: string }[] }

const MentionsSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const short = (id: string): string => id.slice(0, 8);
const help = (say: Say): string => say(
  "Commands: /me shows your role and limits; /link links your GitHub account (its code comes in a direct message), /unlink removes it, "
    + "/repo [owner/name] lists or sets your default repository; /takeover [ticket] opens a pull request from a local ticket's patch; "
    + "/devices shows what I run work on; /memory shows what I remember about you, /forget <number>|all forgets it. "
    + "You can also ask for these in your own words. "
    + "Owners: /role @name owner|maintainer|everyone|none, /chatter on|off in a group, /ceiling read-only|local|github.",
  "命令：/me 查看你的角色和限额；/link 绑定 GitHub 账号（验证码私聊发给你），/unlink 解除绑定；/repo [owner/name] 列出或设置默认仓库；"
    + "/takeover [工单] 把本地工单的补丁做成拉取请求；/devices 看我能用的设备；/memory 看我记得你什么，/forget <编号>|all 让我忘掉。这些也可以直接跟我说。"
    + "owner 还能用：/role @某人 owner|maintainer|everyone|none，群里的 /chatter on|off，/ceiling read-only|local|github。");
/** How many words one page of /memory holds, within a chat message's limit. */
const MEMORY_PAGE_WORDS = 85;
/** How many repositories an answer names before it says how many more there are. */
const LISTED_REPOS = 8;
const repoList = (link: LinkView, say: Say): string => {
  const names = link.repos.map((repo) => repo === link.defaultRepo ? say(`${repo} (default)`, `${repo}（默认）`) : repo);
  const more = names.length - LISTED_REPOS;
  return more > 0 ? say(`${names.slice(0, LISTED_REPOS).join(", ")} and ${more} more`, `${names.slice(0, LISTED_REPOS).join("、")} 等另外 ${more} 个`)
    : names.join(say(", ", "、"));
};
const notLinked = (say: Say): string => say("Link your GitHub account first: send /link.", "先绑定你的 GitHub 账号：发 /link。");
/** How long a wanted pull request waits for its person to link and for its ticket's patch. */
const WANTED_MS = 7 * 24 * HOUR_MS;

const failure = (say: Say, error: unknown): string =>
  `${say("That did not work: ", "没成功：")}${error instanceof Error ? error.message : String(error)}`.slice(0, 300);

/** The bot command a person's chat message to the agent gives, after the mentions it starts with, if it gives one; `isChat` says which Sources are chats. */
export function commandOf(trigger: Trigger, isChat: (source: string) => boolean = () => false): Command | undefined {
  if (!isChat(trigger.source) || !trigger.human || !trigger.addressed) return undefined;
  const mentions = metaOf(trigger).mentions ?? [];
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
  /** What the host runs its tickets' work on now, which /devices shows; without it /devices says the host does not tell. */
  devices?: () => Promise<Devices>;
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
    const command = commandOf(trigger, this.isChat);
    const say = this.say(trigger);
    const held = this.held(trigger, settings, !command, say);
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
      text = failure(say, error);
    }
    if (text) this.answer(trigger, text, key("command", trigger.id));
    return result;
  }
  /**
   * Runs a command the router chose for a person's message as if they had typed it, which answers in the conversation as
   * the command does; a take-over decides the message.
   */
  perform(trigger: Trigger, name: AgentCommand, args: readonly string[]): void {
    const settings = this.client.settings();
    const say = this.say(trigger);
    let text: string | undefined;
    try {
      const kind = this.kind(trigger);
      text = !kind ? say("Bot commands work only in a chat.", "机器人命令只在聊天里能用。")
        : this.run({ name, args: [...args], mentions: metaOf(trigger).mentions ?? [] }, trigger, settings);
    } catch (error) {
      text = failure(say, error);
    }
    if (text) this.answer(trigger, text, key("command", trigger.id));
  }

  /**
   * How answers to a message are worded: in the language it is written in, or, for a typed command, which has none,
   * Chinese on Feishu and English on Lark.
   */
  private say(trigger: Trigger): Say {
    return sayIn(inChinese(trigger.text) || (!!commandOf(trigger, this.isChat) && this.client.deployment().feishu?.brand !== "lark"));
  }

  /** The chat kind a trigger came by, when its Source has one. */
  private kind(trigger: Trigger): ChatKind | undefined { return this.client.sources.chatKind(trigger.source); }
  /** Whether a Source is a chat kind: bot commands run only in chats. */
  private readonly isChat = (source: string): boolean => this.client.sources.chatKind(source) !== undefined;

  /** Runs a command that answers once GitHub has; its failure is its answer. */
  private later(trigger: Trigger, work: () => Promise<string>): undefined {
    void work().catch((error: unknown) => failure(this.say(trigger), error)).then((text) => this.answer(trigger, text, key("command", trigger.id)),
      (error: unknown) => this.options.log?.(`superagent: a bot command failed: ${String(error)}`));
    return undefined;
  }

  /** Why a sender's message is held back: beyond their requests per hour, or, for one that starts new work, their open tickets. */
  private held(trigger: Trigger, settings: Settings, request: boolean, say: Say): string | undefined {
    const { store } = this.client;
    const role = roleOf(settings, trigger.actor);
    const perHour = limitOf(settings, role, "requestsPerHour");
    const from = new Date(Date.parse(trigger.at) - HOUR_MS).toISOString();
    if (perHour !== undefined && store.read.requests(trigger.actor, from, trigger.at) >= perHour) {
      return say(`You sent ${perHour} requests in the last hour, as many as your role allows, so I did not take this one in. Try again later.`,
        `你最近一小时已经发了 ${perHour} 条请求，达到你角色的上限，这条我没接。稍后再试。`);
    }
    const open = limitOf(settings, role, "openTickets");
    // A message on a Thread without tickets starts new work; one on a ticket's Thread follows it up.
    const thread = store.threads.get(threadKey(trigger.threads[0]!));
    if (!request || open === undefined || thread?.subscriptions.length) return undefined;
    const mine = this.openTickets(trigger).length;
    return mine >= open ? say(`You have ${mine} open tickets, as many as your role allows. Reply in one of their threads, or wait until one finishes.`,
      `你有 ${mine} 张未结工单，达到你角色的上限。请在其中一张的对话里回复，或等一张结束。`) : undefined;
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
      case "help": return help(this.say(trigger));
      case "me": return this.me(trigger, settings);
      case "link": return this.link(trigger, settings);
      case "unlink": return this.unlink(trigger, settings);
      case "repo": return this.repo(command, trigger, settings);
      case "role": return this.role(command, trigger, settings);
      case "ceiling": return this.ceiling(command, trigger, settings);
      case "chatter": return this.chatter(command, trigger, settings);
      case "takeover": return this.takeover(command, trigger, settings);
      case "devices": return this.devices(trigger, settings);
      case "memory": return this.memory(command, trigger, settings);
      case "forget": return this.forget(command, trigger, settings);
      case "status": return this.status(trigger, settings);
      case "tickets": return this.tickets(command, trigger);
      case "usage": return this.later(trigger, () => this.usage(trigger));
      case "why": return this.later(trigger, () => this.why(command, trigger, settings));
      case "mesh": return this.later(trigger, () => this.mesh(trigger, settings));
    }
  }

  /**
   * `/status`: the host as it last reported itself: whether it runs, how many tickets wait in each group, what is not
   * healthy, and replies that failed, were dropped, or wait on a Source that is off.
   */
  private status(trigger: Trigger, settings: Settings): string {
    const say = this.say(trigger);
    const status = hostStatus(this.client);
    const counts = Object.entries(status.counts).filter(([, count]) => count > 0).map(([group, count]) => `${group} ${count}`);
    const unhealthy = Object.entries(status.health).filter(([, entry]) => entry.state !== 'ready')
      .map(([name, entry]) => `${name}: ${entry.state}${entry.detail ? ` (${entry.detail})` : ''}`);
    const lines = [say(`${status.running ? 'Running' : 'Not running here'}; tickets: ${counts.join(', ') || 'none'}.`,
      `${status.running ? '运行中' : '这里没有运行'}；工单：${counts.join('、') || '无'}。`)];
    if (unhealthy.length) lines.push(say(`Not healthy: ${unhealthy.join('; ')}`, `不健康：${unhealthy.join('；')}`));
    const { failing, dropped } = status.replies;
    if (failing.length) lines.push(say(`${failing.length} repl${failing.length === 1 ? 'y' : 'ies'} failing to deliver.`, `${failing.length} 条回复发送失败。`));
    if (dropped.length) lines.push(say(`${dropped.length} repl${dropped.length === 1 ? 'y' : 'ies'} dropped.`, `${dropped.length} 条回复被丢弃。`));
    if (status.waitingOnOff.length) lines.push(say(`${status.waitingOnOff.length} waiting on a Source that is off.`, `${status.waitingOnOff.length} 条回复在等一个关闭的 Source。`));
    if (status.unrouted.length) lines.push(say(`${status.unrouted.length} request${status.unrouted.length === 1 ? '' : 's'} could not be routed.`, `${status.unrouted.length} 条请求没能路由。`));
    if (seesNodes(settings, trigger.actor) && status.pid) lines.push(say(`Host pid ${status.pid}.`, `Host 进程 ${status.pid}。`));
    return lines.join('\n');
  }

  /** `/tickets [page]`: the tickets that are not ended, what each waits for first, a page at a time. */
  private tickets(command: Command, trigger: Trigger): string {
    const say = this.say(trigger);
    const rows = ticketRows(this.client).filter((row) => row.group !== 'ended');
    if (!rows.length) return say('No tickets are open.', '没有未结的工单。');
    const pages: string[][] = [[]];
    for (const row of rows) {
      const line = `${row.short}  ${row.label}  ${row.title}`;
      if (wordCount([...pages.at(-1)!, line].join('\n')) > MEMORY_PAGE_WORDS && pages.at(-1)!.length) pages.push([]);
      pages.at(-1)!.push(line);
    }
    const page = Math.min(pages.length, Math.max(1, Number(command.args.find((arg) => /^\d+$/.test(arg)) ?? 1)));
    const more = page < pages.length ? say(` (page ${page} of ${pages.length}: /tickets ${page + 1})`, `（第 ${page}/${pages.length} 页，发 /tickets ${page + 1}）`) : '';
    return `${say('Open tickets:', '未结工单：')}\n${pages[page - 1]!.join('\n')}${more}`;
  }

  /** `/usage`: what this device's model calls cost today and over the 30 days before. */
  private async usage(trigger: Trigger): Promise<string> {
    const say = this.say(trigger);
    const summary = await usageSummary();
    if (summary === undefined) return say('The usage ledger cannot be read here.', '这里读不到用量账本。');
    const line = (label: string, labelZh: string, item: { calls: number; input: number; output: number; cost: number }) =>
      say(`${label}: ${item.calls} calls, ${item.input + item.output} tokens, $${item.cost.toFixed(4)}`,
        `${labelZh}：${item.calls} 次调用，${item.input + item.output} tokens，$${item.cost.toFixed(4)}`);
    return [line('Today', '今天', summary.today), line('Last 30 days', '最近 30 天', summary.month)].join('\n');
  }

  /** `/why <ticket|message>`: what happened to it, routing, work, talking-path runs and what they cost. For maintainers. */
  private async why(command: Command, trigger: Trigger, settings: Settings): Promise<string> {
    const say = this.say(trigger);
    if (!atLeast(roleOf(settings, trigger.actor), 'maintainer')) return say('Explaining a ticket is for maintainers.', '解释工单只对 maintainer 开放。');
    const handle = command.args[0];
    if (!handle) return say('Usage: /why <ticket or message>', '用法：/why <工单或消息>');
    const report = await whyReport(this.client, handle);
    const text = whyText(this.client, report);
    return text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text;
  }

  /** `/mesh`: the paired nodes and where each is reached. For maintainers. */
  private async mesh(trigger: Trigger, settings: Settings): Promise<string> {
    const say = this.say(trigger);
    if (!atLeast(roleOf(settings, trigger.actor), 'maintainer')) return say('The paired nodes are for maintainers.', '配对节点只对 maintainer 可见。');
    const { meshPeers } = await import('../mesh/state.js');
    const peers = meshPeers();
    if (!peers.length) return say('No devices are paired.', '还没有配对设备。');
    return [say('Paired:', '已配对：'), ...peers.map((peer) => `${peer.name}  ${peer.addresses.join(', ') || 'relay'}`)].join('\n');
  }

  /** `/devices`: what the agent runs work on now; which nodes these are only for maintainers and owners, counts for everyone. */
  private devices(trigger: Trigger, settings: Settings): string | undefined {
    const say = this.say(trigger);
    const { devices } = this.options;
    if (!devices) return say("This host does not tell what it runs work on.", "这台主机不提供设备信息。");
    const names = seesNodes(settings, trigger.actor);
    return this.later(trigger, async () => devicesText(await devices(), names, say));
  }

  private me(trigger: Trigger, settings: Settings): string {
    const say = this.say(trigger);
    const role = roleOf(settings, trigger.actor);
    if (!settings.access) return say(`Your role: ${role}. The access model is off, so everyone on the list may do everything.`,
      `你的角色：${role}。访问模型没有开启，列表里的人什么都能做。`);
    const of = (count: number, limit: number | undefined) => limit === undefined ? String(count) : say(`${count} of ${limit}`, `${count}/${limit}`);
    const from = new Date(Date.parse(trigger.at) - HOUR_MS).toISOString();
    const requests = this.client.store.read.requests(trigger.actor, from, trigger.at);
    const scope = this.client.sources.scope(trigger);
    const ceiling = ceilingOf(settings, trigger.source, scope.listened ? scope.row : undefined);
    const link = githubApp(settings) ? linkOf(this.client.store, trigger.actor) : undefined;
    const github = !githubApp(settings) ? "" : !link ? say(" GitHub: not linked; send /link.", " GitHub：未绑定，发 /link 绑定。")
      : link.broken ? say(` GitHub: @${link.login}, but the link stopped working; send /link again.`, ` GitHub：@${link.login}，但绑定已失效，再发一次 /link。`)
      : !metaOf(trigger).direct ? ` GitHub: @${link.login}.`
      : say(` GitHub: @${link.login}, working on ${link.repos.length ? repoList(link, say) : "no repository yet"}.`,
        ` GitHub：@${link.login}，可用仓库：${link.repos.length ? repoList(link, say) : "还没有"}。`);
    const open = of(this.openTickets(trigger).length, limitOf(settings, role, "openTickets"));
    const asked = of(requests, limitOf(settings, role, "requestsPerHour"));
    return say(`Your role: ${role}. Open tickets: ${open}. Requests in the last hour: ${asked}. Work asked for here writes ${ceiling} at most.${github}`,
      `你的角色：${role}。未结工单：${open}。最近一小时请求：${asked}。这里提出的工作最多写到 ${ceiling}。${github}`);
  }

  /** Whom a memory command is about: the person it names after the command, which only an owner may name for someone else, or the sender. */
  private remembered(command: Command, trigger: Trigger, settings: Settings): { id: string; name: string } {
    const bot = this.client.sources.agent(trigger.source, this.client.resolvedDeployment())?.id;
    const rest = trigger.text.slice(Math.max(0, trigger.text.indexOf(`/${command.name}`)));
    const named = command.mentions.find((mention) => mention.id !== bot && mention.id !== trigger.actor.id && rest.includes(`@${mention.name}`));
    if (!named) return { id: trigger.actor.id, name: "" };
    this.owner(trigger, settings);
    return named;
  }
  /**
   * `/memory [@name] [page]`: what the agent remembers about the sender, or for an owner about someone they name, a page
   * at a time and numbered for /forget; in a group the list goes to the sender's direct messages.
   */
  private memory(command: Command, trigger: Trigger, settings: Settings): string {
    const say = this.say(trigger);
    if (!memoryOf(settings)) return say("My memory is off here.", "这里没有开记忆。");
    const person = this.remembered(command, trigger, settings);
    const notes = this.client.store.memory.about(personSubject(person.id));
    const whom = person.name ? say(`about ${person.name}`, `关于 ${person.name}`) : say("about you", "关于你");
    if (!notes.length) return say(`I don't remember anything ${whom} yet.`, `我还没有记住${whom}的事。`);
    const pages: string[][] = [[]];
    notes.forEach((note, index) => {
      const line = `${index + 1}. ${note.text}${note.kind === "promise" && note.due && !note.done ? say(` (due ${note.due.slice(0, 16).replace("T", " ")} UTC)`, `（${note.due.slice(0, 16).replace("T", " ")} UTC 到期）`) : ""}`;
      if (wordCount([...pages.at(-1)!, line].join("\n")) > MEMORY_PAGE_WORDS && pages.at(-1)!.length) pages.push([]);
      pages.at(-1)!.push(line);
    });
    const page = Math.min(pages.length, Math.max(1, Number(command.args.find((arg) => /^\d+$/.test(arg)) ?? 1)));
    const more = page < pages.length ? say(` (page ${page} of ${pages.length}: /memory ${page + 1} for more)`, `（第 ${page}/${pages.length} 页，发 /memory ${page + 1} 看下一页）`) : "";
    const list = `${say(`What I remember ${whom}:`, `我记得${whom}的：`)}\n${pages[page - 1]!.join("\n")}${more}`;
    if (metaOf(trigger).direct) return list;
    const kind = this.kind(trigger);
    if (!kind) return say("I cannot send you a direct message here.", "这里没法私聊发给你。");
    this.client.outbox.send({ id: key("memory", trigger.id), channel: kind.user(trigger.actor.id), text: list, kind: "reply" });
    return say("I sent you the list in a direct message.", "已经私聊发给你了。");
  }
  /** `/forget <number>|all [@name]`: the agent forgets one note about the sender, as /memory numbers them, or all of them; an owner, about someone they name. */
  private forget(command: Command, trigger: Trigger, settings: Settings): string {
    const say = this.say(trigger);
    if (!memoryOf(settings)) return say("My memory is off here.", "这里没有开记忆。");
    const person = this.remembered(command, trigger, settings);
    const subject = personSubject(person.id);
    const whom = person.name ? say(`about ${person.name}`, `关于 ${person.name}`) : say("about you", "关于你");
    if (command.args.includes("all")) {
      const count = this.client.store.memory.deleteAbout(subject);
      return say(`Forgot everything ${whom} (${count}).`, `${whom}的都忘掉了（${count} 条）。`);
    }
    const number = Number(command.args.find((arg) => /^\d+$/.test(arg)));
    const note = Number.isInteger(number) ? this.client.store.memory.about(subject)[number - 1] : undefined;
    if (!note) return say("Usage: /forget <number from /memory>|all", "用法：/forget <在 /memory 里的编号>|all");
    this.client.store.memory.delete(note.id);
    return say(`Forgot: ${note.text}`, `忘掉了：${note.text}`);
  }

  /** The GitHub App and the host's links, for the commands that need both. */
  private linking(settings: Settings, say?: Say): { app: GithubApp; links: GithubLinks } {
    const app = githubApp(settings);
    const { links } = this.options;
    if (!app || !links) throw new Error((say ?? sayIn(false))("linking GitHub accounts is not set up here", "这里没有开启 GitHub 账号绑定"));
    return { app, links };
  }

  /**
   * `/link`: the device flow's code, then, once the person entered it on GitHub, the account and the repositories they may
   * work on, in a direct message. Asked in a group, both go to their direct messages, since whoever enters the code links
   * their own account to the person who asked.
   */
  private link(trigger: Trigger, settings: Settings): string | undefined {
    const say = this.say(trigger);
    this.linking(settings, say);
    const direct = metaOf(trigger).direct;
    const kind = this.kind(trigger);
    const here = kind ? kind.user(trigger.actor.id) : undefined;
    if (!this.startLink(trigger.actor, direct && trigger.channel ? trigger.channel : here ?? trigger.channel ?? here!, trigger.id, say)) {
      return say("Enter the code I sent you in a direct message, or wait until it expires to ask for another.", "请输入我私聊发你的验证码，或等它过期后再要一个。");
    }
    return direct ? undefined : say("I sent you a direct message with a code to link your GitHub account. If none arrives, send me a direct message saying /link.",
      "我私聊发了你一个验证码，用来绑定 GitHub 账号。没收到的话，私聊我发 /link。");
  }
  /**
   * Starts the device flow of a person, whose code and outcome go to `channel`, a direct message with them; none starts while
   * theirs still waits for its code. Once they linked, the pull requests they wanted are opened.
   * @returns whether it started one.
   */
  private startLink(actor: ActorRef, channel: ChannelRef, id: string, say: Say): boolean {
    const { app, links } = this.linking(this.client.settings(), say);
    const flow = `${actor.source}:${actor.id}`;
    if (this.flows.has(flow)) return false;
    this.flows.add(flow);
    const send = (text: string, part: string) => this.client.outbox.send({ id: key("link", id, part), channel, text, kind: "reply" });
    void (async () => {
      const device = await links.start(app);
      const minutes = Math.round(device.expires_in / 60);
      send(say(`Open ${device.verification_uri} and enter ${device.user_code} within ${minutes} minutes to link your GitHub account.`,
        `打开 ${device.verification_uri}，在 ${minutes} 分钟内输入 ${device.user_code}，绑定你的 GitHub 账号。`), "code");
      const link = await links.link(actor, await links.authorized(app, device, this.lifetime.signal), channel);
      send(link.repos.length
        ? say(`Linked as @${link.login}. You can work on ${repoList(link, say)}. Install the app on more repositories at ${installUrl(app)}.`,
          `已绑定 @${link.login}。可用仓库：${repoList(link, say)}。要用更多仓库，到 ${installUrl(app)} 安装应用。`)
        : say(`Linked as @${link.login}, but the app is not installed on a repository you can push to: install it at ${installUrl(app)}, then send /repo.`,
          `已绑定 @${link.login}，但应用还没装在你能推送的仓库上：到 ${installUrl(app)} 安装后，再发 /repo。`), "linked");
      this.takeOverWanted();
    })().catch((error: unknown) => send(failure(say, error), "failed"))
      .catch((error: unknown) => this.options.log?.(`superagent: linking a GitHub account failed: ${String(error)}`))
      .finally(() => this.flows.delete(flow));
    return true;
  }

  /** `/unlink`: removes the person's link, after which their tickets cannot act as them. */
  private unlink(trigger: Trigger, settings: Settings): string | undefined {
    const say = this.say(trigger);
    const { app, links } = this.linking(settings, say);
    return this.later(trigger, async () => await links.unlink(app, trigger.actor)
      ? say(`Unlinked. To revoke the app's access on GitHub too, go to ${AUTHORIZATIONS_URL}.`, `已解除绑定。要在 GitHub 上也撤销应用的权限，去 ${AUTHORIZATIONS_URL}。`)
      : say("You have no linked GitHub account.", "你没有绑定 GitHub 账号。"));
  }

  /** `/repo [owner/name]`: reads again which repositories the person may work on, and sets their default. */
  private repo(command: Command, trigger: Trigger, settings: Settings): string | undefined {
    const say = this.say(trigger);
    if (!metaOf(trigger).direct) return say("Send /repo to me in a direct message.", "请私聊我发 /repo。");
    const { app, links } = this.linking(settings, say);
    if (!linkOf(this.client.store, trigger.actor)) return notLinked(say);
    return this.later(trigger, async () => {
      const link = await links.refreshRepos(app, trigger.actor);
      if (!link) return say("Your GitHub link stopped working: send /link to link again.", "你的 GitHub 绑定已失效：发 /link 重新绑定。");
      const wanted = command.args[0] && namedRepository(command.args[0], link.repos);
      if (command.args[0] && !wanted) {
        return say(`@${link.login} cannot push to ${command.args[0]} through the app: install it there at ${installUrl(app)}, then send /repo again.`,
          `@${link.login} 没法通过应用推送到 ${command.args[0]}：到 ${installUrl(app)} 在那里安装应用，然后再发一次 /repo。`);
      }
      const now = wanted ? links.setDefault(trigger.actor, wanted)! : link;
      return now.repos.length ? say(`You can work on ${repoList(now, say)}.`, `可用仓库：${repoList(now, say)}。`)
        : say(`The app is not installed on a repository you can push to: install it at ${installUrl(app)}.`, `应用还没装在你能推送的仓库上：到 ${installUrl(app)} 安装。`);
    });
  }

  private owner(trigger: Trigger, settings: Settings): void {
    if (!atLeast(roleOf(settings, trigger.actor), "owner")) throw new Error(this.say(trigger)("only an owner can do that", "只有 owner 能这么做"));
  }

  /** `/role @name… <role>`: an owner gives the people the message mentions a role, or with `none` takes theirs away. */
  private role(command: Command, trigger: Trigger, settings: Settings): string {
    this.owner(trigger, settings);
    const say = this.say(trigger);
    const wanted = command.args.at(-1) ?? "";
    const role = wanted === "none" ? undefined : RoleSchema.safeParse(wanted).data;
    const bot = this.client.sources.agent(trigger.source, this.client.resolvedDeployment())?.id;
    const rest = trigger.text.slice(trigger.text.indexOf("/role"));
    const people = command.mentions.filter((mention) => mention.id !== bot && rest.includes(`@${mention.name}`));
    if ((wanted !== "none" && !role) || !people.length) return say("Usage: /role @name owner|maintainer|everyone|none", "用法：/role @某人 owner|maintainer|everyone|none");
    updateSettings((next) => {
      const part = next.policy.sources[trigger.source] ??= { allowed: [], admission: {} };
      const roles: Record<string, Role> = { ...part.roles };
      for (const person of people) {
        if (role) roles[person.id] = role;
        else delete roles[person.id];
      }
      if (!Object.values(roles).includes("owner")) throw new Error(say("someone must stay an owner", "至少要留一个 owner"));
      part.roles = roles;
      return next;
    }, settingsPath(this.client.stateDir));
    const names = people.map((person) => person.name).join(say(", ", "、"));
    return role ? say(`${names}: ${role} from now on.`, `${names}：从现在起是 ${role}。`) : say(`${names}: no role from now on.`, `${names}：从现在起没有角色。`);
  }

  /** `/ceiling <level>`: an owner sets how far work asked for in this conversation's receiving scope may write. */
  private ceiling(command: Command, trigger: Trigger, settings: Settings): string {
    this.owner(trigger, settings);
    const say = this.say(trigger);
    const level: WriteLevel | undefined = WriteLevelSchema.safeParse(command.args[0]).data;
    const scope = this.client.sources.scope(trigger);
    if (!level) return say("Usage: /ceiling read-only|local|github", "用法：/ceiling read-only|local|github");
    if (!scope.listened || scope.row === undefined) return say("I cannot set a ceiling for this conversation.", "这个对话没法设置上限。");
    const row = scope.row;
    updateSettings((next) => {
      const part = next.policy.sources[trigger.source] ??= { allowed: [], admission: {} };
      part.ceilings = { ...part.ceilings, [row]: level };
      return next;
    }, settingsPath(this.client.stateDir));
    return say(`Work asked for here writes ${level} at most from now on.`, `从现在起，这里提出的工作最多写到 ${level}。`);
  }

  /**
   * `/chatter on|off`, in a group, for an owner: whether the agent joins the conversation there on its own; without an
   * argument, for anyone, whether it does.
   */
  private chatter(command: Command, trigger: Trigger, settings: Settings): string {
    const say = this.say(trigger);
    const chatId = metaOf(trigger).chatId ?? "";
    const current = chatterOf(settings);
    const on = current.everywhere ? !current.off.includes(chatId) : current.chats.includes(chatId);
    if (metaOf(trigger).direct) return say("/chatter works in a group chat.", "/chatter 要在群里用。");
    const mode = command.args[0];
    const perHour = chatterOf(settings).perHour;
    if (!mode) return on ? say(`I join the conversation here now and then, at most ${perHour} times an hour.`, `我会时不时加入这里的对话，每小时最多 ${perHour} 次。`)
      : say("I speak here only when someone mentions me.", "只有有人 @ 我时，我才在这里说话。");
    this.owner(trigger, settings);
    if (mode !== "on" && mode !== "off") return say("Usage: /chatter on|off", "用法：/chatter on|off");
    // It reads the chat from the messages it keeps; `off` holds where every group is on but this one.
    updateSettings((next) => {
      const chatter = chatterOf(next);
      const without = (list: string[]) => list.filter((chat) => chat !== chatId);
      next.chatter = mode === "on" ? { ...chatter, chats: [...new Set([...chatter.chats, chatId])], off: without(chatter.off) }
        : { ...chatter, chats: without(chatter.chats), off: [...new Set([...chatter.off, chatId])] };
      return next;
    }, settingsPath(this.client.stateDir));
    return mode === "on" ? say("I'll join the conversation here now and then.", "我会时不时加入这里的对话。")
      : say("I'll speak here only when someone mentions me.", "之后只有有人 @ 我时，我才在这里说话。");
  }

  /**
   * `/takeover [ticket]`: a ticket that kept its work local, named or the latest on this Thread, goes on as a new ticket of the
   * sender's, which applies its patch and opens a pull request; the old one ends. Its requester, a maintainer, or, for work
   * nobody asked for, anyone who may write to GitHub here may take it over.
   */
  private takeover(command: Command, trigger: Trigger, settings: Settings): string {
    const ticket = this.ticketNamed(command.args[0], trigger);
    if (!ticket) return this.say(trigger)("Name the ticket: /takeover <ticket id>, or send /takeover in its thread.", "请指明工单：/takeover <工单 id>，或在那张工单的对话里发 /takeover。");
    return this.takeOver(ticket, trigger, settings);
  }
  /**
   * Takes a local ticket over for the sender of `trigger`, whose message decides the new ticket, and words how it went. Until
   * they linked an account and the ticket has its patch, the take-over waits for both (see `takeOverWanted`), and a sender
   * who has not linked yet gets the code to link in a direct message.
   */
  private takeOver(ticket: Ticket, trigger: Trigger, settings: Settings): string {
    const { client } = this;
    const say = this.say(trigger);
    const name = short(ticket.id);
    const outcome: TakeOverOutcome = takeOverTicket(client, ticket, trigger, settings);
    if (outcome.kind === "taken") {
      return say(`Ticket ${short(outcome.ticketId)} takes over ticket ${name}: it applies the patch and opens a pull request.`,
        `工单 ${short(outcome.ticketId)} 接手了工单 ${name}：它会应用补丁并开拉取请求。`);
    }
    if (outcome.kind === "waiting" && outcome.needs === "patch") {
      wantPullRequestFor(client, ticket, trigger);
      const login = linkOf(client.store, trigger.actor)?.login ?? "you";
      return say(`Ticket ${name} has no patch yet: I'll open the pull request as @${login} once it reports ready.`,
        `工单 ${name} 还没有补丁：等它完成后，我会以 @${login} 的身份开拉取请求。`);
    }
    if (outcome.kind === "waiting") {
      wantPullRequestFor(client, ticket, trigger);
      const direct = metaOf(trigger).direct && !!trigger.channel;
      const via = this.kind(trigger)?.user(trigger.actor.id) ?? trigger.channel;
      const here = !!via && this.startLink(trigger.actor, direct ? trigger.channel! : via, trigger.id, say) && direct;
      return say(`Link your GitHub account first: enter the code ${here ? "I'm sending you here" : "I sent you in a direct message"}. `
        + `Once it is linked${patchReady(client, ticket) ? "" : ` and ticket ${name} reports ready`}, I'll open the pull request as you.`,
        `先绑定你的 GitHub 账号：输入${here ? "我在这里发你" : "我私聊发你"}的验证码。绑定好${patchReady(client, ticket) ? "" : `、工单 ${name} 完成`}后，我会以你的身份开拉取请求。`);
    }
    switch (outcome.reason) {
      case "not-local":
        return say(`Ticket ${name} does not keep its work local, so there is nothing to take over.`, `工单 ${name} 不是本地工单，没有可接手的补丁。`);
      case "already-taken":
        return say(`Ticket ${name} was taken over as ticket ${short(outcome.taker ?? "")} already.`, `工单 ${name} 已经由工单 ${short(outcome.taker ?? "")} 接手了。`);
      case "not-steerer":
        return say(`Only the person who asked for ticket ${name} or a maintainer can take it over.`, `只有提出工单 ${name} 的人或 maintainer 能接手它。`);
      case "cannot-write": {
        const link = linkOf(client.store, trigger.actor);
        // Linking can only help when this conversation's ceiling lets a take-over write to GitHub at all; otherwise the
        // ceiling is what stops it, and the person would link for nothing.
        if (!link || link.broken) {
          const scope = client.sources.scope(trigger);
          const row = scope.listened ? scope.row : undefined;
          const mandate = { strength: "explicit" as const, actor: trigger.actor, basis: { via: "addressed" as const, addressed: "mention" as const, source: trigger.source, ...(row === undefined ? {} : { row }) } };
          if (allowedWrite(settings, mandate) !== "github") {
            return say(`The work here cannot write to GitHub: this conversation's ceiling does not let it, so linking would not change that.`,
              `这里的工作不能写到 GitHub：这个对话的上限不允许，绑定账号也不会改变。`);
          }
        }
        if (!link || link.broken || !githubApp(settings) || !this.options.links) return notLinked(say);
        const watched = watchedRepository(settings);
        return say(`You cannot open pull requests on ${watched} from here (your role: ${roleOf(settings, trigger.actor)}, GitHub: @${link.login}).`,
          `你在这里不能在 ${watched} 上开拉取请求（你的角色：${roleOf(settings, trigger.actor)}，GitHub：@${link.login}）。`);
      }
      case "limit": {
        const mine = openTicketsOf(client, trigger, ticket.id).length;
        return say(`You have ${mine} open tickets, as many as your role allows: take this over once one finishes.`, `你有 ${mine} 张未结工单，达到你角色的上限：等一张结束后再接手。`);
      }
    }
  }
  /**
   * After the router accepted work from someone who wants a pull request from it but cannot open one yet, as their GitHub
   * account is not linked: the ticket, kept local, is taken over once they linked it and it reported ready, and they get
   * the code to link in a direct message (see `takeOver`).
   */
  wantPullRequest(trigger: Trigger, ticketId: string): void {
    const ticket = this.client.store.tickets.get(ticketId);
    if (!ticket || !this.isChat(trigger.source)) return;
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
      const patched = !!ticket && patchReady(this.client, ticket);
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
        text = failure(this.say(trigger), error);
      }
      this.answer(trigger, text, key("wanted", ticket.id, trigger.id));
    }
  }

  /** The ticket `/takeover` names: by its id's start or its name, else the latest local ticket on the message's Threads. */
  private ticketNamed(name: string | undefined, trigger: Trigger): Ticket | undefined {
    return ticketNamed(this.client, name, trigger.threads);
  }
}
