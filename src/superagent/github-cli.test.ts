/**
 * `swarm superagent link|repo|takeover`: the device flow a terminal starts and finishes, the repository it works on, and a
 * local ticket's patch as a pull request of its operator's own account. GitHub answers come from a scripted fetch; no test
 * runs the real CLI or gh.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./testing/expect.js";
import { SuperagentClient } from "./client.js";
import { runGithubCommand } from "./github-cli.js";
import { GithubLinks, linkKey, linkOf } from "./github-link.js";
import { KV } from "./kv.js";
import { settingsPath, writeSettings } from "./settings.js";
import { localOperator, localTrigger } from "./sources/local.js";
import { fileReport } from "./ticket-tools.js";

const OPERATOR = localOperator();
const WATCHED = "owner/watched";
const APP = { clientId: "Iv23client", slug: "swarm-oauth" };

let stateDir: string;
let client: SuperagentClient;
let script: Record<string, unknown[]>;
const calls: { url: string; token?: string }[] = [];
const realFetch = globalThis.fetch;

/** GitHub answers each path's requests from its script, in order; the last answer repeats. */
async function scriptedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace("Bearer ", "");
  calls.push({ url, ...(token ? { token } : {}) });
  const path = new URL(url).pathname;
  const answers = script[path] ?? [];
  if (!answers.length) return new Response("not found", { status: 404 });
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  return Response.json(answer);
}
/** GitHub's answers for a device flow the person completes at once, linking `login` with push access to `repos`. */
const deviceFlow = (login: string, repos: string[]) => ({
  "/login/device/code": [{ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }],
  "/login/oauth/access_token": [{ access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 15897600 }],
  "/user": [{ login, id: 7 }],
  "/user/installations": [{ installations: [{ id: 1 }] }],
  "/user/installations/1/repositories": [{ repositories: repos.map((full_name) => ({ full_name, permissions: { push: true } })) }]
});
const settings = (allowed: string[] = [OPERATOR], roles: Record<string, string> = {}) => ({
  sources: { github: { enabled: false, config: { repository: WATCHED, app: APP } } },
  policy: { sources: { local: { allowed: allowed.map((id) => ({ id })), roles, admission: {} } } },
  eval: { mode: "observe" },
  access: {}
});
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-github-cli-"));
  writeSettings(settings(), settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
  script = {};
  calls.length = 0;
  globalThis.fetch = scriptedFetch as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** Runs a command as the terminal does and returns what it printed, and nothing that went to a log. */
async function run(command: "link" | "repo" | "takeover", ...args: string[]): Promise<{ printed: string }> {
  const lines: string[] = [];
  const log = console.log;
  const links = new GithubLinks({ store: client.store, key: () => linkKey(stateDir), sleep: async () => {} });
  console.log = (...items: unknown[]) => { lines.push(items.join(" ")); };
  try { await runGithubCommand(client, command, args, links); } finally { console.log = log; }
  return { printed: lines.join("\n") };
}
/** A request accepted as a local ticket of the operator's, as the router's accept decision makes one. */
function accepted(text = "fix the typo"): { triggerId: string; ticketId: string } {
  return acceptedAs(text);
}
/** A request from `actor` accepted as a local ticket of theirs: one asked before the operator linked, whose work stays local. */
function acceptedAs(text: string, actor = OPERATOR): { triggerId: string; ticketId: string } {
  const { triggerId } = client.request(text, actor);
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const decision = client.engine.decide(triggerId, { kind: "accept", title: "Fix the typo", scope: "Fix the typo", reason: "asked", name: "fix-typo", evalId: candidate.evalId });
  return { triggerId, ticketId: decision.ticketId! };
}
async function ready(ticketId: string): Promise<void> {
  const ticket = client.store.tickets.get(ticketId)!;
  client.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
  const patch = "From 0000 Mon Sep 17 00:00:00 2001\n";
  await fileReport(client, ticket.id, { state: "ready", summary: "Done.", patch: { text: patch, bytes: patch.length, uncommitted: false } });
}

describe("link", () => {
  it("prints the code for this terminal only, keeps it pending, and finishes once the person entered it", async () => {
    script = deviceFlow("operator-gh", [WATCHED]);
    const first = await run("link");
    expect(first.printed).toBe("Open https://github.com/login/device and enter ABCD-1234 (expires in 15 minutes).\nRun `swarm superagent link --wait` once you entered it.");
    expect(calls).toHaveLength(1);
    // The code waits in the store for --wait, not in a log.
    expect(client.store.get(KV.links.device)).toMatchObject({ clientId: APP.clientId, device: { user_code: "ABCD-1234" } });
    expect(linkOf(client.store, { source: "local", id: OPERATOR })).toBeUndefined();
    const second = await run("link", "--wait");
    expect(second.printed).toBe(`Linked as @operator-gh. You can work on ${WATCHED}. Install the app on more repositories at https://github.com/apps/swarm-oauth/installations/new.`);
    // The link is where every local request and ticket finds it, under the operator's own id.
    expect(linkOf(client.store, { source: "local", id: OPERATOR })).toMatchObject({ login: "operator-gh", repos: [WATCHED] });
    expect(client.store.get(KV.links.device)).toBeUndefined();
  });
  it("sets the default repository the code was linked with, and refuses one the app is not on", async () => {
    script = deviceFlow("operator-gh", [WATCHED, "operator-gh/tool"]);
    const { printed } = await run("link", "--repo", "operator-gh/tool", "--wait");
    expect(printed).toContain("Your tickets work on operator-gh/tool unless their request names another.");
    expect(linkOf(client.store, { source: "local", id: OPERATOR })?.defaultRepo).toBe("operator-gh/tool");
    await expect(run("repo", "operator-gh/elsewhere")).rejects.toThrow("cannot push to operator-gh/elsewhere");
  });
  it("starts a fresh code when the stored one is past its lifetime or was made for another app", async () => {
    // A code started 16 minutes ago, when codes live 15: a link without --wait must ask GitHub for a new one.
    client.store.set(KV.links.device, { device: { device_code: "dead", user_code: "OLD-0000", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 },
      clientId: APP.clientId, at: new Date(Date.now() - 16 * 60_000).toISOString() });
    script = { ...deviceFlow("operator-gh", [WATCHED]), "/login/device/code": [{ device_code: "dc", user_code: "NEW-1111", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }] };
    const { printed } = await run("link");
    expect(printed).toContain("enter NEW-1111");
    expect(client.store.get(KV.links.device)).toMatchObject({ device: { user_code: "NEW-1111" } });
    // A code from another app, still fresh: no use here either, since the app polling it would be the wrong one.
    client.store.set(KV.links.device, { device: { device_code: "other", user_code: "APP-2222", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 },
      clientId: "Iv23other", at: new Date().toISOString() });
    script = { ...script, "/login/device/code": [{ device_code: "dc2", user_code: "THIRD-3333", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }] };
    expect((await run("link")).printed).toContain("enter THIRD-3333");
    expect(client.store.get(KV.links.device)).toMatchObject({ clientId: APP.clientId, device: { user_code: "THIRD-3333" } });
  });
  it("clears the pending code when the person declines, so the next link starts over instead of reusing a dead one", async () => {
    client.store.set(KV.links.device, { device: { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 },
      clientId: APP.clientId, at: new Date().toISOString() });
    script = { "/login/oauth/access_token": [{ error: "access_denied" }] };
    await expect(run("link", "--wait")).rejects.toThrow("the request was declined on GitHub");
    expect(client.store.get(KV.links.device)).toBeUndefined();
  });
  it("says linking is not set up when the settings name no app", async () => {
    writeSettings({ ...settings(), sources: { github: { enabled: false, config: { repository: WATCHED } } } }, settingsPath(stateDir));
    await expect(run("link")).rejects.toThrow("linking GitHub accounts is not set up here");
  });
});

describe("repo", () => {
  it("lists the repositories with the default marked, and sets the default among the ones the app may push to", async () => {
    script = deviceFlow("operator-gh", [WATCHED, "operator-gh/tool"]);
    await run("link", "--wait");
    // The repositories read as GitHub lists them, sorted, with the default marked.
    const listed = await run("repo");
    expect(listed.printed).toBe("You can work on operator-gh/tool, owner/watched.");
    const set = await run("repo", "operator-gh/tool");
    expect(set.printed).toBe("You can work on operator-gh/tool (default), owner/watched.");
    expect(linkOf(client.store, { source: "local", id: OPERATOR })?.defaultRepo).toBe("operator-gh/tool");
    expect(calls.at(-1)!.token).toBe("ghu_1");
  });
  it("points an unlinked operator at the link command", async () => {
    await expect(run("repo")).rejects.toThrow("run swarm superagent link");
  });
});

describe("takeover", () => {
  it("links first when the operator has not, then takes the patched ticket over", async () => {
    script = deviceFlow("operator-gh", [WATCHED]);
    const { ticketId } = accepted();
    await ready(ticketId);
    const { printed } = await run("takeover", ticketId.slice(0, 8));
    expect(printed).toMatch(/^Your GitHub account is not linked yet, so this ticket stays local for now\.\n/);
    expect(printed).toContain("Linked as @operator-gh.");
    expect(printed).toMatch(/Ticket [0-9a-f]{8} takes over ticket [0-9a-f]{8}: it applies the patch and opens a pull request\.$/);
    const taker = client.store.tickets.list().find((ticket) => ticket.mandate.capability?.from === ticketId)!;
    expect(taker.mandate).toMatchObject({ actor: { source: "local", id: OPERATOR }, capability: { write: "github", from: ticketId,
      credential: { login: "operator-gh", id: 7 }, repository: WATCHED } });
    expect(client.store.tickets.get(ticketId)!.ended).toBeDefined();
    expect(linkOf(client.store, { source: "local", id: OPERATOR })?.login).toBe("operator-gh");
    expect(client.store.get(KV.links.device)).toBeUndefined();
  });
  it("refuses a ticket whose requester is someone else and the operator is not a maintainer", async () => {
    script = deviceFlow("operator-gh", [WATCHED]);
    const { ticketId } = accepted();
    await ready(ticketId);
    await run("link", "--wait");
    // The operator is everyone here, not a maintainer, and the ticket becomes someone else's: it is not theirs to take over.
    writeSettings(settings([OPERATOR], { [OPERATOR]: "everyone" }), settingsPath(stateDir));
    const stored = client.store.tickets.get(ticketId)!;
    client.store.atomic(() => client.store.tickets.save({ ...stored, mandate: { ...stored.mandate, actor: { source: "feishu", id: "ou_someone" } } }));
    await expect(run("takeover", ticketId)).rejects.toThrow("Only the person who asked for ticket");
  });
  it("refuses a ticket that already has a taker", async () => {
    script = deviceFlow("operator-gh", [WATCHED]);
    const { ticketId } = accepted();
    await ready(ticketId);
    // The take-over links the operator on the way, which leaves later requests of theirs writing to GitHub.
    const first = await run("takeover", ticketId);
    const taker = client.store.tickets.list().find((ticket) => ticket.mandate.capability?.from === ticketId)!;
    expect(first.printed).toContain("takes over ticket");
    await expect(run("takeover", ticketId)).rejects.toThrow(`Ticket ${ticketId.slice(0, 8)} was taken over as ticket ${taker.id.slice(0, 8)} already.`);
  });
  it("says the app is not installed on the right repository when the link it just made serves none of the work", async () => {
    // The link lands on a repository other than the one this patch's pull request goes to: a repository problem, not a
    // permission one, so the run ends on the install step rather than blaming the operator's rights.
    script = deviceFlow("operator-gh", ["operator-gh/tool"]);
    const { ticketId } = accepted();
    await ready(ticketId);
    const { printed } = await run("takeover", ticketId.slice(0, 8));
    expect(printed).toContain("Linked as @operator-gh.");
    expect(printed).toContain(`The app is not installed on ${WATCHED}, where this ticket's patch opens its pull request: install it there at https://github.com/apps/swarm-oauth/installations/new, then run swarm superagent repo.`);
    expect(printed).not.toContain("You cannot open pull requests");
    expect(client.store.tickets.list().some((ticket) => ticket.mandate.capability?.from === ticketId)).toBe(false);
  });
  it("waits for a patch that is not there yet, and keeps the wanted pull request", async () => {
    script = deviceFlow("operator-gh", [WATCHED]);
    const { ticketId } = accepted();
    // This operator linked already; the ticket was asked before, and its work stays local for it.
    await run("link", "--wait");
    const { printed } = await run("takeover", ticketId);
    expect(printed).toBe(`I'll open the pull request as @operator-gh once ticket ${ticketId.slice(0, 8)} reports ready.`);
    expect(client.store.get(KV.links.wanted(ticketId))).toBeDefined();
  });
});
