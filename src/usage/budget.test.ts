import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultSwarmConfig, defaultSwarmSettings, loadSwarmSettings, type UsageSettings } from "../config/settings.js";
import { SwarmDatabase } from "../storage/database.js";
import { UsageStore } from "../storage/usage-store.js";
import { reachedBudgetNotices } from "../tui/usage-view.js";
import { BudgetReached, budgetStatus } from "./budget.js";
import { openUsageDatabase } from "./ledger.js";

const root = mkdtempSync(join(tmpdir(), "swarm-usage-budget-"));
const home = join(root, "home");
const databasePath = join(home, "state", "swarm.db");
const saved = { SWARM_HOME: process.env.SWARM_HOME, SWARM_SUPERAGENT_HOME: process.env.SWARM_SUPERAGENT_HOME, CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH };
const requests: unknown[] = [];
let server: Server;

/** Writes the Swarm settings: the DeepSeek provider at the fake server, its test model priced at $1 per million tokens, and `usage`. */
function writeSettings(budgets: UsageSettings["budgets"]): void {
  const settings = defaultSwarmSettings();
  const { port } = server.address() as AddressInfo;
  settings.models.defaultProvider = "deepseek";
  settings.models.planner = settings.models.worker = settings.models.aggregator = "deepseek/test-chat";
  settings.providers.deepseek!.baseURL = `http://127.0.0.1:${port}`;
  settings.providers.deepseek!.models = { "test-chat": { name: "Test Chat" } };
  settings.runtime.databasePath = databasePath;
  settings.usage = { prices: { "deepseek/test-chat": { input: 1, output: 1, currency: "USD" } }, budgets };
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings, null, 2));
}

/** One recorded call or turn today under `providerId`, of 20K input tokens: $0.02 at the test model's price. */
function recordCall(providerId: string, extra: Record<string, unknown> = {}): void {
  const database = new SwarmDatabase(databasePath);
  new UsageStore(database).append({ kind: "llm_call", amount: 1, unit: "count", metadata: { providerId, protocol: "openai-chat-completions",
    model: "test-chat", purpose: "main_coding_loop", inputTokens: 20_000, outputTokens: 0, totalInputWithCacheTokens: 20_000, ...extra } });
  database.close();
}

before(async () => {
  mkdirSync(join(home, "state"), { recursive: true });
  process.env.SWARM_HOME = home;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      requests.push(JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 0, model: "test-chat",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = defaultSwarmConfig();
  config.providerApiKeys.deepseek = "test-key";
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  recordCall("deepseek");
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a provider whose daily budget is reached takes no new calls until the cap is raised", async () => {
  writeSettings({ providers: { deepseek: { daily: 0.01, currency: "USD" } }, harnesses: {} });
  const { OpenAIProvider } = await import("../providers/openai-provider.js");
  const provider = new OpenAIProvider({ workspace: root });
  const call = () => provider.generateText({ model: "deepseek/test-chat", system: "s", user: "u", usage: { purpose: "budget_test" } });
  const error = await call().then(() => undefined, (reason: unknown) => reason);
  assert.ok(error instanceof BudgetReached, `refused with ${String(error)}`);
  assert.match(error.message, /^The daily budget for provider deepseek is reached: \$0\.0200 spent of \$0\.0100 today\. New calls on deepseek stop until it resets at midnight; to raise it, set usage\.budgets\.providers\.deepseek\.daily in .+settings\.json\.$/);
  assert.equal(requests.length, 0, "the call never reached the provider");

  writeSettings({ providers: { deepseek: { daily: 1, currency: "USD" } }, harnesses: {} });
  assert.equal(await call(), "{\"ok\":true}", "a raised cap applies to the next call");
  assert.equal(requests.length, 1);

  writeSettings({ providers: { deepseek: { dailyTokens: 10_000 } }, harnesses: {} });
  await assert.rejects(call(), /The daily budget for provider deepseek is reached: 20\.0K tokens used of 10\.0K tokens today\..+usage\.budgets\.providers\.deepseek\.dailyTokens/);
  assert.equal(requests.length, 1);
});

test("budgets show what each cap has spent, and the TUI notice names a reached one", () => {
  writeSettings({ providers: { deepseek: { daily: 0.01, monthly: 5, currency: "USD" }, kimi: { monthlyTokens: 1_000_000 } }, harnesses: { claude: { daily: 3 } } });
  const settings = loadSwarmSettings(root);
  const database = openUsageDatabase(databasePath);
  try {
    const statuses = budgetStatus(settings, database);
    assert.deepEqual(statuses.map(({ kind, id, period, unit, reached }) => [kind, id, period, unit, reached]), [
      ["provider", "deepseek", "daily", "USD", true], ["provider", "deepseek", "monthly", "USD", false],
      ["provider", "kimi", "monthly", "tokens", false], ["harness", "claude", "daily", "USD", false]
    ]);
    assert.deepEqual(reachedBudgetNotices(settings, database),
      ["provider deepseek: daily budget reached ($0.0200 of $0.0100), new calls stop · raise usage.budgets.providers.deepseek.daily"]);
  } finally {
    database?.close();
  }
});

test("a harness whose budget is reached runs no turn, and its ticket gets a blocked report saying so", { timeout: 60_000 }, async () => {
  const { writeFakeHarnesses } = await import("../superagent/testing/fake-harness.js");
  const fakes = writeFakeHarnesses(join(root, "bin"), join(root, "harness"));
  process.env.SWARM_SUPERAGENT_HOME = join(root, "superagent");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.PATH = `${join(root, "bin")}:${saved.PATH}`;
  writeSettings({ providers: {}, harnesses: { codex: { dailyTokens: 100 } } });
  recordCall("harness:codex", { event: "harness_turn", harness: "codex" });

  const { SuperagentClient } = await import("../superagent/client.js");
  const { runWorker } = await import("../superagent/worker.js");
  const client = new SuperagentClient({ stateDir: join(root, "superagent") });
  try {
    const { triggerId } = client.request("write the budget note");
    client.engine.evaluateDue();
    const candidate = client.engine.candidate(triggerId)!;
    const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Write the budget note", scope: "note", reason: "asked", name: "budget-note", evalId: candidate.evalId });
    const ticket = client.store.tickets.get(ticketId!)!;
    client.engine.assignmentStarted(ticketId!, ticket.assignments[0]!.id);
    const directory = join(root, "work");
    mkdirSync(directory, { recursive: true });
    const reports: { state: string; summary: string }[] = [];
    const view = () => {
      const now = client.store.tickets.get(ticketId!)!;
      return { ticket: { ...now, execution: { ...now.execution!, harness: "codex", directory } }, triggers: {} };
    };
    const code = await runWorker({ ticketId: ticketId!, entry: [process.execPath, "unused"], link: {
      view: async () => view(), start: async () => ({ directory, prompt: "", blockedCommands: [] }),
      delivered: async () => {}, turnEnded: async () => {}, fileReport: async () => {},
      report: async (report) => { reports.push(report); client.engine.report(ticketId!, report); },
      tools: { args: [], env: {} }, close: () => {}
    } });
    assert.equal(code, 0);
    assert.deepEqual(reports.map((report) => report.state), ["blocked"]);
    assert.match(reports[0]!.summary, /^The daily budget for harness codex is reached: 20\.0K tokens used of 100 tokens today\. New codex turns stop until it resets at midnight; to raise it, set usage\.budgets\.harnesses\.codex\.dailyTokens in .+settings\.json\. Retry the ticket once it is raised\.$/);
    assert.deepEqual(fakes.calls(), [], "codex ran no turn");
  } finally {
    client.close();
  }
});
