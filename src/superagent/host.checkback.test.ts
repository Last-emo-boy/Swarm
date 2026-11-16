/**
 * The host's own wiring of ticket check-backs (host.ts): the pass queues a due one, the handler it registers fires it, and
 * a row kept across a stop runs on the next start. The ticket row keeps what is due, so the effect row is only a timer.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentHost } from "./host.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator } from "./sources/local.js";

let stateDir: string;
let host: SuperagentHost;
/** A check-back wakes a ticket without the model; a test that reaches it fails rather than call out. */
const noModel = async (): Promise<string> => { throw new Error("no model in this test"); };
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-checkback-host-"));
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } } }, settingsPath(stateDir));
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {}, complete: noModel });
});
afterEach(async () => { await host.stop(); rmSync(stateDir, { recursive: true, force: true }); });

/** An open ticket whose worker asked to be woken by now. */
function due(host: SuperagentHost): string {
  const { client } = host;
  const { triggerId } = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked",
    name: "add-notice", evalId: client.engine.candidate(triggerId)!.evalId });
  // The ticket row as a worker's `check_back` leaves it, with the delay already elapsed: the minimum it accepts is a minute.
  client.store.tickets.save({ ...client.store.tickets.get(ticketId!)!, checkBack: { at: new Date(Date.now() - 60_000).toISOString(), note: "waiting for CI",
    requestedAt: new Date(Date.now() - 120_000).toISOString() } });
  return ticketId!;
}

test("the host's pass queues a due check-back and the handler it registered wakes the ticket", async () => {
  const ticketId = due(host);
  await host.start();
  await host.client.effects.idle("checkback");
  const ticket = host.client.store.tickets.get(ticketId)!;
  assert.equal(ticket.checkBack, undefined);
  assert.deepEqual(ticket.inputs.filter((input) => input.kind === "check-back").map((input) => input.kind === "check-back" && input.text),
    ["waiting for CI"]);
});

test("a check-back kept by a stopped host fires on its next start", async () => {
  const ticketId = due(host);
  await host.start();
  await host.stop();
  host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {}, complete: noModel });
  await host.start();
  await host.client.effects.idle("checkback");
  const ticket = host.client.store.tickets.get(ticketId)!;
  assert.equal(ticket.checkBack, undefined);
  assert.equal(ticket.inputs.filter((input) => input.kind === "check-back").length, 1);
});
