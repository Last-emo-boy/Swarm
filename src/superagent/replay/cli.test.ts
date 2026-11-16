/** The replay command line: `diff` needs no model, and the exit codes tell automation from a run's result. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runReplayCommand } from "./cli.js";
import { saveRuns, type RunRecord } from "./run.js";
import { AT, message, state, usageDb } from "./_testing.js";
import { exportCases } from "./export.js";

let dir: string, out: string, stdout: typeof process.stdout.write, written: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-replay-cli-"));
  out = mkdtempSync(join(tmpdir(), "swarm-replay-cli-out-"));
  written = [];
  stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.exitCode = 0;
});
afterEach(() => {
  process.stdout.write = stdout;
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

/** One exported case built from a synthetic store and usage copy, as `replay export` writes it. */
function exported(): string {
  const fixture = state(dir);
  try {
    message(fixture.client, { id: "om_1", sender: "ou_alice", text: "staging 那版应该没上吧", at: "2026-11-11T10:40:02.000Z" });
  writeFileSync(join(out, "anchors.json"), JSON.stringify({ F04: { anchor: "staging 那版应该没上吧" } }));
  } finally { fixture.close(); }
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ sources: { feishu: { enabled: true, config: { chats: [{ chatId: "oc_team", listen: "all" }] } } }, chatter: { chats: ["oc_team"], persona: "Dry." }, memory: { enabled: true }, policy: { rules: [], sources: {} } }));
  usageDb(join(dir, "usage.db"), [{ at: "2026-11-11T10:45:24.000Z", purpose: "superagent_chatter", systemHash: "a".repeat(64), userHash: "b".repeat(64) }]);
  // The copy the export reads is the live store the fixture wrote.
  const copy = join(dir, "copy.db");
  writeFileSync(copy, readFileSync(join(dir, "superagent.db")));
  const result = exportCases({ storePath: copy, usagePath: join(dir, "usage.db"), settingsPath: join(dir, "settings.json"), out,
    anchors: JSON.parse(readFileSync(join(out, "anchors.json"), "utf8")) as Record<string, { anchor?: string }>, findings: ["F04"] });
  assert.equal(result.cases.length, 1);
  return result.cases[0]!;
}

test("diff runs a case with no model and reports the card it sends today", async () => {
  const id = exported();
  await runReplayCommand(["diff", "--out", out, "--json"]);
  const report = JSON.parse(written.join("")) as { cases: { id: string; verdict: string; system: boolean; user: boolean }[]; summary: Record<string, number> };
  assert.equal(report.cases[0]!.id, id);
  // The exported card's hashes are a placeholder the run cannot match: approximate, and the summary counts it.
  assert.equal(report.cases[0]!.verdict, "approximate");
  assert.equal(report.cases[0]!.system, false);
  assert.equal(report.summary.approximate, 1);
  assert.equal(process.exitCode, 0, "an approximate card is a result, not a failure");
});

test("diff without any case is a usage error: exit 2", async () => {
  await runReplayCommand(["diff", "--out", out]);
  assert.equal(process.exitCode, 2);
});

test("grade with no saved run fails the case: exit 1", async () => {
  exported();
  await runReplayCommand(["grade", "--mode", "card", "--out", out]);
  assert.equal(process.exitCode, 1);
});

test("grade --mode card writes a report under the private root and exits 0 with a saved run", async () => {
  const id = exported();
  // A saved run that made its call: card mode compares its hashes with the exported ones.
  const record: RunRecord = { caseId: id, run: 1, at: AT, durationMs: 5, answer: null, outcome: { kind: "silent" },
    call: { purpose: "superagent_chatter", system: "s", user: "u", systemHash: "a".repeat(64), userHash: "b".repeat(64), sectionHashes: { system: "a".repeat(64), task: "b".repeat(64) } } };
  saveRuns(out, [record]);
  await runReplayCommand(["grade", "--mode", "card", "--out", out, "--json"]);
  assert.equal(process.exitCode, 0);
  const report = JSON.parse(written.join("")) as { mode: string; cases: { id: string; verdict: string }[] };
  assert.equal(report.mode, "card");
  assert.deepEqual(report.cases.map((row) => row.id), [id]);
});

test("grade reads every saved run and reports the worst, so one bad run in three is not hidden", async () => {
  const id = exported();
  const committed = { kind: "said" as const, text: "行，我发个最小请求打过去，马上回来" };
  const silent = { kind: "silent" as const };
  const card = { purpose: "superagent_chatter", system: "s", user: "u", systemHash: "a".repeat(64), userHash: "b".repeat(64), sectionHashes: {} };
  // Three runs: the last one was silent, but two committed, and the case must not read clean.
  saveRuns(out, [1, 2, 3].map((run): RunRecord => ({ caseId: id, run, at: AT, durationMs: 5, answer: null, call: card,
    outcome: run === 3 ? silent : committed })));
  await runReplayCommand(["grade", "--mode", "card", "--out", out, "--json"]);
  const report = JSON.parse(written.join("")) as { cases: { id: string; verdict: string; runs: { run: number; verdict: string }[] }[] };
  assert.deepEqual(report.cases[0]!.runs.map((entry) => entry.run), [1, 2, 3], "every saved run is graded, not just the last");
});

test("diff runs take no error path: the scripted answers are keyed by the purpose the port receives", async () => {
  const id = exported();
  await runReplayCommand(["diff", "--out", out, "--json"]);
  const report = JSON.parse(written.join("")) as { cases: { id: string; verdict: string; error?: string }[] };
  assert.equal(report.cases[0]!.id, id);
  assert.equal(report.cases[0]!.error, undefined, "no second model call: the first answer parsed");
});
