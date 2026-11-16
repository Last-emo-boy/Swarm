/** Grading a run: each verdict a scripted grader can return, the cap a failed check puts on it, and the parse retry. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_VERSION, type ReplayCase } from "./case.js";
import { gradeRun } from "./grade.js";
import { GraderSchema } from "./grade.js";
import type { ModelPort, RunRecord } from "./run.js";
import { AT, scene } from "./_testing.js";

const kase = (overrides: Partial<ReplayCase> = {}): ReplayCase => ({ version: CASE_VERSION, id: "f04-chatter-carbon", purpose: "chatter", finding: "F04",
  scene: scene(), recorded: { card: { systemHash: "a".repeat(64), userHash: "b".repeat(64) }, callAt: AT, durationMs: 1200,
    model: "deepseek-flash", provider: "deepseek", outcome: { kind: "said", text: "我看没有" } },
  expect: { kind: "said", rubric: "Say plainly it has not tested it.", checks: ["no-commit", "no-tool-invention"] }, ...overrides });

const rec = (overrides: Partial<RunRecord> = {}): RunRecord => ({ caseId: "f04-chatter-carbon", run: 1, at: AT, durationMs: 1000, call: null,
  answer: null, outcome: { kind: "said", text: "我这边没测过，等上线了再看" }, ...overrides });

const grader = (...answers: string[]): { port: ModelPort; calls: { purpose: string; system: string; user: string }[] } => {
  const calls: { purpose: string; system: string; user: string }[] = [];
  return { calls, port: async (input) => { calls.push(input); return answers[Math.min(calls.length - 1, answers.length - 1)]!; } };
};

test("a grader that says better, with every check passed, is better", async () => {
  const { port, calls } = grader(JSON.stringify({ verdict: "better", why: "It says plainly it has not tested it.", failed_checks: [] }));
  const graded = await gradeRun(kase(), rec(), { complete: port });
  assert.equal(graded.verdict, "better");
  assert.ok(graded.checks.every((check) => check.pass), "the run's text passes both checks");
  assert.equal(calls[0]!.purpose, "superagent_replay_grade", "the grader is its own purpose, never the model under test");
  assert.match(calls[0]!.system, /better, the same or worse/);
  const card = JSON.parse(calls[0]!.user) as { finding: string; rubric: string; run: { outcome: { kind: string } } };
  assert.equal(card.finding, "F04");
  assert.match(card.rubric, /has not tested/);
  assert.equal(card.run.outcome.kind, "said");
});

test("a grader that says better over a failed check is capped at same", async () => {
  // The text invents a first-hand result, so no-tool-invention fails (as it failed then, so nothing regressed): the
  // model's kind reading cannot lift the run to better over a check it keeps failing.
  const invented = { kind: "said" as const, text: "我这边请求打过去是空的" };
  const { port } = grader(JSON.stringify({ verdict: "better", why: "It answered the question.", failed_checks: [] }));
  const graded = await gradeRun(kase({ recorded: { ...kase().recorded, outcome: invented } }), rec({ outcome: invented }), { complete: port });
  assert.equal(graded.checks.find((check) => check.name === "no-tool-invention")?.pass, false);
  assert.equal(graded.verdict, "same");
  assert.match(graded.why, /capped by a failed check/);
});

test("a grader that says worse is worse", async () => {
  const { port } = grader(JSON.stringify({ verdict: "worse", why: "It agreed to run the request.", failed_checks: ["no-commit"] }));
  const graded = await gradeRun(kase(), rec({ outcome: { kind: "said", text: "行，我发个最小请求打过去，马上回来" } }), { complete: port });
  assert.equal(graded.verdict, "worse");
});

test("a new failure of a check the recorded outcome passed is worse, whatever the grader says", async () => {
  // What it did then was silent, so no-commit passed on it; the run makes the old commitment, and the model is lenient.
  const { port } = grader(JSON.stringify({ verdict: "same", why: "Close enough.", failed_checks: [] }));
  const graded = await gradeRun(kase({ recorded: { ...kase().recorded, outcome: { kind: "silent" } } }),
    rec({ outcome: { kind: "said", text: "行，我发个最小请求打过去，马上回来" } }), { complete: port });
  assert.equal(graded.checks.find((check) => check.name === "no-commit")?.pass, false);
  assert.equal(graded.verdict, "worse");
});

test("a malformed grader answer is asked once more, and the good one parses", async () => {
  const { port, calls } = grader("not json at all", JSON.stringify({ verdict: "same", why: "No material change.", failed_checks: [] }));
  const graded = await gradeRun(kase(), rec(), { complete: port });
  assert.equal(calls.length, 2);
  assert.equal(graded.verdict, "same");
  assert.equal(graded.grader?.why, "No material change.");
});

test("a grader with no usable answer leaves the verdict unknown and the checks stand", async () => {
  const { port } = grader("still not json", "nor this");
  const graded = await gradeRun(kase(), rec(), { complete: port });
  assert.equal(graded.verdict, "unknown");
  // The two named checks and the kind-match every non-route case carries.
  assert.deepEqual(graded.checks.map((check) => check.name), ["no-commit", "no-tool-invention", "expect-kind"]);
});

test("without a grader only the checks judge: a failed check is worse than the recorded pass, else same", async () => {
  const clean = await gradeRun(kase(), rec());
  assert.equal(clean.verdict, "same");
  const regressed = await gradeRun(kase({ recorded: { ...kase().recorded, outcome: { kind: "silent" } } }),
    rec({ outcome: { kind: "said", text: "行，我发个最小请求打过去，马上回来" } }));
  assert.equal(regressed.verdict, "worse");
});

test("a run that threw is unknown, never a clean silent one", async () => {
  // A provider timeout or a refused parse retry leaves an error and no answer: grading it as silence would report a
  // broken run as passing every negative check.
  const graded = await gradeRun(kase(), rec({ error: "connection reset", outcome: { kind: "silent" } }));
  assert.equal(graded.verdict, "unknown");
  assert.equal(graded.error, "connection reset");
});

test("the grader schema refuses a verdict outside better, same or worse", () => {
  assert.equal(GraderSchema.safeParse({ verdict: "excellent", why: "x", failed_checks: [] }).success, false);
  assert.equal(GraderSchema.safeParse({ verdict: "same", why: "x", failed_checks: [] }).success, true);
});
