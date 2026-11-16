/**
 * `swarm superagent replay`: export cases from a private store copy, run them against a model, compare the cards they
 * send (no model needed) and grade what they did. Cases, run records and reports live under the superagent state
 * directory, never in a repository.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivate, listCases, loadCase, replayRoot, type ReplayCase } from "./case.js";
import type { CheckResult } from "./checks.js";
import { cardDiff, type CardDiff } from "./diff.js";
import { exportCases, type PrivateAnchors } from "./export.js";
import { gradeRun } from "./grade.js";
import { runCase, saveRuns, type ModelPort, type RunRecord } from "./run.js";

const USAGE = `Usage: swarm superagent replay <command>

Commands:
  export --store <db> --usage <db> --settings <json> [--anchors <json>] [--case F01 ...] [--out <dir>] [--json]
                              Write cases from a private copy of the store and usage databases; the anchors
                              file holds each finding's private lines and rubric (it lives beside the cases)
  run    [--case <id>|all] [--times N] [--model <id>] [--out <dir>] [--json]
                              Run each case N times against the configured model, recording what each did
  diff   [--case <id>|all] [--out <dir>] [--json]
                              Compare the card each case sends today with the recorded one; no model is called
  grade  [--case <id>|all] [--mode card|model|both] [--grader-model <id>] [--out <dir>] [--json]
                              Grade the recorded runs: the card diff, and the model's verdict on better or worse

Cases, run records and reports go to <state>/replay unless --out names another private directory.`;

type Args = { values: Record<string, string>; flags: Set<string>; rest: string[] };

function parse(args: readonly string[]): Args {
  const values: Record<string, string> = {}, flags = new Set<string>(), rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    const name = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) { values[name] = next; index++; } else flags.add(name);
  }
  return { values, flags, rest };
}

/** The cases `--case` names: one, a finding's cases, or all. */
function chosen(root: string, wanted: readonly string[]): string[] {
  const all = listCases(root);
  if (!wanted.length || wanted.includes("all")) return all;
  return all.filter((id) => wanted.some((name) => id === name || id.startsWith(`${name.toLowerCase()}-`) || id.startsWith(`${name.toLowerCase()}.`)));
}

/** A usage error, which exits 2: the command itself is wrong, not a case or a model. */
class UsageError extends Error {}

/** The root, refused when it sits inside a git work tree: an `--out` there is a usage error, not a case failure. */
function privateRoot(root: string): string {
  try { assertPrivate(root); } catch (caught) { throw new UsageError(caught instanceof Error ? caught.message : String(caught)); }
  return root;
}

/**
 * The scripted answers `diff` gives so each call runs to completion without a model: the card is captured before the
 * answer is read, so its content only has to be valid for its purpose.
 */
const DIFF_ANSWERS: Record<string, string> = {
  superagent_chatter: JSON.stringify({ say: null, reason: "diff" }),
  superagent_attend: JSON.stringify({ reply: null, relay: [], ask_back: [], reason: "diff" }),
  superagent_memory: JSON.stringify({ notes: [], reach_out: null }),
  superagent_route: JSON.stringify({ kind: "ignore", reason: "diff" })
};

/** The newest saved run set for a case, or none. */
export function latestRuns(root: string, caseId: string): RunRecord[] {
  const dir = join(root, "runs", caseId);
  if (!existsSync(dir)) return [];
  const stamps = readdirSync(dir).sort();
  const newest = stamps.at(-1);
  if (!newest) return [];
  const files = join(dir, newest, "");
  return readdirSync(files).filter((name) => name.endsWith(".json")).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]))
    .map((name) => JSON.parse(readFileSync(join(files, name), "utf8")) as RunRecord);
}

interface CaseReport {
  id: string;
  verdict: "exact" | "approximate" | "no-call" | "better" | "same" | "worse" | "unknown";
  /** Every saved run's verdict, and the card's, when `grade` read more than one. */
  runs?: { run: number; verdict: string }[];
  system?: boolean; user?: boolean;
  changedSections?: string[];
  ms?: number;
  checks?: CheckResult[];
  why?: string;
  error?: string;
}

export async function runReplayCommand(input: string[]): Promise<void> {
  try {
    const code = await dispatch([...input]);
    if (code) process.exitCode = code;
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = caught instanceof UsageError ? 2 : 1;
  }
}

async function dispatch(input: string[]): Promise<number> {
  const args = [...input];
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "?") { console.log(USAGE); return 0; }
  const { values, flags } = parse(args);
  const json = flags.has("json");
  const root = privateRoot(values.out ?? replayRoot());
  if (command === "export") {
    const missing = (["store", "usage", "settings"] as const).filter((name) => !values[name]);
    if (missing.length) throw new UsageError(`replay export needs ${missing.map((name) => `--${name} <path>`).join(", ")}\n\n${USAGE}`);
    // `--case` names the findings to export (F01, or f04-chatter-carbon), each as its own flag when several are wanted.
    const findings = args.flatMap((arg, index) => arg === "--case" ? [args[index + 1] ?? ""] : []).filter(Boolean)
      .flatMap((name) => /^F\d+$/i.test(name) ? [name.toUpperCase()] : [name.slice(0, name.indexOf("-") === -1 ? name.length : name.indexOf("-")).toUpperCase()]);
    // The anchors file defaults to the one export wrote under the private root: it holds the chats' own lines, so it never
    // lives in the repository either.
    const anchorsPath = values.anchors ?? join(root, "anchors.json");
    const anchors = existsSync(anchorsPath) ? JSON.parse(readFileSync(anchorsPath, "utf8")) as PrivateAnchors : {};
    const result = exportCases({ storePath: values.store!, usagePath: values.usage!, settingsPath: values.settings!, out: root,
      anchors, ...(findings.length ? { findings } : {}) });
    if (json) { console.log(JSON.stringify(result, null, 2)); return 0; }
    for (const id of result.cases) console.log(`wrote ${id}`);
    for (const skip of result.skipped) console.log(`skipped ${skip.finding}: ${skip.why}`);
    console.log(`${result.cases.length} case${result.cases.length === 1 ? "" : "s"} in ${root}/cases, ${result.skipped.length} skipped`);
    return 0;
  }
  if (command === "run") {
    const ids = chosen(root, values.case ? [values.case] : []);
    if (!ids.length) throw new UsageError(`No cases in ${root}/cases: export some first`);
    const times = Number(values.times ?? 3);
    if (!Number.isInteger(times) || times < 1) throw new UsageError("--times takes a whole number of runs, 1 or more");
    // The production port bills and records usage like any call, under a replay purpose, so `swarm usage --by purpose` shows it.
    const complete = await productionPort(values.model);
    const summary: Record<string, number> = {};
    const rows: { id: string; run: number; outcome: string; error?: string }[] = [];
    for (const id of ids) {
      const records = await runCase(loadCase(root, id), { complete, runs: times });
      saveRuns(root, records);
      for (const record of records) {
        // A run that threw is not a silent outcome, and the summary must not count it as one.
        const kind = record.error ? "error" : record.outcome.kind;
        summary[kind] = (summary[kind] ?? 0) + 1;
        rows.push({ id, run: record.run, outcome: record.outcome.kind, ...(record.error ? { error: record.error } : {}) });
      }
      if (!json) console.log(`${id}  ${records.map((record) => record.error ? `error: ${record.error.slice(0, 60)}` : record.outcome.kind).join(", ")}`);
    }
    if (json) { console.log(JSON.stringify({ cases: rows, summary }, null, 2)); return 0; }
    console.log(Object.entries(summary).map(([kind, count]) => `${count} ${kind}`).join(", "));
    return 0;
  }
  if (command === "diff") {
    const ids = chosen(root, values.case ? [values.case] : []);
    if (!ids.length) throw new UsageError(`No cases in ${root}/cases: export some first`);
    const reports: CaseReport[] = [];
    let failed = false;
    for (const id of ids) {
      const kase = loadCase(root, id);
      // One scripted run: the card is what the provider was handed, before any answer is read, so no model is billed.
      const [record] = await runCase(kase, { complete: async (call) => DIFF_ANSWERS[call.purpose] ?? "{}", runs: 1 });
      const diff = record ? cardDiff(kase, record) : null;
      const report: CaseReport = !diff ? { id, verdict: "no-call", ...(record?.error ? { error: record.error } : {}) }
        : { id, verdict: diff.verdict, system: diff.system, user: diff.user, ...(diff.changedSections ? { changedSections: diff.changedSections } : {}), ...(diff.ms !== undefined ? { ms: diff.ms } : {}) };
      if (report.verdict === "no-call") failed = true;
      reports.push(report);
      if (!json) console.log(lineOf(report));
    }
    const summary = countOf(reports);
    if (json) { console.log(JSON.stringify({ cases: reports, summary }, null, 2)); return failed ? 1 : 0; }
    console.log(summaryLine(summary));
    return failed ? 1 : 0;
  }
  if (command === "grade") {
    const ids = chosen(root, values.case ? [values.case] : []);
    if (!ids.length) throw new UsageError(`No cases in ${root}/cases: export some first`);
    const mode = values.mode ?? "both";
    if (!["card", "model", "both"].includes(mode)) throw new UsageError("--mode is card, model or both");
    // The grader is its own call: a run under test is judged by a model that did not produce it.
    const complete = mode === "card" ? undefined : await productionPort(values["grader-model"]);
    const reports: CaseReport[] = [];
    let failed = false;
    for (const id of ids) {
      const kase = loadCase(root, id);
      const runs = latestRuns(root, id);
      if (!runs.length) { failed = true; reports.push({ id, verdict: "unknown", error: "no saved run: run the case first" }); continue; }
      // Every saved run is graded: `run --times N` exists to see variance, and a case that fails in two runs of three
      // must not read clean because the last one happened to pass. The case's verdict is its worst run's.
      const graded = mode === "card" ? [] : await Promise.all(runs.map((record) => gradeRun(kase, record,
        { complete, ...(values["grader-model"] ? { graderModel: values["grader-model"] } : {}) })));
      const gradeable: Record<string, readonly unknown[]> = { card: [], model: graded, both: graded };
      const last = runs.at(-1)!;
      const diff = mode === "model" ? null : cardDiff(kase, last);
      // Each run's own verdict: the model's on it, else the card it sent against the recorded one, which needs no model.
      const perRun = runs.map((record, index) => ({ run: record.run,
        verdict: gradeable[mode]?.length ? graded[index]?.verdict ?? "unknown" : cardDiff(kase, record)?.verdict ?? "no-call" }));
      const verdicts = perRun.map((entry) => entry.verdict);
      const report: CaseReport = {
        id, verdict: worstOf(verdicts),
        ...(runs.length > 1 ? { runs: perRun } : {}),
        ...(diff ? { system: diff.system, user: diff.user, ...(diff.changedSections ? { changedSections: diff.changedSections } : {}), ...(diff.ms !== undefined ? { ms: diff.ms } : {}) } : {}),
        ...(graded.length ? (() => { const worst = graded.reduce((a, b) => VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] ? b : a);
          return { checks: worst.checks, why: worst.why, ...(worst.error ? { error: worst.error } : {}) }; })() : {})
      };
      if (report.verdict === "unknown") failed = true;
      reports.push(report);
      if (!json) console.log(lineOf(report));
    }
    const summary = countOf(reports);
    mkdirSync(join(root, "reports"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "reports", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify({ at: new Date().toISOString(), mode, cases: reports, summary }, null, 2)}\n`, { mode: 0o600 });
    if (json) { console.log(JSON.stringify({ mode, cases: reports, summary }, null, 2)); return failed ? 1 : 0; }
    console.log(summaryLine(summary));
    return failed ? 1 : 0;
  }
  throw new UsageError(`Unknown replay command: ${command}\n\n${USAGE}`);
}

/** The production model port, under a replay purpose so `swarm usage --by purpose` can see what a replay spent. */
async function productionPort(model?: string): Promise<ModelPort> {
  const { providerComplete } = await import("../provider.js");
  const base = await providerComplete();
  return async (input) => base({ ...input, purpose: `superagent_replay_${input.purpose.replace(/^superagent_/, "")}`, ...(model ? { model } : {}) });
}

/** One case's line in the non-JSON output. */
function lineOf(report: CaseReport): string {
  const parts: string[] = [report.verdict];
  if (report.system !== undefined) parts.push(`system=${report.system ? "match" : "differs"}`, `user=${report.user ? "match" : "differs"}`);
  if (report.changedSections?.length) parts.push(`sections: ${report.changedSections.join(",")}`);
  if (report.ms !== undefined) parts.push(`now ${report.ms >= 0 ? "+" : ""}${report.ms} ms`);
  const checks = report.checks ?? [];
  if (checks.length) {
    const failedChecks = checks.filter((check) => !check.pass).map((check) => check.name);
    parts.push(`checks ${checks.length - failedChecks.length}/${checks.length}${failedChecks.length ? ` (failed: ${failedChecks.join(",")})` : ""}`);
  }
  if (report.error) parts.push(report.error.slice(0, 80));
  return `${report.id.padEnd(28)} ${parts.join("  ")}`;
}

/** How bad each verdict is: a case takes its worst run's, so one regressed run is never hidden by a clean one. */
const VERDICT_RANK: Record<string, number> = { better: 0, exact: 0, same: 1, approximate: 1, "no-call": 2, unknown: 2, worse: 3 };
const worstOf = (verdicts: readonly string[]): CaseReport["verdict"] => {
  const worst = verdicts.reduce<string | undefined>((a, b) => a === undefined || VERDICT_RANK[b]! > VERDICT_RANK[a]! ? b : a, undefined);
  return (worst ?? "unknown") as CaseReport["verdict"];
};

function countOf(reports: readonly CaseReport[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const report of reports) summary[report.verdict] = (summary[report.verdict] ?? 0) + 1;
  return summary;
}

function summaryLine(summary: Record<string, number>): string {
  const order = ["exact", "approximate", "no-call", "better", "same", "worse", "unknown"];
  const parts = order.flatMap((kind) => summary[kind] ? [`${summary[kind]} ${kind}`] : []);
  return parts.join(", ") || "nothing to report";
}
