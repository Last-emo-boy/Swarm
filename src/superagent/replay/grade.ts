/**
 * Model-graded mode: one grader call per run, never the model under test. The grader reads the finding's rubric, the
 * scene, what the agent did then and what the run did now, with the deterministic checks already run, and says whether the
 * run behaved better, the same or worse. A failed check caps its verdict: a run that repeats a checked failure is not
 * "better", whatever the model thinks; one that breaks a check the recorded outcome passed is "worse".
 */
import { z } from "zod/v4";
import { answerOf } from "../text.js";
import { gradePrompt } from "../prompts.js";
import type { ReplayCase } from "./case.js";
import { runChecks, type CheckResult } from "./checks.js";
import type { ModelPort, RunRecord } from "./run.js";

export const GraderSchema = z.object({
  verdict: z.enum(["better", "same", "worse"]),
  why: z.string().max(500),
  failed_checks: z.array(z.string())
});
export type Grader = z.infer<typeof GraderSchema>;

/** What grading one run came out as: the deterministic checks, the model's verdict, and why after capping. */
export interface Graded {
  checks: CheckResult[];
  grader?: Grader;
  verdict: "better" | "same" | "worse" | "unknown";
  why: string;
  error?: string;
}

/** The record a case's own outcome makes, so the checks can pass judgement on what it did then. */
const recordedRun = (kase: ReplayCase): RunRecord => ({
  caseId: kase.id, run: 0, at: kase.recorded.callAt, durationMs: kase.recorded.durationMs,
  call: null, answer: kase.recorded.answer ?? null, outcome: kase.recorded.outcome
});

/**
 * Grades one run against its case: the checks first, then (when given a model port) the grader, whose answer is capped by
 * the checks. A grader that cannot answer leaves the verdict unknown; the deterministic checks still stand.
 */
export async function gradeRun(kase: ReplayCase, rec: RunRecord, options: { complete?: ModelPort; graderModel?: string } = {}): Promise<Graded> {
  // A run that threw (a provider timeout, a refused parse retry) produced nothing to judge: grading it as silence would
  // read a broken run as a clean one, so it is unknown and says why.
  if (rec.error) return { checks: runChecks(kase, rec), verdict: "unknown", why: "the run failed before it could answer", error: rec.error };
  const checks = runChecks(kase, rec);
  const then = runChecks(kase, recordedRun(kase));
  const regressed = checks.filter((check) => !check.pass && then.find((was) => was.name === check.name)?.pass === true);
  if (!options.complete) {
    return { checks, verdict: regressed.length ? "worse" : "same", why: regressed.length ? "newly fails a check the recorded outcome passed" : "checks only" };
  }
  const user = JSON.stringify({
    finding: kase.finding, rubric: kase.expect.rubric,
    scene: { messages: kase.scene.messages.map((message) => ({ from: message.senderName, ...(message.human ? {} : { bot: true }), at: message.at, text: message.text })),
      own: kase.scene.own },
    recorded: kase.recorded.outcome, run: { outcome: rec.outcome, answer: rec.answer },
    checks: checks.map((check) => ({ name: check.name, ...(check.pass ? {} : { failed: check.why }) }))
  });
  let grader: Grader | undefined;
  try {
    grader = await answerOf(GraderSchema, () => options.complete!({ purpose: "superagent_replay_grade", system: gradePrompt(), user,
      ...(options.graderModel ? { model: options.graderModel } : {}) }), 2);
  } catch (caught) {
    return { checks, verdict: "unknown", why: "the grader call failed", error: caught instanceof Error ? caught.message : String(caught) };
  }
  if (!grader) return { checks, verdict: "unknown", why: "the grader gave no usable answer" };
  // The checks own the load-bearing part: a run that repeats a checked failure is not better, and one that newly breaks a
  // check the recorded outcome passed is worse even if the model reads its words kindly.
  const verdict = regressed.length ? "worse" : grader.verdict === "better" && checks.some((check) => !check.pass) ? "same" : grader.verdict;
  return { checks, grader, verdict, why: verdict === grader.verdict ? grader.why : `${grader.why} (capped by a failed check)` };
}
