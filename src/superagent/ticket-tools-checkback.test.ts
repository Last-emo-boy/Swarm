/**
 * The check_back ticket tool: a worker asks its ticket to wake it later, the note its next turn reads, the schema's own
 * refusal outside the bounds, and a ticket's end dropping the request. Each test runs the tools on a local store with no
 * deployment, so nothing leaves this process.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod/v4";
import { SuperagentClient } from "./client.js";
import { latestReport } from "./core/index.js";
import { inputMessage } from "./messages.js";
import { workerPrompt } from "./prompts.js";
import { proxiedTicketTools, ticketTools } from "./ticket-tools.js";
import { ticketRow } from "./views.js";

let stateDir: string, client: SuperagentClient;
/** The client's clock, which the test moves: the tool itself does not take a time. */
let time: { clock: () => string; tick: (ms: number) => void };
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-checkback-tool-"));
  let now = Date.parse("2026-11-16T00:00:00Z");
  time = { clock: () => new Date(now).toISOString(), tick: (ms) => { now += ms } };
  client = new SuperagentClient({ stateDir, now: time.clock });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A ticket accepted from a local request, as the router accepts one. */
function started(open: SuperagentClient): string {
  const { triggerId } = open.request("watch the CI run to the end");
  open.engine.evaluateDue();
  return open.engine.decide(triggerId, { kind: "accept", title: "Watch CI", scope: "x", reason: "asked", name: "watch-ci",
    evalId: open.engine.candidate(triggerId)!.evalId }).ticketId!;
}

const tool = (open: SuperagentClient, id: string) => ticketTools(open, id).find((item) => item.name === "check_back")!;
const run = (open: SuperagentClient, id: string, args: Record<string, unknown>) => tool(open, id).run(args);

test("a worker leaves a check-back and reads it back; at the time it names, the ticket wakes with its note", async () => {
  const ticketId = started(client);
  const tools = ticketTools(client, ticketId);
  assert.ok(tools.some((item) => item.name === "check_back" && !item.readOnly), "a worker has the tool, and it writes");
  assert.deepEqual(await run(client, ticketId, { after_minutes: 30, note: "  waiting for CI on the branch  " }),
    { scheduled: "2026-11-16T00:30:00.000Z" });
  const read = JSON.parse((await tools.find((item) => item.name === "read")!.run({ resource: `ticket/${ticketId}`, offset: 0 }) as { text: string }).text) as
    { check_back: { at: string; note: string } | null };
  assert.deepEqual(read.check_back, { at: "2026-11-16T00:30:00.000Z", note: "waiting for CI on the branch", requestedAt: "2026-11-16T00:00:00.000Z" });
  assert.equal(ticketRow(client, client.store.tickets.get(ticketId)!).checkBack, "check-back 2026-11-16T00:30:00.000Z: waiting for CI on the branch");
  // The host fires it by its own clock; the input carries the note the next turn starts with.
  time.tick(30 * 60_000);
  assert.equal(client.engine.fireCheckBack(ticketId), true);
  const woken = client.store.tickets.get(ticketId)!;
  assert.equal(woken.checkBack, undefined);
  const input = woken.inputs.find((item) => item.kind === "check-back");
  assert.deepEqual(input && { text: input.text, at: input.at }, { text: "waiting for CI on the branch", at: "2026-11-16T00:30:00.000Z" });
  assert.equal(inputMessage(input!), "Check-back you asked for: waiting for CI on the branch");
  assert.equal(latestReport(woken), undefined);
});

test("a second check-back replaces the first, and only the later time wakes the ticket", async () => {
  const ticketId = started(client);
  await run(client, ticketId, { after_minutes: 5, note: "waiting for a review" });
  time.tick(60_000);
  assert.deepEqual(await run(client, ticketId, { after_minutes: 60, note: "waiting for the merge" }),
    { scheduled: "2026-11-16T01:01:00.000Z", rescheduled: true });
  time.tick(5 * 60_000);
  assert.equal(client.engine.fireCheckBack(ticketId), false, "the earlier time is gone");
  time.tick(60 * 60_000);
  assert.equal(client.engine.fireCheckBack(ticketId), true);
  assert.deepEqual(client.store.tickets.get(ticketId)!.inputs.filter((item) => item.kind === "check-back").map((item) => item.kind === "check-back" && item.text),
    ["waiting for the merge"]);
});

test("the tool refuses a time outside its bounds and a note with nothing in it", async () => {
  const ticketId = started(client);
  const schema = z.object(tool(client, ticketId).input);
  // Both the direct call and the parsed schema refuse: the model's arguments are checked where they arrive.
  for (const args of [{ after_minutes: 0, note: "too soon" }, { after_minutes: 10_081, note: "beyond the clock" },
    { after_minutes: 1.5, note: "fractions are not minutes" }, { after_minutes: 10, note: "   " }]) {
    assert.equal(schema.safeParse(args).success, false, JSON.stringify(args));
    await assert.rejects(run(client, ticketId, args));
    assert.equal(client.store.tickets.get(ticketId)!.checkBack, undefined, `nothing is left by ${JSON.stringify(args)}`);
  }
  for (const after_minutes of [1, 10_080]) assert.equal(schema.safeParse({ after_minutes, note: "at the bounds" }).success, true);
});

test("a ticket that ends drops its check-back, and the tool refuses a check-back from one that already ended", async () => {
  const ticketId = started(client);
  await run(client, ticketId, { after_minutes: 1, note: "waiting for CI" });
  client.engine.stopTicket(ticketId);
  assert.equal(client.store.tickets.get(ticketId)!.checkBack, undefined);
  time.tick(2 * 60_000);
  assert.equal(client.engine.fireCheckBack(ticketId), false);
  await assert.rejects(run(client, ticketId, { after_minutes: 5, note: "try again" }), /Ticket has ended/);
  assert.equal(client.store.tickets.get(ticketId)!.inputs.filter((item) => item.kind === "check-back").length, 0);
});

test("the worker's prompt tells it how to wait without holding the ticket", () => {
  const prompt = workerPrompt({ stateDir, environment: "", mandate: "", sources: [], github: false });
  const checkBack = prompt.slice(prompt.indexOf("## Check-backs"));
  assert.ok(checkBack.startsWith("## Check-backs"), "the section follows Work");
  for (const phrase of ["mcp__ticket__check_back", "end your turn", "At most one is pending; leaving another replaces it", "report ready or dropped"])
    assert.ok(checkBack.includes(phrase), phrase);
  assert.ok(prompt.indexOf("## Check-backs") > prompt.indexOf("## Work") && prompt.indexOf("## Check-backs") < prompt.indexOf("## Handoff"));
});

test("a worker on a paired node leaves a check-back through the owner's tool", async () => {
  const ticketId = started(client);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const proxied = proxiedTicketTools(async (name, args) => {
    calls.push({ name, args });
    return tool(client, ticketId).run(args);
  });
  assert.ok(proxied.some((item) => item.name === "check_back" && !item.readOnly));
  await proxied.find((item) => item.name === "check_back")!.run({ after_minutes: 20, note: "waiting for the deploy" });
  assert.deepEqual(calls, [{ name: "check_back", args: { after_minutes: 20, note: "waiting for the deploy" } }]);
  assert.equal(client.store.tickets.get(ticketId)!.checkBack?.note, "waiting for the deploy");
});

test("a worker of an Assignment the ticket replaced cannot reschedule the live worker's wake", async () => {
  const ticketId = started(client);
  client.engine.assignmentStarted(ticketId, client.store.tickets.get(ticketId)!.assignments[0]!.id);
  client.engine.report(ticketId, { state: "blocked", summary: "need a decision" });
  client.retry(ticketId);
  const assignments = client.store.tickets.get(ticketId)!.assignments;
  assert.equal(assignments.length, 2);
  const stale = ticketTools(client, ticketId, assignments[0]!.id).find((item) => item.name === "check_back")!;
  await assert.rejects(stale.run({ after_minutes: 10_080, note: "waiting for CI" }), /Assignment has ended/);
  assert.equal(client.store.tickets.get(ticketId)!.checkBack, undefined, "the stale worker left nothing");
  // The live worker's own request goes through, with its assignment named.
  const live = ticketTools(client, ticketId, assignments[1]!.id).find((item) => item.name === "check_back")!;
  assert.deepEqual(await live.run({ after_minutes: 5, note: "CI again" }), { scheduled: "2026-11-16T00:05:00.000Z" });
  assert.equal(client.store.tickets.get(ticketId)!.checkBack?.note, "CI again");
});
