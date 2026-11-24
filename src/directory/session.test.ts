/** The capability directory as the main session uses it (src/directory/session.ts): held directory, SwarmRead and Dispatch. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { McpServerRecord } from "../extensions/mcp.js";
import type { NodeCard } from "../mesh/card.js";
import type { PeerHealth } from "../mesh/client.js";
import { SuperagentClient } from "../superagent/client.js";
import { KV } from "../superagent/kv.js";
import { settingsPath, writeSettings } from "../superagent/settings.js";
import { buildDirectory, lendersChange, type DirectoryParts } from "./build.js";
import { readDirectory } from "./read.js";
import { SUMMARY_CHARS, mainSummary } from "./render.js";
import { HOLD_MS, REFRESH_MS, sessionSwarmTools, type SessionDirectoryOptions } from "./session.js";
import type { Directory } from "./types.js";

const AT = "2026-11-24T10:00:00.000Z";
const card = (id: string, name: string, extra: Partial<NodeCard> = {}): NodeCard => ({
  id, name, addresses: [], relayName: name, protocol: 2, version: "0.1.0", os: "linux", arch: "x64", abilities: ["linux"], at: AT, ...extra
});
const online = (id: string, name: string, extra: Partial<NodeCard> = {}): PeerHealth =>
  ({ peer: { id, name, addresses: [] }, reachable: true, ms: 12, card: card(id, name, extra) });

/** The parts of a directory built at `at`, from a pass over `peers` made then. */
function parts(peers: PeerHealth[] = defaultPeers(), at = AT): DirectoryParts {
  return {
    at, own: { protocol: 2, version: "0.1.0" },
    here: { id: "mac-id", name: "mac", host: "running", machine: ["macos"], harnesses: ["claude"], workers: { slots: 2, running: 0, queued: 0, free: 2 }, takesWork: true },
    mesh: { at, given: {}, peers },
    harnesses: { at, signIn: true, default: "claude", profiles: [
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
  // Each read builds a directory of its own, as a session with no host does: a new snapshot every time.
  let builds = 0;
  const { swarm, clock } = tools(() => dir, { mcp: () => servers, refreshMcp: async () => { refreshes += 1; },
    build: async (read) => buildDirectory({ ...parts(peers(), new Date(Date.parse(AT) + 1000 * ++builds).toISOString()), mcp: { servers: read.mcp ?? [] } }) });
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

test("the host's written directory read twice is one look: only a newer one with the same change loads the servers again", async () => {
  // The host writes about once a minute and a session reads every HOLD_MS, so it holds each written directory twice.
  let written = buildDirectory(parts());
  let refreshes = 0;
  const { swarm, clock } = tools(() => assert.fail("the host's directory is used"), { written: async () => written, mcp: () => [],
    refreshMcp: async () => { refreshes += 1; } });
  await swarm.summary();
  clock.now += HOLD_MS;
  await swarm.source.current();
  assert.equal(refreshes, 0, "gpu lending in one snapshot, read twice, loads nothing");
  written = buildDirectory(parts(defaultPeers(), "2026-11-24T10:01:00.000Z"));
  clock.now += HOLD_MS;
  await swarm.source.current();
  assert.equal(refreshes, 1, "the next snapshot shows it too");
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

test("Dispatch without a node needs a paired node with a free worker for a harness this node lacks, as the host's placement does", async () => {
  const only = (load: NonNullable<NodeCard["load"]>) => [online("p-id", "p", { yourGrant: "operator", abilities: ["linux", "harness:kimi"], load })];
  // Running and waiting work both take slots, as `fittest` counts them; the host passes a full node over and runs the work here.
  for (const load of [{ slots: 1, running: 1, queued: 0 }, { slots: 2, running: 1, queued: 1 }]) {
    const { swarm } = tools(() => buildDirectory(parts(only(load))));
    await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" }),
      /Dispatch refused: kimi runs only on p, where no worker is free now: name the node as on to wait for one/, JSON.stringify(load));
  }
  assert.equal(existsSync(join(stateDir, "superagent.db")), false, "a refused dispatch files nothing");
  // Named, it waits for a free worker there.
  const { swarm } = tools(() => buildDirectory(parts(only({ slots: 1, running: 1, queued: 0 }))));
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "p", harness: "kimi" })).summary, /^Filed request .*; its worker runs on kimi on p\./);
});

test("Dispatch without a node files work only a full node runs when that node pulls such work, and says the work waits for it", async () => {
  const pulling = (extra: Partial<NodeCard> = {}) => [online("p-id", "p", { yourGrant: "operator", abilities: ["linux", "harness:kimi"],
    load: { slots: 1, running: 1, queued: 0 }, pull: { repositories: [] }, ...extra })];
  // A node that pulls only another repository's work, or one this node keeps its waiting work from, is not waited for.
  const kept = buildDirectory(parts(pulling()));
  for (const dir of [buildDirectory(parts(pulling({ pull: { repositories: ["acme/web"] } }))), { ...kept, here: { ...kept.here, offersWork: false as const } }]) {
    const { swarm } = tools(() => dir);
    await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" }), /Dispatch refused: kimi runs only on p, where no worker is free now/);
  }
  assert.equal(existsSync(join(stateDir, "superagent.db")), false, "a refused dispatch files nothing");
  // The host's placement finds no free node and waits for p to pull the work, as `choose` does.
  const { swarm } = tools(() => buildDirectory(parts(pulling())));
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" })).summary,
    /^Filed request [^;]+; its worker runs on kimi\. It waits for p to pull it: no worker is free there now\. No host runs yet: start this device's node with `swarm node run`\.$/);
  // A host that is no mesh node hands no work to nodes that pull.
  const client = new SuperagentClient({ stateDir });
  const now = new Date().toISOString();
  client.store.set(KV.host.owner, { pid: process.pid, startedAt: now, heartbeatAt: now });
  client.store.set(KV.host.health, { at: now, entries: {} });
  client.close();
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" }), /Dispatch refused: kimi runs only on p, but the host here is not a mesh node/);
});

test("Dispatch files work on a harness installed here whose sign-in no host checked, and says the host checks it when it runs the work", async () => {
  const bin = join(stateDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  writeSettings({ sources: {}, policy: { sources: {} }, executor: { harness: "codex" } }, settingsPath(stateDir));
  const home = mkdtempSync(join(tmpdir(), "swarm-session-mesh-"));
  try {
    // No host ran, so the session builds its own directory, in which nothing checked codex's sign-in.
    const { swarm } = tools(() => assert.fail("the session reads its own"), { build: (read) => readDirectory({ ...read, home, machine: ["linux"], base: { PATH: bin } }) });
    const dir = await swarm.source.current();
    assert.deepEqual([dir.here.unchecked, dir.harnesses.find((harness) => harness.id === "codex")?.runsOn], [["codex"], []]);
    assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x" })).summary,
      /^Filed request [^;]+; its worker runs\. The sign-in of the default harness codex here was not checked: the host checks it when it runs the work\. No host runs yet: start one with `swarm superagent run`/);
    assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "here" })).summary, /^Filed request [^;]+; its worker runs here\. The sign-in of the default harness codex here was not checked/);
    assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "codex" })).content ?? "", /The sign-in of codex here was not checked: the host checks it when it runs the work\./);
    // A known problem still refuses: claude is not installed here.
    await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "claude" }), /Dispatch refused: claude runs on no node now \([^:]+: Claude Code is not installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // Work for a paired node that runs the harness says nothing of the sign-in here, which it does not use.
  const part = parts([online("p-id", "p", { yourGrant: "operator", abilities: ["linux", "harness:claude"], load: { slots: 2, running: 0, queued: 0 } })]);
  part.here = { ...part.here, harnesses: [], unchecked: ["claude"], harnessProblems: { claude: "installed, but its sign-in was not checked" } };
  const { swarm } = tools(() => buildDirectory(part));
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "p" })).summary, /^Filed request [^;]+; its worker runs on p\. No host runs yet/);
  // With no node named, a paired node with a free worker that runs it is where a mesh node's host puts the work if the
  // sign-in here fails, so the hint names the host that can.
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "claude" })).summary,
    /The sign-in of claude here was not checked: the host checks it when it runs the work, and a mesh node's host puts it on p if it does not run here\. No host runs yet: start this device's node with `swarm node run`\.$/);
});

test("Dispatch checks the default harness wherever the work goes: here, with no node named, and on a paired node", async () => {
  const signedOut = (peers: PeerHealth[] = []) => {
    const part = parts(peers);
    part.here = { ...part.here, harnesses: [], harnessProblems: { claude: "not signed in: run `claude auth login`" } };
    return buildDirectory(part);
  };
  const { swarm } = tools(() => signedOut());
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "here" }),
    /Dispatch refused: the default harness claude runs not here now \(mac: not signed in: run `claude auth login`\)/);
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "mac" }), /the default harness claude runs not here now/);
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x" }), /Dispatch refused: the default harness claude runs on no node now \(mac: not signed in/);
  assert.equal(existsSync(join(stateDir, "superagent.db")), false, "a refused dispatch files nothing");
  // A paired node that runs it takes the work no node is named for; here still does not.
  const claudeOnP = [online("p-id", "p", { yourGrant: "operator", abilities: ["linux", "harness:claude"], load: { slots: 2, running: 0, queued: 0 } })];
  const { swarm: elsewhere } = tools(() => signedOut(claudeOnP));
  await assert.rejects(elsewhere.dispatch({ type: "swarm.dispatch", text: "x", on: "here" }), /the default harness claude runs not here now/);
  assert.match((await elsewhere.dispatch({ type: "swarm.dispatch", text: "x" })).summary, /^Filed request [^;]+; its worker runs\. No host runs yet: start this device's node with `swarm node run`\.$/);
});

test("Dispatch refuses work only a paired node can run while the host here is no mesh node, which runs every worker itself", async () => {
  const peers = [online("p-id", "p", { yourGrant: "operator", abilities: ["linux", "harness:kimi"], load: { slots: 2, running: 0, queued: 0 } })];
  const { swarm } = tools(() => buildDirectory(parts(peers)));
  const host = (entries: Record<string, { state: "ready"; detail: string }>) => {
    const client = new SuperagentClient({ stateDir });
    const now = new Date().toISOString();
    client.store.set(KV.host.owner, { pid: process.pid, startedAt: now, heartbeatAt: now });
    client.store.set(KV.host.health, { at: now, entries });
    client.close();
  };
  host({});
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" }),
    /Dispatch refused: kimi runs only on p, but the host here is not a mesh node, so it runs every worker itself: run it as `swarm node run` instead\./);
  await assert.rejects(swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "p", harness: "kimi" }), /Dispatch refused: the work is for p, but the host here is not a mesh node/);
  // Work this node runs itself is filed as before.
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x" })).summary, /^Filed request [^;]+; its worker runs\.$/);
  // A mesh node's host places work on paired nodes.
  host({ mesh: { state: "ready", detail: "Places tickets' workers on paired nodes and runs theirs" } });
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", harness: "kimi" })).summary, /^Filed request [^;]+; its worker runs on kimi\.$/);
  assert.match((await swarm.dispatch({ type: "swarm.dispatch", text: "x", on: "p", harness: "kimi" })).summary, /^Filed request [^;]+; its worker runs on kimi on p\.$/);
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
