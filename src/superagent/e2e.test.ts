/**
 * End to end, with no paid model: a real host, a real worker process running Swarm's coding loop, and the ticket tools'
 * MCP server, against a scripted OpenAI-compatible model on localhost.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { SuperagentHost as Host } from "./host.js";
import { startFakeModel, writeFakeModelHome, type ModelRequest } from "./testing/fake-model.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const home = mkdtempSync(join(tmpdir(), "swarm-superagent-e2e-"));
const saved = { SWARM_HOME: process.env.SWARM_HOME, SWARM_SUPERAGENT_HOME: process.env.SWARM_SUPERAGENT_HOME };
let model: Awaited<ReturnType<typeof startFakeModel>>;
let host: Host;
/** The README ticket's worker answers in order: a progress report, a failed turn, then, once told the turn failed, its result. */
let readmeStep = 0;
/** Whether the config ticket's worker already answered the person's question, which it does once. */
let configAnswered = false;

const loop = (result: Record<string, unknown>) => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...result });
const reported = (request: ModelRequest) => request.user.includes("\"reported\":true") || request.user.includes("\\\"reported\\\":true");
/** The coding loop's answers, by ticket and by how many tool results the ticket's turn has seen. */
function answer(request: ModelRequest): string {
  if (request.system.includes("ended its turn twice without calling its report tool")) {
    return JSON.stringify({ state: "ready", summary: "Bumped the version to 0.2.0 and committed.", message_for_person: "The version is bumped to 0.2.0." });
  }
  if (request.system.includes("You route requests for Swarm's ticket host")) {
    // Earlier tickets' titles reach the router's card too, so the NOTICE request is matched first.
    if (request.user.includes("NOTICE")) {
      return JSON.stringify({ kind: "accept", title: "Add a NOTICE file", worktree_name: "add-notice", acknowledgement: "On it: adding a NOTICE file." });
    }
    if (request.user.includes("bump the version")) {
      return JSON.stringify({ kind: "accept", title: "Bump the version", worktree_name: "bump-version", acknowledgement: "On it: bumping the version." });
    }
    if (request.user.includes("config file")) {
      return JSON.stringify({ kind: "accept", title: "Rename the config file", worktree_name: "rename-config", acknowledgement: "On it: renaming the config file." });
    }
    if (request.user.includes("README")) {
      return JSON.stringify({ kind: "accept", title: "Tidy the README", worktree_name: "tidy-readme", acknowledgement: "On it: tidying the README." });
    }
    if (request.user.includes("changelog")) {
      return JSON.stringify({ kind: "accept", title: "Update the changelog", worktree_name: "update-changelog", acknowledgement: "On it: updating the changelog." });
    }
    return JSON.stringify({ kind: "accept", title: "Create hello.txt", worktree_name: "create-hello", acknowledgement: "On it: creating hello.txt." });
  }
  // The NOTICE ticket keeps its work local: its worker commits, finds no GitHub account, and reports ready.
  if (request.system.includes("add-notice-")) {
    if (!request.user.includes("gh is unavailable")) {
      return loop({ status: "continue", summary: "Commit", message: "Committing the NOTICE file.", tool_calls: [
        { id: "write", action: "Write", inputs: { file_path: "NOTICE", content: "Notice\n" } },
        { id: "commit", action: "Bash", inputs: { command: "git add NOTICE && git -c user.name=t -c user.email=t@example.com commit -qm 'Add NOTICE' && gh api user" } }
      ] });
    }
    if (!reported(request)) {
      return loop({ status: "continue", summary: "Report", message: "Reporting.", tool_calls: [
        { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Committed NOTICE.", message_for_person: "NOTICE is added; the patch is attached." } }
      ] });
    }
    return loop({ status: "completed", summary: "Reported", message: "Reported." });
  }
  // The version ticket's worker never reports, even when reminded, as a real model did in a live trial.
  if (request.system.includes("bump-version-")) {
    return loop({ status: "completed", summary: "Bumped the version; reporting ready now.", message: "" });
  }
  // The config ticket's worker reports progress, then answers a person's question with its result, as on OVH.
  if (request.system.includes("rename-config-")) {
    if (!request.user.includes("ready for review")) {
      if (reported(request)) return loop({ status: "completed", summary: "Waiting for review", message: "Waiting for review." });
      return loop({ status: "continue", summary: "Progress", message: "Recording progress.", tool_calls: [
        { id: "progress", action: "mcp__ticket__report", inputs: { state: "progress", summary: "Renamed the config file; the PR waits for review." } }
      ] });
    }
    if (configAnswered) return loop({ status: "completed", summary: "Answered", message: "Answered." });
    configAnswered = true;
    const asked = [...request.user.matchAll(/trigger_id\\?":\\?"([0-9a-f]{32})/g)].at(-1)?.[1] ?? "";
    return loop({ status: "continue", summary: "Answer", message: "Answering.", tool_calls: [
      { id: "ready", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Renamed the config file; ready for review.", reply_to_trigger_id: asked, message_for_person: "Yes, it is ready for review." } }
    ] });
  }
  // The README ticket's worker reports progress, then its turn fails on a reply the loop cannot use, as a real model's did on OVH.
  if (request.system.includes("tidy-readme-")) {
    readmeStep += 1;
    if (readmeStep === 1) {
      return loop({ status: "continue", summary: "Bind", message: "Recording progress.", tool_calls: [
        { id: "progress", action: "mcp__ticket__report", inputs: { state: "progress", summary: "Tidied the README; checking it next." } }
      ] });
    }
    if (readmeStep === 2) return loop({ status: "failed", summary: "The invalid output contains shell fragments rather than a valid executable tool_call.", message: "" });
    if (!request.user.includes("Your last turn failed")) return loop({ status: "completed", summary: "Done", message: "Done." });
    if (readmeStep === 3) {
      return loop({ status: "continue", summary: "Report", message: "Reporting.", tool_calls: [
        { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Tidied the README and checked it.", message_for_person: "The README is tidy." } }
      ] });
    }
    return loop({ status: "completed", summary: "Reported", message: "Reported." });
  }
  // The changelog ticket's worker ends its first turn without a report, as a real model did in a live trial.
  if (request.system.includes("update-changelog-")) {
    if (!request.user.includes("Your turn ended without calling the mcp__ticket__report tool")) {
      return loop({ status: "completed", summary: "Done — reporting the ticket result now.", message: "Done — reporting the ticket result now." });
    }
    if (!reported(request)) {
      return loop({ status: "continue", summary: "Report", message: "Reporting.", tool_calls: [
        { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Nothing to change in the changelog.", message_for_person: "The changelog is up to date." } }
      ] });
    }
    return loop({ status: "completed", summary: "Reported", message: "Reported." });
  }
  const trigger = /trigger_id\\?":\\?"([0-9a-f]{32})/.exec(request.user)?.[1] ?? "";
  if (!request.user.includes("hello.txt was written") && !/"action":\s*"Write"[\s\S]*"status":\s*"success"/.test(request.user)) {
    return loop({ status: "continue", summary: "Write the file", message: "Writing hello.txt.", tool_calls: [
      { id: "ack", action: "mcp__ticket__ack", inputs: { trigger_id: trigger, text: "On it: writing hello.txt." } },
      { id: "write", action: "Write", inputs: { file_path: "hello.txt", content: "hi\n" } }
    ] });
  }
  if (!reported(request)) {
    return loop({ status: "continue", summary: "Verify and report", message: "Checking the file and reporting.", tool_calls: [
      { id: "check", action: "Bash", inputs: { command: "cat hello.txt" } },
      { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Wrote hello.txt; cat shows hi.", message_for_person: "hello.txt is ready." } }
    ] });
  }
  return loop({ status: "completed", summary: "Done", message: "hello.txt is written and reported.", files_touched: ["hello.txt"] });
}

before(async () => {
  process.env.SWARM_HOME = home;
  process.env.SWARM_SUPERAGENT_HOME = join(home, "superagent");
  model = await startFakeModel(answer);
  writeFakeModelHome(home, model.url);
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

test("a local request runs to a completed ticket: routed, worked in its own directory, acknowledged and reported", { timeout: 120_000 }, async () => {
  const { client } = host;
  client.request("create hello.txt containing hi");
  const deadline = Date.now() + 100_000;
  let ticket = client.store.tickets.list()[0];
  while (Date.now() < deadline && !ticket?.ended) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ticket = client.store.tickets.list()[0];
  }
  assert.ok(ticket, "the request became a ticket");
  const report = ticket.assignments.at(-1)?.report;
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(report)}`);
  const file = join(ticket.execution!.directory, "hello.txt");
  assert.ok(existsSync(file), "the worker wrote in the ticket's directory");
  assert.equal(readFileSync(file, "utf8"), "hi\n");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { kind: string; text: string; status: string });
  assert.deepEqual(replies.map((reply) => [reply.kind, reply.text]), [
    ["acknowledgement", "On it: creating hello.txt."],
    ["reply", "hello.txt is ready."]
  ]);
  const workerCalls = model.requests.filter((request) => request.system.includes("## Swarm superagent"));
  assert.ok(workerCalls.length >= 2, "the worker ran Swarm's coding loop with the superagent instructions");
});

test("a worker whose turn ends without a report is reminded once, and its report then ends the ticket", { timeout: 120_000 }, async () => {
  const { client } = host;
  client.request("update the changelog for the release");
  const deadline = Date.now() + 100_000;
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Update the changelog");
  let ticket = find();
  while (Date.now() < deadline && !ticket?.ended) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ticket = find();
  }
  assert.equal(ticket?.ended?.outcome, "completed", `ticket: ${JSON.stringify(ticket?.ended)} report: ${JSON.stringify(ticket?.assignments.at(-1)?.report)}`);
  const reminders = model.requests.filter((request) => request.system.includes("update-changelog-") && request.user.includes("Your turn ended without calling the mcp__ticket__report tool"));
  assert.ok(reminders.length >= 1, "the worker was reminded");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "The changelog is up to date."));
});

test("a worker that stays silent after the reminder gets its report written from its last words", { timeout: 120_000 }, async () => {
  const { client } = host;
  client.request("bump the version to 0.2.0");
  const deadline = Date.now() + 100_000;
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Bump the version");
  let ticket = find();
  while (Date.now() < deadline && !ticket?.ended) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ticket = find();
  }
  assert.equal(ticket?.ended?.outcome, "completed", `ticket: ${JSON.stringify(ticket?.ended)} report: ${JSON.stringify(ticket?.assignments.at(-1)?.report)}`);
  assert.match(ticket?.assignments.at(-1)?.report?.summary ?? "", /Reported by the host from the worker's last words/);
  const conclusion = model.requests.find((request) => request.system.includes("ended its turn twice without calling its report tool"));
  assert.ok(conclusion, "the host asked for the conclusion");
  assert.match(conclusion.user, /reporting ready now/, "from the worker's last words");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "The version is bumped to 0.2.0."));
});

test("a worker whose turn fails after a progress report gets another turn with the reason, and its report then ends the ticket", { timeout: 120_000 }, async () => {
  const { client } = host;
  client.request("tidy the README");
  const deadline = Date.now() + 100_000;
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Tidy the README");
  let ticket = find();
  while (Date.now() < deadline && !ticket?.ended) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ticket = find();
  }
  assert.equal(ticket?.ended?.outcome, "completed", `ticket: ${JSON.stringify(ticket?.ended)} report: ${JSON.stringify(ticket?.assignments.at(-1)?.report)}`);
  const retry = model.requests.find((request) => request.system.includes("tidy-readme-") && request.user.includes("Your last turn failed"));
  assert.ok(retry, "the worker was told its turn failed");
  assert.match(retry.user, /shell fragments/, "with the loop's reason");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "The README is tidy."));
});

test("a worker reads a person's message before it reports on it, so the ticket ends when its PR merges", { timeout: 120_000 }, async () => {
  const { client } = host;
  client.request("rename the config file");
  const deadline = Date.now() + 100_000;
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Rename the config file");
  const until = async (done: () => boolean) => {
    while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 300));
  };
  await until(() => !!find()?.assignments.at(-1)?.idleAt);
  const ticketId = find()!.id;
  client.engine.bindThread(ticketId, { source: "github", id: "9" }, true);
  const asked = client.message(ticketId, "is it ready for review?");
  await until(() => find()?.assignments.at(-1)?.report?.state === "ready" && !!find()?.assignments.at(-1)?.idleAt
    && find()!.assignments.at(-1)!.idleAt! > find()!.assignments.at(-1)!.report!.at);
  const ticket = find()!;
  const report = ticket.assignments.at(-1)!.report!;
  assert.equal(report.state, "ready", `report: ${JSON.stringify(report)}`);
  const input = ticket.inputs.find((item) => item.kind === "trigger" && item.triggerId === asked.triggerId);
  assert.ok(input?.kind === "trigger" && input.readAt, "the worker read the message");
  assert.ok(input.readAt < report.at, `read at ${input.readAt}, before the report at ${report.at}`);
  client.engine.threadClosed({ source: "github", id: "9" }, "merged", new Date().toISOString());
  assert.equal(find()?.ended?.outcome, "merged", `ended: ${JSON.stringify(find()?.ended)}`);
});

test("a local ticket's worker has no agent accounts, commits its change, and its result carries the commits as a patch", { timeout: 120_000 }, async () => {
  const { client } = host;
  const { execFileSync } = await import("node:child_process");
  const { localOperator } = await import("./sources/local.js");
  const { settingsPath, writeSettings } = await import("./settings.js");
  const origin = join(home, "origin");
  execFileSync("git", ["init", "-q", origin]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "Start"], { cwd: origin });
  // The operator asks with the role everyone under the access model, so the ticket keeps its work local.
  const path = settingsPath(client.stateDir);
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "everyone" } } } },
    executor: { prepare: `git clone -q ${JSON.stringify(origin)} "$SWARM_TICKET_DIR"` } }, path);
  try {
    client.request("add a NOTICE file");
    const deadline = Date.now() + 100_000;
    const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Add a NOTICE file");
    let ticket = find();
    while (Date.now() < deadline && !ticket?.ended) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      ticket = find();
    }
    const seen = model.requests.filter((request) => request.system.includes("add-notice-")).map((request) => request.user.slice(-1500)).join("\n=====\n");
    assert.equal(ticket?.ended?.outcome, "completed", `ticket: ${JSON.stringify(ticket?.ended)} report: ${JSON.stringify(ticket?.assignments.at(-1)?.report)} ${seen}`);
    assert.deepEqual(ticket.mandate.capability, { role: "everyone", write: "local" });
    assert.ok(model.requests.some((request) => request.system.includes("add-notice-") && request.system.includes("This ticket keeps its change local")));
    assert.ok(model.requests.some((request) => request.user.includes("gh is unavailable")), "the worker's gh has no account");
    const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string; attachment?: string });
    const result = replies.find((reply) => reply.text === "NOTICE is added; the patch is attached.");
    assert.ok(result?.attachment, `the result carries the patch: ${JSON.stringify(result)}`);
    const patch = readFileSync(result.attachment, "utf8");
    assert.match(patch, /Subject: \[PATCH\] Add NOTICE/);
    assert.match(patch, /\+Notice/);
  } finally {
    rmSync(path, { force: true });
  }
});
