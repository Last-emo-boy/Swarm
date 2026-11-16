/** The card diff: an exact match by hash, an approximate one named by section, and the chatter clock sweep. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CASE_VERSION, type ReplayCase } from "./case.js";
import { cardDiff, sweepNow } from "./diff.js";
import { cardHashes } from "./hash.js";
import { runCase, type ModelPort, type RunRecord } from "./run.js";
import { AT, scene } from "./_testing.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "swarm-replay-diff-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const scripted = (answer: string): ModelPort => async () => answer;

/** A case whose recorded card is whatever `run` made: the exact shape a real export records. */
const caseOf = (run: RunRecord, overrides: Partial<ReplayCase> = {}): ReplayCase => ({ version: CASE_VERSION, id: "f04-chatter-carbon", purpose: "chatter",
  finding: "F04", scene: scene(),
  recorded: { card: { systemHash: run.call!.systemHash, userHash: run.call!.userHash, ...(run.call!.sectionHashes ? { sectionHashes: run.call!.sectionHashes } : {}) },
    callAt: AT, durationMs: 1200, model: "deepseek-flash", provider: "deepseek", outcome: run.outcome },
  expect: { kind: "said", rubric: "No invented result.", checks: ["no-tool-invention"] }, ...overrides });

const once = async (kase: ReplayCase, answer = JSON.stringify({ say: "我这边看不到", reason: "staging" })): Promise<RunRecord> =>
  (await runCase(kase, { complete: scripted(answer), runs: 1 }))[0]!;

test("the card this build sends today is byte-identical to the one it recorded: exact", async () => {
  const run = await once({ version: CASE_VERSION, id: "f04-chatter-carbon", purpose: "chatter", finding: "F04", scene: scene(),
    recorded: { card: { systemHash: "", userHash: "" }, callAt: AT, durationMs: 0, model: "", provider: "", outcome: { kind: "silent" } },
    expect: { kind: "said", rubric: "", checks: [] } });
  const diff = cardDiff(caseOf(run), run);
  assert.deepEqual(diff, { verdict: "exact", system: true, user: true });
});

test("a user hash that differs by one character is approximate, not exact, and names the section", async () => {
  const run = await once({ version: CASE_VERSION, id: "f04-chatter-carbon", purpose: "chatter", finding: "F04", scene: scene(),
    recorded: { card: { systemHash: "", userHash: "" }, callAt: AT, durationMs: 0, model: "", provider: "", outcome: { kind: "silent" } },
    expect: { kind: "said", rubric: "", checks: [] } });
  const kase = caseOf(run);
  // One flipped nibble in the recorded user hash, as a changed card text would move it; the section hash moves with it,
  // as an exported case records both from the same text.
  const flip = (hash: string): string => hash.slice(0, -1) + (hash.endsWith("0") ? "1" : "0");
  const card = { ...kase.recorded.card, userHash: flip(kase.recorded.card.userHash),
    sectionHashes: { ...kase.recorded.card.sectionHashes, task: flip(kase.recorded.card.sectionHashes!.task!) } };
  const diff = cardDiff({ ...kase, recorded: { ...kase.recorded, card } }, run);
  assert.equal(diff?.verdict, "approximate");
  assert.equal(diff?.system, true);
  assert.equal(diff?.user, false);
  // The run's card and the recorded one carry the same sections, and the one that holds the user's card text differs.
  assert.deepEqual(diff?.changedSections, ["task"]);
});

test("a chatter card that moved only in time is found by the sweep, with its offset", async () => {
  // A run at the case's clock; and the same card as a call that started 3000 ms later would send it, which is what
  // production recorded. The only difference is the card's `now`, to the millisecond.
  const run = await once({ version: CASE_VERSION, id: "f04-chatter-carbon", purpose: "chatter", finding: "F04", scene: scene(),
    recorded: { card: { systemHash: "", userHash: "" }, callAt: AT, durationMs: 0, model: "", provider: "", outcome: { kind: "silent" } },
    expect: { kind: "said", rubric: "", checks: [] } });
  const at = Date.parse(AT);
  // The card text at AT, moved to AT+3000 only in its stamp, and hashed: the recorded card is that text.
  const later = run.call!.user.replace(`"now": "${new Date(at).toISOString()}"`, `"now": "${new Date(at + 3000).toISOString()}"`);
  const recorded = cardHashes(run.call!.system, later);
  const kase: ReplayCase = { version: CASE_VERSION, id: "f04-chatter-carbon", purpose: "chatter", finding: "F04", scene: scene(),
    recorded: { card: recorded, callAt: AT, durationMs: 0, model: "", provider: "", outcome: { kind: "silent" } },
    expect: { kind: "said", rubric: "", checks: [] } };
  // The run's own card text at AT, against the later hash: the sweep finds the millisecond it reproduces.
  assert.equal(sweepNow(run.call!.user, at, recorded.userHash), 3000);
  const diff = cardDiff(kase, run);
  assert.equal(diff?.verdict, "approximate");
  assert.equal(diff?.user, false);
  assert.equal(diff?.ms, 3000);
});

test("a run that made no model call has no card to compare", () => {
  const run: RunRecord = { caseId: "f04-chatter-carbon", run: 1, at: AT, durationMs: 1, call: null, answer: null, outcome: { kind: "silent" } };
  assert.equal(cardDiff(caseOf({ ...run, call: { purpose: "superagent_chatter", system: "", user: "", systemHash: "", userHash: "", sectionHashes: {} } }), run), null);
});
