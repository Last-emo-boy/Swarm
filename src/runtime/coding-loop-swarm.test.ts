/** The main session's swarm: the swarm_directory prompt block, the SwarmDirectory, SwarmRead and Dispatch tools, and exact-name ToolSearch. */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSwarmSettings, type SwarmSettings } from "../config/settings.js";
import { CapabilityBroker } from "../extensions/broker.js";
import { BuiltinLocalToolProvider } from "../extensions/builtin-tools.js";
import type { CapabilityPlane } from "../extensions/capability-plane.js";
import type { CapabilityDescriptor } from "../extensions/types.js";
import type { OpenAIProvider } from "../providers/openai-provider.js";
import { LOCAL_TOOL_SCHEMAS } from "../tools/tool-contracts.js";
import { normalizeToolAction } from "../tools/local-tools.js";
import { decideToolPermission, riskClassForAction } from "../tools/permissions.js";
import type { SwarmDispatchAction, ToolApprovalRequest, ToolResult } from "../tools/types.js";
import { CodingAgentLoop, type CodingLoopSwarm } from "./coding-agent-loop.js";
import { RuntimeEvents, type RuntimeEvent } from "./events.js";

type GenerateTextRequest = Parameters<OpenAIProvider["generateText"]>[0];
type PermissionMode = SwarmSettings["permissions"]["defaultMode"];
const SUMMARY = "This node mac: 2 of 2 workers free, takes work, host running.\nCan place work on: gpu.\nHarnesses ready: claude (default) on here; codex on gpu.";

/** A swarm whose tools record what they were asked. */
function fakeSwarm(summary = SUMMARY) {
  const dispatched: SwarmDispatchAction[] = [];
  const swarm: CodingLoopSwarm = {
    summary: async () => summary,
    directory: async (action) => ({ action: "swarm.directory", status: "success", summary: `directory ${action.section ?? "all"}` }),
    read: async (action) => ({ action: "swarm.read", status: "success", summary: `/${action.name}` }),
    dispatch: async (action) => { dispatched.push(action); return { action: "swarm.dispatch", status: "success", summary: "Filed request 12345678." }; }
  };
  return { swarm, dispatched };
}

const done = JSON.stringify({ status: "completed", summary: "Done", message: "Done", files_touched: [], next_actions: [], tool_calls: [] });
const calling = (action: string, inputs: Record<string, unknown>) =>
  JSON.stringify({ status: "continue", summary: "Acting", message: "", files_touched: [], next_actions: [], tool_calls: [{ id: "call-1", action, inputs, reason: action }] });

async function runLoop(input: {
  replies: string[];
  swarm?: CodingLoopSwarm;
  role?: "main" | "worker";
  mode?: PermissionMode;
  approve?: (request: ToolApprovalRequest) => boolean;
  capabilities?: CapabilityDescriptor[];
  disallowedTools?: string[];
  deny?: string[];
}) {
  const workspace = mkdtempSync(join(tmpdir(), "swarm-coding-loop-swarm-"));
  const settings: SwarmSettings = defaultSwarmSettings();
  settings.permissions.defaultMode = input.mode ?? "yolo";
  settings.permissions.deny = [...settings.permissions.deny, ...input.deny ?? []];
  const requests: GenerateTextRequest[] = [];
  const approvals: ToolApprovalRequest[] = [];
  const events = new RuntimeEvents();
  const results: Extract<RuntimeEvent, { type: "tool_result" }>[] = [];
  events.on("event", (event: RuntimeEvent) => { if (event.type === "tool_result") results.push(event); });
  const replies = [...input.replies];
  const provider = { workerModel: "test-model", generateText: async (request: GenerateTextRequest) => { requests.push(request); return replies.shift() ?? done; } } as unknown as OpenAIProvider;
  try {
    const loop = new CodingAgentLoop({
      workspace, settings, provider, events, role: input.role, maxTurns: 3, maxToolCalls: 3, expectedSideEffects: "read_workspace",
      ...(input.swarm ? { swarm: input.swarm } : {}),
      ...(input.capabilities ? { listModelCapabilities: async () => input.capabilities! } : {}),
      ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
      approvalHandler: async (request) => { approvals.push(request); return input.approve?.(request) ?? true; }
    });
    await loop.run("Place the training run");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  return { requests, approvals, results };
}

const text = (blocks: GenerateTextRequest["user"] | GenerateTextRequest["system"]): string =>
  typeof blocks === "string" ? blocks : (blocks ?? []).map((block) => block.text).join("\n");
const section = (blocks: GenerateTextRequest["user"], name: string) => (Array.isArray(blocks) ? blocks : []).find((block) => block.section === name);

test("the main session gets the swarm_directory block outside its cached prefix, one sentence on it, and the three tools", async () => {
  const { requests } = await runLoop({ replies: [done], swarm: fakeSwarm().swarm });
  const [request] = requests;
  const context = section(request!.user, "context");
  assert.equal(context?.cache, false);
  assert.match(context!.text, /"swarm_directory": "This node mac: 2 of 2 workers free/);
  const cached = (Array.isArray(request!.user) ? request!.user : []).filter((block) => block.cache).map((block) => block.text).join("\n");
  assert.doesNotMatch(cached, /This node mac/, "the summary is not in the cached prefix");
  const system = text(request!.system);
  assert.match(system, /swarm_directory in the user payload says which nodes, harnesses and lent tools are ready now/);
  assert.match(system, /call SwarmDirectory for detail/);
  assert.match(system, /Its commands for a person \(pairing, grants, lending, placement, pause, settings, keys and sign-ins\) are never yours to run: name the exact line to the person instead/);
  assert.match(system, /or on your own when a ready harness fits the task better than Swarm's own loop \(swarm_directory lists the harnesses ready here\); it spends that harness account's budget/);
  assert.doesNotMatch(system, /only when the user asks for a subagent/);
  assert.match(system, /Allowed tools: .*, Agent, Dispatch, SwarmDirectory, SwarmRead, ToolSearch\./);
  const tools = section(request!.user, "tools")!.text;
  for (const name of ["SwarmDirectory", "SwarmRead", "Dispatch"]) assert.match(tools, new RegExp(`"action": "${name}"`));
});

test("without the swarm, or in a worker, there is no block, no sentence and no swarm tool", async () => {
  for (const run of [{}, { swarm: fakeSwarm().swarm, role: "worker" as const }]) {
    const { requests } = await runLoop({ replies: [done], ...run });
    const all = `${text(requests[0]!.system)}\n${text(requests[0]!.user)}`;
    assert.doesNotMatch(all, /swarm_directory|SwarmDirectory|SwarmRead|"Dispatch"/);
  }
  // A worker that names Dispatch anyway is refused before anything is filed.
  const { swarm, dispatched } = fakeSwarm();
  const { results } = await runLoop({ replies: [calling("Dispatch", { text: "file it" }), done], swarm, role: "worker" });
  assert.equal(dispatched.length, 0);
  assert.match(results[0]!.summary, /swarm\.dispatch is only available in the main Swarm session/);
});

test("the tools' schemas, risk classes and input checks", () => {
  assert.deepEqual(LOCAL_TOOL_SCHEMAS.SwarmDirectory!.input_schema!.properties.section!.enum, ["nodes", "harnesses", "tools", "sources", "commands"]);
  assert.deepEqual(LOCAL_TOOL_SCHEMAS.SwarmRead!.input_schema!.properties.name!.enum, ["status", "tickets", "usage", "devices", "mesh", "me"]);
  assert.deepEqual(LOCAL_TOOL_SCHEMAS.Dispatch!.input_schema!.required, ["text"]);
  const builtin = new Map(new BuiltinLocalToolProvider().listCapabilities().map((tool) => [tool.name, tool]));
  assert.deepEqual(["SwarmDirectory", "SwarmRead", "Dispatch"].map((name) => [builtin.get(name)!.riskClass, builtin.get(name)!.readOnly, builtin.get(name)!.shouldDefer]),
    [["r0", true, false], ["r0", true, false], ["r2", false, false]]);
  assert.equal(riskClassForAction(normalizeToolAction({ action: "SwarmDirectory", section: "nodes" })), "r0");
  assert.equal(riskClassForAction(normalizeToolAction({ action: "SwarmRead", name: "tickets" })), "r0");
  assert.equal(riskClassForAction(normalizeToolAction({ action: "Dispatch", text: "train it", on: "gpu", harness: "codex" })), "r2");
  assert.deepEqual(normalizeToolAction({ action: "Dispatch", text: "train it", on: "gpu", harness: "codex" }), { type: "swarm.dispatch", text: "train it", on: "gpu", harness: "codex" });
  assert.deepEqual(normalizeToolAction({ action: "SwarmRead", name: "tickets", args: "--all" }), { type: "swarm.read", name: "tickets", args: ["--all"] });
  assert.throws(() => normalizeToolAction({ action: "SwarmDirectory", section: "secrets" }), /section must be one of nodes, harnesses, tools, sources, commands/);
  assert.throws(() => normalizeToolAction({ action: "Dispatch" }), /Dispatch requires text/);
  assert.throws(() => normalizeToolAction({ action: "SwarmRead" }), /SwarmRead requires name/);
});

test("Dispatch asks for approval exactly where Bash does, and the reads never ask", () => {
  const dispatch = normalizeToolAction({ action: "Dispatch", text: "train it", on: "gpu" });
  const bash = normalizeToolAction({ action: "Bash", command: "npm run train" });
  const read = normalizeToolAction({ action: "SwarmDirectory" });
  for (const mode of ["ask", "auto-edit", "auto", "full-auto", "yolo"] as PermissionMode[]) {
    const settings = defaultSwarmSettings();
    settings.permissions.defaultMode = mode;
    assert.equal(decideToolPermission(dispatch, settings).decision, decideToolPermission(bash, settings).decision, mode);
    assert.equal(decideToolPermission(read, settings).decision, "allow", mode);
  }
  const ask = defaultSwarmSettings();
  ask.permissions.defaultMode = "ask";
  assert.equal(decideToolPermission(dispatch, ask).decision, "ask");
  const auto = defaultSwarmSettings();
  auto.permissions.defaultMode = "auto";
  assert.equal(decideToolPermission(dispatch, auto).decision, "allow");
});

test("a session without shell has no Dispatch: disallowedTools Bash and a deny of every shell command both remove it", async () => {
  const without = fakeSwarm();
  const disallowed = await runLoop({ replies: [calling("Dispatch", { text: "run echo hi and report" }), done], swarm: without.swarm, mode: "auto", disallowedTools: ["Bash"] });
  assert.equal(without.dispatched.length, 0, "nothing is filed");
  assert.match(disallowed.results[0]!.summary, /denied by run tool policy/i);
  assert.doesNotMatch(text(disallowed.requests[0]!.system), /Allowed tools: [^\n]*Dispatch/);
  assert.match(text(disallowed.requests[0]!.system), /Allowed tools: [^\n]*SwarmDirectory/, "the reads stay");

  for (const rule of ["Bash", "Bash(*)"]) {
    const denied = fakeSwarm();
    const run = await runLoop({ replies: [calling("Dispatch", { text: "run echo hi and report" }), done], swarm: denied.swarm, mode: "auto", deny: [rule] });
    assert.equal(denied.dispatched.length, 0, rule);
    assert.equal(run.approvals.length, 0, rule);
    const settings = defaultSwarmSettings();
    settings.permissions.deny.push(rule);
    const decision = decideToolPermission(normalizeToolAction({ action: "Dispatch", text: "x" }), settings);
    assert.deepEqual([decision.decision, decision.matched_rule], ["deny", rule]);
  }
  // A deny of some shell commands only leaves Dispatch as it was.
  const some = defaultSwarmSettings();
  some.permissions.defaultMode = "auto";
  some.permissions.deny.push("Bash(rm *)");
  assert.equal(decideToolPermission(normalizeToolAction({ action: "Dispatch", text: "x" }), some).decision, "allow");
});

test("in the loop, Dispatch waits for a person in ask mode and runs in auto; SwarmDirectory runs without asking", async () => {
  const denied = fakeSwarm();
  const asked = await runLoop({ replies: [calling("Dispatch", { text: "train it", on: "gpu", harness: "codex" }), done], swarm: denied.swarm, mode: "ask", approve: () => false });
  assert.equal(asked.approvals.length, 1);
  assert.deepEqual([asked.approvals[0]!.risk_class, asked.approvals[0]!.risk, asked.approvals[0]!.permission_name], ["r2", "delegate", "Dispatch"]);
  assert.match(asked.approvals[0]!.summary, /Dispatch work on gpu via codex: train it/);
  assert.equal(denied.dispatched.length, 0, "a denied dispatch files nothing");

  const granted = fakeSwarm();
  const auto = await runLoop({ replies: [calling("Dispatch", { text: "train it", on: "gpu", harness: "codex" }), done], swarm: granted.swarm, mode: "auto" });
  assert.equal(auto.approvals.length, 0);
  assert.deepEqual(granted.dispatched, [{ type: "swarm.dispatch", text: "train it", on: "gpu", harness: "codex" }]);

  const reads = await runLoop({ replies: [calling("SwarmDirectory", { section: "nodes" }), done], swarm: fakeSwarm().swarm, mode: "ask" });
  assert.equal(reads.approvals.length, 0);
  assert.equal(reads.results[0]!.summary, "directory nodes");
});

test("through the capability broker, Dispatch asks in ask mode and passes in auto, as Bash does", async () => {
  const tools = new BuiltinLocalToolProvider().listCapabilities();
  const run = async (mode: PermissionMode, approve: boolean) => {
    const settings = defaultSwarmSettings();
    settings.permissions.defaultMode = mode;
    const { swarm, dispatched } = fakeSwarm();
    const approvals: ToolApprovalRequest[] = [];
    const broker = new CapabilityBroker({
      capabilityPlane: { getCapability: async (id: string) => tools.find((tool) => tool.id === id) } as unknown as CapabilityPlane,
      settings, workspaceForSession: () => tmpdir(), swarm,
      approvalHandler: async (request) => { approvals.push(request); return approve; },
      emitApproval: () => undefined, emitToolResult: () => undefined,
      activateSkill: () => { throw new Error("no skills here"); }
    });
    const result: ToolResult = await broker.invoke("local_tool.Dispatch", { action: "Dispatch", text: "train it", on: "gpu" }, undefined, { source: "coding_loop" });
    return { result, approvals, dispatched };
  };
  const ask = await run("ask", false);
  assert.deepEqual([ask.result.status, ask.approvals.length, ask.dispatched.length], ["failed", 1, 0]);
  const auto = await run("auto", false);
  assert.deepEqual([auto.result.status, auto.approvals.length, auto.dispatched.length], ["success", 0, 1]);
});

test("ToolSearch selects an exact tool name in one step", async () => {
  const tool = (name: string): CapabilityDescriptor => ({ id: `mcp_tool.gpu.${name}`, kind: "mcp_tool", source: "mcp", trust: "trusted", providerId: "mcp:gpu", name,
    description: `${name} on gpu`, inputSchema: { type: "object" }, riskClass: "r2", permissionName: `McpTool(gpu:${name})`, modelVisible: true, userVisible: true,
    status: "available", readOnly: false, concurrencyClass: "network_limited", metadata: { server_id: "gpu" } });
  const capabilities = [tool("mcp__gpu__shell"), tool("mcp__gpu__shell_history"), tool("mcp__gpu__read_file")];
  const { results, requests } = await runLoop({ replies: [calling("ToolSearch", { query: "mcp__gpu__shell" }), done], capabilities });
  assert.match(results[0]!.summary, /found 1 matching capabilities and loaded 1 MCP tools/);
  assert.match(text(requests[1]!.system), /Allowed tools: .*, Agent, mcp__gpu__shell, ToolSearch\./);
  assert.doesNotMatch(text(requests[1]!.system), /mcp__gpu__shell_history/);
  // A partial name still searches as before.
  const partial = await runLoop({ replies: [calling("ToolSearch", { query: "mcp__gpu" }), done], capabilities });
  assert.match(partial.results[0]!.summary, /found 3 matching capabilities/);
});

test("a runtime gives its main session the real directory, and a ticket worker's runtime has no swarm tools", async () => {
  const { SwarmRuntime } = await import("./runtime.js");
  const root = mkdtempSync(join(tmpdir(), "swarm-runtime-swarm-"));
  const runtime = new SwarmRuntime({ workspace: root, databasePath: join(root, "swarm.db") });
  const worker = new SwarmRuntime({ workspace: root, databasePath: join(root, "worker.db"), swarmTools: false });
  try {
    const answer = await runtime.capabilityBroker.invoke("local_tool.SwarmDirectory", { action: "SwarmDirectory", section: "harnesses" }, undefined, { source: "coding_loop" });
    assert.equal(answer.status, "success");
    assert.match(answer.summary, /^Swarm directory at .*: 0 paired nodes \(0 online\)/);
    assert.ok(Array.isArray((answer.data as { harnesses?: unknown }).harnesses), "the harness section is read here");
    const refused = await worker.capabilityBroker.invoke("local_tool.SwarmDirectory", { action: "SwarmDirectory" }, undefined, { source: "coding_loop" });
    assert.equal(refused.status, "failed");
    assert.match(refused.summary, /swarm\.directory is only available in the main Swarm session/);
  } finally {
    runtime.dispose();
    worker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmarks, the smoke check and the local evals run without swarm tools, so they stay hermetic and file no tickets", () => {
  for (const path of ["../bench/bench-runner.ts", "../smoke.ts", "../evals/local-evals.ts"]) {
    const source = readFileSync(join(import.meta.dirname, path), "utf8");
    const runtimes = source.match(/new SwarmRuntime\(\{[^}]*\}/g) ?? [];
    assert.ok(runtimes.length > 0, path);
    for (const runtime of runtimes) assert.match(runtime, /swarmTools: false/, `${path}: ${runtime}`);
  }
});
