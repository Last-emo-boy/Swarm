/** The capability directory (src/directory): its builder, renderers, the host's snapshot and `swarm directory`. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { NodeCard } from "../mesh/card.js";
import type { PeerHealth } from "../mesh/client.js";
import type { Grant } from "../mesh/surfaces.js";
import { PEER_READS } from "../mesh/tickets.js";
import { COMMAND_TABLE } from "../superagent/command-table.js";
import { SuperagentHost } from "../superagent/host.js";
import { KV } from "../superagent/kv.js";
import { routerPrompt } from "../superagent/prompts.js";
import { settingsPath, writeSettings } from "../superagent/settings.js";
import { PERSON_COMMANDS, buildDirectory, placementProblem, pullingNodes, type DirectoryParts } from "./build.js";
import { directoryText, runDirectoryCommand } from "./cli.js";
import { DIRECTORY_MS, freshDirectory, readDirectory, signInsOf } from "./read.js";
import { SUMMARY_CHARS, mainSummary, routerCard, workerView } from "./render.js";
import type { Directory } from "./types.js";

const AT = "2026-11-24T10:00:00.000Z";
const OWN = { protocol: 2, version: "0.1.0" };

const card = (id: string, name: string, extra: Partial<NodeCard> = {}): NodeCard => ({
  id, name, addresses: [], relayName: name, protocol: 2, version: "0.1.0", os: "linux", arch: "x64", abilities: ["linux"], at: AT, ...extra
});
const online = (id: string, name: string, extra: Partial<NodeCard> = {}): PeerHealth =>
  ({ peer: { id, name, addresses: [] }, reachable: true, ms: 12, card: card(id, name, extra) });

function parts(change: Partial<DirectoryParts> = {}): DirectoryParts {
  return {
    at: AT, own: OWN,
    here: { id: "mac-id", name: "mac", host: "running", machine: ["macos"], harnesses: ["claude"], harnessProblems: { codex: "Codex is not installed: no `codex` on PATH." },
      workers: { slots: 3, running: 1, queued: 0, free: 2 }, takesWork: true },
    mesh: { at: AT, given: { "gpu-id": "member", "box-id": "operator", "vm-id": "member", "old-id": "viewer" }, peers: [
      online("vm-id", "vm", { takesWork: false, yourGrant: "operator", abilities: ["linux", "harness:opencode"], load: { slots: 4, running: 0, queued: 0 } }),
      online("gpu-id", "gpu", { yourGrant: "member", abilities: ["linux", "gpu", "harness:codex"], load: { slots: 2, running: 1, queued: 1 },
        lend: { shell: { roots: ["/srv/work"] }, files: { roots: ["/srv/data"] } }, harnessProblems: { claude: "not signed in: run `claude auth login` in a terminal as this user." } }),
      online("old-id", "old", { abilities: ["linux"], load: { slots: 1, running: 0, queued: 0 } }),
      { peer: { id: "box-id", name: "box", addresses: [] }, reachable: false, error: "no answer within 3000 ms" }
    ] },
    harnesses: { at: AT, signIn: true, default: "claude", profiles: [
      { id: "claude", kind: "claude", readOnly: true }, { id: "codex", kind: "codex", readOnly: true }, { id: "opencode", kind: "opencode", readOnly: false }] },
    health: { at: AT, entries: { feishu: { state: "error", detail: "lark-cli is signed out" }, github: { state: "ready", detail: "watching" }, workers: { state: "ready", detail: "1 running" } } },
    providers: [{ id: "deepseek", primary: true, configured: true, source: "DEEPSEEK_API_KEY" }],
    ...change
  };
}

/** The parts with gpu giving this node an operator grant, which lets it call every tool gpu lends. */
function operatorGpu(): DirectoryParts {
  const offered = parts();
  if (!("error" in offered.mesh)) offered.mesh = { ...offered.mesh, peers: offered.mesh.peers.map((health) => health.card?.name === "gpu" ? { ...health, card: { ...health.card, yourGrant: "operator" as const } } : health) };
  return offered;
}

test("the same state builds the same directory and renders the same text, whatever order its parts came in", () => {
  const first = buildDirectory(parts());
  const shuffled = parts();
  if (!("error" in shuffled.mesh)) shuffled.mesh = { ...shuffled.mesh, peers: [...shuffled.mesh.peers].reverse() };
  const second = buildDirectory(shuffled);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.peers.map((peer) => peer.name), ["box", "gpu", "old", "vm"]);
  assert.deepEqual(first.harnesses.map((harness) => harness.id), ["claude", "codex", "opencode"]);
  // A later build of the same state renders the same prompt text: no timestamps or latencies in it.
  const later = buildDirectory({ ...parts(), at: "2026-11-24T10:00:20.000Z" });
  assert.equal(mainSummary(later), mainSummary(first));
  assert.deepEqual(routerCard(later, true), routerCard(first, true));
  assert.ok(!mainSummary(first).includes("12"), "no latency in the summary");
});

test("each peer's grants and what this node may ask there come from the grant its card says it gives", () => {
  const dir = buildDirectory(parts());
  const peer = (name: string) => dir.peers.find((item) => item.name === name)!;
  assert.deepEqual(peer("gpu").grant, { given: "member", received: "member" });
  assert.deepEqual(peer("gpu").mayThere, ["tickets.submit", "commands.read"]);
  assert.deepEqual(peer("vm").mayThere, ["tickets.submit", "work.offer", "lend.shell", "lend.files.read", "lend.files.write", "commands.read"]);
  // A peer from before the field gives no grant: unknown, and nothing is claimed of it.
  assert.deepEqual([peer("old").grant.received, peer("old").mayThere], ["unknown", []]);
  assert.deepEqual([peer("box").online, peer("box").state, peer("box").grant.given, peer("box").mayThere], [false, "offline", "operator", []]);
  const scoped = parts();
  if (!("error" in scoped.mesh)) scoped.mesh = { ...scoped.mesh, peers: [online("gpu-id", "gpu", { yourGrant: { scopes: ["node.read", "work.offer"] } })] };
  assert.deepEqual(buildDirectory(scoped).peers[0]!.mayThere, ["work.offer"]);
});

test("a grant a peer's card says that this version cannot read is unknown, as a missing one is, and the directory still builds", () => {
  // A newer Swarm's preset, a surface this version lacks, or a card that is simply wrong.
  for (const grant of ["admin", { scopes: ["teleport"] }, { scopes: "work.offer" }, 7]) {
    const part = parts();
    const yourGrant = grant as unknown as Grant;
    if (!("error" in part.mesh)) part.mesh = { ...part.mesh, peers: [
      online("p-id", "p", { yourGrant, load: { slots: 1, running: 0, queued: 0 }, lend: { shell: { roots: ["/srv"] }, files: { roots: ["/srv"] } } }),
      { peer: { id: "q-id", name: "q", addresses: [] }, reachable: false, card: card("q-id", "q", { yourGrant }) }] };
    const dir = buildDirectory(part);
    const [p, q] = dir.peers;
    assert.deepEqual([p!.grant.received, p!.mayThere, p!.lends?.tools.length, q!.grant.received], ["unknown", [], 4, "unknown"], JSON.stringify(grant));
    assert.equal(placementProblem(dir, "p"), undefined, "the host's offer tries it, and that node's grant decides");
  }
});

test("a node's lends are listed by the exact tool names a session calls, and its harness problems by node", () => {
  const dir = buildDirectory(operatorGpu());
  const gpu = dir.peers.find((peer) => peer.name === "gpu")!;
  assert.deepEqual(gpu.lends, { shell: ["/srv/work"], files: ["/srv/data"],
    tools: ["mcp__gpu__list_files", "mcp__gpu__read_file", "mcp__gpu__shell", "mcp__gpu__write_file"] });
  assert.deepEqual(gpu.workers, { slots: 2, running: 1, queued: 1, free: 1 });
  assert.deepEqual(dir.tools, [{ id: "gpu", kind: "lent", status: "connected", tools: 4, via: "gpu" }]);
  const claude = dir.harnesses.find((harness) => harness.id === "claude")!;
  assert.deepEqual([claude.isDefault, claude.runsOn, claude.problems.map((item) => item.node)], [true, ["here"], ["gpu"]]);
  const codex = dir.harnesses.find((harness) => harness.id === "codex")!;
  assert.deepEqual([codex.runsOn, codex.problems], [["gpu"], [{ node: "mac", problem: "Codex is not installed: no `codex` on PATH." }]]);
  assert.deepEqual(dir.harnesses.find((harness) => harness.id === "opencode")!.runsOn, ["vm"]);
});

test("a node's lent tools are listed only as far as its grant to this node lets them be called", () => {
  const lending = (grant: NodeCard["yourGrant"]) => {
    const part = parts();
    if (!("error" in part.mesh)) part.mesh = { ...part.mesh, peers: [online("p-id", "p", { ...(grant ? { yourGrant: grant } : {}), load: { slots: 1, running: 0, queued: 0 },
      lend: { shell: { roots: ["/srv"] }, files: { roots: ["/srv"] } } })] };
    return buildDirectory(part).peers[0]!;
  };
  assert.deepEqual(lending("operator").lends?.tools, ["mcp__p__list_files", "mcp__p__read_file", "mcp__p__shell", "mcp__p__write_file"]);
  // A member grant reaches none of them; the folders are still what that node lends.
  assert.deepEqual(lending("member").lends, { shell: ["/srv"], files: ["/srv"], tools: [] });
  assert.deepEqual(lending({ scopes: ["lend.files.read"] }).lends?.tools, ["mcp__p__list_files", "mcp__p__read_file"]);
  assert.deepEqual(lending({ scopes: ["lend.files.read"] }).mayThere, ["lend.files.read"]);
  // An older Swarm does not say its grant, so its lender decides each call.
  assert.equal(lending(undefined).lends?.tools.length, 4);
});

test("a process's own MCP servers are listed with their status, and borrowed ones by the node they come from", () => {
  const record = { transport: "http" as const, trust: "user" as const, exposeTools: true, exposeResources: false, exposePrompts: false, resourceCount: 0, promptCount: 0, diagnostics: [] };
  const dir = buildDirectory(parts({ mcp: { servers: [
    { ...record, id: "gpu", status: "connected", url: "swarm-mesh://gpu-id/mesh/v1/mcp", toolCount: 4 },
    { ...record, id: "docs", status: "failed", url: "https://docs.example/mcp", toolCount: 0, lastError: "401 Unauthorized" }] } }));
  assert.deepEqual(dir.tools, [{ id: "gpu", kind: "lent", status: "connected", tools: 4, via: "gpu" },
    { id: "docs", kind: "mcp", status: "failed", tools: 0, lastError: "401 Unauthorized" }].sort((a, b) => a.kind.localeCompare(b.kind)));
  assert.match(mainSummary(dir), /Not ready: mcp docs: failed, 401 Unauthorized\./);
});

test("sections that could not be read or outlived their time are reported stale, with why", () => {
  assert.deepEqual(buildDirectory(parts()).stale, []);
  const broken = buildDirectory(parts({ mesh: { error: "state.json is unreadable" }, harnesses: { error: "bad settings" }, mcp: { error: "config is invalid" } }));
  assert.deepEqual(broken.stale.map((item) => item.section), ["nodes", "harnesses", "tools"]);
  assert.match(broken.stale[0]!.why, /state.json is unreadable/);
  const old = parts({ at: "2026-11-24T10:30:00.000Z" });
  assert.deepEqual(buildDirectory(old).stale.map((item) => item.section), ["nodes", "harnesses", "sources"]);
  const unchecked = buildDirectory(parts({ harnesses: { at: AT, signIn: false, default: null, profiles: [] } }));
  assert.match(unchecked.stale.find((item) => item.section === "harnesses")!.why, /swarm harness check/);
  const stopped = parts();
  stopped.here = { ...stopped.here, host: "stopped" };
  assert.match(buildDirectory(stopped).stale.find((item) => item.section === "sources")!.why, /no host runs/);
  const { health: _health, ...none } = parts();
  assert.match(buildDirectory(none).stale.find((item) => item.section === "sources")!.why, /Sources are unknown/);
});

test("work is placed only on a node that is online, takes work, has what it needs and lets this node offer it work", () => {
  const dir = buildDirectory(parts());
  assert.equal(placementProblem(dir, "vm"), "vm takes no work put on it");
  assert.equal(placementProblem(dir, "box"), "box is offline");
  assert.match(placementProblem(dir, "gpu") ?? "", /grant to this node \(member\) does not allow work\.offer/);
  // A peer on an older Swarm does not say its grant: the host's offer tries it, as `swarm superagent place` does.
  assert.equal(placementProblem(dir, "old"), undefined);
  // A node with no ticket host (`swarm node run --no-host`) answers with no workers and serves no work offers.
  const hostless = parts();
  if (!("error" in hostless.mesh)) hostless.mesh = { ...hostless.mesh, peers: [online("p-id", "p", { yourGrant: "operator", abilities: ["linux"] })] };
  const noHost = buildDirectory(hostless);
  assert.deepEqual([noHost.peers[0]!.takesWork, noHost.peers[0]!.workers], [false, undefined]);
  assert.equal(placementProblem(noHost, "p"), "p runs no ticket host, so it takes no work put on it");
  assert.match(mainSummary(noHost), /Can place work on: no paired node\./);
  assert.match(mainSummary(noHost), /- p: workers unknown, takes no work/);
  // This node is checked as a paired node is, for what the work needs and the harness it runs on.
  assert.equal(placementProblem(dir, "here", { needs: ["macos"], harness: "claude" }), undefined);
  assert.equal(placementProblem(dir, "mac", { needs: ["gpu"] }), "this node lacks gpu");
  assert.equal(placementProblem(dir, "here", { harness: "codex" }), "this node does not run codex: Codex is not installed: no `codex` on PATH.");
  assert.match(placementProblem(dir, "nowhere") ?? "", /No paired node is called nowhere/);
  const offered = parts();
  if (!("error" in offered.mesh)) offered.mesh = { ...offered.mesh, peers: offered.mesh.peers.map((health) => health.card?.name === "gpu" ? { ...health, card: { ...health.card, yourGrant: "operator" as const } } : health) };
  const open = buildDirectory(offered);
  assert.equal(placementProblem(open, "gpu", { needs: ["gpu"], harness: "codex" }), undefined);
  assert.match(placementProblem(open, "gpu", { harness: "claude" }) ?? "", /does not run claude: not signed in/);
  assert.match(placementProblem(open, "gpu", { needs: ["docker"] }) ?? "", /lacks docker/);
  assert.equal(placementProblem(open, "here"), undefined);
  assert.match(mainSummary(open), /Can place work on: gpu, old\./);
  assert.match(mainSummary(dir), /Can place work on: old\./);
});

test("the main session's summary stays short and names lenders, ready harnesses, what is not ready and the reads", () => {
  const summary = mainSummary(buildDirectory(operatorGpu()));
  assert.ok(summary.length <= SUMMARY_CHARS, `${summary.length} characters`);
  assert.match(summary, /lends mcp__gpu__list_files, mcp__gpu__read_file, mcp__gpu__shell, mcp__gpu__write_file/);
  assert.match(summary, /Harnesses ready: claude \(default\) on here; codex on gpu; opencode on vm\./);
  assert.match(summary, /Not ready: feishu: error, lark-cli is signed out\./);
  assert.match(summary, /Offline: box\./);
  assert.match(summary, new RegExp(`Reads: ${COMMAND_TABLE.filter((command) => (PEER_READS as readonly string[]).includes(command.name)).map((command) => command.name).join(", ")}\\.`));
  // However many nodes there are, the block keeps its size.
  const many = parts();
  if (!("error" in many.mesh)) many.mesh = { ...many.mesh, peers: Array.from({ length: 40 }, (_, index) => online(`n${index}`, `node-${String(index).padStart(2, "0")}`, { lend: { shell: { roots: ["/w"] } } })) };
  const capped = mainSummary(buildDirectory(many));
  assert.ok(capped.length <= SUMMARY_CHARS + 40 && capped.endsWith("(SwarmDirectory has the rest)"));
});

test("the summary keeps what the session chooses from ahead of the nodes, whatever they lend, and says stale with no time in it", () => {
  const busy = parts({ at: "2026-11-24T10:00:31.000Z", mcp: { servers: [{ id: "docs", transport: "http", url: "https://docs.example/mcp", trust: "user", status: "failed",
    exposeTools: true, exposeResources: false, exposePrompts: false, toolCount: 0, resourceCount: 0, promptCount: 0, diagnostics: [], lastError: "401 Unauthorized" }] } });
  if (!("error" in busy.mesh)) busy.mesh = { ...busy.mesh, peers: ["ovh", "netcup", "kube", "gpu-box"].map((name) => online(`${name}-id`, name, { yourGrant: "operator",
    abilities: ["linux", "harness:claude", "harness:codex", "harness:kimi", "harness:opencode"], load: { slots: 2, running: 0, queued: 0 }, protocol: 3, version: "0.2.0", commit: "abcdef1",
    lend: { shell: { roots: ["/srv"] }, files: { roots: ["/srv"] } } })) };
  const summary = mainSummary(buildDirectory(busy));
  assert.ok(summary.length <= SUMMARY_CHARS + 40, `${summary.length} characters`);
  for (const line of [/^Can place work on: gpu-box, kube, netcup, ovh\.$/m, /^Harnesses ready: /m, /^Not ready: mcp docs: failed, 401 Unauthorized\.$/m,
    /^Stale nodes: the paired nodes were read over 30 s before\.$/m, /^Reads: /m]) assert.match(summary, line);
  assert.doesNotMatch(summary, /\d{4}-\d{2}-\d{2}T/, "no timestamp, so the block caches");
  // Sign-ins checked on time are never stale: a node checks every 10 minutes, and its view may be half a minute older.
  const late = parts({ at: "2026-11-24T10:10:31.000Z" });
  if (!("error" in late.mesh)) late.mesh = { ...late.mesh, at: late.at };
  late.health = { ...late.health!, at: late.at };
  assert.deepEqual(buildDirectory(late).stale, []);
});

test("however large the swarm, the summary keeps every line the session chooses from, each short, and fills the rest with nodes", () => {
  const failing = Array.from({ length: 8 }, (_, index) => ({ id: `docs-${index}`, transport: "http" as const, url: "https://docs.example/mcp", trust: "user" as const,
    status: "failed" as const, exposeTools: true, exposeResources: false, exposePrompts: false, toolCount: 0, resourceCount: 0, promptCount: 0, diagnostics: [], lastError: "401 Unauthorized" }));
  const large = (order: (peers: PeerHealth[]) => PeerHealth[] = (peers) => peers) => {
    const part = parts({ at: "2026-11-24T10:00:31.000Z", mcp: { servers: failing } });
    if (!("error" in part.mesh)) part.mesh = { ...part.mesh, peers: order([
      ...Array.from({ length: 30 }, (_, index) => online(`w${index}-id`, `workstation-${index}`, { yourGrant: "operator",
        abilities: ["linux", "harness:claude", "harness:codex"], load: { slots: 2, running: 0, queued: 0 } })),
      ...Array.from({ length: 9 }, (_, index): PeerHealth => ({ peer: { id: `x${index}-id`, name: `gone-${index}`, addresses: [] }, reachable: false }))]) };
    return mainSummary(buildDirectory(part));
  };
  const summary = large();
  assert.ok(summary.length <= SUMMARY_CHARS + 40, `${summary.length} characters`);
  for (const line of [/^This node mac: /m, /^Can place work on: (workstation-\d+, ){6}\+24 more\.$/m,
    /^Harnesses ready: claude \(default\) on here, workstation-\d+, \+29 more; codex on (workstation-\d+, ){2}\+28 more\.$/m,
    /^Harnesses on no node: opencode\.$/m, /^Not ready: mcp docs-0: failed, 401 Unauthorized\.$/m, /^Not ready: \+6 more\.$/m,
    /^Stale nodes: the paired nodes were read over 30 s before\.$/m, /^Reads: /m, /^Offline: (gone-\d, ){6}\+3 more\.$/m, /^- workstation-\d+: /m]) assert.match(summary, line);
  assert.ok(summary.endsWith("\n... (SwarmDirectory has the rest)"));
  assert.equal(large((peers) => [...peers].reverse()), summary, "the same state gives the same block");
});

test("the ready line names six harnesses then how many more, so however many harnesses the nodes run, node lines keep room", () => {
  const lines = (summary: string) => summary.split("\n");
  const nodeLines = (summary: string) => lines(summary).filter((line) => line.startsWith("- ")).length;
  // Each node runs a profile of its own, as a swarm whose nodes each name theirs does.
  const own = (order: (peers: PeerHealth[]) => PeerHealth[] = (peers) => peers) => {
    const part = parts();
    if (!("error" in part.mesh)) part.mesh = { ...part.mesh, peers: order(Array.from({ length: 60 }, (_, index) => online(`w${index}-id`, `ws-${index}`, { yourGrant: "operator",
      abilities: ["linux", `harness:claude-ws${index}`], load: { slots: 2, running: 0, queued: 0 } }))) };
    return mainSummary(buildDirectory(part));
  };
  const summary = own();
  assert.match(summary, /^Harnesses ready: claude \(default\) on here; claude-ws0 on ws-0; claude-ws1 on ws-1; claude-ws10 on ws-10; claude-ws11 on ws-11; claude-ws12 on ws-12; \+55 more\.$/m);
  assert.ok(summary.length <= SUMMARY_CHARS + 40 && nodeLines(summary) > 0, `${summary.length} characters, ${nodeLines(summary)} node lines`);
  assert.equal(own((peers) => [...peers].reverse()), summary, "the same state gives the same block");
  // Every node runs all six built-in profiles, and eight servers fail with a long error each.
  const error = "MCP error -32000: Connection closed: spawn npx ENOENT while starting the server process; check that the command exists on PATH and that its arguments are right, then retry";
  const failing = Array.from({ length: 8 }, (_, index) => ({ id: `server-number-${index}`, transport: "stdio" as const, trust: "user" as const, status: "failed" as const,
    exposeTools: true, exposeResources: false, exposePrompts: false, toolCount: 0, resourceCount: 0, promptCount: 0, diagnostics: [], lastError: error }));
  const profiles = ["claude", "codex", "kimi", "opencode", "claude-glm", "claude-deepseek"];
  const busy = parts({ at: "2026-11-24T10:00:31.000Z", mcp: { servers: failing } });
  if (!("error" in busy.mesh)) busy.mesh = { ...busy.mesh, peers: Array.from({ length: 30 }, (_, index) => online(`w${index}-id`, `workstation-${index}`, { yourGrant: "operator",
    abilities: ["linux", ...profiles.map((id) => `harness:${id}`)], load: { slots: 2, running: 0, queued: 0 } })) };
  const crowded = mainSummary(buildDirectory(busy));
  assert.ok(crowded.length <= SUMMARY_CHARS + 40 && nodeLines(crowded) > 0, `${crowded.length} characters, ${nodeLines(crowded)} node lines`);
  assert.match(crowded, /^Harnesses ready: claude \(default\) on here, workstation-0, \+29 more; claude-deepseek on workstation-0, workstation-1, \+28 more; /m);
  assert.match(crowded, /^Not ready: \+6 more\.$/m);
  assert.ok(lines(crowded).filter((line) => line.startsWith("Not ready: mcp")).every((line) => line.length <= 120));
  // A harness id is a paired node's word, of any length: no line of the block grows with it.
  const odd = parts();
  if (!("error" in odd.mesh)) odd.mesh = { ...odd.mesh, peers: [online("p-id", "p", { yourGrant: "operator", abilities: ["linux", `harness:${"x".repeat(4000)}`], load: { slots: 1, running: 0, queued: 0 } })] };
  const long = mainSummary(buildDirectory(odd));
  assert.ok(lines(long).every((line) => line.length <= 480) && long.length <= SUMMARY_CHARS, `${long.length} characters`);
});

test("the router's card marks a node whose grant to this node is unknown, which its prompt lets it name", () => {
  const shown = routerCard(buildDirectory(parts()), true) as { paired_nodes: Record<string, unknown>[] };
  const node = (name: string) => shown.paired_nodes.find((item) => item.name === name)!;
  // old runs a Swarm from before the field: its empty may_there must not read as a grant that forbids the work.
  assert.deepEqual([node("old").may_there, node("old").grant_unknown], [[], true]);
  assert.equal(node("gpu").grant_unknown, undefined, "gpu says its grant: member");
  assert.equal(node("box").grant_unknown, undefined, "an offline node says nothing more");
  assert.match(routerPrompt(), /has work\.offer in may_there or grant_unknown \(the host's offer tries that node, and its grant decides\)/);
});

test("the router and a worker see which nodes there are only for a requester who may see them", () => {
  const dir = buildDirectory(parts());
  const hidden = routerCard(dir, false);
  assert.deepEqual(hidden.paired_nodes, { total: 4, online: 3 });
  assert.ok(!JSON.stringify(hidden).includes("gpu"));
  assert.deepEqual(Object.keys(hidden.commands as object), COMMAND_TABLE.filter((command) => command.router).map((command) => command.name));
  const shown = routerCard(dir, true) as { paired_nodes: Record<string, unknown>[]; not_ready: string[] };
  const gpu = shown.paired_nodes.find((node) => node.name === "gpu")!;
  assert.deepEqual(gpu.may_there, ["tickets.submit", "commands.read"]);
  assert.deepEqual(gpu.harness_problems, { claude: "not signed in: run `claude auth login` in a terminal as this user." });
  // A member grant lets this node call none of what gpu lends.
  assert.deepEqual(gpu.lends, []);
  assert.deepEqual(shown.not_ready, ["feishu: error, lark-cli is signed out"]);
  const worker = workerView(dir, false);
  assert.ok(!JSON.stringify(worker).includes("gpu"));
  assert.ok(Object.keys(worker.commands_people_can_send as object).includes("/status"));
  const full = workerView(dir, true) as { paired_nodes: Record<string, unknown>[] };
  assert.equal(full.paired_nodes.find((node) => node.name === "gpu")!.grant_received, "member");
  assert.equal(full.paired_nodes.find((node) => node.name === "box")!.error, "no answer within 3000 ms");
});

test("commands say what they do and who runs them; the ones people keep exist where they are listed", () => {
  const dir = buildDirectory(parts());
  for (const command of COMMAND_TABLE) assert.ok(command.about.length > 10, `${command.name} says what it does`);
  // A paired node and the main session run only reads.
  for (const name of PEER_READS) assert.equal(COMMAND_TABLE.find((command) => command.name === name)?.effect, "read", `${name} is a read`);
  // The router's prompt explains every command it may run, status, tickets and usage too, in the table's words.
  const prompt = routerPrompt();
  for (const command of COMMAND_TABLE.filter((item) => item.router)) assert.ok(prompt.includes(`${command.name}: ${command.about}.`), `the router's prompt explains ${command.name}`);
  const status = dir.commands.find((command) => command.name === "status")!;
  assert.deepEqual([status.how, status.who], ["/status", ["main", "router", "peer", "person"]]);
  assert.deepEqual(dir.commands.find((command) => command.name === "role")!.who, ["person"]);
  const person = dir.commands.filter((command) => command.who.length === 1 && command.who[0] === "person" && command.how.startsWith("swarm "));
  assert.deepEqual(person.map((command) => command.name), PERSON_COMMANDS.map((command) => command.name));
  assert.ok(dir.commands.some((command) => command.how === "claude auth login"), "harness sign-ins come from their kinds");
  const source = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
  const dispatchers = { mesh: source("mesh/cli.ts"), superagent: source("superagent/cli.ts"), harness: source("superagent/harness-cli.ts"), auth: source("index.ts") };
  const index = source("index.ts");
  for (const command of PERSON_COMMANDS) {
    const word = command.dispatcher === "auth" ? "subcommand" : "command";
    assert.ok(dispatchers[command.dispatcher].includes(`${word} === "${command.subcommand}"`), `${command.how} is dispatched`);
    assert.ok(index.includes(`command === "${command.dispatcher}"`), `swarm ${command.dispatcher} is dispatched`);
    assert.ok(command.how.startsWith(`swarm ${command.dispatcher} ${command.subcommand}`), `${command.name} names its own command line`);
  }
});

let stateDir: string;
let home: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "swarm-directory-"));
  home = mkdtempSync(join(tmpdir(), "swarm-directory-mesh-"));
  writeSettings({ sources: {}, policy: { sources: {} } }, settingsPath(stateDir));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a directory built here lists a harness as running here only once its sign-in was checked, and with ticket VMs the ones VMs run", async () => {
  const bin = join(stateDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  const now = new Date("2026-11-24T10:00:00.000Z");
  const read = (extra: Parameters<typeof readDirectory>[0] = {}) => readDirectory({ stateDir, home, machine: ["linux"], base: { PATH: bin }, now: () => now, ...extra });
  const codex = (dir: Directory) => dir.harnesses.find((harness) => harness.id === "codex")!;
  // Installed but never checked: on no node, with why, so no agent picks it to fail at its sign-in.
  const unchecked = await read();
  assert.deepEqual(codex(unchecked).runsOn, []);
  assert.match(codex(unchecked).problems[0]!.problem, /installed, but its sign-in was not checked: `swarm harness check` checks it/);
  // The checks the host or node ran last count while they hold, for an install found now.
  const checked = await read({ signIns: { at: "2026-11-24T09:55:00.000Z", harnesses: ["codex", "claude"], problems: {} } });
  assert.deepEqual([codex(checked).runsOn, checked.here.harnesses], [["here"], ["codex"]], "claude is not installed here now");
  assert.ok(!checked.stale.some((item) => item.section === "harnesses"));
  const signedOut = await read({ signIns: { at: "2026-11-24T09:55:00.000Z", harnesses: [], problems: { codex: "not signed in: run `codex login`" } } });
  assert.deepEqual([codex(signedOut).runsOn, codex(signedOut).problems[0]!.problem], [[], "not signed in: run `codex login`"]);
  const old = await read({ signIns: { at: "2026-11-24T09:00:00.000Z", harnesses: ["codex"], problems: {} } });
  assert.deepEqual(codex(old).runsOn, [], "checks older than their time count for nothing");
  // Reused again, the checks keep the time they ran, not the time of the directory that holds them.
  const again = signInsOf(checked)!;
  assert.deepEqual([again.at, again.harnesses, again.problems.claude], ["2026-11-24T09:55:00.000Z", ["codex"], "Claude Code is not installed: no `claude` on PATH."]);
  assert.equal(signInsOf(unchecked), undefined);
  // With ticket VMs, harness work runs in a VM, which has OpenCode: what this machine has installed does not count.
  writeSettings({ sources: {}, policy: { sources: {} }, executor: { isolation: "vm" } }, settingsPath(stateDir));
  const vm = await read();
  const opencode = vm.harnesses.find((harness) => harness.id === "opencode")!;
  assert.deepEqual([opencode.runsOn, opencode.problems], [["here"], []]);
  assert.deepEqual(codex(vm).runsOn, [], "VMs do not run codex, though it is installed here");
  assert.ok(!vm.stale.some((item) => item.section === "harnesses"));
});

test("a harness installed here whose sign-in no check covers is not ready, yet work may be placed on it: the host checks it when it runs the work", async () => {
  const bin = join(stateDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  const now = new Date("2026-11-24T10:00:00.000Z");
  const read = (extra: Parameters<typeof readDirectory>[0] = {}) => readDirectory({ stateDir, home, machine: ["linux"], base: { PATH: bin }, now: () => now, ...extra });
  const codex = (dir: Directory) => dir.harnesses.find((harness) => harness.id === "codex")!;
  // No check at all, checks past their time, and checks from before codex was a profile here.
  for (const signIns of [undefined, { at: "2026-11-24T09:00:00.000Z", harnesses: ["codex"], problems: {} }, { at: "2026-11-24T09:55:00.000Z", harnesses: [], problems: {} }]) {
    const dir = await read(signIns ? { signIns } : {});
    assert.deepEqual([dir.here.unchecked, dir.here.harnesses, codex(dir).runsOn], [["codex"], [], []], JSON.stringify(signIns));
    assert.equal(placementProblem(dir, "here", { harness: "codex" }), undefined);
    assert.equal(placementProblem(dir, dir.here.name, { harness: "codex" }), undefined);
    // Not ready all the same, as the summary and the router say.
    assert.match(mainSummary(dir), /^Harnesses on no node: [^\n]*\bcodex\b/m);
    assert.match((routerCard(dir, true).this_node as { harness_problems: Record<string, string> }).harness_problems.codex!, /sign-in was not checked/);
  }
  // A check that found a problem, and an install that is missing, still refuse.
  const signedOut = await read({ signIns: { at: "2026-11-24T09:55:00.000Z", harnesses: [], problems: { codex: "not signed in: run `codex login`" } } });
  assert.equal(signedOut.here.unchecked, undefined);
  assert.equal(placementProblem(signedOut, "here", { harness: "codex" }), "this node does not run codex: not signed in: run `codex login`");
  assert.match(placementProblem(signedOut, "here", { harness: "claude" }) ?? "", /^this node does not run claude: Claude Code is not installed/);
  // The checks a directory hands on to the next reader say nothing of a harness they never checked.
  const uncovered = await read({ signIns: { at: "2026-11-24T09:55:00.000Z", harnesses: [], problems: {} } });
  assert.deepEqual([signInsOf(uncovered)!.problems.codex, signInsOf(signedOut)!.problems.codex], [undefined, "not signed in: run `codex login`"]);
});

test("a node that pulls work is waited for only as the host's placement waits for it, and only while this node hands its waiting work out", async () => {
  const pulling = (extra: Partial<NodeCard> = {}, given: Grant = "member", others: PeerHealth[] = []) => {
    const part = parts();
    part.mesh = { at: AT, given: { "p-id": given }, peers: [online("p-id", "p", { yourGrant: "operator", abilities: ["linux", "harness:kimi"],
      load: { slots: 1, running: 1, queued: 0 }, pull: { repositories: [] }, ...extra }), ...others] };
    return buildDirectory(part);
  };
  assert.deepEqual(pullingNodes(pulling(), { harness: "kimi" }), ["p"]);
  assert.deepEqual(pullingNodes(pulling({ pull: { repositories: ["acme/web"] } }), { harness: "kimi" }), [], "it pulls only work of another repository");
  const ofWeb = pulling({ pull: { repositories: ["acme/web"] } });
  assert.deepEqual(pullingNodes({ ...ofWeb, here: { ...ofWeb.here, repository: "acme/web" } }, { harness: "kimi" }), ["p"]);
  assert.deepEqual(pullingNodes(pulling({ pull: undefined }), { harness: "kimi" }), [], "it pulls nothing");
  assert.deepEqual(pullingNodes(pulling({}, "viewer"), { harness: "kimi" }), [], "this node's grant lets it claim no work");
  assert.deepEqual(pullingNodes(pulling(), { harness: "codex" }), [], "it lacks the harness");
  assert.deepEqual(pullingNodes(pulling(), { needs: ["gpu"] }), [], "it lacks what the work needs");
  // While the work waits, the host offers it to that node once a worker there is free, so its grant must allow the offer.
  assert.deepEqual(pullingNodes(pulling({ yourGrant: "member" }), { harness: "kimi" }), [], "its grant to this node allows no work.offer");
  // A fit node with a free worker is offered the work first, whether or not it then takes it.
  const free = online("q-id", "q", { yourGrant: "member", abilities: ["linux", "harness:kimi"], load: { slots: 2, running: 0, queued: 0 } });
  assert.deepEqual(pullingNodes(pulling({}, "member", [free]), { harness: "kimi" }), []);
  const kept = pulling();
  assert.deepEqual(pullingNodes({ ...kept, here: { ...kept.here, offersWork: false } }, { harness: "kimi" }), [], "this node keeps its waiting work");
  // This node's directory says when it keeps its waiting work (`swarm mesh offer off`); by default it hands it out.
  const read = () => readDirectory({ stateDir, home, machine: ["linux"], base: { PATH: "/nowhere" } });
  assert.equal((await read()).here.offersWork, undefined);
  const { updateMesh } = await import("../mesh/state.js");
  updateMesh((state) => ({ ...state, node: { ...state.node, pull: { ...state.node.pull, offer: false } } }), home);
  assert.equal((await read()).here.offersWork, false);
});

test("a written directory keeps when its sign-ins were checked, and a reader ages the checks from then, not from when it was written", async () => {
  const bin = join(stateDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  // The host checked at 10:00 and wrote its directory every minute after: the last one is from 10:19.
  const part = parts({ at: "2026-11-24T10:19:00.000Z" });
  part.here = { ...part.here, harnesses: ["codex"], harnessProblems: {} };
  const written = buildDirectory(part);
  assert.equal(written.signInsAt, AT);
  const signIns = signInsOf(written)!;
  assert.equal(signIns.at, AT);
  const read = (at: string) => readDirectory({ stateDir, home, machine: ["linux"], base: { PATH: bin }, now: () => new Date(at), signIns });
  const codex = (dir: Directory) => dir.harnesses.find((harness) => harness.id === "codex")!;
  // At 10:38 the checks are 38 minutes old, past their 20.
  const late = await read("2026-11-24T10:38:00.000Z");
  assert.deepEqual(codex(late).runsOn, []);
  assert.equal(late.signInsAt, undefined);
  // Within their time they count, and a directory built from them keeps their time.
  const soon = await read("2026-11-24T10:15:00.000Z");
  assert.deepEqual([codex(soon).runsOn, soon.signInsAt, signInsOf(soon)?.at], [["here"], AT, AT]);
  // A directory from before the field says no check time, and its own would make old checks look new: none are reused.
  const { signInsAt: _signInsAt, ...older } = written;
  assert.equal(signInsOf(older), undefined);
  assert.equal(buildDirectory(parts({ harnesses: { at: AT, signIn: false, default: null, profiles: [] } })).signInsAt, undefined, "installs only: no sign-in time");
});

test("the host writes the directory to its store for readers elsewhere, who use it while it is fresh", async () => {
  const saved = process.env.SWARM_MESH_HOME;
  process.env.SWARM_MESH_HOME = home;
  const host = new SuperagentHost({ stateDir, workerCommand: [process.execPath, "-e", ""], log: () => {},
    complete: async () => { throw new Error("no model in this test"); } });
  try {
    const dir = await host.directory();
    assert.deepEqual(host.client.store.get(KV.host.directory), dir);
    assert.equal(dir.here.host, "running");
    assert.deepEqual(dir.peers, []);
    assert.equal(dir.here.workers?.slots, 3);
    // A host that is no mesh node checks no sign-ins unless it is asked to, says so, and so lists no harness as running here.
    assert.ok(dir.stale.some((item) => item.section === "harnesses"));
    assert.deepEqual(dir.here.harnesses, []);
    assert.ok(dir.harnesses.length > 0 && dir.harnesses.every((harness) => !harness.runsOn.includes("here")), "no profile is ready unchecked");
    assert.deepEqual(freshDirectory(host.client.store, Date.parse(dir.at) + DIRECTORY_MS), dir);
    assert.equal(freshDirectory(host.client.store, Date.parse(dir.at) + 3 * DIRECTORY_MS), undefined);
    // A pass a mesh node's meeting made is the host's own: the paired nodes are not asked again for the directory.
    const { newPairKey, savePeer } = await import("../mesh/state.js");
    savePeer({ id: "far-id", name: "far", key: newPairKey(), addresses: ["http://127.0.0.1:9"], pairedAt: AT }, home);
    host.notePeers([{ peer: { id: "far-id", name: "far", addresses: [] }, reachable: true, card: card("far-id", "far", { yourGrant: "operator" }) }]);
    const met = await host.directory();
    assert.deepEqual(met.peers.map((peer) => [peer.name, peer.online, peer.grant.received]), [["far", true, "operator"]]);
    // A mesh view that cannot be read still leaves a directory, with this node's own facts.
    host.meshView = async () => { throw new Error("the mesh state could not be read"); };
    const without = await host.directory();
    assert.deepEqual([without.here.workers?.slots, without.peers.map((peer) => peer.name)], [3, ["far"]]);
  } finally {
    await host.stop();
    if (saved === undefined) delete process.env.SWARM_MESH_HOME;
    else process.env.SWARM_MESH_HOME = saved;
  }
});

test("swarm directory prints the host's fresh directory, and builds its own without one or when asked", async () => {
  const printed: string[] = [];
  const options = { stateDir, home, machine: ["linux"], base: { PATH: "/nowhere" }, print: (text: string) => { printed.push(text); } };
  // No host wrote one: it is built here, starting no harness and creating no mesh state.
  await runDirectoryCommand(["--json"], options);
  const built = JSON.parse(printed.pop()!) as Directory;
  assert.deepEqual([built.here.machine, built.here.harnesses, built.peers, built.here.host], [["linux"], [], [], "stopped"]);
  assert.ok(built.harnesses.every((harness) => harness.problems.some((item) => /not installed/.test(item.problem))));
  assert.ok(built.stale.some((item) => item.section === "harnesses" && /swarm harness check/.test(item.why)));
  assert.ok(!existsSync(join(home, "state.json")), "a device that never joined a mesh gets no mesh state from reading it");
  // A fresh one the host wrote is printed as it is.
  const written = buildDirectory(parts({ at: new Date().toISOString() }));
  const { SuperagentClient } = await import("../superagent/client.js");
  const client = new SuperagentClient({ stateDir });
  client.store.set(KV.host.directory, written);
  client.close();
  await runDirectoryCommand(["--json"], options);
  assert.deepEqual(JSON.parse(printed.pop()!), written);
  await runDirectoryCommand([], options);
  assert.equal(printed.pop(), directoryText(written));
  await runDirectoryCommand(["--refresh", "--json"], options);
  assert.notDeepEqual(JSON.parse(printed.pop()!), written);
  await assert.rejects(runDirectoryCommand(["--bogus"], options), /Unknown argument --bogus/);
});
