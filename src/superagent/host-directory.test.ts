/** The directory the superagent host writes and the one its router reads (host.ts), from the host's own passes and checks. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { placeableNodes } from "../directory/build.js";
import type { NodeCard } from "../mesh/card.js";
import type { PeerHealth } from "../mesh/client.js";
import { newPairKey, savePeer } from "../mesh/state.js";
import { SuperagentHost } from "./host.js";
import { KV } from "./kv.js";

const AT = "2026-11-24T10:00:00.000Z";
const card = (id: string, name: string, extra: Partial<NodeCard> = {}): NodeCard => ({
  id, name, addresses: [], relayName: name, protocol: 2, version: "0.1.0", os: "linux", arch: "x64", abilities: ["linux"], at: AT,
  yourGrant: "operator", load: { slots: 2, running: 0, queued: 0 }, ...extra
});
const online = (id: string, name: string): PeerHealth => ({ peer: { id, name, addresses: [] }, reachable: true, ms: 12, card: card(id, name) });
const offline = (id: string, name: string): PeerHealth => ({ peer: { id, name, addresses: [] }, reachable: false, error: "no answer within 3000 ms" });

let root: string;
let home: string;
let saved: string | undefined;
let host: SuperagentHost;
let calls: { purpose: string; user: string }[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "swarm-host-directory-"));
  home = join(root, "mesh");
  saved = process.env.SWARM_MESH_HOME;
  process.env.SWARM_MESH_HOME = home;
  calls = [];
  host = new SuperagentHost({ stateDir: join(root, "state"), workerCommand: [process.execPath, "-e", ""], log: () => {},
    complete: async (input) => { calls.push(input); return JSON.stringify({ kind: "ignore", reason: "only asking" }); } });
});
afterEach(async () => {
  await host.stop();
  if (saved === undefined) delete process.env.SWARM_MESH_HOME;
  else process.env.SWARM_MESH_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});
/** A paired node this host has a record of, at an address nothing listens on: no test here dials it. */
const pair = (id: string, name: string): void => { savePeer({ id, name, key: newPairKey(), addresses: ["http://127.0.0.1:9"], pairedAt: AT }, home); };

test("a mesh node whose view cannot be read lists only what its own check found running here, with why for each other profile", async () => {
  host.meshView = async () => { throw new Error("the mesh view broke"); };
  const dir = await host.directory();
  assert.deepEqual(dir.here.harnesses, []);
  assert.ok(dir.harnesses.length > 0 && dir.harnesses.every((harness) => !harness.runsOn.includes("here")), "no profile runs here unchecked");
  assert.ok(dir.harnesses.every((harness) => harness.problems.some((item) => item.node === dir.here.name)), "each says why it does not run here");
  assert.deepEqual(host.client.store.get(KV.host.directory)?.here.harnesses, []);
});

test("a pass a meeting hands the host keeps only the peers still paired, so a removed one never shows as online", async () => {
  pair("near-id", "near");
  host.notePeers([online("near-id", "near"), online("gone-id", "gone")]);
  const dir = await host.directory();
  assert.deepEqual(dir.peers.map((peer) => [peer.name, peer.online]), [["near", true]]);
  assert.deepEqual(placeableNodes(dir), ["near"]);
});

test("the router reads the written directory while its paired nodes are fresh, and one built now once they are older", async () => {
  pair("near-id", "near");
  host.notePeers([online("near-id", "near")]);
  const written = await host.directory();
  // near stops answering after the host wrote its directory.
  host.notePeers([offline("near-id", "near")]);
  const route = async (text: string) => {
    const { triggerId } = host.client.request(text);
    host.client.engine.evaluateDue();
    host.client.effects.start();
    await host.client.effects.idle("assessment");
    assert.equal(calls.at(-1)?.purpose, "superagent_route");
    assert.ok(host.client.store.triggers.disposition(triggerId)?.decisionId, "the router decided the request");
    return JSON.parse(calls.at(-1)!.user).candidate.directory.paired_nodes as { name: string; online: boolean }[];
  };

  host.client.store.set(KV.host.directory, { ...written, at: new Date(Date.now() - 10_000).toISOString() });
  assert.deepEqual((await route("which machines are online?")).map((node) => [node.name, node.online]), [["near", true]]);

  const old = new Date(Date.now() - 40_000).toISOString();
  host.client.store.set(KV.host.directory, { ...written, at: old });
  assert.deepEqual((await route("and now?")).map((node) => [node.name, node.online]), [["near", false]]);
  assert.ok(host.client.store.get(KV.host.directory)!.at > old, "the router's read wrote the directory it built");
});
