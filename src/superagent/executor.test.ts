import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runningAssignment, waitsForPerson } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { SwarmExecutor } from "./executor.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator } from "./sources/local.js";
import type { Deployment } from "./setup.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-executor-"));
  writeSettings({ access: {}, sources: { github: { enabled: false, config: { repository: "owner/watched", app: { clientId: "Iv23client", slug: "swarm-oauth" } } } },
    policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } } }, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
});
afterEach(async () => {
  await client.effects.drain();
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a ticket whose requester's link stopped working waits for them, asking them to link again, and starts no worker", async () => {
  client.store.set(KV.links.github("local", localOperator()), { login: "alice-gh", id: 7, repos: ["owner/watched"], reposAt: "", linkedAt: "",
    access: { iv: "", data: "", tag: "" } });
  const deployment = { stateDir, repository: "owner/watched", admissionContextMaxPages: 1, admissionContextTimeoutMs: 1 } as Deployment;
  let asked = 0;
  new SwarmExecutor({ client, deployment: () => deployment, workerCommand: ["/usr/bin/false"], environment: () => ({}), closing: () => false,
    log: () => {}, remote: () => undefined, credential: async () => { asked++; return undefined; } });
  client.effects.start();
  const { triggerId } = client.request("add a VERSION file");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Add a VERSION file", scope: "x", reason: "asked", name: "add-version", evalId: candidate.evalId });
  await client.effects.idle("launch");
  const ticket = client.store.tickets.get(ticketId!)!;
  assert.deepEqual(ticket.mandate.capability, { role: "maintainer", write: "github", credential: { login: "alice-gh", id: 7 }, repository: "owner/watched" });
  assert.equal(asked, 1);
  assert.ok(runningAssignment(ticket), "the Assignment runs, waiting for a person");
  assert.ok(waitsForPerson(ticket));
  assert.match(ticket.attention?.question ?? "", /Your GitHub link \(@alice-gh\) stopped working/);
});
