/** The capability directory as the main session uses it (src/directory/session.ts): held directory, SwarmRead and Dispatch. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { McpServerRecord } from "../extensions/mcp.js";
import type { NodeCard } from "../mesh/card.js";
import type { PeerHealth } from "../mesh/client.js";
import { SuperagentClient } from "../superagent/client.js";
import { KV } from "../superagent/kv.js";
import { buildDirectory, lendersChange, type DirectoryParts } from "./build.js";
import { SUMMARY_CHARS, mainSummary } from "./render.js";
import { HOLD_MS, REFRESH_MS, sessionSwarmTools, type SessionDirectoryOptions } from "./session.js";
import type { Directory } from "./types.js";

const AT = "2026-11-24T10:00:00.000Z";
const card = (id: string, name: string, extra: Partial<NodeCard> = {}): NodeCard => ({
  id, name, addresses: [], relayName: name, protocol: 2, version: "0.1.0", os: "linux", arch: "x64", abilities: ["linux"], at: AT, ...extra
});
const online = (id: string, name: string, extra: Partial<NodeCard> = {}): PeerHealth =>
  ({ peer: { id, name, addresses: [] }, reachable: true, ms: 12, card: card(id, name, extra) });

function parts(peers: PeerHealth[] = defaultPeers()): DirectoryParts {
  return {
    at: AT, own: { protocol: 2, version: "0.1.0" },
    here: { id: "mac-id", name: "mac", host: "running", machine: ["macos"], harnesses: ["claude"], workers: { slots: 2, running: 0, queued: 0, free: 2 }, takesWork: true },
    mesh: { at: AT, given: {}, peers },
    harnesses: { at: AT, signIn: true, default: "claude", profiles: [
      { id: "claude", kind: "claude", readOnly: true }, { id: "codex", kind: "codex", readOnly: true }, { id: "kimi", kind: "kimi", readOnly: true }] }
  };
}
function defaultPeers(): PeerHealth[] {
  return [
    online("gpu-id", "gpu", { yourGrant: "operator", abilities: ["linux", "gpu", "harness:codex"], load: { slots: 2, running: 0, queued: 0 },
      lend: { files: { roots: ["/srv/data"] } }, harnessProblems: { kimi: "Kimi is not installed: no `kimi` on PATH." } }),
    online("vm-id", "vm", { yourGrant: "operator", takesWork: false, abilities: ["linux", "harness:codex"], load: { slots: 4, running: 0, queued: 0 } }),
    online("small-id", "small", { yourGrant: "member", abilities: ["linux", "harness:codex"], load: { slots: 1, running: 0, queued: 0 } }),
    { peer: { id: "box-id", name: "box", addresses: [] }, reachable: false, error: "no answer within 3000 ms" }
  ];
}
const record = (id: string, url: string): McpServerRecord => ({ id, transport: "http", url, trust: "user", status: "connected", exposeTools: true,
  exposeResources: false, exposePrompts: false, toolCount: 2, resourceCount: 0, promptCount: 0, diagnostics: [] });

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "swarm-session-directory-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

/** Session tools over a directory built from `dir`, with a clock the test moves. */
function tools(dir: () => Directory, options: Partial<SessionDirectoryOptions> = {}) {
  const clock = { now: 1_000_000 };
  let builds = 0;
  const swarm = sessionSwarmTools({ stateDir, now: () => clock.now, written: async () => undefined, signIns: async () => undefined,
    build: async () => { builds += 1; return dir(); }, ...options });
  return { swarm, clock, builds: () => builds };
}

test("a session holds its directory, refreshes it on request at most once per 10 s, and lists its own MCP servers", async () => {
  const { swarm, clock, builds } = tools(() => buildDirectory(parts()));
  await swarm.source.current();
  await swarm.source.current();
  assert.equal(builds(), 1);
  clock.now += HOLD_MS;
  await swarm.directory({ type: "swarm.directory" });
  assert.equal(builds(), 2);
  await swarm.directory({ type: "swarm.directory", refresh: true });
  assert.equal(builds(), 3);
  clock.now += REFRESH_MS - 1;
  await swarm.directory({ type: "swarm.directory", refresh: true });
  assert.equal(builds(), 3, "a second refresh within 10 s gets the held directory");
  clock.now += 1;
  await swarm.directory({ type: "swarm.directory", refresh: true });
  assert.equal(builds(), 4);

  // The host's directory lists what the peers lend; a session lists the servers it can call instead.
  const written = buildDirectory(parts());
  const mine = [record("docs", "https://docs.example/mcp")];
  const reader = sessionSwarmTools({ stateDir, written: async () => written, build: async () => assert.fail("a fresh host directory is used"), mcp: () => mine });
  const answer = await reader.directory({ type: "swarm.directory", section: "tools" });
  assert.deepEqual(answer.data, { at: AT, tools: [{ id: "docs", kind: "mcp", status: "connected", tools: 2 }] });
  const nodes = await reader.directory({ type: "swarm.directory", section: "nodes" }) as { data: { here: { name: string }; peers: unknown[] } };
  assert.deepEqual([nodes.data.here.name, nodes.data.peers.length], ["mac", 4]);
});

test("the prompt block is bounded, and a directory that cannot be read says so", async () => {
  const many = Array.from({ length: 40 }, (_, index) => online(`n${index}-id`, `node-${index}`, { yourGrant: "operator",
    abilities: ["linux", "harness:codex"], lend: { shell: { roots: ["/srv"] }, files: { roots: ["/srv"] } } }));
  const { swarm } = tools(() => buildDirectory(parts(many)));
  await swarm.source.current();
  const block = await swarm.summary();
  assert.ok(block.length <= SUMMARY_CHARS + 40, `summary is ${block.length} characters`);
  assert.match(block, /SwarmDirectory has the rest/);
  const broken = sessionSwarmTools({ stateDir, written: async () => undefined, signIns: async () => undefined, build: async () => { throw new Error("state.json is unreadable"); } });
  assert.equal(await broken.summary(), "The swarm directory is being read: call SwarmDirectory to wait for it.");
  await assert.rejects(broken.source.current(), /state.json is unreadable/);
  assert.equal(await broken.summary(), "The swarm directory could not be read: state.json is unreadable");
});

test("borrowed MCP servers are loaded again once a change of the lenders holds for two reads, once for each change", async () => {
  const dir = buildDirectory(parts());
  assert.equal(lendersChange(dir, [record("gpu", "swarm-mesh://gpu-id/mesh/v1/mcp")]), undefined);
  assert.equal(lendersChange(dir, []), "gpu-id|");
  assert.equal(lendersChange(buildDirectory({ ...parts(), mesh: { error: "unreadable" } }), []), undefined, "unread nodes change nothing");
  let servers: McpServerRecord[] = [];
  let refreshes = 0;
  let lending = true;
  const peers = () => lending ? defaultPeers() : defaultPeers().map((health) => health.peer.id === "gpu-id" ? { peer: health.peer, reachable: false, error: "gone" } : health);
  const { swarm, clock } = tools(() => dir, { mcp: () => servers, refreshMcp: async () => { refreshes += 1; },
    build: async (read) => buildDirectory({ ...parts(peers()), mcp: { servers: read.mcp ?? [] } }) });
  const read = async () => { clock.now += HOLD_MS; await swarm.source.current(); };
  await read();
  assert.equal(refreshes, 0, "one read of a change loads nothing");
  await read();
  assert.equal(refreshes, 1);
  // The same difference again, such as a lender whose server does not connect, loads them once only.
  await read();
  assert.equal(refreshes, 1);
  // A lender that goes offline and comes back, whose server never loaded, is loaded again: the change ended in between.
  lending = false;
  await read();
  lending = true;
  await read();
  await read();
  assert.equal(refreshes, 2);
  // A node that flaps between reads loads nothing.
  for (let index = 0; index < 6; index += 1) { lending = index % 2 === 1; await read(); }
  assert.equal(refreshes, 2);
  servers = [record("gpu", "swarm-mesh://gpu-id/mesh/v1/mcp")];
  lending = true;
  await read();
  const answer = await swarm.directory({ type: "swarm.directory", section: "tools" });
  assert.equal(refreshes, 2);
  assert.deepEqual((answer.data as { tools: unknown[] }).tools, [{ id: "gpu", kind: "lent", status: "connected", tools: 2, via: "gpu" }]);
});

test("the prompt block never waits for a read: the held directory now, read again in the background once it is old", async () => {
  let release = (): void => {};
  let builds = 0;
  const clock = { now: 1_000_000 };
  const swarm = sessionSwarmTools({ stateDir, now: () => clock.now, written: async () => undefined, signIns: async () => undefined,
    build: async () => { builds += 1; if (builds > 1) await new Promise<void>((resolve) => { release = resolve; }); return buildDirectory(parts()); } });
  assert.match(await swarm.summary(), /being read/);
  await swarm.source.current();
  const first = await swarm.summary();
  assert.match(first, /^This node mac/);
  clock.now += HOLD_MS;
  // The read that starts now hangs, as an offline node's would, and the block still answers at once.
  assert.equal(await swarm.summary(), first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 2);
  assert.equal(await swarm.summary(), first, "one read at a time");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 2);
  release();
  // A host's written directory serves the first turn without any read here.
  const written = buildDirectory(parts());
  const hosted = sessionSwarmTools({ stateDir, written: async () => written, build: async () => assert.fail("no read while the host's is fresh") });
  assert.equal(await hosted.summary(), mainSummary(written));
});

test("a directory a session builds reuses the sign-in checks its host or node wrote, on a refresh too", async () => {
  const signIns = { at: AT, harnesses: ["claude"], problems: { codex: "not signed in" } };
  const seen: unknown[] = [];
  const { swarm } = tools(() => buildDirectory(parts()), { signIns: async () => signIns,
    build: async (read) => { seen.push(read.signIns); return buildDirectory(parts()); } });
  await swarm.source.current();
  await swarm.directory({ type: "swarm.directory", refresh: true });
  assert.deepEqual(seen, [signIns, signIns]);
});

test("SwarmRead runs only the peer reads, as the local operator, and says the host's state without one", async () => {
  const { swarm } = tools(() => buildDirectory(parts()));
  await assert.rejects(swarm.read({ type: "swarm.read", name: "role" }), /only the read commands status, tickets, usage, devices, mesh, me, not role/);
  const absent = sessionSwarmTools({ stateDir: join(stateDir, "none"), written: async () => undefined,
    build: async () => { const dir = buildDirectory(parts()); return { ...dir, here: { ...dir.here, host: "none" } }; } });
  const none = await absent.read({ type: "swarm.read", name: "status" });
  assert.match(none.summary, /No superagent state on this device, so \/status has nothing to read: host none/);
  assert.equal(existsSync(join(stateDir, "none")), false, "reading creates no superagent state");

  new SuperagentClient({ stateDir }).close();
  const status = await swarm.read({ type: "swarm.read", name: "status" });
  assert.equal(status.status, "success");
  assert.ok(status.content && status.content.length > 0, "the host's /status answers");
  const devices = await swarm.read({ type: "swarm.read", name: "devices" });
  // Without the host's devices snapshot /devices says so, in the language the host answers typed commands in.
  assert.match(devices.content ?? "", /does not tell what it runs work on|不提供设备信息/);
});

test("Dispatch refuses up front a node the directory says cannot take the work", async () => {
  const { swarm } = tools(() => buildDirectory(parts()));
  const refused = async (on: string, harness: string | undefined, why: RegExp) =>
    assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "train it", on, ...(harness ? { harness } : {}) }), why);
  await refused("box", undefined, /Dispatch refused: box is offline/);
  await refused("vm", undefined, /vm takes no work put on it/);
  await refused("small", undefined, /small's grant to this node \(member\) does not allow work\.offer/);
  await refused("gpu", "kimi", /gpu does not run kimi: Kimi is not installed/);
  await refused("nowhere", undefined, /No paired node is called nowhere/);
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "here", harness: "codex" }), /codex runs not here now/);
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" }), /kimi runs on no node now \(gpu: Kimi is not installed/);
  // Without a harness the ticket runs on the default one, which the node must run too.
  await refused("gpu", undefined, /Dispatch refused: gpu does not run claude/);
  assert.equal(existsSync(join(stateDir, "superagent.db")), false, "a refused dispatch files nothing");
});

test("Dispatch without a node takes a harness this node lacks only when a paired node that runs it can take the work", async () => {
  const only = (extra: Partial<NodeCard>) => [online("p-id", "p", { abilities: ["linux", "harness:kimi"], load: { slots: 2, running: 0, queued: 0 }, ...extra })];
  for (const [peers, why] of [
    [only({ yourGrant: "operator", takesWork: false }), "takes no work"],
    [only({ yourGrant: "member" }), "a member grant allows no work.offer"],
    [only({ yourGrant: "operator", load: undefined }), "no ticket host"]
  ] as const) {
    const { swarm } = tools(() => buildDirectory(parts([...peers])));
    await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" }), /kimi runs only on p, where work cannot be placed now/, why);
  }
  assert.equal(existsSync(join(stateDir, "superagent.db")), false, "a refused dispatch files nothing");
  const { swarm } = tools(() => buildDirectory(parts(only({ yourGrant: "operator" }))));
  const filed = await swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" });
  assert.match(filed.summary, /^Filed request .*; its worker runs on kimi\./);
});

test("Dispatch reaches requestOn with the node and harness, and files as the terminal does without one", async () => {
  const calls: unknown[] = [];
  const { swarm } = tools(() => buildDirectory(parts()), {
    requestOn: (_client, text, node, harness) => { calls.push({ text, node, harness }); return { triggerId: "trigger-1234567890", thread: "t" }; }
  });
  const placed = await swarm.dispatch({ type: "swarm.dispatch", text: "train the model", on: "gpu", harness: "codex" });
  assert.deepEqual(calls, [{ text: "train the model", node: { id: "gpu-id", name: "gpu" }, harness: "codex" }]);
  assert.match(placed.summary, /^Filed request trigger-; its worker runs on codex on gpu\. No host runs yet/);
  assert.deepEqual(placed.data, { triggerId: "trigger-1234567890", on: "gpu", harness: "codex" });

  // The real requestOn records the placement and the harness with the request, as `swarm superagent request --on` does.
  const real = sessionSwarmTools({ stateDir, now: () => 0, written: async () => undefined, signIns: async () => undefined, build: async () => buildDirectory(parts()) });
  const filed = await real.dispatch({ type: "swarm.dispatch", text: "train the model", on: "gpu-id", harness: "codex" });
  const local = await real.dispatch({ type: "swarm.dispatch", text: "tidy the docs" });
  const pinned = await real.dispatch({ type: "swarm.dispatch", text: "check the build", on: "mac" });
  const client = new SuperagentClient({ stateDir });
  try {
    const id = (filed.data as { triggerId: string }).triggerId;
    assert.deepEqual(client.store.get(KV.mesh.placement(id))?.on, { id: "gpu-id", name: "gpu" });
    assert.equal(client.store.get(KV.harness.chosen(id)), "codex");
    const plain = (local.data as { triggerId: string }).triggerId;
    assert.equal(client.store.get(KV.mesh.placement(plain)), undefined);
    assert.equal(client.store.triggers.get(plain)?.text, "tidy the docs");
    assert.equal(client.store.get(KV.mesh.placement((pinned.data as { triggerId: string }).triggerId))?.on, "here");
    assert.equal(client.store.triggers.get(plain)?.source, "local", "filed from this terminal");
  } finally {
    client.close();
  }
});
