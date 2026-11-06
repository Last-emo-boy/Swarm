/**
 * The harness registry: the arguments each kind passes (the flags verified against `claude --help` 2.1.285, `codex exec
 * --help` 0.163.0, `kimi --help` 2.1.1 and `opencode run --help` 1.18.21), how it reads the events those CLIs printed in
 * recorded runs (Kimi Code's from its stream-json writer), the files a turn writes and puts back, read-only turns, profiles
 * and their keys, the budget stop, and how a request's harness choice becomes its ticket's execution. No harness or model
 * runs here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SuperagentClient } from "./client.js";
import { HARNESS_KINDS, HarnessProfileSchema, HarnessSetupError, harnessIds, harnessProfiles, harnessStatus, harnessUsageRows, readOnlyProblem, resolveHarness, runTurn,
  type TurnEvents, type TurnRequest } from "./harness.js";
import { SettingsSchema, settingsPath, writeSettings } from "./settings.js";
import { writeFakeHarnesses } from "./testing/fake-harness.js";

const request: TurnRequest = {
  directory: "/work/fix-typo", instructions: "## Swarm superagent\nReport with mcp__ticket__report.",
  tools: { command: "/usr/bin/node", args: ["/swarm/index.js", "superagent", "mcp", "--ticket", "t1"], env: { SWARM_SUPERAGENT_HOME: "/state", SWARM_SUPERAGENT_DEPLOYMENT: "{\"repository\":\"a/b\"}" } },
  permission: "full-auto", blockedCommands: ["npm-publish"], variables: ["HOME", "PATH", "SWARM_SUPERAGENT_HOME"], extra: []
};
const fresh = (): TurnEvents => ({ text: "", done: false, steps: 0, toolCalls: 0 });
const read = (kind: keyof typeof HARNESS_KINDS, events: unknown[]): TurnEvents => {
  const turn = fresh();
  for (const event of events) HARNESS_KINDS[kind].read(event as Record<string, unknown>, turn);
  return turn;
};
/** The value after a flag. */
const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

test("Claude Code runs a turn headless with the ticket tools only, its permission mode and the blocked commands denied", () => {
  const args = HARNESS_KINDS.claude.args(request);
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(JSON.parse(after(args, "--settings")!), { attribution: { commit: "", pr: "", sessionUrl: false } },
    "no Co-Authored-By trailer, pull request line or session link");
  assert.equal(after(args, "--append-system-prompt"), request.instructions);
  assert.deepEqual(JSON.parse(after(args, "--mcp-config")!), { mcpServers: { ticket: { type: "stdio", ...request.tools } } });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(after(args, "--allowedTools"), "mcp__ticket");
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 3), ["Bash(npm-publish)", "Bash(npm-publish *)"]);
  assert.equal(after(args, "--permission-mode"), "auto");
  assert.equal(after(args, "--permission-prompts"), "none");
  assert.ok(!args.includes("--resume"));

  const later = HARNESS_KINDS.claude.args({ ...request, session: "845fd0c6-64b4-452e-a53d-dc059b4ed0ff", permission: "yolo", model: "sonnet", extra: ["--effort", "high"] });
  assert.equal(after(later, "--resume"), "845fd0c6-64b4-452e-a53d-dc059b4ed0ff");
  assert.equal(after(later, "--model"), "sonnet");
  assert.equal(after(later, "--effort"), "high");
  assert.ok(later.indexOf("--settings") > later.indexOf("--effort"), "the profile's arguments cannot override the attribution setting");
  assert.ok(later.includes("--dangerously-skip-permissions") && !later.includes("--permission-mode"));
});

test("Codex runs `exec --json` with the ticket tools as an approved MCP server, approvals off, and resumes by thread id", () => {
  const args = HARNESS_KINDS.codex.args({ ...request, extra: ["--profile", "cli"] });
  assert.deepEqual(args.slice(0, 3), ["exec", "--profile", "cli"]);
  assert.equal(args.at(-1), "-", "the prompt comes on standard input");
  assert.equal(after(args, "-C"), request.directory);
  assert.equal(after(args, "-s"), "danger-full-access", "its sandbox keeps git metadata read-only, and a ticket's work is commits");
  assert.ok(args.includes("--json") && args.includes("--skip-git-repo-check"));
  // Every -c value is TOML that is also JSON, as Swarm writes it.
  const config = new Map(args.flatMap((arg, index) => arg === "-c" ? [args[index + 1]!.split(/=(.*)/s).slice(0, 2) as [string, string]] : [])
    .map(([key, value]) => [key, JSON.parse(value)] as const));
  assert.equal(config.get("approval_policy"), "never");
  assert.equal(config.get("developer_instructions"), request.instructions);
  assert.equal(config.get("mcp_servers.ticket.command"), "/usr/bin/node");
  assert.deepEqual(config.get("mcp_servers.ticket.args"), request.tools!.args);
  assert.equal(config.get("mcp_servers.ticket.env.SWARM_SUPERAGENT_DEPLOYMENT"), "{\"repository\":\"a/b\"}");
  assert.deepEqual(config.get("mcp_servers.ticket.env_vars"), ["HOME", "PATH"], "the server inherits the worker's other variables");
  assert.equal(config.get("mcp_servers.ticket.default_tools_approval_mode"), "approve");
  assert.ok(!args.includes("resume"));

  const later = HARNESS_KINDS.codex.args({ ...request, session: "01a1ae67-cd55-7852-9e9a-ee91085830f4", permission: "yolo", model: "gpt-5.5" });
  assert.deepEqual(later.slice(-3), ["resume", "01a1ae67-cd55-7852-9e9a-ee91085830f4", "-"], "exec's flags come before resume");
  assert.equal(after(later, "-m"), "gpt-5.5");
  assert.ok(later.includes("--dangerously-bypass-approvals-and-sandbox") && !later.includes("-s"));
});

test("Claude Code's stream-json events give the session, the final words, the model and the usage of a turn", () => {
  const turn = read("claude", [
    { type: "system", subtype: "init", session_id: "845fd0c6", model: "claude-opus-5-5[1m]", mcp_servers: [{ name: "ticket", status: "connected", source: "dynamic" }], permissionMode: "auto" },
    { type: "assistant", message: { id: "msg_1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "" }] }, session_id: "845fd0c6" },
    { type: "assistant", message: { id: "msg_1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__ticket__report", input: { state: "ready", summary: "ok" } }] }, session_id: "845fd0c6" },
    { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "text", text: "{\"reported\":true}" }] }] } },
    { type: "assistant", message: { id: "msg_2", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }] }, session_id: "845fd0c6" },
    { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "845fd0c6", total_cost_usd: 0.2212404,
      usage: { input_tokens: 4360, cache_creation_input_tokens: 38831, cache_read_input_tokens: 34327, output_tokens: 139, output_tokens_details: { thinking_tokens: 58 } },
      modelUsage: { "claude-opus-5-5[1m]": { inputTokens: 4360, outputTokens: 139, cacheReadInputTokens: 34327, cacheCreationInputTokens: 38831, costUSD: 0.2212404 } } }
  ]);
  assert.equal(turn.done, true);
  assert.equal(turn.session, "845fd0c6");
  assert.equal(turn.text, "done");
  assert.equal(turn.model, "claude-opus-5-5[1m]");
  assert.deepEqual([turn.steps, turn.toolCalls], [2, 1], "a message's blocks come as several events and count as one step");
  assert.deepEqual(turn.usage, { inputTokens: 4360, outputTokens: 139, cachedInputTokens: 34327, cacheCreationInputTokens: 38831, reasoningOutputTokens: 58, costUsd: 0.2212404 });

  const refused = read("claude", [
    { type: "system", subtype: "init", session_id: "cd54af82", model: "claude-opus-5-5[1m]", mcp_servers: [{ name: "ticket", status: "failed" }] },
    { type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "API Error: 400 Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header.", session_id: "cd54af82" }
  ]);
  assert.equal(refused.done, false);
  assert.match(refused.error ?? "", /API Error: 400/);
  assert.equal(refused.toolsDown, "failed");

  const stopped = read("claude", [
    { type: "assistant", message: { id: "msg_1", content: [{ type: "thinking" }], usage: { input_tokens: 4358, cache_creation_input_tokens: 34327, cache_read_input_tokens: 0, output_tokens: 4 } } },
    { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use" }], usage: { input_tokens: 4358, cache_creation_input_tokens: 34327, cache_read_input_tokens: 0, output_tokens: 4 } } },
    { type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "done" }], usage: { input_tokens: 2, cache_creation_input_tokens: 4504, cache_read_input_tokens: 34327, output_tokens: 3 } } }
  ]);
  void HARNESS_KINDS.claude.settle!(stopped, { command: "claude", env: {}, directory: "/work", started: 0 });
  assert.deepEqual(stopped.usage, { inputTokens: 4360, outputTokens: 7, cachedInputTokens: 34327, cacheCreationInputTokens: 38831, reasoningOutputTokens: 0, partial: true },
    "a turn stopped before its result still counts each message once");

  const lost = read("claude", [{ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["No conversation found with session ID: 0000"] }]);
  assert.ok(HARNESS_KINDS.claude.lost(lost.error ?? ""));
});

test("Codex's JSON events give the thread, the final message and the usage; warnings and reconnects do not fail a turn", () => {
  const turn = read("codex", [
    { type: "thread.started", thread_id: "01a1ae67-cd55-7852-9e9a-ee91085830f4" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "I'll call the ticket report tool.\n" } },
    { type: "item.started", item: { id: "item_5", type: "mcp_tool_call", server: "ticket", tool: "report", arguments: { state: "ready" }, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_5", type: "mcp_tool_call", server: "ticket", tool: "report", arguments: { state: "ready" },
      result: { content: [{ type: "text", text: "{\"reported\":true}" }] }, error: null, status: "completed" } },
    { type: "item.completed", item: { id: "item_6", type: "agent_message", text: "Reported once." } },
    { type: "turn.completed", usage: { input_tokens: 146600, cached_input_tokens: 96885, cache_write_input_tokens: 0, output_tokens: 139, reasoning_output_tokens: 0 } }
  ]);
  assert.equal(turn.done, true);
  assert.equal(turn.session, "01a1ae67-cd55-7852-9e9a-ee91085830f4");
  assert.equal(turn.text, "Reported once.");
  assert.deepEqual([turn.steps, turn.toolCalls], [2, 1]);
  assert.deepEqual(turn.usage, { inputTokens: 146600, outputTokens: 139, cachedInputTokens: 96885, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 });

  const failed = read("codex", [{ type: "thread.started", thread_id: "t" }, { type: "turn.failed", error: { message: "stream disconnected before completion" } }]);
  assert.equal(failed.done, false);
  assert.equal(failed.error, "stream disconnected before completion");
  assert.ok(HARNESS_KINDS.codex.lost("Error: thread/resume: thread/resume failed: no rollout found for thread id 0000 (code -32600)"));
});

test("Kimi Code takes the prompt as an argument, starts a session with Swarm's agent file and resumes by session id", () => {
  const scratch = mkdtempSync(join(tmpdir(), "swarm-kimi-scratch-"));
  try {
    const turn = { ...request, prompt: "fix the typo", scratch };
    const args = HARNESS_KINDS.kimi.args(turn);
    assert.equal(HARNESS_KINDS.kimi.promptArgument, true);
    assert.equal(after(args, "--prompt"), "fix the typo");
    assert.equal(after(args, "--output-format"), "stream-json");
    assert.equal(after(args, "--agent-file"), join(scratch, "kimi-agent.md"));
    assert.ok(!args.includes("--session") && !args.includes("--yolo"), "print mode runs in Kimi's own auto mode");
    const later = HARNESS_KINDS.kimi.args({ ...turn, session: "session_ff56abe5", model: "kimi-code/k3" });
    assert.equal(after(later, "--session"), "session_ff56abe5");
    assert.ok(!later.includes("--agent-file"), "a resumed session keeps the agent it started with");
    assert.equal(after(later, "--model"), "kimi-code/k3");
    assert.equal(HARNESS_KINDS.kimi.tool("report"), "mcp__ticket__report");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Kimi Code's agent file holds Kimi's own prompt and Swarm's, and the ticket tools go in the directory's mcp.json for the turn", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-kimi-prepare-"));
  try {
    const scratch = join(root, "scratch");
    const directory = join(root, "work");
    mkdirSync(scratch);
    mkdirSync(join(directory, ".kimi-code"), { recursive: true });
    const theirs = `${JSON.stringify({ mcpServers: { github: { url: "https://mcp.example.com/mcp" } } })}\n`;
    writeFileSync(join(directory, ".kimi-code", "mcp.json"), theirs);
    const prepared = HARNESS_KINDS.kimi.prepare!({ ...request, directory, scratch, prompt: "fix it" }, {});
    const agent = readFileSync(join(scratch, "kimi-agent.md"), "utf8");
    assert.match(agent, /^---\nname: swarm\ndescription: .+\n---\n\$\{base_prompt\}\n\n## Swarm superagent\n/);
    assert.ok(!agent.includes("tools:"), "a worker keeps all of Kimi's tools");
    assert.deepEqual(prepared.env, { KIMI_CODE_TRUST_WORKSPACE: "1" }, "a headless run reads project-level servers only in a trusted workspace");
    const servers = JSON.parse(readFileSync(join(directory, ".kimi-code", "mcp.json"), "utf8")).mcpServers;
    assert.deepEqual(Object.keys(servers), ["github", "ticket"]);
    assert.deepEqual({ command: servers.ticket.command, args: servers.ticket.args, env: servers.ticket.env }, request.tools);
    prepared.undo!();
    assert.equal(readFileSync(join(directory, ".kimi-code", "mcp.json"), "utf8"), theirs, "the directory's own file comes back as it was");

    rmSync(join(directory, ".kimi-code"), { recursive: true });
    HARNESS_KINDS.kimi.prepare!({ ...request, directory, scratch, prompt: "fix it" }, {}).undo!();
    assert.equal(existsSync(join(directory, ".kimi-code")), false, "a folder Swarm made for the turn goes away with it");

    const reviewer = HARNESS_KINDS.kimi.prepare!({ ...request, tools: undefined, permission: "read-only", directory, scratch, prompt: "review" }, {});
    assert.deepEqual(reviewer, {}, "a delegated subagent needs no MCP server");
    assert.match(readFileSync(join(scratch, "kimi-agent.md"), "utf8"), /\ntools: Read, Grep, Glob, ReadMediaFile, TodoList, WebSearch, FetchURL\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Kimi Code's stream-json lines give the final words, the session and the steps; its wire files give the usage", async () => {
  const turn = read("kimi", [
    { role: "meta", type: "system.version", version: "2.1.1" },
    { role: "assistant", content: "I'll report.", tool_calls: [{ type: "function", id: "tool_1", function: { name: "mcp__ticket__report", arguments: "{\"state\":\"ready\"}" } }] },
    { role: "tool", tool_call_id: "tool_1", content: "{\"reported\":true}" },
    { role: "assistant", content: "Reported." },
    { role: "meta", type: "session.resume_hint", session_id: "session_de46", command: "kimi -r session_de46", content: "To resume this session: kimi -r session_de46" }
  ]);
  assert.equal(turn.done, true);
  assert.equal(turn.session, "session_de46");
  assert.equal(turn.text, "Reported.");
  assert.deepEqual([turn.steps, turn.toolCalls], [2, 1]);
  const retried = read("kimi", [{ role: "meta", type: "turn.step.retrying", failed_attempt: 1, next_attempt: 2, error_name: "APIError", error_message: "429 rate limited" }]);
  assert.equal(retried.done, false, "a turn without the closing notice did not complete");
  assert.equal(retried.error, "APIError: 429 rate limited");
  assert.equal(HARNESS_KINDS.kimi.detail!("error: failed to run prompt: provider managed:kimi-code has no credential configured\nSee log: /x\n"),
    "provider managed:kimi-code has no credential configured");
  assert.ok(HARNESS_KINDS.kimi.lost("error: failed to run prompt: Session \"session_x\" not found."));

  const home = mkdtempSync(join(tmpdir(), "swarm-kimi-home-"));
  try {
    const directory = join(home, "work");
    const dir = join(home, "sessions", "wd_work_1", "session_de46");
    mkdirSync(join(dir, "agents", "main"), { recursive: true });
    mkdirSync(join(dir, "agents", "agent-1"), { recursive: true });
    mkdirSync(directory);
    writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session_de46", sessionDir: dir, workDir: realpathSync(directory) })}\n`);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ id: "session_de46", createdAt: 2000 }));
    const record = (agent: string, time: number, inputOther: number) => `${JSON.stringify({ type: "usage.record", agentId: agent, model: "kimi-code/k3",
      usage: { inputOther, output: 116, inputCacheRead: 15360, inputCacheCreation: 0 }, usageScope: "turn", time })}\n`;
    writeFileSync(join(dir, "agents", "main", "wire.jsonl"), record("main", 1000, 99) + record("main", 2500, 1779));
    writeFileSync(join(dir, "agents", "agent-1", "wire.jsonl"), record("agent-1", 2600, 1272));
    const failed = fresh();
    await HARNESS_KINDS.kimi.settle!(failed, { command: "kimi", env: { KIMI_CODE_HOME: home }, directory, started: 2000 });
    assert.equal(failed.session, "session_de46", "a turn that failed before its notice still finds the session it started");
    assert.equal(failed.model, "kimi-code/k3");
    assert.deepEqual(failed.usage, { inputTokens: 3051, outputTokens: 232, cachedInputTokens: 30720, cacheCreationInputTokens: 0 },
      "the turn's model calls, the subagents' too, without an earlier turn's");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OpenCode runs `run --format json` with Swarm's config inline: the ticket tools, the instructions file and its agent", () => {
  const scratch = mkdtempSync(join(tmpdir(), "swarm-opencode-scratch-"));
  try {
    const turn = { ...request, scratch, prompt: "fix it" };
    const args = HARNESS_KINDS.opencode.args({ ...turn, extra: ["--variant", "high"] });
    assert.deepEqual(args.slice(0, 5), ["run", "--format", "json", "--variant", "high"]);
    assert.equal(after(args, "--agent"), "swarm", "every turn names the agent, or a resumed session goes on with the default one");
    assert.ok(args.includes("--auto"), "full-auto approves whatever would still ask");
    assert.equal(after(args, "--log-level"), "ERROR");
    assert.ok(!HARNESS_KINDS.opencode.promptArgument, "the prompt goes on standard input");
    const later = HARNESS_KINDS.opencode.args({ ...turn, session: "ses_e4debd685ffeYEPW7fhbtP830c", model: "deepseek/deepseek-flash" });
    assert.equal(after(later, "--session"), "ses_e4debd685ffeYEPW7fhbtP830c");
    assert.equal(after(later, "--model"), "deepseek/deepseek-flash");

    const prepared = HARNESS_KINDS.opencode.prepare!(turn, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["/team/rules.md"], agent: { review: { mode: "subagent" } } }) });
    const config = JSON.parse(prepared.env!.OPENCODE_CONFIG_CONTENT!);
    assert.deepEqual(config.mcp.ticket, { type: "local", command: [request.tools!.command, ...request.tools!.args], environment: request.tools!.env, enabled: true, timeout: 120_000 });
    assert.deepEqual(config.instructions, ["/team/rules.md", join(scratch, "opencode-instructions.md")], "added to the inline config the environment had");
    assert.equal(readFileSync(join(scratch, "opencode-instructions.md"), "utf8"), request.instructions);
    assert.deepEqual(Object.keys(config.agent), ["review", "swarm"]);
    assert.deepEqual(config.agent.swarm.permission, { "*": "allow", question: "deny", bash: { "*": "allow", "npm-publish": "deny", "npm-publish *": "deny" } });
    assert.equal(HARNESS_KINDS.opencode.tool("report"), "ticket_report");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("OpenCode's JSON events give the session, the final words, each step's tokens and cost, and its error log the cause", () => {
  const session = "ses_e4debd685ffeYEPW7fhbtP830c";
  const part = (fields: Record<string, unknown>) => ({ sessionID: session, part: { sessionID: session, ...fields } });
  const turn = read("opencode", [
    { type: "step_start", ...part({ type: "step-start" }) },
    { type: "tool_use", ...part({ type: "tool", tool: "write", state: { status: "completed" } }) },
    { type: "step_finish", ...part({ type: "step-finish", reason: "tool-calls", tokens: { total: 23204, input: 23131, output: 73, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0.00325878 }) },
    { type: "step_start", ...part({ type: "step-start" }) },
    { type: "tool_use", ...part({ type: "tool", tool: "ticket_report", state: { status: "completed", output: "{\"reported\":true}" } }) },
    { type: "step_finish", ...part({ type: "step-finish", reason: "tool-calls", tokens: { total: 23278, input: 180, output: 58, reasoning: 0, cache: { write: 0, read: 23040 } }, cost: 0.000105952 }) },
    { type: "step_start", ...part({ type: "step-start" }) },
    { type: "text", ...part({ type: "text", text: "done" }) },
    { type: "step_finish", ...part({ type: "step-finish", reason: "stop", tokens: { total: 23297, input: 255, output: 2, reasoning: 0, cache: { write: 0, read: 23040 } }, cost: 0.000100772 }) }
  ].map((event) => ({ timestamp: 1793989030182, ...event })));
  assert.equal(turn.done, true);
  assert.equal(turn.session, session);
  assert.equal(turn.text, "done");
  assert.deepEqual([turn.steps, turn.toolCalls], [3, 2]);
  assert.equal(turn.usage?.inputTokens, 23566);
  assert.equal(turn.usage?.cachedInputTokens, 46080);
  assert.equal(turn.usage?.outputTokens, 133);
  assert.ok(Math.abs((turn.usage?.costUsd ?? 0) - 0.003465504) < 1e-12);

  const failed = read("opencode", [{ type: "error", timestamp: 1, sessionID: session, error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details.", ref: "err_67188424" } } }]);
  assert.equal(failed.done, false);
  assert.equal(failed.error, "Unexpected server error. Check server logs for details.");
  assert.equal(HARNESS_KINDS.opencode.detail!("timestamp=2026-11-06T18:18:40.573Z level=ERROR run=49fc4359 message=failed ref=err_67188424 error=\"ProviderModelNotFoundError: Model not found: deepseek/deepseek-v4-flash. Did you mean: deepseek-flash, deepseek-v4-pro?\" cause=\"x\""),
    "ProviderModelNotFoundError: Model not found: deepseek/deepseek-v4-flash. Did you mean: deepseek-flash, deepseek-v4-pro?");
  assert.ok(HARNESS_KINDS.opencode.lost("\u001b[91m\u001b[1mError: \u001b[0mSession not found"));
});

test("a read-only turn uses each harness's own way to keep it from writing, and a profile that sets permissions itself is refused", () => {
  const scratch = mkdtempSync(join(tmpdir(), "swarm-read-only-"));
  try {
    const reviewer: TurnRequest = { ...request, tools: undefined, permission: "read-only", scratch, prompt: "review the diff" };
    const claude = HARNESS_KINDS.claude.args(reviewer);
    assert.equal(after(claude, "--permission-mode"), "dontAsk", "only what is allowed runs; everything else is denied without asking");
    assert.equal(after(claude, "--tools"), "Read,Grep,Glob,Bash");
    assert.deepEqual(claude.slice(claude.indexOf("--allowedTools") + 1, claude.indexOf("--disallowedTools")),
      ["Read", "Grep", "Glob", "Bash(git status)", "Bash(git status *)", "Bash(git diff)", "Bash(git diff *)", "Bash(git log)", "Bash(git log *)", "Bash(git show)", "Bash(git show *)"]);
    assert.ok(!claude.includes("--mcp-config") && claude.includes("--strict-mcp-config"), "no MCP servers at all");

    assert.equal(after(HARNESS_KINDS.codex.args(reviewer), "-s"), "read-only");
    assert.ok(!HARNESS_KINDS.codex.args(reviewer).some((arg) => arg.startsWith("mcp_servers.ticket")));

    const opencode = HARNESS_KINDS.opencode.args(reviewer);
    assert.ok(!opencode.includes("--auto"), "without --auto OpenCode rejects whatever would ask");
    const permission = JSON.parse(HARNESS_KINDS.opencode.prepare!(reviewer, {}).env!.OPENCODE_CONFIG_CONTENT!).agent.swarm.permission;
    assert.equal(permission["*"], "deny");
    assert.equal(permission.edit, undefined, "edits fall under the denying catch-all");
    assert.equal(permission.bash["*"], "deny");
    assert.equal(permission.bash["git diff *"], "allow");

    for (const kind of Object.values(HARNESS_KINDS)) assert.ok(kind.readOnly, `${kind.label} says what a read-only turn enforces`);
    const resolved = (id: string, args: string[]) => ({ id, kind: HARNESS_KINDS[harnessProfiles({})[id]!.kind], args });
    assert.equal(readOnlyProblem(resolved("claude", ["--effort", "high"])), undefined);
    assert.equal(readOnlyProblem(resolved("claude", ["--dangerously-skip-permissions"])),
      "the profile \"claude\" passes --dangerously-skip-permissions in its args, which sets Claude Code's permissions itself, so Swarm cannot keep it read-only.");
    assert.match(readOnlyProblem(resolved("codex", ["--sandbox=danger-full-access"])) ?? "", /passes --sandbox=danger-full-access/);
    assert.match(readOnlyProblem(resolved("opencode", ["--auto"])) ?? "", /passes --auto/);
    assert.equal(readOnlyProblem({ id: "x", kind: { ...HARNESS_KINDS.kimi, readOnly: undefined }, args: [] }), "Kimi Code has no read-only mode Swarm can start it in.");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("GLM and DeepSeek run behind Claude Code as built-in profiles, with their endpoints' variables and keys from the environment", () => {
  const profiles = harnessProfiles({});
  assert.deepEqual(profiles["claude-glm"]?.keys, { ANTHROPIC_AUTH_TOKEN: "ZHIPU_API_KEY" });
  assert.equal(profiles["claude-glm"]?.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(profiles["claude-glm"]?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3[1m]");
  assert.deepEqual(profiles["claude-deepseek"]?.keys, { ANTHROPIC_AUTH_TOKEN: "DEEPSEEK_API_KEY" });
  assert.equal(profiles["claude-deepseek"]?.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(profiles["claude-deepseek"]?.env.ANTHROPIC_MODEL, "deepseek-flash[1m]");
  const international = harnessProfiles({ "claude-glm": HarnessProfileSchema.parse({ env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } }) })["claude-glm"]!;
  assert.equal(international.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic", "settings change a model profile's variables");
  assert.equal(international.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3[1m]", "and keep the rest");
  assert.deepEqual(international.keys, { ANTHROPIC_AUTH_TOKEN: "ZHIPU_API_KEY" });

  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const harness = resolveHarness("claude-deepseek", {}, "settings.json", { PATH: bin, DEEPSEEK_API_KEY: "sk-test" });
    assert.equal(harness.kind, HARNESS_KINDS.claude);
    assert.equal(harness.env.ANTHROPIC_AUTH_TOKEN, "sk-test");
    assert.equal(harness.own.ANTHROPIC_AUTH_TOKEN, "sk-test");
    const scratch = join(bin, "scratch");
    mkdirSync(scratch);
    const turn: TurnRequest = { ...request, scratch, own: harness.own };
    const args = HARNESS_KINDS.claude.args(turn);
    assert.equal(after(args, "--settings"), join(scratch, "claude-settings.json"), "a file, as the settings hold the key");
    assert.ok(!args.some((arg) => arg.includes("sk-test")), "no key in the arguments, which other processes can read");
    HARNESS_KINDS.claude.prepare!(turn, {});
    const settings = JSON.parse(readFileSync(join(scratch, "claude-settings.json"), "utf8"));
    assert.deepEqual(settings.attribution, { commit: "", pr: "", sessionUrl: false });
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic", "above the user's settings, which may name a relay");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-test");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Kimi Code and OpenCode turns run end to end on the fakes: final words, usage, model and session", async () => {
  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  const kimiHome = join(bin, "kimi-home");
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const directory = join(bin, "work");
    mkdirSync(directory);
    const base = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIMI_CODE_HOME: kimiHome };
    const turn = { ...request, directory, tools: undefined, blockedCommands: [] };

    const kimi = await runTurn(resolveHarness("kimi", {}, "settings.json", base), turn, "write the note", { steps: 10, toolCalls: 10 });
    assert.equal(kimi.status, "completed", kimi.error);
    assert.match(kimi.session ?? "", /^session_/);
    assert.equal(kimi.text, "Wrote harness.txt on kimi.");
    assert.equal(kimi.model, "kimi-code/k3");
    assert.equal(kimi.usage?.inputTokens, 1779);
    const kimiRows = harnessUsageRows(resolveHarness("kimi", {}, "settings.json", base), kimi, { purpose: "test" });
    assert.equal(kimiRows[0]?.metadata.totalInputWithCacheTokens, 1779 + 15360, "Kimi counts cached input apart");

    const opencode = await runTurn(resolveHarness("opencode", {}, "settings.json", base), turn, "write the note", { steps: 10, toolCalls: 10 });
    assert.equal(opencode.status, "completed", opencode.error);
    assert.match(opencode.session ?? "", /^ses_/);
    assert.equal(opencode.model, "deepseek/deepseek-flash", "from `opencode export`, as its events name no model");
    assert.equal(opencode.protocol, "openai-chat-completions");
    assert.ok(Math.abs((opencode.usage?.costUsd ?? 0) - 0.003359552) < 1e-12);
    assert.equal(readFileSync(join(directory, "harness.txt"), "utf8"), "kimi turn 1\nopencode turn 1\n");

    const gone = await runTurn(resolveHarness("opencode", {}, "settings.json", base), { ...turn, session: "ses_gone" }, "go on", { steps: 10, toolCalls: 10 });
    assert.equal(gone.lost, true);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("`swarm harness` statuses name each profile's command, kind, model and keys, and whether it is installed and signed in", async () => {
  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const base = { PATH: bin, HOME: bin };
    const deepseek = await harnessStatus("claude-deepseek", {}, "settings.json", { base });
    assert.deepEqual({ ...deepseek, command: undefined }, { id: "claude-deepseek", kind: "claude", label: "Claude Code", command: undefined, installed: true,
      keys: [{ name: "ANTHROPIC_AUTH_TOKEN", from: "DEEPSEEK_API_KEY", present: false }],
      problem: `The Claude Code profile "claude-deepseek" reads ANTHROPIC_AUTH_TOKEN from DEEPSEEK_API_KEY, which is not set where Swarm runs on ${(await import("node:os")).hostname()}.` });
    assert.equal(deepseek.command, join(bin, "claude"));
    const kimi = await harnessStatus("kimi", {}, "settings.json", { base, signIn: true });
    assert.equal(kimi.signedIn, true);
    assert.equal(kimi.problem, undefined);
    const away = await harnessStatus("opencode", { opencode: HarnessProfileSchema.parse({ env: { FAKE_HARNESS_SIGNED_OUT: "1" } }) }, "settings.json", { base, signIn: true });
    assert.equal(away.signedIn, false);
    assert.match(away.problem ?? "", /not signed in: run `.+\/opencode auth login`/);
    const missing = await harnessStatus("codex", {}, "settings.json", { base: { PATH: "/nowhere" } });
    assert.deepEqual([missing.installed, missing.problem], [false, "Codex is not installed: no `codex` on PATH."]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("profiles change the built-in harnesses and add others, and read keys only from the environment", () => {
  assert.throws(() => HarnessProfileSchema.parse({ env: { ANTHROPIC_AUTH_TOKEN: "sk-secret" } }), /read from the environment/);
  assert.throws(() => HarnessProfileSchema.parse({ env: { OPENAI_API_KEY: "sk-secret" } }), /read from the environment/);
  assert.deepEqual(HarnessProfileSchema.parse({ env: { MAX_THINKING_TOKENS: "8000" } }).env, { MAX_THINKING_TOKENS: "8000" });
  assert.throws(() => SettingsSchema.parse({ executor: { harness: "glm" } }), /names no harness profile: glm/);
  assert.throws(() => SettingsSchema.parse({ executor: { harnesses: { glm: { model: "glm-4.6" } } } }), /needs a kind/);
  const settings = SettingsSchema.parse({ executor: { harness: "glm", harnesses: { glm: { kind: "claude", model: "glm-4.6",
    env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic" }, keys: { ANTHROPIC_AUTH_TOKEN: "GLM_API_KEY" } } } } });
  assert.deepEqual(harnessIds(settings.executor.harnesses), ["claude", "codex", "kimi", "opencode", "claude-glm", "claude-deepseek", "glm"]);

  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const base = { PATH: bin, HOME: "/home/a", GLM_API_KEY: "k-1", CLAUDECODE: "1", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" };
    const glm = resolveHarness("glm", settings.executor.harnesses, "settings.json", base);
    assert.equal(glm.kind, HARNESS_KINDS.claude);
    assert.equal(glm.command, join(bin, "claude"));
    assert.equal(glm.model, "glm-4.6");
    assert.equal(glm.env.ANTHROPIC_AUTH_TOKEN, "k-1");
    assert.equal(glm.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(glm.env.CLAUDECODE, undefined, "an enclosing Claude Code session's variables stay out");
    assert.equal(glm.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, undefined);
    assert.throws(() => resolveHarness("glm", settings.executor.harnesses, "settings.json", { PATH: bin }),
      (error: unknown) => error instanceof HarnessSetupError && /reads ANTHROPIC_AUTH_TOKEN from GLM_API_KEY, which is not set/.test(error.message));
    assert.throws(() => resolveHarness("codex", {}, "settings.json", { PATH: "/nowhere" }),
      (error: unknown) => error instanceof HarnessSetupError && /Codex is not installed on .*: no `codex` on PATH\. .*executor\.harnesses\.codex\.command in settings\.json/.test(error.message));
    assert.throws(() => resolveHarness("ghost", {}, "settings.json", base), /No harness "ghost" .*the profiles here are claude, codex, kimi, opencode, claude-glm, claude-deepseek/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a turn that goes past its budget is stopped and fails with why", async () => {
  const bin = mkdtempSync(join(tmpdir(), "swarm-harness-bin-"));
  try {
    writeFakeHarnesses(bin, join(bin, "home"));
    const harness = resolveHarness("claude", {}, "settings.json", { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    const outcome = await runTurn(harness, { ...request, directory: bin, tools: { command: "/usr/bin/false", args: [], env: {} }, blockedCommands: [] },
      "do the work", { steps: 0, toolCalls: 0 });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /ran out of budget after 1 model messages and 0 tool calls/);
    assert.equal(outcome.session !== undefined, true, "the session it ran in, to resume");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "swarm-harness-client-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

/** Files a request and accepts it as a ticket at once, as the router would. */
function accepted(client: SuperagentClient, text: string, harness?: string) {
  const { triggerId } = client.request(text, undefined, harness ? { harness } : {});
  client.engine.evaluateDue();
  const candidate = client.engine.candidate(triggerId)!;
  const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: text, scope: "x", reason: "asked", name: "fix-it", evalId: candidate.evalId });
  return client.store.tickets.get(ticketId!)!;
}

test("a ticket runs on the harness its request names, else on the settings' default, else on Swarm's own loop", () => {
  const client = new SuperagentClient({ stateDir });
  try {
    assert.equal(accepted(client, "fix the typo").execution?.harness, undefined);
    writeSettings({ executor: { harness: "codex" } }, settingsPath(stateDir));
    assert.equal(accepted(client, "fix the link").execution?.harness, "codex");
    assert.equal(accepted(client, "fix the title", "claude").execution?.harness, "claude");
    assert.throws(() => client.request("fix it", undefined, { harness: "ghost" }), /No harness "ghost": choose one of claude, codex/);
  } finally {
    client.close();
  }
});
