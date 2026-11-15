import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { key, type Decision } from "./core/index.js";
import { runSuperagentCommand } from "./cli.js";
import { SuperagentClient, unroutedRequest } from "./client.js";
import { unroutedNotice } from "./notices.js";
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
  assert.equal(outbox().length, 2);
  for (const silent of [restarted, verdict]) assert.equal(client.outbox.status(key("unavailable", silent.id)), undefined);
  assert.deepEqual(hostStatus(client).unrouted.map((item) => item.triggerId), [english.triggerId, triggerId], "and the status lists neither");
});

test("picks the last message of the request that a person wrote in a conversation, and only for an explicit request that timed out", () => {
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
  assert.equal(unroutedRequest(client.store, { ...decision, strength: "inferred" }), undefined);
  assert.equal(unroutedRequest(client.store, { ...decision, reason: [{ code: "policyChanged" }] }), undefined);
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
