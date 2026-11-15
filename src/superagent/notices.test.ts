/** A ticket's notices: the stop notice that always fits, the clock of a ticket that waits on a person, and what stopped work keeps. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { key, liveTicket, type Ticket } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { SuperagentHost } from "./host.js";
import { KV } from "./kv.js";
import { CLOSE_MS, EXPIRED_REASON, REMIND_MS, stoppedNotice, sweepStale, waitingSince } from "./notices.js";
import { settingsPath, writeSettings } from "./settings.js";
import { commentTrigger } from "./sources/github-trigger.js";
import { localOperator } from "./sources/local.js";
import { IM_WORDS, wordCount } from "./text.js";
import { fileReport, patchPath, withPatch, type TicketTool } from "./ticket-tools.js";
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
});

test("a ticket waits on its person since its latest report, while they said nothing since and its worker is not at work", () => {
  const id = started("choose a separator");
  const assignment = ticket(id).assignments[0]!.id;
  assert.equal(waitingSince(ticket(id)), undefined, "its worker works");

  client.engine.report(id, { state: "blocked", summary: "Needs a branch name." });
  assert.equal(waitingSince(ticket(id)), iso(now));
  tick();
  client.message(id, "use main");
  assert.equal(waitingSince(ticket(id)), undefined, "the person wrote");

  tick();
  client.engine.report(id, { state: "failed", summary: "The build broke." });
  assert.equal(waitingSince(ticket(id)), iso(now));

  // A question asked in passing: the worker goes on until its turn ends.
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
  assert.equal(waitingSince(ticket(id)), undefined, "the retried work runs");
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
  assert.deepEqual([ticketRow(client, ticket(id)).group, ticketRow(client, ticket(id)).label], ["ended", EXPIRED_REASON]);
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

test("a ticket the host closed shows why in its row, one its worker dropped shows there was nothing to do, and closing twice changes nothing", () => {
  const closed = started("fix the typo");
  client.engine.report(closed, { state: "blocked", summary: "Needs a branch name." });
  tick();
  const ended = client.engine.expireTicket(closed, EXPIRED_REASON);
  assert.deepEqual(ended.ended, { at: iso(now), by: "executor", outcome: "dropped", reason: EXPIRED_REASON });
  assert.equal(ticketRow(client, ended).label, "No reply in two days");
  tick();
  assert.deepEqual(client.engine.expireTicket(closed, "Another reason").ended, ended.ended);

  const dropped = started("thanks");
  client.engine.report(dropped, { state: "dropped", summary: "Nothing asked." });
  assert.equal(ticketRow(client, ticket(dropped)).label, "Nothing to do");
});

test("work that stops keeps its commits as a patch, attached to nothing, uncommitted changes or not", async () => {
  // A ticket that keeps its work local, whose ready report refuses uncommitted changes and a patch too large.
  settings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "everyone" } } } } });
  const id = started("add a NOTICE file");
  assert.equal(ticket(id).mandate.capability?.write, "local");
  const patch = "From 1 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Add NOTICE\n";
  const blocked = await fileReport(client, id, { state: "blocked", summary: "Needs a licence name.", patch: { text: patch, bytes: patch.length, uncommitted: true } });
  assert.deepEqual([blocked.reported, blocked.posted, blocked.ended], [true, [], false]);
  assert.equal(readFileSync(patchPath(stateDir, ticket(id)), "utf8"), patch);
  const later = `${patch}Subject: [PATCH] Name the licence\n`;
  await fileReport(client, id, { state: "failed", summary: "The build broke.", patch: { text: later, bytes: later.length, uncommitted: false } });
  assert.equal(readFileSync(patchPath(stateDir, ticket(id)), "utf8"), later);
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
