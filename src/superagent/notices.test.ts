/** A ticket's notices: the stop notice that always fits, the clock of a ticket that waits on a person, and what stopped work keeps. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { key, liveTicket, ticketStage, type Ticket } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { SuperagentHost } from "./host.js";
import { KV } from "./kv.js";
import { CLOSE_MS, EXPIRED_REASON, REMIND_MS, stoppedNotice, sweepStale, waitingSince } from "./notices.js";
import { settingsPath, writeSettings } from "./settings.js";
import { commentTrigger } from "./sources/github-trigger.js";
import { localOperator, localTrigger } from "./sources/local.js";
import { IM_WORDS, wordCount } from "./text.js";
import { PATCH_BYTES, fileReport, patchPath, withPatch, type TicketTool } from "./ticket-tools.js";
import { ticketRow } from "./views.js";

const HOUR = 3_600_000;
let stateDir: string;
let client: SuperagentClient;
/** The Engine's clock, which a test moves. */
let now: number;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-superagent-notices-"));
  now = Date.now();
  client = new SuperagentClient({ stateDir, now: () => new Date(now).toISOString() });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

const iso = (time: number) => new Date(time).toISOString();
const tick = (ms = 1000) => { now += ms; };
const ticket = (id: string): Ticket => client.store.tickets.get(id)!;
const receipts = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
  .map((row) => JSON.parse(String(row.value)) as { id: string; text: string; kind: string; ticketId?: string; attachment?: string; channel: { source: string } });
let written = Date.now();
/** Writes the settings file with a modification time later than any before, so the client reads it again. */
function settings(value: unknown): void {
  writeSettings(value, settingsPath(stateDir));
  written += 2000;
  utimesSync(settingsPath(stateDir), new Date(), new Date(written));
}
/** Accepts the request a Trigger holds and starts its worker; returns the ticket's id. */
function accept(triggerId: string): string {
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Fix the typo", scope: "x", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  client.engine.assignmentStarted(ticketId!, ticket(ticketId!).assignments[0]!.id);
  tick();
  return ticketId!;
}
/** A ticket a person asked for in the terminal, with its worker at work. */
const started = (request: string): string => accept(client.request(request).triggerId);
/** Moves the clock to `at` and looks for tickets that waited too long, as the host's pass does. */
function sweep(at: number): void {
  now = at;
  sweepStale(client, now);
}

test("a stop notice fits a chat message whatever its report's summary says, and still tells the person how to go on", () => {
  const chinese = "构建失败了，测试没有通过，需要检查依赖的版本。".repeat(20).slice(0, 240);
  const english = "the build failed and the tests did not pass ".repeat(60).slice(0, 2000);
  assert.ok(wordCount(chinese) > IM_WORDS && wordCount(english) > IM_WORDS, "either summary alone is too long for a chat message");
  const endings = {
    failed: ["Reply here and I'll pick it up again.", "回复这条消息，我会接着做。"],
    blocked: ["Reply here to tell me how to go on.", "回复这条消息，告诉我怎么继续。"]
  };
  for (const state of ["failed", "blocked"] as const) {
    for (const [summary, request, ending] of [[english, "fix the typo", endings[state][0]!], [chinese, "修一下错别字", endings[state][1]!],
      [english, "修一下错别字", endings[state][1]!], [chinese, "fix the typo", endings[state][0]!]] as const) {
      const text = stoppedNotice(state, summary, request);
      assert.ok(wordCount(text) <= IM_WORDS, `${wordCount(text)} words: ${text}`);
      assert.ok(text.endsWith(`… ${ending}`), text);
      assert.ok(text.includes(summary.slice(0, 20)), "it still quotes the start of the reason");
    }
  }
  // A summary that fits is quoted whole, as before.
  assert.equal(stoppedNotice("blocked", "Needs a branch name.", "fix it"), "This ticket is stuck: Needs a branch name. Reply here to tell me how to go on.");
  // One long word counts as one, and is still cut at the 240 characters a notice quotes at most.
  const word = stoppedNotice("failed", "x".repeat(300), "fix it");
  assert.ok(word.includes(`: ${"x".repeat(240)}… Reply here`), word);
});

test("a ticket waits on its person since its latest report, while they said nothing since and its worker is not at work", () => {
  const id = started("choose a separator");
  const assignment = ticket(id).assignments[0]!.id;
  assert.equal(waitingSince(ticket(id)), undefined, "its worker works");

  client.engine.report(id, { state: "blocked", summary: "Needs a branch name." });
  const blocked = iso(now);
  assert.equal(waitingSince(ticket(id)), blocked);
  // What a bot writes on its Thread is not its person's word.
  tick();
  const threadId = client.store.triggers.get(ticket(id).origin.triggerId)!.threads[0]!.id;
  client.engine.receive({ ...localTrigger({ id: "ci-1", text: "The checks passed.", threadId }), human: false });
  assert.ok(ticket(id).inputs.some((input) => input.kind === "trigger" && !input.human), "the bot's message reached the ticket");
  assert.equal(waitingSince(ticket(id)), blocked);
  // Nor is what a person writes on a Thread the ticket only reads for context.
  client.engine.followForContext(id, { source: "local", id: "elsewhere" });
  client.engine.receive(localTrigger({ id: "aside-1", text: "An aside.", threadId: "elsewhere" }));
  assert.ok(ticket(id).inputs.some((input) => input.kind === "trigger" && input.human && input.context), "the aside reached the ticket for context");
  assert.equal(waitingSince(ticket(id)), blocked);
  tick();
  client.message(id, "use main");
  assert.equal(waitingSince(ticket(id)), undefined, "the person wrote");

  // A person's message in the very millisecond of the report does not answer it, as `waitsForPerson` decides; one a
  // millisecond later does.
  tick();
  client.engine.report(id, { state: "failed", summary: "The build broke." });
  const broke = iso(now);
  assert.equal(waitingSince(ticket(id)), broke);
  client.message(id, "try again with main");
  assert.equal(waitingSince(ticket(id)), broke, "written before the report it would answer");
  tick();
  client.message(id, "still try again with main");
  assert.equal(waitingSince(ticket(id)), undefined, "the person wrote after it");
  tick();
  client.engine.report(id, { state: "failed", summary: "The build broke again." });
  assert.equal(waitingSince(ticket(id)), iso(now));

  // A question asked in passing: the worker goes on until its turn ends, and the end of an earlier turn does not count.
  tick();
  client.engine.turnEnded(id, assignment);
  tick();
  client.engine.report(id, { state: "progress", summary: "Need the default", question: "Dash or underscore?" });
  const asked = iso(now);
  assert.equal(waitingSince(ticket(id)), undefined, "its worker has not ended its turn");
  tick();
  client.engine.turnEnded(id, assignment);
  assert.equal(waitingSince(ticket(id)), asked, "it waits since the report that asked, not since the turn's end");
  tick();
  client.message(id, "dash");
  assert.equal(waitingSince(ticket(id)), undefined, "the person answered");

  tick();
  client.engine.report(id, { state: "blocked", summary: "Still unclear.", question: "Dash where, in file names too?" });
  assert.equal(waitingSince(ticket(id)), iso(now));
  // A retry starts a worker that has reported nothing yet, while the question stays open.
  tick();
  client.retry(id);
  const retried = iso(now);
  assert.equal(waitingSince(ticket(id)), undefined, "the retried work runs");
  // Its turn ends with no report, the question still open: the ticket waits since the retry, which its person asked for.
  client.engine.assignmentStarted(id, ticket(id).assignments.at(-1)!.id);
  tick();
  client.engine.turnEnded(id, ticket(id).assignments.at(-1)!.id);
  assert.equal(waitingSince(ticket(id)), retried, "not since the report before the retry");
  // A note that reaches the retried worker puts it to work again, until that turn ends too.
  tick();
  client.engine.note(id, "The other ticket chose dashes.");
  client.engine.inputsDelivered(id, ticket(id).assignments.at(-1)!.id, ticket(id).undelivered);
  assert.equal(waitingSince(ticket(id)), undefined, "its worker reads the note");
  tick();
  client.engine.turnEnded(id, ticket(id).assignments.at(-1)!.id);
  assert.equal(waitingSince(ticket(id)), retried);
});

test("a ticket whose worker took up what reached it after its question is not closed under it", () => {
  const id = started("choose a separator");
  const assignment = ticket(id).assignments[0]!.id;
  client.engine.report(id, { state: "progress", summary: "Need the default", question: "Dash or underscore?" });
  const since = now;
  tick();
  client.engine.turnEnded(id, assignment);
  sweep(since + REMIND_MS);
  const reminder = { since: iso(since), at: iso(since + REMIND_MS) };
  assert.deepEqual(client.store.get(KV.notices.nudged(id)), reminder);
  // A note reaches its worker an hour before the ticket would close, and the worker works on it.
  now = since + REMIND_MS + CLOSE_MS - HOUR;
  client.engine.note(id, "The other ticket chose dashes.");
  client.engine.inputsDelivered(id, assignment, ticket(id).undelivered);
  assert.equal(waitingSince(ticket(id)), undefined, "its worker is at work");
  sweep(since + REMIND_MS + CLOSE_MS);
  assert.ok(liveTicket(ticket(id)), "work that runs is not stopped");
  assert.deepEqual(client.store.get(KV.notices.nudged(id)), reminder, "the reminder still counts");
  // Its turn ends with nothing new said: the wait its person was reminded of goes on, and is over.
  tick();
  client.engine.turnEnded(id, assignment);
  assert.equal(waitingSince(ticket(id)), iso(since));
  sweep(now);
  assert.equal(ticket(id).ended?.reason, EXPIRED_REASON);
});

test("a host restart while a ticket waits on its person does not start its clock again", () => {
  const id = started("choose a separator");
  const assignment = ticket(id).assignments[0]!.id;
  client.engine.report(id, { state: "progress", summary: "Need the default", question: "Dash or underscore?" });
  const since = now;
  tick();
  client.engine.turnEnded(id, assignment);
  sweep(since + REMIND_MS);
  const reminder = { since: iso(since), at: iso(since + REMIND_MS) };
  const sent = receipts().length;
  // The host restarts four hours before the ticket would close: a worker whose last report was progress starts anew.
  now = since + REMIND_MS + CLOSE_MS - 4 * HOUR;
  client.engine.assignmentInterrupted(id, assignment);
  const restarted = ticket(id).assignments.at(-1)!.id;
  assert.notEqual(restarted, assignment);
  client.engine.assignmentStarted(id, restarted);
  assert.equal(waitingSince(ticket(id)), undefined, "the restarted worker is at work");
  sweep(now + 1000);
  assert.deepEqual(client.store.get(KV.notices.nudged(id)), reminder, "the reminder still counts");
  // It reads the host's note and ends its turn with no report, since the question is still open.
  tick();
  client.engine.inputsDelivered(id, restarted, ticket(id).undelivered);
  tick();
  client.engine.turnEnded(id, restarted);
  assert.equal(waitingSince(ticket(id)), iso(since));
  sweep(since + REMIND_MS + CLOSE_MS - 1);
  assert.ok(liveTicket(ticket(id)));
  sweep(since + REMIND_MS + CLOSE_MS);
  assert.equal(ticket(id).ended?.reason, EXPIRED_REASON, "closed a day after its reminder, not a day after the restart");
  assert.equal(receipts().length, sent + 1, "the closing notice, and no second reminder");
});

test("a retry starts the wait over, as its person's message would", () => {
  const id = started("choose a separator");
  client.engine.report(id, { state: "blocked", summary: "Unclear.", question: "Dash or underscore?" });
  const since = now;
  sweep(since + REMIND_MS);
  assert.ok(client.store.get(KV.notices.nudged(id)));
  // Half an hour before the ticket would close its person retries it, and the retried worker's turn ends with no report.
  now = since + REMIND_MS + CLOSE_MS - HOUR / 2;
  client.retry(id);
  const retried = now;
  const assignment = ticket(id).assignments.at(-1)!.id;
  client.engine.assignmentStarted(id, assignment);
  tick(20_000);
  client.engine.turnEnded(id, assignment);
  sweep(since + REMIND_MS + CLOSE_MS);
  assert.ok(liveTicket(ticket(id)), "not closed half an hour after its person retried it");
  assert.equal(client.store.get(KV.notices.nudged(id)), undefined, "the reminder was for the wait before the retry");
  sweep(retried + REMIND_MS);
  assert.equal(receipts().find((receipt) => receipt.id === key("nudge", id, iso(retried)))?.text,
    "This ticket is still waiting for your answer: Dash or underscore? Without a reply within a day I'll close it; a reply here after that reopens it.");
  sweep(retried + REMIND_MS + CLOSE_MS);
  assert.equal(ticket(id).ended?.reason, EXPIRED_REASON);
  assert.equal(receipts().find((receipt) => receipt.id === key("expired", id, iso(retried)))?.text,
    "There was no reply in two days, so I closed this ticket. Reply here and I'll pick it up again.");
});

test("a ticket that idles between turns or waits for its result's review has no clock", () => {
  // Idle: its worker reported that it waits, and ended its turn.
  const idle = started("watch the build");
  client.engine.report(idle, { state: "waiting", summary: "Waiting for the build." });
  tick();
  client.engine.turnEnded(idle, ticket(idle).assignments[0]!.id);
  // In review: its result is ready, and the ticket stays open with the pull request it opened.
  const review = started("fix the typo");
  client.engine.bindThread(review, { source: "github", id: "9" }, true);
  client.engine.report(review, { state: "ready", summary: "Opened the pull request." });
  assert.deepEqual([ticketStage(ticket(idle)), ticketStage(ticket(review))], [{ stage: "idle" }, { stage: "person", action: "review" }]);
  assert.deepEqual([waitingSince(ticket(idle)), waitingSince(ticket(review))], [undefined, undefined]);
  const before = receipts().length;
  for (const day of [1, 2, 3, 10]) sweep(now + day * 24 * HOUR);
  assert.ok(liveTicket(ticket(idle)) && liveTicket(ticket(review)), "neither is closed");
  assert.equal(receipts().length, before, "and neither is reminded");
});

test("the day before a close counts from the reminder, and a new report starts a new wait though no pass saw the old one end", () => {
  const id = started("fix the typo");
  client.engine.report(id, { state: "blocked", summary: "Needs a branch name." });
  const since = now;
  // The host was off for three days: its first pass reminds, and the ticket has its day from then.
  sweep(since + 72 * HOUR);
  assert.deepEqual(client.store.get(KV.notices.nudged(id)), { since: iso(since), at: iso(since + 72 * HOUR) });
  sweep(since + 95 * HOUR);
  assert.ok(liveTicket(ticket(id)), "a day after the reminder, not two days after the report");
  // Its worker reports again with no pass in between: the reminder was for the wait before.
  tick();
  client.engine.report(id, { state: "failed", summary: "The build broke." });
  const again = now;
  sweep(since + 96 * HOUR);
  assert.ok(liveTicket(ticket(id)), "the new wait is an hour old");
  assert.equal(client.store.get(KV.notices.nudged(id)), undefined);
  sweep(again + REMIND_MS);
  assert.deepEqual(client.store.get(KV.notices.nudged(id)), { since: iso(again), at: iso(again + REMIND_MS) });
  sweep(again + REMIND_MS + CLOSE_MS);
  assert.equal(ticket(id).ended?.reason, EXPIRED_REASON);
});

test("a ticket that waits on its person reminds them once after a day and is closed a day later, and their reply reopens it", () => {
  const id = started("修一下 README 的错别字");
  client.engine.report(id, { state: "blocked", summary: "Needs a branch name." });
  const since = now;
  const nudge = (at: number) => receipts().find((receipt) => receipt.id === key("nudge", id, iso(at)));
  const expired = (at: number) => receipts().find((receipt) => receipt.id === key("expired", id, iso(at)));
  const before = receipts().length;

  sweep(since + 23 * HOUR);
  assert.equal(receipts().length, before, "nothing before a day passed");
  assert.equal(client.store.get(KV.notices.nudged(id)), undefined);

  sweep(since + REMIND_MS);
  const reminder = nudge(since);
  assert.deepEqual([reminder?.kind, reminder?.ticketId, reminder?.channel.source], ["reply", id, "local"]);
  assert.equal(reminder?.text, "这张工单还卡着，在等你回复。一天内没有回复的话，我会关闭它；之后回复这条消息可以重新打开。");
  assert.deepEqual(client.store.get(KV.notices.nudged(id)), { since: iso(since), at: iso(since + REMIND_MS) });
  sweep(since + REMIND_MS + HOUR);
  assert.equal(receipts().length, before + 1, "one reminder, not one a pass");

  // The person's message ends the wait; a later block starts a fresh one.
  tick();
  client.message(id, "用 main 分支");
  sweep(now + 72 * HOUR);
  assert.equal(client.store.get(KV.notices.nudged(id)), undefined);
  assert.ok(liveTicket(ticket(id)), "the person wrote, so the ticket waits on its worker");
  tick();
  client.engine.report(id, { state: "blocked", summary: "The branch is protected." });
  const again = now;
  const sent = receipts().length;
  sweep(again + REMIND_MS - 1);
  assert.equal(receipts().length, sent);
  sweep(again + REMIND_MS);
  assert.ok(nudge(again), "the new wait has its own reminder");
  assert.equal(receipts().length, sent + 1);

  sweep(again + REMIND_MS + CLOSE_MS - 1);
  assert.ok(liveTicket(ticket(id)), "open until a day after the reminder");
  sweep(again + REMIND_MS + CLOSE_MS);
  assert.deepEqual(ticket(id).ended, { at: iso(now), by: "executor", outcome: "dropped", reason: EXPIRED_REASON });
  assert.equal(expired(again)?.text, "两天没有收到回复，我把这张工单关闭了。回复这条消息，我会接着做。");
  assert.deepEqual([expired(again)?.kind, expired(again)?.ticketId], ["reply", id]);
  assert.equal(receipts().length, sent + 2, "one closing notice");
  assert.equal(client.store.get(KV.notices.nudged(id)), undefined);
  assert.deepEqual([ticketRow(client, ticket(id)).group, ticketRow(client, ticket(id)).label], ["ended", "两天没有收到回复"]);
  sweep(now + 72 * HOUR);
  assert.equal(receipts().length, sent + 2, "a closed ticket hears nothing more");

  // Their reply resumes it under its Mandate, as it resumes a completed ticket.
  const assignments = ticket(id).assignments.length;
  tick();
  client.message(id, "分支解除保护了，继续吧");
  client.engine.evaluateDue();
  assert.ok(liveTicket(ticket(id)));
  assert.equal(ticket(id).assignments.length, assignments + 1);
  assert.equal(ticket(id).assignments.at(-1)!.state, "pending");
  assert.equal(waitingSince(ticket(id)), undefined);
});

test("the reminder of an open question quotes it, cut to fit a chat message", () => {
  const id = started("choose a separator");
  client.engine.report(id, { state: "blocked", summary: "Unclear.", question: "Dash or underscore?" });
  const since = now;
  sweep(since + REMIND_MS);
  assert.equal(receipts().find((receipt) => receipt.id === key("nudge", id, iso(since)))?.text,
    "This ticket is still waiting for your answer: Dash or underscore? Without a reply within a day I'll close it; a reply here after that reopens it.");

  const long = started("选一个分隔符");
  const question = "文件名里的分隔符用短横线还是下划线，目录名要不要一起改？".repeat(30);
  client.engine.report(long, { state: "blocked", summary: "不清楚。", question });
  const asked = now;
  sweep(asked + REMIND_MS);
  const text = receipts().find((receipt) => receipt.id === key("nudge", long, iso(asked)))!.text;
  assert.ok(wordCount(text) <= IM_WORDS, `${wordCount(text)} words`);
  assert.ok(text.startsWith("这张工单还在等你的回答：文件名里的分隔符") && text.endsWith("… 一天内没有回复的话，我会关闭它；之后回复这条消息可以重新打开。"), text);
});

test("a ticket with no conversation to remind its person in is closed after two days, unannounced", () => {
  // A ticket from GitHub: its timeline shows the work, so its notices go nowhere.
  settings({ sources: { github: { enabled: true, config: { repository: "acme/widgets", cli: "gh" } } }, policy: { sources: { github: { allowed: [{ id: "alice" }] } } } });
  const request = commentTrigger({ id: 1, body: "@agent-bot please fix the label typo", user: { login: "alice", type: "User" },
    html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1", created_at: iso(now) },
    { number: 7, isPr: false, url: "https://github.com/acme/widgets/issues/7" }, "conversation", "agent-bot");
  client.engine.receive(request);
  const github = accept(request.id);
  client.engine.report(github, { state: "failed", summary: "The build broke." });
  const since = now;
  assert.equal(waitingSince(ticket(github)), iso(since));
  sweep(since + REMIND_MS);
  sweep(since + REMIND_MS + CLOSE_MS - 1);
  assert.ok(liveTicket(ticket(github)));
  assert.equal(client.store.get(KV.notices.nudged(github)), undefined);
  sweep(since + REMIND_MS + CLOSE_MS);
  assert.deepEqual(ticket(github).ended, { at: iso(now), by: "executor", outcome: "dropped", reason: EXPIRED_REASON });
  assert.deepEqual(receipts(), [], "no reminder and no closing notice");

  // A ticket whose Source was switched off since: its conversation takes nothing.
  const local = started("fix the typo");
  client.engine.report(local, { state: "blocked", summary: "Needs a branch name." });
  const blocked = now;
  const before = receipts().length;
  settings({ sources: { local: { enabled: false, config: {} } } });
  sweep(blocked + REMIND_MS + CLOSE_MS - 1);
  assert.ok(liveTicket(ticket(local)));
  sweep(blocked + REMIND_MS + CLOSE_MS);
  assert.equal(ticket(local).ended?.reason, EXPIRED_REASON);
  assert.equal(receipts().length, before);
});

test("a ticket whose conversation went away after its reminder is closed a day after it, unannounced", () => {
  const id = started("fix the typo");
  client.engine.report(id, { state: "blocked", summary: "Needs a branch name." });
  const since = now;
  sweep(since + REMIND_MS);
  const sent = receipts().length;
  assert.ok(client.store.get(KV.notices.nudged(id)));
  settings({ sources: { local: { enabled: false, config: {} } } });
  sweep(since + REMIND_MS + CLOSE_MS - 1);
  assert.ok(liveTicket(ticket(id)));
  sweep(since + REMIND_MS + CLOSE_MS);
  assert.equal(ticket(id).ended?.reason, EXPIRED_REASON);
  assert.equal(receipts().length, sent, "no closing notice");
  assert.equal(client.store.get(KV.notices.nudged(id)), undefined);
});

test("a ticket the host closed shows why in its row, one its worker dropped shows there was nothing to do, and closing twice changes nothing", () => {
  const closed = started("fix the typo");
  client.engine.report(closed, { state: "blocked", summary: "Needs a branch name." });
  tick();
  const ended = client.engine.expireTicket(closed, EXPIRED_REASON);
  assert.deepEqual(ended.ended, { at: iso(now), by: "executor", outcome: "dropped", reason: EXPIRED_REASON });
  assert.equal(ticketRow(client, ended).label, "No reply in two days", "worded for its English request");
  tick();
  assert.deepEqual(client.engine.expireTicket(closed, "Another reason").ended, ended.ended);

  const dropped = started("thanks");
  client.engine.report(dropped, { state: "dropped", summary: "Nothing asked." });
  assert.equal(ticketRow(client, ticket(dropped)).label, "Nothing to do");
  // Only the host's close shows its reason: a ticket a person stopped says so, whatever reason they gave.
  assert.equal(ticketRow(client, client.stop(started("fix another typo"), "Changed my mind")).label, "Stopped by a person");
});

test("work that stops keeps its commits as a patch, attached to nothing, uncommitted changes or not", async () => {
  // Any ticket's, not only one that keeps its work local: a ticket VM's disk goes with its ticket.
  const plain = started("fix the typo");
  assert.notEqual(ticket(plain).mandate.capability?.write, "local");
  await fileReport(client, plain, { state: "blocked", summary: "Needs a branch name.", patch: { text: "From 0\n", bytes: 7, uncommitted: false } });
  assert.equal(readFileSync(patchPath(stateDir, ticket(plain)), "utf8"), "From 0\n");
  client.stop(plain);
  // A ticket that keeps its work local, whose ready report refuses uncommitted changes and a patch too large.
  settings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "everyone" } } } } });
  const id = started("add a NOTICE file");
  assert.equal(ticket(id).mandate.capability?.write, "local");
  const patch = "From 1 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Add NOTICE\n";
  const blocked = await fileReport(client, id, { state: "blocked", summary: "Needs a licence name.", patch: { text: patch, bytes: patch.length, uncommitted: true } });
  assert.deepEqual([blocked.reported, blocked.posted, blocked.ended], [true, [], false]);
  assert.equal(readFileSync(patchPath(stateDir, ticket(id)), "utf8"), patch);
  const later = `${patch}Subject: [PATCH] Name the licence\n`;
  const failed = await fileReport(client, id, { state: "failed", summary: "The build broke.", message_for_person: "The build broke, so I stopped.",
    patch: { text: later, bytes: later.length, uncommitted: false } });
  assert.equal(readFileSync(patchPath(stateDir, ticket(id)), "utf8"), later);
  // The worker's own words go to its person as the stop notice, and carry no patch either.
  assert.deepEqual(failed.posted, ["notice"]);
  const told = receipts().filter((receipt) => receipt.text === "The build broke, so I stopped.");
  assert.deepEqual(told.map((receipt) => [receipt.ticketId, receipt.attachment]), [[id, undefined]]);
  // A patch too large to carry has no text: the report still counts, and the patch kept before stays.
  await fileReport(client, id, { state: "blocked", summary: "Still broken.", patch: { text: "", bytes: 4 * 1024 * 1024, uncommitted: true } });
  assert.equal(readFileSync(patchPath(stateDir, ticket(id)), "utf8"), later);
  assert.ok(receipts().length > 0 && receipts().every((receipt) => receipt.attachment === undefined), "the person's notices carry no patch");
});

test("the report tool reads the directory's patch for a ready, blocked or failed report, and for no other", async () => {
  const directory = join(stateDir, "work");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: directory, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "-q", directory]);
  git("commit", "-q", "--allow-empty", "-m", "Start");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(directory, "NOTICE"), "Swarm\n");
  git("add", "NOTICE");
  git("commit", "-q", "-m", "Add NOTICE");
  const seen: Record<string, unknown>[] = [];
  const report: TicketTool = { name: "report", description: "", input: {}, readOnly: false, run: async (args) => { seen.push(args); return {}; } };
  const [tool] = withPatch([report], directory);
  for (const state of ["progress", "ready", "blocked", "failed", "dropped"]) await tool!.run({ state, summary: "x" });
  const patches = seen.map((args) => (args.patch as { text: string; uncommitted: boolean } | undefined));
  assert.deepEqual(patches.map((patch) => patch !== undefined), [false, true, true, true, false]);
  assert.ok(patches[2]!.text.includes("Subject: [PATCH] Add NOTICE") && patches[2]!.uncommitted === false);

  // Stopped work must still be reported: a patch that would make its report too large to send goes without its text. A
  // ready report keeps it, since a local ticket's result is that patch.
  writeFileSync(join(directory, "LARGE"), "x".repeat(990_000));
  git("add", "LARGE");
  git("commit", "-q", "-m", "Add a large file");
  seen.length = 0;
  for (const state of ["blocked", "failed", "ready"]) await tool!.run({ state, summary: "x" });
  const large = seen.map((args) => args.patch as { text: string; bytes: number });
  assert.ok(large[0]!.bytes > 990_000 && large[0]!.bytes <= PATCH_BYTES, `${large[0]!.bytes} bytes`);
  assert.deepEqual(large.map((patch) => patch.text.length > 0), [false, false, true]);
});

test("the host's pass looks for tickets that waited too long, though not while paused, and logs a follow-up that failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-superagent-notices-"));
  const logs: string[] = [];
  const host = new SuperagentHost({ stateDir: dir, workerCommand: [process.execPath], complete: async () => { throw new Error("no model in this test"); },
    log: (message) => logs.push(message) });
  const write = (value: unknown) => {
    writeSettings(value, settingsPath(dir));
    written += 2000;
    utimesSync(settingsPath(dir), new Date(), new Date(written));
  };
  try {
    const { store, engine } = host.client;
    const { triggerId } = host.client.request("fix the typo");
    engine.evaluateDue();
    const { ticketId } = engine.decide(triggerId, { kind: "accept", title: "Fix the typo", scope: "x", reason: "asked", name: "fix-typo", evalId: engine.candidate(triggerId)!.evalId });
    engine.assignmentStarted(ticketId!, store.tickets.get(ticketId!)!.assignments[0]!.id);
    engine.report(ticketId!, { state: "blocked", summary: "Needs a branch name." });
    // The host reads the real clock, so the report moves a day back instead.
    const waiting = store.tickets.get(ticketId!)!;
    const since = iso(Date.now() - REMIND_MS - HOUR);
    waiting.assignments[0]!.report!.at = since;
    store.tickets.save(waiting);
    const reminded = () => store.receipts.get(key("nudge", ticketId!, since));

    write({ paused: true });
    await host.pass();
    assert.equal(reminded(), undefined, "a paused host reminds nobody");
    write({});
    await host.pass();
    assert.equal(reminded()?.text, "This ticket is still stuck and waiting for you. Without a reply within a day I'll close it; a reply here after that reopens it.");
    assert.deepEqual(logs.filter((line) => line.includes("failed")), []);
    // It looks once a minute: a pass right after leaves open a ticket whose reminder is a day old by then.
    store.set(KV.notices.nudged(ticketId!), { since, at: iso(Date.now() - CLOSE_MS) });
    await host.pass();
    assert.ok(liveTicket(store.tickets.get(ticketId!)!), "its next look is a minute away");

    host.client.subscribe(() => { throw new Error("the notice did not fit"); });
    host.client.request("another request");
    assert.match(logs.join("\n"), /superagent: a follow-up after a commit failed: Error: the notice did not fit/);
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an error thrown by a follow-up after a commit is reported to the client's onError instead of vanishing", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-superagent-notices-"));
  const errors: unknown[] = [];
  const reporting = new SuperagentClient({ stateDir: dir, onError: (error) => errors.push(error), onEvent: () => { throw new Error("the notice did not fit"); } });
  try {
    // The request commits, then its event's follow-up throws.
    const { triggerId } = reporting.request("fix the typo");
    assert.ok(reporting.store.triggers.get(triggerId), "the commit stands");
    assert.deepEqual(errors.map(String), ["Error: the notice did not fit"]);
  } finally {
    reporting.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket whose Inputs did not reach its worker waits from the failed delivery, and is reminded and closed like any other", () => {
  const id = started("choose a separator");
  const assignment = ticket(id).assignments[0]!.id;
  client.engine.deliveryFailed(id, assignment, "Session busy");
  const failed = iso(now);
  assert.deepEqual(ticketStage(ticket(id)), { stage: "person", action: "delivery" });
  assert.equal(waitingSince(ticket(id)), failed, "the ticket has a clock though it reported nothing");
  // Its person's retry starts a worker, which puts it to work until that turn ends.
  tick();
  client.retry(id);
  assert.equal(waitingSince(ticket(id)), undefined, "the retried work runs");
  client.engine.assignmentStarted(id, ticket(id).assignments.at(-1)!.id);
  client.engine.deliveryFailed(id, ticket(id).assignments.at(-1)!.id, "Session busy");
  const retried = iso(now);
  assert.equal(waitingSince(ticket(id)), retried, "a retry that fails to deliver starts its own wait");
  sweep(now + REMIND_MS);
  assert.ok(receipts().some((receipt) => receipt.id === key("nudge", id, retried)), "its person hears a reminder");
  sweep(now + CLOSE_MS);
  assert.equal(ticket(id).ended?.reason, EXPIRED_REASON);
  assert.ok(receipts().some((receipt) => receipt.id === key("expired", id, retried)), "and hears it closed");
});
