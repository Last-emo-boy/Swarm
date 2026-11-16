/** The journal (journal.ts): one row per run with its card and outcome, attempts under one key, and the 14-day prune. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { JOURNAL_DAYS, Journal, journaled, journalPlace } from "./journal.js";
import { Store } from "./store.js";

let directory: string;
let store: Store;
let now: number;
let journal: Journal;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "swarm-journal-"));
  store = new Store(join(directory, "superagent.db"));
  now = Date.parse("2026-11-16T09:00:00Z");
  journal = new Journal(store, () => new Date(now));
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

test("a run's start records the card as sent, and its outcome patches that same row", () => {
  const id = journal.start({ kind: "chatter", key: "chat:oc_team", purpose: "superagent_chatter", model: "deepseek-v4-flash",
    system: "You are w33d.", user: '{"chat":"oc_team"}' });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM journal").get()?.n, 1);
  journal.answer(id, '{"say":"hello","reason":"a light moment"}');
  journal.outcome("chatter", "chat:oc_team", "sent", { reason: "a light moment", outbox: ["m1", "m1"] });
  const [run] = journal.byKey("chat:oc_team");
  assert.deepEqual(run, { purpose: "superagent_chatter", model: "deepseek-v4-flash", system: "You are w33d.", user: '{"chat":"oc_team"}',
    answer: '{"say":"hello","reason":"a light moment"}', outcome: "sent", reason: "a light moment", outbox: ["m1"] });
});

test("two runs under one key are attempts 0 and 1, the first closes as a retry, and an outcome goes to the one still open", () => {
  journal.start({ kind: "attend", key: "chat:oc_team", purpose: "superagent_attend", system: "s", user: "u" });
  journal.start({ kind: "attend", key: "chat:oc_team", purpose: "superagent_attend", system: "s", user: "u" });
  const rows = store.db.prepare("SELECT attempt, id FROM journal ORDER BY attempt").all();
  assert.deepEqual(rows.map((row) => Number(row.attempt)), [0, 1]);
  assert.equal(new Set(rows.map((row) => String(row.id))).size, 2);
  journal.outcome("attend", "chat:oc_team", "silent", { reason: "already answered" });
  const runs = journal.byKey("chat:oc_team");
  // A second try closes the first as retried, so it does not read as a crash.
  assert.deepEqual(runs.map((run) => [run.outcome, run.reason]), [["dropped", "retried"], ["silent", "already answered"]]);
});

test("after a prune deletes old rows, a new run never reuses a kept row's attempt, and kept cards survive", () => {
  const days = (count: number) => new Date(now - count * 86_400_000);
  // Five runs 15 days old, then five kept: the prune leaves attempts 5-9, whose count is smaller than their attempts.
  for (let index = 0; index < 10; index++) {
    store.db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?)").run(`old-${index}`, days(index < 5 ? 15 : 10).toISOString(), "chatter", "chat:c", index,
      JSON.stringify({ purpose: "p", system: "", user: `card ${index}` }))
  }
  assert.equal(journal.prune(JOURNAL_DAYS), 5);
  const id = journal.start({ kind: "chatter", key: "chat:c", purpose: "superagent_chatter", system: "s", user: "card new" });
  const rows = store.db.prepare("SELECT id, attempt, value FROM journal WHERE key = 'chat:c' ORDER BY attempt").all();
  assert.equal(rows.length, 6, "the new run adds a row rather than replacing a kept one");
  assert.equal(Number(rows.at(-1)!.attempt), 10);
  assert.equal(String(rows.at(-1)!.id), id);
  assert.deepEqual(rows.slice(0, 5).map((row) => JSON.parse(String(row.value)).user), ["card 5", "card 6", "card 7", "card 8", "card 9"]);
});

test("a limit on a key or on history keeps the newest runs, oldest first", () => {
  for (let index = 0; index < 120; index++) journal.skip("chatter", "chat:c", "skipped", `run ${index}`);
  const newest = journal.byKey("chat:c", 3).map((run) => run.reason);
  assert.deepEqual(newest, ["run 117", "run 118", "run 119"]);
  assert.deepEqual(journal.byKeyPrefix("chat:", 2).map((run) => run.reason), ["run 118", "run 119"]);
  assert.deepEqual(journal.history(["chat:c"], [], 2).map((entry) => entry.run.reason), ["run 118", "run 119"]);
});

test("a skipped run records why the model was never asked, and an outcome with no open run records itself", () => {
  journal.skip("reach_out", "person:ou_alice:2026-11-16T09:00:00.000Z", "skipped", "quiet hours");
  journal.outcome("promise", "note:n1", "sent", { reason: "kept", outbox: ["p1"] });
  assert.deepEqual(journal.byKey("person:ou_alice:2026-11-16T09:00:00.000Z").map((run) => [run.outcome, run.reason]), [["skipped", "quiet hours"]]);
  assert.deepEqual(journal.byKey("note:n1").map((run) => [run.outcome, run.outbox]), [["sent", ["p1"]]]);
});

test("the wrapper records the card, the answer and a failed call, and the newest rows of a kind come back oldest first", async () => {
  const complete = journaled(journal, async (input) => input.user === "broken" ? Promise.reject(new Error("the provider timed out")) : '"ok"');
  await complete({ purpose: "superagent_chatter", system: "s", user: "u", target: { chat: "oc_team" } });
  await assert.rejects(complete({ purpose: "superagent_chatter", system: "s", user: "broken", target: { chat: "oc_team" } }), /timed out/);
  // A call with nothing to place it in, such as the worker's own conclusion, is passed through unrecorded.
  assert.equal(await complete({ purpose: "superagent_conclude", system: "s", user: "u" }), '"ok"');
  const runs = journal.byKey("chat:oc_team");
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.answer, '"ok"');
  assert.equal(runs[0]?.outcome, "dropped", "a second call of the same key closes the first as retried, not as a crash");
  assert.equal(runs[0]?.reason, "retried");
  assert.equal(runs[1]?.outcome, "failed");
  assert.match(runs[1]!.reason!, /timed out/);
  assert.deepEqual(journal.latestByKind("chatter", 5).map((run) => run.user), ["u", "broken"]);
});

test("places a call by its purpose and what it is about, and none without one", () => {
  assert.deepEqual(journalPlace("superagent_chatter", { chat: "c" }), { kind: "chatter", key: "chat:c", purpose: "superagent_chatter" });
  assert.deepEqual(journalPlace("superagent_memory", { ticket: "t" }), { kind: "ticket_reflect", key: "ticket:t", purpose: "superagent_memory" });
  assert.deepEqual(journalPlace("superagent_memory", { chat: "c" }), { kind: "reflect", key: "chat:c", purpose: "superagent_memory" });
  assert.deepEqual(journalPlace("superagent_memory", { subject: "person:ou_a" }), { kind: "tidy", key: "subject:person:ou_a", purpose: "superagent_memory" });
  assert.deepEqual(journalPlace("superagent_promise", { note: "n" }), { kind: "promise", key: "note:n", purpose: "superagent_promise" });
  assert.deepEqual(journalPlace("superagent_route", { message: "m" }), { kind: "route", key: "trigger:m", purpose: "superagent_route" });
  assert.equal(journalPlace("superagent_chatter", undefined), undefined);
  assert.equal(journalPlace("superagent_conclude", { chat: "c" }), undefined);
});

test("keeps the runs of the last 14 days and deletes the older ones", () => {
  const days = (count: number) => new Date(now - count * 86_400_000);
  // 15 days old goes, 13 stays, and one exactly at the boundary stays: the prune deletes what is older than the window.
  store.db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?)").run("old", days(15).toISOString(), "chatter", "chat:a", 0, '{"purpose":"p","system":"","user":""}');
  store.db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?)").run("edge", days(14).toISOString(), "chatter", "chat:b", 0, '{"purpose":"p","system":"","user":""}');
  store.db.prepare("INSERT INTO journal VALUES (?,?,?,?,?,?)").run("new", days(13).toISOString(), "chatter", "chat:c", 0, '{"purpose":"p","system":"","user":""}');
  assert.equal(journal.prune(JOURNAL_DAYS), 1);
  assert.deepEqual(store.db.prepare("SELECT id FROM journal ORDER BY id").all().map((row) => String(row.id)), ["edge", "new"]);
});
