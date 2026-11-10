import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import { liveTicket, type Ticket, type Trigger } from "./core/index.js";
import { BotCommands, commandOf } from "./bot-commands.js";
import { devicesOf } from "./devices.js";
import { GithubLinks, linkKey, linkOf } from "./github-link.js";
import { KV } from "./kv.js";
import { SuperagentClient } from "./client.js";
import { readSettings, settingsPath, writeSettings } from "./settings.js";
import { feishuTrigger } from "./sources/feishu.js";
import { fileReport, patchPath } from "./ticket-tools.js";
import type { Deployment } from "./setup.js";

const BOT = "ou_bot", CHAT = "oc_team", DM = "oc_dm";
const BOSS = "ou_boss", MAINTAINER = "ou_alice", READER = "ou_reader", STRANGER = "ou_stranger";
const NAMES: Record<string, string> = { [BOT]: "w33d", [BOSS]: "Boss", [MAINTAINER]: "Alice", [READER]: "Reader" };

let stateDir: string;
let client: SuperagentClient;
let commands: BotCommands;
let clock: number;
let links: GithubLinks;
/** The bot's brand, which words answers to a bare command: Chinese on Feishu, English on Lark. */
let brand: "feishu" | "lark";
/** GitHub's answers by path. */
let answers: Record<string, unknown>;
const fakeFetch: typeof fetch = async (input) => {
  const answer = answers[new URL(String(input)).pathname];
  return answer === undefined ? new Response("not found", { status: 404 }) : Response.json(answer);
};
/** Links a sender's GitHub account as the device flow would, with the repositories they may push to. */
function linkAs(sender: string, login: string, repos: string[]): void {
  client.store.set(KV.links.github("feishu", sender), { login, id: 7, repos, reposAt: "", linkedAt: "", access: { iv: "", data: "", tag: "" } });
}
const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };
const WATCHED = "owner/watched";
const APP = { clientId: "Iv23client", slug: "swarm-oauth" };
const settings = (access: Record<string, unknown> = {}) => ({
  sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: true } },
    github: { enabled: false, config: { repository: WATCHED, app: APP } } },
  policy: { sources: { feishu: { allowed: [{ id: MAINTAINER, name: "Alice" }], roles: { [BOSS]: "owner", [READER]: "everyone" } } } },
  eval: { mode: "observe" },
  access
});
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-bot-commands-"));
  brand = "lark";
  writeSettings(settings(), settingsPath(stateDir));
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", get brand() { return brand; }, botId: BOT, name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  answers = {};
  links = new GithubLinks({ store: client.store, key: () => linkKey(stateDir), fetch: fakeFetch, sleep: async () => {} });
  commands = new BotCommands(client, { links });
  clock = Date.parse("2026-11-09T10:00:00Z");
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A Feishu message from `sender`: in the group with `mention`s (the bot first by default), or as a direct message. */
function message(sender: string, text: string, options: { direct?: boolean; mentions?: string[]; root?: string } = {}): Trigger {
  clock += 1000;
  const mentions = options.direct ? options.mentions ?? [] : options.mentions ?? [BOT];
  const id = `om_${clock}`;
  return feishuTrigger({
    message_id: id, chat_id: options.direct ? DM : CHAT, chat_type: options.direct ? "p2p" : "group", sender_id: sender, sender_type: "user",
    content: [...mentions.map((person, index) => `@_user_${index + 1}`), text].join(" "), create_time: String(clock),
    mentions: mentions.map((person, index) => ({ id: person, key: `@_user_${index + 1}`, name: NAMES[person] ?? person })),
    ...(options.root ? { root_id: options.root } : {})
  }, BOT, "cli_app")!;
}
const replies = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string; channel: { address: Record<string, string> } });
const current = () => readSettings(settingsPath(stateDir)).settings;

describe("bot commands", () => {
  it("reads a command after the mentions that address the agent, and nothing else as one", () => {
    expect(commandOf(message(MAINTAINER, "/me"))).toMatchObject({ name: "me", args: [] });
    expect(commandOf(message(BOSS, "/role @Reader maintainer", { mentions: [BOT, READER] }))).toMatchObject({ name: "role", args: ["@Reader", "maintainer"] });
    expect(commandOf(message(MAINTAINER, "/me", { direct: true }))).toMatchObject({ name: "me" });
    expect(commandOf(message(MAINTAINER, "/etc/hosts looks wrong"))).toBeUndefined();
    expect(commandOf(message(MAINTAINER, "please check /me"))).toBeUndefined();
  });
  it("answers /me once, records it so it reaches no Eval, and takes it in once", () => {
    const trigger = message(MAINTAINER, "/me", { direct: true });
    expect(commands.receive(trigger)).toBe("stored");
    expect(commands.receive(trigger)).toBe("duplicate");
    expect(client.store.triggers.disposition(trigger.id)).toMatchObject({ command: "me", fanout: [] });
    expect(client.store.threads.active()).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]!.text).toContain("Your role: maintainer");
    expect(replies()[0]!.channel.address.messageId).toBe(trigger.meta.messageId);
  });
  it("lets an owner give the people a message mentions a role, keeps an owner, and refuses everyone else", () => {
    commands.receive(message(BOSS, "/role @Reader @Alice maintainer", { mentions: [BOT, READER, MAINTAINER] }));
    expect(current().policy.sources.feishu?.roles).toEqual({ [BOSS]: "owner", [READER]: "maintainer", [MAINTAINER]: "maintainer" });
    commands.receive(message(BOSS, "/role @Reader none", { mentions: [BOT, READER] }));
    expect(current().policy.sources.feishu?.roles).toEqual({ [BOSS]: "owner", [MAINTAINER]: "maintainer" });
    commands.receive(message(BOSS, "/role @Boss everyone", { mentions: [BOT, BOSS] }));
    commands.receive(message(MAINTAINER, "/role @Alice owner", { mentions: [BOT, MAINTAINER] }));
    expect(current().policy.sources.feishu?.roles).toEqual({ [BOSS]: "owner", [MAINTAINER]: "maintainer" });
    expect(replies().map((reply) => reply.text)).toEqual(["Reader, Alice: maintainer from now on.", "Reader: no role from now on.",
      "That did not work: someone must stay an owner", "That did not work: only an owner can do that"]);
  });
  it("lets an owner list the chat with what the agent reads there, and set how far work asked for there writes", () => {
    commands.receive(message(BOSS, "/listen all"));
    expect(current().sources.feishu?.config.chats).toEqual([{ chatId: CHAT, listen: "all" }]);
    commands.receive(message(BOSS, "/ceiling local"));
    expect(current().policy.sources.feishu?.ceilings).toEqual({ [CHAT]: "local" });
    commands.receive(message(BOSS, "/listen all", { direct: true }));
    expect(replies().at(-1)!.text).toBe("/listen works in a group chat.");
  });
  it("lets an owner have the agent join the conversation in a chat or keep out of it, whatever it listens to there", () => {
    commands.receive(message(MAINTAINER, "/chatter on"));
    expect(replies().at(-1)!.text).toBe("That did not work: only an owner can do that");
    commands.receive(message(BOSS, "/chatter on"));
    expect(current().chatter?.chats).toEqual([CHAT]);
    commands.receive(message(MAINTAINER, "/chatter"));
    expect(replies().at(-1)!.text).toBe("I join the conversation here now and then, at most 2 times an hour.");
    // What it listens to is apart: it reads the chat from the messages it keeps.
    commands.receive(message(BOSS, "/listen mentions"));
    expect(current().chatter?.chats).toEqual([CHAT]);
    commands.receive(message(BOSS, "/chatter off"));
    expect(replies().at(-1)!.text).toBe("I'll speak here only when someone mentions me.");
    expect(current().chatter).toMatchObject({ chats: [], off: [CHAT] });
    // In every group, an owner's /chatter off keeps it out of this one.
    writeSettings({ ...current(), chatter: { ...current().chatter, everywhere: true } }, settingsPath(stateDir));
    commands.receive(message(MAINTAINER, "/chatter"));
    expect(replies().at(-1)!.text).toBe("I speak here only when someone mentions me.");
    commands.receive(message(BOSS, "/chatter on"));
    expect(current().chatter).toMatchObject({ everywhere: true, off: [] });
  });
  it("hands every other message, and anything from a sender the gate would not take, to the Engine", () => {
    const request = message(READER, "fix the typo");
    expect(commands.receive(request)).toBe("stored");
    expect(client.store.threads.active().map((thread) => thread.pending)).toEqual([[request.id]]);
    const stranger = message(STRANGER, "/me");
    expect(commands.receive(stranger)).toBe("stored");
    expect(client.store.triggers.disposition(stranger.id)?.command).toBeUndefined();
    expect(replies()).toEqual([]);
  });
});

describe("devices", () => {
  /** A bot VM with OpenCode, paired with a Mac that has Codex and a PC that does not answer, one of its three workers busy. */
  const view = { here: { name: "bot-vm", abilities: ["linux", "harness:opencode"] }, peers: [{ name: "mac", abilities: ["macos", "harness:codex"] }], offline: ["pc"] };
  it("shows a maintainer which nodes the agent runs work on and everyone else counts, also when the router runs it for them", async () => {
    commands = new BotCommands(client, { links, devices: async () => devicesOf({ settings: client.settings(), store: client.store, view, running: 1 }) });
    commands.receive(message(MAINTAINER, "/devices"));
    await until(() => replies().length === 1);
    expect(replies()[0]!.text).toBe("This node: bot-vm (linux; harnesses: opencode). Paired nodes: mac, online (macos; harnesses: codex); pc, offline. "
      + "Workers: 2 of 3 free, as processes on this node.");
    commands.receive(message(READER, "/devices"));
    await until(() => replies().length === 2);
    expect(replies()[1]!.text).toBe("Paired nodes: 2, 1 online. Workers: 2 of 3 free, as processes on this node. Only maintainers and owners see which nodes these are.");
    const asked = message(READER, "你现在能调用哪些设备？");
    commands.receive(asked);
    commands.perform(asked, "devices", []);
    await until(() => replies().length === 3);
    expect(replies()[2]!.text).toBe("配对节点：2 个，1 个在线。worker：3 个，空闲 2 个，在本机以进程运行。只有 maintainer 和 owner 能看到具体是哪些节点。");
    commands = new BotCommands(client, { links });
    commands.receive(message(MAINTAINER, "/devices"));
    expect(replies().at(-1)!.text).toBe("This host does not tell what it runs work on.");
  });
});

describe("request limits", () => {
  it("holds back a sender's messages beyond their requests per hour, answering once", () => {
    writeSettings(settings({ limits: { everyone: { requestsPerHour: 2 } } }), settingsPath(stateDir));
    const sent = [1, 2, 3, 4].map((n) => message(READER, `request ${n}`, { direct: true }));
    for (const trigger of sent) commands.receive(trigger);
    expect(sent.map((trigger) => client.store.triggers.disposition(trigger.id)?.command)).toEqual([undefined, undefined, "limit", "limit"]);
    expect(replies().map((reply) => reply.text)).toEqual(["You sent 2 requests in the last hour, as many as your role allows, so I did not take this one in. Try again later."]);
    // An hour later the sender may ask again.
    clock += 3_600_000;
    const later = message(READER, "later", { direct: true });
    commands.receive(later);
    expect(client.store.triggers.disposition(later.id)?.command).toBeUndefined();
  });
  it("holds back new work beyond a sender's open tickets, and lets their follow-ups through", () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const first = accept(message(READER, "fix the typo"));
    const again = message(READER, "and another thing");
    commands.receive(again);
    expect(client.store.triggers.disposition(again.id)?.command).toBe("limit");
    expect(replies().at(-1)!.text).toContain("You have 1 open tickets");
    const followup = message(READER, "use British spelling", { root: String(client.store.triggers.get(first.origin.triggerId)!.meta.messageId) });
    commands.receive(followup);
    expect(client.store.triggers.disposition(followup.id)).toMatchObject({ fanout: [first.id] });
  });
});

/** Takes a message in and accepts it as a ticket, as the router would. */
function accept(trigger: Trigger): Ticket {
  commands.receive(trigger);
  client.engine.evaluateDue();
  const decision = client.engine.decide(trigger.id, { kind: "accept", title: "Fix the typo", scope: "Fix the typo", reason: "requested", name: "fix-typo" });
  return client.store.tickets.get(decision.ticketId!)!;
}

/** Has a local ticket report ready with its commits as a patch, as its worker would. */
async function ready(ticket: Ticket): Promise<void> {
  client.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
  const patch = "From 0000 Mon Sep 17 00:00:00 2001\n";
  await fileReport(client, ticket.id, { state: "ready", summary: "Done.", patch: { text: patch, bytes: patch.length, uncommitted: false } });
}
const takerOf = (ticket: Ticket) => client.store.tickets.list().find((item) => item.mandate.capability?.from === ticket.id);
/** GitHub's answers for a device flow the person completes at once, linking `login` with push access to `repos`. */
const deviceFlow = (login: string, repos: string[]) => ({
  "/login/device/code": { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
  "/login/oauth/access_token": { access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 15897600 },
  "/user": { login, id: 7 }, "/user/installations": { installations: [{ id: 1 }] },
  "/user/installations/1/repositories": { repositories: repos.map((full_name) => ({ full_name, permissions: { push: true } })) }
});

describe("take-over", () => {
  it("lets a maintainer take over a local ticket with a patch: a new ticket of theirs that writes to GitHub from it, and the old one ends", () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const local = accept(message(READER, "fix the typo"));
    expect(local.mandate.capability).toEqual({ role: "everyone", write: "local" });
    const root = String(client.store.triggers.get(local.origin.triggerId)!.meta.messageId);
    linkAs(MAINTAINER, "alice-gh", ["alice-gh/tool"]);
    commands.receive(message(MAINTAINER, "/takeover", { root }));
    expect(replies().at(-1)!.text).toContain(`You cannot open pull requests on ${WATCHED} from here`);
    linkAs(MAINTAINER, "alice-gh", ["alice-gh/tool", WATCHED]);
    // Without a patch yet, the take-over waits for one.
    commands.receive(message(MAINTAINER, "/takeover", { root }));
    expect(replies().at(-1)!.text).toContain("has no patch yet: I'll open the pull request as @alice-gh once it reports ready");
    expect(client.store.get(KV.links.wanted(local.id))).toBeDefined();
    const path = patchPath(stateDir, local);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "From 0000 Mon Sep 17 00:00:00 2001\n");
    commands.receive(message(MAINTAINER, "/takeover", { root }));
    const taken = takerOf(local)!;
    expect(taken.mandate).toMatchObject({ actor: { id: MAINTAINER }, capability: { role: "maintainer", write: "github", from: local.id,
      credential: { login: "alice-gh", id: 7 }, repository: WATCHED } });
    expect(taken.execution?.assignment).toContain("fix the typo");
    expect(liveTicket(client.store.tickets.get(local.id)!)).toBe(false);
    expect(replies().at(-1)!.text).toMatch(/^Ticket [0-9a-f]{8} takes over ticket [0-9a-f]{8}/);
    expect(readFileSync(path, "utf8")).toContain("From 0000");
    expect(client.store.get(KV.links.wanted(local.id))).toBeUndefined();
    // A ticket is taken over once.
    commands.receive(message(MAINTAINER, "/takeover", { root }));
    expect(replies().at(-1)!.text).toContain(`was taken over as ticket ${taken.id.slice(0, 8)} already`);
  });
  it("lets a requester of any role take over their own ticket once linked, beside the open ticket it replaces", async () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const local = accept(message(READER, "fix the typo"));
    await ready(local);
    linkAs(READER, "reader-gh", [WATCHED]);
    commands.receive(message(READER, "/takeover", { root: String(client.store.triggers.get(local.origin.triggerId)!.meta.messageId) }));
    expect(takerOf(local)?.mandate.capability).toMatchObject({ role: "everyone", write: "github", credential: { login: "reader-gh" } });
  });
  it("has someone who wants a pull request but has not linked GitHub link it in a direct message, and opens it once linked and ready", async () => {
    writeSettings(settings({}), settingsPath(stateDir));
    answers = deviceFlow("reader-gh", [WATCHED]);
    const local = accept(message(READER, "fix the typo and open a pull request"));
    const origin = client.store.triggers.get(local.origin.triggerId)!;
    commands.wantPullRequest(origin, local.id);
    await until(() => replies().length === 2);
    // The code goes to their direct messages, not the group, where anyone could enter it.
    expect(replies().map((reply) => reply.text)).toEqual([
      "Open https://github.com/login/device and enter ABCD-1234 within 15 minutes to link your GitHub account.",
      `Linked as @reader-gh. You can work on ${WATCHED}. Install the app on more repositories at https://github.com/apps/swarm-oauth/installations/new.`
    ]);
    expect(replies()[0]!.channel.address).toEqual({ userId: READER, mode: "user", direct: "true" });
    // Linked before the ticket is ready, it waits for its patch.
    commands.takeOverWanted();
    expect(takerOf(local)).toBeUndefined();
    await ready(local);
    commands.takeOverWanted();
    expect(takerOf(local)?.mandate).toMatchObject({ actor: { id: READER }, capability: { write: "github", from: local.id, credential: { login: "reader-gh" }, repository: WATCHED } });
    expect(replies().at(-1)).toMatchObject({ text: expect.stringMatching(/takes over ticket/), channel: { address: { messageId: origin.meta.messageId } } });
    expect(client.store.get(KV.links.wanted(local.id))).toBeUndefined();
  });
});

describe("GitHub links", () => {
  it("links an account with a code that goes to a direct message, then names the account and its repositories", async () => {
    answers = deviceFlow("alice-gh", [WATCHED]);
    commands.receive(message(MAINTAINER, "/link"));
    await until(() => replies().length === 3);
    expect(replies().map((reply) => reply.text)).toEqual([
      "I sent you a direct message with a code to link your GitHub account. If none arrives, send me a direct message saying /link.",
      "Open https://github.com/login/device and enter ABCD-1234 within 15 minutes to link your GitHub account.",
      `Linked as @alice-gh. You can work on ${WATCHED}. Install the app on more repositories at https://github.com/apps/swarm-oauth/installations/new.`
    ]);
    expect(replies()[1]!.channel.address).toEqual({ userId: MAINTAINER, mode: "user", direct: "true" });
    expect(linkOf(client.store, { source: "feishu", id: MAINTAINER })).toMatchObject({ login: "alice-gh", repos: [WATCHED], channel: { address: { userId: MAINTAINER } } });
    // In a direct message, the code comes there.
    commands.receive(message(MAINTAINER, "/link", { direct: true }));
    await until(() => replies().length === 5);
    expect(replies()[3]!.channel.address).toMatchObject({ chatId: DM });
    commands.receive(message(MAINTAINER, "/me", { direct: true }));
    expect(replies().at(-1)!.text).toContain(`GitHub: @alice-gh, working on ${WATCHED}.`);
  });
  it("answers in the language a person writes in, and a bare command in Chinese on Feishu", () => {
    const asked = message(MAINTAINER, "我在这里能做什么？");
    commands.receive(asked);
    commands.perform(asked, "me", []);
    expect(replies().at(-1)!.text).toContain("你的角色：maintainer。");
    commands.receive(message(MAINTAINER, "/help"));
    expect(replies().at(-1)!.text).toMatch(/^Commands: /);
    brand = "feishu";
    commands.receive(message(MAINTAINER, "/help"));
    expect(replies().at(-1)!.text).toMatch(/^命令：/);
  });
  it("runs a command the router chose for a person's message as if they had typed it", () => {
    const asked = message(MAINTAINER, "what can I do here?");
    commands.receive(asked);
    commands.perform(asked, "me", []);
    expect(replies().at(-1)).toMatchObject({ text: expect.stringContaining("Your role: maintainer"), channel: { address: { messageId: asked.meta.messageId } } });
  });
  it("sets a default repository among the ones the app may push to, and unlinks", async () => {
    answers = { "/user": { login: "alice-gh", id: 7 }, "/user/installations": { installations: [{ id: 1 }] },
      "/user/installations/1/repositories": { repositories: [{ full_name: WATCHED, permissions: { push: true } }, { full_name: "alice-gh/tool", permissions: { push: true } }] } };
    await links.link({ source: "feishu", id: MAINTAINER }, { access_token: "ghu_ok", expires_in: 28800 });
    commands.receive(message(MAINTAINER, "/repo alice-gh/tool", { direct: true }));
    await until(() => replies().length === 1);
    expect(replies()[0]!.text).toBe(`You can work on alice-gh/tool (default), ${WATCHED}.`);
    commands.receive(message(MAINTAINER, "/repo someone/else", { direct: true }));
    await until(() => replies().length === 2);
    expect(replies()[1]!.text).toContain("@alice-gh cannot push to someone/else through the app");
    commands.receive(message(MAINTAINER, "/unlink", { direct: true }));
    await until(() => replies().length === 3);
    expect(replies()[2]!.text).toContain("Unlinked.");
    expect(linkOf(client.store, { source: "feishu", id: MAINTAINER })).toBeUndefined();
  });
});
