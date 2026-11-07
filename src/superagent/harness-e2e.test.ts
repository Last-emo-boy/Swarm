/**
 * End to end with harness workers and no paid model: a real host routes requests with a scripted model, and each ticket's
 * worker process runs its turns on fake `claude`, `codex`, `kimi` and `opencode` executables (testing/fake-harness.ts) that
 * print the real CLIs' event formats and report through the real ticket tools' MCP server.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import type { Ticket } from "./core/index.js";
import type { SuperagentHost as Host } from "./host.js";
import { startFakeModel, writeFakeModelHome, type ModelRequest } from "./testing/fake-model.js";
import { writeFakeHarnesses } from "./testing/fake-harness.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const exec = promisify(execFile);
const home = mkdtempSync(join(tmpdir(), "swarm-harness-e2e-"));
const saved = { SWARM_HOME: process.env.SWARM_HOME, SWARM_SUPERAGENT_HOME: process.env.SWARM_SUPERAGENT_HOME, CODEX_HOME: process.env.CODEX_HOME,
  KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, PATH: process.env.PATH };
const fakes = writeFakeHarnesses(join(home, "bin"), join(home, "harness"));
let model: Awaited<ReturnType<typeof startFakeModel>>;
let host: Host;

const NAMES: Record<string, string> = { claude: "claude-note", codex: "codex-note", kimi: "kimi-note", opencode: "opencode-note", ghost: "ghost-note", away: "away-note",
  quietly: "quiet-note", flaky: "flaky-note", slowly: "slow-note", "kimi quietly": "kimi-quiet-note", "opencode flaky": "opencode-flaky-note" };
function answer(request: ModelRequest): string {
  if (request.system.includes("You route requests for Swarm's ticket host")) {
    const word = Object.keys(NAMES).sort((a, b) => b.length - a.length).find((name) => request.user.includes(`note with ${name}`)) ?? "claude";
    return JSON.stringify({ kind: "accept", title: `Write the ${word} note`, worktree_name: NAMES[word], acknowledgement: `On it: the ${word} note.` });
  }
  throw new Error("Only the router calls the model here: the workers run on harnesses");
}

before(async () => {
  process.env.SWARM_HOME = home;
  process.env.SWARM_SUPERAGENT_HOME = join(home, "superagent");
  process.env.CODEX_HOME = join(home, "codex");
  process.env.KIMI_CODE_HOME = join(home, "kimi");
  process.env.PATH = `${join(home, "bin")}:${process.env.PATH}`;
  model = await startFakeModel(answer);
  writeFakeModelHome(home, model.url);
  const { settingsPath, writeSettings } = await import("./settings.js");
  writeSettings({ executor: { harness: "codex", harnesses: {
    ghost: { kind: "claude", command: "/nonexistent/claude" },
    away: { kind: "codex", env: { FAKE_HARNESS_SIGNED_OUT: "1" } }
  } } }, settingsPath());
  const { SuperagentHost } = await import("./host.js");
  const { OpenAIProvider } = await import("../providers/openai-provider.js");
  const provider = new OpenAIProvider();
  host = new SuperagentHost({
    workerCommand: [process.execPath, "--import", import.meta.resolve("tsx"), join(repo, "src/index.ts")],
    complete: ({ purpose, system, user }) => provider.generateText({ model: provider.workerModel, system: [{ text: system }], user,
      responseFormat: "json_object", maxOutputTokens: 2000, usage: { purpose } }),
    log: () => {}
  });
  await host.start();
});
after(async () => {
  await host?.stop();
  await model?.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const find = (title: string): Ticket | undefined => host.client.store.tickets.list().find((ticket) => ticket.title === title);
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(done(), `timed out waiting for ${what}`);
}
const replies = () => host.client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
  .map((row) => (JSON.parse(String(row.value)) as { ticketId?: string; text: string }));
async function usage(ticketId: string) {
  const { SwarmDatabase } = await import("../storage/database.js");
  const { UsageStore } = await import("../storage/usage-store.js");
  const database = new SwarmDatabase(join(home, "state", "swarm.db"));
  try { return new UsageStore(database).list(`worker-${ticketId}`, 100); } finally { database.close(); }
}

/** Runs one harness's ticket to completion, then a follow-up on it, and checks the harness's calls, its session and its usage. */
async function harnessTicket(kind: "claude" | "codex" | "kimi" | "opencode", options: { harness?: string }, expected: { model: string; input: number }) {
  const { client } = host;
  client.request(`write the note with ${kind}`, undefined, options);
  const title = `Write the ${kind} note`;
  await until(() => !!find(title)?.ended, `the ${kind} ticket to end`);
  let ticket = find(title)!;
  assert.equal(ticket.ended?.outcome, "completed", `ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.equal(ticket.execution?.harness, kind);
  const directory = ticket.execution!.directory;
  assert.equal(readFileSync(join(directory, "harness.txt"), "utf8"), `${kind} turn 1\n`, "the harness worked in the ticket's directory");
  assert.ok(replies().some((reply) => reply.text === `Done on ${kind}.`), "its ready report posted the result");

  const turns = () => fakes.calls().filter((call) => call.kind === kind && call.cwd === realpathSync(directory));
  const [first] = turns();
  assert.ok(first?.session, "the harness ran a turn there");
  assert.equal(first.resumed, undefined, "a new session for the ticket's first turn");
  assert.match(first.prompt ?? "", /write the note with/);
  assert.match(first.instructions ?? "", /## Swarm superagent[\s\S]*## Working in (Claude Code|Codex|Kimi Code|OpenCode)/);
  assert.match(first.instructions ?? "", /stage those files by path, never with `git add -A` or `git add \.`/);
  assert.match(first.instructions ?? "", /no attribution to an agent, model or harness/);
  assert.deepEqual(first.tools?.args.slice(-4), ["superagent", "mcp", "--ticket", ticket.id]);

  client.message(ticket.id, "add one more line");
  await until(() => {
    const now = find(title);
    return !!now?.ended && now.assignments.length > 1;
  }, `the ${kind} follow-up to end`);
  ticket = find(title)!;
  assert.equal(ticket.ended?.outcome, "completed");
  const later = turns()[1];
  assert.equal(later?.resumed, first.session, "the follow-up resumed the same harness session");
  assert.match(later?.prompt ?? "", /add one more line/);
  assert.equal(readFileSync(join(directory, "harness.txt"), "utf8"), `${kind} turn 1\n${kind} turn 2\n`);
  assert.ok(replies().some((reply) => reply.text === `Follow-up done on ${kind}.`));

  // The ready report ends the ticket during the turn; the worker records the turn's usage once the harness exits.
  const deadline = Date.now() + 30_000;
  let records = await usage(ticket.id);
  while (Date.now() < deadline && records.filter((record) => record.unit === "count").length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    records = await usage(ticket.id);
  }
  const counts = records.filter((record) => record.unit === "count");
  assert.equal(counts.length, 2, "one usage record per turn");
  for (const record of counts) {
    assert.equal(record.metadata.harness, kind);
    assert.equal(record.metadata.model, expected.model);
    assert.equal(record.metadata.providerId, `harness:${kind}`);
  }
  const input = records.filter((record) => record.metadata.token_type === "input").map((record) => record.amount);
  assert.deepEqual(input, [expected.input, expected.input]);

  const shown = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), join(repo, "src/index.ts"), "superagent", "ticket", ticket.id.slice(0, 8)],
    { env: process.env, timeout: 60_000 });
  assert.match(shown.stdout, new RegExp(`Write the ${kind} note  \\(via ${kind}\\)`), "swarm superagent ticket shows the harness");
}

test("a ticket on Claude Code works in its directory, reports ready through the ticket tools, and a follow-up resumes its session", { timeout: 200_000 }, async () => {
  await harnessTicket("claude", { harness: "claude" }, { model: "claude-opus-5-5[1m]", input: 4360 });
});

test("a ticket on Codex, the settings' default, does the same and records the model from Codex's session file", { timeout: 200_000 }, async () => {
  await harnessTicket("codex", {}, { model: "gpt-6.1-sol", input: 146600 });
});

test("a ticket on Kimi Code gets the ticket tools from its directory's mcp.json, put back after each turn, and its usage from the session files", { timeout: 200_000 }, async () => {
  await harnessTicket("kimi", { harness: "kimi" }, { model: "kimi-code/k3", input: 1779 });
  const ticket = find("Write the kimi note")!;
  assert.equal(existsSync(join(ticket.execution!.directory, ".kimi-code")), false, "no Kimi config is left in the ticket's directory");
});

test("a ticket on OpenCode gets the ticket tools and its agent from inline config, and its model from its session export", { timeout: 200_000 }, async () => {
  await harnessTicket("opencode", { harness: "opencode" }, { model: "deepseek/deepseek-flash", input: 23386 });
});

test("Kimi Code and OpenCode turns are reminded and retried with their own tool names", { timeout: 200_000 }, async () => {
  host.client.request("write the note with kimi quietly", undefined, { harness: "kimi" });
  host.client.request("write the note with opencode flaky", undefined, { harness: "opencode" });
  await until(() => !!find("Write the kimi quietly note")?.ended && !!find("Write the opencode flaky note")?.ended, "both tickets to end");
  for (const title of ["Write the kimi quietly note", "Write the opencode flaky note"]) {
    assert.equal(find(title)?.ended?.outcome, "completed", `${title}: ${JSON.stringify(find(title)?.assignments.at(-1)?.report)}`);
  }
  const [, reminded] = fakes.calls().filter((call) => call.cwd === realpathSync(find("Write the kimi quietly note")!.execution!.directory));
  assert.match(reminded?.prompt ?? "", /^Your turn ended without calling the mcp__ticket__report tool/);
  const [, retried] = fakes.calls().filter((call) => call.cwd === realpathSync(find("Write the opencode flaky note")!.execution!.directory));
  assert.match(retried?.prompt ?? "", /^Your last turn failed: OpenCode: API Error: 400 Unexpected value\(s\)/, "the cause from OpenCode's error log, not its generic event");
});

test("a harness that is missing or not signed in fails its ticket with what to do", { timeout: 200_000 }, async () => {
  const { client } = host;
  client.request("write the note with ghost", undefined, { harness: "ghost" });
  client.request("write the note with away", undefined, { harness: "away" });
  const failed = (title: string) => find(title)?.assignments.at(-1)?.report?.state === "failed";
  await until(() => failed("Write the ghost note") && failed("Write the away note"), "both tickets to fail");
  assert.match(find("Write the ghost note")!.assignments.at(-1)!.report!.summary,
    /Claude Code is not installed on .+: \/nonexistent\/claude is not an executable file\. Install it, or set executor\.harnesses\.ghost\.command in .+settings\.json/);
  assert.match(find("Write the away note")!.assignments.at(-1)!.report!.summary,
    /Codex is not signed in on .+: run `.+\/codex login` in a terminal as this user, then retry the ticket\./);

  const cli = (args: string[]) => exec(process.execPath, ["--import", import.meta.resolve("tsx"), join(repo, "src/index.ts"), "harness", ...args],
    { env: process.env, timeout: 60_000 }).then(({ stdout }) => ({ stdout, code: 0 }), (error: { stdout: string; code: number }) => ({ stdout: error.stdout, code: error.code }));
  const listed = JSON.parse((await cli(["list", "--json"])).stdout) as { id: string; installed: boolean }[];
  assert.deepEqual(listed.map((status) => [status.id, status.installed]), [["claude", true], ["codex", true], ["kimi", true], ["opencode", true],
    ["claude-glm", true], ["claude-deepseek", true], ["ghost", false], ["away", true]]);
  const away = await cli(["check", "away"]);
  assert.equal(away.code, 1);
  assert.match(away.stdout, /^away \(Codex\)\n  command: {3}.+\/codex\n  model: {5}the harness's default\n  keys: {6}none\n  signed in: no\n  ! not signed in: run `.+\/codex login`/);
});

test("a harness turn that ends without a report is reminded once in the same session, and its report then ends the ticket", { timeout: 200_000 }, async () => {
  host.client.request("write the note with quietly", undefined, { harness: "codex" });
  await until(() => !!find("Write the quietly note")?.ended, "the quiet ticket to end");
  const ticket = find("Write the quietly note")!;
  assert.equal(ticket.ended?.outcome, "completed", `report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  const [first, reminded] = fakes.calls().filter((call) => call.cwd === realpathSync(ticket.execution!.directory));
  assert.match(reminded?.prompt ?? "", /^Your turn ended without calling the mcp__ticket__report tool, so nobody knows what happened: your final message is not a report\./);
  assert.equal(reminded?.resumed, first?.session);
});

test("a harness turn that fails gets another turn in the same session with the reason, and its report then ends the ticket", { timeout: 200_000 }, async () => {
  host.client.request("write the note with flaky", undefined, { harness: "claude" });
  await until(() => !!find("Write the flaky note")?.ended, "the flaky ticket to end");
  const ticket = find("Write the flaky note")!;
  assert.equal(ticket.ended?.outcome, "completed", `report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  const [first, retried] = fakes.calls().filter((call) => call.cwd === realpathSync(ticket.execution!.directory));
  assert.match(retried?.prompt ?? "", /^Your last turn failed: Claude Code: API Error: 400 /);
  assert.equal(retried?.resumed, first?.session);
});

test("stopping a ticket stops its harness turn", { timeout: 200_000 }, async () => {
  const { client } = host;
  client.request("write the note with slowly", undefined, { harness: "claude" });
  await until(() => !!find("Write the slowly note") && fakes.calls().some((call) => call.prompt?.includes("note with slowly")), "the slow turn to start");
  const ticket = find("Write the slowly note")!;
  const turn = fakes.calls().find((call) => call.prompt?.includes("note with slowly"))!;
  client.stop(ticket.id);
  const alive = () => { try { process.kill(turn.pid, 0); return true; } catch { return false; } };
  await until(() => !alive(), "the harness process to exit");
  assert.equal(find("Write the slowly note")?.ended?.outcome, "stopped");
  assert.equal(existsSync(join(ticket.execution!.directory, "harness.txt")), false, "the turn did no work");
});
