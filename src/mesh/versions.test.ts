import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { loadSwarmVersion } from "../runtime/headless-artifacts.js";
import { TuiMesh } from "../tui/mesh-commands.js";
import { swarmCommit } from "../update.js";
import { MESH_PROTOCOL, nodeCard, versionMismatch, type NodeCard } from "./card.js";
import { joinMesh, peerHealth } from "./client.js";
import { runMeshCommand } from "./cli.js";
import { MeshServer } from "./server.js";
import { createInvite, readMesh, updateMesh } from "./state.js";

// These nodes link up directly, and `swarm mesh status` reads no real superagent state.
process.env.SWARM_MESH_RELAY = "off";
const root = mkdtempSync(join(tmpdir(), "swarm-versions-"));
process.env.SWARM_HOME = join(root, "swarm-home");
after(() => rmSync(root, { recursive: true, force: true }));

interface TestNode { home: string; server: MeshServer; url: string }
const started: TestNode[] = [];

/** A node on a free localhost port whose card `change` alters, as a node running another Swarm would send it. */
async function startNode(name: string, change: (card: NodeCard) => NodeCard = (card) => card): Promise<TestNode> {
  const home = join(root, name);
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0" } }), home);
  const server = new MeshServer({ home, card: async () => change(await nodeCard(readMesh(home).node, { abilities: ["test"] })) });
  const { address: url } = await server.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  const node = { home, server, url };
  started.push(node);
  return node;
}

afterEach(async () => {
  for (const node of started.splice(0)) await node.server.stop();
});

async function printed(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await run(); } finally { console.log = log; }
  return lines.join("\n");
}

test("mesh status and /mesh mark the peers whose cards name another mesh protocol or Swarm version", async () => {
  const mac = await startNode("mac");
  const ovh = await startNode("ovh", (card) => ({ ...card, version: "0.2.0" }));
  const gpu = await startNode("gpu", (card) => ({ ...card, protocol: MESH_PROTOCOL + 1 }));
  const box = await startNode("box");
  for (const peer of [ovh, gpu, box]) await joinMesh(createInvite(peer.url, 15, peer.home), mac.home);

  const cards = Object.fromEntries((await peerHealth(mac.home)).map((item) => [item.peer.name, item.card!]));
  const commit = swarmCommit();
  assert.deepEqual([cards.box!.protocol, cards.box!.version, cards.box!.commit], [MESH_PROTOCOL, loadSwarmVersion(), commit], "a card names its protocol, version and commit");
  assert.equal(versionMismatch(cards.box!), undefined);
  assert.equal(versionMismatch(cards.ovh!), `runs Swarm 0.2.0, this device ${loadSwarmVersion()}: update one of them with swarm update`);

  process.env.SWARM_MESH_HOME = mac.home;
  const status = await printed(() => runMeshCommand(["status"]));
  assert.match(status, new RegExp(`^  swarm ${loadSwarmVersion().replace(/\./g, "\\.")}${commit ? ` ${commit}` : ""}, mesh protocol ${MESH_PROTOCOL}$`, "m"));
  assert.match(status, /^  ovh .*\n {19}! runs Swarm 0\.2\.0, this device .*: update one of them with swarm update$/m);
  assert.match(status, new RegExp(`^  gpu .*\\n {19}! speaks mesh protocol ${MESH_PROTOCOL + 1}, this device ${MESH_PROTOCOL}: they may not work together; update one of them with swarm update$`, "m"));
  assert.match(status, /^  box .*$/m);
  assert.doesNotMatch(status, /^  box .*\n {19}!/m, "a peer like this one is not marked");

  const json = JSON.parse(await printed(() => runMeshCommand(["status", "--json"]))) as { node: { protocol: number }; peers: { peer: { name: string }; mismatch?: string }[] };
  assert.equal(json.node.protocol, MESH_PROTOCOL);
  assert.deepEqual(json.peers.map((item) => [item.peer.name, !!item.mismatch]), [["ovh", true], ["gpu", true], ["box", false]]);

  const tui = new TuiMesh({ meshHome: mac.home, notify: () => {} });
  const shown = await tui.run([]);
  assert.match(shown.brief, /3 reachable now\. ovh, gpu run a different Swarm: swarm update on one side\.$/);
  assert.match(shown.detail ?? "", /^gpu .*\n {17}! speaks mesh protocol 2/m);
  assert.match(shown.detail ?? "", new RegExp(`^This device: swarm ${loadSwarmVersion().replace(/\./g, "\\.")}`, "m"));
});

test("a card from before the protocol field speaks 1, and commits are compared only when both sides know theirs", () => {
  const own = { protocol: 1, version: "0.1.0", commit: "2972b50" };
  assert.equal(versionMismatch({ version: "0.1.0" }, own), undefined, "an older card without protocol or commit");
  assert.match(versionMismatch({ version: "0.1.0" }, { ...own, protocol: 2 }) ?? "", /speaks mesh protocol 1, this device 2/);
  assert.match(versionMismatch({ protocol: 1, version: "0.1.0", commit: "a1b2c3d" }, own) ?? "", /runs Swarm at a1b2c3d, this device at 2972b50/);
  assert.equal(versionMismatch({ protocol: 1, version: "0.1.0", commit: "2972b50e" }, own), undefined, "a longer abbreviation of the same commit");
  assert.equal(versionMismatch({ protocol: 1, version: "0.1.0", commit: "a1b2c3d" }, { protocol: 1, version: "0.1.0" }), undefined);
});
