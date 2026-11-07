/**
 * Delegated subagents on agent harnesses, with fake harnesses (superagent/testing/fake-harness.ts) and no model: a delegate
 * on a harness returns its outcome to the parent, a writer and a read-only reviewer run side by side in the background,
 * a read-only spec does not start on a harness Swarm cannot keep read-only, and none starts on a harness past its budget.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SwarmPolicy } from "../protocol/types.js";
import { settingsPath, writeSettings } from "../superagent/settings.js";
import { writeFakeHarnesses, type FakeHarnessCall } from "../superagent/testing/fake-harness.js";
import type { ToolApprovalRequest, ToolResult } from "../tools/types.js";
import type { AgentInvocationRequest } from "./agent-specs.js";
import { SwarmRuntime } from "./runtime.js";

const root = mkdtempSync(join(tmpdir(), "swarm-harness-worker-"));
const saved = { PATH: process.env.PATH, SWARM_HOME: process.env.SWARM_HOME, SWARM_SUPERAGENT_HOME: process.env.SWARM_SUPERAGENT_HOME, CODEX_HOME: process.env.CODEX_HOME };
let fakes: { calls(): FakeHarnessCall[] };

before(() => {
  fakes = writeFakeHarnesses(join(root, "bin"), join(root, "harness"));
  process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
  process.env.SWARM_HOME = join(root, "swarm-home");
  process.env.SWARM_SUPERAGENT_HOME = join(root, "superagent");
  process.env.CODEX_HOME = join(root, "codex");
  writeSettings({ executor: { harnesses: { loose: { kind: "claude", args: ["--dangerously-skip-permissions"] } } } }, settingsPath());
});
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** A runtime on a fresh git workspace whose spawn decisions pick the spec each request prefers, as the model would. */
function fixture(name: string) {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(workspace, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const approvals: ToolApprovalRequest[] = [];
  const runtime = new SwarmRuntime({ workspace, databasePath: join(workspace, "..", `${name}.db`), approvalHandler: async (request) => { approvals.push(request); return true; } });
  const provider = (runtime as unknown as { provider: { generateText: (request: { usage?: { purpose?: string }; user?: { text: string }[] }) => Promise<string> } }).provider;
  provider.generateText = async (request) => {
    if (request.usage?.purpose !== "agent_spawn_decision") throw new Error("Only spawn decisions call the model here: the workers run on harnesses");
    const user = (request.user ?? []).map((part) => part.text).join("\n");
    const spec = /"preferred_agent_spec_id":\s*"(\w+)"/.exec(user)?.[1] ?? "coder";
    const mode = /"preferred_mode":\s*"(\w+)"/.exec(user)?.[1] ?? "call_subagent";
    return JSON.stringify({ agent_spec_id: spec, invocation_mode: mode, reason: "The request names this spec.", confidence: 1 });
  };
  const sessionId = `session-${name}`;
  seedSession(runtime, sessionId);
  const invoke = (request: Omit<AgentInvocationRequest, "parent_session_id" | "requested_by">) =>
    (runtime as unknown as { invokeAgent: (request: AgentInvocationRequest) => Promise<ToolResult> })
      .invokeAgent({ parent_session_id: sessionId, requested_by: "main_swarm", ...request });
  return { workspace, runtime, approvals, invoke };
}

test("a delegate on a harness works in the workspace and returns its outcome to the parent", { timeout: 60_000 }, async () => {
  const { workspace, runtime, approvals, invoke } = fixture("delegate");
  try {
    const result = await invoke({
      capability: "code.implement", task: "Write the harness note in harness.txt for the main Swarm.", preferred_agent_spec_id: "coder",
      file_scope: ["harness.txt"], harness: "opencode", spawn_reason: "harness delegate test"
    });
    assert.equal(result.status, "success", result.content);
    const data = result.data as { worker_id: string; outcome: { changed_files: string[]; final_summary: string } };
    assert.deepEqual(data.outcome.changed_files, ["harness.txt"], "from git status before and after");
    assert.match(data.outcome.final_summary, /^Wrote harness\.txt on opencode\.\n\nRan on OpenCode \(opencode, deepseek\/deepseek-flash\), scoped_write: OpenCode runs in its own auto mode and is not confined to the workspace or the file scope\./);
    assert.equal(readFileSync(join(workspace, "harness.txt"), "utf8"), "opencode turn 1\n");
    assert.equal(runtime.workerStateStore.get(data.worker_id)?.status, "completed");

    const [call] = fakes.calls().filter((each) => each.cwd.endsWith("/delegate"));
    assert.equal(call?.tools, undefined, "a subagent has no ticket tools");
    assert.match(call?.instructions ?? "", /You are a scoped implementation worker[\s\S]*## Working in OpenCode[\s\S]*Do not commit, push or open pull requests/);
    assert.match(call?.prompt ?? "", /Execute this internal Swarm agent task packet[\s\S]*Write the harness note/);
    assert.equal(approvals.length, 1, "in ask mode a writer needs approval to start");
    assert.equal(approvals[0]?.risk, "delegate");
    assert.match(approvals[0]?.summary ?? "", /^Run Code Agent on OpenCode \(opencode\)$/);

    const usage = runtime.usageStore.list(runtime.workerStateStore.get(data.worker_id)!.worker_session_id!, 20);
    const count = usage.find((record) => record.unit === "count");
    assert.equal(count?.metadata.harness, "opencode");
    assert.equal(count?.metadata.model, "deepseek/deepseek-flash");
    assert.equal(count?.task_id, data.worker_id);
    assert.ok(Math.abs(Number(count?.metadata.reportedCostUsd) - 0.003359552) < 1e-12);
  } finally {
    runtime.dispose();
  }
});

test("parallel delegation runs one harness that writes and another that reviews read-only", { timeout: 60_000 }, async () => {
  const { runtime, invoke } = fixture("pair");
  try {
    const launched = await Promise.all([
      invoke({ capability: "code.implement", task: "Write the harness note in harness.txt as a background worker.", preferred_agent_spec_id: "coder",
        preferred_mode: "parallel", file_scope: ["harness.txt"], harness: "claude" }),
      invoke({ capability: "code.review", task: "Review the workspace as a background reviewer and report findings.", preferred_agent_spec_id: "reviewer",
        preferred_mode: "parallel", file_scope: ["harness.txt"], harness: "codex" })
    ]);
    const ids = launched.map((result) => (result.data as { worker_id: string; background?: boolean }).worker_id);
    assert.deepEqual(launched.map((result) => (result.data as { background?: boolean }).background), [true, true]);
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline && !ids.every((id) => runtime.workerStateStore.get(id)?.status === "completed")) await new Promise((resolve) => setTimeout(resolve, 100));
    const [writer, reviewer] = ids.map((id) => runtime.workerStateStore.get(id)!);
    assert.equal(writer?.status, "completed", writer?.last_result);
    assert.equal(reviewer?.status, "completed", reviewer?.last_result);
    assert.deepEqual(writer?.outcome?.changed_files, ["harness.txt"]);
    assert.match(reviewer?.last_result ?? "", /^Reviewed the workspace on codex without changing it\.\n\nRan on Codex \(codex, gpt-6\.1-sol\), read_only: Codex runs in its read-only sandbox/);
    const calls = fakes.calls().filter((each) => each.cwd.endsWith("/pair"));
    assert.equal(calls.find((each) => each.kind === "codex")?.args[calls.find((each) => each.kind === "codex")!.args.indexOf("-s") + 1], "read-only");
    assert.equal(calls.find((each) => each.kind === "claude")?.args.includes("--dangerously-skip-permissions"), false);
  } finally {
    runtime.dispose();
  }
});

test("a read-only spec on a harness that cannot be kept read-only refuses to start, and says why", { timeout: 60_000 }, async () => {
  const { runtime, invoke } = fixture("refused");
  try {
    const result = await invoke({ capability: "code.review", task: "Review the workspace changes for regressions and report findings.",
      preferred_agent_spec_id: "reviewer", harness: "loose" });
    assert.equal(result.status, "failed");
    assert.match(result.content ?? "", /\(reviewer\) failed: Review Agent only reads, and cannot start on loose \(Claude Code\): the profile "loose" passes --dangerously-skip-permissions in its args, which sets Claude Code's permissions itself, so Swarm cannot keep it read-only\./);
    assert.equal(fakes.calls().filter((each) => each.cwd.endsWith("/refused")).length, 0, "the harness never ran");
  } finally {
    runtime.dispose();
  }
});

test("a delegate on a harness whose budget is reached does not start, and asks no approval", { timeout: 60_000 }, async () => {
  const { workspace, runtime, approvals, invoke } = fixture("capped");
  try {
    mkdirSync(join(workspace, ".swarm"));
    writeFileSync(join(workspace, ".swarm", "settings.json"), JSON.stringify({ runtime: { databasePath: join(workspace, "..", "capped.db") },
      usage: { budgets: { providers: {}, harnesses: { opencode: { dailyTokens: 100 } } } } }));
    runtime.usageStore.append({ kind: "llm_call", amount: 1, unit: "count", metadata: { providerId: "harness:opencode", event: "harness_turn",
      harness: "opencode", model: "deepseek/deepseek-flash", purpose: "agent_worker", inputTokens: 20_000, outputTokens: 0, totalInputWithCacheTokens: 20_000 } });
    const result = await invoke({ capability: "code.implement", task: "Write the harness note in harness.txt for the main Swarm.",
      preferred_agent_spec_id: "coder", file_scope: ["harness.txt"], harness: "opencode" });
    assert.equal(result.status, "failed");
    assert.match(result.content ?? "", /\(coder\) failed: Code Agent cannot start on opencode: The daily budget for harness opencode is reached: 20\.0K tokens used of 100 tokens today\./);
    assert.equal(approvals.length, 0);
    assert.equal(fakes.calls().filter((each) => each.cwd.endsWith("/capped")).length, 0, "the harness never ran");
  } finally {
    runtime.dispose();
  }
});

function seedSession(runtime: SwarmRuntime, sessionId: string): void {
  runtime.sessionStore.create({
    swarm_id: `swarm_${sessionId}`,
    session_id: sessionId,
    user_request_id: "user-harness-worker",
    source: { source: "user", human_id: sessionId, title: "Harness worker test", description: "Harness worker test", labels: ["test"], state: "active", metadata: { mode: "coding_loop" } },
    objective: "Delegate to harness workers",
    status: "running",
    coordinator: { agent_id: "main_swarm", role: "controller" },
    participants: [],
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z",
    policy: policy()
  });
}

function policy(): SwarmPolicy {
  return {
    max_agents: 4, max_parallel_tasks: 2, timeout_ms: 10_000, retry: { max_attempts: 1, backoff_ms: 100 }, require_review: false,
    consensus: "coordinator_decision", approval_mode: "on-request", network_access: "deny", allow_domains: [], human_approval_for: [],
    safety: { require_human_approval_for: [], forbidden_capabilities: [], sandbox_required: false },
    memory: { allow_read: true, allow_write: true, retention: "session" }
  };
}
