import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import { liveTicket, type Ticket, type Trigger } from "./core/index.js";
import { BotCommands, commandOf } from "./bot-commands.js";
import { SuperagentClient } from "./client.js";
import { readSettings, settingsPath, writeSettings } from "./settings.js";
import { feishuTrigger } from "./sources/feishu.js";
import { patchPath } from "./ticket-tools.js";
import type { Deployment } from "./setup.js";

const BOT = "ou_bot", CHAT = "oc_team", DM = "oc_dm";
const BOSS = "ou_boss", MAINTAINER = "ou_alice", READER = "ou_reader", STRANGER = "ou_stranger";
const NAMES: Record<string, string> = { [BOT]: "w33d", [BOSS]: "Boss", [MAINTAINER]: "Alice", [READER]: "Reader" };

let stateDir: string;
let client: SuperagentClient;
let commands: BotCommands;
let clock: number;
const settings = (access: Record<string, unknown> = {}) => ({
  sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: CHAT, listen: "mentions" }], directMessages: true } } },
  policy: { sources: { feishu: { allowed: [{ id: MAINTAINER, name: "Alice" }], roles: { [BOSS]: "owner", [READER]: "everyone" } } } },
  eval: { mode: "observe" },
  access
});
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-bot-commands-"));
  writeSettings(settings(), settingsPath(stateDir));
  const deployment = { stateDir, repository: "", feishu: { cli: "lark-cli", appId: "cli_app", brand: "feishu", botId: BOT, name: "w33d" } } as unknown as Deployment;
  client = new SuperagentClient({ stateDir, deployment: () => deployment });
  commands = new BotCommands(client);
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
  it("lets an owner have the agent join the conversation in a chat it reads in full, and stop", () => {
    commands.receive(message(BOSS, "/chatter on"));
    expect(replies().at(-1)!.text).toBe("First send /listen all here: I need to read the whole conversation.");
    commands.receive(message(BOSS, "/listen all"));
    commands.receive(message(MAINTAINER, "/chatter on"));
    expect(replies().at(-1)!.text).toBe("That did not work: only an owner can do that");
    commands.receive(message(BOSS, "/chatter on"));
    expect(current().chatter?.chats).toEqual([CHAT]);
    commands.receive(message(MAINTAINER, "/chatter"));
    expect(replies().at(-1)!.text).toBe("I join the conversation here now and then, at most 2 times an hour.");
    // Listening to mentions only also ends joining in, which needs the whole conversation.
    commands.receive(message(BOSS, "/listen mentions"));
    expect(current().chatter?.chats).toEqual([]);
    commands.receive(message(BOSS, "/chatter off"));
    expect(replies().at(-1)!.text).toBe("I'll speak here only when someone mentions me.");
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

describe("take-over", () => {
  it("lets a maintainer take over a local ticket with a patch: a new ticket of theirs that writes to GitHub from it, and the old one ends", () => {
    writeSettings(settings({}), settingsPath(stateDir));
    const local = accept(message(READER, "fix the typo"));
    expect(local.mandate.capability).toEqual({ role: "everyone", write: "local" });
    const root = String(client.store.triggers.get(local.origin.triggerId)!.meta.messageId);
    commands.receive(message(MAINTAINER, "/takeover", { root }));
    expect(replies().at(-1)!.text).toContain("has no patch yet");
    const path = patchPath(stateDir, local);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "From 0000 Mon Sep 17 00:00:00 2001\n");
    commands.receive(message(READER, "/takeover", { root }));
    expect(replies().at(-1)!.text).toContain("You cannot open pull requests from here");
    commands.receive(message(MAINTAINER, "/takeover", { root }));
    const taken = client.store.tickets.list().find((ticket) => ticket.mandate.capability?.from === local.id)!;
    expect(taken.mandate).toMatchObject({ actor: { id: MAINTAINER }, capability: { role: "maintainer", write: "github", from: local.id } });
    expect(taken.execution?.assignment).toContain("fix the typo");
    expect(liveTicket(client.store.tickets.get(local.id)!)).toBe(false);
    expect(replies().at(-1)!.text).toMatch(/^Ticket [0-9a-f]{8} takes over ticket [0-9a-f]{8}/);
    expect(readFileSync(path, "utf8")).toContain("From 0000");
  });
});
