import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { loadSwarmSettings } from "../config/settings.js";
import { nodeCard } from "../mesh/card.js";
import { joinMesh } from "../mesh/client.js";
import { lendFolders, registerLending } from "../mesh/lend.js";
import { MeshServer } from "../mesh/server.js";
import { createInvite, readMesh, setGrant, updateMesh } from "../mesh/state.js";
import { createCapabilityPlane } from "./capability-plane.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-capability-plane-")));
const spawnLog = join(root, "spawns.log");
const serverPath = join(root, "counted-server.mjs");
let lender: MeshServer;
let lenderHome: string;

/** How many times the configured stdio server was started. */
const spawns = () => existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length : 0;

before(async () => {
  const sdk = (path: string) => JSON.stringify(pathToFileURL(join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", path)).href);
  writeFileSync(serverPath, [
    'import { appendFileSync } from "node:fs";',
    `import { McpServer } from ${sdk("mcp.js")};`,
    `import { StdioServerTransport } from ${sdk("stdio.js")};`,
    'appendFileSync(process.env.SPAWN_LOG, "spawn\\n");',
    "const server = new McpServer({ name: 'counted', version: '1.0.0' });",
    "server.registerTool('ping', { description: 'Ping.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));",
    "await server.connect(new StdioServerTransport());"
  ].join("\n"));
  // `gpu` is paired with `mac` and lends nothing yet.
  lenderHome = join(root, "gpu-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "gpu", listen: "127.0.0.1:0" } }), lenderHome);
  const home = lenderHome;
  lender = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  registerLending(lender);
  const { address: url } = await lender.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const macHome = join(root, "mac-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "mac", advertise: "http://127.0.0.1:9" } }), macHome);
  await joinMesh(createInvite(url, 15, home), macHome);
  setGrant("mac", "operator", home);
  process.env.SWARM_HOME = join(root, "swarm-home");
  process.env.SWARM_MESH_HOME = macHome;
});

after(async () => {
  await lender.stop();
  rmSync(root, { recursive: true, force: true });
});

test("loading borrowed servers again shows what a lender lends now and reconnects no other MCP server", async () => {
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const settings = loadSwarmSettings(workspace);
  settings.extensions.mcp.enabled = true;
  settings.extensions.mcp.servers = { counted: { transport: "stdio", command: process.execPath, args: [serverPath], env: { SPAWN_LOG: spawnLog }, trust: "user" } };
  const plane = createCapabilityPlane({ settings, workspace });
  const names = async () => (await plane.listCapabilities()).map((item) => item.name);
  try {
    assert.deepEqual((await names()).filter((name) => name.startsWith("mcp__")), ["mcp__counted__ping"]);
    await names();
    assert.equal(spawns(), 1, "a second list uses the cache");

    mkdirSync(join(root, "gpu-work"));
    lendFolders("shell", [join(root, "gpu-work")], lenderHome);
    await plane.refreshBorrowedMcp();
    const listed = await names();
    assert.ok(listed.includes("mcp__gpu__shell"), "the next list has the lender's new tool");
    assert.ok(listed.includes("mcp__counted__ping"));
    assert.equal(spawns(), 1, "the configured server kept its connection");
  } finally {
    await plane.dispose();
  }
});
