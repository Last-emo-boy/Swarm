/**
 * Ticket check-backs (host.ts `dueCheckBacks`, core/tickets.ts `checkBack`/`fireCheckBack`): a ticket waking itself at the
 * time its worker asked for, with the note it left, and the ticket's end dropping it. Each test drives the real store and
 * effect queue with no deployment, so nothing leaves this process.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { inputMessage } from "./messages.js";
import { dueCheckBacks } from "./host.js";
import { CLOSE_MS, EXPIRED_REASON, REMIND_MS, sweepStale } from "./notices.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator } from "./sources/local.js";

let stateDir: string, client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-checkback-"));
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } } }, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** The current time of a client whose clock the test moves. */
const moved = (start: number) => {
  let now = start;
  return { clock: () => new Date(now).toISOString(), tick: (ms: number) => { now += ms } };
};

/** A ticket accepted from a local request, as the router accepts one. */
function started(open: SuperagentClient): string {
  const { triggerId } = open.request("add a NOTICE file");
  open.engine.evaluateDue();
  return open.engine.decide(triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked", name: "add-notice",
    evalId: open.engine.candidate(triggerId)!.evalId }).ticketId!;
}

/** The host's check-back handler, as host.ts registers it. */
function handler(open: SuperagentClient) {
  open.effects.handle("checkback", async ({ ticketId }) => { open.engine.fireCheckBack(ticketId); }, { limit: () => 4 });
}

test("a check-back due by the pass's clock enqueues once, wakes with its note, and never fires twice", async () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  client.engine.checkBack(ticketId, 30, "waiting for CI on the branch to finish");
  handler(client);
  client.effects.start();
  // Not due yet: the pass queues nothing.
  time.tick(29 * 60_000);
  assert.equal(dueCheckBacks(client, time.clock()), 0);
  time.tick(60_000);
  assert.equal(dueCheckBacks(client, time.clock()), 1);
  // The row waits until the host's queue runs it; the pass does not queue it again meanwhile.
  assert.equal(dueCheckBacks(client, time.clock()), 0);
  await client.effects.idle("checkback");
  const ticket = client.store.tickets.get(ticketId)!;
  assert.equal(ticket.checkBack, undefined);
  const checkBacks = ticket.inputs.filter((input) => input.kind === "check-back");
  assert.equal(checkBacks.length, 1);
  assert.equal(inputMessage(checkBacks[0]!), "Check-back you asked for: waiting for CI on the branch to finish");
  assert.equal(dueCheckBacks(client, time.clock()), 0, "a fired check-back is not queued again");
});

test("a check-back that fell due while the host was down fires on the first pass after a restart", async () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  client.engine.checkBack(ticketId, 10, "checking the deploy");
  client.close();
  // The ticket row kept what is due; the fresh process finds it and queues it, and its own queue runs it.
  client = new SuperagentClient({ stateDir, now: time.clock });
  handler(client);
  client.effects.start();
  time.tick(11 * 60_000);
  assert.equal(dueCheckBacks(client, time.clock()), 1);
  await client.effects.idle("checkback");
  const ticket = client.store.tickets.get(ticketId)!;
  assert.equal(ticket.checkBack, undefined, "the fresh process fired the wake the ticket kept");
  const checkBacks = ticket.inputs.filter((input) => input.kind === "check-back");
  assert.deepEqual(checkBacks.map((input) => input.kind === "check-back" && input.text), ["checking the deploy"]);
  assert.equal(dueCheckBacks(client, time.clock()), 0);
});

test("a ticket that ended drops its check-back, and the pass never queues one for it", () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  client.engine.checkBack(ticketId, 5, "waiting for CI");
  client.engine.stopTicket(ticketId);
  time.tick(6 * 60_000);
  assert.equal(dueCheckBacks(client, time.clock()), 0);
  assert.equal(client.engine.fireCheckBack(ticketId), false);
  assert.deepEqual(client.store.tickets.get(ticketId)!.inputs.filter((input) => input.kind === "check-back"), []);
});

test("a ticket that waits for a person keeps its check-back until they answer, and the stale clock still closes it", async () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  client.engine.report(ticketId, { state: "blocked", summary: "need a decision", question: "Which branch?" });
  client.engine.checkBack(ticketId, 5, "waiting for CI");
  time.tick(6 * 60_000);
  assert.equal(dueCheckBacks(client, time.clock()), 0, "a ticket waiting on a person takes no automatic Input");
  assert.equal(client.store.tickets.get(ticketId)!.checkBack?.note, "waiting for CI");
  // The effect runs anyway, as one queued before the report landed does: the check-back stays, so a later pass can fire it.
  assert.equal(client.engine.fireCheckBack(ticketId), false);
  assert.equal(client.store.tickets.get(ticketId)!.checkBack?.note, "waiting for CI");
  // The person answers: the reply lifts the wait, the next pass queues the request the ticket kept, and it wakes the worker.
  handler(client);
  client.effects.start();
  client.message(ticketId, "main branch");
  time.tick(1);
  assert.equal(dueCheckBacks(client, time.clock()), 1);
  await client.effects.idle("checkback");
  const ticket = client.store.tickets.get(ticketId)!;
  assert.equal(ticket.checkBack, undefined);
  assert.deepEqual(ticket.inputs.filter((input) => input.kind === "check-back").map((input) => input.kind === "check-back" && input.text),
    ["waiting for CI"]);
});

test("the stale clock reaps a ticket past its deadline however many check-backs it holds", () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  client.engine.report(ticketId, { state: "blocked", summary: "need a decision", question: "Which branch?" });
  client.engine.checkBack(ticketId, 5, "waiting for CI");
  time.tick(6 * 60_000);
  client.engine.fireCheckBack(ticketId);
  // A second wait, renewable forever by the worker: the clock does not count it.
  client.engine.checkBack(ticketId, 60, "still waiting");
  // A person hears one reminder, and the close follows it; a ticket with nowhere to say so closes in one sweep.
  const reminded = Date.parse(time.clock()) + REMIND_MS;
  sweepStale(client, reminded);
  sweepStale(client, reminded + CLOSE_MS);
  const ticket = client.store.tickets.get(ticketId)!;
  assert.deepEqual(ticket.ended && { by: ticket.ended.by, outcome: ticket.ended.outcome, reason: ticket.ended.reason },
    { by: "executor", outcome: "dropped", reason: EXPIRED_REASON });
  assert.equal(ticket.checkBack, undefined, "the end dropped the pending check-back");
  time.tick(24 * 3_600_000);
  assert.equal(client.engine.fireCheckBack(ticketId), false);
  assert.equal(dueCheckBacks(client, time.clock()), 0);
});

test("a ready worker that keeps working only for a thread it follows drops its check-back with the report", () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  const assignment = client.store.tickets.get(ticketId)!.assignments[0]!;
  client.engine.assignmentStarted(ticketId, assignment.id);
  client.engine.bindThread(ticketId, { source: "github", id: "pr-12" }, true);
  client.engine.checkBack(ticketId, 10, "waiting for CI on the PR");
  client.engine.report(ticketId, { state: "ready", summary: "PR #12 is up" });
  // The ticket stays open, following its PR: with no running Assignment a wake would reach nobody, so the request goes.
  const ticket = client.store.tickets.get(ticketId)!;
  assert.equal(ticket.ended, undefined);
  assert.equal(ticket.checkBack, undefined);
  time.tick(11 * 60_000);
  assert.equal(dueCheckBacks(client, time.clock()), 0);
  assert.deepEqual(ticket.inputs.filter((input) => input.kind === "check-back"), []);
});

test("a ticket that keeps waking itself after a progress report is reminded and closed by the same clock", async () => {
  const time = moved(Date.parse("2026-11-16T00:00:00Z"));
  client.close();
  client = new SuperagentClient({ stateDir, now: time.clock });
  const ticketId = started(client);
  const assignment = client.store.tickets.get(ticketId)!.assignments[0]!;
  client.engine.assignmentStarted(ticketId, assignment.id);
  client.engine.report(ticketId, { state: "progress", summary: "still watching the CI run" });
  client.engine.turnEnded(ticketId, assignment.id);
  client.engine.checkBack(ticketId, 60, "CI again");
  time.tick(61 * 60_000);
  client.engine.fireCheckBack(ticketId);
  // The next turn takes the note and reports progress, leaving another check-back: each wake is a paid turn, and no person is
  // waited for.
  client.engine.inputsDelivered(ticketId, assignment.id, [...client.store.tickets.get(ticketId)!.undelivered]);
  client.engine.report(ticketId, { state: "progress", summary: "still watching the CI run" });
  client.engine.turnEnded(ticketId, assignment.id);
  client.engine.checkBack(ticketId, 60, "CI again");
  // The clock counts from the latest progress report, not from the check-back that woke the turn: a ticket cannot restart
  // its own clock by waking itself.
  const since = client.store.tickets.get(ticketId)!.assignments[0]!.report!.at;
  assert.equal(since, new Date(Date.parse("2026-11-16T00:00:00Z") + 61 * 60_000).toISOString());
  const reminded = Date.parse(time.clock()) + REMIND_MS;
  sweepStale(client, reminded);
  const nudge = client.store.receipts.waiting().find((receipt) => receipt.kind === "reply" && receipt.ticketId === ticketId);
  assert.match(nudge?.text ?? "", /working on its own/, "the person hears what the ticket is doing, not that it waits on them");
  sweepStale(client, reminded + CLOSE_MS);
  const ticket = client.store.tickets.get(ticketId)!;
  assert.deepEqual(ticket.ended && { outcome: ticket.ended.outcome, reason: ticket.ended.reason }, { outcome: "dropped", reason: EXPIRED_REASON });
});
