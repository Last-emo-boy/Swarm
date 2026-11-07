import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readLedgerAt } from "../usage/ledger.js";
import { startFakeModel, writeFakeModelHome } from "./testing/fake-model.js";

const home = mkdtempSync(join(tmpdir(), "swarm-superagent-provider-"));
const saved = process.env.SWARM_HOME;
let model: Awaited<ReturnType<typeof startFakeModel>>;

before(async () => {
  process.env.SWARM_HOME = home;
  model = await startFakeModel(() => JSON.stringify({ kind: "ignore", reason: "a test" }));
  writeFakeModelHome(home, model.url);
});
after(async () => {
  await model.close();
  if (saved === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

test("the host's routing and assessment calls go to this device's usage records as assessor calls", async () => {
  const { providerComplete } = await import("./provider.js");
  const complete = await providerComplete();
  await complete({ purpose: "superagent_route", system: "You route requests.", user: "fix the build" });
  await complete({ purpose: "superagent_assessment", system: "You assess candidates.", user: "a CI failure" });
  assert.equal(model.requests.length, 2);
  const entries = readLedgerAt(join(home, "state", "swarm.db"), "mac");
  assert.deepEqual(entries.map(({ source, purpose, provider, model: name, input, output }) => ({ source, purpose, provider, model: name, input, output })), [
    { source: "assessor", purpose: "superagent_route", provider: "local-test", model: "model", input: 10, output: 10 },
    { source: "assessor", purpose: "superagent_assessment", provider: "local-test", model: "model", input: 10, output: 10 }
  ]);
});
