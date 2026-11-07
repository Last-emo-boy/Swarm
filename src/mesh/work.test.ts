/**
 * Placing a ticket's worker on another node, end to end with no paid model: an owner node and a runner node on localhost,
 * each a real superagent host and mesh server, a worker process on the runner with its ticket tools' proxy, and a scripted
 * OpenAI-compatible model. A third node takes work and then goes silent, so its lease lapses. The runner also lists Claude
 * Code (a fake one on PATH) among its abilities, so work on that harness goes to it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { Ticket } from "../superagent/core/index.js";
import type { SuperagentHost } from "../superagent/host.js";
import { KV } from "../superagent/kv.js";
import { requestOn } from "../superagent/placement.js";
import { writeFakeHarnesses } from "../superagent/testing/fake-harness.js";
import { startFakeModel, writeFakeModelHome, type ModelRequest } from "../superagent/testing/fake-model.js";
import { ticketRow } from "../superagent/views.js";
import { nodeCard, type NodeCard } from "./card.js";
import { callPeer, joinMesh, MeshError } from "./client.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, newPairKey, readMesh, updateMesh, type Peer } from "./state.js";
import { fittest, MeshWork } from "./work.js";
import { workPath } from "./work-link.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "swarm-mesh-work-"));
const saved = process.env.SWARM_HOME;
const savedPath = process.env.PATH;
const fakes = writeFakeHarnesses(join(root, "bin"), join(root, "harness"));
const workerCommand = [process.execPath, "--import", import.meta.resolve("tsx"), join(repo, "src/index.ts")];

interface TestNode { host: SuperagentHost; server: MeshServer; url: string; mesh: string; state: string }
let model: Awaited<ReturnType<typeof startFakeModel>>;
let ovh: TestNode;
let gpu: TestNode;
let ghost: { server: MeshServer; mesh: string; offers: Record<string, unknown>[] };

const loop = (result: Record<string, unknown>) => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...result });
const reported = (request: ModelRequest) => request.user.includes("\"reported\":true") || request.user.includes("\\\"reported\\\":true");

/** Whether the config ticket's worker already answered the person's question, which it does once. */
let configAnswered = false;

/**
 * The router accepts every request, saying all but the training and harness note ones need a GPU. The hello.txt worker writes the file, checks
 * it and reports; the config worker reports progress and goes idle, then answers a person's question with its result.
 */
function answer(request: ModelRequest): string {
  if (request.system.includes("You route requests for Swarm's ticket host")) {
    if (request.user.includes("train")) return JSON.stringify({ kind: "accept", title: "Train the model", worktree_name: "train-model", acknowledgement: "On it: training the model." });
    if (request.user.includes("config file")) {
      return JSON.stringify({ kind: "accept", title: "Rename the config file", worktree_name: "rename-config", acknowledgement: "On it: renaming the config file.", needs: ["gpu"] });
    }
    // Last: the router sees open tickets' titles, so every later request mentions the harness note.
    if (request.user.includes("harness note")) return JSON.stringify({ kind: "accept", title: "Write the harness note", worktree_name: "harness-note", acknowledgement: "On it: writing the harness note." });
    return JSON.stringify({ kind: "accept", title: "Create hello.txt", worktree_name: "create-hello", acknowledgement: "On it: creating hello.txt.", needs: ["GPU"] });
  }
  if (request.system.includes("rename-config-")) {
    if (!request.user.includes("ready for review")) {
      if (reported(request)) return loop({ status: "completed", summary: "Waiting for review", message: "Waiting for review." });
      return loop({ status: "continue", summary: "Progress", message: "Recording progress.", tool_calls: [
        { id: "progress", action: "mcp__ticket__report", inputs: { state: "progress", summary: "Renamed the config file; the PR waits for review." } }
      ] });
    }
    if (configAnswered) return loop({ status: "completed", summary: "Answered", message: "Answered." });
    configAnswered = true;
    const asked = [...request.user.matchAll(/trigger_id\\?":\\?"([0-9a-f]{32})/g)].at(-1)?.[1] ?? "";
    return loop({ status: "continue", summary: "Answer", message: "Answering.", tool_calls: [
      { id: "ready", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Renamed the config file; ready for review.", reply_to_trigger_id: asked, message_for_person: "Yes, it is ready for review." } }
    ] });
  }
  const trigger = /trigger_id\\?":\\?"([0-9a-f]{32})/.exec(request.user)?.[1] ?? "";
  if (!request.user.includes("hello.txt was written") && !/"action":\s*"Write"[\s\S]*"status":\s*"success"/.test(request.user)) {
    return loop({ status: "continue", summary: "Write the file", message: "Writing hello.txt.", tool_calls: [
      { id: "ack", action: "mcp__ticket__ack", inputs: { trigger_id: trigger, text: "On it: writing hello.txt." } },
      { id: "write", action: "Write", inputs: { file_path: "hello.txt", content: "hi\n" } }
    ] });
  }
  if (!reported(request)) {
    return loop({ status: "continue", summary: "Verify and report", message: "Checking the file and reporting.", tool_calls: [
      { id: "check", action: "Bash", inputs: { command: "cat hello.txt" } },
      { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Wrote hello.txt; cat shows hi.", message_for_person: "hello.txt is ready." } }
    ] });
  }
  return loop({ status: "completed", summary: "Done", message: "hello.txt is written and reported.", files_touched: ["hello.txt"] });
}

/** A node on a free localhost port: a superagent host whose tickets' workers can run on its peers, and its mesh server. */
async function startNode(name: string, abilities: string[]): Promise<TestNode> {
  const mesh = join(root, `${name}-mesh`);
  const state = join(root, `${name}-superagent`);
  updateMesh((current) => ({ ...current, node: { ...current.node, name, listen: "127.0.0.1:0" } }), mesh);
  const [{ SuperagentHost }, { OpenAIProvider }] = await Promise.all([import("../superagent/host.js"), import("../providers/openai-provider.js")]);
  const provider = new OpenAIProvider();
  const host = new SuperagentHost({
    stateDir: state, workerCommand, log: () => {},
    complete: ({ purpose, system, user }) => provider.generateText({ model: provider.workerModel, system: [{ text: system }], user,
      responseFormat: "json_object", maxOutputTokens: 2000, usage: { purpose } })
  });
  const work = new MeshWork(host, { home: mesh, abilities, workerCommand, leaseMs: 1500, heartbeatMs: 300, log: () => {} });
  await host.start();
  const server = new MeshServer({ home: mesh, card: () => nodeCard(readMesh(mesh).node, { abilities, load: work.load() }) });
  work.serve(server);
  const { address: url } = await server.start();
  updateMesh((current) => ({ ...current, node: { ...current.node, advertise: url } }), mesh);
  return { host, server, url, mesh, state };
}

async function until<T>(read: () => T | undefined, ms = 100_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

before(async () => {
  process.env.SWARM_HOME = root;
  process.env.PATH = `${join(root, "bin")}:${savedPath}`;
  model = await startFakeModel(answer);
  writeFakeModelHome(root, model.url);
  ovh = await startNode("ovh", ["linux"]);
  gpu = await startNode("gpu", ["linux", "gpu", "harness:claude"]);
  await joinMesh(createInvite(ovh.url, 15, ovh.mesh), gpu.mesh);

  // A node that takes the work it is offered, says it started, and is never heard from again.
  const mesh = join(root, "ghost-mesh");
  updateMesh((current) => ({ ...current, node: { ...current.node, name: "ghost", listen: "127.0.0.1:0" } }), mesh);
  const offers: Record<string, unknown>[] = [];
  const server = new MeshServer({ home: mesh, card: () => nodeCard(readMesh(mesh).node, { abilities: ["linux"] }) });
  server.route("POST", "/mesh/v1/work/offers", ({ peer, body }) => {
    offers.push(body);
    setImmediate(() => {
      void callPeer(peer!, "POST", `${workPath(String(body.ticketId))}/started`, { assignmentId: body.assignmentId, directory: "/ghost/work" })
        .finally(() => server.stop());
    });
    return { accepted: true };
  });
  const { address: url } = await server.start();
  updateMesh((current) => ({ ...current, node: { ...current.node, advertise: url } }), mesh);
  await joinMesh(createInvite(ovh.url, 15, ovh.mesh), mesh);
  ghost = { server, mesh, offers };
});
after(async () => {
  for (const node of [ovh, gpu]) {
    await node?.server.stop();
    await node?.host.stop();
  }
  await ghost?.server.stop();
  await model?.close();
  process.env.PATH = savedPath;
  if (saved === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

test("work that needs abilities goes to the paired node that has them and the most free slots", () => {
  const card = (name: string, abilities: string[], load?: NodeCard["load"]): NodeCard =>
    ({ id: name, name, addresses: [], relayName: name, version: "0", os: "linux", arch: "x64", abilities, ...(load ? { load } : {}), at: "" });
  const cards = [
    card("mac", ["macos"], { running: 0, queued: 0, slots: 2 }),
    card("busy", ["linux", "gpu"], { running: 2, queued: 0, slots: 2 }),
    card("gpu", ["linux", "gpu"], { running: 1, queued: 0, slots: 3 }),
    card("no-host", ["linux", "gpu"])
  ];
  assert.equal(fittest(["gpu"], cards)?.name, "gpu");
  assert.equal(fittest(["macos"], cards)?.name, "mac");
  assert.equal(fittest(["windows"], cards), undefined);
});

test("a ticket that needs a GPU runs on the paired node that has one, in its directory there, and completes through its owner", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("create hello.txt containing hi");
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Create hello.txt");
  const ticket = await until(() => find()?.ended ? find() : undefined);
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.deepEqual(client.store.get(KV.mesh.placement(ticket.id))?.needs, ["gpu"]);

  const directory = join(gpu.state, "remote", readMesh(ovh.mesh).node.id, "work", ticket.execution!.name);
  assert.equal(readFileSync(join(directory, "hello.txt"), "utf8"), "hi\n", "the worker wrote in the runner's own directory");
  assert.ok(!existsSync(ticket.execution!.directory), "nothing ran in the owner's directory");
  assert.equal(gpu.host.client.store.tickets.list().length, 0, "the runner keeps no ticket of its own");
  assert.equal(ticketRow(client, ticket).runsOn, "gpu");

  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { kind: string; text: string });
  assert.deepEqual(replies.map((reply) => [reply.kind, reply.text]), [["acknowledgement", "On it: creating hello.txt."], ["reply", "hello.txt is ready."]]);
  const worker = model.requests.find((request) => request.system.includes("## Swarm superagent"));
  assert.ok(worker?.system.includes(directory), "the worker's environment names its directory on the runner");
  await until(() => client.store.get(KV.mesh.lease(ticket.id)) ? undefined : true, 10_000);
});

test("a ticket on a harness runs on the paired node that lists that harness, though the router named no needs", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("write the harness note", undefined, { harness: "claude" });
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Write the harness note");
  const ticket = await until(() => find()?.ended ? find() : undefined);
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.equal(ticket.execution?.harness, "claude");
  assert.equal(client.store.get(KV.mesh.placement(ticket.id))?.needs, undefined, "the router named none");
  assert.equal(ticketRow(client, ticket).runsOn, "gpu");

  const directory = join(gpu.state, "remote", readMesh(ovh.mesh).node.id, "work", ticket.execution!.name);
  const turns = fakes.calls().filter((call) => call.tools);
  assert.deepEqual(turns.map((call) => [call.kind, call.cwd]), [["claude", realpathSync(directory)]], "Claude Code ran there, in the runner's directory");
  assert.ok(existsSync(join(directory, "harness.txt")));
  await until(() => client.store.get(KV.mesh.lease(ticket.id)) ? undefined : true, 10_000);
});

test("a person's message wakes the idle worker on the node that holds the ticket's lease, which answers through the owner", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("rename the config file");
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Rename the config file");
  await until(() => find()?.assignments.at(-1)?.report?.state === "waiting" && find()?.assignments.at(-1)?.idleAt ? true : undefined);
  const asked = client.message(find()!.id, "is it ready for review?");
  const ticket = await until(() => find()?.ended ? find() : undefined);
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.equal(ticket.assignments.length, 1, "the same Assignment went on, on the same node");
  const input = ticket.inputs.find((item) => item.kind === "trigger" && item.triggerId === asked.triggerId);
  assert.ok(input?.kind === "trigger" && input.readAt, "the worker read the message");
  const directory = join(gpu.state, "remote", readMesh(ovh.mesh).node.id, "work", ticket.execution!.name);
  const answered = model.requests.find((request) => request.system.includes("rename-config-") && request.user.includes("ready for review"));
  assert.ok(answered?.system.includes(directory), "the woken worker ran on the runner");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((row) => JSON.parse(String(row.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "Yes, it is ready for review."));
});

test("a node that stops renewing its lease loses the work: the owner restarts the Assignment and places it again", { timeout: 60_000 }, async () => {
  const { client } = ovh.host;
  const { id, name } = findPeer(readMesh(ovh.mesh), "ghost");
  requestOn(client, "train the model on the new data", { id, name });
  const find = () => client.store.tickets.list().find((ticket) => ticket.title === "Train the model");
  const ticket: Ticket = await until(() => find()?.assignments.at(-1)?.report?.state === "failed" ? find() : undefined, 50_000);
  assert.equal(ghost.offers.length, 1, "the ghost took the first Assignment");
  const [first, second] = ticket.assignments;
  assert.ok(first?.startedAt, "it ran on the ghost");
  assert.equal(first?.endedReason, "hostRestarted", "the lapsed lease interrupted it like a lost worker");
  assert.match(second?.report?.summary ?? "", /ghost did not take the work: .*unreachable/);
  assert.equal(client.store.get(KV.mesh.lease(ticket.id)), undefined);
});

test("a node that is not paired can neither offer work nor act for a ticket, and a paired one only for the lease it holds", async () => {
  const { client } = ovh.host;
  const ticket = client.store.tickets.list().find((item) => item.title === "Train the model")!;
  const assignmentId = ticket.assignments.at(-1)!.id;
  const report = { assignmentId, report: { state: "ready", summary: "Done." } };
  // A node that shares no key with gpu or ovh never gets past their links' TLS.
  const stranger = (node: { url: string; mesh: string }): Peer => ({ id: readMesh(node.mesh).node.id, name: "stranger", key: newPairKey(), addresses: [node.url], pairedAt: "" });
  const refused = (error: MeshError): boolean => error.status === 0 && /no longer knows this node/.test(error.message);
  await assert.rejects(callPeer(stranger(gpu), "POST", "/mesh/v1/work/offers", { ticketId: ticket.id, assignmentId }), refused);
  await assert.rejects(callPeer(stranger(ovh), "POST", `${workPath(ticket.id)}/report`, report), refused);

  const ovhFromGpu = findPeer(readMesh(gpu.mesh), "ovh");
  await assert.rejects(callPeer(ovhFromGpu, "POST", `${workPath(ticket.id)}/report`, report), (error: MeshError) => error.status === 403);
  await assert.rejects(callPeer(ovhFromGpu, "POST", `${workPath(ticket.id)}/tools/report`, { assignmentId, args: { state: "ready", summary: "Done." } }),
    (error: MeshError) => error.status === 403);
  assert.deepEqual(await callPeer(ovhFromGpu, "GET", `${workPath(ticket.id)}?assignment=${assignmentId}`), { view: null });
  assert.deepEqual(await callPeer(ovhFromGpu, "POST", `${workPath(ticket.id)}/heartbeat`, { assignmentId }), { live: false });
  assert.equal(client.store.tickets.get(ticket.id)!.assignments.at(-1)!.report?.state, "failed", "nothing changed");
});
