/**
 * A ticket's worker turns on an agent harness (harness.ts) instead of Swarm's coding loop. Each turn is one headless run of
 * the harness in the ticket's directory, with Swarm's ticket tools as its MCP server and Swarm's worker instructions; later
 * turns resume its session, whose id is kept under Swarm's state on the machine that runs the worker. Each turn's token
 * usage goes to Swarm's usage records with the harness and its model.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSwarmPaths, loadSwarmSettings } from "../config/settings.js";
import { SwarmDatabase } from "../storage/database.js";
import { UsageStore } from "../storage/usage-store.js";
import { assertBudget } from "../usage/budget.js";
import { checkHarness, HarnessSetupError, resolveHarness, runTurn, SessionLost, type Harness, type TurnLimits, type TurnOutcome } from "./harness.js";
import { transient, workerSessionId } from "./messages.js";
import { readSettings, settingsPath } from "./settings.js";
import type { WorkLink, WorkStart } from "./work-link.js";
import type { WorkerTurns } from "./worker.js";

const UNREPORTED = "Your turn ended without calling the mcp__ticket__report tool, so nobody knows what happened: your final message is not a report. Call mcp__ticket__report now: state ready with message_for_person if the work is done and verified, progress if you wait for something such as CI or a review (say what), blocked or failed with what stops you, or dropped if there is nothing to do.";

/** What a harness reads after Swarm's worker instructions, which were written for Swarm's own coding loop. */
const harnessSection = (label: string): string => [
  `## Working in ${label}`,
  "",
  `You run in ${label} as this ticket's worker. Swarm's ticket host starts you for one turn at a time and resumes this session when the ticket has news.`,
  "Swarm's ticket tools are the MCP server `ticket`: mcp__ticket__read, mcp__ticket__ack, mcp__ticket__report, mcp__ticket__handback, mcp__ticket__thread_follow and mcp__ticket__thread_unrelated.",
  `Where the sections above mention tool_calls or a final JSON, call the tools as ${label} calls tools. Your final message is not a report and reaches nobody: end every turn with mcp__ticket__report.`,
  "Nobody can answer a permission prompt: an action that is denied stays denied, so choose another way, or report blocked with human_action naming what it needs.",
  "Commit only what you changed for this ticket: stage those files by path, never with `git add -A` or `git add .`, and leave files you did not make, such as a tool's untracked state directory, out of every commit and where they are.",
  "Commits and pull requests carry no attribution to an agent, model or harness: no Co-Authored-By trailer and no \"Generated with\" line."
].join("\n");

interface Saved { harness: string; session: string; directory: string; at: string }
const savedPath = (ticketId: string): string => join(getSwarmPaths().stateDir, "harness-sessions", `${ticketId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/** The harness session this ticket's worker resumes here, when the same harness ran it in the same directory. */
function readSaved(ticketId: string, harness: string, directory: string): string | undefined {
  try {
    const saved = JSON.parse(readFileSync(savedPath(ticketId), "utf8")) as Partial<Saved>;
    return saved.harness === harness && saved.directory === directory && typeof saved.session === "string" ? saved.session : undefined;
  } catch { return undefined; }
}
function writeSaved(ticketId: string, saved: Saved): void {
  const path = savedPath(ticketId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Writes a turn's usage as Swarm's provider calls write theirs: one count row and its token rows, with the harness and model. */
function recordUsage(directory: string, sessionId: string, ticketId: string, harness: Harness, outcome: TurnOutcome): void {
  const usage = outcome.usage;
  if (!usage) return;
  const anthropic = harness.kind.protocol === "anthropic-messages";
  const total = anthropic ? usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens : usage.inputTokens;
  const metadata = {
    providerId: `harness:${harness.id}`, protocol: harness.kind.protocol, model: outcome.model ?? harness.model ?? "unknown",
    purpose: "superagent_worker", sessionId, ticketId, harness: harness.id, harnessKind: harness.kind.program,
    ...(outcome.session ? { harnessSession: outcome.session } : {}), status: outcome.status, durationMs: outcome.durationMs,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens, totalInputWithCacheTokens: total,
    uncachedInputTokens: Math.max(0, total - usage.cachedInputTokens),
    ...(usage.reasoningOutputTokens ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.costUsd !== undefined ? { reportedCostUsd: usage.costUsd } : {}),
    ...(usage.partial ? { usagePartial: true } : {})
  };
  const database = new SwarmDatabase(loadSwarmSettings(directory).runtime.databasePath);
  try {
    const store = new UsageStore(database);
    store.append({ session_id: sessionId, kind: "llm_call", amount: 1, unit: "count", metadata: { ...metadata, event: "harness_turn" } });
    for (const [name, amount] of [["input", usage.inputTokens], ["output", usage.outputTokens], ["cached_input", usage.cachedInputTokens],
      ["cache_creation_input", usage.cacheCreationInputTokens]] as const) {
      if (amount > 0) store.append({ session_id: sessionId, kind: "llm_call", amount, unit: "tokens", metadata: { ...metadata, token_type: name } });
    }
  } finally {
    database.close();
  }
}

export interface HarnessTurnsInput {
  ticketId: string;
  link: WorkLink;
  start: WorkStart;
  /** How to start the ticket tools' MCP server: the Node binary and the Swarm entry point. */
  entry: readonly string[];
  /** The harness profile the ticket's execution names. */
  harness: string;
  limits: TurnLimits;
}

/**
 * A worker's turns on the ticket's harness, resolved with this machine's settings and checked to be installed and signed
 * in; a harness that cannot run here gives the failure the ticket reports.
 */
export async function harnessTurns(input: HarnessTurnsInput): Promise<WorkerTurns | { failure: string }> {
  const { ticketId, link, start } = input;
  const where = settingsPath();
  let harness: Harness;
  try {
    harness = resolveHarness(input.harness, readSettings(where).settings.executor.harnesses, where);
    await checkHarness(harness);
  } catch (error) {
    if (error instanceof HarnessSetupError) return { failure: error.message };
    throw error;
  }
  const { directory } = start;
  const sessionId = workerSessionId(ticketId);
  const [node, ...entry] = input.entry;
  const tools = { command: node!, args: [...entry, ...link.tools.args], env: link.tools.env };
  const request = {
    directory, instructions: `${start.prompt}\n\n${harnessSection(harness.kind.label)}`, tools,
    permission: process.env.SWARM_PERMISSION_MODE === "yolo" ? "yolo" as const : "full-auto" as const,
    blockedCommands: start.blockedCommands,
    variables: Object.keys(harness.env).filter((name) => harness.env[name] !== undefined)
  };
  let session = readSaved(ticketId, harness.id, directory);
  const abort = new AbortController();
  return {
    fresh: !session,
    run: async (prompt) => {
      // A harness's turns stop at its budget (usage.budgets.harnesses), as model calls stop at their provider's.
      assertBudget({ harness: harness.id }, directory);
      const outcome = await runTurn(harness, { ...request, ...(session ? { session } : {}) }, prompt, input.limits, abort.signal);
      try { recordUsage(directory, sessionId, ticketId, harness, outcome); }
      catch (error) { process.stderr.write(`superagent: could not record the harness turn's usage: ${String(error)}\n`); }
      if (outcome.lost) {
        const gone = session;
        session = undefined;
        rmSync(savedPath(ticketId), { force: true });
        throw new SessionLost(`${harness.kind.label} no longer has session ${gone}`);
      }
      if (outcome.session && outcome.session !== session) {
        session = outcome.session;
        writeSaved(ticketId, { harness: harness.id, session, directory, at: new Date().toISOString() });
      }
      const label = harness.kind.label;
      if (outcome.toolsDown) return { failed: true, words: `The ticket tools' MCP server did not connect in ${label} (${outcome.toolsDown}).` };
      if (outcome.status === "completed") return { failed: false, words: outcome.text.slice(0, 4000) };
      const why = `${label}: ${outcome.error ?? "the turn failed"}`;
      if (!abort.signal.aborted && transient(new Error(why))) throw new Error(why);
      return { failed: true, words: why.slice(0, 4000) };
    },
    settle: async () => [],
    unreported: UNREPORTED,
    stop: () => abort.abort(),
    dispose: () => {}
  };
}
