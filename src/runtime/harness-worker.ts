/**
 * A delegated subagent on an agent harness (superagent/harness.ts) instead of Swarm's coding loop. It runs one headless turn
 * of the harness in the delegating session's workspace: the agent spec's role and output contract as its instructions, the
 * task packet as its prompt, the spec's write policy kept as far as the harness's own flags allow (a read-only spec runs in
 * the harness's read-only mode, and does not start where none can be kept), and the spec's tool budget as the turn's
 * limits. Its result is the WorkSessionOutcome Swarm's workers return: the harness's final words as the summary, with what
 * the harness could not be held to, and the files it changed from git status and HEAD before and after the turn.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { RiskClass } from "../protocol/types.js";
import { harnessUsageRows, HarnessSetupError, readOnlyProblem, resolveHarness, runTurn, type Harness, type HarnessPermission, type HarnessProfile } from "../superagent/harness.js";
import { readSettings, settingsPath } from "../superagent/settings.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import type { AgentSpec } from "./agent-specs.js";
import type { ExecutionResult } from "./orchestrator.js";

const git = promisify(execFile);
const STOP_POLL_MS = 1000;
const SUMMARY_CHARS = 4000;

export interface HarnessWorkerOptions {
  /** The harness profile the subagent runs on. */
  harness: string;
  workspace: string;
  spec: Pick<AgentSpec, "id" | "name" | "write_policy">;
  /** The spec's role, output contract and file scope, as Swarm's own workers read them. */
  instructions: string;
  objective: string;
  fileScope: readonly string[];
  budget: AgentSpec["default_budget"];
  /** The delegating session's permission mode: in ask and auto-edit, a subagent that writes needs approval to start. */
  permissionMode: string;
  approve(request: ToolApprovalRequest): Promise<boolean>;
  /** Whether the main Swarm asked the worker to stop. */
  stopped(): boolean;
  onSessionStart(sessionId: string, objective: string): void;
  recordUsage(sessionId: string, rows: ReturnType<typeof harnessUsageRows>): void;
  /** The harness profiles and the file they come from; the superagent settings' by default. */
  profiles?: { configured: Readonly<Record<string, HarnessProfile>>; where: string };
}

/** What a harness subagent reads after the spec's instructions, which were written for Swarm's own coding loop. */
const harnessSection = (harness: Harness, readOnly: boolean): string => [
  `## Working in ${harness.kind.label}`,
  "",
  `You run in ${harness.kind.label} as a subagent of Swarm for one turn: the main Swarm gave you the task packet in the prompt and reads only your final message.`,
  "Where the task packet names Swarm's tools (allowed_tools), they say what you may do: do it with your own tools.",
  readOnly ? "You only read: do not change files." : "Change only what the task needs. Do not commit, push or open pull requests: the main Swarm reviews your changes.",
  "End with a final message that is your whole result for the main Swarm, following the expected output above."
].join("\n");

/** A workspace's git state: HEAD, and each changed or untracked file with its status and a hash of its content. */
interface GitState { root: string; head?: string; files: Map<string, string> }

async function gitState(workspace: string): Promise<GitState | undefined> {
  const run = (args: string[]) => git("git", args, { cwd: workspace, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout);
  let root: string;
  try { root = (await run(["rev-parse", "--show-toplevel"])).trim(); } catch { return undefined; }
  const head = await run(["rev-parse", "--verify", "-q", "HEAD"]).then((stdout) => stdout.trim() || undefined, () => undefined);
  const entries = (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
  const files = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename's source path follows it.
    if (status.includes("R") || status.includes("C")) index += 1;
    let content = "gone";
    try { content = createHash("sha1").update(readFileSync(join(root, path))).digest("hex"); } catch { /* Deleted, or a directory. */ }
    files.set(path, `${status} ${content}`);
  }
  return { root, ...(head ? { head } : {}), files };
}

/** The files a turn changed, relative to the workspace: in the working tree, and in commits it made. */
async function changedFiles(workspace: string, before: GitState | undefined): Promise<string[]> {
  if (!before) return [];
  const after = await gitState(workspace);
  if (!after) return [];
  const changed = new Set<string>();
  for (const [path, state] of after.files) if (before.files.get(path) !== state) changed.add(path);
  for (const path of before.files.keys()) if (!after.files.has(path)) changed.add(path);
  if (before.head && after.head && before.head !== after.head) {
    const { stdout } = await git("git", ["diff", "--name-only", "-z", before.head, after.head], { cwd: workspace, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
      .catch(() => ({ stdout: "" }));
    for (const path of stdout.split("\0").filter(Boolean)) changed.add(path);
  }
  const base = realpathSync(workspace);
  return [...changed].map((path) => relative(base, join(after.root, path)) || ".").sort();
}

/** Whether a path the harness changed lies inside one of the spec's file scope entries (paths or directories). */
const inScope = (path: string, scope: readonly string[]): boolean =>
  scope.some((entry) => {
    const clean = entry.replace(/^\.\//, "").replace(/\/+$/, "").replace(/\/\*\*?$/, "");
    return clean === "" || clean === "." || path === clean || path.startsWith(`${clean}/`);
  });

export function harnessWorker(options: HarnessWorkerOptions): { run(prompt: string): Promise<ExecutionResult> } {
  return {
    async run(prompt) {
      const sessionId = `worker_loop_${randomUUID()}`;
      options.onSessionStart(sessionId, options.objective);
      const failed = (content: string): ExecutionResult => ({
        session_id: sessionId, content, status: "failed",
        outcome: { changed_files: [], intermediate_artifacts: [], tests_run: [], final_summary: content }
      });
      const { configured, where } = options.profiles ?? (() => {
        const file = settingsPath();
        return { configured: readSettings(file).settings.executor.harnesses, where: file };
      })();
      let harness: Harness;
      try {
        harness = resolveHarness(options.harness, configured, where);
      } catch (error) {
        if (error instanceof HarnessSetupError) return failed(`${options.spec.name} cannot run on ${options.harness}: ${error.message}`);
        throw error;
      }
      const { label } = harness.kind;
      const readOnly = options.spec.write_policy === "read_only";
      if (readOnly) {
        const problem = readOnlyProblem(harness);
        if (problem) return failed(`${options.spec.name} only reads, and cannot start on ${harness.id} (${label}): ${problem}`);
      }
      const yolo = options.permissionMode === "yolo";
      if (!readOnly && (options.permissionMode === "ask" || options.permissionMode === "auto-edit")) {
        const approved = await options.approve({
          id: `harness_worker_${randomUUID()}`, session_id: sessionId, action: "agent.delegate",
          summary: `Run ${options.spec.name} on ${label} (${harness.id})`,
          detail: `${label} edits files and runs commands in ${options.workspace} in its own auto mode, without asking Swarm for each.`,
          risk: "delegate", risk_class: "r2" satisfies RiskClass, target: options.workspace,
          why_now: options.objective, predicted_impact: `File changes in ${options.workspace}${options.fileScope.length ? ` meant for ${options.fileScope.join(", ")}` : ""}.`,
          rollback_plan: "Review the changed files the worker reports, and revert them with git."
        });
        if (!approved) return failed(`${options.spec.name} on ${label} was not approved to start: it would edit files and run commands without asking.`);
      }
      const permission: HarnessPermission = readOnly ? "read-only" : yolo ? "yolo" : "full-auto";
      const enforced = readOnly ? harness.kind.readOnly!
        : `${label} runs in its ${yolo ? "unrestricted" : "own auto"} mode and is not confined to the workspace${options.fileScope.length ? " or the file scope" : ""}.`;
      const before = readOnly ? undefined : await gitState(options.workspace).catch(() => undefined);
      const abort = new AbortController();
      const poll = setInterval(() => { if (options.stopped()) abort.abort(); }, STOP_POLL_MS);
      let outcome;
      try {
        outcome = await runTurn(harness, {
          directory: options.workspace, instructions: `${options.instructions}\n\n${harnessSection(harness, readOnly)}`, permission,
          blockedCommands: [], variables: Object.keys(harness.env).filter((name) => harness.env[name] !== undefined)
        }, prompt, { steps: options.budget.max_turns + options.budget.max_tool_calls, toolCalls: options.budget.max_tool_calls }, abort.signal);
      } finally {
        clearInterval(poll);
      }
      try { options.recordUsage(sessionId, harnessUsageRows(harness, outcome, { purpose: "agent_worker", sessionId, agentSpecId: options.spec.id })); }
      catch (error) { process.stderr.write(`swarm: could not record the harness worker's usage: ${String(error)}\n`); }
      const changed = await changedFiles(options.workspace, before).catch(() => []);
      const outside = options.fileScope.length ? changed.filter((path) => !inScope(path, options.fileScope)) : [];
      const words = outcome.status === "completed" ? outcome.text.trim() : `${label}: ${outcome.error ?? "the turn failed"}`;
      const summary = [
        words.slice(0, SUMMARY_CHARS),
        "",
        `Ran on ${label} (${harness.id}${outcome.model ? `, ${outcome.model}` : ""}), ${options.spec.write_policy}: ${enforced}`,
        ...(outside.length ? [`Changed outside its file scope: ${outside.join(", ")}.`] : [])
      ].join("\n");
      return {
        session_id: sessionId, content: summary,
        status: abort.signal.aborted ? "stopped" : outcome.status === "completed" ? "completed" : "failed",
        outcome: { changed_files: changed, intermediate_artifacts: [], tests_run: [], final_summary: summary }
      };
    }
  };
}
