import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { liveTicket, type Trigger } from "./core/index.js";
import { ModelAssessor, routeProblem, type AgentCommands, type Complete } from "./assessor.js";
import { SuperagentClient } from "./client.js";
import { devicesOf } from "./devices.js";
import { KV } from "./kv.js";
import { placementOf, workNeeds, type MeshView } from "./placement.js";
import { settingsPath, writeSettings } from "./settings.js";
import { commentTrigger } from "./sources/github-trigger.js";

let stateDir: string;
let client: SuperagentClient;
let answers: string[];
let calls: { purpose: string; system: string; user: string }[];
let assessor: ModelAssessor;
/** This node and its paired nodes as a mesh node shows them to the router; none on a host that is not a mesh node. */
let view: MeshView | undefined;
/** Why reading what the host runs work on fails, when it does. */
let devicesFail: string | undefined;
let opened = false;
const complete: Complete = async (input) => {
  calls.push(input);
  const answer = answers.shift();
  if (answer === undefined) throw new Error("no scripted answer");
  return answer;
};
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-superagent-assessor-"));
  answers = [];
  calls = [];
  view = undefined;
  devicesFail = undefined;
});
afterEach(() => {
  if (opened) client.close();
  opened = false;
  rmSync(stateDir, { recursive: true, force: true });
});
function start(settings: unknown = {}, commands?: AgentCommands) {
  writeSettings(settings, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
  opened = true;
  assessor = new ModelAssessor({ client, complete, configured: () => false, mesh: async () => view, ...(commands ? { commands } : {}),
    devices: async () => {
      if (devicesFail) throw new Error(devicesFail);
      return devicesOf({ settings: client.settings(), store: client.store, ...(view ? { view } : {}), running: 1 });
    } });
}
/** Runs the Eval the Trigger is in, as the host's assessment effect does. */
async function judge(triggerId: string) {
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId);
  assert.ok(candidate, "an Eval holds the Trigger");
  await assessor.judge(triggerId, candidate.evalId);
}
const accept = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  kind: "accept", title: "Fix the README typo", worktree_name: "fix-readme-typo", acknowledgement: "On it: fixing the README typo.", ...overrides
});

test("routes an explicit request to a new ticket with the router's title, name and acknowledgement", async () => {
  start();
  const { triggerId } = client.request("fix the typo in README");
  answers.push(accept());
  await judge(triggerId);
  const decision = client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!;
  assert.equal(decision.kind, "accept");
  const ticket = client.store.tickets.get(decision.ticketId!)!;
  assert.equal(ticket.title, "Fix the README typo");
  assert.match(ticket.execution!.name, /^fix-readme-typo-/);
  assert.equal(calls[0]!.purpose, "superagent_route");
  assert.match(calls[0]!.system, /Return exactly one JSON object/);
  assert.equal(JSON.parse(calls[0]!.user).candidate.strength, "explicit");
});

test("records what the router says accepted work needs of its machine, for a mesh node to place its worker", async () => {
  start();
  const { triggerId } = client.request("retrain the model on the GPU box");
  answers.push(accept({ title: "Retrain the model", worktree_name: "retrain-model", needs: ["GPU", "linux", "gpu"] }));
  await judge(triggerId);
  const ticketId = client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!.ticketId!;
  assert.deepEqual(placementOf(client, client.store.tickets.get(ticketId)!)?.needs, ["gpu", "linux"]);

  const plain = client.request("fix the typo in README");
  answers.push(accept());
  await judge(plain.triggerId);
  const other = client.store.decisions.get(client.store.triggers.disposition(plain.triggerId)!.decisionId!)!.ticketId!;
  assert.equal(placementOf(client, client.store.tickets.get(other)!), undefined, "work any machine can do has no placement");
});

test("asks again with the problem when an answer breaks a limit, and leaves the Eval undecided after a second bad answer", async () => {
  start();
  const { triggerId } = client.request("rename the script");
  answers.push(accept({ worktree_name: "Rename The Script" }), accept({ worktree_name: "rename-script" }));
  await judge(triggerId);
  assert.match(JSON.parse(calls[1]!.user).problem, /worktree_name/);
  assert.ok(client.store.triggers.disposition(triggerId)!.decisionId);

  const second = client.request("another request");
  answers.push("not json", JSON.stringify({ kind: "ignore" }));
  await assert.rejects(judge(second.triggerId), /could not be used/);
  assert.equal(client.store.triggers.disposition(second.triggerId)?.decisionId, undefined);
});

test("routeProblem names the field a kind needs", () => {
  assert.equal(routeProblem({ kind: "attach" }), "attach needs ticket_id");
  assert.equal(routeProblem({ kind: "ignore", reason: "chat" }), undefined);
  assert.match(routeProblem({ kind: "accept", title: "x", worktree_name: "ok-name", acknowledgement: "word ".repeat(120) }) ?? "", /acknowledgement/);
});

const githubSettings = (mode: "observe" | "auto") => ({
  sources: { github: { enabled: true, config: { repository: "acme/widgets", cli: "gh", observeComments: true } } },
  policy: { sources: { github: { allowed: [{ id: "alice" }] } } },
  eval: { mode }
});
const comment = (id: number, body: string, login = "alice"): Trigger => commentTrigger(
  { id, body, user: { login, type: "User" }, html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`, created_at: `2026-11-01T00:00:0${id}Z` },
  { number: 7, isPr: false, url: "https://github.com/acme/widgets/issues/7" }, "conversation", "agent-bot");
const assessment = (decision: "accept" | "ignore") => JSON.stringify({
  decision,
  rule_assessments: [{ rule_id: "copy", matched: decision === "accept", reason: "a wording fix" }, { rule_id: "visual", matched: false, reason: "no visual change" }],
  direction: { implementation_requested: true, target_basis: "specified", requires_design_decision: false, evidence: "\"Save changes\" should read \"Save\"" },
  title: "Shorten the save label", scope: "Change the label to Save", reason: "a concrete copy fix",
  worktree_name: "shorten-save-label", intent_evidence: "\"just 'Save' would do\"", acknowledgement: "On it: changing the label to Save."
});

test("records an observed proactive accept as ignore with would_accept, and accepts it in auto mode", async () => {
  start(githubSettings("observe"));
  const observed = comment(1, "the button should just say 'Save'");
  client.engine.receive(observed);
  answers.push(assessment("accept"));
  await judge(observed.id);
  const ignored = client.store.decisions.get(client.store.triggers.disposition(observed.id)!.decisionId!)!;
  assert.equal(ignored.kind, "ignore");
  assert.equal((ignored.audit as { would_accept?: boolean }).would_accept, true);
  assert.equal(calls[0]!.purpose, "superagent_assessment");
  assert.match(JSON.parse(calls[0]!.user).candidate.thread.error, /Thread context unavailable/);

  writeSettings(githubSettings("auto"), settingsPath(stateDir));
  const accepted = comment(2, "and the cancel button should just say 'Close'");
  client.engine.receive(accepted);
  answers.push(assessment("accept"));
  await judge(accepted.id);
  const decision = client.store.decisions.get(client.store.triggers.disposition(accepted.id)!.decisionId!)!;
  assert.equal(decision.kind, "accept");
  const ticket = client.store.tickets.get(decision.ticketId!)!;
  assert.equal(ticket.mandate.strength, "inferred");
  assert.deepEqual(ticket.mandate.basis.rules, ["copy"]);
});

test("stops the tickets a person's follow-up asks to stop, and nothing on a message that only comments", async () => {
  start(githubSettings("observe"));
  const request = comment(1, "@agent-bot please fix the label typo");
  client.engine.receive(request);
  answers.push(accept());
  await judge(request.id);
  const ticketId = client.store.triggers.disposition(request.id)!.fanout[0] ?? client.store.tickets.list()[0]!.id;

  const chatter = comment(2, "thanks, looks good so far");
  client.engine.receive(chatter);
  const queued = client.store.db.prepare("SELECT key FROM effect WHERE kind = 'followup'").all().map((row) => String(row.key));
  assert.deepEqual(queued, [chatter.id]);
  answers.push(JSON.stringify({ stop: [], reason: "a comment" }));
  await assessor.followup(chatter.id);
  assert.ok(liveTicket(client.store.tickets.get(ticketId)!));

  const stop = comment(3, "actually, cancel this, we will not change the label");
  client.engine.receive(stop);
  answers.push(JSON.stringify({ stop: [ticketId, "unknown"], reason: "the person cancelled it" }));
  await assessor.followup(stop.id);
  const ended = client.store.tickets.get(ticketId)!;
  assert.equal(ended.ended?.by, "human");
});

test("routes a request again when the Engine refuses to attach it to a ticket its sender may not steer", async () => {
  start({ access: {}, policy: { sources: { local: { allowed: [], roles: { alice: "maintainer", bob: "everyone" } } } } });
  const first = client.request("fix the typo in README", "alice");
  answers.push(accept());
  await judge(first.triggerId);
  const ticketId = client.store.tickets.list()[0]!.id;
  const { triggerId } = client.request("also reword the intro", "bob");
  answers.push(JSON.stringify({ kind: "attach", ticket_id: ticketId }), accept({ title: "Reword the intro", worktree_name: "reword-intro" }));
  await judge(triggerId);
  assert.match(calls[2]!.user, /may not steer this ticket/);
  const mine = client.store.tickets.list().find((ticket) => ticket.mandate.actor.id === "bob");
  assert.equal(mine?.title, "Reword the intro");
  assert.deepEqual(mine?.mandate.capability, { role: "everyone", write: "local" });
  assert.ok(liveTicket(client.store.tickets.get(ticketId)!));
});

test("answers a message that asks for no work in its own conversation, with no ticket", async () => {
  start();
  const { triggerId } = client.request("good morning!");
  answers.push(JSON.stringify({ kind: "chat", reply: "Morning! Coffee first." }));
  await judge(triggerId);
  assert.match(calls[0]!.system, /Use chat for a message that asks for no work/);
  const decision = client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!;
  assert.equal(decision.kind, "ignore");
  assert.deepEqual(decision.reason, [{ code: "chatted" }]);
  assert.equal(client.store.tickets.list().length, 0);
  const replies = client.store.db.prepare("SELECT value FROM outbox").all().map((row) => JSON.parse(String(row.value)) as { text: string; kind: string });
  assert.deepEqual(replies.map((reply) => [reply.kind, reply.text]), [["reply", "Morning! Coffee first."]]);
  // A chat answer needs its reply.
  assert.equal(routeProblem({ kind: "chat" } as never), "chat needs reply");
});

test("tells the router who it is, for its replies and acknowledgements, when the settings give a persona", async () => {
  start({ chatter: { persona: "Speaks like a pirate." } });
  const { triggerId } = client.request("hello");
  answers.push(JSON.stringify({ kind: "chat", reply: "Ahoy!" }));
  await judge(triggerId);
  assert.match(calls[0]!.system, /## Voice\n\nWho you are and how you write to people: Speaks like a pirate\.\nEvery text a person reads follows it\./);
});

test("gives a ticket's worker the persona for what it writes to people, and none without one", async () => {
  const { workStart } = await import("./work-link.js");
  const { testDeployment } = await import("./testing/fixtures.js");
  start({ chatter: { persona: "Speaks like a pirate." } });
  const { triggerId } = client.request("add a NOTICE file");
  answers.push(JSON.stringify({ kind: "accept", title: "Add a NOTICE file", worktree_name: "add-notice", acknowledgement: "Aye, adding NOTICE." }));
  await judge(triggerId);
  const ticket = client.store.tickets.list()[0]!;
  const deployment = testDeployment({ stateDir: client.stateDir });
  assert.match(workStart(client, deployment, ticket, "/tmp/work").prompt, /## Voice\n\nWho you are and how you write to people: Speaks like a pirate\.[\s\S]*stay plain and factual/);
  writeSettings({}, settingsPath(stateDir));
  assert.doesNotMatch(workStart(client, deployment, ticket, "/tmp/work").prompt, /## Voice/);
});

test("answers chit-chat on Feishu in the chat itself, quoting the message, and remembers what it said there", async () => {
  start({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: "oc_team", listen: "mentions" }] } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } } });
  const { feishuTrigger } = await import("./sources/feishu.js");
  const { KV } = await import("./kv.js");
  const trigger = feishuTrigger({ message_id: "om_1", chat_id: "oc_team", chat_type: "group", sender_id: "ou_alice", sender_type: "user",
    content: "@_user_1 morning!", create_time: String(Date.now()), mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] }, "ou_bot", "cli_app")!;
  client.engine.receive(trigger);
  answers.push(JSON.stringify({ kind: "chat", reply: "Morning, Alice!" }));
  await judge(trigger.id);
  const [reply] = client.store.db.prepare("SELECT value FROM outbox").all().map((row) => JSON.parse(String(row.value)) as { channel: { address: Record<string, string> } });
  assert.deepEqual(reply!.channel.address, { chatId: "oc_team", messageId: "om_1", mode: "chat" });
  assert.deepEqual(client.store.get(KV.chatter.chat("oc_team"))?.said.map((item) => item.text), ["Morning, Alice!"]);
});

test("puts its words on Feishu where the router chose: small talk as a plain message, quick work quoting the request, a topic's in the topic", async () => {
  start({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: "oc_team", listen: "mentions" }] } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } } });
  const { feishuTrigger } = await import("./sources/feishu.js");
  const message = (id: string, text: string, topic: { root_id?: string; thread_id?: string } = {}) => {
    const trigger = feishuTrigger({ message_id: id, chat_id: "oc_team", chat_type: "group", sender_id: "ou_alice", sender_type: "user",
      content: `@_user_1 ${text}`, create_time: String(Date.now()), mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }], ...topic }, "ou_bot", "cli_app")!;
    client.engine.receive(trigger);
    return trigger;
  };
  const sent = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { kind: string; text: string; channel: { address: Record<string, string> } });
  const greeting = message("om_1", "morning!");
  answers.push(JSON.stringify({ kind: "chat", reply: "Morning!", reply_as: "message" }));
  await judge(greeting.id);
  assert.equal(JSON.parse(calls[0]!.user).candidate.posted_in, "a group chat");
  assert.match(calls[0]!.system, /## Where to reply\n\nOn Feishu/);
  assert.deepEqual(sent().at(-1)!.channel.address, { chatId: "oc_team", mode: "chat" });
  // Quick work quotes its request with its acknowledgement and, through the ticket's channel, what comes after.
  const question = message("om_2", "what does the README say about installing?");
  answers.push(accept({ title: "Summarize the README's install steps", worktree_name: "readme-install", acknowledgement: "Reading it now.", reply_as: "message" }));
  await judge(question.id);
  assert.deepEqual(sent().at(-1)!.channel.address, { chatId: "oc_team", messageId: "om_2", mode: "chat" });
  const ticket = client.store.tickets.list().find((item) => item.title === "Summarize the README's install steps")!;
  assert.deepEqual(ticket.channels.map((channel) => channel.address), [{ chatId: "oc_team", messageId: "om_2", mode: "chat" }]);
  // A message in a topic is answered in the topic, whatever the router chose; one that replies in the chat itself, quoting it.
  const inTopic = message("om_3", "thanks!", { root_id: "om_0", thread_id: "omt_1" });
  answers.push(JSON.stringify({ kind: "chat", reply: "Anytime.", reply_as: "message" }));
  await judge(inTopic.id);
  assert.equal(JSON.parse(calls.at(-1)!.user).candidate.posted_in, "a topic");
  assert.deepEqual(sent().at(-1)!.channel.address, { chatId: "oc_team", messageId: "om_3" });
  assert.deepEqual(message("om_4", "and the tests?", { root_id: "om_2" }).channel!.address, { chatId: "oc_team", messageId: "om_4", mode: "chat" });
  assert.match(routeProblem({ kind: "chat", reply: "Hi", reply_as: "dm" }) ?? "", /reply_as/);
});

test("shows the router who is who on Feishu: the sender's and chat's names, who is mentioned and here, and the conversation around the message", async () => {
  start({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: "oc_team", listen: "mentions" }] } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } } });
  const { feishuTrigger } = await import("./sources/feishu.js");
  const { noticed, readMembers } = await import("./people.js");
  client.store.set(KV.sources.labels("feishu"), { oc_team: "Team" });
  await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" }], bots: [] }), client.store, "oc_team");
  const message = (id: string, sender: string, content: string, mentions: { id: string; key: string; name: string }[] = []) => {
    const trigger = noticed(client.store, feishuTrigger({ message_id: id, chat_id: "oc_team", chat_type: "group", sender_id: sender, sender_type: "user",
      content, create_time: String(Date.now() - (id === "om_0" ? 120_000 : 0)), mentions }, "ou_bot", "cli_app")!);
    client.engine.receive(trigger);
    return trigger;
  };
  message("om_0", "ou_bob", "the deploy is broken again");
  const asked = message("om_1", "ou_alice", "@_user_1 can you check what @_user_2 said?",
    [{ id: "ou_bot", key: "@_user_1", name: "w33d" }, { id: "ou_bob", key: "@_user_2", name: "Bob" }]);
  answers.push(JSON.stringify({ kind: "chat", reply: "Bob says the deploy is broken again." }));
  await judge(asked.id);
  const card = JSON.parse(calls[0]!.user).candidate;
  assert.equal(card.from, "ou_alice");
  assert.equal(card.from_name, "Alice");
  assert.equal(card.chat_name, "Team");
  assert.deepEqual(card.mentioned, [{ id: "ou_bot", name: "w33d" }, { id: "ou_bob", name: "Bob" }]);
  assert.deepEqual(card.conversation.map((line: { from: string; text: string }) => [line.from, line.text]), [["Bob", "the deploy is broken again"]]);
  assert.deepEqual(card.people_here, [{ id: "ou_alice", name: "Alice" }, { id: "ou_bob", name: "Bob" }]);
  assert.match(calls[0]!.system, /## People\n\nOn Feishu the card says who is who/);
});

test("messages someone for the person who asked: by name in a direct message, with a reply to them, asking again when the name fits several", async () => {
  start({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: "oc_team", listen: "mentions" }], directMessages: true } } },
    policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } } });
  const { feishuTrigger } = await import("./sources/feishu.js");
  const { readMembers } = await import("./people.js");
  client.store.set(KV.sources.labels("feishu"), { oc_team: "Team" });
  await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" },
    { member_id: "ou_lilei", name: "Li Lei" }, { member_id: "ou_lina", name: "Li Na" }], bots: [] }), client.store, "oc_team");
  const ask = (id: string, text: string) => {
    const trigger = feishuTrigger({ message_id: id, chat_id: "oc_team", chat_type: "group", sender_id: "ou_alice", sender_type: "user",
      content: `@_user_1 ${text}`, create_time: String(Date.now()), mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] }, "ou_bot", "cli_app")!;
    client.engine.receive(trigger);
    return trigger;
  };
  const sent = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { kind: string; text: string; channel: { address: Record<string, string> }; mentions?: unknown });
  const first = ask("om_1", "帮我私聊 Bob 说今晚的会改到八点");
  answers.push(JSON.stringify({ kind: "message", to: "Bob", text: "Alice 让我告诉你：今晚的会改到八点。", reply: "好，已经私聊 Bob 了。" }));
  await judge(first.id);
  assert.match(calls[0]!.system, /## Messaging people/);
  assert.deepEqual(JSON.parse(calls[0]!.user).candidate.your_chats, [{ chat_id: "oc_team", name: "Team" }]);
  assert.deepEqual(sent().map((item) => [item.kind, item.text, item.channel.address]), [
    ["notice", "Alice 让我告诉你：今晚的会改到八点。", { userId: "ou_bob", mode: "user", direct: "true" }],
    ["reply", "好，已经私聊 Bob 了。", { chatId: "oc_team", messageId: "om_1", mode: "chat" }]
  ]);
  const decision = client.store.decisions.get(client.store.triggers.disposition(first.id)!.decisionId!)!;
  assert.deepEqual([decision.kind, decision.reason], ["ignore", [{ code: "messaged", values: { to: "Bob" } }]]);
  const second = ask("om_2", "告诉 Li 一声明天放假");
  answers.push(JSON.stringify({ kind: "message", to: "Li", text: "明天放假。" }), JSON.stringify({ kind: "chat", reply: "你说的是 Li Lei 还是 Li Na？" }));
  await judge(second.id);
  assert.match(JSON.parse(calls.at(-1)!.user).problem, /Several people match Li: ou_lilei Li Lei \(Team\); ou_lina Li Na \(Team\)/);
  assert.equal(sent().at(-1)!.text, "你说的是 Li Lei 还是 Li Na？");
  // A chat answer @s someone for real; an id nobody has is asked about again.
  const third = ask("om_3", "叫一下 Bob");
  answers.push(JSON.stringify({ kind: "chat", reply: "@Bob Alice 找你", mentions: ["ou_nobody"] }), JSON.stringify({ kind: "chat", reply: "@Bob Alice 找你", mentions: ["ou_bob"] }));
  await judge(third.id);
  assert.match(JSON.parse(calls.at(-1)!.user).problem, /ou_nobody is no one the agent knows/);
  assert.deepEqual(sent().at(-1)!.mentions, [{ id: "ou_bob", name: "Bob" }]);
});

/** Feishu settings with the access model on and a GitHub App people link their accounts with. */
const ACCESS = { sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [{ chatId: "oc_team", listen: "mentions" }] } },
  github: { enabled: false, config: { repository: "owner/watched", app: { clientId: "Iv23client", slug: "swarm-oauth" } } } },
  policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }] } } }, access: {} };
/** Alice's message to the agent in the team chat, taken in. */
const fromAlice = (text: string, id: string): Promise<Trigger> => fromFeishu("ou_alice", text, id);
/** A message to the agent in the team chat from `sender`, taken in. */
async function fromFeishu(sender: string, text: string, id: string): Promise<Trigger> {
  const { feishuTrigger } = await import("./sources/feishu.js");
  const trigger = feishuTrigger({ message_id: id, chat_id: "oc_team", chat_type: "group", sender_id: sender, sender_type: "user",
    content: `@_user_1 ${text}`, create_time: String(Date.now()), mentions: [{ id: "ou_bot", key: "@_user_1", name: "w33d" }] }, "ou_bot", "cli_app")!;
  client.engine.receive(trigger);
  return trigger;
}
/** Bot commands that record what the router has them do. */
function recorded() {
  const done: unknown[][] = [];
  const commands: AgentCommands = {
    perform: (trigger, name, args) => { done.push(["perform", trigger.id, name, args]); },
    wantPullRequest: (trigger, ticketId) => { done.push(["want", trigger.id, ticketId]); }
  };
  return { done, commands };
}

test("tells the router who sent a message: their role, how far their work may write, and their GitHub account", async () => {
  start(ACCESS);
  const trigger = await fromAlice("fix the README and open a pull request", "om_1");
  answers.push(accept());
  await judge(trigger.id);
  assert.deepEqual(JSON.parse(calls[0]!.user).candidate.requester,
    { role: "maintainer", direct_message: false, may_write: "github", this_request: "local", github: "not linked" });
  assert.match(calls[0]!.system, /## Requester/);
  // Without the access model, the card has no requester.
  client.close();
  start();
  const { triggerId } = client.request("fix the typo");
  answers.push(accept());
  await judge(triggerId);
  assert.equal(JSON.parse(calls[1]!.user).candidate.requester, undefined);
});

test("runs the bot command the router chose for the person, which answers them, and leaves the message ignored", async () => {
  const { done, commands } = recorded();
  start(ACCESS, commands);
  const trigger = await fromAlice("link my GitHub please", "om_1");
  // Only the commands people may have run for them count; the router is asked again.
  answers.push(JSON.stringify({ kind: "command", command: "role", args: ["owner"] }), JSON.stringify({ kind: "command", command: "link" }));
  await judge(trigger.id);
  assert.match(JSON.parse(calls[1]!.user).problem, /command/);
  assert.deepEqual(done, [["perform", trigger.id, "link", []]]);
  const decision = client.store.decisions.get(client.store.triggers.disposition(trigger.id)!.decisionId!)!;
  assert.equal(decision.kind, "ignore");
  assert.deepEqual(decision.reason, [{ code: "commanded", values: { command: "link" } }]);
  assert.equal(routeProblem({ kind: "command" } as never), "command needs command");
});

test("has the requester of accepted work link GitHub when the router says they want a pull request", async () => {
  const { done, commands } = recorded();
  start(ACCESS, commands);
  const wanting = await fromAlice("fix the README and open a pull request", "om_1");
  answers.push(accept({ link: true, acknowledgement: "On it: a patch first, and a pull request once you link GitHub." }));
  await judge(wanting.id);
  const ticketId = client.store.decisions.get(client.store.triggers.disposition(wanting.id)!.decisionId!)!.ticketId!;
  assert.deepEqual(client.store.tickets.get(ticketId)!.mandate.capability, { role: "maintainer", write: "local" });
  assert.deepEqual(done, [["want", wanting.id, ticketId]]);
  const plain = await fromAlice("fix the CHANGELOG", "om_2");
  answers.push(accept({ title: "Fix the CHANGELOG", worktree_name: "fix-changelog" }));
  await judge(plain.id);
  assert.equal(done.length, 1);
});

test("works on the requester's repository the router chose, however they called it, and only on one of theirs", async () => {
  start(ACCESS);
  const { KV } = await import("./kv.js");
  client.store.set(KV.links.github("feishu", "ou_alice"), { login: "alice-gh", id: 7, repos: ["owner/watched", "alice-gh/2048-DQN"], reposAt: "", linkedAt: "",
    access: { iv: "", data: "", tag: "" } });
  const named = await fromAlice("你拉一下2048 DQN这个repo试试", "om_1");
  answers.push(accept({ repository: "Alice-GH/2048-dqn" }));
  await judge(named.id);
  const card = JSON.parse(calls[0]!.user).candidate.requester;
  assert.deepEqual(card.github.repositories, ["owner/watched", "alice-gh/2048-DQN"]);
  assert.equal(card.github.when_none_is_named, "owner/watched");
  assert.equal(card.this_request, "github, as @alice-gh");
  const ticketOf = (triggerId: string) => client.store.tickets.get(client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!.ticketId!)!;
  assert.equal(ticketOf(named.id).mandate.capability?.repository, "alice-gh/2048-DQN");
  // A repository that is not one of theirs does not count.
  const other = await fromAlice("fix the README in someone/else", "om_2");
  answers.push(accept({ title: "Fix the README", worktree_name: "fix-readme", repository: "someone/else" }));
  await judge(other.id);
  assert.equal(ticketOf(other.id).mandate.capability?.repository, "owner/watched");
});

/** The ticket the router's accept of `triggerId` created. */
const ticketOf = (triggerId: string) => client.store.tickets.get(client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!.ticketId!)!;
/** A bot VM with no harness signed in, paired with a Mac that has Codex and Claude Code. */
const MESH: MeshView = { here: { name: "bot-vm", abilities: ["linux"] }, peers: [{ name: "mac", abilities: ["macos", "harness:codex", "harness:claude"] }] };

test("runs a Feishu request on the harness its sender named, needing it of the machine so the paired node that has it runs the worker", async () => {
  start(ACCESS);
  view = { ...MESH, here: { name: "bot-vm", abilities: ["linux", "harness:kimi"] } };
  const trigger = await fromAlice("用 codex 做：修一下 README 的错字", "om_1");
  answers.push(accept({ harness: "Codex", acknowledgement: "好的，用 Codex 在 mac 上修 README 的错字。" }));
  await judge(trigger.id);
  assert.match(calls[0]!.system, /## Harness/);
  const { harnesses } = JSON.parse(calls[0]!.user).candidate;
  assert.equal(harnesses.default, "swarm (Swarm's own coding loop)");
  assert.equal(harnesses.choices.codex, "paired node mac");
  assert.equal(harnesses.choices.kimi, "this node (bot-vm)");
  assert.equal(harnesses.choices.opencode, "no node: none has it installed and signed in");
  const ticket = ticketOf(trigger.id);
  assert.equal(ticket.execution?.harness, "codex");
  assert.deepEqual(workNeeds(ticket, placementOf(client, ticket)), ["harness:codex"]);
});

test("answers plainly, with no ticket, when no node runs the harness a person names or it is no profile here", async () => {
  start(ACCESS);
  view = MESH;
  const missing = await fromAlice("run this on Kimi Code: fix the README", "om_1");
  answers.push(accept({ harness: "kimi" }), JSON.stringify({ kind: "chat", reply: "No node can run Kimi Code now; Codex and Claude Code run on mac." }));
  await judge(missing.id);
  assert.match(JSON.parse(calls[1]!.user).problem, /No node can run kimi now: answer with chat/);
  const unknown = await fromAlice("do it with Cursor", "om_2");
  answers.push(accept({ harness: "cursor" }), JSON.stringify({ kind: "chat", reply: "There is no Cursor harness here." }));
  await judge(unknown.id);
  assert.match(JSON.parse(calls[3]!.user).problem, /No harness profile "cursor": the choices are claude, codex, kimi, opencode/);
  assert.equal(client.store.tickets.list().length, 0);
  assert.equal(client.store.get(KV.harness.chosen(missing.id)), undefined);
  const replies = client.store.db.prepare("SELECT value FROM outbox").all().map((row) => (JSON.parse(String(row.value)) as { text: string }).text);
  assert.equal(replies.length, 2);
});

test("lets only maintainers and owners choose a harness, and runs work that acts as its requester on GitHub only on a harness here", async () => {
  start({ ...ACCESS, policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }], roles: { ou_bob: "everyone" } } } } });
  view = { ...MESH, here: { name: "bot-vm", abilities: ["linux", "harness:claude"] } };
  const bob = await fromFeishu("ou_bob", "use codex to fix the README", "om_1");
  answers.push(accept({ harness: "codex" }), accept({ acknowledgement: "On it on the default harness: only maintainers choose one." }));
  await judge(bob.id);
  assert.match(JSON.parse(calls[0]!.user).candidate.harnesses.choices, /only maintainers and owners choose a harness/);
  assert.match(JSON.parse(calls[1]!.user).problem, /Only maintainers and owners choose a harness/);
  assert.equal(ticketOf(bob.id).execution?.harness, undefined);

  client.store.set(KV.links.github("feishu", "ou_alice"), { login: "alice-gh", id: 7, repos: ["owner/watched"], reposAt: "", linkedAt: "",
    access: { iv: "", data: "", tag: "" } });
  const alice = await fromAlice("用 codex 修 README 然后开个 PR", "om_2");
  answers.push(accept({ harness: "codex", title: "Fix the README", worktree_name: "fix-readme" }),
    accept({ harness: "claude", title: "Fix the README", worktree_name: "fix-readme" }));
  await judge(alice.id);
  const { choices } = JSON.parse(calls[2]!.user).candidate.harnesses;
  assert.match(choices.codex, /^no node for this request: only paired node mac has it, and work that acts as @alice-gh on GitHub runs only on this node$/);
  assert.equal(choices.claude, "this node (bot-vm)");
  assert.match(JSON.parse(calls[3]!.user).problem, /Only mac can run codex, and work that acts as @alice-gh on GitHub runs only on this node/);
  const ticket = ticketOf(alice.id);
  assert.equal(ticket.mandate.capability?.credential?.login, "alice-gh");
  assert.equal(ticket.execution?.harness, "claude");
});

test("keeps the harness a request was filed with, and counts every profile as this node's on a host that is no mesh node", async () => {
  start();
  const filed = client.request("fix the typo in README", undefined, { harness: "codex" });
  answers.push(accept({ harness: "claude" }));
  await judge(filed.triggerId);
  assert.deepEqual(JSON.parse(calls[0]!.user).candidate.harnesses, { default: "swarm (Swarm's own coding loop)", filed_with: "codex" });
  assert.equal(ticketOf(filed.triggerId).execution?.harness, "codex");

  const named = client.request("run this on opencode: fix the CHANGELOG");
  answers.push(accept({ harness: "opencode", title: "Fix the CHANGELOG", worktree_name: "fix-changelog" }));
  await judge(named.triggerId);
  assert.equal(JSON.parse(calls[1]!.user).candidate.harnesses.choices.opencode, "this node");
  assert.equal(ticketOf(named.triggerId).execution?.harness, "opencode");
});

test("tells the router what it runs work on, naming the nodes to maintainers and owners and giving everyone else counts", async () => {
  start({ ...ACCESS, policy: { sources: { feishu: { allowed: [{ id: "ou_alice" }], roles: { ou_bob: "everyone" } } } } });
  view = { ...MESH, offline: ["pc"] };
  const chat = (reply: string) => JSON.stringify({ kind: "chat", reply });
  const alice = await fromAlice("你现在能调用哪些设备？", "om_1");
  answers.push(chat("我在 bot-vm 上跑，mac 在线、有 codex 和 claude，pc 离线。"));
  await judge(alice.id);
  assert.match(calls[0]!.system, /## Devices\n\nThe card's devices says what you run work on now/);
  assert.deepEqual(JSON.parse(calls[0]!.user).candidate.devices, {
    this_node: { name: "bot-vm", machine: ["linux"], harnesses: [] },
    paired_nodes: [{ name: "mac", online: true, machine: ["macos"], harnesses: ["codex", "claude"] }, { name: "pc", online: false }],
    ticket_workers: { runs_as: "processes on this node", total: 3, busy: 1, free: 2 }
  });
  assert.equal(client.store.tickets.list().length, 0);

  const bob = await fromFeishu("ou_bob", "你现在能调用哪些设备？", "om_2");
  answers.push(chat("现在配了 2 个节点，1 个在线，还有 2 个空闲的 worker。"));
  await judge(bob.id);
  const counts = JSON.parse(calls[1]!.user).candidate.devices;
  assert.deepEqual(counts.paired_nodes, { total: 2, online: 1 });
  assert.match(counts.node_names, /only maintainers and owners see which nodes these are/);
  // The devices the card shows name no node; what the agent said in this chat before, which Bob read there, may.
  assert.doesNotMatch(JSON.stringify(counts), /bot-vm|"mac"|"pc"/);

  // Routing goes on when the host cannot tell, and the card says so.
  devicesFail = "the mesh state could not be read";
  const again = await fromAlice("还有哪些机器在线？", "om_3");
  answers.push(chat("现在查不到设备情况。"));
  await judge(again.id);
  assert.equal(JSON.parse(calls[2]!.user).candidate.devices, "unknown now: the mesh state could not be read");
});
