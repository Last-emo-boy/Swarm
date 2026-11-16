/**
 * The worker's stop report: work that stops keeps its commits as a patch, as the report tool's blocked and failed reports
 * do, so a ticket whose directory goes with it (a ticket VM's disk, or any ticket the host closes) keeps its work.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { latestReport } from "./core/index.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator } from "./sources/local.js";
import { fileReport, patchPath, withStoppedPatch } from "./ticket-tools.js";

let stateDir: string, directory: string, client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-worker-stop-"));
  directory = mkdtempSync(join(tmpdir(), "swarm-worker-stop-work-"));
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } } }, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
});

/** A repository with one commit no remote has, as a worker's directory after its turn. */
function commits(): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: directory, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "-q", directory]);
  git("commit", "-q", "--allow-empty", "-m", "Start");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(directory, "NOTICE"), "Swarm\n");
  git("add", "NOTICE");
  git("commit", "-q", "-m", "Add NOTICE");
}

/** A ticket accepted from a local request, as the router accepts one. */
function started(): string {
  const { triggerId } = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  return client.engine.decide(triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked", name: "add-notice", evalId: client.engine.candidate(triggerId)!.evalId }).ticketId!;
}

test("the catch block's failed report reaches fileReport with the directory's commits as a patch, which the host keeps", async () => {
  commits();
  const ticketId = started();
  const args = await withStoppedPatch(directory, { state: "failed", summary: "The worker failed: the model refused" });
  assert.equal(args.state, "failed");
  assert.ok(args.patch?.text.includes("Subject: [PATCH] Add NOTICE"), "the commits no remote has");
  assert.equal(args.patch?.uncommitted, false);
  await fileReport(client, ticketId, args);
  assert.equal(latestReport(client.store.tickets.get(ticketId)!)?.state, "failed");
  assert.match(readFileSync(patchPath(stateDir, client.store.tickets.get(ticketId)!), "utf8"), /Subject: \[PATCH\] Add NOTICE/);
});

test("a report that stopped still goes without a patch when the directory cannot give one, and progress never reads it", async () => {
  // A directory that is no repository, and one that is gone: the report goes without a patch.
  assert.deepEqual(await withStoppedPatch(directory, { state: "failed", summary: "The worker failed: nowhere" }), { state: "failed", summary: "The worker failed: nowhere" });
  assert.deepEqual(await withStoppedPatch(join(directory, "gone"), { state: "blocked", summary: "Out of budget." }), { state: "blocked", summary: "Out of budget." });
  assert.deepEqual(await withStoppedPatch(directory, { state: "progress", summary: "Working." }), { state: "progress", summary: "Working." });
  // A read that throws, as when git is not on PATH, leaves the plain report too.
  commits();
  const saved = process.env.PATH;
  process.env.PATH = join(directory, "no-bin");
  try {
    assert.deepEqual(await withStoppedPatch(directory, { state: "failed", summary: "The worker failed: nowhere" }), { state: "failed", summary: "The worker failed: nowhere" });
  } finally {
    process.env.PATH = saved;
  }
});
