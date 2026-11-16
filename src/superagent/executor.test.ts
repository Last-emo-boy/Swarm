import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runningAssignment, waitsForPerson, type Ticket } from "./core/index.js";
import { SuperagentClient } from "./client.js";
import { SwarmExecutor } from "./executor.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator } from "./sources/local.js";
import { patchPath } from "./ticket-tools.js";
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

/** A base repository with one commit, and the patch of one commit on top of it, as a ticket's work would make it. */
function patchOf(stateDir: string): string {
  const base = join(stateDir, "base"), work = join(stateDir, "seed");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "-q", "--bare", base]);
  execFileSync("git", ["clone", "-q", base, work]);
  writeFileSync(join(work, "README"), "base\n");
  git(work, "add", "README");
  git(work, "commit", "-q", "-m", "Start");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  writeFileSync(join(work, "NOTICE"), "Swarm\n");
  git(work, "add", "NOTICE");
  git(work, "commit", "-q", "-m", "Add NOTICE");
  return String(git(work, "format-patch", "--stdout", "HEAD", "--not", "origin/main"));
}

/** An executor that prepares a ticket's directory as a clone of the base repository, and starts a worker that just exits. */
function preparing(stateDir: string): SwarmExecutor {
  writeSettings({ access: {}, sources: { github: { enabled: false, config: { repository: "owner/watched", app: { clientId: "Iv23client", slug: "swarm-oauth" } } } },
    policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } },
    executor: { prepare: `git clone -q "$SWARM_BASE" "$(basename "$SWARM_TICKET_DIR")"` } }, settingsPath(stateDir));
  const deployment = { stateDir, repository: "owner/watched", admissionContextMaxPages: 1, admissionContextTimeoutMs: 1 } as Deployment;
  return new SwarmExecutor({ client, deployment: () => deployment, workerCommand: [process.execPath, "-e", ""], environment: (ticket) => ({ SWARM_BASE: join(stateDir, "base"), SWARM_TICKET_DIR: ticket.execution!.directory }),
    closing: () => false, log: () => {}, remote: () => undefined, credential: async () => undefined });
}

/** Accepts a local request as a ticket, keeps `patch` for it as the host would, and lets the executor launch it. */
async function launched(patch?: string): Promise<Ticket> {
  const { triggerId } = client.request("add a NOTICE file");
  client.engine.evaluateDue();
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Add a NOTICE file", scope: "x", reason: "asked", name: "add-notice", evalId: client.engine.candidate(triggerId)!.evalId });
  const ticket = client.store.tickets.get(ticketId!)!;
  if (patch !== undefined) {
    const path = patchPath(stateDir, ticket);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, patch);
  }
  client.effects.start();
  await client.effects.idle("launch");
  return client.store.tickets.get(ticketId!)!;
}

test("a ticket whose directory is prepared afresh gets its own kept patch back, its commits on its branch", async () => {
  const executor = preparing(stateDir);
  const ticket = await launched(patchOf(stateDir));
  const directory = ticket.execution!.directory;
  const log = String(execFileSync("git", ["log", "--format=%s"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"] }));
  assert.deepEqual(log.trim().split("\n"), ["Add NOTICE", "Start"]);
  assert.ok(!ticket.inputs.some((input) => input.kind === "note"), "nothing kept the ticket from its work");
  await executor.shutdown();
});

test("a kept patch that does not apply leaves the directory as prepared, the launch going on, and the ticket noting where its commits are", async () => {
  const executor = preparing(stateDir);
  patchOf(stateDir);
  const ticket = await launched("From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nnot a patch\n");
  const path = patchPath(stateDir, ticket);
  const directory = ticket.execution!.directory;
  assert.equal(String(execFileSync("git", ["log", "--format=%s"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"] })).trim(), "Start");
  const note = ticket.inputs.find((input) => input.kind === "note");
  assert.ok(note, "the ticket has a note about its patch");
  assert.match(note.text ?? "", new RegExp(`kept as a patch at ${path}`));
  assert.ok(runningAssignment(ticket), "the launch went on");
  await executor.shutdown();
});
