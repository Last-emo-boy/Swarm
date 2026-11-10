/** Ticket tools that read the host's records of people and chats (people.ts), which work wherever the worker runs. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { settingsPath, writeSettings } from "./settings.js";
import { KV } from "./kv.js";
import { noticed, readMembers } from "./people.js";
import { feishuTrigger } from "./sources/feishu.js";
import { proxiedTicketTools, ticketTools } from "./ticket-tools.js";

let stateDir: string;
let client: SuperagentClient;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-ticket-tools-"));
  client = new SuperagentClient({ stateDir });
});
afterEach(() => {
  client.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a worker reads who is who and a group's latest messages from the host's records, but nobody else's direct messages", async () => {
  const { triggerId } = client.request("summarize what the team said about the release");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Summarize", scope: "x", reason: "asked", name: "summarize", evalId: candidate.evalId });
  client.store.set(KV.sources.labels("feishu"), { oc_team: "Team" });
  client.store.set(KV.feishu.chats, { oc_team: false, oc_dm: true });
  await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" }],
    bots: [{ member_id: "ou_tickey", app_id: "cli_tickey", name: "Tickey" }] }), client.store, "oc_team");
  await readMembers(async () => ({ users: [{ member_id: "ou_carol", name: "Carol" }] }), client.store, "oc_dm");
  client.engine.receive(noticed(client.store, feishuTrigger({ message_id: "om_1", chat_id: "oc_team", chat_type: "group", sender_id: "ou_alice",
    sender_type: "user", content: "ship it on Friday", create_time: String(Date.now() - 60_000), mentions: [] }, "ou_bot", "cli_bot")!));
  const tools = ticketTools(client, ticketId!);
  const run = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(args);
  const page = await run("read", { resource: "chat/oc_team", offset: 0 }) as { text: string };
  const read = JSON.parse(page.text) as { name: string; messages: { from: string; text: string }[] };
  assert.equal(read.name, "Team");
  assert.deepEqual(read.messages.map((line) => [line.from, line.text]), [["Alice", "ship it on Friday"]]);
  await assert.rejects(run("read", { resource: "chat/oc_dm", offset: 0 }), /another person's direct messages/);
  assert.deepEqual(await run("people", {}), { chats: [{ chat_id: "oc_team", name: "Team", people: 3 }, { chat_id: "oc_dm", name: "Carol", direct: true, people: 1 }] });
  assert.deepEqual(await run("people", { chat: "oc_team" }), { chat: "oc_team", name: "Team",
    people: [{ id: "ou_alice", name: "Alice" }, { id: "ou_bob", name: "Bob" }, { id: "ou_tickey", name: "Tickey", bot: true }] });
  assert.deepEqual(await run("people", { name: "bob" }), { people: [{ id: "ou_bob", name: "Bob", chats: ["Team"] }] });
  // Workers in VMs and on paired nodes get the same tool, run by the host.
  assert.ok(proxiedTicketTools(async () => ({})).some((tool) => tool.name === "people" && tool.readOnly));
});

test("a worker messages people on Feishu for its ticket, in their direct messages or a chat, at most ten times an hour", async () => {
  writeSettings({ sources: { feishu: { enabled: true, config: { cli: "lark-cli", chats: [], directMessages: true, otherChats: "mentions" } } } }, settingsPath(stateDir));
  const { triggerId } = client.request("tell Bob the release moved to Friday");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Tell Bob", scope: "x", reason: "asked", name: "tell-bob", evalId: candidate.evalId });
  client.store.set(KV.sources.labels("feishu"), { oc_team: "Team" });
  await readMembers(async () => ({ users: [{ member_id: "ou_alice", name: "Alice" }, { member_id: "ou_bob", name: "Bob" }] }), client.store, "oc_team");
  const run = (args: Record<string, unknown>) => ticketTools(client, ticketId!).find((tool) => tool.name === "message")!.run(args);
  const sent = () => client.store.db.prepare("SELECT value FROM outbox ORDER BY rowid").all()
    .map((row) => JSON.parse(String(row.value)) as { kind: string; ticketId?: string; channel: { address: Record<string, string> }; mentions?: unknown });
  assert.deepEqual(await run({ to: "Bob", text: "The release moved to Friday." }), { sent: true, to: "Bob" });
  assert.deepEqual(await run({ to: "Team", text: "@all the release moved to Friday.", mentions: ["all"] }), { sent: true, to: "Team" });
  assert.deepEqual(sent().map((item) => [item.kind, item.ticketId, item.channel.address, item.mentions ?? null]), [
    ["notice", ticketId, { userId: "ou_bob", mode: "user", direct: "true" }, null],
    ["notice", ticketId, { chatId: "oc_team", mode: "chat" }, [{ id: "all", name: "all" }]]
  ]);
  await assert.rejects(run({ to: "Carol", text: "hi" }), /No one named Carol/);
  for (let index = 0; index < 8; index++) await run({ to: "Bob", text: `Update ${index}.` });
  await assert.rejects(run({ to: "Bob", text: "One more." }), /sent 10 messages in the last hour/);
});

test("a worker keeps notes for later and looks up what the agent remembers, when its memory is on", async () => {
  const { personSubject } = await import("./memories.js");
  const { triggerId } = client.request("set up the CI");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Set up CI", scope: "x", reason: "asked", name: "set-up-ci", evalId: candidate.evalId });
  const run = (name: string, args: Record<string, unknown>) => ticketTools(client, ticketId!).find((tool) => tool.name === name)!.run(args);
  await assert.rejects(run("remember", { about: "self", text: "I set up CI with GitHub Actions" }), /memory is off/);
  writeSettings({ memory: { enabled: true } }, settingsPath(stateDir));
  assert.deepEqual(await run("remember", { about: "self", kind: "fact", text: "I set up CI with GitHub Actions" }), { remembered: true });
  assert.deepEqual(await run("remember", { about: "ou_bob", kind: "preference", text: "Bob wants CI to run on every push" }), { remembered: true });
  await assert.rejects(run("remember", { about: "requester", text: "x" }), /not someone or something here/, "a local request has no Feishu requester");
  const found = await run("recall", { query: "every push" }) as { notes: { text: string; about: string }[] };
  assert.deepEqual(found.notes.map((note) => [note.about, note.text]), [["ou_bob", "Bob wants CI to run on every push"]]);
  assert.equal(client.store.memory.about(personSubject("ou_bob"))[0]!.origin.ticketId, ticketId);
  assert.deepEqual(((await run("recall", { about: "self" })) as { notes: { text: string }[] }).notes.map((note) => note.text), ["I set up CI with GitHub Actions"]);
});

test("a worker answers what the agent runs work on from the host's devices, with the nodes' names only for a requester who may see them", async () => {
  const { triggerId } = client.request("which machines can you run work on?");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Devices", scope: "x", reason: "asked", name: "devices", evalId: candidate.evalId });
  const run = () => ticketTools(client, ticketId!).find((tool) => tool.name === "devices")!.run({});
  await assert.rejects(run(), /not read its devices yet/);
  const devices = { here: { name: "bot-vm", machine: ["linux"], harnesses: ["opencode"] },
    peers: [{ name: "mac", online: true, machine: ["macos"], harnesses: ["codex"] }],
    workers: { isolation: "vm" as const, local: { total: 4, busy: 1, free: 3 } } };
  client.store.set(KV.host.devices, { at: "2026-11-10T10:15:00.000Z", devices });
  // Without an access model everyone may see the nodes, as /devices shows them.
  assert.deepEqual(await run(), { as_of: "2026-11-10T10:15:00.000Z", this_node: devices.here, paired_nodes: devices.peers,
    ticket_workers: { runs_as: "a VM of its own for each ticket; the cluster takes tickets once this node's VMs are busy", on_this_node: devices.workers.local } });
  // Under the access model, a requester below maintainer gets counts.
  const { localOperator } = await import("./sources/local.js");
  writeSettings({ access: {}, policy: { sources: { local: { allowed: [], roles: { [localOperator()]: "everyone" } } } } }, settingsPath(stateDir));
  utimesSync(settingsPath(stateDir), new Date(), new Date(Date.now() + 2000));
  const counts = await run() as Record<string, unknown>;
  assert.deepEqual(counts.paired_nodes, { total: 1, online: 1 });
  assert.equal(counts.this_node, undefined);
  assert.ok(proxiedTicketTools(async () => ({})).some((tool) => tool.name === "devices" && tool.readOnly));
});

test("a worker uses what paired nodes lend through its host's mesh, and each call it makes is kept with its ticket", async () => {
  const { triggerId } = client.request("run kubectl get nodes on the kube node");
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Kube nodes", scope: "x", reason: "asked", name: "kube-nodes", evalId: candidate.evalId });
  const saved = process.env.SWARM_MESH_HOME;
  process.env.SWARM_MESH_HOME = join(stateDir, "mesh");
  try {
    const run = (args: Record<string, unknown>) => ticketTools(client, ticketId!).find((tool) => tool.name === "mesh")!.run(args);
    assert.deepEqual(await run({}), { nodes: [] });
    await assert.rejects(run({ node: "kube", tool: "shell", args: { command: "kubectl get nodes", timeout_ms: 600_000 } }), /No paired node is called kube/);
    const [call] = client.store.get(KV.mesh.calls(ticketId!)) ?? [];
    assert.deepEqual([call?.node, call?.tool, JSON.parse(call!.args)], ["kube", "shell", { command: "kubectl get nodes", timeout_ms: 100_000 }]);
    assert.ok(proxiedTicketTools(async () => ({})).some((tool) => tool.name === "mesh" && !tool.readOnly), "workers in VMs and on paired nodes get it too, run by the host");
  } finally {
    if (saved === undefined) delete process.env.SWARM_MESH_HOME;
    else process.env.SWARM_MESH_HOME = saved;
  }
});
