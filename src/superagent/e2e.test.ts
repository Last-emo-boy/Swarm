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

const loop = (result: Record<string, unknown>) => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...result });
const reported = (request: ModelRequest) => request.user.includes("\"reported\":true") || request.user.includes("\\\"reported\\\":true");
/** The coding loop's answers, by ticket and by how many tool results the ticket's turn has seen. */
function answer(request: ModelRequest): string {
  if (request.system.includes("You route requests for Swarm's ticket host")) {
    if (request.user.includes("changelog")) {
      return JSON.stringify({ kind: "accept", title: "Update the changelog", worktree_name: "update-changelog", acknowledgement: "On it: updating the changelog." });
    }
    return JSON.stringify({ kind: "accept", title: "Create hello.txt", worktree_name: "create-hello", acknowledgement: "On it: creating hello.txt." });
  }
  // The changelog ticket's worker ends its first turn without a report, as a real model did in a live trial.
  if (request.system.includes("update-changelog-")) {
    if (!request.user.includes("Your turn ended without mcp__ticket__report")) {
      return loop({ status: "completed", summary: "Done — reporting the ticket result now.", message: "Done — reporting the ticket result now." });
    }
    if (!reported(request)) {
      return loop({ status: "continue", summary: "Report", message: "Reporting.", tool_calls: [
        { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Nothing to change in the changelog.", message: "The changelog is up to date." } }
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
      { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Wrote hello.txt; cat shows hi.", message: "hello.txt is ready." } }
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
  const reminders = model.requests.filter((request) => request.system.includes("update-changelog-") && request.user.includes("Your turn ended without mcp__ticket__report"));
  assert.ok(reminders.length >= 1, "the worker was reminded");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "The changelog is up to date."));
});
