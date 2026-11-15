import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { key, type Decision, type Trigger } from "./core/index.js";
import { runSuperagentCommand } from "./cli.js";
import { SuperagentClient, unroutedRequest } from "./client.js";
import { unroutedNotice } from "./notices.js";
import { settingsPath, writeSettings } from "./settings.js";
import { commentTrigger } from "./sources/github-trigger.js";
import { localTrigger } from "./sources/local.js";
import { wordCount } from "./text.js";
import { dismissUnrouted, findTrigger, hostStatus, routeAgain } from "./views.js";

const home = process.env.SWARM_SUPERAGENT_HOME;
let stateDir: string;
let client: SuperagentClient;
/** The Engine's clock, which a test moves past an Eval's time limit. */
let now: number;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-superagent-unrouted-"));
  // The commands open the state directory the environment names.
  process.env.SWARM_SUPERAGENT_HOME = stateDir;
  now = Date.now();
  client = new SuperagentClient({ stateDir, now: () => new Date(now).toISOString() });
});
afterEach(() => {
  client.close();
  if (home === undefined) delete process.env.SWARM_SUPERAGENT_HOME;
  else process.env.SWARM_SUPERAGENT_HOME = home;
  rmSync(stateDir, { recursive: true, force: true });
});

/** The Eval's time limit in the default settings, and a second more. */
const PAST_LIMIT_MS = 121_000;
/** Lets the router never answer a request: each Eval of it reaches the router and expires, until one ends unavailable. */
function timeOut(triggerId: string): Decision {
  for (let expiry = 0; expiry < 4; expiry++) {
    client.engine.evaluateDue();
    const candidate = client.engine.candidate(triggerId);
    if (!candidate) break;
    client.engine.candidateDelivered(candidate.evalId);
    now += PAST_LIMIT_MS;
  }
  return client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!;
}
const outbox = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
  .map((row) => JSON.parse(String(row.value)) as { id: string; kind: string; text: string; channel: { source: string; thread: string }; ticketId?: string });
/** Runs a `swarm superagent` command on the test's state directory and returns what it printed. */
async function run(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...items: unknown[]) => { lines.push(items.join(" ")); };
  try { await runSuperagentCommand(args); } finally { console.log = log; }
  return lines.join("\n");
}

test("tells the person once, where they wrote, that a request the router never answered was not taken in, and nobody when an Eval only starts again", () => {
  const { triggerId, thread } = client.request("修一下 README 的错别字");
  client.engine.evaluateDue();
  client.engine.candidateDelivered(client.engine.candidate(triggerId)!.evalId);
  now += PAST_LIMIT_MS;
  client.engine.evaluateDue();
  assert.deepEqual([client.store.decisions.byThread(thread), outbox()], [[], []], "an Eval that expired is tried again first, and says nothing");

  const decision = timeOut(triggerId);
  assert.deepEqual([decision.kind, decision.reason, decision.strength], ["unavailable", [{ code: "timeout" }], "explicit"]);
  const [notice, ...others] = outbox();
  assert.deepEqual(others, []);
  assert.deepEqual(notice, { id: key("unavailable", decision.id), channel: client.store.triggers.get(triggerId)!.channel, kind: "reply", status: "pending",
    text: "这条请求没能受理：模型没有及时回答。请过几分钟再发一次。" });
  assert.equal(notice!.channel.source, "local");
  assert.equal(notice!.channel.thread, thread);

  // In the language of the request, and short.
  const english = client.request("fix the typo in README");
  const second = timeOut(english.triggerId);
  assert.equal(outbox().find((message) => message.id === key("unavailable", second.id))?.text,
    "I couldn't take this request in: the model didn't answer in time. Please send it again in a few minutes.");
  for (const request of ["fix it", "修一下"]) assert.ok(wordCount(unroutedNotice(request)) < 40);
  assert.equal(outbox().length, 2);

  // An Eval that ends unavailable because the Policy changed starts again by itself: nobody is told.
  const changed = client.request("rename the build script");
  client.engine.evaluateDue();
  client.engine.policyChanged("before", "after");
  const restarted = client.store.decisions.get(client.store.triggers.disposition(changed.triggerId)!.decisionId!)!;
  assert.deepEqual([restarted.kind, restarted.reason], ["unavailable", [{ code: "policyChanged" }]]);
  assert.deepEqual(client.store.threads.get(changed.thread)?.pending, [changed.triggerId]);
  // Nor for an unavailable that is the assessor's own verdict.
  const judged = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  const verdict = client.engine.decide(judged.triggerId, { kind: "unavailable", reason: "the thread could not be read", evalId: client.engine.candidate(judged.triggerId)!.evalId });
  assert.equal(verdict.kind, "unavailable");
  // Nor when one message of an Eval was routed to a ticket by hand, and the rest starts again without it.
  const ticket = client.request("update the changelog");
  client.engine.evaluateDue();
  const { ticketId } = client.engine.decide(ticket.triggerId, { kind: "accept", title: "Update the changelog", scope: "x", reason: "asked", name: "update-changelog",
    evalId: client.engine.candidate(ticket.triggerId)!.evalId });
  const pointed = localTrigger({ id: "pointed", text: "this one belongs to the changelog ticket", threadId: "routed" });
  const other = localTrigger({ id: "other", text: "and bump the version", threadId: "routed" });
  client.engine.receive(pointed);
  client.engine.receive(other);
  client.engine.evaluateDue();
  client.engine.attach(ticketId!, pointed.id);
  const routed = client.store.decisions.byThread("local:routed").at(-1)!;
  assert.deepEqual([routed.kind, routed.reason[0]?.code, client.store.threads.get("local:routed")?.pending], ["unavailable", "routed", [other.id]]);
  assert.equal(outbox().length, 2);
  for (const silent of [restarted, verdict, routed]) assert.equal(client.outbox.status(key("unavailable", silent.id)), undefined);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.triggerId), [english.triggerId, triggerId], "and the status lists neither");
});

test("picks the last message in which a person addressed the agent in a conversation, else the last a person wrote in one, and only for an explicit request that timed out", () => {
  const { triggerId } = client.request("fix the typo in README");
  const decision = timeOut(triggerId);
  const person = client.store.triggers.get(triggerId)!;
  const { channel: _channel, ...unanswerable } = person;
  client.store.triggers.save({ ...unanswerable, id: "no-channel" });
  client.store.triggers.save({ ...person, id: "bot", human: false });
  client.store.triggers.save({ ...person, id: "later" });
  assert.equal(unroutedRequest(client.store, { ...decision, triggerIds: [triggerId, "no-channel", "bot", "gone"] })?.id, triggerId);
  assert.equal(unroutedRequest(client.store, { ...decision, triggerIds: [triggerId, "later", "bot"] })?.id, "later");
  assert.equal(unroutedRequest(client.store, { ...decision, triggerIds: ["no-channel", "bot"] }), undefined);
  // What a person wrote there without addressing the agent is the request only when nobody addressed it.
  const { addressed: _addressed, ...aside } = person;
  client.store.triggers.save({ ...aside, id: "aside" });
  assert.equal(unroutedRequest(client.store, { ...decision, triggerIds: [triggerId, "later", "aside", "bot"] })?.id, "later");
  assert.equal(unroutedRequest(client.store, { ...decision, triggerIds: ["bot", "aside", "no-channel"] })?.id, "aside");
  assert.equal(unroutedRequest(client.store, { ...decision, strength: "inferred" }), undefined);
  assert.equal(unroutedRequest(client.store, { ...decision, reason: [{ code: "policyChanged" }] }), undefined);
  assert.equal(unroutedRequest(client.store, { ...decision, reason: [{ code: "routed" }, { code: "timeout" }] }), undefined, "its first reason says why the Eval ended");
  assert.equal(unroutedRequest(client.store, { ...decision, kind: "ignore" }), undefined);
});

test("status lists a request that could not be routed, and sending it again queues it for the router and takes it off the list", async () => {
  const text = `fix the typo in README,\n  the one in the second paragraph ${"and the others like it ".repeat(6)}`;
  const { triggerId, thread } = client.request(text);
  assert.deepEqual(hostStatus(client).unrouted, []);
  const decision = timeOut(triggerId);
  const shown = "fix the typo in README, the one in the second paragraph and the others like it a";
  assert.equal(shown.length, 80);
  assert.deepEqual(hostStatus(client).unrouted, [{ triggerId, decisionId: decision.id, at: decision.at, text: shown }]);
  const short = triggerId.slice(0, 8);
  const listed = await run("status");
  assert.match(listed, /^1 request could not be routed:$/m);
  assert.ok(listed.includes(`  ${short}  ${new Date(decision.at).toLocaleString()}  ${shown}\n`), listed);
  assert.match(listed, /swarm superagent again <id>.*swarm superagent dismiss <id>/);
  assert.deepEqual(JSON.parse(await run("status", "--json")).unrouted, hostStatus(client).unrouted);

  const sent = await run("again", short);
  assert.match(sent, new RegExp(`^Sent request ${short} to the router again, and took it off the list in status\\.`));
  assert.match(sent, /No host runs yet: start one with `swarm superagent run`\.$/);
  assert.deepEqual(client.store.threads.get(thread)?.pending, [triggerId]);
  assert.equal(client.store.decisions.get(decision.id)?.dismissed, true);
  assert.deepEqual(hostStatus(client).unrouted, []);
  assert.doesNotMatch(await run("status"), /could not be routed/);

  // An Eval holds it now: asked again, nothing changes, and the command says so.
  client.engine.evaluateDue();
  const held = client.engine.candidate(triggerId)!.evalId;
  assert.match(await run("again", short), new RegExp(`^Request ${short} is with the router already: an Eval holds it`));
  assert.deepEqual(routeAgain(client, triggerId), { trigger: client.store.triggers.get(triggerId), queued: false });
  assert.equal(client.engine.candidate(triggerId)?.evalId, held);

  // When that Eval runs out too, it is a new Decision: listed again, and the person hears of it again.
  const second = timeOut(triggerId);
  assert.notEqual(second.id, decision.id);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.decisionId), [second.id]);
  assert.deepEqual(outbox().map((message) => message.id), [key("unavailable", decision.id), key("unavailable", second.id)]);
});

test("sends the messages that waited in one request again together, in their order", () => {
  const first = localTrigger({ id: "first", text: "fix the login bug", threadId: "batch" });
  const second = localTrigger({ id: "second", text: "and add a test for it", threadId: "batch" });
  client.engine.receive(first);
  client.engine.receive(second);
  const decision = timeOut(second.id);
  assert.deepEqual(decision.triggerIds, [first.id, second.id]);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => [item.triggerId, item.text]), [[second.id, "and add a test for it"]]);
  // A character outside the basic plane is kept whole where the text is cut.
  client.store.triggers.save({ ...second, text: `${"x".repeat(79)}😀 and more` });
  assert.equal(hostStatus(client).unrouted[0]?.text, `${"x".repeat(79)}😀`);
  client.store.triggers.save(second);
  assert.deepEqual(outbox().map((message) => [message.id, message.channel]), [[key("unavailable", decision.id), second.channel]]);

  const again = routeAgain(client, second.id);
  assert.deepEqual([again.queued, again.dismissed?.id], [true, decision.id]);
  assert.deepEqual(client.store.threads.get("local:batch")?.pending, [first.id, second.id]);
  assert.deepEqual(hostStatus(client).unrouted, []);
  client.engine.evaluateDue();
  assert.deepEqual(client.engine.candidate(first.id)?.triggers.map((trigger) => trigger.id), [first.id, second.id]);
});

test("dismissing a request that could not be routed takes it off the list without sending it again, by its message's id or its Decision's", async () => {
  const one = client.request("fix the typo in README");
  const two = client.request("rename the build script");
  const first = timeOut(one.triggerId);
  const second = timeOut(two.triggerId);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.triggerId), [two.triggerId, one.triggerId], "newest first");
  assert.match(await run("status"), /^2 requests could not be routed:$/m);

  assert.match(await run("dismiss", one.triggerId.slice(0, 8)), new RegExp(`^Dismissed ${one.triggerId.slice(0, 8)}: the request leaves the status`));
  assert.equal(client.store.decisions.get(first.id)?.dismissed, true);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.triggerId), [two.triggerId]);
  assert.equal(dismissUnrouted(client, second.id.slice(0, 10)).id, second.id);
  assert.deepEqual(hostStatus(client).unrouted, []);
  assert.equal(dismissUnrouted(client, second.id.slice(0, 10)).dismissed, true, "dismissed again, it stays dismissed");
  for (const { triggerId, thread } of [one, two]) {
    assert.deepEqual(client.store.threads.get(thread)?.pending, []);
    assert.equal(client.engine.candidate(triggerId), undefined);
  }
  client.engine.evaluateDue();
  assert.equal(client.engine.candidate(one.triggerId), undefined, "nothing went back to the router");
  assert.equal(outbox().length, 2, "and nobody is told anything more");

  // Dismissed already, a message has nothing left to dismiss; a Decision of another kind is none of these.
  assert.throws(() => dismissUnrouted(client, one.triggerId), /has no request that could not be routed/);
  const accepted = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  const ticket = client.engine.decide(accepted.triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked", name: "add-notice",
    evalId: client.engine.candidate(accepted.triggerId)!.evalId });
  assert.throws(() => dismissUnrouted(client, ticket.id), new RegExp(`No message ${ticket.id}`));
  assert.throws(() => dismissUnrouted(client, accepted.triggerId), /has no request that could not be routed/);
  assert.equal(client.store.decisions.get(ticket.id)?.dismissed, undefined);

  // The start of an id that two unavailable Decisions share names neither.
  const third = timeOut(client.request("update the changelog").triggerId);
  client.store.decisions.save({ ...third, id: `${third.id.slice(0, 12)}-twin` });
  assert.throws(() => dismissUnrouted(client, third.id.slice(0, 12)), /names several Decisions; give more of the id/);
  assert.equal(client.store.decisions.get(third.id)?.dismissed, undefined);
  assert.equal(dismissUnrouted(client, third.id).dismissed, true);
});

test("refuses a message id that names several messages or none", async () => {
  const { triggerId } = client.request("fix the typo in README");
  const decision = timeOut(triggerId);
  const trigger = client.store.triggers.get(triggerId)!;
  client.store.triggers.save({ ...trigger, id: "twin-1" });
  client.store.triggers.save({ ...trigger, id: "twin-2" });
  assert.throws(() => findTrigger(client, "twin"), /twin names several messages; give more of the id/);
  assert.throws(() => routeAgain(client, "twin"), /names several messages/);
  assert.throws(() => dismissUnrouted(client, "twin"), /names several messages/);
  await assert.rejects(run("again", "twin"), /names several messages/);
  await assert.rejects(run("dismiss", "twin"), /names several messages/);
  assert.equal(findTrigger(client, "twin-2").id, "twin-2");
  assert.equal(findTrigger(client, triggerId.slice(0, 8)).id, triggerId);
  assert.throws(() => routeAgain(client, "no-such-message"), /No message no-such-message/);
  await assert.rejects(run("again"), /Usage: swarm superagent again <message id>/);
  await assert.rejects(run("dismiss"), /Usage: swarm superagent dismiss <message id>/);
  // Nothing was sent again or dismissed by a refused command.
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.decisionId), [decision.id]);
  assert.equal(client.engine.candidate(triggerId), undefined);
});

const githubSettings = { sources: { github: { enabled: true, config: { repository: "acme/widgets", cli: "gh", observeComments: true } } },
  policy: { sources: { github: { allowed: [{ id: "alice" }] } } } };
const comment = (id: number, body: string, login: string): Trigger => commentTrigger(
  { id, body, user: { login, type: "User" }, html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`, created_at: `2026-11-01T00:00:0${id}Z` },
  { number: 7, isPr: false, url: "https://github.com/acme/widgets/issues/7" }, "conversation", "agent-bot");

test("tells the person who asked, where they asked, when someone else wrote on the Thread before the router gave up", () => {
  writeSettings(githubSettings, settingsPath(stateDir));
  const ask = comment(1, "@agent-bot please fix the label typo", "alice");
  const aside = comment(2, "+1 我也遇到了", "bob");
  client.engine.receive(ask);
  client.engine.receive(aside);
  const decision = timeOut(ask.id);
  assert.deepEqual([decision.triggerIds, decision.strength, decision.reason], [[ask.id, aside.id], "explicit", [{ code: "timeout" }]]);
  // One comment, on the request and in its language, not under the comment of someone who asked for nothing.
  assert.deepEqual(outbox(), [{ id: key("unavailable", decision.id), kind: "reply", status: "pending",
    channel: { source: "github", thread: "github:7", address: { number: "7", url: "https://github.com/acme/widgets/issues/7#issuecomment-1" } },
    text: "I couldn't take this request in: the model didn't answer in time. Please send it again in a few minutes." }]);
  assert.deepEqual(hostStatus(client).unrouted, [{ triggerId: ask.id, decisionId: decision.id, at: decision.at, text: "@agent-bot please fix the label typo" }]);
  // Sent again, the Eval gets the Thread's messages as it had them.
  assert.equal(routeAgain(client, ask.id).dismissed?.id, decision.id);
  assert.deepEqual(client.store.threads.get("github:7")?.pending, [ask.id, aside.id]);
});

test("status lists the newest fifty requests that could not be routed, whatever else was decided since, and the rest once those are seen to", () => {
  const requests = Array.from({ length: 60 }, (_, index) => client.request(`request ${index}`).triggerId);
  const decisions = requests.map((triggerId) => timeOut(triggerId));
  // Evals that only started again leave unavailable Decisions too, and so do candidates nobody asked for: far more of both.
  for (let index = 0; index < 60; index++) {
    client.store.decisions.save({ ...decisions[0]!, id: `restarted-${index}`, reason: [{ code: "policyChanged" }] });
    client.store.decisions.save({ ...decisions[0]!, id: `candidate-${index}`, strength: "inferred" });
    client.store.decisions.save({ ...decisions[0]!, id: `ignored-${index}`, kind: "ignore" });
  }
  const newest = requests.slice(10).reverse();
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.triggerId), newest);
  // Seen to, they make room for the older ones: a dismissed Decision stays stored, but takes no place in the list.
  for (const triggerId of newest.slice(0, 25)) dismissUnrouted(client, triggerId);
  for (const triggerId of newest.slice(25)) routeAgain(client, triggerId);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.triggerId), requests.slice(0, 10).reverse());
  for (const triggerId of requests.slice(0, 10)) dismissUnrouted(client, triggerId);
  assert.deepEqual(hostStatus(client).unrouted, []);
  assert.equal(decisions.filter((decision) => client.store.decisions.get(decision.id)?.dismissed).length, 60);
});

test("dismisses only a request the status lists, and takes a short id as the message's that status printed", async () => {
  // An Eval that started again under a new Policy ended unavailable too, but its request is with the router.
  const changed = client.request("rename the build script");
  client.engine.evaluateDue();
  client.engine.policyChanged("before", "after");
  const restarted = client.store.decisions.get(client.store.triggers.disposition(changed.triggerId)!.decisionId!)!;
  assert.deepEqual([restarted.kind, restarted.reason], ["unavailable", [{ code: "policyChanged" }]]);
  assert.throws(() => dismissUnrouted(client, changed.triggerId), /has no request that could not be routed/);
  await assert.rejects(run("dismiss", changed.triggerId.slice(0, 8)), /has no request that could not be routed/);
  assert.throws(() => dismissUnrouted(client, restarted.id.slice(0, 10)), /No message/, "nor does its own id name one");
  // Sent again, it is queued as any message is, and that Decision is left alone.
  assert.deepEqual(routeAgain(client, changed.triggerId), { trigger: client.store.triggers.get(changed.triggerId), queued: true });
  assert.equal(client.store.decisions.get(restarted.id)?.dismissed, undefined);
  assert.deepEqual(client.store.threads.get(changed.thread)?.pending, [changed.triggerId], "it still waits for the router");

  // A Decision whose id starts as a listed message's does: the short id status printed names the message.
  const one = client.request("fix the typo in README");
  const two = client.request("update the changelog");
  const first = timeOut(one.triggerId);
  const second = timeOut(two.triggerId);
  const short = one.triggerId.slice(0, 8);
  client.store.decisions.save({ ...second, id: `${short}-of-another-request` });
  assert.equal(dismissUnrouted(client, short).id, first.id);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.decisionId), [`${short}-of-another-request`, second.id]);
  // More of a Decision's id than any message has names the Decision.
  assert.equal(dismissUnrouted(client, `${short}-of`).id, `${short}-of-another-request`);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.decisionId), [second.id]);
});

test("sending a request again leaves alone what was decided since, and changes nothing while an Eval holds the message", async () => {
  const batch = (thread: string) => {
    const first = localTrigger({ id: `${thread}-first`, text: "fix the login bug", threadId: thread });
    const second = localTrigger({ id: `${thread}-second`, text: "and add a test for it", threadId: thread });
    client.engine.receive(first);
    client.engine.receive(second);
    return { first, second, decision: timeOut(second.id) };
  };
  // The first message of the request was decided by itself since: only the other goes again.
  const decided = batch("decided");
  const ignored = client.engine.decide(decided.first.id, { kind: "ignore", reason: "a greeting" });
  const again = routeAgain(client, decided.second.id);
  assert.deepEqual([again.queued, again.dismissed?.id], [true, decided.decision.id]);
  assert.deepEqual(client.store.threads.get("local:decided")?.pending, [decided.second.id]);
  assert.equal(client.store.triggers.disposition(decided.first.id)?.decisionId, ignored.id);

  // A replay put the request's last message with the router, and an Eval holds it: asked again, nothing moves, as the command says.
  const held = batch("held");
  client.engine.reevaluate(held.second.id);
  client.engine.evaluateDue();
  assert.deepEqual(client.engine.candidate(held.second.id)?.triggers.map((trigger) => trigger.id), [held.second.id]);
  assert.match(await run("again", held.second.id), /is with the router already: an Eval holds it, so nothing changed\./);
  assert.deepEqual(routeAgain(client, held.second.id), { trigger: client.store.triggers.get(held.second.id), queued: false });
  assert.deepEqual(client.store.threads.get("local:held")?.pending, [], "the message that waited with it was not queued either");
  assert.equal(client.engine.candidate(held.first.id), undefined);
  assert.equal(client.store.decisions.get(held.decision.id)?.dismissed, undefined);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.decisionId), [held.decision.id]);
});

test("says so when a message sent again was not on the list, and names both commands in the help", async () => {
  const help = await run("help");
  assert.match(help, /^  again <message id> +Send a request that could not be routed to the router again/m);
  assert.match(help, /^  dismiss <message id> +Drop one from status without sending it again/m);

  // A request that became a ticket is no request that could not be routed: its fresh Eval ignores it, and no second ticket starts.
  const { triggerId, thread } = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  const accepted = client.engine.decide(triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked", name: "add-notice",
    evalId: client.engine.candidate(triggerId)!.evalId });
  const short = triggerId.slice(0, 8);
  assert.equal(await run("again", short),
    `Queued message ${short} for the router again; it was not on the list in status. No host runs yet: start one with \`swarm superagent run\`.`);
  assert.deepEqual(client.store.threads.get(thread)?.pending, [triggerId]);
  client.engine.evaluateDue();
  assert.deepEqual(client.store.decisions.byThread(thread).map((decision) => [decision.kind, decision.reason[0]?.code]), [["accept", "said"], ["ignore", "startedTicket"]]);
  assert.deepEqual(client.store.tickets.list().map((ticket) => ticket.id), [accepted.ticketId]);

  // With a host running, the hint to start one is left out.
  writeFileSync(join(stateDir, "host.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const timedOut = client.request("fix the typo in README").triggerId;
  timeOut(timedOut);
  assert.equal(await run("again", timedOut), `Sent request ${timedOut.slice(0, 8)} to the router again, and took it off the list in status.`);
});
