/**
 * Ticket VM slots and their gateway, with no VM: a fake control records boots and stops, and requests reach the gateway's
 * listeners on 127.0.0.1 with the tokens the slots' directories hold.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { latestAssignment } from "../core/index.js";
import { SuperagentClient } from "../client.js";
import { Later } from "../effects.js";
import { KV } from "../kv.js";
import { settingsPath, writeSettings } from "../settings.js";
import { localOperator } from "../sources/local.js";
import { startFakeModel, writeFakeModelHome } from "../testing/fake-model.js";
import { testDeployment } from "../testing/fixtures.js";
import type { GuestSpec } from "./gateway.js";
import { guestSettings, opencodeConfig } from "./guest.js";
import type { ClusterControl } from "./kube-control.js";
import { VmWork, vmHarnessIds, type VmControl } from "./vm-work.js";

let stateDir: string;
let client: SuperagentClient;
let work: VmWork | undefined;
let port: number;
let calls: string[];
/** The token each cluster slot's pod got. */
let tokens: Map<number, string>;
let model: Awaited<ReturnType<typeof startFakeModel>>;
const swarmHome = mkdtempSync(join(tmpdir(), "swarm-vm-home-"));
const savedHome = process.env.SWARM_HOME;

const control = (): VmControl => ({
  start: async (slot) => { calls.push(`start ${slot}`); },
  stop: async (slot) => { calls.push(`stop ${slot}`); },
  collect: async () => { calls.push("collect"); }
});
const cluster = (): ClusterControl => ({
  start: async (index, ticketId, secret) => { calls.push(`cluster start ${index} ${ticketId}`); tokens.set(index, secret); },
  stop: async (index) => { calls.push(`cluster stop ${index}`); },
  discard: async (ticketId) => { calls.push(`cluster discard ${ticketId}`); },
  guard: async () => { calls.push("cluster guard"); }
});

before(async () => {
  process.env.SWARM_HOME = swarmHome;
  model = await startFakeModel(() => "pong");
  writeFakeModelHome(swarmHome, model.url);
});
after(async () => {
  await model.close();
  if (savedHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = savedHome;
  rmSync(swarmHome, { recursive: true, force: true });
});
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-vm-"));
  port = 42_000 + Math.floor(Math.random() * 8000);
  calls = [];
  tokens = new Map();
  writeSettings({ access: {}, sources: { github: { enabled: false, config: { repository: "owner/watched", app: { clientId: "Iv23client", slug: "swarm-oauth" } } } },
    policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "maintainer" } } } },
    executor: { isolation: "vm", vm: { slots: 2, port }, prepare: "true" } }, settingsPath(stateDir));
  client = new SuperagentClient({ stateDir });
});
afterEach(async () => {
  await work?.close();
  work = undefined;
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

/** A ticket accepted from a local request, whose first Assignment is pending. */
function ticket(text: string, name: string) {
  const { triggerId } = client.request(text);
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: text, scope: "x", reason: "asked", name, evalId: candidate.evalId });
  const found = client.store.tickets.get(ticketId!)!;
  return { ticket: found, assignmentId: latestAssignment(found)!.id };
}

async function start(credential?: string): Promise<VmWork> {
  const gh = join(stateDir, "agent-gh");
  writeFileSync(gh, "#!/bin/sh\necho gho_agent\n");
  chmodSync(gh, 0o755);
  work = new VmWork({ client, stateDir, deployment: () => testDeployment({ stateDir, github: { cli: gh, login: "agent-bot", noreply: "7+agent-bot@users.noreply.github.com" } }),
    environment: (found) => ({ SWARM_TICKET_ID: found.id }),
    credential: async () => credential ? { token: credential, login: "alice-gh", id: 7 } : undefined, log: () => {} }, undefined, control(), cluster());
  await work.start();
  return work;
}

const token = (slot: number): string => readFileSync(join(stateDir, "vm", String(slot), "token"), "utf8");
const call = async (slot: number, method: string, path: string, secret: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port + slot}${path}`, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

test("a slot boots a ticket with a token of its own, and its gateway takes that token alone", async () => {
  const vm = await start();
  const { ticket: first, assignmentId } = ticket("add a NOTICE file", "add-notice");
  assert.equal(await vm.run(first, assignmentId), true);
  assert.deepEqual(calls, ["start 0"]);
  assert.equal(readFileSync(join(stateDir, "vm", "0", "ticket"), "utf8").trim(), first.id);
  assert.ok(vm.holds(first.id, assignmentId));
  assert.equal((await call(0, "GET", "/v1/spec", "wrong")).status, 401);
  // Another slot's gateway does not take this slot's token.
  assert.equal((await call(1, "GET", "/v1/spec", token(0))).status, 401);
  const spec = (await call(0, "GET", "/v1/spec", token(0))).body as unknown as GuestSpec;
  assert.equal(spec.ticketId, first.id);
  assert.equal(spec.assignmentId, assignmentId);
  assert.equal(spec.prepare, "true");
  assert.equal(spec.variables.SWARM_TICKET_ID, first.id);
  assert.ok(spec.providers["local-test"], "the providers Swarm's models use");
  // A ticket that keeps its work local gets no GitHub account; one without the access model works as the agent.
  assert.equal(spec.accounts, "none");
  assert.equal((await call(0, "GET", "/v1/github", token(0))).status, 403);
  writeSettings({ executor: { isolation: "vm", vm: { slots: 2, port }, prepare: "true" } }, settingsPath(stateDir));
  const agent = ticket("add a VERSION file", "add-version");
  await vm.run(agent.ticket, agent.assignmentId);
  assert.equal(((await call(1, "GET", "/v1/spec", token(1))).body as unknown as GuestSpec).accounts, "agent");
  assert.deepEqual((await call(1, "GET", "/v1/github", token(1))).body, { token: "gho_agent", login: "agent-bot" });
  // A guest in a VM points Swarm at the gateway, without the host's headers or keys.
  const settings = guestSettings(spec, { url: "http://10.0.2.2:47100", token: "t" }) as { providers: Record<string, Record<string, unknown>> };
  assert.equal(settings.providers["local-test"]?.baseURL, "http://10.0.2.2:47100/v1/model/local-test");
  assert.equal(settings.providers["local-test"]?.apiKeyEnv, "SWARM_GUEST_TOKEN");
  assert.equal(settings.providers["local-test"]?.headers, undefined);
});

test("the guest starts the Assignment, renews its lease, and lets the slot go once its worker exited", async () => {
  const vm = await start();
  const { ticket: first, assignmentId } = ticket("add a NOTICE file", "add-notice");
  await vm.run(first, assignmentId);
  const secret = token(0);
  assert.deepEqual((await call(0, "POST", "/v1/work/started", secret, { directory: "/home/swarm/work/add-notice" })).body, { started: true });
  assert.equal(client.store.tickets.get(first.id)!.assignments.at(-1)!.state, "running");
  assert.equal(client.store.get(KV.vm.slot("0"))?.directory, "/home/swarm/work/add-notice");
  assert.deepEqual((await call(0, "POST", "/v1/work/heartbeat", secret)).body, { live: true });
  const view = (await call(0, "GET", "/v1/work", secret)).body.view as { ticket: { id: string } };
  assert.equal(view.ticket.id, first.id);
  await call(0, "POST", "/v1/work/exited", secret, { code: 0, stderr: "" });
  assert.equal(client.store.get(KV.vm.slot("0"))?.tokenHash, "");
  assert.ok(!vm.holds(first.id, assignmentId));
  assert.deepEqual(calls, ["start 0", "stop 0"]);
  // The token went with the lease.
  assert.equal((await call(0, "GET", "/v1/work", secret)).status, 401);
});

test("the slot that ran a ticket boots it again, others go to free slots, and a full house waits", async () => {
  const vm = await start();
  const a = ticket("add a NOTICE file", "add-notice");
  const b = ticket("add a VERSION file", "add-version");
  const c = ticket("add a LICENSE file", "add-license");
  await vm.run(a.ticket, a.assignmentId);
  await vm.run(b.ticket, b.assignmentId);
  await assert.rejects(vm.run(c.ticket, c.assignmentId), Later);
  await vm.release(0);
  await vm.release(1);
  client.engine.stopTicket(b.ticket.id);
  // The NOTICE ticket is idle with its VM off, so the free slot that ran it is kept for it; the VERSION ticket ended.
  await vm.run(c.ticket, c.assignmentId);
  assert.equal(readFileSync(join(stateDir, "vm", "1", "ticket"), "utf8").trim(), c.ticket.id, "the slot of the ticket that ended");
  await vm.run(a.ticket, a.assignmentId);
  assert.equal(readFileSync(join(stateDir, "vm", "0", "ticket"), "utf8").trim(), a.ticket.id);
});

test("a VM that keeps stopping before its worker starts fails the ticket after three boots, and a lapsed boot launches again", async () => {
  const vm = await start();
  const { ticket: first, assignmentId } = ticket("add a NOTICE file", "add-notice");
  for (let boot = 0; boot < 3; boot++) {
    await vm.run(first, assignmentId);
    const record = client.store.get(KV.vm.slot("0"))!;
    // The boot's lease runs out, as when the VM never reached its gateway.
    client.store.set(KV.vm.slot("0"), { ...record, expiresAt: new Date(Date.now() - 1).toISOString() });
    client.store.db.prepare("DELETE FROM effect").run();
    (vm as unknown as { lapse(): void }).lapse();
    assert.equal(client.store.get(KV.vm.slot("0"))?.tokenHash, "");
    assert.ok(client.store.db.prepare("SELECT 1 FROM effect WHERE kind = 'launch' AND key = ?").get(assignmentId), "the pending Assignment launches again");
  }
  await assert.rejects(vm.run(first, assignmentId), /stopped 3 times before its worker started/);
});

test("a ticket that ended marks its disk for deletion, and a requester whose link stopped working gets no VM", async () => {
  const vm = await start();
  const collect = () => (vm as unknown as { collect(): void }).collect();
  const { ticket: first, assignmentId } = ticket("add a NOTICE file", "add-notice");
  const never = ticket("add a LICENSE file", "add-license");
  await vm.run(first, assignmentId);
  collect();
  assert.ok(!existsSync(join(stateDir, "vm", "ended", first.id)), "an open ticket keeps its disk");
  // Another process, such as a terminal, ends the ticket: the next sweep marks its disk, once.
  const other = new SuperagentClient({ stateDir });
  other.engine.stopTicket(first.id);
  other.engine.stopTicket(never.ticket.id);
  other.close();
  collect();
  assert.ok(existsSync(join(stateDir, "vm", "ended", first.id)));
  assert.ok(!existsSync(join(stateDir, "vm", "ended", never.ticket.id)), "a ticket that never booted has no disk");
  assert.deepEqual(calls.filter((item) => item === "collect"), ["collect"]);
  collect();
  assert.deepEqual(calls.filter((item) => item === "collect"), ["collect"]);
  calls.length = 0;
  client.store.set(KV.links.github("local", localOperator()), { login: "alice-gh", id: 7, repos: ["owner/watched"], reposAt: "", linkedAt: "",
    access: { iv: "", data: "", tag: "" } });
  const linked = ticket("add a VERSION file", "add-version");
  assert.ok(linked.ticket.mandate.capability?.credential);
  assert.equal(await vm.run(linked.ticket, linked.assignmentId), false);
  assert.deepEqual(calls.filter((item) => item.startsWith("start")), [], `the stopped ticket was ${assignmentId}'s`);
});

test("the model proxy forwards a worker's calls with the host's provider and refuses what Swarm's provider and OpenCode never send", async () => {
  const vm = await start();
  const { ticket: first, assignmentId } = ticket("add a NOTICE file", "add-notice");
  await vm.run(first, assignmentId);
  const secret = token(0);
  const before = model.requests.length;
  const answer = await call(0, "POST", "/v1/model/local-test/chat/completions", secret, { model: "model", messages: [{ role: "user", content: "ping" }] });
  assert.equal(answer.status, 200);
  assert.equal((answer.body.choices as { message: { content: string } }[])[0]?.message.content, "pong");
  assert.equal(model.requests.length, before + 1);
  // A streamed call, as OpenCode makes, is relayed as it comes, asked for its usage, and counted under the ticket's worker.
  const streamed = await fetch(`http://127.0.0.1:${port}/v1/model/local-test/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "ping" }], stream: true }) });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await streamed.text();
  assert.match(events, /"content":"pong"/);
  assert.match(events, /data: \[DONE\]/);
  assert.deepEqual(model.requests.at(-1)?.body.stream_options, { include_usage: true });
  const { DatabaseSync } = await import("node:sqlite");
  const ledger = new DatabaseSync(join(swarmHome, "state", "swarm.db"), { readOnly: true });
  const counted = ledger.prepare("SELECT count(*) AS n FROM usage_events WHERE session_id = ? AND kind = 'llm_call' AND unit = 'count'").get(`worker-${first.id}`) as { n: number };
  ledger.close();
  assert.equal(counted.n, 2, "both calls are in the ledger");
  const callsBefore = model.requests.length;
  assert.equal((await call(0, "POST", "/v1/model/local-test/chat/completions", secret, { model: "model", messages: [], background: true })).status, 400);
  assert.equal((await call(0, "POST", "/v1/model/local-test/models", secret, {})).status, 403);
  assert.equal((await call(0, "POST", "/v1/model/nowhere/chat/completions", secret, {})).status, 404);
  assert.equal((await call(0, "POST", "/v1/model/local-test/chat/completions", "wrong", {})).status, 401);
  assert.equal(model.requests.length, callsBefore, "nothing refused reached the provider");
});

test("a ticket on an OpenCode profile runs in a VM, whose spec carries the profile without its command or keys; other harnesses do not", async () => {
  writeSettings({ executor: { isolation: "vm", vm: { slots: 2, port }, prepare: "true",
    harnesses: { "opencode-ds": { kind: "opencode", command: "/opt/opencode", model: "local-test/model", keys: { LOCAL_TEST_API_KEY: "HOST_SECRET" } } } } }, settingsPath(stateDir));
  const vm = await start();
  const filed = (text: string, harness: string) => {
    const { triggerId } = client.request(text, undefined, { harness });
    client.engine.evaluateDue();
    const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: text, scope: "x", reason: "asked", name: harness, evalId: client.engine.candidate(triggerId)!.evalId });
    const found = client.store.tickets.get(ticketId!)!;
    return { ticket: found, assignmentId: latestAssignment(found)!.id };
  };
  const open = filed("add a NOTICE file", "opencode-ds");
  assert.equal(open.ticket.execution?.harness, "opencode-ds");
  assert.equal(await vm.run(open.ticket, open.assignmentId), true);
  const spec = (await call(0, "GET", "/v1/spec", token(0))).body as unknown as GuestSpec;
  assert.deepEqual(spec.harness, { id: "opencode-ds", profile: { kind: "opencode", model: "local-test/model", args: [], env: {}, keys: {} } });
  assert.equal(spec.model, "local-test/model");
  const claude = filed("add a VERSION file", "claude");
  await assert.rejects(vm.run(claude.ticket, claude.assignmentId), /Ticket VMs run Swarm's own coding loop and OpenCode, not claude/);
  assert.deepEqual(vmHarnessIds({}), ["opencode"]);
});

test("OpenCode in a VM calls Swarm's chat-completions providers at the gateway with the slot's token, and refuses a model it cannot call", () => {
  const gateway = { url: "http://10.0.2.2:47100", token: "slot-token" };
  const providers = {
    deepseek: { id: "deepseek", name: "DeepSeek", protocol: "openai-chat-completions", baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", apiKeyRequired: true, auth: "bearer", models: {} },
    other: { id: "other", name: "Other", protocol: "openai-chat-completions", baseURL: "https://other.example", apiKeyEnv: "OTHER_API_KEY", apiKeyRequired: true, auth: "bearer", models: {} },
    claude: { id: "claude", name: "Claude", protocol: "anthropic-messages", baseURL: "https://anthropic.example", apiKeyEnv: "A_KEY", apiKeyRequired: true, auth: "x-api-key", models: {} }
  } as GuestSpec["providers"];
  const models = { defaultProvider: "deepseek", planner: "", worker: "deepseek-flash", aggregator: "", apiKeyEnv: "", maxOutputTokens: null } as GuestSpec["models"];
  const { config, auth } = opencodeConfig({ providers, models, model: "deepseek-flash",
    harness: { id: "opencode", profile: { kind: "opencode", model: "other/big", args: [], env: {}, keys: {} } } }, gateway);
  assert.equal(config.model, "deepseek/deepseek-flash");
  assert.deepEqual(config.provider, {
    deepseek: { options: { baseURL: "http://10.0.2.2:47100/v1/model/deepseek", includeUsage: true }, models: { "deepseek-flash": { name: "deepseek-flash" } } },
    other: { npm: "@ai-sdk/openai-compatible", name: "Other through Swarm", options: { baseURL: "http://10.0.2.2:47100/v1/model/other", includeUsage: true },
      models: { big: { name: "big" } } }
  });
  assert.deepEqual(auth, { deepseek: { type: "api", key: "slot-token" }, other: { type: "api", key: "slot-token" } });
  assert.throws(() => opencodeConfig({ providers, models, model: "claude/sonnet" }, gateway), /chat completions, and claude\/sonnet uses anthropic-messages/);
});

test("a full house spills over to the cluster, where a ticket stays for good, and its volume goes when it ends", async () => {
  writeSettings({ executor: { isolation: "vm", vm: { slots: 1, port, kube: { slots: 2, port: port + 10 } }, prepare: "true" } }, settingsPath(stateDir));
  const vm = await start();
  const a = ticket("add a NOTICE file", "add-notice");
  const b = ticket("add a VERSION file", "add-version");
  const c = ticket("add a LICENSE file", "add-license");
  const d = ticket("add a README file", "add-readme");
  await vm.run(a.ticket, a.assignmentId);
  await vm.run(b.ticket, b.assignmentId);
  await vm.run(c.ticket, c.assignmentId);
  await assert.rejects(vm.run(d.ticket, d.assignmentId), Later);
  assert.deepEqual(calls, ["start 0", `cluster start 0 ${b.ticket.id}`, `cluster start 1 ${c.ticket.id}`]);
  // A cluster slot's gateway listens on the cluster's port for it and takes the token its pod got, which no file holds.
  const spec = await fetch(`http://127.0.0.1:${port + 10}/v1/spec`, { headers: { authorization: `Bearer ${tokens.get(0)}` } });
  assert.equal(((await spec.json()) as GuestSpec).ticketId, b.ticket.id);
  assert.equal((await fetch(`http://127.0.0.1:${port + 11}/v1/spec`, { headers: { authorization: `Bearer ${tokens.get(0)}` } })).status, 401);
  assert.ok(!existsSync(join(stateDir, "vm", "1")));
  (vm as unknown as { guard(): void }).guard();
  assert.equal(calls.at(-1), "cluster guard", "running cluster VMs keep their egress rules current");
  // With this host's slot free, the VERSION ticket's follow-up still boots in the cluster, where its disk is.
  await vm.release(0);
  await vm.release(1);
  assert.deepEqual(calls.slice(-2), ["stop 0", "cluster stop 0"]);
  calls.length = 0;
  await vm.run(b.ticket, b.assignmentId);
  await vm.run(d.ticket, d.assignmentId);
  assert.deepEqual(calls, [`cluster start 0 ${b.ticket.id}`, "start 0"]);
  // The ended ticket's volume is deleted in the cluster, and no local disk is marked for it.
  client.engine.stopTicket(b.ticket.id);
  await vm.release(1);
  (vm as unknown as { collect(): void }).collect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes(`cluster discard ${b.ticket.id}`));
  assert.equal(client.store.get(KV.vm.cluster(b.ticket.id)), undefined);
  assert.equal(client.store.get(KV.vm.disk(b.ticket.id)), undefined);
  assert.ok(!existsSync(join(stateDir, "vm", "ended", b.ticket.id)));
});
