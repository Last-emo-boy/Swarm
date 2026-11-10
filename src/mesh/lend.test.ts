import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callLent, lentByPeers, meshMcpUrl } from "./borrow.js";
import { peerFetch } from "./link.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { nodeCard, type NodeCard } from "./card.js";
import { callPeer, joinMesh, type MeshError } from "./client.js";
import { lendFolders, lentTools, registerLending, stopLending } from "./lend.js";
import { MeshServer } from "./server.js";
import { createInvite, findPeer, newPairKey, readMesh, updateMesh, type Peer } from "./state.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-mesh-lend-")));
const servers: MeshServer[] = [];
const approvals: ToolApprovalRequest[] = [];
let approve = false;
let runtime: SwarmRuntime;
let gpu: { home: string; url: string; work: string; files: string };

/** A node on a free localhost port that serves what it lends. */
async function startNode(name: string): Promise<{ home: string; url: string; server: MeshServer }> {
  const home = join(root, `${name}-mesh`);
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  registerLending(server);
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  servers.push(server);
  return { home, url, server };
}

before(async () => {
  const node = await startNode("gpu");
  gpu = { ...node, work: join(root, "gpu-work"), files: join(root, "gpu-files") };
  mkdirSync(gpu.work);
  mkdirSync(gpu.files);
  writeFileSync(join(root, "secret.txt"), "not lent");
  lendFolders("shell", [gpu.work], gpu.home);
  lendFolders("files", [gpu.files], gpu.home);
  const ovh = await startNode("ovh");
  const box = await startNode("box");
  lendFolders("files", [gpu.files], box.home);

  const macHome = join(root, "mac-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "mac", advertise: "http://127.0.0.1:9" } }), macHome);
  for (const peer of [node, ovh, box]) await joinMesh(createInvite(peer.url, 15, peer.home), macHome);
  await box.server.stop();

  process.env.SWARM_HOME = join(root, "swarm-home");
  process.env.SWARM_MESH_HOME = macHome;
  mkdirSync(join(root, "mac-work"));
  const { SwarmRuntime } = await import("../runtime/runtime.js");
  runtime = new SwarmRuntime({
    workspace: join(root, "mac-work"),
    databasePath: join(root, "swarm.db"),
    approvalHandler: async (request) => { approvals.push(request); return approve; }
  });
});

after(async () => {
  runtime.dispose();
  for (const server of servers) await server.stop();
  rmSync(root, { recursive: true, force: true });
});

async function invoke(name: string, args: Record<string, unknown>) {
  const capability = (await runtime.listCapabilities()).find((item) => item.name === name);
  assert.ok(capability, `${name} is listed`);
  return runtime.invokeCapability(capability.id, args, undefined, { taskId: `lend-${name}` });
}
const answer = (result: { content?: string }) => JSON.parse(result.content ?? "{}") as Record<string, unknown>;

test("a node's card says what it lends, and a paired runtime sees the tools of each reachable lender", async () => {
  const card = await callPeer<NodeCard>(findPeer(readMesh(process.env.SWARM_MESH_HOME), "gpu"), "GET", "/mesh/v1/node");
  assert.deepEqual(card.lend, { shell: { roots: [gpu.work] }, files: { roots: [gpu.files] } });
  assert.deepEqual(lentTools(card.lend), ["shell", "list_files", "read_file", "write_file"]);

  const lent = (await runtime.listCapabilities()).filter((item) => item.providerId === "mcp:gpu");
  assert.deepEqual(lent.map((item) => [item.name, item.riskClass, item.modelVisible]).sort(), [
    ["mcp__gpu__list_files", "r2", true],
    ["mcp__gpu__read_file", "r2", true],
    ["mcp__gpu__shell", "r3", true],
    ["mcp__gpu__write_file", "r3", true]
  ]);
  const gpuServer = runtime.listMcpServers().find((server) => server.id === "gpu");
  assert.deepEqual([gpuServer?.status, gpuServer?.transport, gpuServer?.url], ["connected", "http", meshMcpUrl(readMesh(gpu.home).node.id)]);
  assert.deepEqual(runtime.listMcpServers().map((server) => server.id), ["gpu"], "ovh lends nothing and box does not answer");

  const mcp = (await runtime.listCapabilityProviders()).find((provider) => provider.providerId === "mcp");
  const skipped = mcp?.diagnostics.find((item) => item.code === "MCP_MESH_PEER_UNREACHABLE");
  assert.equal(skipped?.severity, "info");
  assert.match(skipped?.message ?? "", /box/);
});

test("a paired runtime runs commands and reads and writes files in the lent folders", async () => {
  runtime.settings.permissions.defaultMode = "full-auto";
  const ran = await invoke("mcp__gpu__shell", { command: "pwd && echo hello > note.txt" });
  assert.equal(ran.status, "success");
  assert.deepEqual([answer(ran).exit_code, String(answer(ran).stdout).trim()], [0, gpu.work]);
  assert.equal(readFileSync(join(gpu.work, "note.txt"), "utf8"), "hello\n");

  assert.equal((await invoke("mcp__gpu__write_file", { path: "notes/plan.md", content: "lent" })).status, "success");
  assert.equal(readFileSync(join(gpu.files, "notes", "plan.md"), "utf8"), "lent");
  assert.equal(answer(await invoke("mcp__gpu__read_file", { path: join(gpu.files, "notes/plan.md") })).content, "lent");
  assert.deepEqual(answer(await invoke("mcp__gpu__list_files", {})).entries, [{ name: "notes", type: "dir" }]);
});

test("a path that leaves the lent folders is refused, through a symlink too", async () => {
  runtime.settings.permissions.defaultMode = "full-auto";
  symlinkSync(root, join(gpu.files, "out"));
  symlinkSync(join(root, "planted.txt"), join(gpu.files, "dangling"));
  const refusals = [
    await invoke("mcp__gpu__read_file", { path: "../secret.txt" }),
    await invoke("mcp__gpu__read_file", { path: "out/secret.txt" }),
    await invoke("mcp__gpu__write_file", { path: "out/planted.txt", content: "x" }),
    await invoke("mcp__gpu__write_file", { path: "dangling", content: "x" }),
    await invoke("mcp__gpu__list_files", { path: "/" }),
    await invoke("mcp__gpu__shell", { command: "pwd", cwd: root })
  ];
  for (const result of refusals) {
    assert.equal(result.status, "failed");
    assert.match(result.content ?? "", /outside the lent folders/);
  }
  assert.equal(existsSync(join(root, "planted.txt")), false, "nothing was written outside");
});

test("the lent tools refuse a device that is not paired with the node", async () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stranger", version: "1" } } };
  // A stranger that knows the node's address but shares no key with it never gets past the link's TLS.
  const stranger: Peer = { id: readMesh(gpu.home).node.id, name: "gpu", key: newPairKey(), addresses: [gpu.url], pairedAt: "" };
  await assert.rejects(callPeer(stranger, "POST", "/mesh/v1/mcp", initialize), (error: MeshError) => error.status === 0 && /no longer knows this node/.test(error.message));
  const client = new Client({ name: "stranger", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(meshMcpUrl(stranger.id)), { fetch: peerFetch(() => stranger) });
  await assert.rejects(client.connect(transport, { timeout: 5000 }), /no longer knows this node/);
  await transport.close();
  const peer = findPeer(readMesh(process.env.SWARM_MESH_HOME), "gpu");
  await assert.rejects(callPeer(peer, "GET", "/mesh/v1/mcp"), (error: MeshError) => error.status === 405);
});

test("in ask mode a borrowed tool waits for approval, and a refusal runs nothing", async () => {
  runtime.settings.permissions.defaultMode = "ask";
  approvals.length = 0;
  approve = false;
  const refused = await invoke("mcp__gpu__shell", { command: "touch asked.txt" });
  assert.equal(refused.status, "failed");
  assert.match(refused.summary ?? "", /denied/);
  assert.equal(existsSync(join(gpu.work, "asked.txt")), false);
  assert.deepEqual(approvals.map((request) => [request.action, request.risk_class]), [["mcp__gpu__shell", "r3"]]);

  approve = true;
  const read = await invoke("mcp__gpu__read_file", { path: "notes/plan.md" });
  assert.equal(read.status, "success");
  assert.deepEqual(approvals.map((request) => request.action), ["mcp__gpu__shell", "mcp__gpu__read_file"], "reading a lent file asks too");
});

test("a node stops lending from its next request, and lends nothing it was not told to", async () => {
  stopLending("shell", [], gpu.home);
  const card = await callPeer<NodeCard>(findPeer(readMesh(process.env.SWARM_MESH_HOME), "gpu"), "GET", "/mesh/v1/node");
  assert.deepEqual(card.lend, { files: { roots: [gpu.files] } });
  runtime.settings.permissions.defaultMode = "full-auto";
  const stale = await invoke("mcp__gpu__shell", { command: "pwd" });
  assert.equal(stale.status, "failed");

  const ovh = await callPeer<NodeCard>(findPeer(readMesh(process.env.SWARM_MESH_HOME), "ovh"), "GET", "/mesh/v1/node");
  assert.equal(ovh.lend, undefined);
});

test("a ticket's worker borrows through its host: what each paired node lends, and a call to one of its tools", async () => {
  // The test before stopped the shell.
  lendFolders("shell", [gpu.work], gpu.home);
  const lenders = await lentByPeers(process.env.SWARM_MESH_HOME, 3000);
  const gpuLends = lenders.find((lender) => lender.node === "gpu");
  assert.deepEqual([gpuLends?.online, gpuLends?.shell, gpuLends?.files, gpuLends?.tools], [true, [gpu.work], [gpu.files], ["shell", "list_files", "read_file", "write_file"]]);
  assert.deepEqual(lenders.find((lender) => lender.node === "ovh")?.tools, []);
  assert.equal(lenders.find((lender) => lender.node === "box")?.online, false);
  const ran = await callLent("gpu", "shell", { command: "pwd" }, 10_000, process.env.SWARM_MESH_HOME) as { exit_code: number; stdout: string };
  assert.deepEqual([ran.exit_code, ran.stdout.trim()], [0, gpu.work]);
  await assert.rejects(callLent("gpu", "shell", { command: "pwd", cwd: root }, 10_000, process.env.SWARM_MESH_HOME), /gpu refused shell/);
  await assert.rejects(callLent("nowhere", "shell", { command: "pwd" }, 10_000, process.env.SWARM_MESH_HOME), /No paired node is called nowhere: the paired nodes are gpu, ovh, box/);
});
