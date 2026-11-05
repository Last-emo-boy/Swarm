import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { liveTicket, type Trigger } from "./core/index.js";
import { ModelAssessor, routeProblem, type Complete } from "./assessor.js";
import { SuperagentClient } from "./client.js";
import { placementOf } from "./placement.js";
import { settingsPath, writeSettings } from "./settings.js";
import { commentTrigger } from "./sources/github-trigger.js";

let stateDir: string;
let client: SuperagentClient;
let answers: string[];
let calls: { purpose: string; system: string; user: string }[];
let assessor: ModelAssessor;
let opened = false;
const complete: Complete = async (input) => {
  calls.push(input);
  const answer = answers.shift();
  if (answer === undefined) throw new Error("no scripted answer");
  return answer;
};
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-superagent-assessor-"));
  answers = [];
  calls = [];
});
afterEach(() => {
  if (opened) client.close();
  opened = false;
  rmSync(stateDir, { recursive: true, force: true });
});
function start(settings: unknown = {}) {
  writeSettings(settings, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
  opened = true;
  assessor = new ModelAssessor({ client, complete, configured: () => false });
}
/** Runs the Eval the Trigger is in, as the host's assessment effect does. */
async function judge(triggerId: string) {
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId);
  assert.ok(candidate, "an Eval holds the Trigger");
  await assessor.judge(triggerId, candidate.evalId);
}
const accept = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  kind: "accept", title: "Fix the README typo", worktree_name: "fix-readme-typo", acknowledgement: "On it: fixing the README typo.", ...overrides
});

test("routes an explicit request to a new ticket with the router's title, name and acknowledgement", async () => {
  start();
  const { triggerId } = client.request("fix the typo in README");
  answers.push(accept());
  await judge(triggerId);
  const decision = client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!;
  assert.equal(decision.kind, "accept");
  const ticket = client.store.tickets.get(decision.ticketId!)!;
  assert.equal(ticket.title, "Fix the README typo");
  assert.match(ticket.execution!.name, /^fix-readme-typo-/);
  assert.equal(calls[0]!.purpose, "superagent_route");
  assert.match(calls[0]!.system, /Return exactly one JSON object/);
  assert.equal(JSON.parse(calls[0]!.user).candidate.strength, "explicit");
});

test("records what the router says accepted work needs of its machine, for a mesh node to place its worker", async () => {
  start();
  const { triggerId } = client.request("retrain the model on the GPU box");
  answers.push(accept({ title: "Retrain the model", worktree_name: "retrain-model", needs: ["GPU", "linux", "gpu"] }));
  await judge(triggerId);
  const ticketId = client.store.decisions.get(client.store.triggers.disposition(triggerId)!.decisionId!)!.ticketId!;
  assert.deepEqual(placementOf(client, client.store.tickets.get(ticketId)!)?.needs, ["gpu", "linux"]);

  const plain = client.request("fix the typo in README");
  answers.push(accept());
  await judge(plain.triggerId);
  const other = client.store.decisions.get(client.store.triggers.disposition(plain.triggerId)!.decisionId!)!.ticketId!;
  assert.equal(placementOf(client, client.store.tickets.get(other)!), undefined, "work any machine can do has no placement");
});

test("asks again with the problem when an answer breaks a limit, and leaves the Eval undecided after a second bad answer", async () => {
  start();
  const { triggerId } = client.request("rename the script");
  answers.push(accept({ worktree_name: "Rename The Script" }), accept({ worktree_name: "rename-script" }));
  await judge(triggerId);
  assert.match(JSON.parse(calls[1]!.user).problem, /worktree_name/);
  assert.ok(client.store.triggers.disposition(triggerId)!.decisionId);

  const second = client.request("another request");
  answers.push("not json", JSON.stringify({ kind: "ignore" }));
  await assert.rejects(judge(second.triggerId), /could not be used/);
  assert.equal(client.store.triggers.disposition(second.triggerId)?.decisionId, undefined);
});

test("routeProblem names the field a kind needs", () => {
  assert.equal(routeProblem({ kind: "attach" }), "attach needs ticket_id");
  assert.equal(routeProblem({ kind: "ignore", reason: "chat" }), undefined);
  assert.match(routeProblem({ kind: "accept", title: "x", worktree_name: "ok-name", acknowledgement: "word ".repeat(120) }) ?? "", /acknowledgement/);
});

const githubSettings = (mode: "observe" | "auto") => ({
  sources: { github: { enabled: true, config: { repository: "acme/widgets", cli: "gh", observeComments: true } } },
  policy: { sources: { github: { allowed: [{ id: "alice" }] } } },
  eval: { mode }
});
const comment = (id: number, body: string, login = "alice"): Trigger => commentTrigger(
  { id, body, user: { login, type: "User" }, html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`, created_at: `2026-11-01T00:00:0${id}Z` },
  { number: 7, isPr: false, url: "https://github.com/acme/widgets/issues/7" }, "conversation", "agent-bot");
const assessment = (decision: "accept" | "ignore") => JSON.stringify({
  decision,
  rule_assessments: [{ rule_id: "copy", matched: decision === "accept", reason: "a wording fix" }, { rule_id: "visual", matched: false, reason: "no visual change" }],
  direction: { implementation_requested: true, target_basis: "specified", requires_design_decision: false, evidence: "\"Save changes\" should read \"Save\"" },
  title: "Shorten the save label", scope: "Change the label to Save", reason: "a concrete copy fix",
  worktree_name: "shorten-save-label", intent_evidence: "\"just 'Save' would do\"", acknowledgement: "On it: changing the label to Save."
});

test("records an observed proactive accept as ignore with would_accept, and accepts it in auto mode", async () => {
  start(githubSettings("observe"));
  const observed = comment(1, "the button should just say 'Save'");
  client.engine.receive(observed);
  answers.push(assessment("accept"));
  await judge(observed.id);
  const ignored = client.store.decisions.get(client.store.triggers.disposition(observed.id)!.decisionId!)!;
  assert.equal(ignored.kind, "ignore");
  assert.equal((ignored.audit as { would_accept?: boolean }).would_accept, true);
  assert.equal(calls[0]!.purpose, "superagent_assessment");
  assert.match(JSON.parse(calls[0]!.user).candidate.thread.error, /Thread context unavailable/);

  writeSettings(githubSettings("auto"), settingsPath(stateDir));
  const accepted = comment(2, "and the cancel button should just say 'Close'");
  client.engine.receive(accepted);
  answers.push(assessment("accept"));
  await judge(accepted.id);
  const decision = client.store.decisions.get(client.store.triggers.disposition(accepted.id)!.decisionId!)!;
  assert.equal(decision.kind, "accept");
  const ticket = client.store.tickets.get(decision.ticketId!)!;
  assert.equal(ticket.mandate.strength, "inferred");
  assert.deepEqual(ticket.mandate.basis.rules, ["copy"]);
});

test("stops the tickets a person's follow-up asks to stop, and nothing on a message that only comments", async () => {
  start(githubSettings("observe"));
  const request = comment(1, "@agent-bot please fix the label typo");
  client.engine.receive(request);
  answers.push(accept());
  await judge(request.id);
  const ticketId = client.store.triggers.disposition(request.id)!.fanout[0] ?? client.store.tickets.list()[0]!.id;

  const chatter = comment(2, "thanks, looks good so far");
  client.engine.receive(chatter);
  const queued = client.store.db.prepare("SELECT key FROM effect WHERE kind = 'followup'").all().map((row) => String(row.key));
  assert.deepEqual(queued, [chatter.id]);
  answers.push(JSON.stringify({ stop: [], reason: "a comment" }));
  await assessor.followup(chatter.id);
  assert.ok(liveTicket(client.store.tickets.get(ticketId)!));

  const stop = comment(3, "actually, cancel this, we will not change the label");
  client.engine.receive(stop);
  answers.push(JSON.stringify({ stop: [ticketId, "unknown"], reason: "the person cancelled it" }));
  await assessor.followup(stop.id);
  const ended = client.store.tickets.get(ticketId)!;
  assert.equal(ended.ended?.by, "human");
});
