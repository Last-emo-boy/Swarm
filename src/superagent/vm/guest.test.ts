/**
 * The guest's preparing of a ticket's directory in its VM: a fresh directory gets the ticket's own kept patch back, from
 * work that stopped, and one that does not apply leaves the directory as prepared while the host is told.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { GuestSpec } from "./gateway.js";
import { prepare } from "./guest.js";

let root: string;
let directory: string;
let server: Server;
/** The patch the gateway gives for the ticket, or undefined for none. */
let kept: string | undefined;
/** The reasons the guest gave the gateway for a kept patch that did not apply. */
let told: string[];
const saved = { SWARM_SUPERAGENT_HOME: process.env.SWARM_SUPERAGENT_HOME, SWARM_HOME: process.env.SWARM_HOME };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "swarm-guest-"));
  directory = join(root, "work");
  kept = undefined;
  told = [];
  server = createServer((request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "GET" && request.url === "/v1/patch") return kept === undefined ? send(404, { error: { message: "none" } }) : send(200, { patch: kept });
    if (request.method === "POST" && request.url === "/v1/work/patch") {
      let text = "";
      request.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      request.on("end", () => { told.push(String((JSON.parse(text) as { why?: unknown }).why ?? "")); send(200, {}); });
      return;
    }
    send(404, { error: { message: `No route ${request.method} ${request.url}` } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The guest's settings go to its own home, not the test's.
  process.env.SWARM_SUPERAGENT_HOME = join(root, "superagent");
  process.env.SWARM_HOME = join(root, "home");
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.SWARM_SUPERAGENT_HOME === undefined) delete process.env.SWARM_SUPERAGENT_HOME; else process.env.SWARM_SUPERAGENT_HOME = saved.SWARM_SUPERAGENT_HOME;
  if (saved.SWARM_HOME === undefined) delete process.env.SWARM_HOME; else process.env.SWARM_HOME = saved.SWARM_HOME;
});

const gateway = () => ({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "secret" });
const spec = (): GuestSpec => ({
  ticketId: "ticket-1", assignmentId: "assignment-1", name: "add-notice", directory,
  variables: {}, prepare: "true", accounts: "none", blockedCommands: [], permissionMode: "yolo",
  models: { defaultProvider: "deepseek", planner: "x", worker: "x", aggregator: "x" } as GuestSpec["models"],
  providers: {}, model: "deepseek/x"
});

/** A repository with a "Start" commit, whose branch the prepare command copies into the ticket's directory. */
function base(): string {
  const path = join(root, "base");
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: path, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "-q", path]);
  git("commit", "-q", "--allow-empty", "-m", "Start");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(path, "NOTICE"), "Swarm\n");
  git("add", "NOTICE");
  git("commit", "-q", "-m", "Add NOTICE");
  return path;
}

const subjects = (path: string): string[] => String(execFileSync("git", ["log", "--format=%s"], { cwd: path, stdio: ["ignore", "pipe", "ignore"] })).trim().split("\n");

test("a fresh directory gets the ticket's own kept patch back, its commits on its branch", async () => {
  const from = base();
  kept = String(execFileSync("git", ["format-patch", "--stdout", "HEAD", "--not", "--remotes"], { cwd: from, stdio: ["ignore", "pipe", "ignore"] }));
  // The prepare command runs in the directory's parent: it makes the directory from a branch at its start commit.
  const prepare = `git clone -q "${from}" "${join(root, "work")}" && git -C "${join(root, "work")}" reset -q --hard HEAD~1`;
  await prepareTest(spec(), prepare);
  assert.deepEqual(subjects(directory), ["Add NOTICE", "Start"]);
  assert.deepEqual(told, [], "the host hears nothing of a patch that applied");
});

test("a kept patch that does not apply leaves the directory as prepared, and the guest tells the host why", async () => {
  kept = "From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nnot a patch\n";
  await prepareTest(spec(), `git clone -q "${base()}" "${join(root, "work")}"`);
  assert.deepEqual(subjects(directory), ["Add NOTICE", "Start"], "the directory as the prepare command made it, without the patch");
  assert.equal(told.length, 1);
  assert.match(told[0]!, /^The patch of ticket ticket-1 does not apply/);
});

test("a ticket with no kept patch prepares as before, and asks for nothing more", async () => {
  kept = undefined;
  await prepareTest(spec(), `git clone -q "${base()}" "${join(root, "work")}"`);
  assert.deepEqual(told, []);
});

/** Prepares `spec`'s directory with `command`, as the guest does for a ticket of the watched repository. */
async function prepareTest(found: GuestSpec, command: string): Promise<void> {
  await prepare({ ...found, prepare: command }, gateway(), process.env);
}
