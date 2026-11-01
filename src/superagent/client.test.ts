import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
