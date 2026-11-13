/**
 * Pulling work across the mesh, end to end with no paid model: an owner node whose only worker slot a held ticket keeps
 * busy, two runner nodes that pull when told to, and a ghost that claims work and goes silent. Each is a real superagent
 * host and mesh server on localhost (the ghost a mesh server only), with a scripted OpenAI-compatible model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import type { Ticket } from "../superagent/core/index.js";
import type { SuperagentHost } from "../superagent/host.js";
import { KV } from "../superagent/kv.js";
import { settingsPath, updateSettings, writeSettings } from "../superagent/settings.js";
import { startFakeModel, writeFakeModelHome, type ModelRequest } from "../superagent/testing/fake-model.js";
import { ticketRow } from "../superagent/views.js";
import { nodeCard, type NodeCard } from "./card.js";
import { callPeer, joinMesh, type MeshError } from "./client.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, readMesh, updateMesh, type Pull } from "./state.js";
import { MeshWork, unfit, type OpenWork } from "./work.js";
import { workPath } from "./work-link.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "swarm-mesh-pull-"));
const saved = process.env.SWARM_HOME;
const workerCommand = [process.execPath, "--import", import.meta.resolve("tsx"), join(repo, "src/index.ts")];

interface TestNode { name: string; host: SuperagentHost; server: MeshServer; url: string; mesh: string; state: string; logs: string[] }
let model: Awaited<ReturnType<typeof startFakeModel>>;
let ovh: TestNode;
let gpu: TestNode;
let mac: TestNode;
let ghost: { server: MeshServer; mesh: string; offers: Record<string, unknown>[] };

let releaseHog = (): void => {};
const hogReleased = new Promise<void>((resolve) => { releaseHog = resolve; });

const loop = (result: Record<string, unknown>) => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...result });
const reported = (request: ModelRequest) => request.user.includes("\"reported\":true") || request.user.includes("\\\"reported\\\":true");

/**
 * The router accepts every request; the request for two.txt needs a GPU, and the one for seven.txt CUDA. The held ticket's worker waits until the test
 * releases it, so the owner's only slot stays busy. Every other worker writes its file, reports it ready and ends its turn.
 */
async function answer(request: ModelRequest): Promise<string> {
  if (request.system.includes("You route requests for Swarm's ticket host")) {
    if (request.user.includes("hold the slot")) return JSON.stringify({ kind: "accept", title: "Hold the slot", worktree_name: "hold-slot", acknowledgement: "On it: holding the slot." });
    const file = /write (\w+)\.txt/.exec(request.user)?.[1] ?? "unknown";
    return JSON.stringify({ kind: "accept", title: `Write ${file}.txt`, worktree_name: `write-${file}`, acknowledgement: `On it: writing ${file}.txt.`,
      ...(file === "two" ? { needs: ["gpu"] } : file === "seven" ? { needs: ["cuda"] } : {}) });
  }
  if (request.system.includes("hold-slot-")) {
    if (reported(request)) return loop({ status: "completed", summary: "Done", message: "Released the slot." });
    await hogReleased;
    return loop({ status: "continue", summary: "Report", message: "Reporting.", tool_calls: [
      { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: "Held the slot.", message_for_person: "Done holding the slot." } }
    ] });
  }
  const file = `${/write-(\w+)-/.exec(request.system)?.[1] ?? "unknown"}.txt`;
  if (!/"action":\s*"Write"[\s\S]*"status":\s*"success"/.test(request.user)) {
    return loop({ status: "continue", summary: "Write the file", message: `Writing ${file}.`, tool_calls: [
      { id: "write", action: "Write", inputs: { file_path: file, content: "hi\n" } }
    ] });
  }
  if (!reported(request)) {
    return loop({ status: "continue", summary: "Report", message: "Reporting.", tool_calls: [
      { id: "report", action: "mcp__ticket__report", inputs: { state: "ready", summary: `Wrote ${file}.`, message_for_person: `${file} is ready.` } }
    ] });
  }
  return loop({ status: "completed", summary: "Done", message: `${file} is written and reported.`, files_touched: [file] });
}

/** A node on a free localhost port: a superagent host whose MeshWork pulls when its mesh state says so, and its mesh server. */
async function startNode(name: string, abilities: string[], settings?: unknown): Promise<TestNode> {
  const mesh = join(root, `${name}-mesh`);
  const state = join(root, `${name}-superagent`);
  updateMesh((current) => ({ ...current, node: { ...current.node, name, listen: "127.0.0.1:0" } }), mesh);
  if (settings) writeSettings(settings, settingsPath(state));
  const [{ SuperagentHost }, { OpenAIProvider }] = await Promise.all([import("../superagent/host.js"), import("../providers/openai-provider.js")]);
  const provider = new OpenAIProvider();
  const host = new SuperagentHost({
    stateDir: state, workerCommand, log: () => {},
    complete: ({ purpose, system, user }) => provider.generateText({ model: provider.workerModel, system: [{ text: system }], user,
      responseFormat: "json_object", maxOutputTokens: 2000, usage: { purpose } })
  });
  const logs: string[] = [];
  const work = new MeshWork(host, { home: mesh, abilities, workerCommand, leaseMs: 1500, heartbeatMs: 300, pullMs: 150, log: (line) => logs.push(line) });
  await host.start();
  const server = new MeshServer({ home: mesh, card: () => nodeCard(readMesh(mesh).node, { abilities, load: work.load() }) });
  work.serve(server);
  const { address: url } = await server.start();
  updateMesh((current) => ({ ...current, node: { ...current.node, advertise: url } }), mesh);
  return { name, host, server, url, mesh, state, logs };
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, ms = 100_000, every = 200): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const setPull = (node: { mesh: string }, pull: Partial<Pull>) =>
  updateMesh((state) => ({ ...state, node: { ...state.node, pull: { ...state.node.pull, ...pull } } }), node.mesh);
const ownerFrom = (node: { mesh: string }) => findPeer(readMesh(node.mesh), "ovh");
const openWork = async () => (await callPeer<{ work: OpenWork[] }>(ownerFrom(gpu), "GET", "/mesh/v1/work/open")).work;
const waitingNamed = (title: string) => until(async () => (await openWork()).find((work) => work.title === title));
const claim = (node: { mesh: string }, work: Pick<OpenWork, "ticketId" | "assignmentId">) =>
  callPeer(ownerFrom(node), "POST", "/mesh/v1/work/claims", { ticketId: work.ticketId, assignmentId: work.assignmentId });
const find = (title: string): Ticket | undefined => ovh.host.client.store.tickets.list().find((ticket) => ticket.title === title);
const ended = (title: string) => until(() => find(title)?.ended ? find(title) : undefined);
const pulled = (title: string) => ovh.host.client.store.get(KV.mesh.placement(find(title)!.id))?.pulled?.name;
const remoteDirectory = (node: TestNode, ticket: Ticket) => join(node.state, "remote", readMesh(ovh.mesh).node.id, "work", ticket.execution!.name);

before(async () => {
  process.env.SWARM_HOME = root;
  model = await startFakeModel(answer);
  writeFakeModelHome(root, model.url);
  ovh = await startNode("ovh", ["linux"], { executor: { maxWorkers: 1 } });
  gpu = await startNode("gpu", ["linux", "gpu"]);
  mac = await startNode("mac", ["macos"]);
  await joinMesh(createInvite(ovh.url, 15, ovh.mesh), gpu.mesh);
  await joinMesh(createInvite(ovh.url, 15, ovh.mesh), mac.mesh);

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

  ovh.host.client.request("hold the slot until the test is done");
  await until(() => find("Hold the slot")?.assignments.at(-1)?.state === "running" ? true : undefined);
});
after(async () => {
  releaseHog();
  for (const node of [ovh, gpu, mac]) {
    await node?.server.stop();
    await node?.host.stop();
  }
  await ghost?.server.stop();
  await model?.close();
  if (saved === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

test("a node takes work it has the abilities for, of the repositories it pulls", () => {
  const work = { needs: ["gpu"], repository: "acme/app" };
  assert.equal(unfit(work, ["linux", "gpu"], []), undefined);
  assert.equal(unfit(work, ["linux", "gpu"], ["acme/app", "acme/web"]), undefined);
  assert.match(unfit(work, ["macos"], []) ?? "", /lacks gpu/);
  assert.match(unfit(work, ["linux", "gpu"], ["acme/web"]) ?? "", /pulls only work of acme\/web/);
});

test("with the owner's slots full, a node that pulls takes a queued ticket, runs it in its own directory, and it completes through the owner", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("write one.txt containing hi");
  const waiting = await waitingNamed("Write one.txt");
  assert.deepEqual([waiting.repository, waiting.needs, waiting.assignmentId], ["", [], find("Write one.txt")!.assignments.at(-1)!.id]);

  setPull(mac, { enabled: true });
  const ticket = await ended("Write one.txt");
  setPull(mac, { enabled: false });
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.equal(ticket.assignments.length, 1);
  assert.equal(readFileSync(join(remoteDirectory(mac, ticket), "one.txt"), "utf8"), "hi\n", "the worker wrote in the puller's own directory");
  assert.ok(!existsSync(ticket.execution!.directory), "the owner never started it");
  const row = ticketRow(client, ticket);
  assert.deepEqual([row.pulledBy, row.runsOn], ["mac", "mac"]);
  assert.ok(mac.logs.some((line) => line.includes("pulled ticket") && line.includes("Write one.txt")));
  assert.equal(find("Hold the slot")?.assignments.at(-1)?.state, "running", "the owner's only slot stayed busy");
  const replies = client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all().map((item) => JSON.parse(String(item.value)) as { text: string });
  assert.ok(replies.some((reply) => reply.text === "one.txt is ready."));
});

test("nothing is pulled while pulling is off, by a node that lacks what the work needs, or one that pulls other repositories", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("write two.txt containing hi");
  client.request("write three.txt containing hi");
  const two = await waitingNamed("Write two.txt");
  await waitingNamed("Write three.txt");
  assert.deepEqual(two.needs, ["gpu"]);

  setPull(mac, { enabled: true, repositories: ["acme/other"] });
  const card = await callPeer<NodeCard>(findPeer(readMesh(ovh.mesh), "mac"), "GET", "/mesh/v1/node");
  assert.deepEqual(card.pull, { repositories: ["acme/other"] }, "the card says it pulls");
  await sleep(2500);
  assert.equal(pulled("Write two.txt"), undefined, "the GPU node fits it, but does not pull");
  assert.equal(pulled("Write three.txt"), undefined, "mac pulls only acme/other");

  setPull(mac, { repositories: [] });
  await until(() => pulled("Write three.txt") === "mac" ? true : undefined, 20_000);
  await sleep(1500);
  assert.equal(pulled("Write two.txt"), undefined, "mac has no GPU");
  assert.ok((await openWork()).some((work) => work.title === "Write two.txt"), "it is still open");
  await assert.rejects(claim(mac, two), (error: MeshError) => error.status === 409 && /mac cannot take ticket .*: it lacks gpu/.test(error.message));
  setPull(mac, { enabled: false });

  // The owner decides too: a node that keeps its work shows none and takes no claim.
  setPull(ovh, { offer: false });
  await assert.rejects(openWork(), (error: MeshError) => error.status === 403 && /does not hand its waiting work/.test(error.message));
  await assert.rejects(claim(gpu, two), (error: MeshError) => error.status === 403);
  setPull(ovh, { offer: true });

  setPull(gpu, { enabled: true });
  const done = await ended("Write two.txt");
  setPull(gpu, { enabled: false });
  assert.equal(done.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(done.ended)} report: ${JSON.stringify(done.assignments.at(-1)?.report)}`);
  assert.equal(ticketRow(client, done).pulledBy, "gpu");
  assert.equal(readFileSync(join(remoteDirectory(gpu, done), "two.txt"), "utf8"), "hi\n");
  assert.equal(ticketRow(client, await ended("Write three.txt")).pulledBy, "mac");
});

test("of two nodes that claim the same Assignment, exactly one gets it", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("write five.txt containing hi");
  const waiting = await waitingNamed("Write five.txt");
  const results = await Promise.allSettled([claim(gpu, waiting), claim(mac, waiting)]);
  const winners = [gpu, mac].filter((_, index) => results[index]!.status === "fulfilled");
  const refusals = results.flatMap((result) => result.status === "rejected" ? [result.reason as MeshError] : []);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.status, 409);
  assert.match(refusals[0]!.message, /no longer open/);

  const [winner] = winners;
  const loser = winner === gpu ? mac : gpu;
  const ticket = await ended("Write five.txt");
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.equal(ticket.assignments.length, 1);
  assert.equal(ticketRow(client, ticket).pulledBy, winner!.name);
  assert.ok(existsSync(join(remoteDirectory(winner!, ticket), "five.txt")));
  assert.ok(!existsSync(remoteDirectory(loser, ticket)), "the other node never prepared it");
});

test("a pulled ticket whose node stops renewing its lease is placed again", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("write four.txt containing hi");
  const waiting = await waitingNamed("Write four.txt");
  await claim(ghost, waiting);
  assert.equal(ghost.offers.length, 1, "the ghost got the work");
  assert.equal(pulled("Write four.txt"), "ghost");

  await until(() => find("Write four.txt")!.assignments.length === 2 ? true : undefined, 30_000);
  setPull(gpu, { enabled: true });
  const ticket = await ended("Write four.txt");
  setPull(gpu, { enabled: false });
  const [first, second] = ticket.assignments;
  assert.ok(first?.startedAt, "it ran on the ghost");
  assert.equal(first?.endedReason, "hostRestarted", "the lapsed lease interrupted it like a lost worker");
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(second?.report)}`);
  assert.equal(client.store.get(KV.mesh.placement(ticket.id))?.pulled?.assignmentId, second?.id);
  assert.equal(ticketRow(client, ticket).pulledBy, "gpu");
});

test("a claim that races with the owner's executor starting the work loses, and the work runs once, on the owner", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  client.request("write six.txt containing hi");
  const waiting = await waitingNamed("Write six.txt");
  // A slow prepare command keeps the owner's launch of it in flight while the claim arrives.
  updateSettings((settings) => ({ ...settings, executor: { ...settings.executor, prepare: "sleep 2" } }), settingsPath(ovh.state));
  releaseHog();
  await until(() => client.effects.running("launch", waiting.assignmentId) ? true : undefined, 60_000, 50);
  await assert.rejects(claim(gpu, waiting), (error: MeshError) => error.status === 409 && /no longer open/.test(error.message));

  const ticket = await ended("Write six.txt");
  assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
  assert.equal(ticket.assignments.length, 1);
  assert.equal(readFileSync(join(ticket.execution!.directory, "six.txt"), "utf8"), "hi\n", "it ran on the owner");
  assert.equal(client.store.get(KV.mesh.placement(ticket.id))?.pulled, undefined);
  assert.equal(ticketRow(client, ticket).runsOn, undefined);
});

test("work that needs what the owner lacks waits for a busy node that has it, pulling or not, and runs on the owner once no such node is reachable", { timeout: 120_000 }, async () => {
  const { client } = ovh.host;
  // A node with CUDA that pulls but has no free slot, so placement cannot hand it the work.
  const mesh = join(root, "busy-mesh");
  updateMesh((current) => ({ ...current, node: { ...current.node, name: "busy", listen: "127.0.0.1:0" } }), mesh);
  const server = new MeshServer({ home: mesh, card: () => nodeCard(readMesh(mesh).node, { abilities: ["linux", "cuda"], load: { running: 1, queued: 0, slots: 1 } }) });
  const { address: url } = await server.start();
  try {
    updateMesh((current) => ({ ...current, node: { ...current.node, advertise: url } }), mesh);
    await joinMesh(createInvite(ovh.url, 15, ovh.mesh), mesh);
    setPull({ mesh }, { enabled: true });

    client.request("write seven.txt containing hi");
    const waiting = await waitingNamed("Write seven.txt");
    assert.deepEqual(waiting.needs, ["cuda"]);
    await sleep(3000);
    assert.equal(find("Write seven.txt")!.assignments.at(-1)?.state, "pending", "the owner, whose slot is free, does not run it");
    assert.ok((await openWork()).some((work) => work.title === "Write seven.txt"));

    setPull({ mesh }, { enabled: false });
    await sleep(6000);
    assert.equal(find("Write seven.txt")!.assignments.at(-1)?.state, "pending", "with pulling off it waits for a free slot on the busy node");

    await server.stop();
    const ticket = await ended("Write seven.txt");
    assert.equal(ticket.ended?.outcome, "completed", `ticket ended: ${JSON.stringify(ticket.ended)} report: ${JSON.stringify(ticket.assignments.at(-1)?.report)}`);
    assert.equal(readFileSync(join(ticket.execution!.directory, "seven.txt"), "utf8"), "hi\n", "with no node that has CUDA reachable, it ran on the owner as before");
  } finally {
    await server.stop();
  }
});
