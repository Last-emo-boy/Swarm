import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { liveTicket, ticketStage } from "./core/index.js";
import { SuperagentClient, effectiveSettings } from "./client.js";
import { SettingsSchema, writeSettings, settingsPath } from "./settings.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-superagent-client-"));
  client = new SuperagentClient({ stateDir });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

const effects = (kind: string) => client.store.db.prepare("SELECT key, value FROM effect WHERE kind = ?").all(kind)
  .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as Record<string, string> }));

test("allows the operator on the local Source unless the settings configure its Policy part", () => {
  const settings = SettingsSchema.parse({});
  assert.deepEqual(effectiveSettings(settings, "alice").policy.sources.local, { allowed: [{ id: "alice" }], admission: {} });
  const configured = SettingsSchema.parse({ policy: { sources: { local: { allowed: [{ id: "bob" }] } } } });
  assert.deepEqual(effectiveSettings(configured, "alice").policy.sources.local?.allowed, [{ id: "bob" }]);
});

test("a local request becomes an explicit candidate, an accepted ticket, and a launch with the acknowledgement on its Thread", () => {
  const { triggerId, thread } = client.request("fix the typo in README");
  assert.equal(client.store.threads.get(thread)?.pending.length, 1);
  client.engine.evaluateDue();
  const [assessment] = effects("assessment");
  assert.ok(assessment, "the Eval queues an assessment");
  const candidate = client.engine.candidate(triggerId)!;
  assert.equal(candidate.strength, "explicit");

  const decision = client.engine.decide(triggerId, {
    kind: "accept", title: "Fix the README typo", scope: "Fix the README typo", reason: "requested",
    acknowledgement: "On it: fixing the README typo.", name: "fix-readme-typo", evalId: candidate.evalId
  });
  assert.equal(decision.kind, "accept");
  const ticket = client.store.tickets.get(decision.ticketId!)!;
  assert.ok(liveTicket(ticket));
  assert.match(ticket.execution!.directory, /\/work\/fix-readme-typo-/);
  assert.deepEqual(ticketStage(ticket), { stage: "working", action: "queued" });
  assert.equal(effects("launch").length, 1);
  const receipts = client.store.db.prepare("SELECT value FROM outbox").all().map((row) => JSON.parse(String(row.value)));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].channel.source, "local");
  assert.equal(receipts[0].text, "On it: fixing the README typo.");
});

test("a message to a local ticket reaches its worker as a follow-up on the ticket's own Thread, without a stop check", () => {
  const { triggerId } = client.request("rename the build script");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, {
    kind: "accept", title: "Rename the build script", scope: "rename", reason: "requested", name: "rename-build", evalId: candidate.evalId
  });
  const reply = client.message(ticketId!, "use build.sh as the new name");
  const ticket = client.store.tickets.get(ticketId!)!;
  assert.ok(ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === reply.triggerId));
  assert.ok(ticket.undelivered.length > 0);
  assert.equal(effects("followup").length, 0);
  assert.equal(client.store.threads.get(reply.thread)?.pending.length, 0, "the worker decides it, so no Eval waits");
});

test("an invalid settings file keeps the last valid settings and reports why", () => {
  writeSettings({ eval: { mode: "auto" } }, settingsPath(stateDir));
  assert.equal(client.settings().eval.mode, "auto");
  const path = settingsPath(stateDir);
  // A later mtime, so the client notices the change.
  const later = new Date(Date.now() + 2000);
  writeFileSync(path, "{ not json");
  utimesSync(path, later, later);
  assert.equal(client.settings().eval.mode, "auto");
  assert.match(client.settingsError() ?? "", /settings\.json/);
});

test("a question the person answered leaves needs-you and shows the ticket working on the answer", async () => {
  const { ticketRow } = await import("./views.js");
  const { triggerId } = client.request("choose a separator");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Separator option", scope: "x", reason: "asked", name: "separator-option", evalId: candidate.evalId });
  client.engine.assignmentStarted(ticketId!, client.store.tickets.get(ticketId!)!.assignments[0]!.id);
  client.engine.report(ticketId!, { state: "progress", summary: "Need the default", question: "Dash or underscore?" });
  assert.deepEqual([ticketRow(client, client.store.tickets.get(ticketId!)!).group, ticketRow(client, client.store.tickets.get(ticketId!)!).label], ["person", "Awaiting answer"]);
  client.message(ticketId!, "dash");
  const row = ticketRow(client, client.store.tickets.get(ticketId!)!);
  assert.deepEqual([row.group, row.label, row.question], ["working", "Working on your answer", undefined]);
});

test("a ready report that answers a person's message in the ticket's own conversation posts one reply, not a result and an answer", async () => {
  const { fileReport } = await import("./ticket-tools.js");
  const { triggerId } = client.request("fix the date format");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Fix the date format", scope: "x", reason: "asked", name: "fix-date-format", evalId: candidate.evalId });
  client.engine.assignmentStarted(ticketId!, client.store.tickets.get(ticketId!)!.assignments[0]!.id);
  const asked = client.message(ticketId!, "is it ready for review?");
  const filed = await fileReport(client, ticketId!, { state: "ready", summary: "Fixed and tested.", reply_to_trigger_id: asked.triggerId, message_for_person: "Yes, it is ready for review." });
  assert.deepEqual(filed.posted, ["answer"]);
  const replies = client.store.db.prepare("SELECT value FROM outbox").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.deepEqual(replies.map((reply) => reply.text), ["Yes, it is ready for review."]);
});

test("a local ticket's ready report keeps its committed patch and attaches it to the result, and refuses uncommitted work", async () => {
  const { fileReport, patchPath } = await import("./ticket-tools.js");
  const { localOperator } = await import("./sources/local.js");
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "everyone" } } } } }, settingsPath(stateDir));
  // The settings file changed within the same second as the client read it; a later mtime makes the client read it again.
  utimesSync(settingsPath(stateDir), new Date(), new Date(Date.now() + 2000));
  const { triggerId } = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked", name: "add-notice", evalId: candidate.evalId });
  const ticket = client.store.tickets.get(ticketId!)!;
  assert.deepEqual(ticket.mandate.capability, { role: "everyone", write: "local" });
  client.engine.assignmentStarted(ticketId!, ticket.assignments[0]!.id);
  const patch = "From 1 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Add NOTICE\n";
  await assert.rejects(fileReport(client, ticketId!, { state: "ready", summary: "Done.", patch: { text: patch, bytes: patch.length, uncommitted: true } }), /uncommitted changes/);
  const filed = await fileReport(client, ticketId!, { state: "ready", summary: "Done.", patch: { text: patch, bytes: patch.length, uncommitted: false } });
  assert.deepEqual(filed.posted, ["result"]);
  const replies = client.store.db.prepare("SELECT value FROM outbox").all().map((row) => JSON.parse(String(row.value)) as { text: string; attachment?: string });
  assert.deepEqual(replies.map((reply) => [reply.text, reply.attachment]), [["The change is ready as the attached patch; nothing was pushed.", patchPath(stateDir, ticket)]]);
  assert.equal(readFileSync(patchPath(stateDir, ticket), "utf8"), patch);
});

test("tells the person when a ticket's work fails or blocks, once a report, in their language, and holds back early or frequent updates", async () => {
  const { fileReport } = await import("./ticket-tools.js");
  const { progressDue, FIRST_PROGRESS_MS, PROGRESS_MS } = await import("./notices.js");
  const { triggerId } = client.request("修一下 README 的错别字");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Fix the typo", scope: "x", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  const ticket = client.store.tickets.get(ticketId!)!;
  client.engine.assignmentStarted(ticketId!, ticket.assignments[0]!.id);
  const texts = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => (JSON.parse(String(row.value)) as { text: string }).text);
  // An update in the first minutes is held back; the report itself still counts.
  const early = await fileReport(client, ticketId!, { state: "progress", summary: "Cloned it.", message_for_person: "代码拉下来了，正在跑测试。" });
  assert.deepEqual(early.posted, []);
  client.engine.report(ticketId!, { state: "failed", summary: "The worker failed: the model answered nothing." });
  assert.equal(texts().at(-1), "这张工单没做完就停下了：The worker failed: the model answered nothing. 回复这条消息，我会接着做。");
  // The worker's own words stand for the host's notice.
  const blocked = await fileReport(client, ticketId!, { state: "blocked", summary: "Needs a branch name.", message_for_person: "需要你告诉我用哪个分支。" });
  assert.deepEqual(blocked.posted, ["notice"]);
  assert.deepEqual(texts(), ["这张工单没做完就停下了：The worker failed: the model answered nothing. 回复这条消息，我会接着做。", "需要你告诉我用哪个分支。"]);
  // A question the host filed, such as for a link that stopped working, is asked.
  client.engine.report(ticketId!, { state: "blocked", summary: "No link.", question: "请私聊我发送 /link 重新绑定 GitHub。" });
  assert.equal(texts().at(-1), "请私聊我发送 /link 重新绑定 GitHub。");
  const created = Date.parse(ticket.createdAt);
  const record = { id: "t-progress", createdAt: ticket.createdAt };
  assert.equal(progressDue(client.store, record, created + FIRST_PROGRESS_MS - 1), false);
  assert.equal(progressDue(client.store, record, created + FIRST_PROGRESS_MS), true);
  assert.equal(progressDue(client.store, record, created + FIRST_PROGRESS_MS + PROGRESS_MS - 1), false);
  assert.equal(progressDue(client.store, record, created + FIRST_PROGRESS_MS + PROGRESS_MS), true);
});
