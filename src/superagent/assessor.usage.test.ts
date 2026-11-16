/** What the router's model calls carry for the journal and the usage ledger (assessor.ts, provider.ts): the message they are about. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Complete } from "./assessor.js";
import { ModelAssessor } from "./assessor.js";
import { SuperagentClient } from "./client.js";
import type { JournalTarget } from "./journal.js";
import { Journal, journaled } from "./journal.js";

let stateDir: string;
let client: SuperagentClient;
let seen: { purpose: string; target?: JournalTarget }[];
const answer = JSON.stringify({ kind: "accept", title: "Fix the typo", worktree_name: "fix-typo", acknowledgement: "On it: fixing the typo.",
  rule_assessments: [], direction: "inward", scope: "the typo", reason: "asked" });
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-assessor-usage-"));
  client = new SuperagentClient({ stateDir });
  client.journal = new Journal(client.store);
  seen = [];
});
afterEach(() => { client.close(); rmSync(stateDir, { recursive: true, force: true }); });

test("a route call names the message it routes, and a journal row under that message holds the card", async () => {
  const complete: Complete = journaled(client.journal, async (input) => { seen.push({ purpose: input.purpose, ...(input.target ? { target: input.target } : {}) }); return answer });
  const assessor = new ModelAssessor({ client, complete, configured: () => false });
  const { triggerId } = client.request("fix the typo in README");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  await assessor.judge(triggerId, candidate.evalId);
  assert.deepEqual(seen, [{ purpose: "superagent_route", target: { message: triggerId } }]);
  assert.equal(seen[0]!.target!.message, triggerId, "the provider turns this into the usage row's triggerId");
  const [run] = client.journal!.byKey(`trigger:${triggerId}`);
  assert.equal(run!.purpose, "superagent_route");
  assert.equal(run!.outcome, "accept");
  assert.ok(run!.user.includes("fix the typo in README"), "the card as sent");
});
